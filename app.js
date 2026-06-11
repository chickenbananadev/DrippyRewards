/* DRIPPY v2 app.js
   One consolidated stats fetch, working burn data, fixed DripQuests,
   wallet connect with mobile deep links and Wallet Standard detection. */

const DRIPPY = {
  tokenAddress: 'EPRZgmvU4aTQ4UaC4bywgNvxJ5YmhuKqM1bx3gw4DRPY',
  pairAddress: '3ohceht4kcjkysrtn4mysd2zwgkwz1cinualvtcchqmz',
  burnAddress: 'N1LCBQJnjLP3ppv7npzL5Btzf5Yp3hBMr6s8GmVfEyV',
  intervalMs: 30 * 60 * 1000,
  // Fallback anchor if stats haven't loaded yet; replaced by live lastDistributionAt
  anchorUTC: Date.UTC(2026, 4, 16, 1, 49, 37)
};
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/* ---------------- helpers ---------------- */
const $ = (id) => document.getElementById(id);
function fmtUsd(n){
  if(n == null || isNaN(n)) return '—';
  n = Number(n);
  if(n >= 1e9) return '$' + (n/1e9).toFixed(2) + 'B';
  if(n >= 1e6) return '$' + (n/1e6).toFixed(2) + 'M';
  if(n >= 1e3) return '$' + (n/1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(2);
}
function fmtPrice(n){
  if(n == null || isNaN(n)) return '—';
  n = Number(n);
  if(n >= 1) return '$' + n.toFixed(4);
  if(n >= 0.001) return '$' + n.toFixed(6);
  return '$' + n.toFixed(9).replace(/0+$/,'');
}
function fmtSol(n){
  if(n == null || isNaN(n)) return '0 SOL';
  n = Number(n);
  if(n === 0) return '0 SOL';
  if(n < 0.001) return n.toFixed(6) + ' SOL';
  if(n < 1) return n.toFixed(4) + ' SOL';
  return n.toLocaleString('en-US', { maximumFractionDigits: 3 }) + ' SOL';
}
function fmtTokens(n){
  if(n == null || isNaN(n)) return '0';
  n = Number(n);
  if(n >= 1e6) return (n/1e6).toFixed(2) + 'M';
  if(n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return Math.round(n).toLocaleString();
}
function fmtTokensFull(n){
  if(n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function timeAgo(iso){
  if(!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if(m < 1) return 'just now';
  if(m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if(h < 24) return h + 'h ago';
  return Math.floor(h/24) + 'd ago';
}
function shortAddr(a){
  if(!a || a.length < 12) return a || '';
  return a.slice(0,4) + '...' + a.slice(-4);
}
function setCell(key, text, cls){
  const cell = document.querySelector('[data-key="' + key + '"]');
  if(!cell) return;
  const v = cell.querySelector('.v');
  const changed = v.textContent !== text && v.textContent !== '—';
  v.textContent = text;
  v.classList.remove('up','down');
  if(cls) v.classList.add(cls);
  cell.classList.remove('loading');
  if(changed){
    v.classList.remove('flash');
    void v.offsetWidth;
    v.classList.add('flash');
  }
}

/* ---------------- countdown + drip meter ---------------- */
let _anchor = DRIPPY.anchorUTC;
function tickCountdown(){
  const now = Date.now();
  let remaining = DRIPPY.intervalMs - ((now - _anchor) % DRIPPY.intervalMs);
  if(remaining < 0) remaining += DRIPPY.intervalMs;
  const m = Math.floor(remaining / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  const el = $('cdTime');
  if(el) el.textContent = String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  const fill = $('dropFill');
  if(fill){
    const pct = 100 - (remaining / DRIPPY.intervalMs) * 100;
    fill.style.height = pct.toFixed(1) + '%';
  }
}
setInterval(tickCountdown, 1000);
tickCountdown();

/* ---------------- payout celebration: gold rain when the pack gets paid ---------------- */
let _lastDistAt = null;
function celebratePayout(amountSol){
  if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const meter = document.querySelector('.dripmeter');
  if(meter){ meter.classList.add('splash'); setTimeout(() => meter.classList.remove('splash'), 950); }
  for(let i = 0; i < 44; i++){
    const dr = document.createElement('span');
    dr.className = 'gold-rain';
    dr.style.left = (Math.random() * 100).toFixed(1) + 'vw';
    dr.style.animationDuration = (1.4 + Math.random() * 1.7).toFixed(2) + 's';
    dr.style.animationDelay = (Math.random() * 0.9).toFixed(2) + 's';
    document.body.appendChild(dr);
    setTimeout(() => dr.remove(), 4300);
  }
  const t = document.createElement('div');
  t.className = 'payout-toast';
  t.textContent = '💸 The pack just got paid' + (amountSol ? ': +' + fmtSol(amountSol) : '') + '!';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

/* ---------------- count-up: make the big numbers land ---------------- */
function cuCell(key, num, fmt){
  const cell = document.querySelector('[data-key="' + key + '"]');
  if(!cell || isNaN(num)) return;
  const v = cell.querySelector('.v');
  if(!v || v.dataset.counted) return;
  v.dataset.counted = '1';
  if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const t0 = performance.now(), dur = 1100;
  (function step(t){
    const k = Math.min(1, (t - t0) / dur);
    const ease = 1 - Math.pow(1 - k, 3);
    try{ v.textContent = fmt(num * ease); }catch(_){ return; }
    if(k < 1) requestAnimationFrame(step);
  })(t0);
}

/* ---------------- consolidated stats ---------------- */
async function loadStats(){
  try{
    const r = await fetch('/api/stats', { cache: 'no-store' });
    if(!r.ok) throw new Error('stats ' + r.status);
    const d = await r.json();

    // Ticker
    if(d.market){
      setCell('price', fmtPrice(d.market.priceUsd));
      if(d.market.change24h != null){
        const ch = Number(d.market.change24h);
        setCell('change', (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%', ch >= 0 ? 'up' : 'down');
        window._mood = ch >= 0 ? 'bull' : 'bear';
      }
      setCell('mcap', fmtUsd(d.market.marketCap));
      setCell('vol', fmtUsd(d.market.volume24h));
      setCell('liq', fmtUsd(d.market.liquidityUsd));
    }
    if(d.supply) setCell('supply', fmtTokens(d.supply.circulating));
    if(d.holders && d.holders.count != null){ setCell('holders', d.holders.count.toLocaleString()); cuCell('holders', Number(d.holders.count), v => Math.round(v).toLocaleString()); }
    if(d.burns && d.burns.tokensBurned){ setCell('burned', fmtTokens(d.burns.tokensBurned), 'purple'); cuCell('burned', Number(d.burns.tokensBurned), fmtTokens); }
    if(d.burns && d.burns.supplyBurnedPct != null) setCell('burnpct', Number(d.burns.supplyBurnedPct).toFixed(2) + '%', 'purple');
    if(d.distribution && d.distribution.totalDistributedSol != null){
      setCell('rewards', fmtSol(d.distribution.totalDistributedSol).replace(' SOL','') + ' SOL', 'gold');
      cuCell('rewards', Number(d.distribution.totalDistributedSol), v => fmtSol(v).replace(' SOL','') + ' SOL');
    }

    // Distribution card
    const dist = d.distribution;
    if(dist){
      if(dist.lastDistributionAt){
        _anchor = new Date(dist.lastDistributionAt).getTime(); // sync the countdown
        const lt = $('distLastTime'); if(lt) lt.textContent = timeAgo(dist.lastDistributionAt);
        if(_lastDistAt && dist.lastDistributionAt !== _lastDistAt) celebratePayout(dist.lastAmountSol);
        _lastDistAt = dist.lastDistributionAt;
      }
      const la = $('distLastAmount'); if(la) la.textContent = fmtSol(dist.lastAmountSol);
      const tt = $('distTotal'); if(tt) tt.textContent = fmtSol(dist.totalDistributedSol);
      const rc = $('distRuns'); if(rc) rc.textContent = (dist.successfulDistributions || 0).toLocaleString();
      const st = $('distStatus'); if(st) st.textContent = (dist.status || 'unknown').toUpperCase();
      const rp = $('distRecipients'); if(rp) rp.textContent = (dist.lastRunRecipients || 0).toLocaleString();
    }
    if(d.burns){
      const be = $('bsBurnEvents'); if(be) be.textContent = (d.burns.burnEvents || 0).toLocaleString();
      const tb = $('bsTokensBurned'); if(tb) tb.textContent = fmtTokensFull(d.burns.tokensBurned);
      const bp = $('bsBurnPct'); if(bp) bp.textContent = d.burns.supplyBurnedPct != null ? Number(d.burns.supplyBurnedPct).toFixed(2) + '%' : '—';
    }

    // Proof of drip feed
    const feed = $('dripFeed');
    if(feed){
      const drips = d.recentDrips || [];
      if(drips.length === 0){
        feed.innerHTML = '<div class="feed-empty">No distributions in the recent window. The next drip is on the timer above.</div>';
      } else {
        feed.innerHTML = '';
        drips.forEach(p => {
          const row = document.createElement('a');
          row.className = 'feed-row';
          row.href = 'https://solscan.io/tx/' + p.txSig;
          row.target = '_blank';
          row.rel = 'noopener';
          row.innerHTML =
            '<span>💧</span>' +
            '<span><span class="amt">' + fmtSol(p.amountSol) + '</span>' +
            (p.recipients ? ' <span class="meta">to ' + p.recipients + ' wallet' + (p.recipients === 1 ? '' : 's') + '</span>' : '') + '</span>' +
            '<span class="ago">' + timeAgo(p.timestamp) + '</span>' +
            '<span class="lnk">tx ↗</span>';
          feed.appendChild(row);
        });
      }
    }
  }catch(e){
    console.warn('[stats]', e.message);
  }
}
loadStats();
setInterval(loadStats, 45000);

/* ---------------- Drippy Run: top global scores on the promo card ---------------- */
(async function loadGameTop(){
  try{
    const r = await fetch('/api/leaderboard?board=game', { cache: 'no-store' });
    if(!r.ok) return;
    const d = await r.json();
    if(!d || !Array.isArray(d.scores) || !d.scores.length) return;
    const el = $('gameTop');
    if(!el) return;
    el.innerHTML = '🏁 Top runs: ' + d.scores.slice(0,3).map((e,i) =>
      '<b>' + (i+1) + '.</b> ' + String(e.n).replace(/[<>&]/g,'') + (e.beat ? ' 👑' : '') + ' <span style="color:var(--gold-bright,#f5c542)">' + Number(e.s).toLocaleString() + '</span>'
    ).join(' &nbsp;·&nbsp; ');
    el.style.display = '';
  }catch(_){}
})();

/* ---------------- Jupiter swap widget ---------------- */
let _jupTries = 0;
function initJupiter(){
  const fallback = $('swapFallback');
  if(!$('jupiter-terminal')) return;
  if(!window.Jupiter || typeof window.Jupiter.init !== 'function'){
    if(++_jupTries < 60){ setTimeout(initJupiter, 250); }
    else if(fallback){ fallback.classList.add('show'); }
    return;
  }
  try{
    window.Jupiter.init({
      displayMode: 'integrated',
      integratedTargetId: 'jupiter-terminal',
      formProps: {
        initialInputMint: 'So11111111111111111111111111111111111111112',
        initialOutputMint: DRIPPY.tokenAddress,
        swapMode: 'ExactIn'
      },
      defaultExplorer: 'Solscan',
      branding: { logoUri: '', name: 'DRIPPY' },
      containerStyles: { background: 'transparent' }
    });
    if(fallback) fallback.classList.remove('show');
  }catch(e){
    console.warn('[jupiter]', e);
    if(fallback) fallback.classList.add('show');
  }
}
if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', initJupiter);
} else { initJupiter(); }

/* ---------------- trade tabs + lazy chart ---------------- */
(function(){
  const tabs = document.querySelectorAll('.trade-tab');
  const panes = document.querySelectorAll('.trade-pane');
  tabs.forEach(tab => tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    panes.forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const pane = $(tab.dataset.pane);
    pane.classList.add('active');
    // Lazy load the chart iframe only when first opened
    const frame = pane.querySelector('iframe[data-src]');
    if(frame && !frame.src){ frame.src = frame.dataset.src; }
  }));
})();

/* ---------------- copy buttons ---------------- */
function copyAddr(srcId, btnId){
  const txt = $(srcId).innerText.trim();
  const btn = $(btnId);
  if(!btn.dataset.orig) btn.dataset.orig = btn.textContent;
  const done = () => {
    btn.textContent = 'copied 🐾';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = btn.dataset.orig; btn.classList.remove('copied'); }, 1800);
  };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(done).catch(() => fallbackCopy(txt, done));
  } else { fallbackCopy(txt, done); }
}
function fallbackCopy(txt, done){
  const ta = document.createElement('textarea');
  ta.value = txt; document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); done(); }catch(_){}
  document.body.removeChild(ta);
}
window.copyAddr = copyAddr;

/* ---------------- DripQuests (fixed: 12 quests, correct counts) ---------------- */
const QUESTS = [
  { id:'join',          img:'assets/quest-join-pack.png',       name:'Join the Pack',     desc:'Hold any amount of $DRIPPY',  check:d => (d.currentHoldings?.uiAmount || 0) > 0 },
  { id:'diamond_start', img:'assets/quest-diamond-starter.png', name:'Diamond Starter',   desc:'Hold 1M+ $DRIPPY',            check:d => (d.currentHoldings?.uiAmount || 0) >= 1e6 },
  { id:'whale',         img:'assets/quest-whale.png',           name:'Whale Status',      desc:'Hold 10M+ $DRIPPY',           check:d => (d.currentHoldings?.uiAmount || 0) >= 1e7 },
  { id:'first_drip',    img:'assets/quest-first-drip.png',      name:'First Drip',        desc:'Receive your first payout',   check:d => (d.distributionCount || 0) >= 1 },
  { id:'veteran',       img:'assets/quest-veteran.png',         name:'Drip Veteran',      desc:'Receive 50+ payouts',         check:d => (d.distributionCount || 0) >= 50 },
  { id:'legend',        img:'assets/quest-legend.png',          name:'Drip Legend',       desc:'Receive 100+ payouts',        check:d => (d.distributionCount || 0) >= 100 },
  { id:'init_burn',     img:'assets/quest-initiate-burn.png',   name:'Initiate the Burn', desc:'Burn any $DRIPPY',            check:d => (d.burner?.burnEvents || 0) >= 1 },
  { id:'burn_boss',     img:'assets/quest-burn-boss.png',       name:'Burn Boss',         desc:'Burn 1M+ $DRIPPY total',      check:d => (d.burner?.tokensBurned || 0) >= 1e6 },
  { id:'inferno',       img:'assets/quest-inferno.png',         name:'Inferno',           desc:'5+ separate burn events',     check:d => (d.burner?.burnEvents || 0) >= 5 },
  { id:'earned_pt1',    img:'assets/quest-earned-01.png',       name:'First Tenth',       desc:'Earn 0.1+ total SOL',         check:d => (d.totalReceivedSol || 0) >= 0.1 },
  { id:'earned_pt5',    img:'assets/quest-earned-05.png',       name:'Half a SOL',        desc:'Earn 0.5+ total SOL',         check:d => (d.totalReceivedSol || 0) >= 0.5 },
  { id:'earned_1',      img:'assets/quest-earned-1.png',        name:'Full SOL Club',     desc:'Earn 1+ total SOL',           check:d => (d.totalReceivedSol || 0) >= 1 }
];
const TIERS = [
  { name:'No Rank',         min:0,  cls:'',             label:'Check your wallet to rank up' },
  { name:'Bronze Dripper',  min:1,  cls:'tier-bronze',  label:'Bronze Dripper' },
  { name:'Silver Dripper',  min:4,  cls:'tier-silver',  label:'Silver Dripper' },
  { name:'Gold Dripper',    min:8,  cls:'tier-gold',    label:'Gold Dripper' },
  { name:'Diamond Dripper', min:11, cls:'tier-diamond', label:'Diamond Dripper' }
];
function computeTier(n){ let t = TIERS[0]; for(const x of TIERS){ if(n >= x.min) t = x; } return t; }
function nextTier(n){
  for(let i = 0; i < TIERS.length; i++){ if(n < TIERS[i].min) return TIERS[i]; }
  return null;
}
function renderQuestGrid(d){
  const grid = $('dqGrid');
  if(!grid) return;
  grid.innerHTML = '';
  QUESTS.forEach(q => {
    const unlocked = d ? !!q.check(d) : false;
    const tile = document.createElement('div');
    tile.className = 'dq-tile ' + (unlocked ? 'unlocked' : 'locked');
    const art = unlocked
      ? '<img src="' + q.img + '" alt="' + q.name + '" loading="lazy">'
      : '<div class="dq-mystery"><span class="lock">🔒</span>???</div>';
    tile.innerHTML =
      '<div class="dq-art">' + art + '</div>' +
      '<div class="dq-name">' + q.name + '</div>' +
      '<div class="dq-desc">' + q.desc + '</div>';
    grid.appendChild(tile);
  });
}
function updateDripQuests(d){
  if(!d) return;
  const completed = QUESTS.filter(q => q.check(d)).length;
  const tier = computeTier(completed);
  const next = nextTier(completed);

  const card = $('dqRankCard');
  if(card){
    card.classList.remove('tier-bronze','tier-silver','tier-gold','tier-diamond');
    if(tier.cls) card.classList.add(tier.cls);
  }
  const nameEl = $('dqRankName');
  if(nameEl) nameEl.textContent = tier.label;

  // Featured art: highest unlocked quest
  let featured = null;
  QUESTS.forEach(q => { if(q.check(d)) featured = q; });
  const artImg = document.querySelector('#dqRankArt img');
  if(artImg && featured){ artImg.src = featured.img; artImg.alt = featured.name; }

  const fill = $('dqProgressFill');
  if(fill) fill.style.width = ((completed / QUESTS.length) * 100).toFixed(0) + '%';
  const txt = $('dqProgressText');
  if(txt){
    txt.textContent = next
      ? completed + ' / ' + QUESTS.length + ' quests · ' + (next.min - completed) + ' more to ' + next.name
      : completed + ' / ' + QUESTS.length + ' quests · Max rank, Diamond Dripper';
  }
  renderQuestGrid(d);

  // Share buttons through /api/share so X and Telegram render the OG card
  const share = $('dqShare');
  if(share){
    share.classList.add('show');
    const url = location.origin + '/api/share?wallet=' + encodeURIComponent(d.wallet);
    const text = 'I am a ' + tier.name + ' in the $DRIPPY pack. ' + fmtSol(d.totalReceivedSol) + ' dripped so far.';
    $('dqShareX').href = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(url);
    $('dqShareTg').href = 'https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(text);
  }
}
renderQuestGrid(null);

/* ---------------- wallet checker ---------------- */
let currentWallet = null;
(function(){
  const input = $('wcInput');
  const button = $('wcButton');
  const errorEl = $('wcError');
  const results = $('wcResults');
  if(!input) return;

  async function checkWallet(){
    const addr = input.value.trim();
    errorEl.textContent = '';
    if(!addr){ errorEl.textContent = 'Paste a wallet address first.'; return; }
    if(!SOL_RE.test(addr)){ errorEl.textContent = 'That does not look like a valid Solana address.'; return; }

    button.disabled = true;
    button.textContent = 'Sniffing...';
    try{
      const r = await fetch('/api/wallet?address=' + encodeURIComponent(addr), { cache:'no-store' });
      const d = await r.json();
      if(d.error){ errorEl.textContent = d.error; results.classList.remove('show'); return; }
      if(d.found === false){
        errorEl.textContent = 'No drips found for this wallet yet. Hold $DRIPPY to start earning.';
        results.classList.remove('show');
        return;
      }

      currentWallet = d.wallet;
      $('wcTotalSol').textContent = fmtSol(d.totalReceivedSol);
      $('wcWalletShort').textContent = shortAddr(d.wallet);
      $('wcDistCount').textContent = (d.distributionCount || 0).toLocaleString();
      $('wcHoldings').textContent = fmtTokens(d.currentHoldings?.uiAmount);
      $('wcBurnedMain').textContent = (d.burner && d.burner.tokensBurned) ? fmtTokens(d.burner.tokensBurned) : '0';
      if(d.lastDistribution){
        $('wcLastAmount').textContent = fmtSol(d.lastDistribution.amountSol);
        $('wcLastTime').textContent = timeAgo(d.lastDistribution.timestamp);
      } else {
        $('wcLastAmount').textContent = '—';
        $('wcLastTime').textContent = 'no payouts yet';
      }

      const burnCard = $('wcBurnCard');
      if(d.burner && d.burner.burnEvents > 0){
        burnCard.classList.remove('hidden');
        $('wcTokensBurned').textContent = fmtTokens(d.burner.tokensBurned);
        $('wcBurnEvents').textContent = (d.burner.burnEvents || 0).toLocaleString();
        $('wcBurnShare').textContent = (d.burner.burnWeightSharePct || 0).toFixed(2) + '%';
      } else {
        burnCard.classList.add('hidden');
      }

      const history = $('wcHistory');
      history.innerHTML = '';
      const recents = d.recentDistributions || [];
      if(recents.length === 0){
        history.innerHTML = '<div class="feed-empty">No recent payouts</div>';
      } else {
        recents.forEach(p => {
          const row = document.createElement('a');
          row.href = 'https://solscan.io/tx/' + p.txSig;
          row.target = '_blank'; row.rel = 'noopener';
          row.innerHTML = '<span class="amt">' + fmtSol(p.amountSol) + '</span>' +
            '<span class="ago">' + timeAgo(p.timestamp) + '</span>' +
            '<span class="lnk">tx ↗</span>';
          history.appendChild(row);
        });
      }

      results.classList.add('show');
      window._dripWalletData = d;
      updateDripQuests(d);
      loadUsernameUI(d.wallet);
      loadLeaderboard(undefined, d.wallet, d.burnRank, d.earnRank);
    }catch(e){
      console.error('[wallet]', e);
      errorEl.textContent = 'Something went wrong. Try again in a moment.';
      results.classList.remove('show');
    }finally{
      button.disabled = false;
      button.textContent = 'Check Drips';
    }
  }

  button.addEventListener('click', checkWallet);
  input.addEventListener('keydown', e => { if(e.key === 'Enter') checkWallet(); });

  // Prefill from share links: /?wallet=XXXX
  const pre = new URLSearchParams(location.search).get('wallet');
  if(pre && SOL_RE.test(pre)){
    input.value = pre;
    checkWallet();
    setTimeout(() => $('checker')?.scrollIntoView({ behavior:'smooth' }), 400);
  }
})();

/* ---------------- wallet provider (connect + sign) ---------------- */
// Wallet Standard collector: catches wallets that register via the standard
// instead of injecting a known global.
const _stdWallets = [];
try{
  window.addEventListener('wallet-standard:register-wallet', (e) => {
    try{ e.detail({ register: (...ws) => ws.forEach(w => _stdWallets.push(w)) }); }catch(_){}
  });
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {
    detail: { register: (...ws) => ws.forEach(w => _stdWallets.push(w)) }
  }));
}catch(_){}

function getProvider(){
  if(window.solana && window.solana.isPhantom) return window.solana;
  if(window.solflare && window.solflare.isSolflare) return window.solflare;
  if(window.backpack && window.backpack.isBackpack) return window.backpack;
  if(window.jupiter && window.jupiter.signMessage) return window.jupiter;
  if(window.coinbaseSolana) return window.coinbaseSolana;
  if(window.solana && window.solana.signMessage) return window.solana;
  // Wallet Standard wallets that expose the solana signMessage feature
  for(const w of _stdWallets){
    const f = w && w.features;
    if(f && (f['solana:signMessage'] || f['standard:connect'])) return makeStdAdapter(w);
  }
  return null;
}
// Minimal adapter so Wallet Standard wallets look like injected providers
function makeStdAdapter(w){
  return {
    isWalletStandard: true,
    publicKey: null,
    async connect(){
      const res = await w.features['standard:connect'].connect();
      const acct = res.accounts && res.accounts[0];
      this._account = acct;
      this.publicKey = { toString: () => acct.address };
      return { publicKey: this.publicKey };
    },
    async signMessage(bytes){
      const out = await w.features['solana:signMessage'].signMessage({ account: this._account, message: bytes });
      const first = Array.isArray(out) ? out[0] : out;
      return { signature: first.signature };
    }
  };
}

function bs58encode(bytes){
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const arr = Array.from(bytes);
  let digits = [0];
  for(let i = 0; i < arr.length; i++){
    let carry = arr[i];
    for(let j = 0; j < digits.length; j++){
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while(carry > 0){ digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  for(let k = 0; k < arr.length && arr[k] === 0; k++) digits.push(0);
  return digits.reverse().map(d => ALPHABET[d]).join('');
}

/* ---------------- username claim ---------------- */
async function loadUsernameUI(wallet){
  const box = $('unameBox');
  if(!box) return;
  const input = $('unameInput');
  const btn = $('unameBtn');
  const display = $('unameCurrent');
  const desc = $('unameDesc');
  setUnameMsg('');
  input.value = '';
  display.textContent = '';
  try{
    const r = await fetch('/api/username?wallet=' + encodeURIComponent(wallet));
    const j = await r.json();
    if(j.username){
      display.textContent = '🏷️ ' + j.username;
      desc.textContent = 'This wallet has a name. Connect and sign to change it. Only the owner can.';
      input.value = j.username;
      btn.textContent = 'Connect & Update';
    } else {
      desc.textContent = 'Connect this wallet and sign once to claim a name for the leaderboard. Only you can set it.';
      btn.textContent = 'Connect & Claim';
    }
  }catch(_){}
}
function setUnameMsg(text, kind){
  const el = $('unameMsg');
  if(!el) return;
  el.textContent = text || '';
  el.className = 'uname-msg' + (kind ? ' ' + kind : '');
}
function showDeepLinks(){
  const dl = $('deepLinks');
  if(!dl) return;
  const here = encodeURIComponent(location.href.split('#')[0] + '#checker');
  const origin = encodeURIComponent(location.origin);
  $('dlPhantom').href = 'https://phantom.app/ul/browse/' + here + '?ref=' + origin;
  $('dlSolflare').href = 'https://solflare.com/ul/v1/browse/' + here + '?ref=' + origin;
  dl.classList.add('show');
}
(function(){
  const btn = $('unameBtn');
  if(!btn) return;
  btn.addEventListener('click', async () => {
    if(!currentWallet){ setUnameMsg('Check a wallet above first.', 'err'); return; }
    const desired = ($('unameInput').value || '').trim().replace(/[^a-zA-Z0-9_]/g, '');
    if(desired.length < 3){
      setUnameMsg('Name needs at least 3 characters: letters, numbers, underscore.', 'err');
      return;
    }
    const provider = getProvider();
    if(!provider){
      setUnameMsg('No Solana wallet detected in this browser. Open the site inside your wallet app instead:', 'err');
      showDeepLinks();
      return;
    }
    btn.disabled = true;
    setUnameMsg('Connecting wallet...');
    try{
      const resp = await provider.connect();
      const connected = (resp && resp.publicKey ? resp.publicKey : provider.publicKey).toString();
      if(connected !== currentWallet){
        setUnameMsg('Connected wallet ' + shortAddr(connected) + ' does not match the wallet you checked. Switch accounts and try again.', 'err');
        btn.disabled = false;
        return;
      }
      const message = 'Drippy username claim for ' + currentWallet.slice(0,8) + ' :: ' + desired + ' :: ' + Date.now();
      setUnameMsg('Approve the signature request in your wallet...');
      const encoded = new TextEncoder().encode(message);
      let signed;
      try{ signed = await provider.signMessage(encoded, 'utf8'); }
      catch(sigErr){
        if(/argument|param|utf8/i.test(sigErr.message || '')) signed = await provider.signMessage(encoded);
        else throw sigErr;
      }
      let sigBytes = signed && signed.signature ? signed.signature : signed;
      let signature;
      if(sigBytes && sigBytes.data && Array.isArray(sigBytes.data)) sigBytes = Uint8Array.from(sigBytes.data);
      if(typeof sigBytes === 'string') signature = sigBytes;
      else signature = bs58encode(sigBytes);

      setUnameMsg('Saving...');
      const r = await fetch('/api/username', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: currentWallet, username: desired, signature, message })
      });
      const j = await r.json();
      if(j.success){
        setUnameMsg('Name set to "' + j.username + '". It now shows on the leaderboard.', 'ok');
        $('unameCurrent').textContent = '🏷️ ' + j.username;
        loadLeaderboard();
      } else {
        setUnameMsg(j.error || 'Could not set the name.', 'err');
      }
    }catch(e){
      if(e && (e.code === 4001 || /reject/i.test(e.message || ''))) setUnameMsg('Signature cancelled.', 'err');
      else setUnameMsg('Error: ' + (e.message || 'wallet connection failed'), 'err');
    }finally{
      btn.disabled = false;
    }
  });
})();

/* ---------------- leaderboard ---------------- */
let _lbType = 'burn';
let _lbMe = null, _lbBurnRank = null, _lbEarnRank = null;
async function loadLeaderboard(type, me, burnRank, earnRank){
  if(type) _lbType = type;
  if(me !== undefined) _lbMe = me;
  if(burnRank !== undefined) _lbBurnRank = burnRank;
  if(earnRank !== undefined) _lbEarnRank = earnRank;
  const list = $('lbList');
  if(!list) return;
  try{
    const r = await fetch('/api/leaderboard?type=' + _lbType + '&limit=15', { cache:'no-store' });
    const d = await r.json();
    if(d.configured === false || !d.entries || d.entries.length === 0){
      list.innerHTML = '<div class="lb-loading">Leaderboard is warming up. Burn or check a wallet to claim a spot.</div>';
      return;
    }
    list.innerHTML = '';
    // Tier badge for burn (Hall of Flame): shows what skin tier each wallet has unlocked
    const burnTierBadge = (burned) => {
      const b = Number(burned) || 0;
      if (b >= 10_000_000) return '<span title="Void tier (10M+ burned)">🌌</span>';
      if (b >= 5_000_000)  return '<span title="Diamond tier (5M+ burned)">💎</span>';
      if (b >= 1_000_000)  return '<span title="Gold tier (1M+ burned)">🥇</span>';
      if (b >= 500_000)    return '<span title="Silver tier (500K+ burned)">🥈</span>';
      if (b >= 100_000)    return '<span title="Bronze tier (100K+ burned)">🥉</span>';
      return '';
    };
    d.entries.forEach(e => {
      const row = document.createElement('div');
      row.className = 'lb-row' + (e.wallet === _lbMe ? ' me' : '');
      const badge = (_lbType === 'burn') ? burnTierBadge(e.tokensBurned) : '';
      const who = e.username
        ? '<span class="uname-tag">' + e.username + '</span> <span style="opacity:.5">' + shortAddr(e.wallet) + '</span>'
        : shortAddr(e.wallet);
      const val = _lbType === 'earn' ? fmtSol(e.totalReceivedSol) : fmtTokens(e.tokensBurned) + ' 🔥';
      row.innerHTML =
        '<span class="rank' + (e.rank <= 3 ? ' top' : '') + '">#' + e.rank + '</span>' +
        '<span class="who">' + (badge ? badge + ' ' : '') + who + '</span>' +
        '<span class="val">' + val + '</span>';
      list.appendChild(row);
    });
    const yr = $('lbYourRank');
    if(yr){
      const rank = _lbType === 'earn' ? _lbEarnRank : _lbBurnRank;
      yr.innerHTML = rank ? 'Your rank: <b>#' + rank + '</b>' : 'Check your wallet above to claim your spot';
    }
  }catch(e){
    list.innerHTML = '<div class="lb-loading">Could not load the leaderboard. Try again shortly.</div>';
  }
}
document.querySelectorAll('.lb-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.lb-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    loadLeaderboard(tab.dataset.type);
  });
});
loadLeaderboard();

/* ---------------- story toggle ---------------- */
(function(){
  const btn = $('storyToggle');
  const more = $('storyMore');
  if(!btn || !more) return;
  btn.addEventListener('click', () => {
    const open = more.classList.toggle('open');
    btn.textContent = open ? 'Close the legend' : 'Read the full legend';
  });
})();

/* ---------------- events feed ---------------- */
async function loadEvents(){
  const list = $('eventsList');
  if(!list) return;
  try{
    const r = await fetch('/api/events', { cache:'no-store' });
    const d = await r.json();
    const events = (d.events || []).filter(e => new Date(e.start).getTime() > Date.now() - 2 * 3600 * 1000);
    if(events.length === 0){
      list.innerHTML = '<div class="ev-empty">Nothing scheduled right now. Follow the pack on X and Telegram for the next one.</div>';
      return;
    }
    list.innerHTML = '';
    events.forEach(e => {
      const ms = new Date(e.start).getTime() - Date.now();
      const live = ms <= 0;
      let cd;
      if(live) cd = 'LIVE NOW';
      else{
        const m = Math.floor(ms / 60000);
        if(m < 60) cd = 'in ' + m + 'm';
        else if(m < 1440) cd = 'in ' + Math.floor(m/60) + 'h ' + (m%60) + 'm';
        else cd = 'in ' + Math.floor(m/1440) + 'd';
      }
      const icon = e.type === 'space' ? '🎙️' : e.type === 'ama' ? '💬' : e.type === 'launch' ? '🚀' : '📡';
      const row = document.createElement(e.link ? 'a' : 'div');
      row.className = 'ev-row' + (e.image ? ' has-img' : '');
      if(e.link){ row.href = e.link; row.target = '_blank'; row.rel = 'noopener'; row.style.textDecoration = 'none'; row.style.color = 'inherit'; }
      row.innerHTML =
        '<span class="icon">' + icon + '</span>' +
        (e.image ? '<img class="ev-img" src="' + e.image + '" alt="" loading="lazy">' : '') +
        '<span><div class="t">' + (e.title || 'Event') + '</div>' +
        '<div class="when">' + new Date(e.start).toLocaleString() + '</div></span>' +
        '<span class="cd">' + cd + '</span>';
      list.appendChild(row);
    });
  }catch(_){}
}
loadEvents();
setInterval(loadEvents, 60000);

/* ---------------- admin modal ---------------- */
(function(){
  const modal = $('adminModal');
  if(!modal) return;
  $('adminOpen').addEventListener('click', (e) => { e.preventDefault(); modal.classList.add('open'); });
  $('adminClose').addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', (e) => { if(e.target === modal) modal.classList.remove('open'); });

  function msg(text, kind){
    const el = $('adminMsg');
    el.textContent = text || '';
    el.className = 'modal-msg' + (kind ? ' ' + kind : '');
  }

  async function refreshAdminList(){
    const key = $('adminKey').value.trim();
    const list = $('adminEvList');
    try{
      const r = await fetch('/api/events', { cache:'no-store' });
      const d = await r.json();
      list.innerHTML = '';
      (d.events || []).forEach(ev => {
        const row = document.createElement('div');
        row.className = 'ev-admin-row';
        row.innerHTML = '<span>' + (ev.title || 'Event') + ' · ' + new Date(ev.start).toLocaleString() + '</span>';
        const del = document.createElement('button');
        del.textContent = 'Delete';
        del.addEventListener('click', async () => {
          const r2 = await fetch('/api/events?action=del&key=' + encodeURIComponent(key) + '&id=' + encodeURIComponent(ev.id));
          const j2 = await r2.json();
          if(j2.ok){ refreshAdminList(); loadEvents(); }
          else msg(j2.error || 'Delete failed', 'err');
        });
        row.appendChild(del);
        list.appendChild(row);
      });
      if(!list.children.length) list.innerHTML = '<div class="ev-admin-row">No events scheduled</div>';
    }catch(_){}
  }
  refreshAdminList();

  /* ---- Game leaderboard CRUD ---- */
  let _lbAdminBoard = 'game';  // 'game' (all-time) | 'weekly'
  function lbMsg(text, kind){
    const el = $('adminLbMsg');
    if(!el) return;
    el.textContent = text || '';
    el.className = 'modal-msg' + (kind ? ' ' + kind : '');
  }
  async function refreshLbAdmin(){
    const key = ($('adminKey').value || '').trim();
    const list = $('adminLbList');
    if(!list) return;
    list.innerHTML = '<div class="ev-admin-row">Loading…</div>';
    try{
      const url = _lbAdminBoard === 'weekly'
        ? '/api/leaderboard?board=weekly'
        : '/api/leaderboard?board=game';
      const r = await fetch(url, { cache: 'no-store' });
      const d = await r.json();
      list.innerHTML = '';
      const items = Array.isArray(d.scores) ? d.scores : [];
      if(!items.length){
        list.innerHTML = '<div class="ev-admin-row">No scores on this board yet</div>';
        return;
      }
      items.forEach((e, i) => {
        // member key:
        //   game (all-time) → server keyed by name (e.n)
        //   weekly         → server returns the raw member key as e.member (wallet or 'anon:NAME:ip')
        const isWeekly = _lbAdminBoard === 'weekly';
        const member = isWeekly ? (e.member || e.wallet || ('anon:' + (e.n || 'DRIPPY') + ':unknown')) : (e.n || '');
        const tag = isWeekly
          ? (e.verified ? ' ✓' : e.status === 'holder' ? ' 🐾' : ' (anon)')
          : (e.beat ? ' 👑' : '');
        const skinBadge = e.skin ? ({default:'🐶',believer:'🐾',bronze:'🥉',silver:'🥈',gold:'🥇',diamond:'💎',void:'🌌',shadow:'☠️'}[e.skin] || '') : '';
        const label = '#' + (i+1) + ' · ' + (e.n || (e.wallet ? (e.wallet.slice(0,4)+'…'+e.wallet.slice(-4)) : 'DRIPPY')) + tag + (skinBadge ? ' ' + skinBadge : '');
        const row = document.createElement('div');
        row.className = 'ev-admin-row';
        row.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';
        row.innerHTML =
          '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">' + label + '</span>' +
          '<span style="font-family:JetBrains Mono,monospace;color:#f5c542;font-weight:700">' + Number(e.s).toLocaleString() + '</span>';
        const editBtn = document.createElement('button');
        editBtn.textContent = '✏️';
        editBtn.title = 'Edit score';
        editBtn.style.cssText = 'padding:4px 8px;background:rgba(162,89,255,.15);border:1px solid rgba(162,89,255,.4);border-radius:6px;color:#c9b8ff;cursor:pointer';
        editBtn.addEventListener('click', async () => {
          if(!key){ lbMsg('Enter the admin key first.', 'err'); return; }
          const next = prompt('New score for "' + (e.n || member) + '" (current: ' + e.s + '):', String(e.s));
          if(next === null) return;
          const sc = Math.round(Number(next));
          if(!isFinite(sc) || sc < 0){ lbMsg('Score must be a non-negative number.', 'err'); return; }
          try{
            const body = isWeekly ? { member, score: sc } : { name: e.n, score: sc, beat: e.beat };
            const r2 = await fetch('/api/leaderboard?board=' + _lbAdminBoard, {
              method: 'PUT',
              headers: { 'Content-Type':'application/json', 'x-admin-secret': key },
              body: JSON.stringify(body)
            });
            const j2 = await r2.json();
            if(j2.ok){ lbMsg('Updated.', 'ok'); refreshLbAdmin(); }
            else lbMsg(j2.error || 'Edit failed', 'err');
          }catch(err){ lbMsg('Edit failed: ' + err.message, 'err'); }
        });
        const delBtn = document.createElement('button');
        delBtn.textContent = '🗑️';
        delBtn.title = 'Delete';
        delBtn.style.cssText = 'padding:4px 8px;background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.4);border-radius:6px;color:#ffadad;cursor:pointer';
        delBtn.addEventListener('click', async () => {
          if(!key){ lbMsg('Enter the admin key first.', 'err'); return; }
          if(!confirm('Delete "' + (e.n || member) + '" (score ' + e.s + ')? This can\'t be undone.')) return;
          try{
            const url = isWeekly
              ? '/api/leaderboard?board=weekly&member=' + encodeURIComponent(member)
              : '/api/leaderboard?board=game&name=' + encodeURIComponent(e.n);
            const r2 = await fetch(url, {
              method: 'DELETE',
              headers: { 'x-admin-secret': key }
            });
            const j2 = await r2.json();
            if(j2.removed !== undefined){ lbMsg('Removed.', 'ok'); refreshLbAdmin(); }
            else lbMsg(j2.error || 'Delete failed', 'err');
          }catch(err){ lbMsg('Delete failed: ' + err.message, 'err'); }
        });
        row.appendChild(editBtn);
        row.appendChild(delBtn);
        list.appendChild(row);
      });
    }catch(err){ list.innerHTML = '<div class="ev-admin-row">Could not load: ' + err.message + '</div>'; }
  }
  // Tab switching
  document.querySelectorAll('.lb-admin-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.lb-admin-tab').forEach(b => {
        b.classList.remove('active');
        b.style.background = 'rgba(255,255,255,.05)';
        b.style.border = '1px solid rgba(255,255,255,.12)';
        b.style.color = '#aaa';
      });
      btn.classList.add('active');
      btn.style.background = 'rgba(245,197,66,.12)';
      btn.style.border = '1px solid rgba(245,197,66,.35)';
      btn.style.color = '#f5c542';
      _lbAdminBoard = btn.dataset.board;
      refreshLbAdmin();
    });
  });
  // Section tabs at top of modal: Events | Leaderboard
  function setSection(name){
    document.querySelectorAll('.admin-section-tab').forEach(b => {
      const active = b.dataset.section === name;
      b.classList.toggle('active', active);
      b.style.background = active ? 'rgba(162,89,255,.18)' : 'rgba(255,255,255,.05)';
      b.style.border     = active ? '1px solid rgba(162,89,255,.5)' : '1px solid rgba(255,255,255,.12)';
      b.style.color      = active ? '#c9b8ff' : '#aaa';
    });
    const ev = $('adminSectionEvents');
    const lb = $('adminSectionLeaderboard');
    if (ev) ev.style.display = name === 'events' ? 'block' : 'none';
    if (lb) lb.style.display = name === 'leaderboard' ? 'block' : 'none';
    if (name === 'leaderboard') setTimeout(refreshLbAdmin, 30);
  }
  document.querySelectorAll('.admin-section-tab').forEach(btn => {
    btn.addEventListener('click', () => setSection(btn.dataset.section));
  });
  // When admin opens, refresh both
  $('adminOpen').addEventListener('click', () => setTimeout(refreshLbAdmin, 80));
  refreshLbAdmin();

  const fileInput = $('adminImage');
  if(fileInput){
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      $('adminImageLabel').textContent = f ? ('📷 ' + f.name) : '📷 Add event image (optional)';
    });
  }

  $('adminPost').addEventListener('click', async () => {
    const key = $('adminKey').value.trim();
    const title = $('adminTitle').value.trim();
    const start = $('adminStart').value;
    const type = $('adminType').value;
    const link = $('adminLink').value.trim();
    if(!key){ msg('Enter the admin key.', 'err'); return; }
    if(!title || !start){ msg('Title and start time are required.', 'err'); return; }
    try{
      let image = '';
      const f = fileInput && fileInput.files && fileInput.files[0];
      if(f){
        if(f.size > 4 * 1024 * 1024){ msg('Image is over 4 MB. Pick a smaller one.', 'err'); return; }
        msg('Uploading image...');
        const up = await fetch('/api/upload-image', {
          method: 'POST',
          headers: { 'Content-Type': f.type || 'image/jpeg', 'X-Filename': f.name, 'X-Admin-Secret': key },
          body: f
        });
        const uj = await up.json();
        if(!uj.success){ msg(uj.error || 'Image upload failed.', 'err'); return; }
        image = uj.url;
      }
      msg('Posting...');
      const qs = new URLSearchParams({ action:'add', key, title, start: new Date(start).toISOString(), type, link, image });
      const r = await fetch('/api/events?' + qs.toString());
      const j = await r.json();
      if(j.ok){
        msg('Event posted.', 'ok');
        if(fileInput){ fileInput.value = ''; $('adminImageLabel').textContent = '📷 Add event image (optional)'; }
        refreshAdminList(); loadEvents();
      }
      else msg(j.error || 'Could not post the event.', 'err');
    }catch(e){ msg('Error: ' + e.message, 'err'); }
  });
})();

/* ---------------- hero fun: drip particles + WOOF easter egg + reveals ---------------- */
(function(){
  if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const host = $('heroDrips');
  if(host){
    for(let i = 0; i < 12; i++){
      const p = document.createElement('span');
      p.className = 'drip-p' + (Math.random() < 0.35 ? ' purple-p' : '');
      p.style.left = (Math.random() * 100).toFixed(1) + '%';
      p.style.setProperty('--s', (0.6 + Math.random() * 0.9).toFixed(2));
      p.style.animationDuration = (6 + Math.random() * 9).toFixed(1) + 's';
      p.style.animationDelay = (-Math.random() * 12).toFixed(1) + 's';
      host.appendChild(p);
    }
  }
})();

(function(){
  const banner = $('heroBanner');
  if(!banner) return;
  const WOOFS = ['WOOF!', 'WOOF WOOF!', 'drip drip.', 'good dog.', 'pays well.', 'AWOOOO!', '*tail wags*', 'the pack eats.'];
  const BULL_WOOFS = ['we pumping. WOOF.', 'green candles taste like bacon.', 'UP ONLY.', 'the drip is dripping.'];
  const BEAR_WOOFS = ['diamond paws.', 'we hold. we fetch later.', 'red is just discount gold.', 'still getting paid every 30 min.'];
  banner.addEventListener('click', (e) => {
    const pool = WOOFS.concat(window._mood === 'bull' ? BULL_WOOFS : window._mood === 'bear' ? BEAR_WOOFS : []);
    const pop = document.createElement('div');
    pop.className = 'woof-pop';
    pop.textContent = pool[Math.floor(Math.random() * pool.length)];
    pop.style.left = e.clientX + 'px';
    pop.style.top = (e.clientY - 10) + 'px';
    pop.style.fontSize = (20 + Math.random() * 16).toFixed(0) + 'px';
    document.body.appendChild(pop);
    setTimeout(() => pop.remove(), 1200);
  });
})();

(function(){
  const sections = document.querySelectorAll('section, .ticker, .hero-copy');
  if(!('IntersectionObserver' in window)){ return; }
  const io = new IntersectionObserver((entries) => {
    entries.forEach(en => { if(en.isIntersecting){ en.target.classList.add('in'); io.unobserve(en.target); } });
  }, { threshold: 0.08 });
  sections.forEach(s => { s.classList.add('reveal'); io.observe(s); });
})();

/* ---------------- rank card: real shareable image ---------------- */
const CARD_W = 1080, CARD_H = 1350;
function loadImg(src){
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
function roundRect(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
async function drawRankCard(d){
  const canvas = $('cardCanvas');
  const ctx = canvas.getContext('2d');
  const completed = QUESTS.filter(q => q.check(d)).length;
  const tier = computeTier(completed);
  let featured = null;
  QUESTS.forEach(q => { if(q.check(d)) featured = q; });

  // Background
  const bg = ctx.createLinearGradient(0, 0, 0, CARD_H);
  bg.addColorStop(0, '#1a0a2e');
  bg.addColorStop(0.55, '#0a0610');
  bg.addColorStop(1, '#120a1c');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Glow blobs
  const glow1 = ctx.createRadialGradient(CARD_W/2, 150, 30, CARD_W/2, 150, 520);
  glow1.addColorStop(0, 'rgba(107,45,201,.45)');
  glow1.addColorStop(1, 'rgba(107,45,201,0)');
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, CARD_W, 700);
  const glow2 = ctx.createRadialGradient(CARD_W/2, 760, 40, CARD_W/2, 760, 460);
  glow2.addColorStop(0, 'rgba(212,164,49,.28)');
  glow2.addColorStop(1, 'rgba(212,164,49,0)');
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 380, CARD_W, 800);

  // Border frame
  const tierColors = { 'tier-bronze':'#cd7f32', 'tier-silver':'#c0c0c8', 'tier-gold':'#f5c542', 'tier-diamond':'#b4e6ff' };
  const frame = tierColors[tier.cls] || '#a259ff';
  ctx.strokeStyle = frame;
  ctx.lineWidth = 10;
  roundRect(ctx, 24, 24, CARD_W - 48, CARD_H - 48, 38);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(246,233,196,.18)';
  ctx.lineWidth = 2;
  roundRect(ctx, 44, 44, CARD_W - 88, CARD_H - 88, 28);
  ctx.stroke();

  // Wordmark
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f5c542';
  ctx.font = '78px "Bowlby One", cursive';
  ctx.fillText('$DRIPPY', CARD_W/2, 152);
  ctx.fillStyle = '#c084fc';
  ctx.font = '30px "Permanent Marker", cursive';
  ctx.fillText('the Solana Dividend Dog', CARD_W/2, 200);

  // Featured quest art
  const artSrc = featured ? featured.img : 'assets/drippy-king.png';
  const art = await loadImg(artSrc);
  const artSize = 460;
  const ax = (CARD_W - artSize) / 2, ay = 250;
  if(art){
    ctx.save();
    roundRect(ctx, ax, ay, artSize, artSize, 30);
    ctx.clip();
    ctx.drawImage(art, ax, ay, artSize, artSize);
    ctx.restore();
    ctx.strokeStyle = frame;
    ctx.lineWidth = 6;
    roundRect(ctx, ax, ay, artSize, artSize, 30);
    ctx.stroke();
  }

  // Rank name
  ctx.fillStyle = frame;
  ctx.font = '64px "Bowlby One", cursive';
  ctx.fillText(tier.name, CARD_W/2, ay + artSize + 96);

  // Quest count
  ctx.fillStyle = 'rgba(246,233,196,.75)';
  ctx.font = '30px "JetBrains Mono", monospace';
  ctx.fillText(completed + ' / ' + QUESTS.length + ' quests complete', CARD_W/2, ay + artSize + 148);

  // Stat boxes
  const stats = [
    ['SOL EARNED', fmtSol(d.totalReceivedSol)],
    ['PAYOUTS', String((d.distributionCount || 0).toLocaleString())],
    ['BURNED', (d.burner && d.burner.tokensBurned) ? fmtTokens(d.burner.tokensBurned) : '0']
  ];
  const boxW = 300, boxH = 130, gap = 24;
  const startX = (CARD_W - (boxW * 3 + gap * 2)) / 2;
  const boxY = ay + artSize + 190;
  stats.forEach((st, i) => {
    const bx = startX + i * (boxW + gap);
    ctx.fillStyle = 'rgba(27,18,40,.85)';
    roundRect(ctx, bx, boxY, boxW, boxH, 18);
    ctx.fill();
    ctx.strokeStyle = 'rgba(162,89,255,.3)';
    ctx.lineWidth = 2;
    roundRect(ctx, bx, boxY, boxW, boxH, 18);
    ctx.stroke();
    ctx.fillStyle = 'rgba(246,233,196,.55)';
    ctx.font = '22px "Anton", sans-serif';
    ctx.fillText(st[0], bx + boxW/2, boxY + 46);
    ctx.fillStyle = '#f5c542';
    ctx.font = '34px "JetBrains Mono", monospace';
    ctx.fillText(st[1], bx + boxW/2, boxY + 96);
  });

  // Wallet + site
  ctx.fillStyle = 'rgba(246,233,196,.5)';
  ctx.font = '26px "JetBrains Mono", monospace';
  ctx.fillText(shortAddr(d.wallet), CARD_W/2, CARD_H - 130);
  ctx.fillStyle = '#ffd966';
  ctx.font = '34px "Anton", sans-serif';
  ctx.fillText('DRIPPYREWARDS.COM', CARD_W/2, CARD_H - 78);
}

(function(){
  const modal = $('cardModal');
  const openBtn = $('dqCardBtn');
  if(!modal || !openBtn) return;

  function cardMsg(text, kind){
    const el = $('cardMsg');
    el.textContent = text || '';
    el.className = 'modal-msg' + (kind ? ' ' + kind : '');
  }

  openBtn.addEventListener('click', async () => {
    const d = window._dripWalletData;
    if(!d) return;
    modal.classList.add('open');
    cardMsg('Building your card...');
    try{
      await (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve());
      await drawRankCard(d);
      cardMsg('');
    }catch(e){ cardMsg('Could not draw the card: ' + e.message, 'err'); }
  });
  $('cardClose').addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', (e) => { if(e.target === modal) modal.classList.remove('open'); });

  $('cardDownloadBtn').addEventListener('click', () => {
    const a = document.createElement('a');
    a.download = 'drippy-rank-card.png';
    a.href = $('cardCanvas').toDataURL('image/png');
    a.click();
  });

  $('cardShareBtn').addEventListener('click', () => {
    $('cardCanvas').toBlob(async (blob) => {
      if(!blob){ cardMsg('Could not create the image.', 'err'); return; }
      const file = new File([blob], 'drippy-rank-card.png', { type: 'image/png' });
      const d = window._dripWalletData;
      const text = 'My $DRIPPY rank card. ' + fmtSol(d ? d.totalReceivedSol : 0) + ' dripped so far. drippyrewards.com';
      if(navigator.canShare && navigator.canShare({ files: [file] })){
        try{ await navigator.share({ files: [file], text }); }
        catch(e){ /* user cancelled */ }
      } else {
        cardMsg('Direct image sharing is not supported in this browser. Use Download, then attach the image to your post.', 'err');
      }
    }, 'image/png');
  });
})();

/* ---------------- intro splash ---------------- */
(function(){
  const intro = $('intro');
  if(!intro) return;
  if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches){
    intro.classList.add('done');
    return;
  }
  // Falling drips inside the splash, gold with a few purple
  const dripHost = $('introDrips');
  if(dripHost){
    for(let i = 0; i < 16; i++){
      const drop = document.createElement('i');
      if(Math.random() < 0.3) drop.className = 'purple-drip';
      drop.style.left = (Math.random() * 100).toFixed(1) + '%';
      drop.style.animationDuration = (1.4 + Math.random() * 2.2).toFixed(2) + 's';
      drop.style.animationDelay = (Math.random() * 2.4).toFixed(2) + 's';
      drop.style.height = (32 + Math.random() * 36).toFixed(0) + 'px';
      dripHost.appendChild(drop);
    }
  }
  // Remove from the page once the exit animation finishes, with a hard
  // fallback timer in case the animation event never fires
  intro.addEventListener('animationend', (e) => {
    if(e.animationName === 'introExit') intro.classList.add('done');
  });
  setTimeout(() => intro.classList.add('done'), 4300);
})();
