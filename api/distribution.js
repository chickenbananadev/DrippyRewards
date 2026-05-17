// /api/distribution.js
// Vercel Serverless Function — proxies Forge's token-distribution endpoint
// so the browser can fetch it without CORS issues.
//
// Hits: https://forgepad.fun/api/token-distribution/<MINT>
// Caches for 30 seconds so we don't hammer Forge or hit rate limits.

const TOKEN_MINT = 'EPRZgmvU4aTQ4UaC4bywgNvxJ5YmhuKqM1bx3gw4DRPY';
const FORGE_URL = `https://forgepad.fun/api/token-distribution/${TOKEN_MINT}`;

export default async function handler(req, res) {
  // CORS headers — allow your own site (and dev tools) to consume this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
 
  try {
    const r = await fetch(FORGE_URL, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'DrippyRewards-Site/1.0'
      },
      // Server-side fetch — no CORS limits
    });

    if (!r.ok) {
      return res.status(r.status).json({
        error: `Forge returned ${r.status}`,
        forgeUrl: FORGE_URL
      });
    }

    const data = await r.json();

    // Pre-format the data for easy consumption by the front-end
    const lamportsToSol = (n) => Number(n || 0) / 1e9;
    const rawTokensToM = (raw) => {
      // Drippy uses 6 decimals (verified from Solscan)
      const tokens = Number(raw || 0) / 1e6;
      if (tokens >= 1e6) return (tokens / 1e6).toFixed(2) + 'M';
      if (tokens >= 1e3) return (tokens / 1e3).toFixed(2) + 'K';
      return tokens.toFixed(0);
    };

    const formatted = {
      // Distribution data
      lastDistributionAt: data.lastDistributionAt || null,
      lastAmountSol: lamportsToSol(data.lastRunAmountDistributed),
      lastAmountLamports: data.lastRunAmountDistributed || '0',
      totalDistributedSol: lamportsToSol(data.totalDividendsDistributed),
      totalDistributedLamports: data.totalDividendsDistributed || '0',
      successfulDistributions: data.successfulDistributions || 0,
      lastRunRecipients: data.lastRunSuccessfulRecipients || 0,
      lastRunAttempted: data.lastRunAttemptedRecipients || 0,
      lastRunSkipped: data.lastRunSkippedRecipients || 0,
      lastRunFailed: data.lastRunFailedRecipients || 0,
      lastRunStatus: data.lastRunStatus || null,
      distributionInterval: data.distributionInterval || 30,

      // Burn data
      burnToEarnEnabled: !!data.burnToEarnEnabled,
      burnEvents: data.burnToEarnBurnEvents || 0,
      tokensBurnedRaw: data.burnToEarnTokensBurned || '0',
      tokensBurnedFormatted: rawTokensToM(data.burnToEarnTokensBurned),
      totalSupplyBurnedPct: data.burnToEarnTotalSupplyBurnedPct || 0,

      // Token info
      rewardsDistributorAddress: data.rewardsDistributorAddress || null,
      launchTimestamp: data.launchTimestamp || null,
      status: data.status || 'unknown',
      quoteMint: data.quoteMint || 'SOL',
      typeOfLaunch: data.typeOfLaunch || null,

      // Meta
      fetchedAt: new Date().toISOString()
    };

    return res.status(200).json(formatted);
  } catch (err) {
    console.error('[distribution proxy] error:', err);
    return res.status(500).json({
      error: err.message || 'Unknown error',
      fetchedAt: new Date().toISOString()
    });
  }
}
