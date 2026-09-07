// Owner 2026-09-08: "everytime a page is switched then interview times start
// loading again, keep this cached so it loads instantly" + "why do we have a
// choose interview time below the confirm interview time...no need".
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

function fakeStorage() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => Array.from(m.keys())[i] || null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const MOD = path.join(process.cwd(), 'js', 'interview-slots-cache.js');

describe('interview slot cache — rules', () => {
  let C;
  beforeEach(() => { globalThis.sessionStorage = fakeStorage(); delete require.cache[MOD]; C = require(MOD); });
  it('round-trips a slot list per application + timezone and expires after 10 minutes', () => {
    const slots = [{ startUtc: '2026-09-12T02:00:00.000Z' }, { startUtc: '2026-09-12T03:00:00.000Z' }];
    expect(C.write('app1', 'Australia/Sydney', slots, 1000)).toBe(true);
    expect(C.read('app1', 'Australia/Sydney', 2000).slots).toEqual(slots);
    expect(C.read('app1', 'Asia/Makassar', 2000)).toBeNull(); // a different clock is a different list
    expect(C.read('app1', 'Australia/Sydney', 1000 + C.TTL_MS + 1)).toBeNull();
  });
  it('a booking clears every timezone variant for that application only', () => {
    C.write('app1', 'A', [{ startUtc: 'x' }]); C.write('app1', 'B', [{ startUtc: 'y' }]); C.write('app2', 'A', [{ startUtc: 'z' }]);
    expect(C.clear('app1')).toBe(2);
    expect(C.read('app1', 'A')).toBeNull();
    expect(C.read('app2', 'A')).not.toBeNull();
  });
  it('sameSlots compares start times only, so a refresh that changed nothing keeps the instant paint', () => {
    expect(C.sameSlots([{ startUtc: 'a', local: 1 }], [{ startUtc: 'a', local: 2 }])).toBe(true);
    expect(C.sameSlots([{ startUtc: 'a' }], [{ startUtc: 'a' }, { startUtc: 'b' }])).toBe(false);
  });
  it('survives a missing sessionStorage', () => {
    globalThis.sessionStorage = undefined; delete require.cache[MOD]; const D = require(MOD);
    expect(D.read('a', 'b')).toBeNull(); expect(D.write('a', 'b', [])).toBe(false); expect(D.clear('a')).toBe(0);
  });
});

describe('wiring', () => {
  it('the card picker and the popup paint from the cache first and refresh quietly; a booking clears it', () => {
    const career = read('pages/career.html');
    expect(career).toContain('/js/interview-slots-cache.js?v=');
    expect(career).toContain('const cached = ivCache ? ivCache.read(appId, careerDeviceTz) : null;');
    expect(career).toContain('if (cached && ivCache && ivCache.sameSlots(cached.slots, fresh)) return;');
    expect(career).toContain('if (careerIvCache()) careerIvCache().clear(appId);');
    const popup = read('js/interview-popup.js');
    expect(popup).toContain('var cached = cache ? cache.read(iv.applicationId, tz) : null;');
    expect(popup).toContain('if (cache) cache.clear(iv.applicationId);');
    const shell = read('pages/app-shell.html');
    expect(shell.indexOf('/js/interview-slots-cache.js?v=')).toBeLessThan(shell.indexOf('/js/interview-popup.js?v='));
    expect(read('sw.js')).toContain('"/js/interview-slots-cache.js?v=20260908a"');
  });
  it('the server memoises the slot list for 60 s per application + timezone and clears it on booking', () => {
    const s = read('server.js');
    expect(s).toContain('const INTERVIEW_SLOTS_MEMO_MS = 60 * 1000;');
    expect(s).toContain("sendJson(res, 200, { ok: true, slots: ciMemo.slots, cached: true });");
    expect(s).toContain('_interviewSlotsMemo[ciMemoKey] = { at: Date.now(), slots: ciSlotCtx.slots };');
    // keyed by user and checked before the ownership lookups; cleared by application id
    expect(s).toContain("const ciMemoKey = String(ciUserId) + '|' + ciAppId + '|' + (interviewMeetings.sanitizeViewerTz(url.searchParams.get('viewer_tz')) || '');");
    expect(s.indexOf('const ciMemo = _interviewSlotsMemo[ciMemoKey];')).toBeLessThan(s.indexOf('const ciCtx = await atsGetApplicationContext(ciAppId);'));
    expect(s).toContain("const needle = '|' + String(appId || '') + '|';");
    expect(s).toContain("    await atsUpdateApplicationStageRow(appCtx.app.id, 'interview', '', actorEmail || '');\n    interviewSlotsMemoClear(appCtx.app.id);");
  });
  it('no second button under a card that shows the picker', () => {
    const career = read('pages/career.html');
    expect(career).toContain('const actionHtml = st.bookable\n        ? ""');
    expect(career).not.toContain('class="at-match-ghost" ${openAttrs}');
  });
});
