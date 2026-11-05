// Coverage for lib/ads-actions.js — the review's changes to the Meta account
// (pause / resume an ad or ad set, change a daily budget, launch a draft) and
// the executor that applies the ticked ones. The Graph API is a recording
// stub, the draft launcher is injected, so nothing here needs a token.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const actions = require('../lib/ads-actions.js');
const meta = require('../lib/meta-ads.js');

const CFG = meta.adsConfig({ META_ADS_ACCESS_TOKEN: 'tok', META_ADS_GRAPH_URL: 'http://graph.test' });

function adsets() {
  return [
    { id: '200', name: 'Live set', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: 100 },
    { id: '201', name: 'Old set', status: 'PAUSED', effective_status: 'PAUSED', daily_budget: 60 }
  ];
}
function ads() {
  return [
    { id: '1', name: 'A', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: '200', adset_name: 'Live set' },
    { id: '2', name: 'B', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: '200', adset_name: 'Live set' },
    { id: '3', name: 'C', status: 'PAUSED', effective_status: 'PAUSED', adset_id: '200', adset_name: 'Live set' },
    { id: '9', name: 'Old', status: 'ACTIVE', effective_status: 'ADSET_PAUSED', adset_id: '201', adset_name: 'Old set' }
  ];
}
const READY = { id: 'd-ready', status: 'ready', angle: '05-duty-day', headline: 'Duty day. Every day.', primary_text: 'Body. Completely free for doctors.', description: 'UK GPs', image_path: 'ad-drafts/x.jpg', image_width: 1080, image_height: 1350, cta: 'BOOK_TRAVEL', adset_id: '200' };
const DRAFTS = [READY, { id: 'd-live', status: 'live', meta_ad_id: '77', angle: 'live-one' }, { id: 'd-bare', status: 'draft', angle: 'bare', headline: '' }, { id: 'd-busy', status: 'launching', angle: 'busy' }, { id: 'd-old', status: 'archived', angle: 'old' }];

// Records every Graph call; answers { success: true } unless the handler says otherwise.
function graphStub(handler) {
  const calls = [];
  const impl = async (url, init) => {
    const u = new URL(url);
    const call = {
      method: init.method, path: u.pathname,
      params: init.method === 'GET' ? Object.fromEntries(u.searchParams) : Object.fromEntries(new URLSearchParams(init.body))
    };
    calls.push(call);
    const out = (handler && handler(call)) || { json: { success: true } };
    const status = out.status || 200;
    return { ok: status >= 200 && status < 300, status, json: async () => out.json };
  };
  return { impl, calls };
}

function change(over) {
  return Object.assign({ id: 'chg-1', action: 'pause_ad', target_id: '1', target_name: 'A', daily_budget: 0, title: 't', why: 'w', priority: 2, applied: null }, over || {});
}

describe('normaliseChanges', () => {
  it('keeps the six actions only, needs a target, needs a positive budget for a budget change', () => {
    const out = actions.normaliseChanges([
      { action: 'pause_ad', target_id: 1 },
      { action: 'resume_adset', target_id: ' 200 ', priority: '1' },
      { action: 'set_adset_daily_budget', target_id: '200', daily_budget: '80' },
      { action: 'set_adset_daily_budget', target_id: '200', daily_budget: -5 },
      { action: 'launch_draft', target_id: 'd-1', title: 'Go', why: 'y' },
      { action: 'edit_targeting', target_id: '200' },
      null
    ]);
    expect(out.map((c) => c.action)).toEqual(['pause_ad', 'resume_adset', 'set_adset_daily_budget', 'launch_draft']);
    expect(out[0]).toEqual({ id: 'chg-1', action: 'pause_ad', target_id: '1', target_name: '', daily_budget: 0, title: 'Pause the ad', why: '', priority: 2, applied: null });
    expect(out[1].target_id).toBe('200');
    expect(out[1].priority).toBe(1);
    expect(out[2].daily_budget).toBe(80);
    expect(out[3].title).toBe('Go');
  });
  it('limits (env) fall back to the defaults and ignore junk', () => {
    expect(actions.limits({})).toEqual({ minLiveAds: 1, maxDailyBudget: 300, maxBudgetStep: 2 });
    expect(actions.limits({ ADS_MIN_LIVE_ADS: '3', ADS_MAX_DAILY_BUDGET: '150' })).toEqual({ minLiveAds: 3, maxDailyBudget: 150, maxBudgetStep: 2 });
    expect(actions.limits({ ADS_MIN_LIVE_ADS: 'x', ADS_MAX_DAILY_BUDGET: '-1' })).toEqual({ minLiveAds: 1, maxDailyBudget: 300, maxBudgetStep: 2 });
  });
});

describe('describeChange', () => {
  const ctx = { ads: ads(), adsets: adsets(), drafts: DRAFTS, currency: 'AUD' };
  it('says exactly what will happen, in the owner\'s words, from the snapshot', () => {
    expect(actions.describeChange(change(), ctx)).toBe('Pauses the ad "A" (live now, in Live set).');
    expect(actions.describeChange(change({ action: 'resume_ad', target_id: '3' }), ctx)).toBe('Resumes the ad "C" (paused now, in Live set).');
    expect(actions.describeChange(change({ action: 'pause_adset', target_id: '200' }), ctx)).toBe('Pauses the ad set "Live set" (live now, A$100 a day). Every ad in it stops delivering (3 ads).');
    expect(actions.describeChange(change({ action: 'resume_adset', target_id: '201' }), ctx)).toBe('Resumes the ad set "Old set" (paused now, A$60 a day). Its ads start delivering again (1 ad).');
    expect(actions.describeChange(change({ action: 'set_adset_daily_budget', target_id: '200', daily_budget: 150 }), ctx)).toBe('Changes the daily budget of "Live set" from A$100 to A$150 a day.');
    expect(actions.describeChange(change({ action: 'launch_draft', target_id: 'd-ready' }), ctx)).toBe('Launches the draft "05-duty-day" ("Duty day. Every day.") as a new live ad (draft is ready).');
  });
  it('copes with a target that is not in the snapshot', () => {
    expect(actions.describeChange(change({ target_id: '404', target_name: 'Gone' }), ctx)).toMatch(/Pauses the ad "Gone"\. It is not in the latest snapshot/);
    expect(actions.describeChange(change({ action: 'set_adset_daily_budget', target_id: '404', target_name: 'X', daily_budget: 20 }), { currency: 'AUD' })).toBe('Changes the daily budget of "X" to A$20 a day.');
  });
  it('describeChanges adds a label and the effect to copies, never the originals', () => {
    const src = [change()];
    const out = actions.describeChanges(src, ctx);
    expect(out[0].label).toBe('Pause ad');
    expect(out[0].effect).toContain('Pauses the ad "A"');
    expect(src[0].effect).toBeUndefined();
  });
});

describe('checkChange', () => {
  const lim = actions.limits({});
  it('pause: skips an ad already paused or not running, refuses the last live ad in a set', () => {
    const live = { ads: ads(), adsets: adsets() };
    expect(actions.checkChange(change(), live, DRAFTS, lim)).toEqual({ ok: true });
    expect(actions.checkChange(change({ target_id: '3' }), live, DRAFTS, lim)).toEqual({ ok: false, skip: true, message: 'Already paused.' });
    expect(actions.checkChange(change({ target_id: '9' }), live, DRAFTS, lim).skip).toBe(true);
    expect(actions.checkChange(change({ target_id: '404' }), live, DRAFTS, lim)).toEqual({ ok: false, message: 'This ad is no longer in the campaign.' });
    live.ads[1].effective_status = 'PAUSED';
    const r = actions.checkChange(change(), live, DRAFTS, lim);
    expect(r.ok).toBe(false);
    expect(r.skip).toBeUndefined();
    expect(r.message).toMatch(/would leave 0 live ads/);
  });
  it('resume: skips a live ad, refuses a deleted one', () => {
    const live = { ads: ads(), adsets: adsets() };
    expect(actions.checkChange(change({ action: 'resume_ad', target_id: '1' }), live, DRAFTS, lim).skip).toBe(true);
    expect(actions.checkChange(change({ action: 'resume_ad', target_id: '3' }), live, DRAFTS, lim)).toEqual({ ok: true });
    live.ads[2].effective_status = 'DELETED';
    expect(actions.checkChange(change({ action: 'resume_ad', target_id: '3' }), live, DRAFTS, lim).message).toMatch(/deleted/);
  });
  it('ad sets: skips when already in that state, refuses pausing the only running set', () => {
    const live = { ads: ads(), adsets: adsets() };
    expect(actions.checkChange(change({ action: 'pause_adset', target_id: '201' }), live, DRAFTS, lim).skip).toBe(true);
    expect(actions.checkChange(change({ action: 'resume_adset', target_id: '200' }), live, DRAFTS, lim).skip).toBe(true);
    expect(actions.checkChange(change({ action: 'resume_adset', target_id: '201' }), live, DRAFTS, lim)).toEqual({ ok: true });
    expect(actions.checkChange(change({ action: 'pause_adset', target_id: '200' }), live, DRAFTS, lim).message).toMatch(/only ad set running/);
    live.adsets[1].effective_status = 'ACTIVE'; live.adsets[1].status = 'ACTIVE';
    expect(actions.checkChange(change({ action: 'pause_adset', target_id: '200' }), live, DRAFTS, lim)).toEqual({ ok: true });
  });
  it('budget: within double and under the ceiling, never zero, skip when unchanged', () => {
    const live = { ads: ads(), adsets: adsets() };
    const b = (v) => change({ action: 'set_adset_daily_budget', target_id: '200', daily_budget: v });
    expect(actions.checkChange(b(150), live, DRAFTS, lim)).toEqual({ ok: true });
    expect(actions.checkChange(b(200), live, DRAFTS, lim)).toEqual({ ok: true });
    expect(actions.checkChange(b(201), live, DRAFTS, lim).message).toMatch(/more than double/);
    expect(actions.checkChange(b(100), live, DRAFTS, lim)).toEqual({ ok: false, skip: true, message: 'Already A$100 a day.' });
    expect(actions.checkChange(b(0), live, DRAFTS, lim).message).toMatch(/above zero/);
    expect(actions.checkChange(b(20), live, DRAFTS, lim)).toEqual({ ok: true });
    expect(actions.checkChange(b(250), live, DRAFTS, actions.limits({ ADS_MAX_DAILY_BUDGET: '240' })).message).toMatch(/ceiling of A\$240/);
    expect(actions.checkChange(b(50), live, DRAFTS, lim).ok).toBe(true);
  });
  it('launch: needs a complete draft that is not live, launching or archived', () => {
    const live = { ads: ads(), adsets: adsets() };
    const l = (id) => change({ action: 'launch_draft', target_id: id });
    expect(actions.checkChange(l('d-ready'), live, DRAFTS, lim)).toEqual({ ok: true });
    expect(actions.checkChange(l('d-live'), live, DRAFTS, lim)).toEqual({ ok: false, skip: true, message: 'Already live (ad 77).' });
    expect(actions.checkChange(l('d-bare'), live, DRAFTS, lim).message).toMatch(/not ready: Headline is empty/);
    expect(actions.checkChange(l('d-busy'), live, DRAFTS, lim).message).toMatch(/already in progress/);
    expect(actions.checkChange(l('d-old'), live, DRAFTS, lim).message).toMatch(/archived/);
    expect(actions.checkChange(l('d-404'), live, DRAFTS, lim).message).toMatch(/no longer exists/);
  });
  it('refuses an unknown action outright', () => {
    expect(actions.checkChange(change({ action: 'nuke' }), { ads: ads(), adsets: adsets() }, DRAFTS, lim).message).toMatch(/Unknown/);
  });
});

describe('orderChanges', () => {
  it('resumes and launches before budgets before pauses, then by priority', () => {
    const out = actions.orderChanges([
      change({ id: 'a', action: 'pause_ad', priority: 1 }),
      change({ id: 'b', action: 'pause_adset', priority: 1 }),
      change({ id: 'c', action: 'set_adset_daily_budget', priority: 2 }),
      change({ id: 'd', action: 'launch_draft', priority: 3 }),
      change({ id: 'e', action: 'resume_ad', priority: 2 }),
      change({ id: 'f', action: 'pause_ad', priority: 3 }),
      change({ id: 'g', action: 'resume_adset', priority: 3 })
    ]);
    expect(out.map((c) => c.id)).toEqual(['g', 'e', 'd', 'c', 'a', 'f', 'b']);
  });
});

describe('applyChanges', () => {
  it('posts the status and budget writes Meta expects, in a safe order, and reports each line', async () => {
    const stub = graphStub();
    const launched = [];
    const r = await actions.applyChanges({
      config: CFG, fetchImpl: stub.impl, ads: ads(), adsets: adsets(), drafts: DRAFTS, env: {},
      launch: async (id) => { launched.push(id); return { ok: true, meta_ad_id: '555' }; },
      changes: [
        change({ id: 'chg-1', action: 'pause_ad', target_id: '1', priority: 1 }),
        change({ id: 'chg-2', action: 'pause_ad', target_id: '2', priority: 2 }),
        change({ id: 'chg-3', action: 'set_adset_daily_budget', target_id: '200', daily_budget: 150.5 }),
        change({ id: 'chg-4', action: 'launch_draft', target_id: 'd-ready' }),
        change({ id: 'chg-5', action: 'pause_ad', target_id: '3' }),
        change({ id: 'chg-6', action: 'resume_adset', target_id: '201' })
      ]
    });
    // Order: resume set, launch, budget, pauses by priority.
    expect(r.results.map((x) => x.id)).toEqual(['chg-6', 'chg-4', 'chg-3', 'chg-1', 'chg-2', 'chg-5']);
    expect(launched).toEqual(['d-ready']);
    expect(stub.calls.map((c) => [c.method, c.path, c.params.status || c.params.daily_budget])).toEqual([
      ['POST', '/v21.0/201', 'ACTIVE'],
      ['POST', '/v21.0/200', '15050'],
      ['POST', '/v21.0/1', 'PAUSED'],
      ['POST', '/v21.0/2', 'PAUSED']
    ]);
    expect(stub.calls[0].params.access_token).toBe('tok');
    const by = {}; r.results.forEach((x) => { by[x.id] = x; });
    expect(by['chg-6']).toMatchObject({ ok: true, message: 'Ad set live again.', before: 'PAUSED', after: 'ACTIVE' });
    expect(by['chg-4']).toMatchObject({ ok: true, message: 'Launched as ad 555.', meta_ad_id: '555', before: 'ready', after: 'live' });
    expect(by['chg-3']).toMatchObject({ ok: true, message: 'Daily budget is now A$150.5 (was A$100).', before: 100, after: 150.5 });
    expect(by['chg-1']).toMatchObject({ ok: true, message: 'Paused.', before: 'ACTIVE', after: 'PAUSED' });
    // The launch counted as live, so pausing B still leaves the new ad running.
    expect(by['chg-2']).toMatchObject({ ok: true, message: 'Paused.' });
    expect(by['chg-5']).toMatchObject({ ok: false, skipped: true, message: 'Already paused.' });
    expect(r.counts).toEqual({ applied: 5, skipped: 1, failed: 0 });
    expect(r.ok).toBe(true);
    expect(actions.summarise(r.counts)).toBe('5 applied, 1 already done.');
  });

  it('refuses the pause that would empty the ad set, and a Meta refusal on one line does not stop the others', async () => {
    const stub = graphStub((c) => (c.path === '/v21.0/1' ? { status: 400, json: { error: { message: 'Invalid parameter', code: 100, error_user_msg: 'Ad is in review' } } } : null));
    const r = await actions.applyChanges({
      config: CFG, fetchImpl: stub.impl, ads: ads(), adsets: adsets(), drafts: DRAFTS, env: {},
      changes: [
        change({ id: 'chg-1', action: 'pause_ad', target_id: '1', priority: 1 }),
        change({ id: 'chg-2', action: 'pause_ad', target_id: '2', priority: 2 }),
        change({ id: 'chg-3', action: 'set_adset_daily_budget', target_id: '200', daily_budget: 900 })
      ]
    });
    const by = {}; r.results.forEach((x) => { by[x.id] = x; });
    expect(by['chg-1'].ok).toBe(false);
    expect(by['chg-1'].skipped).toBe(false);
    expect(by['chg-1'].message).toMatch(/Meta rejected a field.*Ad is in review/);
    // A did not pause, so pausing B is allowed (A is still counted live).
    expect(by['chg-2']).toMatchObject({ ok: true, message: 'Paused.' });
    expect(by['chg-3'].ok).toBe(false);
    expect(by['chg-3'].message).toMatch(/ceiling/);
    expect(r.counts).toEqual({ applied: 1, skipped: 0, failed: 2 });
    expect(r.ok).toBe(false);
    expect(actions.summarise(r.counts)).toBe('1 applied, 2 not applied.');
    expect(stub.calls.length).toBe(2);
  });

  it('a held launch (kill switch) is reported as not applied, and a thrown error never escapes', async () => {
    const stub = graphStub();
    const r = await actions.applyChanges({
      config: CFG, fetchImpl: stub.impl, ads: ads(), adsets: adsets(), drafts: DRAFTS, env: {},
      launch: async (id) => (id === 'd-ready' ? { ok: false, held: true, error: 'ADS_LAUNCH_DISABLED is true, so nothing is created on Meta.' } : { ok: false }),
      changes: [change({ id: 'chg-1', action: 'launch_draft', target_id: 'd-ready' })]
    });
    expect(r.results[0]).toMatchObject({ ok: false, held: true, skipped: false });
    expect(r.results[0].message).toMatch(/ADS_LAUNCH_DISABLED/);
    const boom = await actions.applyChanges({
      config: CFG, fetchImpl: async () => { throw new Error('ECONNRESET'); }, ads: ads(), adsets: adsets(), drafts: DRAFTS, env: {},
      changes: [change({ id: 'chg-1', action: 'pause_ad', target_id: '1' })]
    });
    expect(boom.results[0].ok).toBe(false);
    expect(boom.results[0].message).toMatch(/Could not reach Meta/);
    const noLauncher = await actions.applyChanges({ config: CFG, fetchImpl: stub.impl, ads: ads(), adsets: adsets(), drafts: DRAFTS, env: {}, changes: [change({ action: 'launch_draft', target_id: 'd-ready' })] });
    expect(noLauncher.results[0].message).toMatch(/No launcher/);
  });

  it('summarise reads naturally when nothing happened', () => {
    expect(actions.summarise({ applied: 0, skipped: 0, failed: 0 })).toBe('Nothing was changed.');
    expect(actions.summarise({ applied: 2, skipped: 0, failed: 1 })).toBe('2 applied, 1 not applied.');
  });
});

describe('meta-ads write helpers', () => {
  it('setEntityStatus and setAdsetDailyBudget post to /{id} and insist on success: true', async () => {
    const ok = graphStub();
    expect(await meta.setEntityStatus('12', 'PAUSED', { config: CFG, fetchImpl: ok.impl })).toEqual({ ok: true, id: '12', status: 'PAUSED' });
    expect(await meta.setEntityStatus('12', 'anything', { config: CFG, fetchImpl: ok.impl })).toEqual({ ok: true, id: '12', status: 'ACTIVE' });
    expect(await meta.setAdsetDailyBudget('13', '42.5', { config: CFG, fetchImpl: ok.impl })).toEqual({ ok: true, id: '13', daily_budget: 42.5 });
    expect(ok.calls.map((c) => [c.path, c.params.status, c.params.daily_budget])).toEqual([['/v21.0/12', 'PAUSED', undefined], ['/v21.0/12', 'ACTIVE', undefined], ['/v21.0/13', undefined, '4250']]);
    expect((await meta.setEntityStatus('abc', 'PAUSED', { config: CFG, fetchImpl: ok.impl })).ok).toBe(false);
    expect((await meta.setAdsetDailyBudget('13', 0, { config: CFG, fetchImpl: ok.impl })).error).toMatch(/above zero/);
    const notConfirmed = graphStub(() => ({ json: { success: false } }));
    expect((await meta.setEntityStatus('12', 'PAUSED', { config: CFG, fetchImpl: notConfirmed.impl })).error).toMatch(/did not confirm/);
    const refused = graphStub(() => ({ status: 400, json: { error: { message: 'nope', code: 10 } } }));
    expect((await meta.setAdsetDailyBudget('13', 10, { config: CFG, fetchImpl: refused.impl })).code).toBe(10);
  });

  it('fetchLiveState reads ad sets and ads with budgets in dollars, and names the problem without a token', async () => {
    const stub = graphStub((c) => {
      if (/\/adsets$/.test(c.path)) return { json: { data: [{ id: '200', name: 'Live set', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '10000' }] } };
      if (/\/ads$/.test(c.path)) return { json: { data: [{ id: '1', name: 'A', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: '200', creative: { title: 'Head' } }] } };
      return { json: { data: [] } };
    });
    const r = await meta.fetchLiveState({ config: CFG, fetchImpl: stub.impl, now: 1 });
    expect(r.ok).toBe(true);
    expect(r.adsets).toEqual([{ id: '200', name: 'Live set', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: 100, schedule: null, rotation: 'live' }]);
    expect(r.ads).toEqual([{ id: '1', name: 'A', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: '200', adset_name: 'Live set', headline: 'Head', rotation: 'live' }]);
    expect(r.rules).toEqual([]);
    expect(r.schedule).toEqual({ managed: false });
    const none = await meta.fetchLiveState({ config: meta.adsConfig({}), fetchImpl: stub.impl });
    expect(none.ok).toBe(false);
    expect(none.error).toMatch(/META_ADS_ACCESS_TOKEN/);
    const broken = await meta.fetchLiveState({ config: CFG, fetchImpl: graphStub(() => ({ status: 400, json: { error: { message: 'Invalid OAuth access token', code: 190 } } })).impl });
    expect(broken.ok).toBe(false);
    expect(broken.error).toMatch(/token was rejected/);
  });
});

// The owner's time rule has the ad set off for the night (lib/meta-ads
// rotation as fetchLiveState now reports it): the ads are in rotation, not
// paused, so a pause must reach the ad itself.
function nightRules(adsetId) {
  const f = [{ field: 'entity_type', value: 'ADSET', operator: 'EQUAL' }, { field: 'id', value: [adsetId], operator: 'IN' }];
  return [
    { id: 'r-off', name: 'UK night off', status: 'ENABLED', evaluation_spec: { evaluation_type: 'SCHEDULE', filters: f }, execution_spec: { execution_type: 'PAUSE' }, schedule_spec: { schedule_type: 'CUSTOM', schedule: [{ start_minute: 450, end_minute: 450, days: [] }] } },
    { id: 'r-on', name: 'UK morning on', status: 'ENABLED', evaluation_spec: { evaluation_type: 'SCHEDULE', filters: f }, execution_spec: { execution_type: 'UNPAUSE' }, schedule_spec: { schedule_type: 'CUSTOM', schedule: [{ start_minute: 1110, end_minute: 1110, days: [] }] } }
  ];
}
function night() {
  const sched = { managed: true, on_rule: { id: 'r-on', name: 'UK morning on', at: '2026-11-06T07:30:00.000Z' }, off_rule: { id: 'r-off', name: 'UK night off', at: '2026-11-06T20:30:00.000Z' }, last_on_at: '2026-11-05T07:30:00.000Z', last_off_at: '2026-11-05T20:30:00.000Z', expected_on: false };
  return {
    adsets: [
      { id: '200', name: 'Live set', status: 'PAUSED', effective_status: 'PAUSED', daily_budget: 100, rotation: 'scheduled_off', schedule: sched },
      { id: '201', name: 'Old set', status: 'PAUSED', effective_status: 'PAUSED', daily_budget: 60, rotation: 'paused', schedule: null }
    ],
    ads: [
      { id: '1', name: 'A', status: 'ACTIVE', effective_status: 'ADSET_PAUSED', adset_id: '200', adset_name: 'Live set', rotation: 'scheduled_off' },
      { id: '2', name: 'B', status: 'ACTIVE', effective_status: 'ADSET_PAUSED', adset_id: '200', adset_name: 'Live set', rotation: 'scheduled_off' },
      { id: '3', name: 'C', status: 'PAUSED', effective_status: 'PAUSED', adset_id: '200', adset_name: 'Live set', rotation: 'paused' },
      { id: '9', name: 'Old', status: 'ACTIVE', effective_status: 'ADSET_PAUSED', adset_id: '201', adset_name: 'Old set', rotation: 'parent_paused' }
    ]
  };
}

describe('while the time rule has the ad set off', () => {
  const lim = actions.limits({});

  it('checkChange: a pause reaches the ad itself, the floor counts ads in rotation, pausing the set is pointed at the rule', () => {
    const live = night();
    expect(actions.checkChange(change({ target_id: '1' }), live, DRAFTS, lim)).toEqual({ ok: true });
    expect(actions.checkChange(change({ target_id: '3' }), live, DRAFTS, lim)).toEqual({ ok: false, skip: true, message: 'Already paused.' });
    // A set paused by hand is a different thing: nothing there will come back by itself.
    const old = actions.checkChange(change({ target_id: '9' }), live, DRAFTS, lim);
    expect(old.skip).toBe(true);
    expect(old.message).toBe('Not running (paused with its ad set), so there is nothing to pause.');
    live.ads[1].status = 'PAUSED'; live.ads[1].effective_status = 'PAUSED'; live.ads[1].rotation = 'paused';
    expect(actions.checkChange(change({ target_id: '1' }), live, DRAFTS, lim).message).toMatch(/would leave 0 live ads/);
    expect(actions.checkChange(change({ action: 'pause_adset', target_id: '200' }), live, DRAFTS, lim)).toEqual({
      ok: false, skip: true,
      message: 'Off right now by the rule "UK night off", but "UK morning on" turns it back on at 07:30 UK. To keep it off, pause the ads inside it or switch the rule off in Ads Manager.'
    });
    expect(actions.checkChange(change({ action: 'resume_adset', target_id: '200' }), live, DRAFTS, lim)).toEqual({ ok: true });
    expect(actions.checkChange(change({ action: 'pause_adset', target_id: '201' }), live, DRAFTS, lim)).toEqual({ ok: false, skip: true, message: 'Already paused.' });
  });

  it('applyChanges: the overnight pause is sent to Meta and the line says it survives the morning rule', async () => {
    const stub = graphStub();
    const n = night();
    const r = await actions.applyChanges({
      config: CFG, fetchImpl: stub.impl, ads: n.ads, adsets: n.adsets, drafts: DRAFTS, env: {},
      changes: [change({ id: 'chg-1', action: 'pause_ad', target_id: '1' }), change({ id: 'chg-2', action: 'resume_ad', target_id: '3' })]
    });
    const by = {}; r.results.forEach((x) => { by[x.id] = x; });
    expect(stub.calls.map((c) => [c.method, c.path, c.params.status])).toEqual([['POST', '/v21.0/3', 'ACTIVE'], ['POST', '/v21.0/1', 'PAUSED']]);
    expect(by['chg-1']).toMatchObject({ ok: true, message: 'Paused. It stays paused when its ad set comes back on.', before: 'ADSET_PAUSED', after: 'PAUSED' });
    expect(by['chg-2']).toMatchObject({ ok: true, message: 'Resumed; it runs when the rule turns its ad set back on.', before: 'PAUSED', after: 'ADSET_PAUSED' });
    expect(r.counts).toEqual({ applied: 2, skipped: 0, failed: 0 });
  });

  it('fetchLiveState reads the rules and marks the ad set and its ads as off by the clock', async () => {
    const stub = graphStub((c) => {
      if (/\/adsets$/.test(c.path)) return { json: { data: [{ id: '200', name: 'Live set', status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '10000' }] } };
      if (/\/ads$/.test(c.path)) return { json: { data: [{ id: '1', name: 'A', status: 'ACTIVE', effective_status: 'ADSET_PAUSED', adset_id: '200' }, { id: '3', name: 'C', status: 'PAUSED', effective_status: 'PAUSED', adset_id: '200' }] } };
      if (/\/adrules_library$/.test(c.path)) return { json: { data: nightRules('200') } };
      return { json: { data: [] } };
    });
    // Thu 5 Nov 2026 21:30Z: inside the off window (off 07:30 Sydney, on 18:30 Sydney).
    const r = await meta.fetchLiveState({ config: CFG, fetchImpl: stub.impl, now: Date.UTC(2026, 10, 5, 21, 30, 0) });
    expect(r.ok).toBe(true);
    expect(stub.calls.some((c) => /\/adrules_library$/.test(c.path))).toBe(true);
    expect(r.rules.map((x) => x.name)).toEqual(['UK night off', 'UK morning on']);
    expect(r.adsets[0].rotation).toBe('scheduled_off');
    expect(r.adsets[0].schedule.on_rule).toEqual({ id: 'r-on', name: 'UK morning on', at: '2026-11-06T07:30:00.000Z' });
    expect(r.ads.map((a) => a.rotation)).toEqual(['scheduled_off', 'paused']);
    expect(r.schedule).toMatchObject({ managed: true, state: 'off', adset_name: 'Live set' });
    // The rules read failing costs only the schedule.
    const noRules = graphStub((c) => {
      if (/\/adsets$/.test(c.path)) return { json: { data: [{ id: '200', name: 'Live set', status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '10000' }] } };
      if (/\/ads$/.test(c.path)) return { json: { data: [{ id: '1', name: 'A', status: 'ACTIVE', effective_status: 'ADSET_PAUSED', adset_id: '200' }] } };
      return { status: 400, json: { error: { message: 'no', code: 200 } } };
    });
    const r2 = await meta.fetchLiveState({ config: CFG, fetchImpl: noRules.impl, now: 1 });
    expect(r2.ok).toBe(true);
    expect(r2.rules).toEqual([]);
    expect(r2.adsets[0].rotation).toBe('paused');
    expect(r2.ads[0].rotation).toBe('parent_paused');
    expect(r2.schedule).toEqual({ managed: false });
  });
});
