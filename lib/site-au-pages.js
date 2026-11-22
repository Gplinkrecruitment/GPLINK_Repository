'use strict';

/**
 * Public website pages and the Australian-GP switch (WP-21).
 * Read docs/au-gp/CONVENTIONS.md section 34 before editing a pages/site-*.html
 * file or pages/blog.html.
 *
 * The problem. Site pages are plain HTML files. Editing one changes the live
 * public site the moment the branch is merged, whatever the switch says.
 *
 * The answer. A site page may carry marker comments. The server resolves them
 * every time it serves a site page (server.js `serveSitePage`):
 *
 *   <!--au:on-->  ...  <!--/au:on-->     exists only with the switch ON
 *   <!--au:off--> ...  <!--/au:off-->    today's content, replaced when it is ON
 *   <!--au:part NAME--> ... <!--/au:part-->
 *                                        names a stretch of a page so another
 *                                        page can reuse it (the markers vanish;
 *                                        the content stays where it is)
 *   <!--au:use FILE#NAME-->              switch ON only: the named part of
 *                                        pages/FILE, as that page serves it
 *                                        with the switch on
 *   <!--au:var NAME-->                   switch ON only: a value the server
 *                                        supplies for this request (HTML-escaped)
 *
 * Every marker is removed from what is served, in both states. A marker eats
 * nothing but itself: put the line break INSIDE the block, so that with the
 * switch off the bytes that remain are exactly the bytes on `main`
 * (tests/au-wp21-site-switch-off-bytes.test.js compares every page).
 *
 * Markers do not nest. A page whose markers are unbalanced, nested or unknown
 * fails a test; in production it is served as the switch-OFF page (best
 * effort) and the error is logged. A page that exists only for the Australian
 * build is then not served at all.
 *
 * Pure except for `renderPageFile`, which reads files under pages/.
 */

const fs = require('fs');
const path = require('path');

// New pages that exist only with the switch on. Route -> backing file. With
// the switch off these routes and files answer exactly as an unknown address.
const AU_ONLY_SITE_ROUTES = Object.freeze({
  '/australian-gps': 'pages/site-australian-gps.html',
  '/australian-gps/changing-practices': 'pages/site-au-changing-practices.html',
});
const AU_ONLY_FILE_TO_ROUTE = Object.freeze(Object.fromEntries(
  Object.entries(AU_ONLY_SITE_ROUTES).map(([route, file]) => ['/' + file, route])
));

const SITE_PAGE_PATH = /^\/pages\/(?:site-[a-z0-9-]+|blog)\.html$/;

/** '/pages/site-home.html', '/pages/blog.html' ... (the backing-file path). */
function isSitePagePath(pathname) {
  return SITE_PAGE_PATH.test(String(pathname || ''));
}
function isAuOnlyPagePath(pathname) {
  return Object.prototype.hasOwnProperty.call(AU_ONLY_FILE_TO_ROUTE, String(pathname || ''));
}
/** The backing file ('/pages/…') for an Australian-only route, or ''. */
function auOnlyFileForRoute(route) {
  const key = String(route || '');
  return Object.prototype.hasOwnProperty.call(AU_ONLY_SITE_ROUTES, key) ? '/' + AU_ONLY_SITE_ROUTES[key] : '';
}
function auOnlyRouteForFile(pathname) {
  return isAuOnlyPagePath(pathname) ? AU_ONLY_FILE_TO_ROUTE[String(pathname)] : '';
}
function auOnlyRoutes() {
  return Object.keys(AU_ONLY_SITE_ROUTES);
}

// ── Markers ────────────────────────────────────────────────────────────────

// Anything that looks like one of ours, well formed or not.
const MARKER = /<!--(\/?)au:([^>]*?)-->/g;
const PART_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const USE_REF = /^((?:site-[a-z0-9-]+|blog)\.html)#([a-z][a-z0-9-]{0,40})$/;
const VAR_NAME = /^[a-z][a-zA-Z0-9]{0,30}$/;

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * Splits a page into pieces.
 * @returns {{ ok: boolean, errors: string[], pieces: Array, parts: Object }}
 *   pieces: { kind: 'text', text, mode: null | 'on' | 'off', part: string | null }
 *           { kind: 'use', file, name, mode, part } | { kind: 'var', name, mode, part }
 *   parts:  name -> true (every part the page defines)
 */
function parseMarkers(source) {
  const src = String(source == null ? '' : source);
  const errors = [];
  const pieces = [];
  const parts = {};
  let mode = null;       // inside <!--au:on--> / <!--au:off-->
  let part = null;       // inside <!--au:part NAME-->
  let last = 0;
  const push = (text) => { if (text) pieces.push({ kind: 'text', text, mode, part }); };
  MARKER.lastIndex = 0;
  let m;
  while ((m = MARKER.exec(src)) !== null) {
    push(src.slice(last, m.index));
    last = m.index + m[0].length;
    const closing = m[1] === '/';
    const body = m[2];
    const at = 'line ' + lineOf(src, m.index);
    const sp = body.indexOf(' ');
    const word = sp === -1 ? body : body.slice(0, sp);
    const arg = sp === -1 ? '' : body.slice(sp + 1).trim();
    if (word === 'on' || word === 'off') {
      if (arg) { errors.push(at + ': "' + m[0] + '" takes no argument'); continue; }
      if (!closing) {
        if (mode) errors.push(at + ': <!--au:' + word + '--> opened inside <!--au:' + mode + '--> (markers do not nest)');
        else mode = word;
      } else if (mode !== word) {
        errors.push(at + ': <!--/au:' + word + '--> with no matching <!--au:' + word + '-->');
      } else {
        mode = null;
      }
    } else if (word === 'part') {
      if (!closing) {
        if (part || mode) errors.push(at + ': <!--au:part--> must open outside every other marker');
        else if (!PART_NAME.test(arg)) errors.push(at + ': bad part name "' + arg + '"');
        else if (parts[arg]) errors.push(at + ': part "' + arg + '" is defined twice');
        else { part = arg; parts[arg] = true; }
      } else if (!part || arg) {
        errors.push(at + ': <!--/au:part--> with no matching <!--au:part NAME-->');
      } else if (mode) {
        errors.push(at + ': <!--/au:part--> inside an open <!--au:' + mode + '-->');
      } else {
        part = null;
      }
    } else if (word === 'use' && !closing) {
      const ref = USE_REF.exec(arg);
      if (!ref) errors.push(at + ': bad <!--au:use FILE#NAME--> reference "' + arg + '"');
      else pieces.push({ kind: 'use', file: ref[1], name: ref[2], mode, part });
    } else if (word === 'var' && !closing) {
      if (!VAR_NAME.test(arg)) errors.push(at + ': bad <!--au:var NAME--> "' + arg + '"');
      else pieces.push({ kind: 'var', name: arg, mode, part });
    } else {
      errors.push(at + ': unknown marker "' + m[0] + '"');
    }
  }
  push(src.slice(last));
  if (mode) errors.push('end of page: <!--au:' + mode + '--> is never closed');
  if (part) errors.push('end of page: <!--au:part ' + part + '--> is never closed');
  return { ok: errors.length === 0, errors, pieces, parts };
}

function escapeHtmlAttr(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// What is left with the switch off. Used for the real switch-off page and as
// the fallback for a page whose markers are broken: everything inside an
// au:on block goes, every marker goes, nothing is pulled in from elsewhere.
function offText(pieces) {
  let out = '';
  for (const p of pieces) if (p.kind === 'text' && p.mode !== 'on') out += p.text;
  return out;
}

/**
 * Renders one page's source.
 *
 * @param {string} source
 * @param {{ on: boolean, vars?: Object, resolvePart?: (file, name) => (string|null), auOnly?: boolean, onlyPart?: string }} opts
 *   auOnly: the page exists only with the switch on, so `use` / `var` may sit
 *           outside an au:on block.
 * @returns {{ html: string, ok: boolean, errors: string[] }}
 *   ok false: `html` is the switch-off page (best effort).
 */
function renderSource(source, opts) {
  const o = opts || {};
  const parsed = parseMarkers(source);
  const errors = parsed.errors.slice();
  const wanted = (p) => !o.onlyPart || p.part === o.onlyPart;
  if (o.onlyPart && !parsed.parts[o.onlyPart]) errors.push('no part named "' + o.onlyPart + '"');

  // A `use` or `var` only means something with the switch on. In a page that
  // is also served with the switch off it must therefore sit inside au:on.
  if (!o.auOnly) {
    for (const p of parsed.pieces) {
      if ((p.kind === 'use' || p.kind === 'var') && p.mode !== 'on') {
        errors.push('<!--au:' + p.kind + '--> outside an <!--au:on--> block');
      }
    }
  }
  if (errors.length) return { html: offText(parsed.pieces.filter(wanted)), ok: false, errors };
  if (!o.on) return { html: offText(parsed.pieces.filter(wanted)), ok: true, errors: [] };

  let out = '';
  for (const p of parsed.pieces) {
    if (!wanted(p) || p.mode === 'off') continue;
    if (p.kind === 'text') { out += p.text; continue; }
    if (p.kind === 'var') {
      const vars = o.vars || {};
      if (!Object.prototype.hasOwnProperty.call(vars, p.name)) errors.push('no value for <!--au:var ' + p.name + '-->');
      else out += escapeHtmlAttr(vars[p.name]);
      continue;
    }
    // use
    const got = typeof o.resolvePart === 'function' ? o.resolvePart(p.file, p.name) : null;
    if (typeof got !== 'string') errors.push('cannot resolve <!--au:use ' + p.file + '#' + p.name + '-->');
    else out += got;
  }
  if (errors.length) return { html: offText(parsed.pieces.filter(wanted)), ok: false, errors };
  return { html: out, ok: true, errors: [] };
}

// ── Files ──────────────────────────────────────────────────────────────────

const _cache = new Map();   // key -> { stamp, result }

function statStamp(file) {
  const st = fs.statSync(file);
  return file + ':' + st.size + ':' + Math.floor(st.mtimeMs);
}

/**
 * Renders a site page file for one switch state. Cached in memory per page,
 * per state, per set of values; re-read when the file (or a file it pulls a
 * part from) changes on disk.
 *
 * @param {string} pagePath '/pages/site-home.html'
 * @param {{ on: boolean, vars?: Object, root?: string }} opts
 * @returns {{ html: string, body: Buffer, ok: boolean, errors: string[], etag: string, mtimeMs: number } | null}
 *   null: not a site page, or no such file.
 */
function renderPageFile(pagePath, opts) {
  const o = opts || {};
  const rel = String(pagePath || '');
  if (!isSitePagePath(rel)) return null;
  const root = o.root || process.cwd();
  const file = path.join(root, rel.slice(1));
  const on = !!o.on;
  const vars = o.vars && typeof o.vars === 'object' ? o.vars : {};
  const key = file + '|' + (on ? 'on' : 'off') + '|' + JSON.stringify(vars);

  let stamp;
  try { stamp = statStamp(file); } catch (err) { return null; }
  const hit = _cache.get(key);
  if (hit) {
    let fresh = hit.stamp === stamp;
    for (const dep of hit.deps) {
      if (!fresh) break;
      try { fresh = statStamp(dep.file) === dep.stamp; } catch (err) { fresh = false; }
    }
    if (fresh) return hit.result;
  }

  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch (err) { return null; }
  const deps = [];
  const resolvePart = (useFile, name) => {
    // One level only: a part may not itself pull in another part.
    const depFile = path.join(root, 'pages', useFile);
    let depSource;
    try {
      depSource = fs.readFileSync(depFile, 'utf8');
      deps.push({ file: depFile, stamp: statStamp(depFile) });
    } catch (err) { return null; }
    const got = renderSource(depSource, { on: true, onlyPart: name });
    return got.ok ? got.html : null;
  };
  const rendered = renderSource(source, { on, vars, resolvePart, auOnly: isAuOnlyPagePath(rel) });
  const body = Buffer.from(rendered.html, 'utf8');
  const result = {
    html: rendered.html,
    body,
    ok: rendered.ok,
    errors: rendered.errors,
    etag: 'W/"' + require('crypto').createHash('sha1').update(body).digest('hex').slice(0, 20) + '"',
    mtimeMs: fs.statSync(file).mtimeMs,
  };
  if (_cache.size > 400) _cache.clear();
  _cache.set(key, { stamp, deps, result });
  return result;
}

function _clearCacheForTest() { _cache.clear(); }

module.exports = {
  AU_ONLY_SITE_ROUTES,
  isSitePagePath,
  isAuOnlyPagePath,
  auOnlyFileForRoute,
  auOnlyRouteForFile,
  auOnlyRoutes,
  parseMarkers,
  renderSource,
  renderPageFile,
  _clearCacheForTest,
};
