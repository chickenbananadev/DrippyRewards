// /api/events.js
// Manages the "What's Dripping" events feed.
//
// Read:   GET /api/events                          → list all upcoming/live events
// Write:  GET /api/events?key=SECRET&action=add&title=...&start=ISO&type=...&link=...
// Delete: GET /api/events?key=SECRET&action=del&id=...

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SECRET = process.env.DRIPPY_EVENTS_SECRET || '2026Drippyrewards';

const EVENTS_KEY = 'drippy:events:list'; // sorted set: member=event JSON, score=startTime

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
    return res.status(200).json({ configured: false, events: [] });
  }

  // Merge query string + JSON body (POST). Body takes precedence on overlap.
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

  // --- Admin actions require the secret ---
  if (action === 'add' || action === 'del' || action === 'clear') {
    if (key !== SECRET) {
      return res.status(401).json({ error: 'Invalid key' });
    }
  }

  try {
    if (action === 'add') {
      const title = (params.title || '').trim();
      const startStr = (params.start || '').trim();
      const type = (params.type || 'event').toLowerCase();
      const link = (params.link || '').trim();
      const image = (params.image || '').trim();
      const duration = parseInt(params.duration_min, 10) || 60;

      if (!title) return res.status(400).json({ error: 'title required' });
      const startTime = startStr ? new Date(startStr).getTime() : Date.now();
      if (isNaN(startTime)) return res.status(400).json({ error: 'invalid start datetime' });

      const id = 'e_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const event = {
        id, title, type, link, image,
        start: startTime,
        end: startTime + duration * 60 * 1000
      };
      await redis(['ZADD', EVENTS_KEY, startTime, JSON.stringify(event)]);
      return res.status(200).json({ ok: true, event });
    }

    if (action === 'del') {
      const id = params.id;
      if (!id) return res.status(400).json({ error: 'id required' });
      // Have to scan for matching event
      const all = await redis(['ZRANGE', EVENTS_KEY, '0', '-1']) || [];
      for (const eStr of all) {
        try {
          const ev = JSON.parse(eStr);
          if (ev.id === id) {
            await redis(['ZREM', EVENTS_KEY, eStr]);
            return res.status(200).json({ ok: true, removed: id });
          }
        } catch(_) {}
      }
      return res.status(404).json({ error: 'event not found' });
    }

    if (action === 'clear') {
      await redis(['DEL', EVENTS_KEY]);
      return res.status(200).json({ ok: true });
    }

    // --- Default: list events (public, only future + currently-live) ---
    const now = Date.now();
    const all = await redis(['ZRANGE', EVENTS_KEY, '0', '-1']) || [];
    const events = [];
    for (const eStr of all) {
      try {
        const ev = JSON.parse(eStr);
        if (ev.end > now) {
          ev.status = (ev.start <= now && now <= ev.end) ? 'live' : 'upcoming';
          events.push(ev);
        }
      } catch(_) {}
    }
    // Sort: live first, then upcoming by start
    events.sort((a, b) => {
      if (a.status === 'live' && b.status !== 'live') return -1;
      if (b.status === 'live' && a.status !== 'live') return 1;
      return a.start - b.start;
    });

    res.status(200).json({ configured: true, events, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[events]', err);
    res.status(500).json({ error: err.message || 'unknown' });
  }
};
