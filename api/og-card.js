import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

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

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const wallet = searchParams.get('wallet');

  if (!wallet || wallet.length < 32) {
    return new Response('Missing or invalid wallet', { status: 400 });
  }

  const origin = new URL(req.url).origin;
  let d;
  try {
    const r = await fetch(`${origin}/api/wallet?address=${wallet}`, { cache: 'no-store' });
    d = await r.json();
    if (!d || d.error) throw new Error(d?.error || 'no data');
  } catch (e) {
    return new Response('Could not fetch wallet data: ' + e.message, { status: 500 });
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
  const tc = tier.color;

  return new ImageResponse(
    (
      <div style={{
        width: '1200px', height: '630px',
        display: 'flex',
        background: 'linear-gradient(135deg, #1a0a2e, #0a0610, #2a1248)',
        fontFamily: 'sans-serif',
        position: 'relative',
      }}>
        {/* Outer border */}
        <div style={{
          position: 'absolute', top: '12px', left: '12px', right: '12px', bottom: '12px',
          border: `4px solid ${tc}`, borderRadius: '8px',
          display: 'flex',
        }} />
        <div style={{
          position: 'absolute', top: '22px', left: '22px', right: '22px', bottom: '22px',
          border: '1.5px solid #f5c542', borderRadius: '4px',
          display: 'flex',
        }} />

        {/* LEFT SIDE */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          width: '500px', padding: '50px 40px',
        }}>
          <div style={{ fontSize: '38px', fontWeight: 900, color: '#ffd966', letterSpacing: '2px' }}>
            DRIPQUESTS
          </div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: '#a259ff', marginTop: '4px' }}>
            drippyrewards.com
          </div>

          {/* Dog placeholder */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '200px', height: '200px',
            marginTop: '24px',
            borderRadius: '18px',
            border: `3px solid ${tc}`,
            background: 'rgba(162,89,255,0.1)',
          }}>
            <div style={{ fontSize: '80px' }}>🐕</div>
          </div>

          <div style={{
            fontSize: '30px', fontWeight: 900, color: tc, marginTop: '20px',
          }}>
            {tier.label.toUpperCase()}
          </div>
          <div style={{
            fontSize: '14px', fontWeight: 700, color: '#a259ff', marginTop: '4px',
          }}>
            {completed} of 12 quests cleared
          </div>
        </div>

        {/* Divider */}
        <div style={{
          position: 'absolute', left: '500px', top: '50px', bottom: '50px',
          width: '1px', background: 'rgba(162,89,255,0.25)',
          display: 'flex',
        }} />

        {/* RIGHT SIDE */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          width: '700px', padding: '45px 40px',
        }}>
          <div style={{
            fontSize: '16px', fontWeight: 700, color: '#a259ff', letterSpacing: '3px',
          }}>
            TOTAL SOL EARNED
          </div>
          <div style={{
            fontSize: '64px', fontWeight: 900, color: '#ffd966',
            marginTop: '8px',
          }}>
            {earned} SOL
          </div>

          {/* Stats grid */}
          <div style={{
            display: 'flex', flexWrap: 'wrap', justifyContent: 'center',
            width: '100%', marginTop: '30px', gap: '10px',
          }}>
            {[
              { label: 'DISTRIBUTIONS', value: distributions },
              { label: 'IN THE PACK', value: daysHolding },
              { label: 'BURNED', value: burned },
              { label: 'BURN WEIGHT', value: burnWeight },
            ].map((s, i) => (
              <div key={i} style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                width: '260px', marginBottom: '8px',
              }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: '#a259ff', letterSpacing: '1px' }}>
                  {s.label}
                </div>
                <div style={{ fontSize: '28px', fontWeight: 900, color: '#fff5c0', marginTop: '4px' }}>
                  {s.value}
                </div>
              </div>
            ))}
          </div>

          {/* Tagline */}
          <div style={{
            fontSize: '18px', fontWeight: 900, color: '#ffd966', marginTop: '24px',
          }}>
            THE DRIP NEVER STOPS
          </div>
          <div style={{
            fontSize: '13px', color: 'rgba(246,233,196,0.5)', marginTop: '6px',
          }}>
            5% tax · 100% to SOL · rewards every 30 min
          </div>

          {/* CTA button */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginTop: '20px',
            padding: '10px 40px',
            borderRadius: '8px',
            border: `2px solid ${tc}`,
            background: 'rgba(245,197,66,0.15)',
          }}>
            <div style={{ fontSize: '16px', fontWeight: 900, color: tc }}>
              JOIN THE PACK
            </div>
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
