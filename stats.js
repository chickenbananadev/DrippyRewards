// /api/stats.js
// One consolidated, Redis-cached stats endpoint. The page makes a single call
// here instead of hitting DexScreener, RPCs, Forge, and a probe wallet from
// every visitor's browser.
//
// Returns: { market, supply, distribution, burns, holders, recentDrips }
//
// Required env vars: HELIUS_API_KEY, KV_REST_API_URL, KV_REST_API_TOKEN

const TOKEN_MINT = 'EPRZgmvU4aTQ4UaC4bywgNvxJ5YmhuKqM1bx3gw4DRPY';
const PAIR_ADDRESS = '3ohceht4kcjkysrtn4mysd2zwgkwz1cinualvtcchqmz';
const DISTRIBUTOR = 'N1LCBQJnjLP3ppv7npzL5Btzf5Yp3hBMr6s8GmVfEyV';
const HELIUS_KEY = process.env.HELIUS_API_KEY;

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const HELIUS_RPC = () => 'https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY;
const PARSE_URL = () => 'https://api.helius.xyz/v0/transactions?api-key=' + HELIUS_KEY;
const FORGE_URL = 'https://forgepad.fun/api/token-distribution/' + TOKEN_MINT;

const TOTAL_BURN_KEY = 'drippy:burn:total';
const TOTAL_BURN_EVENTS_KEY = 'drippy:burn:events';

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

// Cache helper: returns cached value if younger than ttlMs, otherwise calls
// refresh(), stores, and returns fresh. Falls back to stale cache on failure.
async function cached(key, ttlMs, refresh){
  const raw = await redis(['GET', key]);
  let entry = null;
  if(raw){ try{ entry = JSON.parse(raw); }catch(_){} }
  if(entry && (Date.now() - entry.t) < ttlMs) return entry.v;
  try{
    const fresh = await refresh();
    if(fresh != null){
      await redis(['SET', key, JSON.stringify({ t: Date.now(), v: fresh })]);
      return fresh;
    }
  }catch(e){ console.error('[stats]', key, e.message); }
  return entry ? entry.v : null; // stale beats nothing
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

// --- Market data from DexScreener (30s cache) ----------------------------
function fetchMarket(){
  return cached('drippy:stats:market', 30_000, async () => {
    const r = await fetch('https://api.dexscreener.com/latest/dex/pairs/solana/' + PAIR_ADDRESS);
    if(!r.ok) throw new Error('dexscreener ' + r.status);
    const j = await r.json();
    const pair = j?.pairs?.[0] || j?.pair;
    if(!pair) return null;
    return {
      priceUsd: Number(pair.priceUsd) || null,
      change24h: pair.priceChange?.h24 ?? null,
      volume24h: pair.volume?.h24 ?? null,
      liquidityUsd: pair.liquidity?.usd ?? null
    };
  });
}

// --- On-chain supply (5 min cache) ----------------------------------------
function fetchSupply(){
  return cached('drippy:stats:supply', 300_000, async () => {
    const res = await rpc('getTokenSupply', [TOKEN_MINT]);
    const amt = Number(res?.value?.uiAmount);
    return isFinite(amt) ? { circulating: amt } : null;
  });
}

// --- Forge distribution data (60s cache) -----------------------------------
function fetchDistribution(){
  return cached('drippy:stats:forge', 60_000, async () => {
    const r = await fetch(FORGE_URL, { headers: { 'Accept': 'application/json', 'User-Agent': 'DrippyRewards-Site/2.0' } });
    if(!r.ok) throw new Error('forge ' + r.status);
    const d = await r.json();
    const lamportsToSol = (n) => Number(n || 0) / 1e9;
    return {
      lastDistributionAt: d.lastDistributionAt || null,
      lastAmountSol: lamportsToSol(d.lastRunAmountDistributed),
      totalDistributedSol: lamportsToSol(d.totalDividendsDistributed),
      successfulDistributions: d.successfulDistributions || 0,
      lastRunRecipients: d.lastRunSuccessfulRecipients || 0,
      distributionInterval: d.distributionInterval || 30,
      status: d.status || 'unknown',
      forgeBurnEvents: d.burnToEarnBurnEvents || 0,
      forgeTokensBurned: d.burnToEarnTokensBurned ? Number(d.burnToEarnTokensBurned) / 1e9 : 0,
      forgeSupplyBurnedPct: d.burnToEarnTotalSupplyBurnedPct || 0
    };
  });
}

// --- Holder count via Helius DAS getTokenAccounts (10 min cache) ----------
function fetchHolders(){
  return cached('drippy:stats:holders', 600_000, async () => {
    const owners = new Set();
    let cursor = null;
    for(let page = 0; page < 10; page++){ // up to 10k accounts
      const body = { jsonrpc: '2.0', id: 1, method: 'getTokenAccounts', params: { mint: TOKEN_MINT, limit: 1000 } };
      if(cursor) body.params.cursor = cursor;
      const r = await fetch(HELIUS_RPC(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if(!r.ok) throw new Error('getTokenAccounts ' + r.status);
      const j = await r.json();
      const accounts = j?.result?.token_accounts || [];
      accounts.forEach(a => { if(Number(a.amount) > 0 && a.owner) owners.add(a.owner); });
      cursor = j?.result?.cursor;
      if(!cursor || accounts.length < 1000) break;
    }
    return { count: owners.size };
  });
}

// --- Global recent distributions: distributor outgoing SOL (60s cache) ----
function fetchRecentDrips(){
  return cached('drippy:stats:recentdrips', 60_000, async () => {
    const sigs = await rpc('getSignaturesForAddress', [DISTRIBUTOR, { limit: 25 }]);
    const sigList = (sigs || []).filter(s => !s.err).map(s => s.signature);
    if(!sigList.length) return [];
    const parseRes = await fetch(PARSE_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: sigList })
    });
    if(!parseRes.ok) throw new Error('parse ' + parseRes.status);
    const txs = await parseRes.json();
    const drips = [];
    for(const tx of (txs || [])){
      let outLamports = 0;
      let recipients = 0;
      for(const t of (tx.nativeTransfers || [])){
        if(t.fromUserAccount === DISTRIBUTOR && t.toUserAccount !== DISTRIBUTOR){
          outLamports += Number(t.amount) || 0;
          recipients++;
        }
      }
      if(outLamports > 0){
        drips.push({
          txSig: tx.signature,
          timestamp: tx.timestamp ? new Date(tx.timestamp * 1000).toISOString() : null,
          amountSol: outLamports / 1e9,
          recipients
        });
      }
      if(drips.length >= 15) break;
    }
    return drips;
  });
}

// --- Our own burn totals from Redis ----------------------------------------
async function fetchBurnTotals(){
  const [total, events] = await Promise.all([
    redis(['GET', TOTAL_BURN_KEY]),
    redis(['GET', TOTAL_BURN_EVENTS_KEY])
  ]);
  return {
    tokensBurned: Number(total) || 0,
    burnEvents: Number(events) || 0
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if(!HELIUS_KEY){
    res.status(500).json({ error: 'Server is missing HELIUS_API_KEY' });
    return;
  }

  const [market, supply, distribution, holders, recentDrips, burnTotals] = await Promise.all([
    fetchMarket().catch(() => null),
    fetchSupply().catch(() => null),
    fetchDistribution().catch(() => null),
    fetchHolders().catch(() => null),
    fetchRecentDrips().catch(() => null),
    fetchBurnTotals().catch(() => ({ tokensBurned: 0, burnEvents: 0 }))
  ]);

  // Prefer Forge burn figures when they are larger (Forge has full history),
  // otherwise use our own webhook-fed totals.
  const burns = {
    tokensBurned: Math.max(burnTotals.tokensBurned, distribution?.forgeTokensBurned || 0),
    burnEvents: Math.max(burnTotals.burnEvents, distribution?.forgeBurnEvents || 0),
    supplyBurnedPct: distribution?.forgeSupplyBurnedPct
      || (supply?.circulating ? (burnTotals.tokensBurned / (supply.circulating + burnTotals.tokensBurned)) * 100 : null)
  };

  let marketCap = null;
  if(market?.priceUsd && supply?.circulating) marketCap = market.priceUsd * supply.circulating;

  res.status(200).json({
    market: market ? Object.assign({ marketCap }, market) : null,
    supply,
    distribution,
    burns,
    holders,
    recentDrips: recentDrips || [],
    fetchedAt: new Date().toISOString()
  });
};
