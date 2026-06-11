// /api/rebuild-burns.js
// Deterministic FULL rebuild of the burn ledger from on-chain truth.
//
// Why this exists: backfill-burns is incremental and relies on per-signature
// dedup guards with TTLs (14-90 days). Once a guard expires, re-running the
// backfill double counts that burn. This endpoint instead scans the COMPLETE
// burn-account history, aggregates per wallet in memory, and atomically
// replaces the leaderboard, totals, and wallet metas. The result is always
// exactly the chain state — safe to run any number of times.
//
// Usage:  GET /api/rebuild-burns
//         Header: x-admin-secret: <DRIPPY_EVENTS_SECRET>
//
// Required env vars: DRIPPY_EVENTS_SECRET, HELIUS_API_KEY,
//                    KV_REST_API_URL, KV_REST_API_TOKEN

const TOKEN_MINT = 'EPRZgmvU4aTQ4UaC4bywgNvxJ5YmhuKqM1bx3gw4DRPY';
const BURN_ADDRESS = 'N1LCBQJnjLP3ppv7npzL5Btzf5Yp3hBMr6s8GmVfEyV';

const ADMIN_SECRET = process.env.DRIPPY_EVENTS_SECRET;
const HELIUS_KEY = process.env.HELIUS_API_KEY;
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const LB_BURN_KEY = 'drippy:burn:leaderboard';
const META_PREFIX = 'drippy:meta:';
const TOTAL_KEY = 'drippy:burn:total';
const TOTAL_EVENTS_KEY = 'drippy:burn:events';

const HELIUS_RPC = () => 'https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY;
const PARSE_URL = () => 'https://api.helius.xyz/v0/transactions?api-key=' + HELIUS_KEY;

async function redis(command){
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(command.map(String))
  });
  if(!r.ok) throw new Error('redis HTTP ' + r.status);
  const j = await r.json();
  if(j.error) throw new Error('redis: ' + j.error);
  return j.result;
}

// Upstash/Vercel KV REST pipeline: one round trip for many commands.
async function pipeline(commands){
  if(!commands.length) return [];
  const out = [];
  for(let i = 0; i < commands.length; i += 400){
    const chunk = commands.slice(i, i + 400);
    const r = await fetch(REDIS_URL.replace(/\/$/, '') + '/pipeline', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk.map(c => c.map(String)))
    });
    if(!r.ok) throw new Error('pipeline HTTP ' + r.status);
    const j = await r.json();
    out.push(...(Array.isArray(j) ? j : []));
  }
  return out;
}

async function rpc(method, params){
  const r = await fetch(HELIUS_RPC(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  if(!r.ok) throw new Error(method + ' HTTP ' + r.status);
  const j = await r.json();
  if(j.error) throw new Error(method + ': ' + j.error.message);
  return j.result;
}

async function parseTxs(sigs){
  const r = await fetch(PARSE_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactions: sigs })
  });
  if(!r.ok) throw new Error('parse HTTP ' + r.status);
  return r.json();
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if(!ADMIN_SECRET || !HELIUS_KEY || !REDIS_URL || !REDIS_TOKEN){
    res.status(500).json({ error: 'missing env config' });
    return;
  }
  if((req.headers['x-admin-secret'] || '') !== ADMIN_SECRET){
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try{
    // 1. burn address token account for the mint
    const tas = await rpc('getTokenAccountsByOwner', [BURN_ADDRESS, { mint: TOKEN_MINT }, { encoding: 'jsonParsed' }]);
    if(!tas.value || !tas.value.length){
      res.status(200).json({ ok: false, note: 'no token account on burn address' });
      return;
    }
    const tokenAccount = tas.value[0].pubkey;

    // 2. complete signature history (newest -> oldest)
    let sigs = [], before;
    for(let page = 0; page < 25; page++){
      const opts = { limit: 1000 };
      if(before) opts.before = before;
      const batch = await rpc('getSignaturesForAddress', [tokenAccount, opts]);
      if(!batch.length) break;
      for(const s of batch) if(!s.err) sigs.push(s.signature);
      before = batch[batch.length - 1].signature;
      if(batch.length < 1000) break;
    }

    // 3. parse + aggregate burns per wallet
    const agg = {};
    let totalUi = 0, totalEvents = 0;
    for(let i = 0; i < sigs.length; i += 100){
      const txs = await parseTxs(sigs.slice(i, i + 100));
      for(const tx of (txs || [])){
        if(!tx || tx.transactionError) continue;
        for(const t of (tx.tokenTransfers || [])){
          if(t.mint !== TOKEN_MINT) continue;
          const amount = Number(t.tokenAmount) || 0;
          if(amount <= 0) continue;
          let w = null;
          if(t.toUserAccount === BURN_ADDRESS && t.fromUserAccount && t.fromUserAccount !== BURN_ADDRESS) w = t.fromUserAccount;
          else if(tx.type === 'BURN' && t.fromUserAccount && t.fromUserAccount !== BURN_ADDRESS) w = t.fromUserAccount;
          if(!w) continue;
          const a = agg[w] || (agg[w] = { amount: 0, events: 0, lastAt: 0 });
          a.amount += amount; a.events += 1;
          a.lastAt = Math.max(a.lastAt, (tx.timestamp || 0) * 1000);
          totalUi += amount; totalEvents += 1;
        }
      }
    }

    // 4. atomically replace ledger
    const wallets = Object.keys(agg);
    const oldMembers = (await redis(['ZRANGE', LB_BURN_KEY, '0', '-1'])) || [];
    const stale = oldMembers.filter(m => !agg[m]);

    const metaReads = await pipeline(wallets.concat(stale).map(w => ['GET', META_PREFIX + w]));
    const metaOf = (i) => {
      const raw = metaReads[i] && metaReads[i].result;
      if(!raw) return {};
      try{ return JSON.parse(raw) || {}; }catch(_){ return {}; }
    };

    const cmds = [
      ['DEL', LB_BURN_KEY],
      ['SET', TOTAL_KEY, String(totalUi)],
      ['SET', TOTAL_EVENTS_KEY, String(totalEvents)],
    ];
    wallets.forEach((w, i) => {
      const meta = metaOf(i);
      meta.tokensBurned = agg[w].amount;
      meta.burnEvents = agg[w].events;
      meta.lastBurnAt = agg[w].lastAt || meta.lastBurnAt || null;
      meta.updatedAt = Date.now();
      cmds.push(['ZADD', LB_BURN_KEY, String(agg[w].amount), w]);
      cmds.push(['SET', META_PREFIX + w, JSON.stringify(meta)]);
    });
    stale.forEach((w, j) => {
      const meta = metaOf(wallets.length + j);
      meta.tokensBurned = 0;
      meta.burnEvents = 0;
      meta.updatedAt = Date.now();
      cmds.push(['SET', META_PREFIX + w, JSON.stringify(meta)]);
    });
    await pipeline(cmds);

    res.status(200).json({
      ok: true,
      sigsScanned: sigs.length,
      wallets: wallets.length,
      burnEvents: totalEvents,
      tokensBurned: totalUi,
      staleWalletsCleared: stale.length
    });
  }catch(e){
    res.status(500).json({ error: String(e.message || e) });
  }
};
