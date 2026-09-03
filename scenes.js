/* ============================================================
   DRIPPY — SCENE ENGINE
   Turns the page into one continuous environment: a vault that opens,
   a signature object that stays fixed while the world moves past it,
   a ledger that never ends, and a story that runs sideways.

   Contract with the rest of the site:
   - Nothing here is required. If GSAP/Lenis fail to load, or the visitor
     asked for reduced motion, `html.fx` is never set and every scene
     falls back to a composed static block (see scenes.css section 09).
   - It never touches data, wallet logic or the API layer.
   ============================================================ */
(function () {
  'use strict';

  var root = document.documentElement;
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = matchMedia('(pointer: fine)').matches;
  var hasEngine = !!(window.gsap && window.ScrollTrigger);

  /* ---------- 01. THE VAULT OPENS ----------
     Short, and it never blocks: the page is interactive underneath and
     the loader removes itself on a hard timeout even if something stalls. */
  function runLoader(done) {
    var el = document.getElementById('vaultLoad');
    if (!el) { done(); return; }
    if (reduced || !hasEngine) { el.remove(); done(); return; }

    var seam = el.querySelector('.seam');
    var mark = el.querySelector('.vmark');
    var pct = el.querySelector('.pct');
    var top = el.querySelector('.half.t');
    var bot = el.querySelector('.half.b');
    var counter = { v: 0 };
    var finished = false;

    function finish() {
      if (finished) return;
      finished = true;
      root.classList.add('loaded');
      if (el.parentNode) el.remove();
      done();
    }
    setTimeout(finish, 1900); // hard ceiling — never trap the visitor

    // Deliberately brief. A curtain that outstays its welcome reads as a slow
    // site, not a premium one: seam strikes, count runs, vault splits. ~1.4s.
    var tl = gsap.timeline({ onComplete: finish });
    tl.to(seam, { scaleX: 1, duration: .5, ease: 'expo.out' })
      .to([mark, pct], { opacity: 1, duration: .25, ease: 'power2.out' }, '-=.3')
      .to(counter, {
        v: 100, duration: .45, ease: 'power1.inOut',
        onUpdate: function () { if (pct) pct.textContent = String(Math.round(counter.v)).padStart(3, '0'); }
      }, '-=.15')
      .to([mark, pct], { opacity: 0, duration: .2, ease: 'power2.in' })
      .to(seam, { scaleX: 0, duration: .25, ease: 'power2.in' }, '-=.14')
      .to(top, { yPercent: -100, duration: .62, ease: 'expo.inOut' }, '-=.06')
      .to(bot, { yPercent: 100, duration: .62, ease: 'expo.inOut' }, '<');
  }

  /* ---------- 02. SMOOTH SCROLL ----------
     Desktop pointers only. Touch devices keep native momentum, which is
     what they expect and what performs best. */
  var lenis = null;
  function initScroll() {
    if (reduced || !fine || !window.Lenis || !hasEngine) return;
    lenis = new Lenis({
      duration: 1.05,
      easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); },
      smoothWheel: true,
      touchMultiplier: 1.6
    });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add(function (t) { lenis.raf(t * 1000); });
    gsap.ticker.lagSmoothing(0);
    root.style.scrollBehavior = 'auto'; // Lenis owns easing now
    window.__lenis = lenis;

    // in-page anchors route through Lenis so the easing stays consistent
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href^="#"]');
      if (!a) return;
      var id = a.getAttribute('href');
      if (!id || id === '#' || id.length < 2) return;
      var target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      lenis.scrollTo(target, { offset: -80, duration: 1.15 });
    });
    // modals and any scrollable overlay opt out
    document.querySelectorAll('.ov, .modal, [role="dialog"]').forEach(function (m) {
      m.setAttribute('data-lenis-prevent', '');
    });
  }

  /* ---------- 03. TYPE THAT ARRIVES LIKE FILM TITLES ----------
     Headings and eyebrows are wrapped in a clip and pushed up from below —
     a mask reveal, not another fade-up. */
  function initTypeReveals() {
    var targets = document.querySelectorAll('section h2, section .eyebrow, .loop a.loop-back');
    targets.forEach(function (node) {
      if (node.dataset.masked) return;
      node.dataset.masked = '1';
      var inner = document.createElement('span');
      while (node.firstChild) inner.appendChild(node.firstChild);
      node.appendChild(inner);
      node.classList.add('mask');
      gsap.set(inner, { yPercent: 110 });
      ScrollTrigger.create({
        trigger: node,
        start: 'top 88%',
        once: true,
        onEnter: function () {
          gsap.to(inner, { yPercent: 0, duration: 1.05, ease: 'expo.out' });
        }
      });
    });
  }

  /* ---------- 04. SIGNATURE SCENE: THE ETERNAL BONE ----------
     The bone leaves the document flow at centre screen and holds there,
     growing, while the burn story rises and falls around it and its fire
     fills to the live burn percentage. The environment moves; the object
     does not. It is the one thing we want remembered. */
  function initVaultScene() {
    var vault = document.getElementById('vault');
    var stage = vault && vault.querySelector('.vault-pin');
    var bone = vault && vault.querySelector('.vault-bone');
    if (!vault || !stage || !bone) return;

    var halo = vault.querySelector('.vault-halo');
    var pTop = vault.querySelector('.vpanel.top');
    var pBot = vault.querySelector('.vpanel.bot');
    var pLate = vault.querySelector('.vpanel.late');

    // The stage is held by CSS sticky. This only reads progress across the
    // section and layers the choreography on top, so a failure here costs
    // decoration, never layout.
    if (innerWidth <= 700) return; // compact static composition on phones

    var tl = gsap.timeline({
      scrollTrigger: { trigger: vault, start: 'top top', end: 'bottom bottom', scrub: .7 }
    });

    // The fire is NOT driven by scroll. It is a live reading of how much supply
    // is gone, so tying it to scroll position would show a number that
    // contradicts the caption directly beneath it. app.js owns it, and its CSS
    // transition animates the fill once when the real figure arrives.
    tl.fromTo(halo, { opacity: .3, scale: .92 }, { opacity: 1, scale: 1.04, ease: 'none' }, 0)
      .fromTo(bone, { scale: .97 }, { scale: 1.08, ease: 'none' }, 0);

    // the two live figures drift apart as you descend, then hand off to the promise
    if (pTop) tl.fromTo(pTop, { y: 0 }, { y: '-6vh', ease: 'none' }, 0);
    if (pBot) tl.fromTo(pBot, { y: 0 }, { y: '6vh', ease: 'none' }, 0);
    if (pLate && innerWidth > 700) {
      tl.to([pTop, pBot], { opacity: 0, duration: .18, ease: 'none' }, .68)
        .to(pLate, { opacity: 1, duration: .18, ease: 'none' }, .72);
    }
  }

  /* ---------- 05. THE INFINITE LEDGER ----------
     A true endless element: the track holds two identical halves and wraps
     by exactly one half, so the seam can never be seen. Scroll velocity
     leans on it, so the ledger reacts to how hard you are moving. */
  function initLedger() {
    var track = document.querySelector('.ledger-track');
    if (!track) return;

    function rows() {
      var out = [];
      var s = window.__stats;
      if (s && s.recentDrips && s.recentDrips.length) {
        s.recentDrips.slice(0, 10).forEach(function (d) {
          var amt = Number(d.amountSol || d.amount || 0);
          if (amt > 0) out.push(['DRIP', amt.toFixed(4) + ' SOL', 'paid to the pack']);
        });
      }
      if (s && s.distribution) {
        if (s.distribution.totalDistributedSol) out.push(['TOTAL PAID', Number(s.distribution.totalDistributedSol).toFixed(2) + ' SOL', 'and counting']);
        if (s.distribution.successfulDistributions) out.push(['CYCLES', Number(s.distribution.successfulDistributions).toLocaleString(), 'completed']);
      }
      if (s && s.burns && s.burns.tokensBurned) {
        out.push(['BURNED', Math.round(s.burns.tokensBurned).toLocaleString() + ' $DRIPPY', 'gone forever']);
        if (s.burns.burnEvents) out.push(['BURN EVENTS', Number(s.burns.burnEvents).toLocaleString(), 'by the chosen']);
      }
      if (!out.length) {
        out = [
          ['EVERY 30 MINUTES', 'SOL', 'straight to holder wallets'],
          ['BURN', '2x FOREVER', 'even at zero balance'],
          ['5% TAX', '100% TO SOL', 'no staking, no claiming'],
          ['THE DRIP', 'NEVER STOPS', 'around the clock']
        ];
      }
      return out;
    }

    function build() {
      var data = rows();
      var half = document.createDocumentFragment();
      data.forEach(function (r) {
        var it = document.createElement('div');
        it.className = 'ledger-item';
        it.innerHTML = '<span class="dot"></span><span class="who">' + r[0] + '</span><b>' + r[1] + '</b><span>' + r[2] + '</span>';
        half.appendChild(it);
      });
      track.innerHTML = '';
      track.appendChild(half.cloneNode(true));
      track.appendChild(half); // exactly two halves — wrap point is invisible
    }

    build();
    // rebuild once live data lands so the ledger shows real payouts
    var tries = 0;
    var poll = setInterval(function () {
      if (window.__stats || ++tries > 24) { clearInterval(poll); if (window.__stats) build(); }
    }, 500);

    if (!hasEngine || reduced) return; // CSS keyframes carry the fallback

    var offset = 0, base = 0.55, vel = 0;
    var half = 0;
    function measure() { half = track.scrollWidth / 2; }
    measure();
    ScrollTrigger.addEventListener('refreshInit', measure);

    if (lenis) lenis.on('scroll', function (e) { vel = Math.min(4, Math.abs(e.velocity || 0) * .06); });
    else addEventListener('scroll', function () { vel = 1.1; }, { passive: true });

    gsap.ticker.add(function () {
      if (!half) { measure(); return; }
      offset -= base + vel;
      vel *= .93;
      if (offset <= -half) offset += half; // seamless wrap
      track.style.transform = 'translate3d(' + offset.toFixed(2) + 'px,0,0)';
    });
  }

  /* ---------- 06. THE LEGEND, RUN SIDEWAYS ----------
     Vertical scroll drives lateral movement through the chapters. On touch
     the same cards become a natural horizontal swipe instead of a pin. */
  function initLegend() {
    var sec = document.getElementById('legend');
    if (!sec) return;
    var track = sec.querySelector('.lg-track');
    var pin = sec.querySelector('.lg-pin');
    if (!track || !pin) return;

    // Touch keeps the native horizontal scroller — swiping a story sideways is
    // already the right gesture there, and pinning fights the browser.
    if (!fine) return;

    sec.classList.add('lg-scene');
    function distance() { return Math.max(0, track.scrollWidth - innerWidth + 60); }
    function sizeSection() { sec.style.height = (innerHeight + distance()) + 'px'; }
    sizeSection();
    ScrollTrigger.addEventListener('refreshInit', sizeSection);

    gsap.to(track, {
      x: function () { return -distance(); },
      ease: 'none',
      scrollTrigger: {
        trigger: sec, start: 'top top', end: 'bottom bottom',
        scrub: .7, invalidateOnRefresh: true
      }
    });
  }

  /* ---------- 07. NAVIGATION: where you are, always ---------- */
  function initNav() {
    var nav = document.querySelector('.nav');
    var tag = document.getElementById('sceneTag');
    var name = tag && tag.querySelector('b');
    var barFill = tag && tag.querySelector('.bar i');

    if (nav) {
      ScrollTrigger.create({
        start: 'top -60',
        onUpdate: function (self) { nav.classList.toggle('solid', self.scroll() > 60); },
        onRefresh: function (self) { nav.classList.toggle('solid', self.scroll() > 60); }
      });
    }
    if (!tag) return;

    var scenes = [
      ['#top', 'The Vault'], ['#vault', 'Burned Forever'], ['#trade', 'Acquire'],
      ['#proof', 'Proof of Drip'], ['#checker', 'Your Receipts'], ['#burn', 'Burn for Glory'],
      ['#leaderboard', 'The Rankings'], ['#legend', 'The Legend'], ['#game', 'The Arcade'],
      ['#tokenomics', 'Tokenomics'], ['#faq', 'Questions']
    ].map(function (s) { return { el: document.querySelector(s[0]), label: s[1] }; })
     .filter(function (s) { return !!s.el; });

    ScrollTrigger.create({
      start: 0, end: 'max',
      onUpdate: function (self) {
        if (barFill) gsap.set(barFill, { scaleX: self.progress });
        var y = self.scroll() + innerHeight * 0.42, current = scenes[0];
        for (var i = 0; i < scenes.length; i++) {
          if (scenes[i].el.getBoundingClientRect().top + self.scroll() <= y) current = scenes[i];
        }
        if (name && name.textContent !== current.label) name.textContent = current.label;
      }
    });
  }

  /* ---------- 08. CURSOR + MAGNETIC TARGETS ----------
     Desktop only, and it never replaces the system cursor for text or
     form fields — it rides alongside so nothing becomes harder to use. */
  function initCursor() {
    if (!fine || reduced) return;
    var ring = document.getElementById('cur');
    var dot = document.getElementById('curDot');
    if (!ring || !dot) return;
    root.classList.add('cur-on');
    var lab = ring.querySelector('.lab');

    var rx = innerWidth / 2, ry = innerHeight / 2, dx = rx, dy = ry, tx = rx, ty = ry;
    addEventListener('mousemove', function (e) { tx = e.clientX; ty = e.clientY; }, { passive: true });
    gsap.ticker.add(function () {
      dx += (tx - dx) * .55; dy += (ty - dy) * .55;
      rx += (tx - rx) * .16; ry += (ty - ry) * .16;
      dot.style.transform = 'translate3d(' + dx + 'px,' + dy + 'px,0)';
      ring.style.transform = 'translate3d(' + rx + 'px,' + ry + 'px,0)';
    });

    function label(el) {
      if (el.closest('.hero-shot')) return 'Buy';
      if (el.closest('#game, .game-shot, .nav-game')) return 'Play';
      if (el.closest('.lg-track')) return 'Drag';
      if (el.closest('.burn-bone')) return 'Burn';
      if (el.closest('a[target="_blank"]')) return 'Open';
      if (el.closest('details')) return 'Read';
      return 'Go';
    }
    document.addEventListener('mouseover', function (e) {
      var hot = e.target.closest('a, button, summary, .tcell, .doc-card, .burn-bone');
      if (hot && !e.target.closest('input, textarea, select')) {
        ring.classList.add('hot'); dot.classList.add('hide');
        if (lab) lab.textContent = label(e.target);
      } else {
        ring.classList.remove('hot'); dot.classList.remove('hide');
      }
    });

    // magnetic pull on primary calls to action
    document.querySelectorAll('.btn-gold, .btn-purple, .nav-cta').forEach(function (b) {
      var strength = 0.28;
      b.addEventListener('mousemove', function (e) {
        var r = b.getBoundingClientRect();
        gsap.to(b, {
          x: (e.clientX - (r.left + r.width / 2)) * strength,
          y: (e.clientY - (r.top + r.height / 2)) * strength,
          duration: .5, ease: 'power3.out'
        });
      });
      b.addEventListener('mouseleave', function () {
        gsap.to(b, { x: 0, y: 0, duration: .7, ease: 'elastic.out(1,.4)' });
      });
    });
  }

  /* ---------- 09. THE LOOP: the end feeds the beginning ---------- */
  function initLoop() {
    var thread = document.querySelector('.loop .thread');
    if (!thread) return;
    gsap.fromTo(thread, { scaleY: 0 }, {
      scaleY: 1, ease: 'none',
      scrollTrigger: { trigger: '.loop', start: 'top 92%', end: 'top 46%', scrub: .6 }
    });
    var back = document.querySelector('.loop-back');
    if (back && lenis) {
      back.addEventListener('click', function (e) {
        e.preventDefault();
        lenis.scrollTo(0, { duration: 2.1, easing: function (t) { return 1 - Math.pow(1 - t, 4); } });
      });
    }
  }

  /* ---------- boot ---------- */
  function start() {
    if (!hasEngine || reduced) {
      var l = document.getElementById('vaultLoad');
      if (l) l.remove();
      initLedger(); // still builds the rows; CSS animates the fallback
      return;
    }
    gsap.registerPlugin(ScrollTrigger);
    root.classList.add('fx');
    initScroll();
    initTypeReveals();
    initVaultScene();
    initLedger();
    initLegend();
    initNav();
    initCursor();
    initLoop();
    ScrollTrigger.refresh();
    addEventListener('load', function () { ScrollTrigger.refresh(); });
  }

  // The scenes build immediately and the curtain plays over the top of them,
  // so a stalled or failed loader can never cost the visitor the experience.
  start();
  runLoader(function () { if (window.ScrollTrigger) ScrollTrigger.refresh(); });
})();
