// /api/leaderboard.js
// Returns the top burners recorded in the Upstash Redis sorted set.
// Populated by /api/wallet.js whenever someone checks a wallet that has burned.

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const LB_KEY = 'drippy:burn:leaderboard';
const META_PREFIX = 'drippy:burn:meta:';

async function redis(command){
  if(!REDIS_URL || !REDIS_TOKEN) return null;
  try{
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + REDIS_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(command)
    });
    if(!r.ok) return null;
    const j = await r.json();
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
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (!REDIS_URL || !REDIS_TOKEN) {
    res.status(200).json({ configured: false, entries: [], total: 0 });
    return;
  }

  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 15, 50);

    // ZREVRANGE with WITHSCORES — top N members, highest score first
    const raw = await redis(['ZREVRANGE', LB_KEY, '0', String(limit - 1), 'WITHSCORES']);

    // Total number of burners on the board
    const total = await redis(['ZCARD', LB_KEY]) || 0;

    if (!raw || raw.length === 0) {
      res.status(200).json({ configured: true, entries: [], total: 0 });
      return;
    }

    // raw is a flat array: [member, score, member, score, ...]
    const entries = [];
    for (let i = 0; i < raw.length; i += 2) {
      const wallet = raw[i];
      const score = Number(raw[i + 1]);
      entries.push({ wallet, tokensBurned: score, rank: (i / 2) + 1 });
    }

    // Fetch metadata for each wallet (burn events, share, etc.)
    await Promise.all(entries.map(async (e) => {
      const metaStr = await redis(['GET', META_PREFIX + e.wallet]);
      if (metaStr) {
        try {
          const meta = JSON.parse(metaStr);
          e.burnEvents = meta.burnEvents || 0;
          e.burnWeightSharePct = meta.burnWeightSharePct || 0;
          e.totalReceivedSol = meta.totalReceivedSol || 0;
        } catch(_) {}
      }
    }));

    res.status(200).json({
      configured: true,
      entries,
      total: Number(total),
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('[leaderboard] error:', err);
    res.status(500).json({ error: err.message || 'Unknown error', entries: [] });
  }
};
