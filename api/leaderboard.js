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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // ----- DRIPPY RUN global game leaderboard -----
  // Folded in here (instead of a separate api/game-scores.js) to stay under
  // Vercel Hobby's 12-serverless-function limit.
  //   GET  ?board=game            -> { scores: [{ n, s, beat }] }  (top 25)
  //   POST ?board=game {name,score,beat} -> { ok, rank }
  if ((req.query.board || '') === 'game') {
    const ZKEY = 'drippy:game:leaderboard', FLAGS = 'drippy:game:beat', RL = 'drippy:game:rl:', MAX = 2000000;
    const clean = n => String(n || '').toUpperCase().replace(/[^A-Z0-9 _.\-]/g, '').trim().slice(0, 12) || 'DRIPPY';
    // Admin moderation: remove a name (test/abusive). DELETE ?board=game&name=X
    if (req.method === 'DELETE') {
      if ((req.headers['x-admin-secret'] || '') !== process.env.DRIPPY_EVENTS_SECRET) { res.status(401).json({ error: 'unauthorized' }); return; }
      const name = String(req.query.name || '');
      if (name) { await redis(['ZREM', ZKEY, name]); await redis(['HDEL', FLAGS, name]); }
      res.status(200).json({ removed: name });
      return;
    }
    if (req.method === 'POST') {
      let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = null; } }
      if (!b) { res.status(400).json({ error: 'bad body' }); return; }
      const name = clean(b.name), score = Math.round(Number(b.score) || 0);
      if (!(score > 0) || score > MAX) { res.status(400).json({ error: 'score out of range' }); return; }
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      const rl = await redis(['SET', RL + ip, '1', 'NX', 'EX', '20']);
      if (rl !== null && rl !== 'OK') { res.status(429).json({ error: 'one log per 20s' }); return; }
      await redis(['ZADD', ZKEY, 'GT', 'CH', String(score), name]);
      if (b.beat) await redis(['HSET', FLAGS, name, '1']);
      const rank = await redis(['ZREVRANK', ZKEY, name]);
      res.status(200).json({ ok: true, rank: rank != null ? Number(rank) + 1 : null });
      return;
    }
    const raw = await redis(['ZREVRANGE', ZKEY, '0', '24', 'WITHSCORES']);
    const flagsRaw = await redis(['HGETALL', FLAGS]);
    const flags = {}; if (Array.isArray(flagsRaw)) for (let i = 0; i < flagsRaw.length; i += 2) flags[flagsRaw[i]] = flagsRaw[i + 1];
    const scores = [];
    if (Array.isArray(raw)) for (let i = 0; i < raw.length; i += 2) scores.push({ n: raw[i], s: Math.round(Number(raw[i + 1]) || 0), beat: flags[raw[i]] === '1' });
    res.status(200).json({ scores });
    return;
  }

  if (!REDIS_URL || !REDIS_TOKEN) {
    res.status(200).json({ configured: false, entries: [], total: 0 });
    return;
  }

  const type = (req.query.type || 'burn').toLowerCase();
  const key = type === 'earn' ? LB_EARN_KEY : LB_BURN_KEY;

  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 15, 100);
    const total = Number(await redis(['ZCARD', key])) || 0;

    let raw = await redis(['ZRANGE', key, '0', String(limit - 1), 'REV', 'WITHSCORES']);
    if (!raw || raw.length === 0) {
      raw = await redis(['ZREVRANGE', key, '0', String(limit - 1), 'WITHSCORES']);
    }
    if (!raw || raw.length === 0) {
      res.status(200).json({ configured: true, type, entries: [], total });
      return;
    }

    // Total supply is ~1B. Any burn value far above that is corrupted data
    // from an older code version that stored raw (9-decimal) amounts instead
    // of UI amounts. $DRIPPY has 9 decimals, so a raw value is 1e9x too big.
    const MAX_PLAUSIBLE_BURN = 1_000_000_000; // 1B tokens (total supply ceiling)
    function sanitizeBurn(val){
      let v = Number(val) || 0;
      if (v <= MAX_PLAUSIBLE_BURN) return v;       // already clean
      // Try dividing by 1e9 (9 decimals) — the normal contamination
      if (v / 1e9 <= MAX_PLAUSIBLE_BURN) return v / 1e9;
      // Fallback: try 1e6 (6 decimals) in case a different scale slipped in
      if (v / 1e6 <= MAX_PLAUSIBLE_BURN) return v / 1e6;
      // Last resort: clamp by repeated /1e3 until plausible
      let guard = 0;
      while (v > MAX_PLAUSIBLE_BURN && guard < 6) { v = v / 1e3; guard++; }
      return v;
    }

    const entries = [];
    for (let i = 0; i < raw.length; i += 2) {
      const wallet = raw[i];
      let score = Number(raw[i + 1]);
      if (!wallet) continue;
      const entry = { wallet, rank: entries.length + 1 };
      if (type === 'earn') {
        entry.totalReceivedSol = score / 1e9; // lamports → SOL
      } else {
        const fixed = sanitizeBurn(score, wallet);
        // If we corrected it, rewrite the clean value back to Redis so the
        // sort order self-heals on next read
        if (fixed !== score) {
          await redis(['ZADD', key, Math.round(fixed), wallet]);
        }
        entry.tokensBurned = fixed;
      }
      entries.push(entry);
    }
    // Re-sort + re-rank after any corrections (a fixed score may drop in rank)
    if (type === 'burn') {
      entries.sort((a, b) => b.tokensBurned - a.tokensBurned);
      entries.forEach((e, i) => { e.rank = i + 1; });
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
          // Only use meta.tokensBurned if it's plausible; otherwise keep the
          // sanitized score we already computed
          if (type === 'burn' && meta.tokensBurned) {
            const metaFixed = sanitizeBurn(meta.tokensBurned, e.wallet);
            e.tokensBurned = metaFixed;
          }
          if (type === 'earn' && meta.totalReceivedSol != null) e.totalReceivedSol = meta.totalReceivedSol;
        } catch(_) {}
      }
    }));

    // Attach usernames (if any) to each entry
    await Promise.all(entries.map(async (e) => {
      const name = await redis(['GET', 'drippy:username:' + e.wallet]);
      if (name) e.username = name;
    }));

    res.status(200).json({ configured: true, type, entries, total, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[leaderboard] error:', err);
    res.status(500).json({ error: err.message || 'Unknown error', entries: [], total: 0 });
  }
};
