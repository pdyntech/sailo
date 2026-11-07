/* Live demo preview on the landing page: a looping, decorative walk through one invoice.
   Plays only while on screen; shows the finished state when reduced motion is on. */
(function () {
  var win = document.getElementById('dwin');
  if (!win) return;
  var $ = function (id) { return document.getElementById(id); };
  var pipe = [].slice.call($('d-pipe').children), feed = $('d-feed'), ship = $('d-ship'), route = $('d-route'), trail = $('d-trail');
  var status = $('d-status'), escrow = $('d-escrow'), bar = $('d-bar'), ais = $('d-ais'), stepName = $('d-step'), stepNum = $('d-n');
  var len = route.getTotalLength();
  trail.style.strokeDasharray = len;

  // Same facts as the live demo: 1,000 XLM invoice, 85% advance, 880 XLM agent cap, 800 m Cebu geofence.
  var STEPS = [
    { name: 'Tokenized', status: 'Tokenized', escrow: 0, ais: 'In port', ms: 2400, log: ['ok', 'Waybill registered on-chain', 'INV-2026-001 hashed and recorded'] },
    { name: 'Funded', status: 'Funded', escrow: 850, ais: 'In port', ms: 2400, log: ['ok', 'Investor funded the escrow', '850 XLM locked for this invoice'] },
    { name: 'Advanced', status: 'Advanced', escrow: 0, ais: 'In port', ms: 2600, log: ['ok', 'Advance within cap', '850 XLM ≤ 880 XLM cap, paid to the shipowner'] },
    { name: 'In transit', status: 'In transit', escrow: 0, ais: 'Underway', ms: 4200, sail: true, log: ['info', 'Vessel underway', 'AIS: MV VisMin Pioneer left Manila'] },
    { name: 'Berthed', status: 'Berthed', escrow: 0, ais: 'Berthed', ms: 2600, log: ['ok', 'Arrival confirmed', 'Inside the 800 m Cebu geofence at ≤0.5 kn'] },
    { name: 'Paid', status: 'Paid', escrow: 1000, ais: 'Berthed', ms: 2400, log: ['ok', 'Cargo owner paid', '1,000 XLM through Velo checkout'] },
    { name: 'Settled', status: 'Settled', escrow: 0, ais: 'Berthed', ms: 4200, log: ['ok', 'Settled, escrow at zero', 'Investor 880 · shipowner 115 · fee 5 XLM'] }
  ];

  var i = -1, timer = 0, raf = 0, playing = false, shown = 0, sailT = 0;

  function place(t) {
    var p = route.getPointAtLength(t * len), q = route.getPointAtLength(Math.min(len, t * len + 1));
    var a = Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI;
    ship.setAttribute('transform', 'translate(' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ') rotate(' + a.toFixed(1) + ')');
    trail.style.strokeDashoffset = len * (1 - t);
  }
  function count(to) {
    var from = +escrow.textContent.replace(/,/g, '') || 0, t0 = performance.now();
    (function tick(now) {
      var k = Math.min(1, (now - t0) / 700), v = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      escrow.textContent = v.toLocaleString('en-US');
      if (k < 1 && playing) requestAnimationFrame(tick);
    })(t0);
    bar.style.width = (to / 10) + '%';
  }
  function log(entry, animate) {
    var li = document.createElement('li');
    li.className = entry[0] + (animate ? ' in' : '');
    li.innerHTML = '<b>' + entry[1] + '</b><span>' + entry[2] + '</span>';
    feed.insertBefore(li, feed.firstChild);
    while (feed.children.length > 4) feed.removeChild(feed.lastChild);
  }
  function show(n, animate) {
    var s = STEPS[n];
    pipe.forEach(function (li, k) { li.className = k < n ? 'done' : k === n ? 'now' : ''; });
    if (n === STEPS.length - 1) pipe[n].className = 'done now';
    win.style.setProperty('--prog', (n / (STEPS.length - 1)).toFixed(3));
    stepName.textContent = s.name; stepNum.textContent = n + 1;
    status.textContent = s.status; ais.textContent = s.ais; ais.dataset.s = s.ais;
    win.dataset.step = n;
    if (animate) count(s.escrow); else { escrow.textContent = s.escrow.toLocaleString('en-US'); bar.style.width = (s.escrow / 10) + '%'; }
    if (shown <= n) { log(s.log, animate); shown = n + 1; }
    if (!s.sail) place(n < 3 ? 0 : 1);
  }
  function sail(ms) {
    var t0 = performance.now() - sailT * ms;
    cancelAnimationFrame(raf);
    (function frame(now) {
      sailT = Math.min(1, (now - t0) / ms);
      place(sailT < .5 ? 2 * sailT * sailT : 1 - Math.pow(-2 * sailT + 2, 2) / 2);
      if (sailT < 1 && playing) raf = requestAnimationFrame(frame);
    })(t0);
  }
  function reset() {
    i = -1; shown = 0; sailT = 0; feed.innerHTML = ''; escrow.textContent = '0'; bar.style.width = '0%';
    status.textContent = 'Draft'; place(0);
  }
  function next() {
    if (i >= STEPS.length - 1) { win.classList.add('fade'); timer = setTimeout(function () { reset(); win.classList.remove('fade'); next(); }, 500); return; }
    i++; sailT = 0;
    show(i, true);
    if (STEPS[i].sail) sail(STEPS[i].ms - 400);
    timer = setTimeout(next, STEPS[i].ms);
  }
  function play() {
    if (playing) return; playing = true;
    if (i >= 0 && STEPS[i].sail && sailT < 1) sail(STEPS[i].ms - 400);
    timer = setTimeout(next, i < 0 ? 300 : 1200);
  }
  function pause() { playing = false; clearTimeout(timer); cancelAnimationFrame(raf); }

  place(0);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (var k = 0; k < STEPS.length; k++) show(k, false);
    return;
  }
  var visible = false;
  function sync() { if (visible && !document.hidden) play(); else pause(); }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (es) { visible = es[0].isIntersecting; sync(); }, { threshold: 0.25 }).observe(win);
  } else { visible = true; }
  document.addEventListener('visibilitychange', sync);
  sync();
})();
