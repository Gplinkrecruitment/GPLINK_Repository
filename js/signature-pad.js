// js/signature-pad.js
//
// Reusable canvas signature-capture component for the ANOM-00 "change of
// authorised representative" feature. Loaded as a plain <script> (no
// bundler) by both the RSO task card (pages/admin.html) and the doctor's
// signing page — and also `require`d directly by
// tests/ahpra-rep-change.test.js under Node, where there is no
// window/document/canvas at all.
//
// Adapted from the working prototype
// (docs/mockups/anom00-rep-change-prototype.html — see `initPad()` /
// `.sig-canvas`): same devicePixelRatio-aware backing store, same
// draw-a-line-per-move loop. On top of that prototype this adds:
//   - Pointer Events (mouse + touch + pen in one listener set) on browsers
//     that support them, falling back to the prototype's mouse+touch
//     listeners on older ones that don't.
//   - The { isEmpty, toPNG, clear } module interface below, so the pad can
//     be embedded anywhere without assuming any particular wrapper markup
//     or a global `sigStore`.
//   - toPNG() crops to the drawn ink bounds (+ padding) instead of
//     exporting the whole, mostly-blank canvas.
//
// Public interface (browser):
//   window.GPSignaturePad.attach(canvasEl, { onChange }) -> {
//     isEmpty(): boolean,
//     toPNG(): string,     // trimmed data:image/png, or '' when empty
//     clear(): void,
//     destroy(): void,     // stop listening (bonus, not part of the brief's
//                          // required contract, but attach() may be called
//                          // once per rendered task card, so this avoids
//                          // leaking window-level listeners over a long
//                          // admin session)
//   }
//   `onChange(isEmpty)` fires whenever the pad flips between empty and
//   signed (first stroke drawn, clear(), or an implicit clear caused by a
//   resize re-sizing the backing store) — not on every pointer move.
//
// Node-safe pure helper (exported for tests; also used internally by
// toPNG()):
//   trimBounds({ width, height, data }) -> { minX, minY, maxX, maxY } | null
//   `data` is an RGBA Uint8ClampedArray (or plain array) as returned by
//   CanvasRenderingContext2D#getImageData. Returns null when every pixel is
//   fully transparent (alpha === 0), i.e. nothing has been drawn.
//
// Guarding rule: nothing at module-evaluation time touches
// window/document/canvas — trimBounds() is pure math over a plain object,
// and attach() (the only DOM-touching function) throws immediately if
// called outside a browser instead of failing later on a stray DOM call.
// That is what makes `require('../js/signature-pad.js')` safe in Node.

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Pure helper — no DOM, unit-tested directly in Node.
  // ---------------------------------------------------------------------
  function trimBounds(imageDataLike) {
    var width = imageDataLike.width;
    var height = imageDataLike.height;
    var data = imageDataLike.data;
    var minX = null;
    var minY = null;
    var maxX = null;
    var maxY = null;

    for (var y = 0; y < height; y++) {
      var rowOffset = y * width;
      for (var x = 0; x < width; x++) {
        var alpha = data[(rowOffset + x) * 4 + 3];
        if (alpha > 0) {
          if (minX === null || x < minX) minX = x;
          if (minY === null || y < minY) minY = y;
          if (maxX === null || x > maxX) maxX = x;
          if (maxY === null || y > maxY) maxY = y;
        }
      }
    }

    if (minX === null) return null; // fully transparent — nothing drawn
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }

  // ---------------------------------------------------------------------
  // Browser-only drawing implementation.
  // ---------------------------------------------------------------------

  // CSS-pixel padding kept around the trimmed ink bounds in toPNG() output;
  // multiplied by devicePixelRatio at crop time so the visual padding is
  // consistent across low- and high-DPR devices.
  var PADDING_CSS_PX = 12;
  var STROKE_WIDTH = 2.4;
  var STROKE_STYLE = "#0f2c63";

  function attach(canvasEl, options) {
    if (typeof window === "undefined" || typeof document === "undefined") {
      throw new Error("GPSignaturePad.attach() requires a browser environment (window/document).");
    }
    if (!canvasEl) {
      throw new Error("GPSignaturePad.attach() requires a canvas element.");
    }

    options = options || {};
    var onChange = typeof options.onChange === "function" ? options.onChange : function () {};

    var ctx = null;
    var drawing = false;
    var dirty = false;
    var last = null;

    function setDirty(next) {
      if (dirty === next) return;
      dirty = next;
      onChange(!dirty);
    }

    function size() {
      var rect = canvasEl.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      var w = rect.width || canvasEl.clientWidth || 1;
      var h = rect.height || canvasEl.clientHeight || 1;
      canvasEl.width = w * dpr;
      canvasEl.height = h * dpr;
      ctx = canvasEl.getContext("2d");
      ctx.scale(dpr, dpr);
      ctx.lineWidth = STROKE_WIDTH;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = STROKE_STYLE;
    }

    function pos(evt) {
      var rect = canvasEl.getBoundingClientRect();
      var point = evt.touches && evt.touches.length ? evt.touches[0] : evt;
      return { x: point.clientX - rect.left, y: point.clientY - rect.top };
    }

    function start(evt) {
      drawing = true;
      last = pos(evt);
      if (evt.cancelable) evt.preventDefault();
    }

    function move(evt) {
      if (!drawing) return;
      var p = pos(evt);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
      setDirty(true);
      if (evt.cancelable) evt.preventDefault();
    }

    function end() {
      drawing = false;
    }

    function handleResize() {
      // A resize/orientation change reallocates the canvas backing store,
      // which wipes any ink already drawn onto it — reflect that via
      // isEmpty()/onChange() instead of leaving toPNG() to read a
      // now-blank canvas as if nothing changed.
      size();
      setDirty(false);
    }

    size();
    window.addEventListener("resize", handleResize);

    // Pointer Events unify mouse + touch + pen in one listener set on
    // modern browsers. Fall back to the prototype's mouse+touch listeners
    // on older engines that never fire pointer events.
    var usePointerEvents = typeof window.PointerEvent === "function";
    if (usePointerEvents) {
      canvasEl.addEventListener("pointerdown", start);
      canvasEl.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    } else {
      canvasEl.addEventListener("mousedown", start);
      canvasEl.addEventListener("mousemove", move);
      window.addEventListener("mouseup", end);
      canvasEl.addEventListener("touchstart", start, { passive: false });
      canvasEl.addEventListener("touchmove", move, { passive: false });
      canvasEl.addEventListener("touchend", end);
    }
    canvasEl.style.touchAction = "none";

    function isEmpty() {
      return !dirty;
    }

    function toPNG() {
      if (!dirty || !canvasEl.width || !canvasEl.height) return "";

      var imageData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
      var bounds = trimBounds(imageData);
      if (!bounds) return "";

      var pad = PADDING_CSS_PX * (window.devicePixelRatio || 1);
      var minX = Math.max(0, Math.floor(bounds.minX - pad));
      var minY = Math.max(0, Math.floor(bounds.minY - pad));
      var maxX = Math.min(canvasEl.width - 1, Math.ceil(bounds.maxX + pad));
      var maxY = Math.min(canvasEl.height - 1, Math.ceil(bounds.maxY + pad));
      var cropW = maxX - minX + 1;
      var cropH = maxY - minY + 1;

      var out = document.createElement("canvas");
      out.width = cropW;
      out.height = cropH;
      out.getContext("2d").drawImage(canvasEl, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
      return out.toDataURL("image/png");
    }

    function clear() {
      if (ctx) ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      setDirty(false);
    }

    function destroy() {
      window.removeEventListener("resize", handleResize);
      if (usePointerEvents) {
        canvasEl.removeEventListener("pointerdown", start);
        canvasEl.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
      } else {
        canvasEl.removeEventListener("mousedown", start);
        canvasEl.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", end);
        canvasEl.removeEventListener("touchstart", start);
        canvasEl.removeEventListener("touchmove", move);
        canvasEl.removeEventListener("touchend", end);
      }
    }

    return { isEmpty: isEmpty, toPNG: toPNG, clear: clear, destroy: destroy };
  }

  var GPSignaturePad = { trimBounds: trimBounds, attach: attach };

  // CommonJS (Node tests) — guarded so a plain <script> load in the browser
  // (where `module` does not exist; this app ships with no bundler) never
  // takes this branch.
  if (typeof module === "object" && module.exports) {
    module.exports = GPSignaturePad;
  }
  // Browser global — guarded so `require()` in Node never touches `window`.
  if (typeof window !== "undefined") {
    window.GPSignaturePad = GPSignaturePad;
  }
})();
