// /api/username.js
// Get or set a wallet's username. Setting requires a signed message proving
// wallet ownership (verified server-side with tweetnacl ed25519).
//
// GET  /api/username?wallet=XXXX           -> { username }
// GET  /api/username?wallets=A,B,C         -> { usernames: { A: 'name', ... } }
// POST /api/username  { wallet, username, signature, message }  -> { success }
//
// Rules:
//  - A wallet can set/change ITS OWN username (proven by signature)
//  - Usernames are globally unique (first claim wins)
//  - No one can edit another wallet's username (no valid signature = rejected)

const nacl = require('tweetnacl');
const bs58 = require('bs58');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const NAME_PREFIX = 'drippy:username:';       // wallet -> username
const NAME_TAKEN_PREFIX = 'drippy:nametaken:'; // lowercased username -> wallet

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

function cleanUsername(raw){
  // 3-20 chars, letters/numbers/underscore only
  const u = String(raw || '').trim().replace(/[^a-zA-Z0-9_]/g, '');
  return u.slice(0, 20);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (!REDIS_URL || !REDIS_TOKEN) {
    res.status(200).json({ configured: false });
    return;
  }

  // ---- GET: look up username(s) ----
  if (req.method === 'GET') {
    // Batch lookup for leaderboard
    if (req.query.wallets) {
      const wallets = String(req.query.wallets).split(',').map(w => w.trim()).filter(Boolean).slice(0, 120);
      const usernames = {};
      await Promise.all(wallets.map(async (w) => {
        const name = await redis(['GET', NAME_PREFIX + w]);
        if (name) usernames[w] = name;
      }));
      res.status(200).json({ usernames });
      return;
    }
    // Single lookup
    const wallet = req.query.wallet;
    if (!wallet) { res.status(400).json({ error: 'wallet required' }); return; }
    const username = await redis(['GET', NAME_PREFIX + wallet]);
    res.status(200).json({ wallet, username: username || null });
    return;
  }

  // ---- POST: set username (requires signature) ----
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch(_) { body = {}; } }
    const { wallet, username, signature, message } = body || {};

    if (!wallet || !username || !signature || !message) {
      res.status(400).json({ error: 'wallet, username, signature, and message are all required' });
      return;
    }

    const clean = cleanUsername(username);
    if (clean.length < 3) {
      res.status(400).json({ error: 'Username must be at least 3 characters (letters, numbers, underscore only)' });
      return;
    }

    // Verify the signature proves ownership of `wallet`
    let verified = false;
    try {
      const msgBytes = new TextEncoder().encode(message);
      const sigBytes = bs58.decode(signature);
      const pubBytes = bs58.decode(wallet);
      verified = nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes);
    } catch (e) {
      res.status(400).json({ error: 'Invalid signature format' });
      return;
    }
    if (!verified) {
      res.status(401).json({ error: 'Signature verification failed — you must sign with the wallet you are claiming' });
      return;
    }

    // Make sure the message references this wallet (anti-replay-ish sanity check)
    if (!message.includes(wallet.slice(0, 8))) {
      res.status(400).json({ error: 'Message does not match wallet' });
      return;
    }

    const takenKey = NAME_TAKEN_PREFIX + clean.toLowerCase();

    // Is this username already taken by a DIFFERENT wallet?
    const owner = await redis(['GET', takenKey]);
    if (owner && owner !== wallet) {
      res.status(409).json({ error: 'That username is already taken' });
      return;
    }

    // Free up the wallet's OLD username (if changing)
    const oldName = await redis(['GET', NAME_PREFIX + wallet]);
    if (oldName && oldName.toLowerCase() !== clean.toLowerCase()) {
      await redis(['DEL', NAME_TAKEN_PREFIX + oldName.toLowerCase()]);
    }

    // Claim it
    await redis(['SET', NAME_PREFIX + wallet, clean]);
    await redis(['SET', takenKey, wallet]);

    res.status(200).json({ success: true, wallet, username: clean });
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
};
