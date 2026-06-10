// /api/distribution.js
// Vercel Serverless Function — proxies Forge's token-distribution endpoint
// so the browser can fetch it without CORS issues.

const TOKEN_MINT = 'EPRZgmvU4aTQ4UaC4bywgNvxJ5YmhuKqM1bx3gw4DRPY';
const FORGE_URL = `https://forgepad.fun/api/token-distribution/${TOKEN_MINT}`;

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    const r = await fetch(FORGE_URL, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'DrippyRewards-Site/1.0'
      }
    });

    if (!r.ok) {
      res.status(r.status).json({
        error: `Forge returned ${r.status}`,
        forgeUrl: FORGE_URL
      });
      return;
    }

    const data = await r.json();

    const lamportsToSol = (n) => Number(n || 0) / 1e9;

    // Forge returns burnToEarnTokensBurned as a string in token base units (×10^decimals).
    // Drippy uses 9 decimals (verified: 22377461337875081 raw = 22,377,461.337875 tokens).
    const DECIMALS = 9;
    const rawToTokens = (raw) => {
      if (!raw) return 0;
      return Number(raw) / Math.pow(10, DECIMALS);
    };
    const formatTokensFull = (raw) => {
      const n = rawToTokens(raw);
      return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    };
    const formatTokensCompact = (raw) => {
      const n = rawToTokens(raw);
      if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
      return n.toFixed(0);
    };

    const formatted = {
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

      burnToEarnEnabled: !!data.burnToEarnEnabled,
      burnEvents: data.burnToEarnBurnEvents || 0,
      tokensBurnedRaw: data.burnToEarnTokensBurned || '0',
      tokensBurnedExact: rawToTokens(data.burnToEarnTokensBurned),
      tokensBurnedFull: formatTokensFull(data.burnToEarnTokensBurned),
      tokensBurnedCompact: formatTokensCompact(data.burnToEarnTokensBurned),
      tokensBurnedFormatted: formatTokensCompact(data.burnToEarnTokensBurned),
      totalSupplyBurnedPct: data.burnToEarnTotalSupplyBurnedPct || 0,

      rewardsDistributorAddress: data.rewardsDistributorAddress || null,
      launchTimestamp: data.launchTimestamp || null,
      status: data.status || 'unknown',
      quoteMint: data.quoteMint || 'SOL',
      typeOfLaunch: data.typeOfLaunch || null,

      fetchedAt: new Date().toISOString()
    };

    res.status(200).json(formatted);
  } catch (err) {
    console.error('[distribution proxy] error:', err);
    res.status(500).json({
      error: err.message || 'Unknown error',
      fetchedAt: new Date().toISOString()
    });
  }
};
