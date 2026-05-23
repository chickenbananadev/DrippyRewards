// /api/candles.js
// Proxies GeckoTerminal's free OHLCV API so the browser gets real candle data
// with no CORS issues. No API key required.
//
// Usage: /api/candles?tf=15m   (tf = 1m,5m,15m,1h,4h,1d)

const PAIR = '3ohceht4kcjkysrtn4mysd2zwgkwz1cinualvtcchqmz';
const NETWORK = 'solana';

// Map our timeframe codes to GeckoTerminal's timeframe + aggregate
const TF_MAP = {
  '1m':  { timeframe: 'minute', aggregate: 1 },
  '5m':  { timeframe: 'minute', aggregate: 5 },
  '15m': { timeframe: 'minute', aggregate: 15 },
  '1h':  { timeframe: 'hour',   aggregate: 1 },
  '4h':  { timeframe: 'hour',   aggregate: 4 },
  '1d':  { timeframe: 'day',    aggregate: 1 }
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const tf = (req.query.tf || '15m').toLowerCase();
  const cfg = TF_MAP[tf] || TF_MAP['15m'];

  try {
    const url = 'https://api.geckoterminal.com/api/v2/networks/' + NETWORK +
                '/pools/' + PAIR + '/ohlcv/' + cfg.timeframe +
                '?aggregate=' + cfg.aggregate + '&limit=300&currency=usd';

    const r = await fetch(url, {
      headers: {
        'Accept': 'application/json;version=20230302',
        'User-Agent': 'DrippyRewards-Site/1.0'
      }
    });

    if (!r.ok) {
      res.status(r.status).json({ error: 'GeckoTerminal returned ' + r.status, candles: [] });
      return;
    }

    const data = await r.json();
    const list = (data && data.data && data.data.attributes && data.data.attributes.ohlcv_list) || [];

    // ohlcv_list entries: [timestamp, open, high, low, close, volume]
    // GeckoTerminal returns newest-first — reverse to oldest-first for charting.
    const candles = list
      .map(row => ({
        time: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low:  Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5])
      }))
      .filter(c => c.time && isFinite(c.close))
      .sort((a, b) => a.time - b.time);

    res.status(200).json({
      tf: tf,
      candles: candles,
      count: candles.length,
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('[candles] error:', err);
    res.status(500).json({ error: err.message || 'Unknown error', candles: [] });
  }
};
