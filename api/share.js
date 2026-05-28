// /api/share.js
// Serves a lightweight HTML page with dynamic OG meta tags for Twitter/Telegram.
// When a crawler hits /api/share?wallet=XXXX, it sees og:image pointing to /api/og-card?wallet=XXXX.
// When a human visits, it redirects to the main site with the wallet pre-filled.

module.exports = async (req, res) => {
  const wallet = req.query.wallet || '';
  if (!wallet || wallet.length < 32) {
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  const origin = `https://${req.headers.host || 'drippyrewards.com'}`;
  const ogImage = `${origin}/api/og-card?wallet=${encodeURIComponent(wallet)}`;
  const pageUrl = `${origin}/api/share?wallet=${encodeURIComponent(wallet)}`;
  const siteUrl = `${origin}/?wallet=${encodeURIComponent(wallet)}`;
  const shortWallet = wallet.slice(0, 4) + '...' + wallet.slice(-4);

  // Fetch wallet data for the description
  let earned = '0';
  let tierLabel = 'Dripper';
  try {
    const r = await fetch(`${origin}/api/wallet?address=${wallet}`, { cache: 'no-store' });
    const d = await r.json();
    if (d && !d.error) {
      const sol = Number(d.totalReceivedSol || 0);
      earned = sol < 1 ? sol.toFixed(4) : sol.toFixed(3);
      // Compute tier
      const completed = countQuests(d);
      if (completed >= 11) tierLabel = 'Diamond Dripper';
      else if (completed >= 8) tierLabel = 'Gold Dripper';
      else if (completed >= 4) tierLabel = 'Silver Dripper';
      else if (completed >= 1) tierLabel = 'Bronze Dripper';
    }
  } catch (e) {
    // fall through with defaults
  }

  const title = `${tierLabel} | ${shortWallet}`;
  const description = `Earned ${earned} SOL just by holding $DRIPPY. Every 30 min the pack eats. Burn for 2x forever.`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
  res.status(200).send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${title} — DripQuests</title>
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:image" content="${ogImage}" />
  <meta property="og:image:width" content="900" />
  <meta property="og:image:height" content="1100" />
  <meta property="og:url" content="${pageUrl}" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${ogImage}" />
  <meta http-equiv="refresh" content="0;url=${siteUrl}" />
</head>
<body>
  <p>Redirecting to <a href="${siteUrl}">drippyrewards.com</a>...</p>
</body>
</html>`);
};

function countQuests(d) {
  let c = 0;
  const h = d.currentHoldings?.uiAmount || 0;
  const dist = d.distributionCount || 0;
  const sol = d.totalReceivedSol || 0;
  const burns = d.burner?.burnEvents || 0;
  const burned = d.burner?.tokensBurned || 0;
  if (h > 0) c++;
  if (h >= 1_000_000) c++;
  if (h >= 10_000_000) c++;
  if (dist >= 1) c++;
  if (dist >= 50) c++;
  if (dist >= 100) c++;
  if (burns >= 1) c++;
  if (burned >= 1_000_000) c++;
  if (burns >= 5) c++;
  if (sol >= 0.1) c++;
  if (sol >= 0.5) c++;
  if (sol >= 1) c++;
  return c;
}
