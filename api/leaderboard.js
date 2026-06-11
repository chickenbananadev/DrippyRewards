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

  // ----- WEEKLY TOURNAMENT board (Top Dogs — Skill) -----
  // Eligibility: anyone can play, but to be eligible for the 100K $DRIPPY prize
  // they must (a) be signed in with a verified wallet (POST carries session cookie),
  // (b) hold >= 100K $DRIPPY at payout time (checked Sunday).
  // Resets weekly. Key = drippy:game:weekly:<YYYY>-<WW>.
  //   GET  ?board=weekly                        -> { week, scores: [{ wallet|n, s }] }
  //   POST ?board=weekly { score, beat }        -> { ok, eligible, rank }  (session cookie required for eligibility flag)
  if ((req.query.board || '') === 'weekly') {
    const now = new Date();
    const yr = now.getUTCFullYear();
    // ISO week number
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dayNum = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const wk = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    const weekKey = `${yr}-W${String(wk).padStart(2,'0')}`;
    const ZWEEK = `drippy:game:weekly:${weekKey}`;
    const RLWK = 'drippy:game:weekly:rl:';
    const MAX = 2000000;

    // Session cookie reader (inline; we don't import username.js helpers)
    const cookie = (req.headers.cookie || '').match(/drippy_session=([^;]+)/);
    const SESSION_SECRET = process.env.DRIPPY_SESSION_SECRET || process.env.DRIPPY_EVENTS_SECRET || '';
    let signedWallet = null;
    if (cookie && SESSION_SECRET) {
      try {
        const crypto = require('crypto');
        const parts = decodeURIComponent(cookie[1]).split('.');
        if (parts.length === 3 && (Date.now() - Number(parts[1])) < 7*24*3600*1000) {
          const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`${parts[0]}|${parts[1]}`).digest('base64url');
          if (parts[2] === expected) signedWallet = parts[0];
        }
      } catch(_) {}
    }

    // Admin: DELETE ?board=weekly&member=X (member can be a wallet or "anon:NAME:ip" form)
    if (req.method === 'DELETE') {
      if ((req.headers['x-admin-secret'] || '') !== process.env.DRIPPY_EVENTS_SECRET) { res.status(401).json({ error: 'unauthorized' }); return; }
      const member = String(req.query.member || '');
      if (member) await redis(['ZREM', ZWEEK, member]);
      res.status(200).json({ removed: member });
      return;
    }
    // Admin: PUT ?board=weekly {member, score} — set/edit any score on this week's board
    if (req.method === 'PUT') {
      if ((req.headers['x-admin-secret'] || '') !== process.env.DRIPPY_EVENTS_SECRET) { res.status(401).json({ error: 'unauthorized' }); return; }
      let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch(_) { b = null; } }
      if (!b) { res.status(400).json({ error: 'bad body' }); return; }
      const member = String(b.member || '').trim();
      const score = Math.round(Number(b.score) || 0);
      if (!member || !(score >= 0)) { res.status(400).json({ error: 'member + numeric score required' }); return; }
      await redis(['ZADD', ZWEEK, String(score), member]);
      res.status(200).json({ ok: true, member, score });
      return;
    }
    if (req.method === 'POST') {
      let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch(_) { b = null; } }
      if (!b) { res.status(400).json({ error: 'bad body' }); return; }
      const score = Math.round(Number(b.score) || 0);
      if (!(score > 0) || score > MAX) { res.status(400).json({ error: 'score out of range' }); return; }
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      const rlKey = RLWK + (signedWallet || (b.wallet || ip));
      const rl = await redis(['SET', rlKey, '1', 'NX', 'EX', '20']);
      if (rl !== null && rl !== 'OK') { res.status(429).json({ error: 'one log per 20s' }); return; }
      const cleanName = String(b.name || 'DRIPPY').toUpperCase().replace(/[^A-Z0-9 _.\-]/g,'').trim().slice(0,12) || 'DRIPPY';

      // Three eligibility paths:
      //   1. Signed in cookie → wallet auto-pulled, status='verified' (can auto-claim prize)
      //   2. Unsigned but provided a wallet that currently holds ≥25K $DRIPPY → status='holder' (must sign in to claim)
      //   3. Neither → anonymous (ineligible)
      const STATUS_KEY = `drippy:game:weekly:status:${weekKey}`;
      let member, status = 'anon';
      if (signedWallet) {
        member = signedWallet; status = 'verified';
      } else if (b.wallet && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(b.wallet))) {
        // Lightweight on-chain holdings check via internal /api/wallet
        try {
          const origin = `https://${req.headers.host || 'drippyrewards.com'}`;
          const r2 = await fetch(`${origin}/api/wallet?address=${b.wallet}`, { cache: 'no-store' });
          const d = await r2.json();
          const holds = Number(d?.currentHoldings?.uiAmount || 0);
          if (holds >= 25000) { member = String(b.wallet); status = 'holder'; }
        } catch(e) {}
      }
      if (!member) { member = `anon:${cleanName}:${ip.slice(0,12)}`; status = 'anon'; }

      await redis(['ZADD', ZWEEK, 'GT', 'CH', String(score), member]);
      // Track status per member (verified/holder/anon) — verified beats holder if both exist
      const existing = await redis(['HGET', STATUS_KEY, member]);
      if (!existing || (existing === 'holder' && status === 'verified')) {
        await redis(['HSET', STATUS_KEY, member, status]);
      }
      await redis(['EXPIRE', ZWEEK, String(28*24*3600)]);
      await redis(['EXPIRE', STATUS_KEY, String(28*24*3600)]);
      const rank = await redis(['ZREVRANK', ZWEEK, member]);
      res.status(200).json({
        ok: true, week: weekKey,
        status, // 'verified' | 'holder' | 'anon'
        eligible: status === 'verified' || status === 'holder',
        verified: status === 'verified',
        rank: rank != null ? Number(rank) + 1 : null
      });
      return;
    }

    // GET — top N with display names + verified/holder status (default 25, max 50)
    const wkLimit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const raw = await redis(['ZREVRANGE', ZWEEK, '0', String(wkLimit - 1), 'WITHSCORES']);
    const STATUS_KEY = `drippy:game:weekly:status:${weekKey}`;
    const statusMap = {};
    const rawStatus = await redis(['HGETALL', STATUS_KEY]);
    if (Array.isArray(rawStatus)) for (let i = 0; i < rawStatus.length; i += 2) statusMap[rawStatus[i]] = rawStatus[i+1];
    const scores = [];
    const wallets = [];
    if (Array.isArray(raw)) for (let i = 0; i < raw.length; i += 2) {
      const m = raw[i]; const s = Math.round(Number(raw[i+1]) || 0);
      const status = statusMap[m] || (m.startsWith('anon:') ? 'anon' : 'holder');
      // member is the raw Redis member string — admin needs this verbatim to DELETE/PUT
      if (m.startsWith('anon:')) {
        const parts = m.split(':');
        scores.push({ n: parts[1] || 'DRIPPY', s, status: 'anon', eligible: false, verified: false, member: m });
      } else {
        scores.push({ wallet: m, s, status, eligible: status === 'verified' || status === 'holder', verified: status === 'verified', member: m });
        wallets.push(m);
      }
    }
    // Look up usernames for wallet entries
    if (wallets.length) {
      await Promise.all(scores.map(async (e) => {
        if (!e.wallet) return;
        const name = await redis(['GET', 'drippy:username:' + e.wallet]);
        e.n = name || (e.wallet.slice(0,4) + '...' + e.wallet.slice(-4));
      }));
    }
    res.status(200).json({ week: weekKey, scores });
    return;
  }

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
    // Admin edit: set a name's score (bypasses GT). PUT ?board=game {name, score, beat?}
    if (req.method === 'PUT') {
      if ((req.headers['x-admin-secret'] || '') !== process.env.DRIPPY_EVENTS_SECRET) { res.status(401).json({ error: 'unauthorized' }); return; }
      let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch(_) { b = null; } }
      if (!b) { res.status(400).json({ error: 'bad body' }); return; }
      const name = clean(b.name);
      const score = Math.round(Number(b.score) || 0);
      if (!name || !(score >= 0)) { res.status(400).json({ error: 'name + numeric score required' }); return; }
      // Plain ZADD (no GT): admin can set any value (including lowering)
      await redis(['ZADD', ZKEY, String(score), name]);
      if (b.beat === true)  await redis(['HSET', FLAGS, name, '1']);
      if (b.beat === false) await redis(['HDEL', FLAGS, name]);
      res.status(200).json({ ok: true, name, score });
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
      // Persist the skin used — only stamp when this submission IS the new top score for this name
      const SKIN_KEY = 'drippy:game:skin';
      const allowedSkins = ['default','believer','bronze','silver','gold','diamond','void','shadow'];
      const skin = allowedSkins.includes(String(b.skin || '').toLowerCase()) ? String(b.skin).toLowerCase() : 'default';
      const curTop = await redis(['ZSCORE', ZKEY, name]);
      if (Math.round(Number(curTop) || 0) === score) await redis(['HSET', SKIN_KEY, name, skin]);
      const rank = await redis(['ZREVRANK', ZKEY, name]);
      res.status(200).json({ ok: true, rank: rank != null ? Number(rank) + 1 : null });
      return;
    }
    const gmLimit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const raw = await redis(['ZREVRANGE', ZKEY, '0', String(gmLimit - 1), 'WITHSCORES']);
    const flagsRaw = await redis(['HGETALL', FLAGS]);
    const flags = {}; if (Array.isArray(flagsRaw)) for (let i = 0; i < flagsRaw.length; i += 2) flags[flagsRaw[i]] = flagsRaw[i + 1];
    const SKIN_KEY = 'drippy:game:skin';
    const skinsRaw = await redis(['HGETALL', SKIN_KEY]);
    const skins = {}; if (Array.isArray(skinsRaw)) for (let i = 0; i < skinsRaw.length; i += 2) skins[skinsRaw[i]] = skinsRaw[i + 1];
    const scores = [];
    if (Array.isArray(raw)) for (let i = 0; i < raw.length; i += 2) scores.push({
      n: raw[i],
      s: Math.round(Number(raw[i + 1]) || 0),
      beat: flags[raw[i]] === '1',
      skin: skins[raw[i]] || null
    });
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
