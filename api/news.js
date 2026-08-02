// /api/news.js
// The Drippy Newsroom feed.
//
// Read:    GET  /api/news                     → list published articles (newest first)
// Publish: POST /api/news {action:'add', key, title, body, link?, image?, author?}
// Delete:  POST /api/news {action:'del', key, id}
// Verify:  POST /api/news {action:'checkkey', key}   → lets the admin UI validate a key
//
// Access: DRIPPY_NEWS_SECRET (set in Vercel env). Share that key with whoever
// should be able to post news — it grants news publishing only. Falls back to
// DRIPPY_EVENTS_SECRET if a dedicated news secret is not configured.

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SECRET = process.env.DRIPPY_NEWS_SECRET || process.env.DRIPPY_EVENTS_SECRET;

const NEWS_KEY = 'drippy:news:list'; // sorted set: member=article JSON, score=publishedAt
const MAX_ARTICLES = 200;

async function redis(command){
  if(!REDIS_URL || !REDIS_TOKEN) return null;
  try{
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(command.map(x => String(x)))
    });
    if(!r.ok) return null;
    const j = await r.json();
    return j.result;
  }catch(e){ return null; }
}

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
  const key = params.key;

  if (action === 'add' || action === 'del' || action === 'checkkey') {
    if (!SECRET || key !== SECRET) {
      return res.status(401).json({ error: 'Invalid key' });
    }
  }

  try {
    if (action === 'checkkey') {
      return res.status(200).json({ ok: true });
    }

    if (action === 'add') {
      const title = (params.title || '').trim().slice(0, 160);
      const text = (params.body || params.text || '').trim().slice(0, 8000);
      const link = (params.link || '').trim().slice(0, 500);
      const image = (params.image || '').trim().slice(0, 500);
      const author = (params.author || '').trim().slice(0, 40);

      if (!title) return res.status(400).json({ error: 'title required' });
      if (!text) return res.status(400).json({ error: 'body required' });
      if (link && !/^https?:\/\//i.test(link)) return res.status(400).json({ error: 'link must be http(s)' });
      if (image && !/^https?:\/\//i.test(image)) return res.status(400).json({ error: 'image must be a URL (use the image upload)' });

      const publishedAt = Date.now();
      const id = 'n_' + publishedAt + '_' + Math.random().toString(36).slice(2, 8);
      const article = { id, title, body: text, link, image, author, publishedAt };

      await redis(['ZADD', NEWS_KEY, publishedAt, JSON.stringify(article)]);
      // Cap history so the set can't grow unbounded
      await redis(['ZREMRANGEBYRANK', NEWS_KEY, '0', String(-(MAX_ARTICLES + 1))]);
      return res.status(200).json({ ok: true, article });
    }

    if (action === 'del') {
      const id = params.id;
      if (!id) return res.status(400).json({ error: 'id required' });
      const all = await redis(['ZRANGE', NEWS_KEY, '0', '-1']) || [];
      for (const aStr of all) {
        try {
          const a = JSON.parse(aStr);
          if (a.id === id) {
            await redis(['ZREM', NEWS_KEY, aStr]);
            return res.status(200).json({ ok: true, removed: id });
          }
        } catch(_) {}
      }
      return res.status(404).json({ error: 'article not found' });
    }

    // --- Default: list all articles, newest first ---
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
