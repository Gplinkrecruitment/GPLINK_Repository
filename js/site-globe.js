/* ==========================================================================
   GP Link — network globe animation (standalone, framework-free).
   Ported from the supplied Design-Combo scene (globe-scene.jsx): a spinning
   dotted earth with country borders and pulsing #1d52db arcs from the UK,
   Ireland and New Zealand converging on Australia. The original ran on
   React + Babel via a CDN; this port drops all of that — a tiny element→SVG
   string builder replaces React.createElement and a plain requestAnimationFrame
   loop replaces the scene runtime. Mounts on every [data-globe] element.
   ========================================================================== */
(function () {
  "use strict";

  var mounts = document.querySelectorAll("[data-globe]");
  if (!mounts.length) return;

  var reduceMotion = false;
  try { reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  var GEO_URL = "/media/globe/countries.geo.json";
  var LOOP = 12; // seconds — matches the scene's single "Orbit Loop" duration

  // ── constants / projection (verbatim from the scene) ──────────────────────
  var BLUE = "#1d52db", RAD = Math.PI / 180;
  var TILT = -22 * RAD, ST = Math.sin(TILT), CT = Math.cos(TILT);
  var CX = 1000, CY = 462, R = 330, START_LON = -20, W = 1600, H = 900;
  // Tight view box around the globe + arcs (measured across a full loop:
  // content spans x[558,1442] y[29,792], centred on x=1000) so the globe fills
  // the frame instead of floating in empty margin. The container's css
  // aspect-ratio matches VB's ratio (910/786).
  var VB = { x: 545, y: 16, w: 910, h: 786 };

  var clamp01 = function (v) { return Math.max(0, Math.min(1, v)); };
  var ss = function (a, b, x) { var t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

  function ll2vec(lat, lon) {
    var phi = lat * RAD, lam = lon * RAD, cp = Math.cos(phi);
    return [cp * Math.cos(lam), Math.sin(phi), cp * Math.sin(lam)];
  }
  function projVec(v, rot, rho) {
    var cr = Math.cos(rot), sr = Math.sin(rot);
    var x = v[2] * cr + v[0] * sr;
    var z0 = v[0] * cr - v[2] * sr;
    var y = v[1] * CT - z0 * ST;
    var z = v[1] * ST + z0 * CT;
    return { X: CX + R * rho * x, Y: CY - R * rho * y, z: z, d2: x * x + y * y };
  }

  // ── geo data → dot grid + Australia rings (verbatim, vanilla) ─────────────
  function buildGeo(geo) {
    var MW = 720, MH = 360;
    var mk = function () { var c = document.createElement("canvas"); c.width = MW; c.height = MH; return c; };
    var lc = mk(), bc = mk();
    var lx = lc.getContext("2d", { willReadFrequently: true });
    var bx = bc.getContext("2d", { willReadFrequently: true });
    var trace = function (ctx, rings) {
      ctx.beginPath();
      for (var r = 0; r < rings.length; r++) {
        var ring = rings[r];
        for (var i = 0; i < ring.length; i++) {
          var x = (ring[i][0] + 180) * 2, y = (90 - ring[i][1]) * 2;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.closePath();
      }
    };
    lx.fillStyle = "#fff";
    bx.strokeStyle = "#fff"; bx.lineWidth = 3.2; bx.lineJoin = "round";
    var ausRings = [];
    for (var fi = 0; fi < geo.features.length; fi++) {
      var f = geo.features[fi], g = f.geometry;
      if (!g) continue;
      var polys = g.type === "Polygon" ? [g.coordinates] : (g.type === "MultiPolygon" ? g.coordinates : []);
      for (var pi = 0; pi < polys.length; pi++) {
        var rings = polys[pi];
        trace(lx, rings); lx.fill();
        trace(bx, rings); bx.stroke();
        if (f.id === "AUS" && rings[0].length > 30) {
          var outer = rings[0], dec = [];
          var step = Math.max(1, Math.floor(outer.length / 160));
          for (var oi = 0; oi < outer.length; oi += step) dec.push(ll2vec(outer[oi][1], outer[oi][0]));
          dec.push(dec[0]);
          ausRings.push(dec);
        }
      }
    }
    var ld = lx.getImageData(0, 0, MW, MH).data;
    var bd = bx.getImageData(0, 0, MW, MH).data;
    var dots = [];
    for (var lat = -56; lat <= 84; lat += 2) {
      var span = 2 / Math.max(0.2, Math.cos(lat * RAD));
      for (var lon = -180; lon < 180; lon += span) {
        var px = Math.min(MW - 1, Math.round((lon + 180) * 2));
        var py = Math.min(MH - 1, Math.round((90 - lat) * 2));
        var a = (py * MW + px) * 4 + 3;
        if (ld[a] > 100) dots.push([ll2vec(lat, lon), bd[a] > 100 ? 1 : 0]);
      }
    }
    return { dots: dots, ausRings: ausRings };
  }

  // ── theme (light — blends into the visa section's pale background) ────────
  var theme = {
    sea: "#eef1f7", seaEdge: "#dde3ee",
    dot: "#a6b0c4", border: "#15181f",
    shadow: "rgba(25,35,70,0.10)", hi: "rgba(255,255,255,0.75)"
  };
  var fillStyle = "spread";

  // ── routes ────────────────────────────────────────────────────────────────
  var DEST = { lat: -24.6, lon: 134.4 };
  var ORIGINS = [
    { lat: 51.5, lon: -0.12 },   // UK
    { lat: 53.35, lon: -6.26 },  // Ireland
    { lat: -36.85, lon: 174.76 } // NZ
  ];
  var DESTV = ll2vec(DEST.lat, DEST.lon);
  var ROUTES = ORIGINS.map(function (o, i) {
    var A = ll2vec(o.lat, o.lon);
    var dot = A[0] * DESTV[0] + A[1] * DESTV[1] + A[2] * DESTV[2];
    var om = Math.acos(Math.max(-1, Math.min(1, dot)));
    return { A: A, om: om, so: Math.sin(om), h: 0.10 + 0.30 * (om / 2.4), phase: i / 3 };
  });
  function routePoint(rt, s, rot) {
    var k1 = Math.sin((1 - s) * rt.om) / rt.so, k2 = Math.sin(s * rt.om) / rt.so;
    var u = [rt.A[0] * k1 + DESTV[0] * k2, rt.A[1] * k1 + DESTV[1] * k2, rt.A[2] * k1 + DESTV[2] * k2];
    var n = Math.hypot(u[0], u[1], u[2]);
    var rho = (1 + rt.h * Math.sin(Math.PI * s)) / n;
    return projVec(u, rot, rho);
  }
  var visible = function (pt, rho) { return pt.z > 0 || pt.d2 * rho * rho > 1.002; };

  // ── tiny element → SVG-string builder (replaces React.createElement) ──────
  var ATTR = {
    strokeWidth: "stroke-width", strokeLinecap: "stroke-linecap", strokeLinejoin: "stroke-linejoin",
    strokeDasharray: "stroke-dasharray", strokeDashoffset: "stroke-dashoffset",
    stopColor: "stop-color", clipPath: "clip-path"
  };
  function esc(v) {
    return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function styleStr(o) {
    var s = "";
    for (var k in o) {
      if (o[k] == null) continue;
      var kk = k.replace(/[A-Z]/g, function (m) { return "-" + m.toLowerCase(); });
      s += kk + ":" + o[k] + ";";
    }
    return s;
  }
  function h(tag, props) {
    var out = "<" + tag;
    if (props) {
      for (var k in props) {
        if (k === "key") continue;
        var v = props[k];
        if (v == null || v === false) continue;
        if (k === "style") { out += ' style="' + esc(styleStr(v)) + '"'; continue; }
        out += " " + (ATTR[k] || k) + '="' + esc(v) + '"';
      }
    }
    out += ">";
    for (var i = 2; i < arguments.length; i++) out += flat(arguments[i]);
    return out + "</" + tag + ">";
  }
  function flat(c) {
    if (c == null || c === false) return "";
    if (typeof c === "string") return c;
    if (Array.isArray(c)) { var s = ""; for (var i = 0; i < c.length; i++) s += flat(c[i]); return s; }
    return String(c);
  }

  // ── one frame → SVG string (ported from OrbitLoop) ────────────────────────
  function renderFrame(geo, t, p) {
    var rot = -(START_LON + 360 * p) * RAD;

    var landPath = "", borderPath = "";
    var ausPath = "", ausMinY = 1e9, ausMaxY = -1e9, ausMinX = 1e9, ausMaxX = -1e9, ausVis = 0;

    var lp = [], bp = [], i;
    for (i = 0; i < geo.dots.length; i++) {
      var d = geo.dots[i];
      var pt = projVec(d[0], rot, 1);
      if (pt.z <= 0.015) continue;
      var sq = (d[1] ? 2.1 : 1.7) * (0.55 + 0.45 * pt.z);
      var seg = "M" + (pt.X - sq).toFixed(1) + " " + (pt.Y - sq).toFixed(1) +
        "h" + (2 * sq).toFixed(1) + "v" + (2 * sq).toFixed(1) + "h-" + (2 * sq).toFixed(1) + "z";
      (d[1] ? bp : lp).push(seg);
    }
    landPath = lp.join(""); borderPath = bp.join("");

    var ap = [];
    for (var ri = 0; ri < geo.ausRings.length; ri++) {
      var ring = geo.ausRings[ri], run = null;
      for (var vi = 0; vi < ring.length; vi++) {
        var apt = projVec(ring[vi], rot, 1);
        if (apt.z > 0.005) {
          run = run ? run + "L" + apt.X.toFixed(1) + " " + apt.Y.toFixed(1)
                    : "M" + apt.X.toFixed(1) + " " + apt.Y.toFixed(1);
          if (apt.Y < ausMinY) ausMinY = apt.Y; if (apt.Y > ausMaxY) ausMaxY = apt.Y;
          if (apt.X < ausMinX) ausMinX = apt.X; if (apt.X > ausMaxX) ausMaxX = apt.X;
          ausVis++;
        } else if (run) { ap.push(run); run = null; }
      }
      if (run) ap.push(run + "Z");
    }
    ausPath = ap.join("");

    var zAus = projVec(DESTV, rot, 1).z;
    var e = ss(0.26, 0.5, p) * clamp01(zAus / 0.18);

    // arcs + comets
    var arcs = ROUTES.map(function (rt, idx) {
      var zo = projVec(rt.A, rot, 1).z;
      var op = ss(0.02, 0.22, Math.max(zo, zAus));
      if (op < 0.02) return "";
      var segs = [], run2 = null, k;
      for (k = 0; k <= 64; k++) {
        var s = k / 64;
        var pt2 = routePoint(rt, s, rot);
        var rho = 1 + rt.h * Math.sin(Math.PI * s);
        if (visible(pt2, rho)) {
          run2 = run2 ? run2 + "L" + pt2.X.toFixed(1) + " " + pt2.Y.toFixed(1)
                      : "M" + pt2.X.toFixed(1) + " " + pt2.Y.toFixed(1);
        } else if (run2) { segs.push(run2); run2 = null; }
      }
      if (run2) segs.push(run2);
      if (!segs.length) return "";

      var comets = [];
      for (k = 0; k < 3; k++) {
        var cs = (4 * p + rt.phase + k / 3) % 1;
        var cp = routePoint(rt, cs, rot);
        var crho = 1 + rt.h * Math.sin(Math.PI * cs);
        if (!visible(cp, crho)) continue;
        var fade = Math.min(1, 6 * cs * (1 - cs) + 0.25);
        comets.push(
          h("circle", { cx: cp.X, cy: cp.Y, r: 11, fill: BLUE, opacity: 0.22 * op * fade }),
          h("circle", { cx: cp.X, cy: cp.Y, r: 4.2, fill: BLUE, opacity: op * fade })
        );
      }
      return h("g", null,
        h("path", { d: segs.join(""), fill: "none", stroke: BLUE, strokeWidth: 2.4, strokeLinecap: "round", opacity: 0.32 * op }),
        h("path", {
          d: segs.join(""), fill: "none", stroke: BLUE, strokeWidth: 2.4, strokeLinecap: "round",
          opacity: 0.85 * op, strokeDasharray: "4 14", strokeDashoffset: -(t * 36)
        }),
        comets
      );
    });

    // origin + destination pulse markers
    var phase = t % 1;
    var markerVecs = ORIGINS.map(function (o) { return ll2vec(o.lat, o.lon); });
    markerVecs.push(DESTV);
    var markers = markerVecs.map(function (v) {
      var pt3 = projVec(v, rot, 1);
      if (pt3.z < 0.05) return "";
      var f = ss(0.05, 0.25, pt3.z);
      return h("g", null,
        h("circle", { cx: pt3.X, cy: pt3.Y, r: 3, fill: BLUE, opacity: f }),
        h("circle", {
          cx: pt3.X, cy: pt3.Y, r: 4 + 12 * phase, fill: "none", stroke: BLUE,
          strokeWidth: 1.6 * (1 - phase), opacity: f * (1 - phase) * 0.8
        })
      );
    });

    // Australia fill (spread treatment)
    var fill = "";
    if (ausVis > 4 && e > 0.01) {
      var outline = h("path", { d: ausPath, fill: "none", stroke: BLUE, strokeWidth: 2.2, strokeLinejoin: "round", opacity: e });
      var clip = h("defs", null, h("clipPath", { id: "ausClip" }, h("path", { d: ausPath })));
      var dp = projVec(DESTV, rot, 1);
      var rMax = Math.max(
        Math.hypot(ausMinX - dp.X, ausMinY - dp.Y), Math.hypot(ausMaxX - dp.X, ausMinY - dp.Y),
        Math.hypot(ausMinX - dp.X, ausMaxY - dp.Y), Math.hypot(ausMaxX - dp.X, ausMaxY - dp.Y)
      ) + 12;
      fill = h("g", null, clip,
        h("g", { clipPath: "url(#ausClip)" },
          h("circle", { cx: dp.X, cy: dp.Y, r: e * rMax * 1.12, fill: BLUE, opacity: 0.3 }),
          h("circle", { cx: dp.X, cy: dp.Y, r: e * rMax, fill: BLUE, opacity: 0.92 })
        ), outline);
    }

    return h("svg", { width: "100%", height: "100%", viewBox: VB.x + " " + VB.y + " " + VB.w + " " + VB.h, preserveAspectRatio: "xMidYMid meet" },
      h("defs", null,
        h("radialGradient", { id: "sphereHi", cx: "38%", cy: "30%", r: "75%" },
          h("stop", { offset: "0%", stopColor: theme.hi }),
          h("stop", { offset: "60%", stopColor: "rgba(255,255,255,0)" })
        )
      ),
      h("circle", { cx: CX, cy: CY, r: R, fill: theme.sea, stroke: theme.seaEdge, strokeWidth: 1.5 }),
      h("path", { d: landPath, fill: theme.dot }),
      h("path", { d: borderPath, fill: theme.border }),
      h("circle", { cx: CX, cy: CY, r: R, fill: "url(#sphereHi)" }),
      fill,
      arcs,
      markers
    );
  }

  // pick the progress where Australia faces us most — used for the static
  // (reduced-motion) frame.
  function bestStaticP() {
    var best = 0, bestZ = -2;
    for (var i = 0; i <= 60; i++) {
      var p = i / 60;
      var rot = -(START_LON + 360 * p) * RAD;
      var z = projVec(DESTV, rot, 1).z;
      if (z > bestZ) { bestZ = z; best = p; }
    }
    // nudge just past the fill threshold so the Australia treatment shows
    return Math.max(best, 0.5);
  }

  function start(geoRaw) {
    var geo = buildGeo(geoRaw);

    mounts.forEach(function (mount) {
      if (reduceMotion) {
        var sp = bestStaticP();
        mount.innerHTML = renderFrame(geo, sp * LOOP, sp);
        return;
      }
      var t0 = null, raf = 0, running = false, last = -1;
      var MIN_MS = 1000 / 30; // cap at ~30fps — the rotation is slow, this halves cost
      function frame(now) {
        if (!running) return;
        if (t0 == null) { t0 = now; last = -1; }
        if (last < 0 || now - last >= MIN_MS) {
          last = now;
          var el = (now - t0) / 1000;
          var p = (el % LOOP) / LOOP, t = p * LOOP;
          mount.innerHTML = renderFrame(geo, t, p);
        }
        raf = requestAnimationFrame(frame);
      }
      function play() { if (running) return; running = true; t0 = null; raf = requestAnimationFrame(frame); }
      function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }

      // render one frame immediately so it's never blank, then animate only
      // while on-screen.
      mount.innerHTML = renderFrame(geo, 0, 0);
      if ("IntersectionObserver" in window) {
        new IntersectionObserver(function (entries) {
          entries.forEach(function (en) { en.isIntersecting ? play() : stop(); });
        }, { rootMargin: "160px" }).observe(mount);
      } else {
        play();
      }
    });
  }

  fetch(GEO_URL)
    .then(function (r) { if (!r.ok) throw new Error("geo " + r.status); return r.json(); })
    .then(start)
    .catch(function (err) {
      // Leave the mount empty on failure; the section still reads fine without it.
      if (window.console) console.error("[site-globe] load failed", err);
    });
})();
