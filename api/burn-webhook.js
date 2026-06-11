// /api/burn-webhook.js
// Receives Helius enhanced webhook events for the burn/distributor address and
// records $DRIPPY burns into Redis. This is the ingestion pipeline that was
// missing: nothing previously wrote to drippy:burn:leaderboard.
//
// Setup (Helius dashboard or API):
//   Webhook type: enhanced
//   Account:      N1LCBQJnjLP3ppv7npzL5Btzf5Yp3hBMr6s8GmVfEyV
//   URL:          https://drippyrewards.com/api/burn-webhook
//   Auth header:  set to the value of HELIUS_WEBHOOK_SECRET
//
// Required env vars: HELIUS_WEBHOOK_SECRET, KV_REST_API_URL, KV_REST_API_TOKEN

const TOKEN_MINT = 'EPRZgmvU4aTQ4UaC4bywgNvxJ5YmhuKqM1bx3gw4DRPY';
const BURN_ADDRESS = 'N1LCBQJnjLP3ppv7npzL5Btzf5Yp3hBMr6s8GmVfEyV';

const WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET; // no fallback, on purpose
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const LB_BURN_KEY = 'drippy:burn:leaderboard'; // zset wallet -> ui tokens burned
const META_PREFIX = 'drippy:meta:';            // per wallet json blob
const TOTAL_KEY = 'drippy:burn:total';         // running ui total of all burns
const TOTAL_EVENTS_KEY = 'drippy:burn:events'; // running count of burn events
const SIG_PREFIX = 'drippy:burnsig:';          // dedup guard per signature

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
    if(j.error){ console.error('[redis]', j.error); return null; }
    return j.result;
  }catch(e){ console.error('[redis]', e.message); return null; }
}

// Extract burn transfers from one Helius enhanced transaction.
// A "burn" for Drippy is either:
//   1. An SPL transfer of the mint INTO the burn/distributor address
//   2. A native SPL Burn instruction on the mint (type BURN)
function extractBurns(tx){
  const burns = [];
  const transfers = tx.tokenTransfers || [];
  for(const t of transfers){
    if(t.mint !== TOKEN_MINT) continue;
    const amount = Number(t.tokenAmount) || 0;
    if(amount <= 0) continue;
    if(t.toUserAccount === BURN_ADDRESS && t.fromUserAccount && t.fromUserAccount !== BURN_ADDRESS){
      burns.push({ wallet: t.fromUserAccount, amount });
    } else if(tx.type === 'BURN' && t.fromUserAccount){
      burns.push({ wallet: t.fromUserAccount, amount });
    }
  }
  return burns;
}

async function recordBurn(wallet, amount, sig, timestamp){
  // Dedup: webhook deliveries can retry. SET NX guards each signature+wallet.
  // Guard is PERMANENT: an expiring guard lets a later backfill re-record
  // the same burn and double count (this bit us 2026-06-10).
  const guard = await redis(['SET', SIG_PREFIX + sig + ':' + wallet, '1', 'NX']);
  if(guard === null || guard === undefined) {
    // Redis unavailable: bail rather than risk double counting later
    return false;
  }
  if(guard !== 'OK') return false; // already processed

  await redis(['ZINCRBY', LB_BURN_KEY, String(amount), wallet]);
  await redis(['INCRBYFLOAT', TOTAL_KEY, String(amount)]);
  await redis(['INCR', TOTAL_EVENTS_KEY]);

  // Update the wallet's meta blob
  let meta = {};
  const existing = await redis(['GET', META_PREFIX + wallet]);
  if(existing){ try{ meta = JSON.parse(existing); }catch(_){} }
  meta.tokensBurned = (Number(meta.tokensBurned) || 0) + amount;
  meta.burnEvents = (Number(meta.burnEvents) || 0) + 1;
  meta.lastBurnAt = timestamp || Date.now();
  meta.updatedAt = Date.now();
  await redis(['SET', META_PREFIX + wallet, JSON.stringify(meta)]);
  return true;
}

module.exports = async (req, res) => {
  if(req.method !== 'POST'){
    res.status(405).json({ error: 'POST only' });
    return;
  }
  if(!WEBHOOK_SECRET){
    res.status(500).json({ error: 'HELIUS_WEBHOOK_SECRET is not configured' });
    return;
  }
  const auth = req.headers['authorization'] || '';
  if(auth !== WEBHOOK_SECRET && auth !== 'Bearer ' + WEBHOOK_SECRET){
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  let payload = req.body;
  if(typeof payload === 'string'){ try{ payload = JSON.parse(payload); }catch(_){ payload = null; } }
  if(!Array.isArray(payload)){
    res.status(400).json({ error: 'expected an array of enhanced transactions' });
    return;
  }

  let recorded = 0;
  for(const tx of payload){
    if(!tx || tx.transactionError) continue;
    const burns = extractBurns(tx);
    for(const b of burns){
      const ok = await recordBurn(b.wallet, b.amount, tx.signature, (tx.timestamp || 0) * 1000);
      if(ok) recorded++;
    }
  }

  res.status(200).json({ success: true, received: payload.length, burnsRecorded: recorded });
};
