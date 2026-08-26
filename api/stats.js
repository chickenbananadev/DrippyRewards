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

// Per-source diagnostics, exposed via /api/stats?debug=1 so data-freshness
// problems (e.g. a source silently serving week-old stale cache) can be seen
// from a browser without Vercel log access. Warm-instance state; best effort.
const DIAG = {};
const FAIL_AT = {}; // key -> ms timestamp of last refresh failure (warm-instance backoff)

// Cache helper: returns cached value if younger than ttlMs, otherwise calls
// refresh(), stores, and returns fresh. Falls back to stale cache on failure.
async function cached(key, ttlMs, refresh){
  const raw = await redis(['GET', key]);
  let entry = null;
  if(raw){ try{ entry = JSON.parse(raw); }catch(_){} }
  if(entry && (Date.now() - entry.t) < ttlMs){
    DIAG[key] = { source: 'cache', ageSec: Math.round((Date.now() - entry.t) / 1000) };
    return entry.v;
  }
  // Backoff: if this source just failed (e.g. Helius 429), don't re-hit it on
  // every request — serve stale for 60s so a rate-limited upstream can recover.
  if(entry && FAIL_AT[key] && (Date.now() - FAIL_AT[key]) < 60_000){
    DIAG[key] = { source: 'stale-cache-backoff', ageSec: Math.round((Date.now() - entry.t) / 1000) };
    return entry.v;
  }
  try{
    const fresh = await refresh();
    if(fresh != null){
      await redis(['SET', key, JSON.stringify({ t: Date.now(), v: fresh })]);
      DIAG[key] = { source: 'fresh' };
      return fresh;
    }
    FAIL_AT[key] = Date.now();
    DIAG[key] = { source: entry ? 'stale-cache' : 'none', ageSec: entry ? Math.round((Date.now() - entry.t) / 1000) : null, error: 'refresh returned null' };
  }catch(e){
    console.error('[stats]', key, e.message);
    FAIL_AT[key] = Date.now();
    DIAG[key] = { source: entry ? 'stale-cache' : 'none', ageSec: entry ? Math.round((Date.now() - entry.t) / 1000) : null, error: e.message };
  }
  return entry ? entry.v : null; // stale beats nothing
}

// RPC endpoint chain: Helius first, then free public endpoints. Helius has
// been sustaining 429s (plan quota), which froze supply/payout data — but the
// standard JSON-RPC methods used here work on public endpoints too, and Redis
// caching keeps our call volume tiny. Sticky preference: once an endpoint
// works, keep using it for this warm instance so a rate-limited Helius isn't
// retried (and re-billed) on every single call; a fresh instance tries Helius
// first again.
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
  return cached('drippy:stats:supply', 1_800_000, async () => { // 30 min — Helius quota relief; supply moves slowly
    const res = await rpc('getTokenSupply', [TOKEN_MINT]);
    const amt = Number(res?.value?.uiAmount);
    return isFinite(amt) ? { circulating: amt } : null;
  });
}

// --- Forge distribution data (60s cache) -----------------------------------
// Forge migrated to /solana/token/... URLs and now bot-filters plain fetches
// (custom User-Agents get a 403). Send real browser headers and try the known
// endpoint paths, using whichever returns valid JSON. FORGE_URL_OVERRIDE lets
// us repoint instantly via env var if Forge moves the API again.
function forgeCandidates(){
  if(process.env.FORGE_URL_OVERRIDE) return [process.env.FORGE_URL_OVERRIDE];
  return [
    'https://forgepad.fun/api/token-distribution/' + TOKEN_MINT,
    'https://forgepad.fun/api/solana/token-distribution/' + TOKEN_MINT,
    'https://forgepad.fun/solana/api/token-distribution/' + TOKEN_MINT
  ];
}
function fetchDistribution(){
  return cached('drippy:stats:forge', 60_000, async () => {
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Referer': 'https://forgepad.fun/solana/token/' + TOKEN_MINT
    };
    let d = null, lastErr = 'forge unreachable';
    for(const url of forgeCandidates()){
      try{
        const r = await fetch(url, { headers });
        if(!r.ok){ lastErr = 'forge ' + r.status + ' @ ' + url; continue; }
        const j = await r.json();
        if(j && (j.totalDividendsDistributed != null || j.successfulDistributions != null || j.burnToEarnTokensBurned != null)){ d = j; break; }
        lastErr = 'forge unexpected schema @ ' + url;
      }catch(e){ lastErr = (e.message || 'fetch failed') + ' @ ' + url; }
    }
    if(!d) throw new Error(lastErr);
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
  return cached('drippy:stats:holders', 3_600_000, async () => { // 1 h — heaviest Helius call (paginated account scan)
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
  return cached('drippy:stats:recentdrips', 300_000, async () => { // 5 min cache
    const sigs = await rpc('getSignaturesForAddress', [DISTRIBUTOR, { limit: 25 }]);
    const sigList = (sigs || []).filter(s => !s.err).map(s => s.signature).slice(0, 15);
    if(!sigList.length) return [];

    // Preferred: Helius enhanced parse — one request for all transactions.
    try{
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
    }catch(e){
      console.error('[stats] helius parse failed, falling back to getTransaction:', e.message);
    }

    // Fallback: standard getTransaction per signature — works on public RPC
    // when the Helius enhanced API is rate-limited. Distributor outflow is
    // derived from pre/post balances (minus the fee when it's the fee payer);
    // recipients = accounts whose SOL balance increased.
    const settled = await Promise.allSettled(sigList.map(sig =>
      rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]).then(tx => ({ sig, tx }))
    ));
    const drips = [];
    for(const s of settled){
      if(s.status !== 'fulfilled') continue;
      const { sig, tx } = s.value;
      if(!tx || !tx.meta || !tx.transaction) continue;
      const keys = (tx.transaction.message.accountKeys || []).map(k => (typeof k === 'string') ? k : (k && k.pubkey));
      const di = keys.indexOf(DISTRIBUTOR);
      if(di < 0) continue;
      const pre = tx.meta.preBalances || [];
      const post = tx.meta.postBalances || [];
      let lamports = (pre[di] || 0) - (post[di] || 0);
      if(di === 0) lamports -= (tx.meta.fee || 0); // fee payer: exclude the tx fee from "paid out"
      let recipients = 0;
      for(let i = 0; i < keys.length; i++){
        if(i !== di && (post[i] || 0) > (pre[i] || 0)) recipients++;
      }
      if(lamports > 0){
        drips.push({
          txSig: sig,
          timestamp: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
          amountSol: lamports / 1e9,
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

  // Forge is the single source of truth for the burn trio when reachable —
  // never mix sources. (Production debug showed the old Math.max approach
  // pairing Forge's 27.56% with the internal webhook tally of 319.4M tokens,
  // which is inflated: more tokens than Forge across fewer events. Forge:
  // 216.08M / 369 events / 27.56% — a consistent set.) The webhook tally is
  // only a last resort when Forge is completely unavailable, and its pct then
  // uses Forge's own definition (burned / current circulating) so the pair it
  // produces is at least internally consistent.
  const haveForge = !!(distribution && (distribution.forgeTokensBurned > 0 || (distribution.forgeSupplyBurnedPct || 0) > 0));
  const burns = haveForge ? {
    tokensBurned: distribution.forgeTokensBurned,
    burnEvents: distribution.forgeBurnEvents || 0,
    supplyBurnedPct: (distribution.forgeSupplyBurnedPct || 0) > 0
      ? distribution.forgeSupplyBurnedPct
      : (supply?.circulating ? (distribution.forgeTokensBurned / supply.circulating) * 100 : null),
    pctSource: 'forge'
  } : {
    tokensBurned: burnTotals.tokensBurned,
    burnEvents: burnTotals.burnEvents,
    supplyBurnedPct: supply?.circulating ? (burnTotals.tokensBurned / supply.circulating) * 100 : null,
    pctSource: 'webhook-fallback'
  };

  let marketCap = null;
  if(market?.priceUsd && supply?.circulating) marketCap = market.priceUsd * supply.circulating;
  // Note: supply comes from getTokenSupply, i.e. the mint's FULL on-chain
  // supply. DRIPPY burns are transfers to the burn wallet, not mint burns,
  // so burned tokens still count here — burns tighten tradable supply and
  // support price, which raises this market cap. That is intentional: it is
  // the same MC that gates the Forge volume boost below.

  // Forge volume boost: while market cap holds above $500K, the project
  // receives 5% of Forge's daily platform volume into the rewards pool on
  // top of the 5% trading tax. Surface the live status so the site can
  // show it the moment MC crosses the line (stats refresh every 45s).
  const BOOST_MC_USD = 500_000;
  const forgeBoost = (marketCap != null) ? {
    active: marketCap >= BOOST_MC_USD,
    thresholdUsd: BOOST_MC_USD,
    marketCapUsd: marketCap,
    progressPct: Math.min(100, (marketCap / BOOST_MC_USD) * 100),
    sharePct: 5
  } : null;

  const payload = {
    market: market ? Object.assign({ marketCap }, market) : null,
    supply,
    distribution,
    burns,
    forgeBoost,
    holders,
    recentDrips: recentDrips || [],
    fetchedAt: new Date().toISOString()
  };
  if (req.query && (req.query.debug === '1' || req.query.debug === 1)) {
    payload.debug = { sources: DIAG, webhookBurnTotals: burnTotals };
  }
  res.status(200).json(payload);
};
