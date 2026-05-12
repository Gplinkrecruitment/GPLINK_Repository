(function () {
  var RATE_MAX = 10;
  var RATE_WINDOW_MS = 60000;
  var rateCount = 0;
  var rateWindowStart = Date.now();
  var seenErrors = {};

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
      el.textContent = 'Something went wrong \u2014 we\'ve been notified';
      el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1a1a1a;color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;z-index:99999;opacity:1;transition:opacity 0.4s;pointer-events:none;white-space:nowrap';
      document.body.appendChild(el);
      setTimeout(function () { el.style.opacity = '0'; }, 3400);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 4000);
    } catch (e) {}
  }

  function report(message, stack, url, context) {
    var ts = Date.now();
    if (ts - rateWindowStart > RATE_WINDOW_MS) { rateWindowStart = ts; rateCount = 0; }
    if (rateCount >= RATE_MAX) return;
    rateCount++;

    var dedupKey = String(message || '') + '|' + String(url || '');
    if (seenErrors[dedupKey]) return;
    seenErrors[dedupKey] = true;

    showToast();

    try {
      var payload = {
        message: String(message || '').slice(0, 500),
        stack: String(stack || '').slice(0, 2000),
        url: String(url || window.location.href).slice(0, 500),
        email: getUserEmail(),
        userAgent: navigator.userAgent,
        context: context || null
      };
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/errors/report', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify(payload));
    } catch (e) {}
  }

  window.onerror = function (msg, src, line, col, err) {
    report(msg, err && err.stack ? err.stack : (String(msg) + ' @ ' + src + ':' + line + ':' + col), src);
    return false;
  };

  window.addEventListener('unhandledrejection', function (evt) {
    var reason = evt && evt.reason;
    var msg = reason instanceof Error ? reason.message : String(reason || 'Unhandled promise rejection');
    var stack = reason instanceof Error ? reason.stack : msg;
    report(msg, stack, window.location.href);
  });

  window.gpReportError = function (msg, context) {
    report(msg, null, window.location.href, context);
  };
}());
