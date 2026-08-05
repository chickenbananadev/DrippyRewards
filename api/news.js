// /api/news.js
// The Daily Drip — newsroom feed + poster accounts.
//
// Public:
//   GET  /api/news                                   → list articles (newest first)
// Poster auth (username/password accounts that can ONLY post news):
//   POST {action:'login', username, password}        → {ok, token, username}
//   POST {action:'checktoken', token}                → {ok, username}
//   POST {action:'add', token, title, body, ...}     → publish as that poster
//   POST {action:'del', token, id}                   → delete OWN article only
// Admin (key = DRIPPY_NEWS_SECRET, falls back to DRIPPY_EVENTS_SECRET):
//   POST {action:'checkkey', key}
//   POST {action:'add'|'del', key, ...}              → publish / delete anything
//   POST {action:'poster_add', key, username, password}  → create/reset a poster
//   POST {action:'poster_del', key, username}            → revoke a poster
//   POST {action:'poster_list', key}                     → list posters
//
// Passwords are stored as scrypt hashes (never plaintext, api/_auth.js).
// Sessions are HMAC-signed tokens (30 days); no server-side session storage.

const crypto = require('crypto');
const { redis, safeEqual, hashPassword, makeToken, verifyToken, getPoster, POSTERS_KEY, USER_RE } = require('./_auth');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SECRET = process.env.DRIPPY_NEWS_SECRET || process.env.DRIPPY_EVENTS_SECRET;

const NEWS_KEY = 'drippy:news:list'; // sorted set: member=article JSON, score=publishedAt
const MAX_ARTICLES = 200;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(200).json({ configured: false, articles: [] });
  }

  let body = {};
  if (req.method === 'POST') {
    try {
      if (typeof req.body === 'object' && req.body) body = req.body;
      else if (typeof req.body === 'string' && req.body) body = JSON.parse(req.body);
    } catch(_) {}
  }
  const params = Object.assign({}, req.query || {}, body);

  const action = (params.action || 'list').toLowerCase();
  const isAdmin = !!(SECRET && params.key && safeEqual(params.key, SECRET));
  const tokenUser = params.token ? verifyToken(params.token) : null;

  try {
    // ---------- auth checks ----------
    if (action === 'checkkey') {
      if (!isAdmin) return res.status(401).json({ error: 'Invalid key' });
      return res.status(200).json({ ok: true });
    }

    if (action === 'checktoken') {
      if (!tokenUser) return res.status(401).json({ error: 'Session expired — sign in again' });
      const poster = await getPoster(tokenUser);
      if (!poster) return res.status(401).json({ error: 'Account no longer exists' });
      return res.status(200).json({ ok: true, username: tokenUser });
    }

    if (action === 'login') {
      const username = String(params.username || '').trim().toLowerCase();
      const password = String(params.password || '');
      if (!USER_RE.test(username) || !password) return res.status(401).json({ error: 'Wrong username or password' });
      const poster = await getPoster(username);
      if (!poster) return res.status(401).json({ error: 'Wrong username or password' });
      const attempt = hashPassword(password, poster.salt);
      if (!safeEqual(attempt, poster.hash)) return res.status(401).json({ error: 'Wrong username or password' });
      return res.status(200).json({ ok: true, token: makeToken(username), username });
    }

    // ---------- poster account management (admin only) ----------
    if (action === 'poster_add' || action === 'poster_del' || action === 'poster_list') {
      if (!isAdmin) return res.status(401).json({ error: 'Invalid key' });

      if (action === 'poster_add') {
        const username = String(params.username || '').trim().toLowerCase();
        const password = String(params.password || '');
        if (!USER_RE.test(username)) return res.status(400).json({ error: 'Username: 3–20 letters, numbers or _' });
        if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
        const salt = crypto.randomBytes(16).toString('hex');
        const record = { salt, hash: hashPassword(password, salt), createdAt: Date.now() };
        await redis(['HSET', POSTERS_KEY, username, JSON.stringify(record)]);
        return res.status(200).json({ ok: true, username });
      }

      if (action === 'poster_del') {
        const username = String(params.username || '').trim().toLowerCase();
        if (!username) return res.status(400).json({ error: 'username required' });
        await redis(['HDEL', POSTERS_KEY, username]);
        return res.status(200).json({ ok: true, removed: username });
      }

      // poster_list
      const flat = await redis(['HGETALL', POSTERS_KEY]) || [];
      const posters = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        let createdAt = null;
        try{ createdAt = JSON.parse(flat[i + 1]).createdAt || null; }catch(_){}
        posters.push({ username: flat[i], createdAt });
      }
      posters.sort((a, b) => (a.username < b.username ? -1 : 1));
      return res.status(200).json({ ok: true, posters });
    }

    // ---------- articles ----------
    if (action === 'add') {
      let postedBy = null;
      if (isAdmin) postedBy = 'admin';
      else if (tokenUser) {
        const poster = await getPoster(tokenUser); // revoked accounts can't post
        if (poster) postedBy = tokenUser;
      }
      if (!postedBy) return res.status(401).json({ error: 'Sign in (or use a valid key) to publish' });

      const title = (params.title || '').trim().slice(0, 160);
      const text = (params.body || params.text || '').trim().slice(0, 8000);
      const link = (params.link || '').trim().slice(0, 500);
      const image = (params.image || '').trim().slice(0, 500);
      const author = ((params.author || '').trim() || (postedBy === 'admin' ? '' : postedBy)).slice(0, 40);

      if (!title) return res.status(400).json({ error: 'title required' });
      if (!text) return res.status(400).json({ error: 'body required' });
      if (link && !/^https?:\/\//i.test(link)) return res.status(400).json({ error: 'link must be http(s)' });
      if (image && !/^https?:\/\//i.test(image)) return res.status(400).json({ error: 'image must be a URL (use the image upload)' });

      const publishedAt = Date.now();
      const id = 'n_' + publishedAt + '_' + crypto.randomBytes(4).toString('hex');
      const article = { id, title, body: text, link, image, author, postedBy, publishedAt };

      await redis(['ZADD', NEWS_KEY, publishedAt, JSON.stringify(article)]);
      await redis(['ZREMRANGEBYRANK', NEWS_KEY, '0', String(-(MAX_ARTICLES + 1))]);
      return res.status(200).json({ ok: true, article });
    }

    if (action === 'del') {
      if (!isAdmin && !tokenUser) return res.status(401).json({ error: 'Sign in (or use a valid key) to delete' });
      const id = params.id;
      if (!id) return res.status(400).json({ error: 'id required' });
      const all = await redis(['ZRANGE', NEWS_KEY, '0', '-1']) || [];
      for (const aStr of all) {
        try {
          const a = JSON.parse(aStr);
          if (a.id === id) {
            if (!isAdmin && a.postedBy !== tokenUser) {
              return res.status(403).json({ error: 'You can only delete your own articles' });
            }
            await redis(['ZREM', NEWS_KEY, aStr]);
            return res.status(200).json({ ok: true, removed: id });
          }
        } catch(_) {}
      }
      return res.status(404).json({ error: 'article not found' });
    }

    // ---------- share page: per-article OG tags so X shows the picture ----------
    // X's share intent can't attach an image directly; instead the shared URL
    // (/news/share/:id, rewritten here) serves the article's own OG meta tags
    // so X renders a large card with the headline, excerpt and image.
    // Crawlers (Twitterbot etc.) get a PURE meta page — no meta-refresh, no
    // redirect — because X's scraper can treat a refresh as a redirect and
    // abandon the scrape before fetching the image. Real visitors are 302'd
    // server-side (by User-Agent) straight to the article on /news.
    const findArticle = async (id) => {
      if (!id) return null;
      const all = await redis(['ZRANGE', NEWS_KEY, '0', '-1']) || [];
      for (const aStr of all) {
        try { const a = JSON.parse(aStr); if (a.id === id) return a; } catch(_) {}
      }
      return null;
    };

    // ---------- share image proxy ----------
    // X's card fetcher honors robots.txt on the IMAGE host. Uploaded article
    // images live on *.public.blob.vercel-storage.com, which serves a
    // deny-all robots.txt — so cards showed the title but never the picture.
    // Stream the image bytes from our own domain instead (via the
    // /news/img/:id rewrite); drippyrewards.com has no robots restrictions.
    if (action === 'img') {
      const SITE = 'https://drippyrewards.com';
      const article = await findArticle(String(params.id || ''));
      if (!article || !article.image) {
        res.status(302);
        res.setHeader('Location', SITE + '/assets/banner.jpg');
        return res.end();
      }
      try {
        const r = await fetch(article.image);
        if (!r.ok) throw new Error('image upstream ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        const ctype = (r.headers && typeof r.headers.get === 'function' && r.headers.get('content-type')) || 'image/jpeg';
        res.status(200);
        res.setHeader('Content-Type', ctype.split(';')[0]);
        res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable');
        return res.end(buf);
      } catch (e) {
        console.error('[news img]', e.message);
        res.status(302);
        res.setHeader('Location', SITE + '/assets/banner.jpg');
        return res.end();
      }
    }

    if (action === 'share') {
      const SITE = 'https://drippyrewards.com';
      const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const article = await findArticle(String(params.id || ''));
      if (!article) {
        res.status(302);
        res.setHeader('Location', SITE + '/news');
        return res.end();
      }
      const target = SITE + '/news#a-' + encodeURIComponent(article.id);

      const ua = String((req.headers && req.headers['user-agent']) || '');
      const isCrawler = /Twitterbot|facebookexternalhit|Slackbot|TelegramBot|Discordbot|LinkedInBot|WhatsApp|Googlebot|bingbot|Pinterest/i.test(ua);
      if (!isCrawler) {
        res.status(302);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Location', target);
        return res.end();
      }

      const flat = String(article.body || '').replace(/\s+/g, ' ').trim();
      const desc = flat.length > 200 ? flat.slice(0, 200).trim() + '…' : flat;
      const hasOwnImage = !!article.image;
      // Own-domain proxy URL — X won't fetch images straight off the blob host.
      // ?v= busts X's separate per-URL IMAGE cache too, not just the page scrape.
      const img = hasOwnImage
        ? (SITE + '/news/img/' + encodeURIComponent(article.id) + '?v=' + (article.publishedAt || 1))
        : (SITE + '/assets/banner.jpg');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.status(200).end('<!DOCTYPE html>\n<html lang="en"><head>\n' +
        '<meta charset="utf-8">\n' +
        '<title>' + escH(article.title) + ' — The Daily Drip</title>\n' +
        '<meta name="description" content="' + escH(desc) + '">\n' +
        '<meta name="robots" content="noindex">\n' +
        '<meta property="og:type" content="article">\n' +
        '<meta property="og:site_name" content="The Daily Drip — $DRIPPY News">\n' +
        '<meta property="og:title" content="' + escH(article.title) + '">\n' +
        '<meta property="og:description" content="' + escH(desc) + '">\n' +
        '<meta property="og:image" content="' + escH(img) + '">\n' +
        (hasOwnImage ? '' : '<meta property="og:image:width" content="1280">\n<meta property="og:image:height" content="426">\n') +
        '<meta property="og:image:alt" content="' + escH(article.title) + '">\n' +
        '<meta property="og:url" content="' + escH(SITE + '/news/share/' + encodeURIComponent(article.id)) + '">\n' +
        '<meta name="twitter:card" content="summary_large_image">\n' +
        '<meta name="twitter:title" content="' + escH(article.title) + '">\n' +
        '<meta name="twitter:description" content="' + escH(desc) + '">\n' +
        '<meta name="twitter:image" content="' + escH(img) + '">\n' +
        '<meta name="twitter:image:alt" content="' + escH(article.title) + '">\n' +
        '</head><body style="background:#0a0610;color:#f6e9c4;font-family:sans-serif;text-align:center;padding:60px 20px">\n' +
        '<p><a href="' + escH(target) + '" style="color:#f5c542">Read on The Daily Drip →</a></p>\n' +
        '</body></html>');
    }

    // ---------- default: public list ----------
    const all = await redis(['ZRANGE', NEWS_KEY, '0', '-1', 'REV']) || [];
    const articles = [];
    for (const aStr of all) {
      try { articles.push(JSON.parse(aStr)); } catch(_) {}
    }
    res.status(200).json({ configured: true, articles, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[news]', err);
    res.status(500).json({ error: err.message || 'unknown' });
  }
};
