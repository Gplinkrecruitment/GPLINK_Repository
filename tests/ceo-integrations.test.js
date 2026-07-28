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

// Owner report 2026-07-29: Google Calendar drives whether an interview can be
// booked over something already in the owner's diary, but it was the ONE
// integration with no card — so it sat unconnected for weeks with nothing
// anywhere reporting it. Source-level check (the endpoint runs live external
// pings, so booting it here would be slow and network-dependent).
describe('Google Calendar appears on the CEO integrations dashboard', function () {
  const fs = require('fs');
  const path = require('path');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  it('pushes a google_calendar integration card', function () {
    expect(serverSrc).toContain("key: 'google_calendar'");
  });

  it('reports the two settings that actually gate the feature', function () {
    expect(serverSrc).toContain('calendar_id_configured');
    expect(serverSrc).toContain('impersonate_email_configured');
  });

  it('states plainly when clash protection is OFF rather than only showing a status word', function () {
    expect(serverSrc).toContain('interview_clash_protection');
    expect(serverSrc).toMatch(/OFF — interviews are not checked against, or written to, your calendar/);
  });

  it('verifies the calendar with a real read, not just an env-var presence check', function () {
    // The probe must exercise the delegated calendar permission the scheduler
    // needs — an env var can be set while the Workspace scope is still missing.
    expect(serverSrc).toContain('busy_blocks_next_24h');
    expect(serverSrc).toMatch(/isGoogleCalendarConfigured\(\) \? pingWithTimeout/);
  });
});
