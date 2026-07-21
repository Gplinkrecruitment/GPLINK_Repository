/**
 * Automatic client error reporting.
 *
 * Five sources, all automatic, nobody has to report a bug for us to hear
 * about it:
 *   crash               window.onerror (an uncaught exception)
 *   unhandled_rejection a promise that rejected with nobody listening
 *   api_failure         a fetch() that came back with a failing status
 *   resource_error      a <script>/<img>/<link> that failed to load
 *   console_error       an exception that WAS caught but only console.error'd
 *
 * WHY the last three exist: window.onerror only sees CRASHES. The failures
 * that hurt worst were the handled ones, an upload POST returned 500, the
 * catch block logged to console, and the doctor was shown a green "Verified"
 * tick. Nothing crashed, so nothing was ever reported.
 *
 * TWO RULES THIS FILE MUST NEVER BREAK:
 *   1. It must be impossible for this file to break the app. Every hook wraps
 *      its own logic in try/catch and always returns/delegates to the real
 *      thing untouched.
 *   2. It must never transmit request or response BODIES. Those carry
 *      passports, qualification certificates, personal details and session
 *      credentials. Only method + sanitised URL + status ever leave the page.
 */
(function () {
  // ── Rate limiting ─────────────────────────────────────────────────────────
  // Previously a single 10/min bucket shared by everything. With four more
  // sources feeding it, one page hammering a broken endpoint could burn the
  // whole allowance and a genuine crash would then be silently discarded.
  //
  // So each KIND gets its own guaranteed budget and can never spend another
  // kind's. Budgets sum to 10/min on purpose: the server enforces its own
  // 10-per-minute-per-IP limit on /api/errors/report (see the handler in
  // server.js), so anything above 10 would just be 429'd and lost anyway.
  // Crashes get the largest share because they are the most serious.
  var RATE_WINDOW_MS = 60000;
  var BUDGETS = {
    crash: 3,
    unhandled_rejection: 2,
    api_failure: 3,
    resource_error: 1,
    console_error: 1
  };
  var rateCounts = {};
  var rateWindowStart = Date.now();

  // Dedupe is per page load and unchanged: the same fault repeating on one
  // page is one report, and the server's occurrence_count does the counting.
  var seenErrors = {};

  // Guards against a report path re-entering itself (e.g. our console.error
  // wrapper firing while we are already inside a report).
  var reporting = false;

  function getUserEmail() {
    try {
      var raw = localStorage.getItem('gp_session');
      if (!raw) return null;
      var obj = JSON.parse(raw);
      return (obj && typeof obj.email === 'string') ? obj.email : null;
    } catch (e) {
      return null;
    }
  }

  function showToast() {
    try {
      var el = document.createElement('div');
      el.textContent = 'Something went wrong, we\'ve been notified';
      el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1a1a1a;color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;z-index:99999;opacity:1;transition:opacity 0.4s;pointer-events:none;white-space:nowrap';
      document.body.appendChild(el);
      setTimeout(function () { el.style.opacity = '0'; }, 3400);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 4000);
    } catch (e) {}
  }

  /**
   * report(message, stack, url, kind, options)
   *
   * options.silent, when true, the doctor is told NOTHING. Reporting and
   * telling the user are deliberately separate concerns:
   *   - a crash froze the screen, so the toast explains why → NOT silent
   *   - a background API call failed and the page handled it → SILENT
   * If every background failure toasted, a healthy app would look broken.
   */
  function report(message, stack, url, kind, options) {
    if (reporting) return;
    var opts = options || {};
    var errKind = kind || 'crash';

    var ts = Date.now();
    if (ts - rateWindowStart > RATE_WINDOW_MS) { rateWindowStart = ts; rateCounts = {}; }
    var budget = BUDGETS[errKind] != null ? BUDGETS[errKind] : 1;
    var used = rateCounts[errKind] || 0;
    if (used >= budget) return;

    var dedupKey = errKind + '|' + String(message || '') + '|' + String(url || '');
    if (seenErrors[dedupKey]) return;
    seenErrors[dedupKey] = true;

    // Only spend budget on something we are actually going to send.
    rateCounts[errKind] = used + 1;

    if (!opts.silent) showToast();

    reporting = true;
    try {
      var payload = {
        message: String(message || '').slice(0, 500),
        stack: String(stack || '').slice(0, 2000),
        url: String(url || window.location.href).slice(0, 500),
        email: getUserEmail(),
        userAgent: navigator.userAgent,
        // The server stores context as free text and the Technical tab / daily
        // digest group on it, so keep it a short stable tag per signature.
        context: 'kind=' + errKind + (opts.context ? ' · ' + opts.context : '')
      };
      // XHR, not fetch, fetch is wrapped below and we must not observe or
      // rate-limit our own reporting traffic.
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/errors/report', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify(payload));
    } catch (e) {
    } finally {
      reporting = false;
    }
  }

  // ── 1. Uncaught crashes (unchanged behaviour: the doctor sees the toast) ──
  window.onerror = function (msg, src, line, col, err) {
    report(msg, err && err.stack ? err.stack : (String(msg) + ' @ ' + src + ':' + line + ':' + col), src, 'crash');
    return false;
  };

  window.addEventListener('unhandledrejection', function (evt) {
    var reason = evt && evt.reason;
    var msg = reason instanceof Error ? reason.message : String(reason || 'Unhandled promise rejection');
    var stack = reason instanceof Error ? reason.stack : msg;
    report(msg, stack, window.location.href, 'unhandled_rejection');
  });

  window.gpReportError = function (msg, context) {
    report(msg, null, window.location.href, 'crash', { context: context ? String(context) : null });
  };

  // ── URL sanitising ────────────────────────────────────────────────────────
  // A URL is the ONLY part of a request we ever transmit, so it is scrubbed
  // hard. Query strings routinely carry tokens, magic-link secrets, document
  // ids and email addresses, so the whole query is thrown away rather than
  // filtered. The server also redacts emails on write, but we do not rely on
  // that, the address must never leave the browser inside free text.
  var EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

  function sanitizeUrl(raw) {
    try {
      var s = String(raw || '');
      s = s.split('#')[0];
      var qi = s.indexOf('?');
      if (qi >= 0) s = s.slice(0, qi) + '?[query removed]';
      // Same-origin URLs become bare paths, shorter and easier to group.
      try {
        if (window.location && window.location.origin && s.indexOf(window.location.origin) === 0) {
          s = s.slice(window.location.origin.length) || '/';
        }
      } catch (e) {}
      // Defence in depth: an address embedded in a PATH segment.
      s = s.replace(EMAIL_RE, '[email removed]');
      return s.slice(0, 300);
    } catch (e) {
      return '[unreadable url]';
    }
  }

  // ── 2. Failed API responses ───────────────────────────────────────────────
  // A fetch that returns 500 does NOT throw, so none of the ~109 `if (!res.ok)`
  // branches in this codebase were ever visible to anyone.

  // 401/403 that are NORMAL and would otherwise flood us. Each has a reason;
  // nothing is excluded "just in case".
  function isRoutineAuthRefusal(path) {
    // The auth probe every page fires on boot. Returns 401 whenever the person
    // is signed out, i.e. on every public page, every time.
    if (path.indexOf('/api/auth/') === 0) return true;
    // auth-guard.js polls this to detect restricted/under-review accounts;
    // 401 while signed out is its normal answer.
    if (path.indexOf('/api/account/status') === 0) return true;
    // state-sync.js loads this on boot before sign-in is established.
    if (path.indexOf('/api/state') === 0) return true;
    // CEO-only and ATS endpoints are the SERVER-SIDE gate for role scoping.
    // A consultant hitting /api/ats/consultants, or an RSO hitting a CEO
    // endpoint, is refused BY DESIGN and the UI just hides the section
    // (see the comment in js/ceo-ats-practices.js). Not a bug.
    if (path.indexOf('/api/ceo/') === 0) return true;
    if (path.indexOf('/api/ats/') === 0) return true;
    return false;
  }

  function shouldReportStatus(status, path) {
    // Server-side failure. Always a bug, no exceptions.
    if (status >= 500) return true;
    if (status === 401 || status === 403) return !isRoutineAuthRefusal(path);
    // 404/405 on a NON-api URL means a page, template or asset we asked for
    // is not where the code thinks it is, a genuinely broken path.
    //
    // /api/ 404s are deliberately NOT reported: 200+ endpoints in server.js
    // answer 404 to mean "no such record" or "that token is not valid" (an
    // expired practice-intake link, for instance). Those are normal answers
    // to normal questions, not faults, and reporting them would bury the
    // real bugs.
    if ((status === 404 || status === 405) && path.indexOf('/api/') !== 0) return true;
    // Everything else 4xx is deliberately ignored: 400/409/422 are validation
    // and conflict answers the page already shows the person a message for,
    // and 429 is our own rate limiter doing its job.
    return false;
  }

  function requestMethodOf(args) {
    try {
      if (args[1] && args[1].method) return String(args[1].method).toUpperCase();
      var input = args[0];
      if (input && typeof input === 'object' && input.method) return String(input.method).toUpperCase();
    } catch (e) {}
    return 'GET';
  }

  function requestUrlOf(args) {
    try {
      var input = args[0];
      if (typeof input === 'string') return input;
      if (input && typeof input === 'object' && typeof input.url === 'string') return input.url;
      return String(input);
    } catch (e) {
      return '';
    }
  }

  function inspectResponse(method, rawUrl, response) {
    if (!response || typeof response.status !== 'number') return;

    // Cross-origin responses are opaque (status 0) or belong to someone else's
    // service (Calendly, maps, analytics). Their failures are not our bug and
    // their URLs are not ours to log, so only same-origin is inspected.
    var absolute;
    try { absolute = new URL(rawUrl, window.location.href); } catch (e) { return; }
    if (absolute.origin !== window.location.origin) return;

    var path = absolute.pathname;

    // NEVER observe our own reporting endpoint. A 500 here would report a 500,
    // which would report a 500, an infinite loop hammering production.
    if (path.indexOf('/api/errors/report') === 0) return;

    if (!shouldReportStatus(response.status, path)) return;

    var safeUrl = sanitizeUrl(rawUrl);
    // Bodies are NEVER read. Reading (or even cloning) the body would break
    // streaming responses and blob downloads for the real caller.
    var message = 'API ' + response.status + ' ' + method + ' ' + safeUrl;
    report(message, message, window.location.href, 'api_failure', {
      silent: true,
      context: method + ' ' + safeUrl + ' → ' + response.status
    });
  }

  try {
    var nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function' && !nativeFetch.__gpErrorReporterWrapped) {
      var wrappedFetch = function () {
        // Call through FIRST and untouched. If native fetch throws
        // synchronously the error propagates exactly as it always did.
        var result = nativeFetch.apply(this, arguments);
        try {
          if (result && typeof result.then === 'function') {
            var m = requestMethodOf(arguments);
            var u = requestUrlOf(arguments);
            // Observe on a DERIVED promise which is then thrown away. The
            // caller receives the ORIGINAL promise, so the Response object,
            // its unread body, and the timing are all exactly as before. The
            // empty rejection handler is required: without it, this derived
            // promise would itself become an unhandled rejection on every
            // network error and we would report our own observer.
            result.then(function (response) {
              try { inspectResponse(m, u, response); } catch (e) {}
            }, function () {});
          }
        } catch (e) {}
        return result;
      };
      wrappedFetch.__gpErrorReporterWrapped = true;
      window.fetch = wrappedFetch;
    }
  } catch (e) {}

  // ── 3. Resource load failures ─────────────────────────────────────────────
  // A <script>, <img> or stylesheet that 404s fires an `error` event on the
  // ELEMENT. It does not bubble, and window.onerror never sees it, so a
  // missing script (the page silently loses a feature) was invisible. Only a
  // capture-phase listener on window catches these.
  var RESOURCE_TAGS = { SCRIPT: 1, IMG: 1, LINK: 1, VIDEO: 1, AUDIO: 1, SOURCE: 1, IFRAME: 1, TRACK: 1 };

  window.addEventListener('error', function (evt) {
    try {
      var target = evt && evt.target;
      // An uncaught script error is dispatched on window itself and is already
      // handled by window.onerror above, do not report it twice.
      if (!target || target === window || !target.tagName) return;
      var tag = String(target.tagName).toUpperCase();
      if (!RESOURCE_TAGS[tag]) return;

      var src = target.src || target.href || '';
      // data:/blob: URIs are generated in-page and can embed document content,
      // so they are never transmitted. An empty src is not a load failure.
      if (!src || /^(data|blob):/i.test(String(src))) return;

      var safeUrl = sanitizeUrl(src);
      var message = 'Resource failed to load: ' + tag + ' ' + safeUrl;
      report(message, message, window.location.href, 'resource_error', {
        silent: true,
        context: tag + ' ' + safeUrl
      });
    } catch (e) {}
  }, true);

  // ── 4. Swallowed exceptions ───────────────────────────────────────────────
  // `catch (e) { console.error(e) }` appears ~200 times across js/ and pages/.
  // Every one of those is a failure that happened and that nobody outside the
  // browser console ever learned about.
  try {
    var nativeConsoleError = window.console && window.console.error;
    if (typeof nativeConsoleError === 'function' && !nativeConsoleError.__gpErrorReporterWrapped) {
      var wrappedConsoleError = function () {
        // Call through FIRST and always, so local debugging is unchanged even
        // if the reporting below were to fail.
        try { nativeConsoleError.apply(window.console, arguments); } catch (e) {}
        try {
          var parts = [];
          var stack = '';
          for (var i = 0; i < arguments.length && i < 4; i++) {
            var a = arguments[i];
            if (a instanceof Error) {
              parts.push(a.message);
              if (!stack && a.stack) stack = String(a.stack);
            } else if (a && typeof a === 'object') {
              // Objects are NOT serialised, a logged API response or form
              // object would carry personal data straight into the report.
              parts.push('[object]');
            } else {
              parts.push(String(a));
            }
          }
          // Logged strings frequently interpolate the doctor's address
          // ("upload failed for x@y.com"). Scrub before it leaves the page.
          var message = ('console.error: ' + parts.join(' ')).replace(EMAIL_RE, '[email removed]').slice(0, 300);
          report(message, String(stack || message).replace(EMAIL_RE, '[email removed]'), window.location.href, 'console_error', { silent: true });
        } catch (e) {}
      };
      wrappedConsoleError.__gpErrorReporterWrapped = true;
      window.console.error = wrappedConsoleError;
    }
  } catch (e) {}
}());
