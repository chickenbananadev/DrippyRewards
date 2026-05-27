// /api/leaderboard.js
// Returns top burners OR top earners from Upstash Redis.
// Usage: /api/leaderboard?type=burn (default) | /api/leaderboard?type=earn

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const LB_BURN_KEY = 'drippy:burn:leaderboard';
const LB_EARN_KEY = 'drippy:earn:leaderboard';
const META_PREFIX = 'drippy:meta:';

async function redis(command){
  if(!REDIS_URL || !REDIS_TOKEN) return null;
  try{
    const stringCmd = command.map(x => String(x));
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + REDIS_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(stringCmd)
    });
    if(!r.ok){ console.error('[redis] HTTP', r.status); return null; }
    const j = await r.json();
    if(j.error){ console.error('[redis] err:', j.error); return null; }
    return j.result;
  }catch(e){
    console.error('[redis]', e.message);
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (!REDIS_URL || !REDIS_TOKEN) {
    res.status(200).json({ configured: false, entries: [], total: 0 });
    return;
  }

  const type = (req.query.type || 'burn').toLowerCase();
  const key = type === 'earn' ? LB_EARN_KEY : LB_BURN_KEY;

  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 15, 50);
    const total = Number(await redis(['ZCARD', key])) || 0;

    let raw = await redis(['ZRANGE', key, '0', String(limit - 1), 'REV', 'WITHSCORES']);
    if (!raw || raw.length === 0) {
      raw = await redis(['ZREVRANGE', key, '0', String(limit - 1), 'WITHSCORES']);
    }
    if (!raw || raw.length === 0) {
      res.status(200).json({ configured: true, type, entries: [], total });
      return;
    }

    const entries = [];
    for (let i = 0; i < raw.length; i += 2) {
      const wallet = raw[i];
      const score = Number(raw[i + 1]);
      if (!wallet) continue;
      const entry = { wallet, rank: entries.length + 1 };
      if (type === 'earn') entry.totalReceivedSol = score / 1e9; // lamports → SOL
      else                  entry.tokensBurned = score;
      entries.push(entry);
    }

    // Pull display metadata
    await Promise.all(entries.map(async (e) => {
      const metaStr = await redis(['GET', META_PREFIX + e.wallet]);
      if (metaStr) {
        try {
          const meta = JSON.parse(metaStr);
          e.burnEvents = meta.burnEvents || 0;
          e.burnWeightSharePct = meta.burnWeightSharePct || 0;
          e.distributionCount = meta.distributionCount || 0;
          if (type === 'burn' && meta.tokensBurned) e.tokensBurned = meta.tokensBurned;
          if (type === 'earn' && meta.totalReceivedSol != null) e.totalReceivedSol = meta.totalReceivedSol;
        } catch(_) {}
      }
    }));

    res.status(200).json({ configured: true, type, entries, total, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[leaderboard] error:', err);
    res.status(500).json({ error: err.message || 'Unknown error', entries: [], total: 0 });
  }
};
