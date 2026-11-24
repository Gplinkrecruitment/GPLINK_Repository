/* GP Link — one reliable way to download a document, on every GP page.
 *
 * Why this exists (24 Nov 2026, Dr Hatice Akkas — "This content is blocked. Contact the
 * site owner to fix the issue."): GP pages run inside the app-shell <iframe>. A plain
 * <a href="/api/…/download"> NAVIGATES that iframe; the endpoint answers with a redirect
 * to the file store (a different origin), which the site's own security policy
 * (CSP frame-src) refuses to show inside a frame. Every Download button on My Documents
 * ended on Chrome's grey "content is blocked" page.
 *
 * A download must never navigate the frame. This file:
 *   1. exposes window.gpDownloadFile(url, name) — fetches the file in the background and
 *      saves it through a blob link (works in the iframe, on iOS, and for any file type);
 *      if the fetch is impossible it opens the file in a NEW top-level tab, which the
 *      frame policy does not apply to.
 *   2. intercepts clicks on any link to one of our download endpoints, so a link added
 *      later is safe by default (tests/gp-download-links.test.js enforces the include).
 */
(function () {
  "use strict";
  if (window.gpDownloadFile) return;

  var DOWNLOAD_PATH = /^\/api\/[a-z0-9\/-]*download(?:$|[\/?#])/i;

  function extFromMime(mime) {
    var m = String(mime || "").split(";")[0].trim().toLowerCase();
    var map = {
      "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
      "image/heic": ".heic", "image/heif": ".heif", "image/webp": ".webp", "image/gif": ".gif",
      "application/msword": ".doc",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
      "application/vnd.ms-excel": ".xls",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
      "application/zip": ".zip", "text/plain": ".txt", "text/csv": ".csv"
    };
    return map[m] || "";
  }

  function cleanName(name) {
    return String(name || "").replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150);
  }

  // filename from a Content-Disposition header (only readable on same-origin responses).
  function nameFromDisposition(header) {
    var h = String(header || "");
    var star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(h);
    if (star) { try { return cleanName(decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""))); } catch (e) {} }
    var plain = /filename\s*=\s*"?([^";]+)"?/i.exec(h);
    return plain ? cleanName(plain[1]) : "";
  }

  // The name the file is saved under: server-given name, else the caller's label, always
  // ending in the extension that matches what the file really is.
  function resolveFileName(suggested, disposition, mime) {
    var name = nameFromDisposition(disposition) || cleanName(suggested) || "document";
    var ext = extFromMime(mime);
    if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
    return name + (ext || ".pdf");
  }

  function isDownloadHref(href) {
    if (!href) return false;
    try {
      var u = new URL(href, window.location.href);
      return u.origin === window.location.origin && DOWNLOAD_PATH.test(u.pathname);
    } catch (e) { return false; }
  }

  function openInNewTab(url) {
    try {
      var a = document.createElement("a");
      a.href = url; a.target = "_blank"; a.rel = "noopener";
      a.style.display = "none";
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) {
      try { window.open(url, "_blank", "noopener"); } catch (e2) {}
    }
  }

  function saveBlob(blob, fileName) {
    var blobUrl = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = blobUrl; a.download = fileName; a.style.display = "none";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 15000);
  }

  // Resolves { ok:true, fileName } when saved, { ok:false, opened:true } when it had to
  // fall back to a new tab, { ok:false, status } when the server said no (e.g. 404).
  async function gpDownloadFile(url, suggestedName) {
    var resp;
    try {
      resp = await fetch(url, { credentials: "same-origin" });
    } catch (e) {
      openInNewTab(url);
      return { ok: false, opened: true };
    }
    if (!resp.ok) return { ok: false, status: resp.status };
    var blob;
    try { blob = await resp.blob(); } catch (e) { openInNewTab(url); return { ok: false, opened: true }; }
    var fileName = resolveFileName(suggestedName, resp.headers.get("content-disposition"), blob.type || resp.headers.get("content-type"));
    saveBlob(blob, fileName);
    return { ok: true, fileName: fileName };
  }

  function notify(message) {
    try {
      if (typeof window.showToast === "function") { window.showToast(message); return; }
    } catch (e) {}
    var el = document.createElement("div");
    el.textContent = message;
    el.setAttribute("role", "status");
    el.style.cssText = "position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:99999;background:#0f172a;color:#fff;padding:10px 16px;border-radius:10px;font:600 13px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(15,23,42,.25);max-width:88vw;text-align:center";
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 4500);
  }

  // Any link to a download endpoint: download in place instead of navigating the frame.
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href");
    if (!isDownloadHref(href)) return;
    e.preventDefault();
    if (a.getAttribute("data-gp-downloading") === "1") return;
    a.setAttribute("data-gp-downloading", "1");
    a.setAttribute("aria-busy", "true");
    var suggested = a.getAttribute("download") || a.getAttribute("data-download-name") || "";
    gpDownloadFile(a.href, suggested).then(function (r) {
      if (!r.ok && !r.opened) {
        notify(r.status === 404
          ? "That file isn't available yet. Please message your Registration Support Officer."
          : "We couldn't download that file just now. Please try again.");
      }
    }).catch(function () {
      notify("We couldn't download that file just now. Please try again.");
    }).then(function () {
      a.removeAttribute("data-gp-downloading");
      a.removeAttribute("aria-busy");
    });
  }, true);

  window.gpDownloadFile = gpDownloadFile;
  window.gpDownload = { file: gpDownloadFile, isDownloadHref: isDownloadHref, resolveFileName: resolveFileName, extFromMime: extFromMime };
})();
