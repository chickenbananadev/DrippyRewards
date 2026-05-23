// /api/leaderboard.js
// Returns the top burners recorded in the Upstash Redis sorted set.

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const LB_KEY = 'drippy:burn:leaderboard';
const META_PREFIX = 'drippy:burn:meta:';

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
    if(!r.ok){
      console.error('[redis] HTTP', r.status, await r.text());
      return null;
    }
    const j = await r.json();
    if(j.error){
      console.error('[redis] cmd error:', j.error);
      return null;
    }
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

  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 15, 50);

    // ZCARD — total members in the sorted set
    const total = Number(await redis(['ZCARD', LB_KEY])) || 0;

    // ZRANGE with REV + WITHSCORES — top N members, highest score first.
    // (ZRANGE ... REV is the modern form; works on current Upstash.)
    let raw = await redis(['ZRANGE', LB_KEY, '0', String(limit - 1), 'REV', 'WITHSCORES']);

    // Fallback to legacy ZREVRANGE if the above returns nothing
    if (!raw || raw.length === 0) {
      raw = await redis(['ZREVRANGE', LB_KEY, '0', String(limit - 1), 'WITHSCORES']);
    }

    if (!raw || raw.length === 0) {
      res.status(200).json({ configured: true, entries: [], total: total });
      return;
    }

    // raw is a flat array: [member, score, member, score, ...]
    const entries = [];
    for (let i = 0; i < raw.length; i += 2) {
      const wallet = raw[i];
      const score = Number(raw[i + 1]);
      if (!wallet) continue;
      entries.push({ wallet: wallet, tokensBurned: score, rank: (entries.length) + 1 });
    }

    // Fetch metadata for each wallet
    await Promise.all(entries.map(async (e) => {
      const metaStr = await redis(['GET', META_PREFIX + e.wallet]);
      if (metaStr) {
        try {
          const meta = JSON.parse(metaStr);
          e.burnEvents = meta.burnEvents || 0;
          e.burnWeightSharePct = meta.burnWeightSharePct || 0;
          e.totalReceivedSol = meta.totalReceivedSol || 0;
          // Prefer the precise stored value over the rounded score
          if (meta.tokensBurned) e.tokensBurned = meta.tokensBurned;
        } catch(_) {}
      }
    }));

    res.status(200).json({
      configured: true,
      entries: entries,
      total: total,
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('[leaderboard] error:', err);
    res.status(500).json({ error: err.message || 'Unknown error', entries: [], total: 0 });
  }
};
