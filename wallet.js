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

async function getOnChainBalance(owner){
  try{
    const result = await rpc('getTokenAccountsByOwner', [owner, { mint: TOKEN_MINT }, { encoding: 'jsonParsed' }]);
    const accounts = result?.value || [];
    let total = 0;
    accounts.forEach(acc => {
      const ui = acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
      if(typeof ui === 'number') total += ui;
    });
    return total;
  }catch(e){ return null; }
}

// Incremental distribution scan.
// Cache shape: { totalLamports, count, newestSig, recent: [...], updatedAt }
// Each check only parses transactions newer than newestSig, then accumulates.
async function getDistributions(owner){
  let cache = null;
  const cachedStr = await redis(['GET', EARN_CACHE_PREFIX + owner]);
  if(cachedStr){ try{ cache = JSON.parse(cachedStr); }catch(_){} }

  // Within 60 seconds of the last scan just serve the cache untouched.
  if(cache && cache.updatedAt && (Date.now() - cache.updatedAt) < 60_000){
    return { totalSol: cache.totalLamports / 1e9, count: cache.count, recent: cache.recent || [], cached: true };
  }

  const state = cache || { totalLamports: 0, count: 0, newestSig: null, recent: [] };

  try{
    // Collect signatures newer than the last processed one, up to 3 pages.
    let newSigs = [];
    let before = null;
    for(let page = 0; page < 3; page++){
      const params = [owner, { limit: 100 }];
      if(before) params[1].before = before;
      if(state.newestSig && !before) params[1].until = state.newestSig;
      const sigs = await rpc('getSignaturesForAddress', params);
      if(!sigs || !sigs.length) break;
      newSigs = newSigs.concat(sigs.map(s => s.signature));
      if(sigs.length < 100) break;
      before = sigs[sigs.length - 1].signature;
    }

    if(newSigs.length){
      const newest = newSigs[0];
      const newRecent = [];
      // Parse in batches of 100 with the enhanced API
      for(let i = 0; i < newSigs.length; i += 100){
        const batch = newSigs.slice(i, i + 100);
        const parseRes = await fetch(PARSE_URL(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transactions: batch })
        });
        if(!parseRes.ok) break;
        const txs = await parseRes.json();
        for(const tx of (txs || [])){
          for(const t of (tx.nativeTransfers || [])){
            if(t.fromUserAccount === DISTRIBUTOR && t.toUserAccount === owner){
              const lamports = Number(t.amount) || 0;
              if(lamports > 0){
                state.totalLamports += lamports;
                state.count++;
                newRecent.push({
                  timestamp: tx.timestamp ? new Date(tx.timestamp * 1000).toISOString() : null,
                  amountSol: lamports / 1e9,
                  status: 'succeeded',
                  txSig: tx.signature
                });
              }
            }
          }
        }
      }
      // Newest first: fresh payouts go in front of cached ones
      state.recent = newRecent.concat(state.recent || []).slice(0, 10);
      state.newestSig = newest;
    }

    state.updatedAt = Date.now();
    await redis(['SET', EARN_CACHE_PREFIX + owner, JSON.stringify(state)]);
    return { totalSol: state.totalLamports / 1e9, count: state.count, recent: state.recent };
  }catch(e){
    console.error('[distributions]', e.message);
    // If the scan fails but we have a cache, serve the cache.
    if(cache) return { totalSol: cache.totalLamports / 1e9, count: cache.count, recent: cache.recent || [], stale: true };
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
      meta.currentHoldings = balance || 0;
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
      currentHoldings: { uiAmount: balance || 0 },
      lastDistribution,
      recentDistributions: recent,
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
