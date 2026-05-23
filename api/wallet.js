// /api/wallet.js
// Proxies Forge's per-wallet distribution endpoint, AND records the wallet's
// burn stats into an Upstash Redis sorted set so we can build a leaderboard.
//
// Usage: /api/wallet?address=<SOLANA_WALLET_ADDRESS>

const TOKEN_MINT = 'EPRZgmvU4aTQ4UaC4bywgNvxJ5YmhuKqM1bx3gw4DRPY';

// Upstash Redis REST API — credentials injected by the Vercel integration.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const LB_KEY = 'drippy:burn:leaderboard';   // sorted set: member=wallet, score=tokensBurned
const META_PREFIX = 'drippy:burn:meta:';    // per-wallet detail (JSON string)

// Minimal Redis REST helper. Upstash expects every element of the command
// array to be a STRING — numbers must be stringified or the command misbehaves.
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
    const forgeUrl = 'https://forgepad.fun/api/distributions/wallet/' + address + '?contract=' + TOKEN_MINT;
    const r = await fetch(forgeUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'DrippyRewards-Site/1.0' }
    });

    if (r.status === 404) {
      res.status(200).json({ found: false, wallet: address, message: 'No distributions found for this wallet' });
      return;
    }
    if (!r.ok) { res.status(r.status).json({ error: 'Forge returned ' + r.status }); return; }

    const data = await r.json();
    const lamportsToSol = (n) => Number(n || 0) / 1e9;
    const burner = data.burnerStats || {};

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
      currentHoldings: data.currentHoldings ? { uiAmount: data.currentHoldings.uiAmount || 0 } : { uiAmount: 0 },
      burner: {
        enabled: !!burner.burnToEarnEnabled,
        tokensBurned: burner.tokensBurnedUi || 0,
        burnEvents: burner.burnEvents || 0,
        burnWeightSharePct: burner.burnWeightSharePct || 0
      },
      fetchedAt: new Date().toISOString()
    };

    // ---- Leaderboard: record this wallet if it has burned ----
    let rank = null;
    if (formatted.burner.burnEvents > 0 && formatted.burner.tokensBurned > 0) {
      // Score must be an integer-ish string for ZADD. Round to whole tokens.
      const score = Math.round(formatted.burner.tokensBurned);

      // ZADD key score member  — adds or updates this wallet in the sorted set.
      // GT flag is NOT used so a re-check always refreshes the score.
      await redis(['ZADD', LB_KEY, score, address]);

      // Store display metadata for this wallet
      await redis(['SET', META_PREFIX + address, JSON.stringify({
        burnEvents: formatted.burner.burnEvents,
        burnWeightSharePct: formatted.burner.burnWeightSharePct,
        tokensBurned: formatted.burner.tokensBurned,
        totalReceivedSol: formatted.totalReceivedSol,
        updatedAt: Date.now()
      })]);

      // ZREVRANK key member — 0-based rank, highest score first
      const rankResult = await redis(['ZREVRANK', LB_KEY, address]);
      if (rankResult != null) rank = Number(rankResult) + 1;
    }

    formatted.leaderboardRank = rank;

    res.status(200).json(formatted);
  } catch (err) {
    console.error('[wallet proxy] error:', err);
    res.status(500).json({ error: err.message || 'Unknown error' });
  }
};
