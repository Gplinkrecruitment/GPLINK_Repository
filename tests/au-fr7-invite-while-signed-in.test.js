// FR-7 (guide walk): a staff invite link opened in a browser where ANOTHER
// doctor is signed in landed on that doctor's home page. The sign-in page
// sends anyone with a session to the home page, so the invited doctor never
// saw "create your password".
//
// The route is `main`'s and is shared with every password link, so the fix is
// for the Australian invite only, behind the switch: an invite arrival
// (`?reset=true&invite=1`, the two keys the invite bridge adds, and it adds
// `invite=1` only with the switch on) signs the current session out and
// serves the sign-in page. Everything else is exactly as on `main`.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
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
  it('switch on: the other doctor is signed out and the sign-in page is served (the password screen opens there), not their home page', async () => {
    for (const path of ['/pages/signin?reset=true&invite=1', '/pages/signin?invite=1&reset=true']) {
      const res = await page(path, other.cookie);
      expect(res.status, path).toBe(200);
      expect(String(res.headers['content-type'])).toMatch(/text\/html/);
      expect(res.raw).toContain('id="signInForm"');
      expect(res.headers.location).toBeUndefined();
      expect(cleared(res), path).toBe(true);
    }
  });

  it('the cookie that was cleared no longer opens the app; the invited doctor\'s own session is what follows', async () => {
    const res = await page('/pages/signin?reset=true&invite=1', other.cookie);
    expect(cleared(res)).toBe(true);
    // (a browser now holds no session cookie)
    const after = await page('/pages/signin?reset=true&invite=1');
    expect(after.status).toBe(200);
    expect(cleared(after)).toBe(false);   // nobody signed in: nothing to sign out
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
