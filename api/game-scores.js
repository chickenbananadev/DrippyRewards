// /api/game-scores.js
// Global DRIPPY RUN leaderboard.
//   GET  -> { scores: [{ n, s, beat }] }  (top 25, best score per name)
//   POST { name, score, beat } -> { ok, rank }
// Storage: Redis zset (best score per name via ZADD GT) + a hash for the
// "beat the game" crown. Light per-IP rate limit on submissions.
// Required env vars: KV_REST_API_URL, KV_REST_API_TOKEN (same as burn pipeline)

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const ZKEY = 'drippy:game:leaderboard';   // zset name -> best score
const FLAGS = 'drippy:game:beat';         // hash name -> '1' if they beat The Shadow
const RL_PREFIX = 'drippy:game:rl:';      // per-ip submit guard
const MAX_SCORE = 200000;                 // sanity cap; legit runs land well below

async function redis(command){
  if(!REDIS_URL || !REDIS_TOKEN) return null;
  try{
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(command.map(String))
    });
    if(!r.ok) return null;
    const j = await r.json();
    if(j.error){ console.error('[redis]', j.error); return null; }
    return j.result;
  }catch(e){ console.error('[redis]', e.message); return null; }
}

function cleanName(n){
  return String(n || '').toUpperCase().replace(/[^A-Z0-9 _.\-]/g, '').trim().slice(0, 12) || 'DRIPPY';
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if(req.method === 'GET'){
    const raw = await redis(['ZREVRANGE', ZKEY, '0', '24', 'WITHSCORES']);
    const flagsRaw = await redis(['HGETALL', FLAGS]);
    const flags = {};
    if(Array.isArray(flagsRaw)) for(let i = 0; i < flagsRaw.length; i += 2) flags[flagsRaw[i]] = flagsRaw[i + 1];
    const scores = [];
    if(Array.isArray(raw)) for(let i = 0; i < raw.length; i += 2){
      scores.push({ n: raw[i], s: Math.round(Number(raw[i + 1]) || 0), beat: flags[raw[i]] === '1' });
    }
    res.status(200).json({ scores });
    return;
  }

  if(req.method === 'POST'){
    let b = req.body;
    if(typeof b === 'string'){ try{ b = JSON.parse(b); }catch(_){ b = null; } }
    if(!b){ res.status(400).json({ error: 'bad body' }); return; }
    const name = cleanName(b.name);
    const score = Math.round(Number(b.score) || 0);
    if(!(score > 0) || score > MAX_SCORE){ res.status(400).json({ error: 'score out of range' }); return; }

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const rl = await redis(['SET', RL_PREFIX + ip, '1', 'NX', 'EX', '20']);
    if(rl !== null && rl !== 'OK'){ res.status(429).json({ error: 'easy, pup — one log per 20s' }); return; }

    await redis(['ZADD', ZKEY, 'GT', 'CH', String(score), name]);
    if(b.beat) await redis(['HSET', FLAGS, name, '1']);
    const rank = await redis(['ZREVRANK', ZKEY, name]);
    res.status(200).json({ ok: true, rank: rank != null ? Number(rank) + 1 : null });
    return;
  }

  res.status(405).json({ error: 'GET or POST only' });
};
