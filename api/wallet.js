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
// v3: the scan now ALSO detects burns (DRIPPY transfers to the burn address)
// in the same transaction history, healing wallets whose burns the Helius
// webhook missed. The bump forces one rescan of v2 wallets so burns inside
// the already-scanned range get picked up.
const EARN_CACHE_V = 3;
const SIG_PAGE_LIMIT = 1000;   // getSignaturesForAddress max per page
const SIG_MAX_PAGES = 10;      // up to 10,000 sigs ≈ 6+ months at 48 drips/day.
                               // Must exhaust the wallet's backlog: if the
                               // window truncates, everything between the
                               // cursor and the window bottom would be skipped
                               // forever once the cursor advances into it.
const FALLBACK_BATCH = 50;       // per-tx fallback: txs fetched per parallel batch
const FALLBACK_TX_MAX = 800;     // hard cap per check (~17 days of drips per check)
const FALLBACK_TIME_MS = 12000;  // time budget per check — fits the 20s handler
                                 // timeout with sig paging + burn writes to spare

// Record scan-detected burns through the SAME idempotent path the Helius
// webhook uses (permanent per-signature SET NX guard) — so a burn the webhook
// already recorded is never double counted, and one it missed heals the
// wallet meta, the burn leaderboard AND the global totals.
async function recordScannedBurns(owner, burns){
  let recorded = 0;
  for(const b of burns){
    const guard = await redis(['SET', 'drippy:burnsig:' + b.sig + ':' + owner, '1', 'NX']);
    if(guard !== 'OK') continue; // already recorded by webhook/backfill, or redis unavailable
    await redis(['ZINCRBY', LB_BURN_KEY, String(b.amount), owner]);
    await redis(['INCRBYFLOAT', TOTAL_BURN_KEY, String(b.amount)]);
    await redis(['INCR', 'drippy:burn:events']);
    let meta = {};
    const existing = await redis(['GET', META_PREFIX + owner]);
    if(existing){ try{ meta = JSON.parse(existing); }catch(_){} }
    meta.tokensBurned = (Number(meta.tokensBurned) || 0) + b.amount;
    meta.burnEvents = (Number(meta.burnEvents) || 0) + 1;
    meta.lastBurnAt = b.ts || Date.now();
    meta.updatedAt = Date.now();
    await redis(['SET', META_PREFIX + owner, JSON.stringify(meta)]);
    recorded++;
  }
  return recorded;
}

// UI-amount delta of the DRIPPY mint for `who` across a jsonParsed transaction.
function drippyDelta(txMeta, who){
  const sum = (arr) => (arr || [])
    .filter(b => b && b.mint === TOKEN_MINT && b.owner === who)
    .reduce((s, b) => s + ((b.uiTokenAmount && b.uiTokenAmount.uiAmount) || 0), 0);
  return sum(txMeta.postTokenBalances) - sum(txMeta.preTokenBalances);
}

// While a wallet's history is still catching up, the live head probe
// (state.recentLive) knows the true newest payouts; the catch-up list
// (state.recent) lags behind. Serve whichever is fresher.
function pickRecent(state){
  if(state.syncing && Array.isArray(state.recentLive) && state.recentLive.length) return state.recentLive;
  return state.recent || [];
}

async function getDistributions(owner){
  let cache = null;
  const cachedStr = await redis(['GET', EARN_CACHE_PREFIX + owner]);
  if(cachedStr){ try{ cache = JSON.parse(cachedStr); }catch(_){} }
  if(cache && cache.v !== EARN_CACHE_V) cache = null; // discard poisoned v1 state

  // Within 60 seconds of the last scan just serve the cache untouched.
  if(cache && cache.updatedAt && (Date.now() - cache.updatedAt) < 60_000){
    return { totalSol: cache.totalLamports / 1e9, count: cache.count, recent: pickRecent(cache), cached: true, syncing: !!cache.syncing };
  }

  const state = cache || { v: EARN_CACHE_V, totalLamports: 0, count: 0, newestSig: null, recent: [] };
  state.v = EARN_CACHE_V;

  try{
    // Collect signatures newer than the last processed one (newest-first).
    let newSigs = [];
    let before = null;
    let windowTruncated = true; // true until a short page proves we reached the cursor/genesis
    for(let page = 0; page < SIG_MAX_PAGES; page++){
      const opts = { limit: SIG_PAGE_LIMIT };
      if(before) opts.before = before;
      if(state.newestSig) opts.until = state.newestSig; // every page, not just the first
      const sigs = await rpc('getSignaturesForAddress', [owner, opts]);
      if(!sigs || !sigs.length){ windowTruncated = false; break; }
      newSigs = newSigs.concat(sigs.filter(s => !s.err).map(s => s.signature));
      if(sigs.length < SIG_PAGE_LIMIT){ windowTruncated = false; break; }
      before = sigs[sigs.length - 1].signature;
    }
    if(windowTruncated){
      // >10,000 sigs above the cursor. Advancing the cursor into this window
      // would permanently skip the gap below it, so log loudly and don't
      // count this pass — extremely unlikely for a real holder wallet.
      console.error('[distributions] signature window truncated for', owner, '- backlog exceeds', SIG_MAX_PAGES * SIG_PAGE_LIMIT);
      if(state.newestSig) newSigs = [];
    }

    let burnsRecorded = 0;
    if(newSigs.length){
      const oldestFirst = newSigs.slice().reverse();
      const parsedDrips = [];       // oldest-first while collecting
      const foundBurns = [];        // DRIPPY transfers owner -> burn address seen in the scan
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
          // Burn detection (mirrors burn-webhook's extractBurns, scoped to owner)
          for(const t of (tx.tokenTransfers || [])){
            if(t.mint !== TOKEN_MINT) continue;
            const amount = Number(t.tokenAmount) || 0;
            if(amount <= 0 || t.fromUserAccount !== owner) continue;
            if(t.toUserAccount === DISTRIBUTOR || tx.type === 'BURN'){
              foundBurns.push({ sig: tx.signature, amount, ts: tx.timestamp ? tx.timestamp * 1000 : Date.now() });
            }
          }
        }
        parsedThrough = Math.min(i + 100, oldestFirst.length) - 1;
      }

      // --- Fallback: Helius parse unavailable → standard getTransaction on
      // the RPC chain (public endpoints). Time-budgeted batches so catch-up
      // moves at a few hundred transactions per check instead of 40.
      if(parsedThrough < 0){
        const t0 = Date.now();
        let idx = 0;
        outer: while(idx < oldestFirst.length && idx < FALLBACK_TX_MAX && (Date.now() - t0) < FALLBACK_TIME_MS){
          const slice = oldestFirst.slice(idx, idx + FALLBACK_BATCH);
          const settled = await Promise.allSettled(slice.map(sig =>
            rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]).then(tx => ({ sig, tx }))
          ));
          for(let i = 0; i < settled.length; i++){
            const s = settled[i];
            if(s.status !== 'fulfilled'){ break outer; } // keep the resume point contiguous
            const { sig, tx } = s.value;
            parsedThrough = idx + i;
            if(!tx || !tx.meta || !tx.transaction) continue;
            // Burn detection via token balances: owner's DRIPPY down AND the
            // burn address's DRIPPY up in the same tx. Needs only tokenBalances
            // (the burn address's MAIN account is often absent from accountKeys
            // — only its token account is touched). A DEX sell also drops the
            // owner's balance, but the counterparty is a pool — requiring the
            // burn address to gain keeps this exact.
            const burnGain = drippyDelta(tx.meta, DISTRIBUTOR);
            const ownerLoss = -drippyDelta(tx.meta, owner);
            if(burnGain > 0 && ownerLoss > 0){
              foundBurns.push({ sig, amount: Math.min(burnGain, ownerLoss), ts: tx.blockTime ? tx.blockTime * 1000 : Date.now() });
            }
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
          idx += slice.length;
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
        if(foundBurns.length) burnsRecorded = await recordScannedBurns(owner, foundBurns);
      }
      state.syncing = parsedThrough < (oldestFirst.length - 1); // backlog remains
    } else {
      // No new work this pass. Still syncing only in the (rare) truncated-
      // window case above, where a backlog exists but wasn't safe to count.
      state.syncing = !!(windowTruncated && state.newestSig);
    }

    // --- Live head probe: while the historical catch-up runs, state.recent
    // fills oldest→newest and can lag DAYS behind the chain, which made the
    // "Last payout" card show stale times on actively-dripping wallets.
    // Parse just the newest few signatures directly so the card always shows
    // the wallet's true latest payout. Display-only: these are never added
    // to the totals, and the real scan replaces them once it catches up.
    if(state.syncing && newSigs.length){
      try{
        const head = newSigs.slice(0, 10); // newSigs is newest-first
        const settled = await Promise.allSettled(head.map(sig =>
          rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]).then(tx => ({ sig, tx }))
        ));
        const live = [];
        for(const s of settled){
          if(s.status !== 'fulfilled') continue;
          const { sig, tx } = s.value;
          if(!tx || !tx.meta || !tx.transaction) continue;
          const keys = (tx.transaction.message.accountKeys || []).map(k => (typeof k === 'string') ? k : (k && k.pubkey));
          const oi = keys.indexOf(owner);
          const di = keys.indexOf(DISTRIBUTOR);
          if(oi < 0 || di < 0) continue;
          const pre = tx.meta.preBalances || [];
          const post = tx.meta.postBalances || [];
          const gained = (post[oi] || 0) - (pre[oi] || 0);
          if(gained > 0 && (pre[di] || 0) > (post[di] || 0)){
            live.push({
              timestamp: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
              amountSol: gained / 1e9,
              status: 'succeeded',
              txSig: sig
            });
          }
        }
        if(live.length) state.recentLive = live; // newest-first, like head
      }catch(_){ /* display-only — never fail the scan over it */ }
    }
    if(!state.syncing) delete state.recentLive;

    state.updatedAt = Date.now();
    await redis(['SET', EARN_CACHE_PREFIX + owner, JSON.stringify(state)]);
    return { totalSol: state.totalLamports / 1e9, count: state.count, recent: pickRecent(state), syncing: !!state.syncing, burnsRecorded };
  }catch(e){
    console.error('[distributions]', e.message);
    // If the scan fails but we have a cache, serve the cache.
    if(cache) return { totalSol: cache.totalLamports / 1e9, count: cache.count, recent: pickRecent(cache), stale: true, syncing: !!cache.syncing };
    return null;
  }
}

async function getBurnAndRanks(owner){
  const out = { burner: null, burnRank: null, earnRank: null };
  try{
    const [metaStr, totalBurnStr, forgeStr, br, er] = await Promise.all([
      redis(['GET', META_PREFIX + owner]),
      redis(['GET', TOTAL_BURN_KEY]),
      redis(['GET', 'drippy:stats:forge']), // stats.js's cached Forge snapshot
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
      // Burn-weight denominator: prefer Forge's authoritative total (the
      // internal webhook total is known-inflated, which understated shares).
      let forgeTotal = 0;
      if(forgeStr){ try{ forgeTotal = Number(JSON.parse(forgeStr).v.forgeTokensBurned) || 0; }catch(_){} }
      const denom = forgeTotal > 0 ? forgeTotal : (Number(totalBurnStr) || 0);
      out.burner = {
        enabled: burnUi > 0,
        tokensBurned: burnUi,
        burnEvents: meta.burnEvents || 0,
        burnWeightSharePct: denom > 0 ? (burnUi / denom) * 100 : (meta.burnWeightSharePct || 0)
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
    const [balance, dist] = await Promise.all([
      withTimeout(getOnChainBalance(address), 8000).catch(() => null),
      withTimeout(getDistributions(address), 20000).catch(() => null)
    ]);
    // Read burn data AFTER the scan: if the scan just healed missed burns,
    // this very response already shows them.
    const burnRanks = await withTimeout(getBurnAndRanks(address), 5000)
      .catch(() => ({ burner: null, burnRank: null, earnRank: null }));

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
