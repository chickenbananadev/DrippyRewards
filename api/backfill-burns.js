// /api/backfill-burns.js
// One-time (resumable) backfill of historical burns. Scans the burn address's
// $DRIPPY token account history via Helius, finds inbound transfers of the
// mint, and records them with the same dedup guard as the live webhook, so it
// is safe to run alongside it and safe to run multiple times.
//
// Usage (repeat until done:true):
//   GET /api/backfill-burns
//   Header: x-admin-secret: <DRIPPY_EVENTS_SECRET>
//
// Each call processes up to ~300 transactions and stores a cursor in Redis so
// the next call resumes where it left off. Add ?reset=1 to start over.
//
// Required env vars: DRIPPY_EVENTS_SECRET, HELIUS_API_KEY, KV_REST_API_URL, KV_REST_API_TOKEN

const TOKEN_MINT = 'EPRZgmvU4aTQ4UaC4bywgNvxJ5YmhuKqM1bx3gw4DRPY';
const BURN_ADDRESS = 'N1LCBQJnjLP3ppv7npzL5Btzf5Yp3hBMr6s8GmVfEyV';

const ADMIN_SECRET = process.env.DRIPPY_EVENTS_SECRET; // no fallback
const HELIUS_KEY = process.env.HELIUS_API_KEY;          // no fallback
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const HELIUS_RPC = () => 'https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY;
const PARSE_URL = () => 'https://api.helius.xyz/v0/transactions?api-key=' + HELIUS_KEY;

const LB_BURN_KEY = 'drippy:burn:leaderboard';
const META_PREFIX = 'drippy:meta:';
const TOTAL_KEY = 'drippy:burn:total';
const TOTAL_EVENTS_KEY = 'drippy:burn:events';
const SIG_PREFIX = 'drippy:burnsig:';
const CURSOR_KEY = 'drippy:burn:backfill:cursor';
const DONE_KEY = 'drippy:burn:backfill:done';

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

async function recordBurn(wallet, amount, sig, timestamp){
  // Permanent guard — expiring guards caused double counting on re-runs.
  const guard = await redis(['SET', SIG_PREFIX + sig + ':' + wallet, '1', 'NX']);
  if(guard !== 'OK') return false;
  await redis(['ZINCRBY', LB_BURN_KEY, String(amount), wallet]);
  await redis(['INCRBYFLOAT', TOTAL_KEY, String(amount)]);
  await redis(['INCR', TOTAL_EVENTS_KEY]);
  let meta = {};
  const existing = await redis(['GET', META_PREFIX + wallet]);
  if(existing){ try{ meta = JSON.parse(existing); }catch(_){} }
  meta.tokensBurned = (Number(meta.tokensBurned) || 0) + amount;
  meta.burnEvents = (Number(meta.burnEvents) || 0) + 1;
  meta.lastBurnAt = timestamp || meta.lastBurnAt || null;
  meta.updatedAt = Date.now();
  await redis(['SET', META_PREFIX + wallet, JSON.stringify(meta)]);
  return true;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if(!ADMIN_SECRET){ res.status(500).json({ error: 'DRIPPY_EVENTS_SECRET not configured' }); return; }
  if(!HELIUS_KEY){ res.status(500).json({ error: 'HELIUS_API_KEY not configured' }); return; }

  const secret = req.headers['x-admin-secret'];
  if(secret !== ADMIN_SECRET){ res.status(401).json({ error: 'unauthorized' }); return; }

  try{
    if(req.query.reset === '1'){
      await redis(['DEL', CURSOR_KEY]);
      await redis(['DEL', DONE_KEY]);
    }

    const alreadyDone = await redis(['GET', DONE_KEY]);
    if(alreadyDone === '1'){
      res.status(200).json({ done: true, note: 'Backfill already complete. Use ?reset=1 to rerun.' });
      return;
    }

    // Find the burn address's token account for the mint. Scanning the token
    // account's history is far cheaper than scanning the whole address, which
    // also carries every 30 minute SOL distribution.
    const accounts = await rpc('getTokenAccountsByOwner', [BURN_ADDRESS, { mint: TOKEN_MINT }, { encoding: 'jsonParsed' }]);
    const tokenAccount = accounts?.value?.[0]?.pubkey;
    if(!tokenAccount){
      res.status(200).json({ done: true, note: 'No token account found for the mint on the burn address.' });
      await redis(['SET', DONE_KEY, '1']);
      return;
    }

    let cursor = await redis(['GET', CURSOR_KEY]);
    let processed = 0;
    let recorded = 0;
    let pages = 0;
    let reachedEnd = false;

    while(pages < 3){ // ~300 txs per invocation, stays inside the time limit
      const params = [tokenAccount, { limit: 100 }];
      if(cursor) params[1].before = cursor;
      const sigs = await rpc('getSignaturesForAddress', params);
      if(!sigs || sigs.length === 0){ reachedEnd = true; break; }

      const sigList = sigs.map(s => s.signature);
      const parseRes = await fetch(PARSE_URL(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: sigList })
      });
      if(!parseRes.ok) throw new Error('enhanced parse HTTP ' + parseRes.status);
      const txs = await parseRes.json();

      for(const tx of (txs || [])){
        if(!tx || tx.transactionError) continue;
        for(const t of (tx.tokenTransfers || [])){
          if(t.mint !== TOKEN_MINT) continue;
          if(t.toUserAccount !== BURN_ADDRESS) continue;
          if(!t.fromUserAccount || t.fromUserAccount === BURN_ADDRESS) continue;
          const amount = Number(t.tokenAmount) || 0;
          if(amount <= 0) continue;
          const ok = await recordBurn(t.fromUserAccount, amount, tx.signature, (tx.timestamp || 0) * 1000);
          if(ok) recorded++;
        }
        processed++;
      }

      cursor = sigList[sigList.length - 1];
      await redis(['SET', CURSOR_KEY, cursor]);
      pages++;
      if(sigs.length < 100){ reachedEnd = true; break; }
    }

    if(reachedEnd) await redis(['SET', DONE_KEY, '1']);

    res.status(200).json({
      done: reachedEnd,
      processedThisRun: processed,
      burnsRecordedThisRun: recorded,
      cursor,
      note: reachedEnd ? 'Backfill complete.' : 'Call this endpoint again to continue.'
    });
  }catch(err){
    console.error('[backfill]', err);
    res.status(500).json({ error: err.message });
  }
};
