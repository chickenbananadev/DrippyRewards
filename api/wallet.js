// /api/wallet.js
// Returns wallet stats for $DRIPPY — WITHOUT depending on Forge's per-wallet
// endpoint (which black-holes server requests). Everything is sourced from:
//   - Helius RPC (on-chain): holdings + SOL distributions received
//   - Our own Redis: burn stats + leaderboard ranks (populated as wallets
//     are checked, seeded from the leaderboard)
//
// SOL earnings are computed by scanning the wallet's transaction history for
// incoming SOL from the rewards distributor address.

const TOKEN_MINT = 'EPRZgmvU4aTQ4UaC4bywgNvxJ5YmhuKqM1bx3gw4DRPY';
const HELIUS_KEY = process.env.HELIUS_API_KEY || 'c3f500f3-db28-4d44-994f-0fa0e0ebd510';
const DISTRIBUTOR = 'N1LCBQJnjLP3ppv7npzL5Btzf5Yp3hBMr6s8GmVfEyV';

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const LB_KEY = 'drippy:burn:leaderboard';
const LB_EARN_KEY = 'drippy:earn:leaderboard';
const META_PREFIX = 'drippy:meta:';
const EARN_CACHE_PREFIX = 'drippy:earn:cache:'; // per-wallet computed earnings cache

const HELIUS_RPC = 'https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// --- Redis helper -------------------------------------------------------
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

// --- On-chain token balance via Helius ----------------------------------
async function getOnChainBalance(owner){
  try{
    const r = await fetch(HELIUS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenAccountsByOwner',
        params: [owner, { mint: TOKEN_MINT }, { encoding: 'jsonParsed' }]
      })
    });
    if(!r.ok) return null;
    const j = await r.json();
    const accounts = j?.result?.value || [];
    let total = 0;
    accounts.forEach(acc => {
      const ui = acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
      if(typeof ui === 'number') total += ui;
    });
    return total;
  }catch(e){ return null; }
}

// --- SOL distributions received from the distributor --------------------
// Uses Helius enhanced transactions API to find SOL transfers from the
// rewards distributor to this wallet. Returns { totalSol, count, recent[] }.
async function getDistributions(owner){
  try{
    // Get recent signatures for the wallet (most recent first), capped to
    // stay within function time limits.
    const sigRes = await fetch(HELIUS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getSignaturesForAddress',
        params: [owner, { limit: 100 }]
      })
    });
    if(!sigRes.ok) return null;
    const sigJ = await sigRes.json();
    const sigs = (sigJ?.result || []).map(s => s.signature);
    if(!sigs.length) return { totalSol: 0, count: 0, recent: [] };

    // Use Helius enhanced transactions API to parse them (batch of up to 100)
    const parseRes = await fetch('https://api.helius.xyz/v0/transactions?api-key=' + HELIUS_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: sigs.slice(0, 100) })
    });
    if(!parseRes.ok) return null;
    const txs = await parseRes.json();

    let totalLamports = 0;
    let count = 0;
    const recent = [];
    for(const tx of (txs || [])){
      // Look for native SOL transfers from the distributor to this wallet
      const transfers = tx.nativeTransfers || [];
      for(const t of transfers){
        if(t.fromUserAccount === DISTRIBUTOR && t.toUserAccount === owner){
          const lamports = Number(t.amount) || 0;
          if(lamports > 0){
            totalLamports += lamports;
            count++;
            if(recent.length < 10){
              recent.push({
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
    return { totalSol: totalLamports / 1e9, count, recent };
  }catch(e){
    console.error('[distributions]', e.message);
    return null;
  }
}

// --- Burn stats + ranks from Redis --------------------------------------
async function getBurnAndRanks(owner){
  const out = { burner: null, burnRank: null, earnRank: null };
  try{
    const metaStr = await redis(['GET', META_PREFIX + owner]);
    if(metaStr){
      const meta = JSON.parse(metaStr);
      let burnUi = Number(meta.tokensBurned) || 0;
      if(burnUi > 1_000_000_000){
        if(burnUi / 1e9 <= 1_000_000_000) burnUi = burnUi / 1e9;
        else if(burnUi / 1e6 <= 1_000_000_000) burnUi = burnUi / 1e6;
      }
      out.burner = {
        enabled: burnUi > 0,
        tokensBurned: burnUi,
        burnEvents: meta.burnEvents || 0,
        burnWeightSharePct: meta.burnWeightSharePct || 0
      };
    }
    const br = await redis(['ZREVRANK', LB_KEY, owner]);
    if(br != null) out.burnRank = Number(br) + 1;
    const er = await redis(['ZREVRANK', LB_EARN_KEY, owner]);
    if(er != null) out.earnRank = Number(er) + 1;
  }catch(e){ /* ignore */ }
  return out;
}

// --- Main handler -------------------------------------------------------
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const address = req.query.address;
  if (!address) { res.status(400).json({ error: 'Missing wallet address' }); return; }
  if (!SOL_RE.test(address)) { res.status(400).json({ error: 'Invalid Solana wallet address' }); return; }

  try {
    // Run all data sources in parallel with timeouts
    const [balance, dist, burnRanks] = await Promise.all([
      withTimeout(getOnChainBalance(address), 8000).catch(() => null),
      withTimeout(getDistributions(address), 9000).catch(() => null),
      withTimeout(getBurnAndRanks(address), 5000).catch(() => ({ burner: null, burnRank: null, earnRank: null }))
    ]);

    const totalReceivedSol = dist ? dist.totalSol : 0;
    const distributionCount = dist ? dist.count : 0;
    const recent = dist ? dist.recent : [];
    const lastDistribution = (recent && recent.length)
      ? { timestamp: recent[0].timestamp, amountSol: recent[0].amountSol, txSig: recent[0].txSig }
      : null;

    const burner = (burnRanks && burnRanks.burner) || { enabled: false, tokensBurned: 0, burnEvents: 0, burnWeightSharePct: 0 };

    // Compute days holding from first distribution timestamp (oldest in recent
    // is a rough proxy; if no distributions, leave null)
    let daysHolding = null;
    if(recent && recent.length){
      const oldest = recent[recent.length - 1].timestamp;
      if(oldest){
        const days = Math.floor((Date.now() - new Date(oldest).getTime()) / 86400000);
        daysHolding = Math.max(0, days);
      }
    }

    // A wallet is "found" if it has any holdings, distributions, or burns
    const found = (balance > 0) || (distributionCount > 0) || (burner.burnEvents > 0);

    // Record/update this wallet in the earn leaderboard if it earned anything
    if(totalReceivedSol > 0){
      const earnScore = Math.round(totalReceivedSol * 1e9); // lamports
      await redis(['ZADD', LB_EARN_KEY, earnScore, address]);
      // refresh meta with computed earnings
      const existingMeta = await redis(['GET', META_PREFIX + address]);
      let meta = {};
      if(existingMeta){ try { meta = JSON.parse(existingMeta); } catch(_){} }
      meta.totalReceivedSol = totalReceivedSol;
      meta.distributionCount = distributionCount;
      meta.currentHoldings = balance || 0;
      meta.updatedAt = Date.now();
      await redis(['SET', META_PREFIX + address, JSON.stringify(meta)]);
      // refresh earn rank after recording
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
      daysHolding,
      burner,
      burnRank: burnRanks ? burnRanks.burnRank : null,
      earnRank: burnRanks ? burnRanks.earnRank : null,
      source: 'helius',
      fetchedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('[wallet] error:', err);
    res.status(500).json({ error: 'Could not load wallet data. Try again in a moment.' });
  }
};
