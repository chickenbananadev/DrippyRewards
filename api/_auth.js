// api/_auth.js — shared poster-account auth helpers.
// Files starting with "_" inside /api are NOT deployed as Serverless
// Functions by Vercel; they're just importable modules. Keeps us under
// the function-count limit while sharing this logic between news.js and
// upload-image.js.

const crypto = require('crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SESSION_SECRET = process.env.DRIPPY_SESSION_SECRET || process.env.DRIPPY_EVENTS_SECRET;

const POSTERS_KEY = 'drippy:news:posters'; // hash: username -> {salt, hash, createdAt}
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const USER_RE = /^[a-z0-9_]{3,20}$/;

async function redis(command){
  if(!REDIS_URL || !REDIS_TOKEN) return null;
  try{
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(command.map(x => String(x)))
    });
    if(!r.ok) return null;
    const j = await r.json();
    return j.result;
  }catch(e){ return null; }
}

function safeEqual(a, b){
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if(ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function hashPassword(password, salt){
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function makeToken(username){
  const payload = Buffer.from(username + '|' + (Date.now() + TOKEN_TTL_MS)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
}

// Returns the username if the token is validly signed and unexpired, else null.
// Does NOT check whether the account still exists — callers needing that
// guarantee (e.g. publishing) should also call getPoster().
function verifyToken(token){
  if(!token || !SESSION_SECRET) return null;
  const parts = String(token).split('.');
  if(parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(parts[0]).digest('hex');
  if(!safeEqual(parts[1], expected)) return null;
  let decoded = '';
  try{ decoded = Buffer.from(parts[0], 'base64url').toString(); }catch(_){ return null; }
  const i = decoded.lastIndexOf('|');
  if(i < 1) return null;
  const username = decoded.slice(0, i);
  const exp = Number(decoded.slice(i + 1));
  if(!isFinite(exp) || Date.now() > exp) return null;
  return username;
}

async function getPoster(username){
  const raw = await redis(['HGET', POSTERS_KEY, username]);
  if(!raw) return null;
  try{ return JSON.parse(raw); }catch(_){ return null; }
}

module.exports = { redis, safeEqual, hashPassword, makeToken, verifyToken, getPoster, POSTERS_KEY, USER_RE };
