// /api/og-card.js
// Generates a dynamic OG share card image (PNG) for a wallet's DripQuests stats.
// Uses pure SVG -> PNG conversion via resvg-js (no Edge runtime needed).
//
// Usage: /api/og-card?wallet=XXXX

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
    res.status(400).send('Missing or invalid wallet');
    return;
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
    res.status(500).send('Could not fetch wallet data: ' + e.message);
    return;
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

  const W = 900, H = 1100;
  const tc = tier.color;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a0a2e"/>
      <stop offset="50%" stop-color="#0a0610"/>
      <stop offset="100%" stop-color="#2a1248"/>
    </linearGradient>
    <linearGradient id="solGlow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffd966"/>
      <stop offset="100%" stop-color="#f5c542"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="url(#bg)"/>

  <!-- Outer border -->
  <rect x="20" y="20" width="${W-40}" height="${H-40}" rx="4" fill="none" stroke="${tc}" stroke-width="5"/>
  <!-- Inner border -->
  <rect x="36" y="36" width="${W-72}" height="${H-72}" rx="2" fill="none" stroke="#f5c542" stroke-width="2"/>

  <!-- Decorative sparkles -->
  ${Array.from({length: 40}, (_, i) => {
    const x = ((i * 137 + 43) % W);
    const y = ((i * 191 + 71) % H);
    const r = 1.5 + (i % 3);
    const col = i % 2 === 0 ? 'rgba(245,197,66,0.25)' : 'rgba(162,89,255,0.25)';
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${col}"/>`;
  }).join('\n  ')}

  <!-- Header -->
  <text x="${W/2}" y="100" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="56" font-weight="900" fill="#ffd966" letter-spacing="3">DRIPQUESTS</text>
  <text x="${W/2}" y="132" text-anchor="middle" font-family="Courier New, monospace" font-size="20" font-weight="bold" fill="#a259ff">drippyrewards.com</text>

  <!-- Featured image placeholder (gold bordered box) -->
  <rect x="${(W-340)/2}" y="170" width="340" height="340" rx="24" fill="rgba(162,89,255,0.12)" stroke="${tc}" stroke-width="4"/>
  <text x="${W/2}" y="320" text-anchor="middle" font-family="Arial, sans-serif" font-size="80">🐕</text>
  <text x="${W/2}" y="380" text-anchor="middle" font-family="Courier New, monospace" font-size="16" fill="rgba(246,233,196,0.5)">$DRIPPY</text>

  <!-- Tier label -->
  <text x="${W/2}" y="570" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="44" font-weight="900" fill="${tc}">${esc(tier.label.toUpperCase())}</text>
  <text x="${W/2}" y="600" text-anchor="middle" font-family="Courier New, monospace" font-size="18" font-weight="bold" fill="#a259ff">${completed} of 12 quests cleared</text>

  <!-- Total SOL earned label -->
  <text x="${W/2}" y="670" text-anchor="middle" font-family="Courier New, monospace" font-size="18" font-weight="bold" fill="#a259ff" letter-spacing="4">TOTAL SOL EARNED</text>
  <!-- Total SOL earned value -->
  <text x="${W/2}" y="740" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="68" font-weight="900" fill="url(#solGlow)">${esc(earned)} SOL</text>

  <!-- Stats grid 2x2 -->
  <!-- Row 1 -->
  <text x="${W/4}" y="820" text-anchor="middle" font-family="Courier New, monospace" font-size="14" font-weight="bold" fill="#a259ff" letter-spacing="2">DISTRIBUTIONS</text>
  <text x="${W/4}" y="855" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="30" font-weight="900" fill="#fff5c0">${esc(distributions)}</text>

  <text x="${W*3/4}" y="820" text-anchor="middle" font-family="Courier New, monospace" font-size="14" font-weight="bold" fill="#a259ff" letter-spacing="2">IN THE PACK</text>
  <text x="${W*3/4}" y="855" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="30" font-weight="900" fill="#fff5c0">${esc(daysHolding)}</text>

  <!-- Row 2 -->
  <text x="${W/4}" y="920" text-anchor="middle" font-family="Courier New, monospace" font-size="14" font-weight="bold" fill="#a259ff" letter-spacing="2">BURNED</text>
  <text x="${W/4}" y="955" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="30" font-weight="900" fill="#fff5c0">${esc(burned)}</text>

  <text x="${W*3/4}" y="920" text-anchor="middle" font-family="Courier New, monospace" font-size="14" font-weight="bold" fill="#a259ff" letter-spacing="2">BURN WEIGHT</text>
  <text x="${W*3/4}" y="955" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="30" font-weight="900" fill="#fff5c0">${esc(burnWeight)}</text>

  <!-- Footer -->
  <text x="${W/2}" y="${H-55}" text-anchor="middle" font-family="Courier New, monospace" font-size="16" font-weight="bold" fill="#a259ff" letter-spacing="2">PAID EVERY 30 MINUTES · BURN FOR 2X FOREVER</text>
</svg>`;

  // Convert SVG to PNG — Twitter/Telegram require raster images for og:image
  try {
    const { Resvg } = require('@resvg/resvg-js');
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: W },
    });
    const pngData = resvg.render();
    const pngBuffer = pngData.asPng();

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, s-maxage=300, max-age=60');
    res.status(200).send(pngBuffer);
  } catch (e) {
    // Fallback to SVG if resvg fails
    console.error('[og-card] PNG conversion failed, falling back to SVG:', e.message);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, s-maxage=300, max-age=60');
    res.status(200).send(svg);
  }
};
