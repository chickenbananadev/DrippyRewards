// /api/og-card.js
// Generates a dynamic OG share card image (PNG) for Twitter/Telegram.
// Wide landscape format (1200x630) for summary_large_image compatibility.

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

  const W = 1200, H = 630;
  const tc = tier.color;

  // Left column x center, right column x positions
  const leftX = 320;  // center of left area (for dog + tier)
  const rightX = 780; // center of right area (for stats)

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
  <rect x="12" y="12" width="${W-24}" height="${H-24}" rx="8" fill="none" stroke="${tc}" stroke-width="4"/>
  <!-- Inner border -->
  <rect x="22" y="22" width="${W-44}" height="${H-44}" rx="4" fill="none" stroke="#f5c542" stroke-width="1.5"/>

  <!-- Sparkles -->
  ${Array.from({length: 30}, (_, i) => {
    const x = ((i * 137 + 43) % W);
    const y = ((i * 191 + 71) % H);
    const r = 1 + (i % 3);
    const col = i % 2 === 0 ? 'rgba(245,197,66,0.2)' : 'rgba(162,89,255,0.2)';
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${col}"/>`;
  }).join('\n  ')}

  <!-- Divider line between left and right -->
  <line x1="540" y1="60" x2="540" y2="${H-60}" stroke="rgba(162,89,255,0.25)" stroke-width="1" stroke-dasharray="4,6"/>

  <!-- ===== LEFT SIDE: Branding + Tier ===== -->

  <!-- Header -->
  <text x="${leftX}" y="75" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="36" font-weight="900" fill="#ffd966" letter-spacing="2">DRIPQUESTS</text>
  <text x="${leftX}" y="100" text-anchor="middle" font-family="Courier New, monospace" font-size="14" font-weight="bold" fill="#a259ff">drippyrewards.com</text>

  <!-- Dog emoji placeholder -->
  <rect x="${leftX - 120}" y="130" width="240" height="240" rx="18" fill="rgba(162,89,255,0.1)" stroke="${tc}" stroke-width="3"/>
  <text x="${leftX}" y="240" text-anchor="middle" font-family="Arial, sans-serif" font-size="72">🐕</text>
  <text x="${leftX}" y="310" text-anchor="middle" font-family="Courier New, monospace" font-size="14" fill="rgba(246,233,196,0.4)">$DRIPPY</text>

  <!-- Tier -->
  <text x="${leftX}" y="420" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="32" font-weight="900" fill="${tc}">${esc(tier.label.toUpperCase())}</text>
  <text x="${leftX}" y="450" text-anchor="middle" font-family="Courier New, monospace" font-size="14" font-weight="bold" fill="#a259ff">${completed} of 12 quests cleared</text>

  <!-- Footer left -->
  <text x="${leftX}" y="${H-45}" text-anchor="middle" font-family="Courier New, monospace" font-size="11" font-weight="bold" fill="rgba(162,89,255,0.6)" letter-spacing="1">PAID EVERY 30 MIN · BURN FOR 2X FOREVER</text>

  <!-- ===== RIGHT SIDE: Stats ===== -->

  <!-- SOL earned -->
  <text x="${rightX}" y="90" text-anchor="middle" font-family="Courier New, monospace" font-size="16" font-weight="bold" fill="#a259ff" letter-spacing="3">TOTAL SOL EARNED</text>
  <text x="${rightX}" y="155" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="60" font-weight="900" fill="url(#solGlow)">${esc(earned)}</text>
  <text x="${rightX}" y="190" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="30" font-weight="900" fill="#ffd966">SOL</text>

  <!-- Stats 2x2 grid -->
  <text x="${rightX - 120}" y="260" text-anchor="middle" font-family="Courier New, monospace" font-size="12" font-weight="bold" fill="#a259ff" letter-spacing="1">DISTRIBUTIONS</text>
  <text x="${rightX - 120}" y="292" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="28" font-weight="900" fill="#fff5c0">${esc(distributions)}</text>

  <text x="${rightX + 120}" y="260" text-anchor="middle" font-family="Courier New, monospace" font-size="12" font-weight="bold" fill="#a259ff" letter-spacing="1">IN THE PACK</text>
  <text x="${rightX + 120}" y="292" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="28" font-weight="900" fill="#fff5c0">${esc(daysHolding)}</text>

  <text x="${rightX - 120}" y="350" text-anchor="middle" font-family="Courier New, monospace" font-size="12" font-weight="bold" fill="#a259ff" letter-spacing="1">BURNED</text>
  <text x="${rightX - 120}" y="382" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="28" font-weight="900" fill="#fff5c0">${esc(burned)}</text>

  <text x="${rightX + 120}" y="350" text-anchor="middle" font-family="Courier New, monospace" font-size="12" font-weight="bold" fill="#a259ff" letter-spacing="1">BURN WEIGHT</text>
  <text x="${rightX + 120}" y="382" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="28" font-weight="900" fill="#fff5c0">${esc(burnWeight)}</text>

  <!-- Separator -->
  <line x1="580" y1="420" x2="980" y2="420" stroke="rgba(245,197,66,0.2)" stroke-width="1"/>

  <!-- Tagline -->
  <text x="${rightX}" y="470" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="18" font-weight="900" fill="#ffd966">THE DRIP NEVER STOPS</text>
  <text x="${rightX}" y="500" text-anchor="middle" font-family="Courier New, monospace" font-size="13" fill="rgba(246,233,196,0.5)">5% tax · 100% to SOL · rewards every 30 min</text>

  <!-- CTA -->
  <rect x="${rightX - 110}" y="530" width="220" height="42" rx="8" fill="rgba(245,197,66,0.15)" stroke="${tc}" stroke-width="2"/>
  <text x="${rightX}" y="557" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="16" font-weight="900" fill="${tc}">JOIN THE PACK</text>
</svg>`;

  // Convert SVG to PNG for Twitter/Telegram compatibility
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
