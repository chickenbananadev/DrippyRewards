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

    // ---------- X feed: server-side fetch of @drippyrewards posts ----------
    // Pulls from X's syndication backend (the data source behind the official
    // embed widget) and caches in Redis. Server-side fetch + our own render
    // beats the embed widget, whose client-side cache serves stale/empty
    // timelines for many accounts since the 2023 API lockdown.
    if (action === 'xfeed') {
      const X_CACHE_KEY = 'drippy:xfeed:cache';
      const fresh = params.fresh === '1' || params.fresh === 1;
      const debug = params.debug === '1' || params.debug === 1;
      const ttlMs = fresh ? 60_000 : 300_000; // refresh button may re-pull after 60s; normal cache 5 min

      const rawCache = await redis(['GET', X_CACHE_KEY]);
      let cacheEntry = null;
      if (rawCache) { try { cacheEntry = JSON.parse(rawCache); } catch(_) {} }
      if (cacheEntry && !debug && (Date.now() - cacheEntry.t) < ttlMs) {
        return res.status(200).json({ tweets: cacheEntry.v, cached: true, fetchedAt: new Date(cacheEntry.t).toISOString() });
      }

      const BROWSER_HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      };
      // diag: per-attempt status/why, returned only with debug=1 so we can see
      // the real upstream failure from a phone without Vercel log access.
      const diag = [];
      let tweets = null;

      const decodeEnt = (s) => String(s || '')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');

      // --- attempt 1: modern syndication page (__NEXT_DATA__ JSON) ---
      try {
        const r = await fetch('https://syndication.twitter.com/srv/timeline-profile/screen-name/drippyrewards?showReplies=false', {
          headers: Object.assign({ 'Accept': 'text/html,application/xhtml+xml' }, BROWSER_HEADERS)
        });
        const html = await r.text();
        const d = { src: 'srv', status: r.status, bytes: html.length, hasPayload: html.includes('__NEXT_DATA__') };
        diag.push(d);
        if (r.ok) {
          const m = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
          if (m) {
            const data = JSON.parse(m[1]);
            const entries = data?.props?.pageProps?.timeline?.entries || [];
            d.entries = entries.length;
            const out = [];
            for (const e of entries) {
              const t = e?.content?.tweet;
              if (!t || !t.id_str) continue;
              if (t.in_reply_to_status_id_str) continue; // top-level posts only
              let text = String(t.full_text || t.text || '');
              text = text.replace(/\s*https:\/\/t\.co\/\w+\s*$/g, '');
              const images = (t.mediaDetails || [])
                .filter(md => md && md.type === 'photo' && md.media_url_https)
                .map(md => md.media_url_https)
                .slice(0, 4);
              out.push({
                id: t.id_str,
                text: text.trim(),
                createdAt: t.created_at || null,
                likes: Number(t.favorite_count) || 0,
                images,
                isRetweet: !!t.retweeted_status,
                url: 'https://x.com/drippyrewards/status/' + t.id_str
              });
              if (out.length >= 10) break;
            }
            if (out.length) tweets = out;
          }
        }
      } catch (e) { diag.push({ src: 'srv', err: e.message }); }

      // --- attempt 2: legacy CDN timeline (JSON whose body is rendered HTML) ---
      if (!tweets) {
        try {
          const r2 = await fetch('https://cdn.syndication.twimg.com/timeline/profile?screen_name=drippyrewards&lang=en&dnt=true&suppress_response_codes=true', {
            headers: Object.assign({ 'Accept': 'application/json, text/javascript' }, BROWSER_HEADERS)
          });
          const txt = await r2.text();
          const d2 = { src: 'cdn', status: r2.status, bytes: txt.length };
          diag.push(d2);
          let j = null;
          try { j = JSON.parse(txt); } catch (_) { d2.note = 'not json'; }
          const bodyHtml = (j && j.body) ? String(j.body) : '';
          if (bodyHtml) {
            const out = [];
            // Capture the tweet div's class attr together with its id — the
            // class precedes data-tweet-id, so naive splitting on the id
            // attributes mis-assigns per-tweet flags to the previous chunk.
            const heads = [...bodyHtml.matchAll(/<div[^>]*class="([^"]*timeline-Tweet[^"]*)"[^>]*data-tweet-id="(\d+)"[^>]*>/g)];
            for (let i = 0; i < heads.length; i++) {
              const classAttr = heads[i][1];
              const id = heads[i][2];
              const start = heads[i].index + heads[i][0].length;
              const end = (i + 1 < heads.length) ? heads[i + 1].index : bodyHtml.length;
              const chunk = bodyHtml.slice(start, end);
              const textM = chunk.match(/<p[^>]*class="[^"]*timeline-Tweet-text[^"]*"[^>]*>([\s\S]*?)<\/p>/);
              let text = textM ? decodeEnt(textM[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
              text = text.replace(/\s*https:\/\/t\.co\/\w+\s*$/g, '').trim();
              const dateM = chunk.match(/datetime="([^"]+)"/);
              const imgM = chunk.match(/src="(https:\/\/pbs\.twimg\.com\/media\/[^"]+)"/);
              if (!text && !imgM) continue;
              out.push({
                id,
                text,
                createdAt: dateM ? dateM[1] : null,
                likes: 0,
                images: imgM ? [decodeEnt(imgM[1])] : [],
                isRetweet: /timeline-Tweet--isRetweet/.test(classAttr),
                url: 'https://x.com/drippyrewards/status/' + id
              });
              if (out.length >= 10) break;
            }
            d2.parsed = out.length;
            if (out.length) tweets = out;
          }
        } catch (e) { diag.push({ src: 'cdn', err: e.message }); }
      }

      if (tweets && tweets.length) {
        await redis(['SET', X_CACHE_KEY, JSON.stringify({ t: Date.now(), v: tweets })]);
        const ok = { tweets, fetchedAt: new Date().toISOString() };
        if (debug) ok.diag = diag;
        return res.status(200).json(ok);
      }

      console.error('[xfeed]', JSON.stringify(diag));
      if (cacheEntry) {
        const stale = { tweets: cacheEntry.v, cached: true, stale: true };
        if (debug) stale.diag = diag;
        return res.status(200).json(stale);
      }
      const fail = { tweets: [], error: 'unavailable' };
      if (debug) fail.diag = diag;
      return res.status(200).json(fail);
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
