// /api/wallet.js
// Returns wallet stats for the $DRIPPY token.
//
// Important: Forge's `currentHoldings.uiAmount` is unreliable (returns 2x the
// real balance for wallets that hold AND have burned). We fetch the TRUE
// on-chain balance from Helius RPC and pass it as `currentHoldings` (and
// expose Forge's number separately as `rewardWeight` for transparency).

const TOKEN_MINT = 'EPRZgmvU4aTQ4UaC4bywgNvxJ5YmhuKqM1bx3gw4DRPY';
const HELIUS_KEY = process.env.HELIUS_API_KEY || 'c3f500f3-db28-4d44-994f-0fa0e0ebd510';

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const LB_KEY = 'drippy:burn:leaderboard';
const LB_EARN_KEY = 'drippy:earn:leaderboard';
const META_PREFIX = 'drippy:meta:';

// --- Redis helper -------------------------------------------------------
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

// --- On-chain balance via Helius RPC ------------------------------------
async function getOnChainBalance(owner){
  try{
    const url = 'https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner',
        params: [
          owner,
          { mint: TOKEN_MINT },
          { encoding: 'jsonParsed' }
        ]
      })
    });
    if(!r.ok){
      console.error('[helius] HTTP', r.status);
      return null;
    }
    const j = await r.json();
    const accounts = j?.result?.value || [];
    let total = 0;
    accounts.forEach(acc => {
      const ui = acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
      if(typeof ui === 'number') total += ui;
    });
    return total;
  }catch(e){
    console.error('[helius]', e.message);
    return null;
  }
}

// --- First-acquired timestamp via Helius -------------------------------
// Finds the earliest signature for the wallet's DRPY token account, which
// approximates "first acquired" — fine enough for a "days in the pack"
// counter. Cached in Redis per-wallet (24h) to avoid hammering Helius.
async function getFirstDripDate(owner){
  // Try cache first
  const cacheKey = META_PREFIX + 'firstdrip:' + owner;
  try{
    const cached = await redis(['GET', cacheKey]);
    if(cached){
      const ts = Number(cached);
      if(ts > 0) return ts;
    }
  }catch(_){}

  try{
    // Step 1: find the wallet's DRPY token account address
    const url = 'https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY;
    const accRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenAccountsByOwner',
        params: [owner, { mint: TOKEN_MINT }, { encoding: 'jsonParsed' }]
      })
    });
    if(!accRes.ok) return null;
    const accJ = await accRes.json();
    const tokenAccounts = (accJ?.result?.value || []).map(a => a.pubkey);
    if(!tokenAccounts.length) return null;

    // Step 2: for each token account, find the OLDEST signature
    // We paginate to the end (before = oldest) to get the first ever tx
    let earliest = null;
    for(const acc of tokenAccounts){
      let before = null;
      let oldestForThisAcc = null;
      // Walk back through pages until no more results — capped at 5 pages to
      // protect against runaway wallets
      for(let page = 0; page < 5; page++){
        const params = before ? { before, limit: 1000 } : { limit: 1000 };
        const sigRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'getSignaturesForAddress',
            params: [acc, params]
          })
        });
        if(!sigRes.ok) break;
        const sigJ = await sigRes.json();
        const sigs = sigJ?.result || [];
        if(!sigs.length) break;
        // Sigs come back newest-first; take the last one
        const last = sigs[sigs.length - 1];
        if(last?.blockTime) oldestForThisAcc = last.blockTime;
        // If we got a full page, paginate
        if(sigs.length === 1000){
          before = last.signature;
        } else {
          break; // last page
        }
      }
      if(oldestForThisAcc != null){
        if(earliest == null || oldestForThisAcc < earliest) earliest = oldestForThisAcc;
      }
    }

    if(earliest != null){
      // Cache for 24 hours
      await redis(['SET', cacheKey, String(earliest), 'EX', '86400']);
      return earliest; // unix seconds
    }
    return null;
  }catch(e){
    console.error('[helius-firstdrip]', e.message);
    return null;
  }
}

// --- Main handler -------------------------------------------------------
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const address = (req.query.address || req.query.wallet || '').trim();

  if (!address) { res.status(400).json({ error: 'Missing wallet address' }); return; }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    res.status(400).json({ error: 'Invalid Solana wallet address' });
    return;
  }

  try {
    // Fire Forge, Helius balance, and Helius first-drip in parallel
    const forgeUrl = 'https://forgepad.fun/api/distributions/wallet/' + address + '?contract=' + TOKEN_MINT;
    const [forgeRes, onChainBalance, firstDripTs] = await Promise.all([
      fetch(forgeUrl, { headers: { 'Accept': 'application/json', 'User-Agent': 'DrippyRewards-Site/1.0' } }),
      getOnChainBalance(address),
      getFirstDripDate(address)
    ]);

    // Compute days-holding from first-drip timestamp (if found)
    let daysHolding = null;
    if(firstDripTs && typeof firstDripTs === 'number'){
      const nowSec = Math.floor(Date.now() / 1000);
      daysHolding = Math.max(0, Math.floor((nowSec - firstDripTs) / 86400));
    }

    if (forgeRes.status === 404) {
      res.status(200).json({
        found: false,
        wallet: address,
        currentHoldings: { uiAmount: onChainBalance || 0 },
        daysHolding,
        firstDripTimestamp: firstDripTs,
        message: 'No distributions found for this wallet'
      });
      return;
    }
    if (!forgeRes.ok) { res.status(forgeRes.status).json({ error: 'Forge returned ' + forgeRes.status }); return; }

    const data = await forgeRes.json();
    const lamportsToSol = (n) => Number(n || 0) / 1e9;
    const burner = data.burnerStats || {};

    // Real wallet balance comes from Helius. Forge's number is exposed as
    // "rewardWeight" — what Forge uses to compute reward distribution shares.
    const realHoldings = onChainBalance != null
      ? onChainBalance
      : (data.currentHoldings?.uiAmount || 0);
    const forgeWeightedHoldings = data.currentHoldings?.uiAmount || 0;

    const formatted = {
      found: true,
      wallet: data.wallet || address,
      totalReceivedSol: lamportsToSol(data.totalReceived),
      totalReceivedLamports: data.totalReceived || '0',
      distributionCount: data.distributionCount || 0,
      lastDistribution: data.lastDistribution ? {
        timestamp: data.lastDistribution.timestamp,
        amountSol: lamportsToSol(data.lastDistribution.amount),
        txSig: data.lastDistribution.txSig
      } : null,
      recentDistributions: (data.recentDistributions || []).slice(0, 10).map(d => ({
        timestamp: d.timestamp,
        amountSol: lamportsToSol(d.amount),
        status: d.status,
        txSig: d.txSig
      })),
      // TRUE on-chain balance — what shows in the wallet
      currentHoldings: { uiAmount: realHoldings },
      // Forge's number — the burn-weighted reward share value
      rewardWeight: forgeWeightedHoldings,
      // Days since this wallet first acquired DRPY (may be null if Helius failed)
      daysHolding,
      firstDripTimestamp: firstDripTs,
      burner: {
        enabled: !!burner.burnToEarnEnabled,
        tokensBurned: burner.tokensBurnedUi || 0,
        burnEvents: burner.burnEvents || 0,
        burnWeightSharePct: burner.burnWeightSharePct || 0
      },
      fetchedAt: new Date().toISOString()
    };

    // ---- Leaderboards: record this wallet ----
    let burnRank = null;
    let earnRank = null;

    // Burn leaderboard — only if they've actually burned
    if (formatted.burner.burnEvents > 0 && formatted.burner.tokensBurned > 0) {
      const burnScore = Math.round(formatted.burner.tokensBurned);
      await redis(['ZADD', LB_KEY, burnScore, address]);
      const r = await redis(['ZREVRANK', LB_KEY, address]);
      if (r != null) burnRank = Number(r) + 1;
    }

    // Earn leaderboard — track everyone with any distributions
    if (formatted.totalReceivedSol > 0) {
      // Use lamports for precision (Redis ZADD needs integer-ish score)
      const earnScore = Math.round(Number(formatted.totalReceivedLamports) || 0);
      await redis(['ZADD', LB_EARN_KEY, earnScore, address]);
      const r = await redis(['ZREVRANK', LB_EARN_KEY, address]);
      if (r != null) earnRank = Number(r) + 1;
    }

    // Persist display metadata (used by leaderboard endpoint)
    await redis(['SET', META_PREFIX + address, JSON.stringify({
      burnEvents: formatted.burner.burnEvents,
      burnWeightSharePct: formatted.burner.burnWeightSharePct,
      tokensBurned: formatted.burner.tokensBurned,
      totalReceivedSol: formatted.totalReceivedSol,
      currentHoldings: realHoldings,
      distributionCount: formatted.distributionCount,
      updatedAt: Date.now()
    })]);

    formatted.leaderboardRank = burnRank;     // backwards-compat alias
    formatted.burnRank = burnRank;
    formatted.earnRank = earnRank;

    res.status(200).json(formatted);
  } catch (err) {
    console.error('[wallet proxy] error:', err);
    res.status(500).json({ error: err.message || 'Unknown error' });
  }
};
