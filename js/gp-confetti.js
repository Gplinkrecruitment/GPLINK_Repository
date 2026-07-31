/* GP Link — one confetti burst, shared.
 *
 * Extracted from pages/offer-review.html (which had the only copy) so the
 * careers page can mark the same moment the same way. There are exactly two
 * moments in this product worth confetti — a contract arriving, and a placement
 * being secured — and they should not look like two different products.
 *
 * Deliberately dependency-free and canvas-based: the pages that use it are
 * plain HTML with inline scripts and no build step.
 *
 * Usage:
 *   gpConfetti.launch();                                  // brand palette
 *   gpConfetti.launch({ palette: gpConfetti.GOLD });       // black + gold
 *   gpConfetti.launch({ palette: [...], pieces: 160, durationMs: 3200 });
 *
 * Respects prefers-reduced-motion: the burst is skipped entirely rather than
 * shortened, because the whole thing IS the motion.
 */
(function (root) {
  'use strict';

  var BRAND = ['#2563eb', '#22c55e', '#f59e0b', '#ef4444', '#a855f7'];
  // Black and gold, for the contract moment. Three golds so the fall reads as
  // metallic rather than one flat yellow, plus near-black flecks for contrast
  // against a light page.
  var GOLD = ['#d4af37', '#f2cf63', '#b8860b', '#1a1a1a', '#3d3527', '#fff3c4'];

  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  function launch(options) {
    var opts = options || {};
    if (prefersReducedMotion()) return;

    var palette = (Array.isArray(opts.palette) && opts.palette.length) ? opts.palette : BRAND;
    var count = Number(opts.pieces) > 0 ? Number(opts.pieces) : 140;
    var durationMs = Number(opts.durationMs) > 0 ? Number(opts.durationMs) : 2800;

    var canvas = document.createElement('canvas');
    canvas.className = 'gp-confetti-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;';
    document.body.appendChild(canvas);

    var ctx = canvas.getContext('2d');
    if (!ctx) { if (canvas.parentNode) canvas.parentNode.removeChild(canvas); return; }

    function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
    resize();
    window.addEventListener('resize', resize);

    var pieces = [];
    for (var i = 0; i < count; i++) {
      pieces.push({
        x: Math.random() * canvas.width,
        y: -20 - Math.random() * canvas.height * 0.5,
        w: 6 + Math.random() * 6,
        h: 4 + Math.random() * 8,
        color: palette[Math.floor(Math.random() * palette.length)],
        vx: (Math.random() - 0.5) * 2.2,
        vy: 2 + Math.random() * 3.2,
        rotation: Math.random() * 360,
        vr: (Math.random() - 0.5) * 12
      });
    }

    var startTs = null;
    function frame(ts) {
      if (!startTs) startTs = ts;
      var elapsed = ts - startTs;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (var i = 0; i < pieces.length; i++) {
        var p = pieces[i];
        p.x += p.vx; p.y += p.vy; p.rotation += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (elapsed < durationMs) {
        requestAnimationFrame(frame);
      } else {
        window.removeEventListener('resize', resize);
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
    }
    requestAnimationFrame(frame);
  }

  root.gpConfetti = { launch: launch, BRAND: BRAND, GOLD: GOLD };
}(typeof window !== 'undefined' ? window : this));
