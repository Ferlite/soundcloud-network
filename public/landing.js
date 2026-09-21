// The home page (/): a search box over a slowly drifting network.
(() => {
  if (location.pathname !== '/') return; // any other path is a network, handled by app.js

  const $ = (s) => document.querySelector(s);
  $('#landing').hidden = false;

  /* ---------- search ---------- */

  const input = $('#lp-name');
  const go = (username) => (location.href = '/' + encodeURIComponent(username));

  $('#lp-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim().replace(/\/+$/, '').split('/').pop();
    if (v) go(v);
  });
  attachProfileSearch({ input, box: $('#lp-suggestions'), form: $('#lp-form'), open: (u) => go(u.username) });
  input.focus();

  /* ---------- background: a slowly drifting network ---------- */

  const canvas = $('#c');
  const ctx = canvas.getContext('2d');
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const colours = ['255,85,0', '45,212,191', '190,190,205', '255,154,61'];
  const LINK = 150; // people closer than this are joined by a faint line
  let W = 0;
  let H = 0;
  let dots = [];

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.max(40, Math.min(120, Math.round((W * H) / 20000)));
    dots = Array.from({ length: count }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.4,
      r: 2 + Math.pow(Math.random(), 3) * 16, // mostly small, a few big
      c: colours[Math.floor(Math.random() * colours.length)],
    }));
  }

  function frame() {
    ctx.fillStyle = '#121212';
    ctx.fillRect(0, 0, W, H);

    for (let i = 0; i < dots.length; i++) {
      const a = dots[i];
      for (let j = i + 1; j < dots.length; j++) {
        const b = dots[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > LINK) continue;
        ctx.strokeStyle = `rgba(${a.c},${(1 - d / LINK) * 0.22})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    for (const a of dots) {
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${a.c},0.14)`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${a.c},0.55)`;
      ctx.stroke();
      if (!still) {
        a.x += a.vx;
        a.y += a.vy;
        if (a.x < -20) a.x = W + 20;
        if (a.x > W + 20) a.x = -20;
        if (a.y < -20) a.y = H + 20;
        if (a.y > H + 20) a.y = -20;
      }
    }
    if (!still) requestAnimationFrame(frame);
  }

  window.addEventListener('resize', () => {
    resize();
    if (still) frame();
  });
  resize();
  frame();
})();
