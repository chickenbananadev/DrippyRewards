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
const FINALE_BEAT_KEY = 'drippy:game:finale_beat'; // SET of wallets who beat Eternal Drip
const SELECTED_SKIN_PREFIX = 'drippy:skin:'; // wallet -> selected skin key
const BURN_LB_KEY = 'drippy:burn:leaderboard';

const SESSION_COOKIE = 'drippy_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days
const SESSION_SECRET = process.env.DRIPPY_SESSION_SECRET || process.env.DRIPPY_EVENTS_SECRET || '';

const crypto = require('crypto');

function signSession(wallet, ts){
  const payload = `${wallet}|${ts}`;
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${wallet}.${ts}.${hmac}`;
}
function verifySession(cookieVal){
  if (!cookieVal || !SESSION_SECRET) return null;
  const parts = String(cookieVal).split('.');
  if (parts.length !== 3) return null;
  const [wallet, tsStr, hmac] = parts;
  const ts = Number(tsStr);
  if (!wallet || !ts || (Date.now() - ts) > SESSION_MAX_AGE * 1000) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`${wallet}|${ts}`).digest('base64url');
  // constant-time compare
  try {
    if (hmac.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) return null;
  } catch(_) { return null; }
  return wallet;
}
function readCookie(req, name){
  const c = req.headers.cookie || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function setSessionCookie(res, wallet){
  const cookie = signSession(wallet, Date.now());
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(cookie)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`);
}
function clearSessionCookie(res){
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

// Burn tier thresholds (mirrors front-end). 'believer' requires currentHoldings > 0.
const TIERS = [
  { id: 'holder',   min: 0,        beat: false, label: 'Holder' },
  { id: 'believer', min: 0,        beat: false, label: 'True Believer Drippy', requireHolder: true },
  { id: 'bronze',   min: 100000,   beat: false, label: 'Bronze Drippy' },
  { id: 'silver',   min: 500000,   beat: false, label: 'Silver Drippy' },
  { id: 'gold',     min: 1000000,  beat: false, label: 'Gold Drippy' },
  { id: 'diamond',  min: 5000000,  beat: false, label: 'Diamond Drippy' },
  { id: 'shadow',   min: 0,        beat: true,  label: 'Shadow Drippy' },
  { id: 'void',     min: 10000000, beat: true,  label: 'Void Drippy' },
];
async function fetchHolderStatus(wallet, hostHeader){
  // Internal call to /api/wallet — same pattern share.js uses
  try {
    const origin = `https://${hostHeader || 'drippyrewards.com'}`;
    const r = await fetch(`${origin}/api/wallet?address=${wallet}`, { cache: 'no-store' });
    if (!r.ok) return { holds: 0, isHolder: false };
    const d = await r.json();
    const holds = Number(d?.currentHoldings?.uiAmount || 0);
    return { holds, isHolder: holds > 0 };
  } catch (e) {
    return { holds: 0, isHolder: false };
  }
}
async function computeUnlocks(wallet, hostHeader){
  const burnedRaw = await redis(['ZSCORE', BURN_LB_KEY, wallet]);
  let burned = Number(burnedRaw) || 0;
  if (burned > 1e9) burned = burned / 1e9; // 9-decimal contamination guard
  const beat = !!(await redis(['SISMEMBER', FINALE_BEAT_KEY, wallet]));
  const { holds, isHolder } = await fetchHolderStatus(wallet, hostHeader);
  const skins = {};
  for (const t of TIERS) {
    let ok = burned >= t.min && (!t.beat || beat);
    if (t.requireHolder && !isHolder) ok = false;
    skins[t.id] = ok;
  }
  return { wallet, burned, beat, holds, isHolder, skins };
}

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

  const action = String(req.query.action || '').toLowerCase();

  // ---- AUTH: GET ?action=session  -> who am I? ----
  if (req.method === 'GET' && action === 'session') {
    const cookie = readCookie(req, SESSION_COOKIE);
    const wallet = verifySession(cookie);
    if (!wallet) { res.status(200).json({ signedIn: false }); return; }
    const username = await redis(['GET', NAME_PREFIX + wallet]);
    const unlocks = await computeUnlocks(wallet, req.headers.host);
    const skin = await redis(['GET', SELECTED_SKIN_PREFIX + wallet]);
    res.status(200).json({ signedIn: true, wallet, username: username || null, ...unlocks, selectedSkin: skin || null });
    return;
  }

  // ---- AUTH: POST ?action=signin {wallet, signature, message} ----
  if (req.method === 'POST' && action === 'signin') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch(_) { body = {}; } }
    const { wallet, signature, message } = body || {};
    if (!wallet || !signature || !message) {
      res.status(400).json({ error: 'wallet, signature, message required' }); return;
    }
    let verified = false;
    try {
      const msgBytes = new TextEncoder().encode(message);
      const sigBytes = bs58.decode(signature);
      const pubBytes = bs58.decode(wallet);
      if (pubBytes.length !== 32) throw new Error('bad pubkey length');
      verified = nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes);
    } catch (e) {
      res.status(400).json({ error: 'Invalid signature format' }); return;
    }
    if (!verified) { res.status(401).json({ error: 'Signature verification failed' }); return; }
    const tsMatch = String(message).match(/:: (\d{13})$/);
    if (!tsMatch || Math.abs(Date.now() - Number(tsMatch[1])) > 10 * 60 * 1000) {
      res.status(400).json({ error: 'Signed message expired (10min window). Try again.' }); return;
    }
    if (!message.includes(wallet.slice(0, 8))) {
      res.status(400).json({ error: 'Message does not match wallet' }); return;
    }
    setSessionCookie(res, wallet);
    const username = await redis(['GET', NAME_PREFIX + wallet]);
    const unlocks = await computeUnlocks(wallet, req.headers.host);
    res.status(200).json({ success: true, wallet, username: username || null, ...unlocks });
    return;
  }

  // ---- AUTH: POST ?action=signout  -> clear cookie ----
  if (req.method === 'POST' && action === 'signout') {
    clearSessionCookie(res);
    res.status(200).json({ ok: true });
    return;
  }

  // ---- GET ?action=unlocks&wallet=X  -> tier/skin gate info (read-only, no auth needed) ----
  if (req.method === 'GET' && action === 'unlocks') {
    const wallet = String(req.query.wallet || '');
    if (!wallet || wallet.length < 32) { res.status(400).json({ error: 'wallet required' }); return; }
    const unlocks = await computeUnlocks(wallet, req.headers.host);
    res.status(200).json(unlocks);
    return;
  }

  // ---- POST ?action=select_skin {skin}  -> persist skin choice (must be signed in) ----
  if (req.method === 'POST' && action === 'select_skin') {
    const cookie = readCookie(req, SESSION_COOKIE);
    const wallet = verifySession(cookie);
    if (!wallet) { res.status(401).json({ error: 'sign in first' }); return; }
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch(_) { body = {}; } }
    const skin = String(body && body.skin || '').toLowerCase();
    const allowed = ['default','bronze','silver','gold','diamond','shadow','void'];
    if (!allowed.includes(skin)) { res.status(400).json({ error: 'invalid skin' }); return; }
    const unlocks = await computeUnlocks(wallet, req.headers.host);
    if (skin !== 'default' && !unlocks.skins[skin]) {
      res.status(403).json({ error: 'skin not unlocked', unlocks });
      return;
    }
    if (skin === 'default') await redis(['DEL', SELECTED_SKIN_PREFIX + wallet]);
    else await redis(['SET', SELECTED_SKIN_PREFIX + wallet, skin]);
    res.status(200).json({ ok: true, selectedSkin: skin === 'default' ? null : skin });
    return;
  }

  // ---- POST ?action=finale_beat  -> mark wallet beat Eternal Drip (must be signed in) ----
  if (req.method === 'POST' && action === 'finale_beat') {
    const cookie = readCookie(req, SESSION_COOKIE);
    const wallet = verifySession(cookie);
    if (!wallet) { res.status(401).json({ error: 'sign in first' }); return; }
    await redis(['SADD', FINALE_BEAT_KEY, wallet]);
    res.status(200).json({ ok: true });
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

    // Reject stale signed messages (must be signed within the last 10 minutes)
    const tsMatch = String(message).match(/:: (\d{13})$/);
    if (!tsMatch || Math.abs(Date.now() - Number(tsMatch[1])) > 10 * 60 * 1000) {
      res.status(400).json({ error: 'Signed message expired. Try again.' });
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
