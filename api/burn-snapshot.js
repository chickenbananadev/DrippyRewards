// /api/burn-snapshot.js
// Records a point-in-time snapshot of every burner's cumulative burn total,
// so burns within a time window can be computed later by diffing two snapshots.
//
// CRON (record):  GET /api/burn-snapshot?secret=XXXX&action=record
//   -> saves drippy:snapshot:YYYY-MM-DD = { wallet: tokensBurned, ... }
//
// QUERY (range):  GET /api/burn-snapshot?secret=XXXX&action=range&from=YYYY-MM-DD&to=YYYY-MM-DD
//   -> returns burns per wallet between the two dates (to_total - from_total)
//
// LIST:           GET /api/burn-snapshot?secret=XXXX&action=list
//   -> lists all snapshot dates available

const ADMIN_SECRET = process.env.DRIPPY_EVENTS_SECRET || '2026Drippyrewards';
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const LB_BURN_KEY = 'drippy:burn:leaderboard';
const META_PREFIX = 'drippy:meta:';
const SNAP_PREFIX = 'drippy:snapshot:';
const SNAP_INDEX = 'drippy:snapshot:index'; // sorted set of snapshot dates

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

function today(){
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const secret = req.query.secret || req.headers['x-admin-secret'];
  if (secret !== ADMIN_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (!REDIS_URL || !REDIS_TOKEN) {
    res.status(500).json({ error: 'Redis not configured' });
    return;
  }

  const action = req.query.action || 'record';

  // ---- RECORD: snapshot all burners' current totals ----
  if (action === 'record') {
    const date = req.query.date || today();

    // Pull every wallet from the burn leaderboard
    const raw = await redis(['ZRANGE', LB_BURN_KEY, '0', '-1', 'WITHSCORES']);
    if (!raw || raw.length === 0) {
      res.status(200).json({ success: true, date, count: 0, note: 'no burners to snapshot' });
      return;
    }

    const snapshot = {};
    for (let i = 0; i < raw.length; i += 2) {
      const wallet = raw[i];
      const burned = Number(raw[i + 1]) || 0;
      if (wallet) snapshot[wallet] = burned;
    }

    await redis(['SET', SNAP_PREFIX + date, JSON.stringify(snapshot)]);
    await redis(['ZADD', SNAP_INDEX, Date.parse(date), date]);

    res.status(200).json({ success: true, date, count: Object.keys(snapshot).length });
    return;
  }

  // ---- LIST: all snapshot dates ----
  if (action === 'list') {
    const dates = await redis(['ZRANGE', SNAP_INDEX, '0', '-1']) || [];
    res.status(200).json({ dates });
    return;
  }

  // ---- RANGE: burns between two dates ----
  if (action === 'range') {
    const from = req.query.from;
    const to = req.query.to || today();
    if (!from) {
      res.status(400).json({ error: 'from date required (YYYY-MM-DD)' });
      return;
    }

    const fromSnapStr = await redis(['GET', SNAP_PREFIX + from]);
    let toSnapStr = await redis(['GET', SNAP_PREFIX + to]);

    // If "to" snapshot doesn't exist (e.g. asking up to today before cron ran),
    // build a live snapshot from the current leaderboard
    let toSnap;
    if (toSnapStr) {
      toSnap = JSON.parse(toSnapStr);
    } else {
      const raw = await redis(['ZRANGE', LB_BURN_KEY, '0', '-1', 'WITHSCORES']);
      toSnap = {};
      if (raw) for (let i = 0; i < raw.length; i += 2) {
        if (raw[i]) toSnap[raw[i]] = Number(raw[i + 1]) || 0;
      }
    }

    if (!fromSnapStr) {
      res.status(404).json({ error: 'No snapshot exists for "from" date ' + from + '. Available dates: use action=list' });
      return;
    }
    const fromSnap = JSON.parse(fromSnapStr);

    // Diff: burns in window = current total - total at "from"
    const results = [];
    for (const wallet of Object.keys(toSnap)) {
      const before = fromSnap[wallet] || 0;
      const after = toSnap[wallet];
      const delta = after - before;
      if (delta > 0) {
        results.push({ wallet, burnedInPeriod: delta, totalBurned: after });
      }
    }
    results.sort((a, b) => b.burnedInPeriod - a.burnedInPeriod);

    // Attach usernames
    await Promise.all(results.slice(0, 100).map(async (r) => {
      const name = await redis(['GET', 'drippy:username:' + r.wallet]);
      if (name) r.username = name;
    }));

    res.status(200).json({
      from, to,
      count: results.length,
      totalBurnedInPeriod: results.reduce((s, r) => s + r.burnedInPeriod, 0),
      entries: results.slice(0, 100)
    });
    return;
  }

  res.status(400).json({ error: 'unknown action — use record, list, or range' });
};
