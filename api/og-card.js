// /api/og-card.js
// Generates a dynamic OG image (PNG) for a wallet's DripQuests share card.
// Uses @vercel/og (Satori) on Edge Runtime to render JSX -> PNG.
//
// Usage: /api/og-card?wallet=XXXX
// Twitter/Telegram crawlers hit this URL via the og:image meta tag.

import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

// Tier thresholds — must match the client-side TIERS
const TIERS = [
  { min: 0,  label: 'Dripper',         color: '#f5c542' },
  { min: 1,  label: 'Bronze Dripper',  color: '#cd7f32' },
  { min: 4,  label: 'Silver Dripper',  color: '#c0c0c0' },
  { min: 8,  label: 'Gold Dripper',    color: '#ffd700' },
  { min: 11, label: 'Diamond Dripper', color: '#b9f2ff' },
];

// Quest definitions — same check logic as client
function countCompleted(d) {
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

function getTier(completed) {
  let tier = TIERS[0];
  for (const t of TIERS) {
    if (completed >= t.min) tier = t;
  }
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

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const wallet = searchParams.get('wallet');

  if (!wallet || wallet.length < 32) {
    return new Response('Missing or invalid wallet', { status: 400 });
  }

  // Fetch wallet data from our own API
  const origin = new URL(req.url).origin;
  let d;
  try {
    const r = await fetch(`${origin}/api/wallet?address=${wallet}`, { cache: 'no-store' });
    d = await r.json();
    if (!d || d.error) throw new Error(d?.error || 'no data');
  } catch (e) {
    return new Response('Could not fetch wallet data: ' + e.message, { status: 500 });
  }

  const completed = countCompleted(d);
  const tier = getTier(completed);
  const earned = fmtSol(d.totalReceivedSol);
  const distributions = (d.distributionCount || 0).toLocaleString();
  const daysHolding = d.daysHolding != null
    ? (d.daysHolding === 0 ? 'TODAY' : d.daysHolding === 1 ? '1 DAY' : d.daysHolding + ' DAYS')
    : 'HOLDER';
  const burned = fmtTokens(d.burner?.tokensBurned || 0);
  const burnWeight = (d.burner?.burnWeightSharePct || 0).toFixed(2) + '%';
  const shortWallet = wallet.slice(0, 4) + '...' + wallet.slice(-4);

  // Quest tier images hosted on the site
  const questImages = [
    'quest-join-pack', 'quest-diamond-starter', 'quest-whale',
    'quest-first-drip', 'quest-veteran', 'quest-legend',
    'quest-initiate-burn', 'quest-burn-boss', 'quest-inferno',
    'quest-earned-01', 'quest-earned-05', 'quest-earned-1'
  ];
  // Pick the highest unlocked quest image for the featured art
  const questChecks = [
    (d.currentHoldings?.uiAmount || 0) > 0,
    (d.currentHoldings?.uiAmount || 0) >= 1_000_000,
    (d.currentHoldings?.uiAmount || 0) >= 10_000_000,
    (d.distributionCount || 0) >= 1,
    (d.distributionCount || 0) >= 50,
    (d.distributionCount || 0) >= 100,
    (d.burner?.burnEvents || 0) >= 1,
    (d.burner?.tokensBurned || 0) >= 1_000_000,
    (d.burner?.burnEvents || 0) >= 5,
    (d.totalReceivedSol || 0) >= 0.1,
    (d.totalReceivedSol || 0) >= 0.5,
    (d.totalReceivedSol || 0) >= 1,
  ];
  let featuredImg = `${origin}/assets/quest-join-pack.png`;
  for (let i = questChecks.length - 1; i >= 0; i--) {
    if (questChecks[i]) {
      featuredImg = `${origin}/assets/${questImages[i]}.png`;
      break;
    }
  }

  return new ImageResponse(
    (
      <div style={{
        width: '900px', height: '1100px',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        background: 'linear-gradient(135deg, #1a0a2e, #0a0610, #2a1248)',
        fontFamily: 'sans-serif',
        position: 'relative',
        padding: '0',
      }}>
        {/* Outer border */}
        <div style={{
          position: 'absolute', top: '20px', left: '20px', right: '20px', bottom: '20px',
          border: `5px solid ${tier.color}`,
          display: 'flex',
        }} />
        {/* Inner border */}
        <div style={{
          position: 'absolute', top: '36px', left: '36px', right: '36px', bottom: '36px',
          border: '2px solid #f5c542',
          display: 'flex',
        }} />

        {/* Header */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          marginTop: '60px',
        }}>
          <div style={{
            fontSize: '56px', fontWeight: 'bold', color: '#ffd966',
            letterSpacing: '0.04em',
          }}>DRIPQUESTS</div>
          <div style={{
            fontSize: '20px', fontWeight: 'bold', color: '#a259ff',
            marginTop: '4px',
          }}>drippyrewards.com</div>
        </div>

        {/* Featured quest image */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginTop: '30px',
          width: '340px', height: '340px',
          borderRadius: '24px',
          border: `4px solid ${tier.color}`,
          overflow: 'hidden',
          boxShadow: `0 0 40px ${tier.color}44`,
        }}>
          <img src={featuredImg} width="340" height="340" style={{ objectFit: 'cover' }} />
        </div>

        {/* Tier label */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          marginTop: '20px',
        }}>
          <div style={{
            fontSize: '44px', fontWeight: 'bold', color: tier.color,
            textShadow: `0 0 24px ${tier.color}88`,
          }}>{tier.label.toUpperCase()}</div>
          <div style={{
            fontSize: '18px', fontWeight: 'bold', color: '#a259ff',
            marginTop: '4px',
          }}>{completed} of 12 quests cleared</div>
        </div>

        {/* Total SOL earned */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          marginTop: '40px',
        }}>
          <div style={{
            fontSize: '18px', fontWeight: 'bold', color: '#a259ff',
            letterSpacing: '0.1em',
          }}>TOTAL SOL EARNED</div>
          <div style={{
            fontSize: '68px', fontWeight: 'bold', color: '#ffd966',
            textShadow: '0 0 24px rgba(245,197,66,.5)',
            marginTop: '4px',
          }}>{earned} SOL</div>
        </div>

        {/* Stats grid 2x2 */}
        <div style={{
          display: 'flex', flexWrap: 'wrap',
          width: '700px', marginTop: '30px',
          justifyContent: 'center',
        }}>
          {[
            { label: 'DISTRIBUTIONS', value: distributions },
            { label: 'IN THE PACK', value: daysHolding },
            { label: 'BURNED', value: burned },
            { label: 'BURN WEIGHT', value: burnWeight },
          ].map((s) => (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              width: '350px', marginBottom: '16px',
            }}>
              <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#a259ff', letterSpacing: '0.08em' }}>{s.label}</div>
              <div style={{ fontSize: '30px', fontWeight: 'bold', color: '#fff5c0', marginTop: '4px' }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          position: 'absolute', bottom: '55px', left: '0', right: '0',
        }}>
          <div style={{
            fontSize: '16px', fontWeight: 'bold', color: '#a259ff',
            letterSpacing: '0.06em',
          }}>PAID EVERY 30 MINUTES · BURN FOR 2X FOREVER</div>
        </div>
      </div>
    ),
    {
      width: 900,
      height: 1100,
    }
  );
}
