// /api/wallet.js
// Wallet stats for $DRIPPY. Sources:
//   Helius RPC: current holdings
//   Helius enhanced API: SOL received from the rewards distributor
//   Redis: burn stats (fed by /api/burn-webhook), leaderboard ranks, and an
//          incremental earnings cache so totals are accurate beyond the most
//          recent transactions and repeat checks are cheap.
//
// Required env vars: HELIUS_API_KEY, KV_REST_API_URL, KV_REST_API_TOKEN

const TOKEN_MINT = 'EPRZgmvU4aTQ4UaC4bywgNvxJ5YmhuKqM1bx3gw4DRPY';
const DISTRIBUTOR = 'N1LCBQJnjLP3ppv7npzL5Btzf5Yp3hBMr6s8GmVfEyV';
const HELIUS_KEY = process.env.HELIUS_API_KEY; // no fallback, on purpose

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const LB_BURN_KEY = 'drippy:burn:leaderboard';
const LB_EARN_KEY = 'drippy:earn:leaderboard';
const META_PREFIX = 'drippy:meta:';
const EARN_CACHE_PREFIX = 'drippy:earn:cache:'; // per wallet incremental scan state
const TOTAL_BURN_KEY = 'drippy:burn:total';

const HELIUS_RPC = () => 'https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY;
const PARSE_URL = () => 'https://api.helius.xyz/v0/transactions?api-key=' + HELIUS_KEY;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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
    if(j.error) return null;
    return j.result;
  }catch(e){ return null; }
}

function withTimeout(p, ms){
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]);
}

// RPC endpoint chain: Helius first, then free public endpoints (Helius has
// been sustaining 429s on plan quota). Standard JSON-RPC methods used here
// work on public endpoints too. Sticky preference per warm instance.
function rpcEndpoints(){
  const eps = [];
  if (HELIUS_KEY) eps.push(HELIUS_RPC());
  eps.push('https://api.mainnet-beta.solana.com');
  eps.push('https://solana-rpc.publicnode.com');
  return eps;
}
let rpcPreferred = 0;
async function rpc(method, params){
  const eps = rpcEndpoints();
  let lastErr = null;
  for (let n = 0; n < eps.length; n++){
    const i = (rpcPreferred + n) % eps.length;
    try{
      const r = await fetch(eps[i], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      });
      if(!r.ok) throw new Error(method + ' HTTP ' + r.status);
      const j = await r.json();
      if(j.error) throw new Error(method + ': ' + j.error.message);
      rpcPreferred = i;
      return j.result;
    }catch(e){ lastErr = e; }
  }
  throw lastErr;
}

async function balanceViaRpc(owner){
  const result = await rpc('getTokenAccountsByOwner', [owner, { mint: TOKEN_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const accounts = result?.value || [];
  let total = 0;
  accounts.forEach(acc => {
    const ui = acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
    if(typeof ui === 'number') total += ui;
  });
  return total;
}

// Fallback: Helius DAS getTokenAccounts (different backend than the RPC path).
// Returns raw base units; DRIPPY has 9 decimals.
async function balanceViaDas(owner){
  const r = await fetch(HELIUS_RPC(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccounts', params: { owner, mint: TOKEN_MINT, limit: 100 } })
  });
  if(!r.ok) throw new Error('das ' + r.status);
  const j = await r.json();
  const accounts = j?.result?.token_accounts;
  if(!Array.isArray(accounts)) throw new Error('das bad response');
  let raw = 0;
  accounts.forEach(a => { raw += Number(a.amount) || 0; });
  return raw / 1e9;
}

// Returns the wallet's DRIPPY balance, or null when it could NOT be determined.
// null must never be rendered as 0 — the frontend shows "—" for unknown.
async function getOnChainBalance(owner){
  try{ return await balanceViaRpc(owner); }catch(e1){
    try{ return await balanceViaRpc(owner); }catch(e2){
      try{ return await balanceViaDas(owner); }catch(e3){
        console.error('[balance]', owner.slice(0,8), e1.message, '|', e2.message, '|', e3.message);
        return null;
      }
    }
  }
}

// Incremental distribution scan.
// Cache shape v2: { v: 2, totalLamports, count, newestSig, recent: [...], updatedAt }
//
// Correctness rules (a prior version violated all three and permanently
// zeroed wallets that were first checked while Helius was rate-limited):
//   1. newestSig only ever advances through signatures that were actually
//      PARSED — a failed parse must never mark history as processed.
//   2. Signatures are processed oldest→newest so a partial pass leaves a
//      clean resume point instead of holes.
//   3. `until` is applied to every signature page, so paging can't descend
//      into already-counted history and double count.
// v1 caches are discarded (v2 marker) so previously-poisoned wallets heal
// with a full rescan on their next check.
const EARN_CACHE_V = 2;
const SIG_PAGE_LIMIT = 1000;   // getSignaturesForAddress max per page
const SIG_MAX_PAGES = 3;       // up to 3,000 sigs ≈ two months at 48 drips/day
const FALLBACK_TX_CAP = 40;    // per-check budget for per-tx parsing on public RPC

async function getDistributions(owner){
  let cache = null;
  const cachedStr = await redis(['GET', EARN_CACHE_PREFIX + owner]);
  if(cachedStr){ try{ cache = JSON.parse(cachedStr); }catch(_){} }
  if(cache && cache.v !== EARN_CACHE_V) cache = null; // discard poisoned v1 state

  // Within 60 seconds of the last scan just serve the cache untouched.
  if(cache && cache.updatedAt && (Date.now() - cache.updatedAt) < 60_000){
    return { totalSol: cache.totalLamports / 1e9, count: cache.count, recent: cache.recent || [], cached: true, syncing: !!cache.syncing };
  }

  const state = cache || { v: EARN_CACHE_V, totalLamports: 0, count: 0, newestSig: null, recent: [] };
  state.v = EARN_CACHE_V;

  try{
    // Collect signatures newer than the last processed one (newest-first).
    let newSigs = [];
    let before = null;
    for(let page = 0; page < SIG_MAX_PAGES; page++){
      const opts = { limit: SIG_PAGE_LIMIT };
      if(before) opts.before = before;
      if(state.newestSig) opts.until = state.newestSig; // every page, not just the first
      const sigs = await rpc('getSignaturesForAddress', [owner, opts]);
      if(!sigs || !sigs.length) break;
      newSigs = newSigs.concat(sigs.filter(s => !s.err).map(s => s.signature));
      if(sigs.length < SIG_PAGE_LIMIT) break;
      before = sigs[sigs.length - 1].signature;
    }

    if(newSigs.length){
      const oldestFirst = newSigs.slice().reverse();
      const parsedDrips = [];       // oldest-first while collecting
      let parsedThrough = -1;       // index into oldestFirst of the last parsed sig

      // --- Primary: Helius enhanced parse, 100-sig chunks in order.
      // Stop at the first failed chunk; everything before it is counted and
      // newestSig advances exactly that far.
      for(let i = 0; i < oldestFirst.length; i += 100){
        const batch = oldestFirst.slice(i, i + 100);
        let txs = null;
        try{
          const parseRes = await fetch(PARSE_URL(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transactions: batch })
          });
          if(parseRes.ok) txs = await parseRes.json();
        }catch(_){ /* fall through */ }
        if(!Array.isArray(txs)) break;
        for(const tx of txs){
          for(const t of (tx.nativeTransfers || [])){
            if(t.fromUserAccount === DISTRIBUTOR && t.toUserAccount === owner){
              const lamports = Number(t.amount) || 0;
              if(lamports > 0){
                parsedDrips.push({
                  timestamp: tx.timestamp ? new Date(tx.timestamp * 1000).toISOString() : null,
                  amountSol: lamports / 1e9,
                  status: 'succeeded',
                  txSig: tx.signature
                });
              }
            }
          }
        }
        parsedThrough = Math.min(i + 100, oldestFirst.length) - 1;
      }

      // --- Fallback: Helius parse unavailable → standard getTransaction on
      // the RPC chain (public endpoints), a bounded slice per check. Repeat
      // checks keep advancing until history is fully counted.
      if(parsedThrough < 0){
        const slice = oldestFirst.slice(0, FALLBACK_TX_CAP);
        const settled = await Promise.allSettled(slice.map(sig =>
          rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]).then(tx => ({ sig, tx }))
        ));
        for(let i = 0; i < settled.length; i++){
          const s = settled[i];
          if(s.status !== 'fulfilled'){ break; } // keep the resume point contiguous
          const { sig, tx } = s.value;
          parsedThrough = i;
          if(!tx || !tx.meta || !tx.transaction) continue;
          const keys = (tx.transaction.message.accountKeys || []).map(k => (typeof k === 'string') ? k : (k && k.pubkey));
          const oi = keys.indexOf(owner);
          const di = keys.indexOf(DISTRIBUTOR);
          if(oi < 0 || di < 0) continue;
          const pre = tx.meta.preBalances || [];
          const post = tx.meta.postBalances || [];
          const gained = (post[oi] || 0) - (pre[oi] || 0);
          const distPaid = (pre[di] || 0) > (post[di] || 0);
          if(gained > 0 && distPaid){
            parsedDrips.push({
              timestamp: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
              amountSol: gained / 1e9,
              status: 'succeeded',
              txSig: sig
            });
          }
        }
      }

      if(parsedThrough >= 0){
        for(const d of parsedDrips){
          state.totalLamports += Math.round(d.amountSol * 1e9);
          state.count++;
        }
        // Newest first: fresh payouts go in front of cached ones
        state.recent = parsedDrips.slice().reverse().concat(state.recent || []).slice(0, 10);
        state.newestSig = oldestFirst[parsedThrough]; // ONLY as far as actually parsed
      }
      state.syncing = parsedThrough < (oldestFirst.length - 1); // backlog remains
    } else {
      state.syncing = false;
    }

    state.updatedAt = Date.now();
    await redis(['SET', EARN_CACHE_PREFIX + owner, JSON.stringify(state)]);
    return { totalSol: state.totalLamports / 1e9, count: state.count, recent: state.recent, syncing: !!state.syncing };
  }catch(e){
    console.error('[distributions]', e.message);
    // If the scan fails but we have a cache, serve the cache.
    if(cache) return { totalSol: cache.totalLamports / 1e9, count: cache.count, recent: cache.recent || [], stale: true, syncing: !!cache.syncing };
    return null;
  }
}

async function getBurnAndRanks(owner){
  const out = { burner: null, burnRank: null, earnRank: null };
  try{
    const [metaStr, totalBurnStr, br, er] = await Promise.all([
      redis(['GET', META_PREFIX + owner]),
      redis(['GET', TOTAL_BURN_KEY]),
      redis(['ZREVRANK', LB_BURN_KEY, owner]),
      redis(['ZREVRANK', LB_EARN_KEY, owner])
    ]);
    if(metaStr){
      const meta = JSON.parse(metaStr);
      let burnUi = Number(meta.tokensBurned) || 0;
      // Repair legacy raw (9 decimal) values
      if(burnUi > 1_000_000_000){
        if(burnUi / 1e9 <= 1_000_000_000) burnUi = burnUi / 1e9;
        else if(burnUi / 1e6 <= 1_000_000_000) burnUi = burnUi / 1e6;
      }
      const totalBurn = Number(totalBurnStr) || 0;
      out.burner = {
        enabled: burnUi > 0,
        tokensBurned: burnUi,
        burnEvents: meta.burnEvents || 0,
        burnWeightSharePct: totalBurn > 0 ? (burnUi / totalBurn) * 100 : (meta.burnWeightSharePct || 0)
      };
    }
    if(br != null) out.burnRank = Number(br) + 1;
    if(er != null) out.earnRank = Number(er) + 1;
  }catch(e){ /* ignore */ }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if(!HELIUS_KEY){
    res.status(500).json({ error: 'Server is missing HELIUS_API_KEY. Set it in Vercel env vars.' });
    return;
  }

  const address = req.query.address;
  if (!address) { res.status(400).json({ error: 'Missing wallet address' }); return; }
  if (!SOL_RE.test(address)) { res.status(400).json({ error: 'Invalid Solana wallet address' }); return; }

  try {
    const [balance, dist, burnRanks] = await Promise.all([
      withTimeout(getOnChainBalance(address), 8000).catch(() => null),
      withTimeout(getDistributions(address), 20000).catch(() => null),
      withTimeout(getBurnAndRanks(address), 5000).catch(() => ({ burner: null, burnRank: null, earnRank: null }))
    ]);

    const totalReceivedSol = dist ? dist.totalSol : 0;
    const distributionCount = dist ? dist.count : 0;
    const recent = dist ? dist.recent : [];
    const lastDistribution = (recent && recent.length)
      ? { timestamp: recent[0].timestamp, amountSol: recent[0].amountSol, txSig: recent[0].txSig }
      : null;

    const burner = (burnRanks && burnRanks.burner) || { enabled: false, tokensBurned: 0, burnEvents: 0, burnWeightSharePct: 0 };
    const found = (balance > 0) || (distributionCount > 0) || (burner.burnEvents > 0);

    // Keep the earn leaderboard fresh
    if(totalReceivedSol > 0){
      const earnScore = Math.round(totalReceivedSol * 1e9);
      await redis(['ZADD', LB_EARN_KEY, earnScore, address]);
      const existingMeta = await redis(['GET', META_PREFIX + address]);
      let meta = {};
      if(existingMeta){ try { meta = JSON.parse(existingMeta); } catch(_){} }
      meta.totalReceivedSol = totalReceivedSol;
      meta.distributionCount = distributionCount;
      if(balance != null) meta.currentHoldings = balance; // don't overwrite with 0 on lookup failure
      meta.updatedAt = Date.now();
      await redis(['SET', META_PREFIX + address, JSON.stringify(meta)]);
      const er = await redis(['ZREVRANK', LB_EARN_KEY, address]);
      if(er != null) burnRanks.earnRank = Number(er) + 1;
    }

    res.status(200).json({
      found,
      wallet: address,
      totalReceivedSol,
      distributionCount,
      currentHoldings: { uiAmount: balance }, // null = lookup failed (frontend shows "—"), never fake 0
      lastDistribution,
      recentDistributions: recent,
      syncing: !!(dist && dist.syncing), // older payouts still being counted — UI shows a note
      burner,
      burnRank: burnRanks ? burnRanks.burnRank : null,
      earnRank: burnRanks ? burnRanks.earnRank : null,
      source: 'helius+cache',
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('[wallet] error:', err);
    res.status(500).json({ error: 'Could not load wallet data. Try again in a moment.' });
  }
};
