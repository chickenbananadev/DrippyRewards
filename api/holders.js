// /api/holders.js
// Returns the current $DRIPPY holder count by counting all on-chain token
// accounts holding the mint. Uses Helius RPC. Cached for 10 minutes.

const TOKEN_MINT = 'EPRZgmvU4aTQ4UaC4bywgNvxJ5YmhuKqM1bx3gw4DRPY';
const HELIUS_KEY = process.env.HELIUS_API_KEY || 'c3f500f3-db28-4d44-994f-0fa0e0ebd510';

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const CACHE_KEY = 'drippy:holders:cached';

async function redis(command){
  if(!REDIS_URL || !REDIS_TOKEN) return null;
  try{
    const stringCmd = command.map(x => String(x));
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(stringCmd)
    });
    if(!r.ok) return null;
    const j = await r.json();
    return j.result;
  }catch(e){ return null; }
}

// Use Helius's getProgramAccounts to count token accounts holding this mint.
// We paginate up to a reasonable cap. Filters out zero-balance accounts.
async function countHolders(){
  try{
    const url = 'https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getProgramAccounts',
        params: [
          'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token program
          {
            encoding: 'jsonParsed',
            filters: [
              { dataSize: 165 },
              { memcmp: { offset: 0, bytes: TOKEN_MINT } }
            ]
          }
        ]
      })
    });
    if(!r.ok) return null;
    const j = await r.json();
    const accounts = j?.result || [];
    // Count unique owners with non-zero balance
    const owners = new Set();
    accounts.forEach(acc => {
      const info = acc?.account?.data?.parsed?.info;
      const ui = info?.tokenAmount?.uiAmount;
      const owner = info?.owner;
      if (owner && typeof ui === 'number' && ui > 0) owners.add(owner);
    });
    return owners.size;
  }catch(e){
    console.error('[holders]', e.message);
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600'); // 5 min edge cache

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    // Check Redis cache (10 minute TTL)
    if (REDIS_URL && REDIS_TOKEN) {
      const cached = await redis(['GET', CACHE_KEY]);
      if (cached) {
        try {
          const data = JSON.parse(cached);
          if (data && Date.now() - data.timestamp < 10 * 60 * 1000) {
            return res.status(200).json({ count: data.count, cached: true, age: Date.now() - data.timestamp });
          }
        } catch(_) {}
      }
    }

    const count = await countHolders();
    if (count == null) {
      return res.status(200).json({ count: null, error: 'unavailable' });
    }

    // Save to cache
    if (REDIS_URL && REDIS_TOKEN) {
      await redis(['SET', CACHE_KEY, JSON.stringify({ count, timestamp: Date.now() })]);
    }

    res.status(200).json({ count, cached: false });
  } catch (err) {
    console.error('[holders] error:', err);
    res.status(500).json({ error: err.message || 'unknown' });
  }
};
