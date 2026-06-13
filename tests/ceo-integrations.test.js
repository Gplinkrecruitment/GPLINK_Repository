import { describe, it, expect } from 'vitest';

// Mirrors the reconnect ok rule implemented in server.js:
//   ok = results.length > 0 && results.every(r => r.success)
function gmailReconnectOk(results) {
  return Array.isArray(results) && results.length > 0 && results.every(function (r) { return !!r.success; });
}

describe('gmail reconnect ok flag (#46)', function () {
  it('is false when every mailbox renewal failed', function () {
    var results = [
      { email: 'hazel@mygplink.com.au', success: false, error: 'GOOGLE_PUBSUB_TOPIC missing' }
    ];
    expect(gmailReconnectOk(results)).toBe(false);
  });
  it('is false when any mailbox renewal failed', function () {
    var results = [
      { email: 'a@x.com', success: true },
      { email: 'b@x.com', success: false, error: 'auth' }
    ];
    expect(gmailReconnectOk(results)).toBe(false);
  });
  it('is true only when all renewals succeeded', function () {
    var results = [
      { email: 'a@x.com', success: true },
      { email: 'b@x.com', success: true }
    ];
    expect(gmailReconnectOk(results)).toBe(true);
  });
  it('is false on empty results', function () {
    expect(gmailReconnectOk([])).toBe(false);
  });
});
