// FR-7 (guide walk): a staff invite link opened in a browser where ANOTHER
// doctor is signed in landed on that doctor's home page. The sign-in page
// sends anyone with a session to the home page, so the invited doctor never
// saw "create your password".
//
// The route is `main`'s and is shared with every password link, so the fix is
// for the Australian invite only, behind the switch: an invite arrival
// (`?reset=true&invite=1`, the two keys the invite bridge adds, and it adds
// `invite=1` only with the switch on) serves the sign-in page. Round 8 (M8-01): the
// server signs nobody out; the page does, only with a real invite token, and
// names the account it signed out. Everything else is exactly as on `main`.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');

let h;
let other;
const page = (path, cookie) => h.request('GET', path, cookie ? { cookie } : {});
const cleared = (res) => [].concat(res.headers['set-cookie'] || []).some((c) => /^gp_session=;/.test(c) && /Max-Age=0/.test(c));

beforeAll(async () => {
  h = await bootAuTestServer({ name: 'fr7-invite' });
  other = buildAuDoctor('overseas_null', { idSuffix: 'inv1' });
  const db = buildAuFixtureDb([other]);
  Object.keys(db).forEach((name) => { h.emu.db[name] = JSON.parse(JSON.stringify(db[name])); });
  other.cookie = h.gpCookie(other.email, other.userId);
}, 60000);
afterAll(async () => { if (h) await h.close(); });
beforeEach(() => { h.setSwitch(true); });

describe('an invite link opened where another doctor is signed in', () => {
  it('switch on: the sign-in page is served (the password screen opens there), not their home page', async () => {
    for (const path of ['/pages/signin?reset=true&invite=1', '/pages/signin?invite=1&reset=true']) {
      const res = await page(path, other.cookie);
      expect(res.status, path).toBe(200);
      expect(String(res.headers['content-type'])).toMatch(/text\/html/);
      expect(res.raw).toContain('id="signInForm"');
      expect(res.headers.location).toBeUndefined();
      // Round 8 (M8-01): the SERVER signs nobody out. It cannot see the
      // invite token; the page does it, and says so.
      expect(cleared(res), path).toBe(false);
    }
  });

  it('M8-01: a hand-made address with the two keys and no token signs nobody out; the session still works', async () => {
    const res = await page('/pages/signin?reset=true&invite=1', other.cookie);
    expect(res.status).toBe(200);
    expect(cleared(res)).toBe(false);
    const still = await h.request('GET', '/api/auth/session', { cookie: other.cookie });
    expect(still.status).toBe(200);
    expect(still.json.authenticated).toBe(true);
  });

  it('M8-01: the page signs the other account out only with a real invite token, names it, and sends a tokenless visitor home', () => {
    const html = fs.readFileSync(path.join(process.cwd(), 'pages', 'signin.html'), 'utf8');
    // the sign-out is called only from the recovery-token branch, and only for an invite
    const branch = html.slice(html.indexOf('_recoveryAccessToken = recoveryToken;'), html.indexOf('showResetPasswordPanel();', html.indexOf('_recoveryAccessToken = recoveryToken;')));
    expect(branch).toContain('if (_recoveryIsInvite) auInviteSignOutOtherAccount();');
    expect(html.split('auInviteSignOutOtherAccount()').length - 1).toBe(2);   // the definition and that one call
    // run the page's own functions against stand-ins
    const a = html.indexOf('function auInviteNoticeText(email) {');
    const z = html.indexOf('// The same address WITHOUT an invite token', a);
    const calls = [];
    const made = [];
    const container = {
      querySelector: (sel) => (sel === '[data-au-invite-notice]' ? (made[0] || null) : { parentNode: { insertBefore: (n) => made.push(n) }, nextSibling: null })
    };
    const doc = { createElement: () => ({ style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }) };
    const mk = (session) => new Function('fetch', 'document', 'resetPasswordContainerEl', html.slice(a, z) + '; return { run: auInviteSignOutOtherAccount, text: auInviteNoticeText };')(
      (url, opts) => { calls.push((opts && opts.method) || 'GET', url); return Promise.resolve({ ok: !!session, json: () => Promise.resolve(session) }); }, doc, container);
    return (async () => {
      mk({ authenticated: true, profile: { email: 'other@gplink-test.local' } }).run();
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toEqual(['GET', '/api/auth/session', 'POST', '/api/auth/logout']);
      expect(made.length).toBe(1);
      expect(made[0].textContent).toBe("other@gplink-test.local was signed in on this browser and has been signed out so you can create your password. That account's own password still works.");
      expect(made[0].attrs.role).toBe('status');
      // nobody signed in: no sign-out, no line
      calls.length = 0; made.length = 0;
      mk(null).run();
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toEqual(['GET', '/api/auth/session']);
      expect(made.length).toBe(0);
      expect(mk(null).text('')).toMatch(/^Another account was signed in on this browser and has been signed out/);
      // the tokenless address: home, and no sign-out call anywhere in that block
      const tail = html.slice(z, html.indexOf('function showResetPasswordPanel() {', z));
      expect(tail).toContain('if ((window.location.hash || "").indexOf("access_token") !== -1) return;');
      expect(tail).toContain('if (s && s.authenticated) window.location.replace("/pages/index");');
      expect(tail).not.toContain('/api/auth/logout');
    })();
  });

  it('every other visit to the sign-in page with a session goes home, exactly as before', async () => {
    for (const path of ['/pages/signin', '/pages/signin?reset=true', '/pages/signin?invite=1', '/pages/signin?reset=false&invite=1', '/pages/signin?next=/pages/career', '/pages/signin?reset=true&invite=2']) {
      const res = await page(path, other.cookie);
      expect(res.status, path).toBe(302);
      expect(res.headers.location, path).toBe('/pages/index');
      expect(cleared(res), path).toBe(false);
    }
  });

  it('switch off: an address carrying the two keys is treated like any other (home page, nobody signed out)', async () => {
    h.setSwitch(false);
    const res = await page('/pages/signin?reset=true&invite=1', other.cookie);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/pages/index');
    expect(cleared(res)).toBe(false);
  });

  it('the invite bridge adds invite=1 only with the switch on (so with it off no link can ever carry it)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
    expect(src).toContain("const setupIsInvite = auPathwayFlag.isAuPathwayEnabled() && setupReqUrl.searchParams.get('invite') === '1';");
    expect(src).toContain("const setupRedirectTo = APP_BASE_URL + '/pages/signin?reset=true' + (setupIsInvite ? '&invite=1' : '');");
  });
});
