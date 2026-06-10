// /api/og-card.js — Dynamic OG card as pure SVG
// Twitter DOES support SVG og:image when served with correct headers.
// The previous blank-text issue was a resvg font problem — this serves
// the SVG directly to the browser/crawler. No dependencies needed.

const TIERS = [
  { min: 0,  label: 'Dripper',         color: '#f5c542' },
  { min: 1,  label: 'Bronze Dripper',  color: '#cd7f32' },
  { min: 4,  label: 'Silver Dripper',  color: '#c0c0c0' },
  { min: 8,  label: 'Gold Dripper',    color: '#ffd700' },
  { min: 11, label: 'Diamond Dripper', color: '#b9f2ff' },
];

function countQuests(d) {
  let c = 0;
  const h = d.currentHoldings?.uiAmount || 0;
  const dist = d.distributionCount || 0;
  const sol = d.totalReceivedSol || 0;
  const burns = d.burner?.burnEvents || 0;
  const burned = d.burner?.tokensBurned || 0;
  if (h > 0) c++;
  if (h >= 1e6) c++;
  if (h >= 10e6) c++;
  if (dist >= 1) c++;
  if (dist >= 50) c++;
  if (dist >= 100) c++;
  if (burns >= 1) c++;
  if (burned >= 1e6) c++;
  if (burns >= 5) c++;
  if (sol >= 0.1) c++;
  if (sol >= 0.5) c++;
  if (sol >= 1) c++;
  return c;
}

function getTier(completed) {
  let tier = TIERS[0];
  for (const t of TIERS) if (completed >= t.min) tier = t;
  return tier;
}

function fmtSol(n) {
  n = Number(n || 0);
  if (n < 0.001) return n.toFixed(6);
  if (n < 1) return n.toFixed(4);
  return n.toFixed(3);
}

function fmtTokens(n) {
  n = Number(n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return Math.round(n).toLocaleString();
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

module.exports = async (req, res) => {
  const wallet = req.query.wallet || '';
  if (!wallet || wallet.length < 32) {
    return res.status(400).send('Missing or invalid wallet');
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'drippyrewards.com';
  const origin = proto + '://' + host;

  let d;
  try {
    const r = await fetch(origin + '/api/wallet?address=' + encodeURIComponent(wallet), { cache: 'no-store' });
    d = await r.json();
    if (!d || d.error) throw new Error(d?.error || 'no data');
  } catch (e) {
    return res.status(500).send('Could not fetch wallet data: ' + e.message);
  }

  const completed = countQuests(d);
  const tier = getTier(completed);
  const earned = fmtSol(d.totalReceivedSol);
  const distributions = String(d.distributionCount || 0);
  const daysHolding = d.daysHolding != null
    ? (d.daysHolding === 0 ? 'TODAY' : d.daysHolding === 1 ? '1 DAY' : d.daysHolding + ' DAYS')
    : 'HOLDER';
  const burned = fmtTokens(d.burner?.tokensBurned || 0);
  const burnWeight = (d.burner?.burnWeightSharePct || 0).toFixed(2) + '%';

  const W = 1200, H = 630;
  const tc = tier.color;

  // Use foreignObject with HTML inside SVG — this lets us use system fonts
  // that browsers render natively, solving the blank text problem
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@700;900&amp;display=swap');
      .card { font-family: 'Inter', Arial, Helvetica, sans-serif; }
    </style>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a0a2e"/>
      <stop offset="50%" stop-color="#0a0610"/>
      <stop offset="100%" stop-color="#2a1248"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="12" y="12" width="${W-24}" height="${H-24}" rx="8" fill="none" stroke="${tc}" stroke-width="4"/>
  <rect x="22" y="22" width="${W-44}" height="${H-44}" rx="4" fill="none" stroke="#f5c542" stroke-width="1.5"/>

  ${Array.from({length: 25}, (_, i) => {
    const x = ((i * 137 + 43) % W);
    const y = ((i * 191 + 71) % H);
    const r = 1 + (i % 3);
    const col = i % 2 === 0 ? 'rgba(245,197,66,0.2)' : 'rgba(162,89,255,0.2)';
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${col}"/>`;
  }).join('\n  ')}

  <line x1="480" y1="50" x2="480" y2="${H-50}" stroke="rgba(162,89,255,0.2)" stroke-width="1" stroke-dasharray="4,6"/>

  <foreignObject x="40" y="40" width="420" height="${H-80}">
    <div xmlns="http://www.w3.org/1999/xhtml" class="card" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-align:center">
      <div style="font-size:36px;font-weight:900;color:#ffd966;letter-spacing:2px">DRIPQUESTS</div>
      <div style="font-size:14px;font-weight:700;color:#a259ff;margin-top:4px">drippyrewards.com</div>
      <div style="width:180px;height:180px;border-radius:18px;border:3px solid ${tc};background:rgba(162,89,255,0.1);display:flex;align-items:center;justify-content:center;margin-top:20px;font-size:72px">&#128021;</div>
      <div style="font-size:28px;font-weight:900;color:${tc};margin-top:18px">${esc(tier.label.toUpperCase())}</div>
      <div style="font-size:13px;font-weight:700;color:#a259ff;margin-top:4px">${completed} of 12 quests cleared</div>
      <div style="font-size:11px;font-weight:700;color:rgba(162,89,255,0.5);margin-top:16px;letter-spacing:1px">PAID EVERY 30 MIN &#183; BURN FOR 2X FOREVER</div>
    </div>
  </foreignObject>

  <foreignObject x="500" y="40" width="660" height="${H-80}">
    <div xmlns="http://www.w3.org/1999/xhtml" class="card" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-align:center">
      <div style="font-size:15px;font-weight:700;color:#a259ff;letter-spacing:3px">TOTAL SOL EARNED</div>
      <div style="font-size:58px;font-weight:900;color:#ffd966;margin-top:6px">${esc(earned)} SOL</div>

      <div style="display:flex;flex-wrap:wrap;justify-content:center;width:100%;margin-top:24px;gap:8px">
        <div style="width:240px;text-align:center;margin-bottom:6px">
          <div style="font-size:11px;font-weight:700;color:#a259ff;letter-spacing:1px">DISTRIBUTIONS</div>
          <div style="font-size:26px;font-weight:900;color:#fff5c0;margin-top:2px">${esc(distributions)}</div>
        </div>
        <div style="width:240px;text-align:center;margin-bottom:6px">
          <div style="font-size:11px;font-weight:700;color:#a259ff;letter-spacing:1px">IN THE PACK</div>
          <div style="font-size:26px;font-weight:900;color:#fff5c0;margin-top:2px">${esc(daysHolding)}</div>
        </div>
        <div style="width:240px;text-align:center;margin-bottom:6px">
          <div style="font-size:11px;font-weight:700;color:#a259ff;letter-spacing:1px">BURNED</div>
          <div style="font-size:26px;font-weight:900;color:#fff5c0;margin-top:2px">${esc(burned)}</div>
        </div>
        <div style="width:240px;text-align:center;margin-bottom:6px">
          <div style="font-size:11px;font-weight:700;color:#a259ff;letter-spacing:1px">BURN WEIGHT</div>
          <div style="font-size:26px;font-weight:900;color:#fff5c0;margin-top:2px">${esc(burnWeight)}</div>
        </div>
      </div>

      <div style="margin-top:20px">
        <div style="font-size:17px;font-weight:900;color:#ffd966">THE DRIP NEVER STOPS</div>
        <div style="font-size:12px;color:rgba(246,233,196,0.5);margin-top:4px">5% tax &#183; 100% to SOL &#183; rewards every 30 min</div>
      </div>

      <div style="margin-top:16px;padding:8px 36px;border-radius:8px;border:2px solid ${tc};background:rgba(245,197,66,0.12)">
        <div style="font-size:15px;font-weight:900;color:${tc}">JOIN THE PACK</div>
      </div>
    </div>
  </foreignObject>
</svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, s-maxage=300, max-age=60');
  res.status(200).send(svg);
};
