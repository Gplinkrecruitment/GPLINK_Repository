// Regressions from the 26 Nov 2026 onboarding QA sweep (4 agents drove the
// wizard end to end on the local stack). Each block names the bug it guards.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'js', 'onboarding.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'pages', 'onboarding.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  expect(start, name).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unterminated ' + name);
}

describe('newer draft wins between devices and tabs', () => {
  it('saves carry the base revision; the merge uses server revisions, never device clocks', () => {
    const save = extractFn(js, 'sendSave');
    expect(save).toMatch(/_clientId: CLIENT_ID/);
    expect(save).toMatch(/d\.stale && d\.draft/);
    expect(extractFn(js, 'mergeServerOnboarding')).toMatch(/shouldAdoptServerDraft\(state, serverBlob\)/);
    expect(extractFn(js, 'shouldAdoptServerDraft')).not.toMatch(/updatedAt|draftStamp/);
  });

  function loadAdopt() {
    const src = [extractFn(js, 'isDefaultLocalState'), extractFn(js, 'draftScore'), extractFn(js, 'shouldAdoptServerDraft')].join('\n');
    // eslint-disable-next-line no-new-func
    return new Function(src + '; return shouldAdoptServerDraft;')();
  }
  const filled = { targetDate: '2027-04-25', preferredCity: 'Perth', whoMoving: 'just_me' };

  it('server revision wins over a synced or stale local copy (second device, clock skew)', () => {
    const adopt = loadAdopt();
    expect(adopt({ ...filled, country: 'GB', _baseRev: 3 }, { ...filled, preferredCity: 'Sydney', _rev: 5 })).toBe(true);
    expect(adopt({ ...filled, country: 'GB', _baseRev: 5, _dirty: false }, { ...filled, _rev: 5 })).toBe(true);
  });
  it('unsaved local edits made on the current revision are kept (reload mid-save, no country yet)', () => {
    const adopt = loadAdopt();
    expect(adopt({ ...filled, _baseRev: 4, _dirty: true }, { _rev: 4 })).toBe(false);
    expect(adopt({ ...filled, _baseRev: 4, _dirty: true }, { _rev: 5, preferredCity: 'Sydney' })).toBe(true);
  });
  it('legacy drafts (no revisions): the fuller copy wins', () => {
    const adopt = loadAdopt();
    expect(adopt({ country: 'GB', currentStep: 2 }, { ...filled, country: 'GB', registerNumber: '7123456', currentStep: 4 })).toBe(true);
    expect(adopt({ ...filled, country: 'GB', registerNumber: '7123456' }, { country: 'GB' })).toBe(false);
  });
  it('an empty browser always takes the server copy', () => {
    expect(loadAdopt()({ country: '', qualDocs: {} }, { preferredCity: 'Perth' })).toBe(true);
  });

  it('the server refuses a save based on an older revision from another page and hands the draft back', () => {
    // eslint-disable-next-line no-new-func
    const write = new Function(extractFn(server, 'onboardingDraftWrite') + '; return onboardingDraftWrite;')();
    const stored = { preferredCity: 'Sydney', _rev: 5, _clientId: 'laptop' };
    const stale = write({ preferredCity: 'Brisbane', _baseRev: 3, _clientId: 'phone' }, stored);
    expect(stale.stale).toBe(true);
    expect(stale.draft.preferredCity).toBe('Sydney');
    expect(write({ preferredCity: 'Perth', _baseRev: 4, _clientId: 'laptop' }, stored).stale).toBe(false);
    const ok = write({ preferredCity: 'Perth', _baseRev: 5, _clientId: 'phone', _dirty: true }, JSON.stringify(stored));
    expect(ok.stale).toBe(false);
    expect(ok.next._rev).toBe(6);
    expect(ok.next._baseRev).toBeUndefined();
    expect(ok.next._dirty).toBeUndefined();
    expect(write({ preferredCity: 'Perth' }, stored).next._rev).toBe(6);
    expect(write({ preferredCity: 'Perth', _baseRev: 0 }, null).next._rev).toBe(1);
    expect(server).toMatch(/sendJson\(res, 200, \{ ok: true, stale: true, draft: obWrite\.draft \}\)/);
  });

  it('a refused save replays this page\'s own edits on top of the newer copy (no discarded clicks)', () => {
    const send = extractFn(js, 'sendSave');
    expect(send).toMatch(/fieldsChangedSinceAck\(\)/);
    expect(send).toMatch(/changed\.forEach\(function \(k\) \{ state\[k\] = mine\[k\]; \}\)/);
    expect(send).toMatch(/retryAfter = true/);
  });
  it('only one save is in flight per page; the latest state goes next', () => {
    expect(extractFn(js, 'saveState')).toMatch(/if \(saveInFlight\) \{ saveQueued = true;/);
    expect(extractFn(js, 'sendSave')).toMatch(/if \(saveQueued \|\| retryAfter\)/);
  });
  it('fieldsChangedSinceAck diffs against the last acknowledged copy', () => {
    const src = ['var SYNC_FIELDS = ["targetDate", "preferredCity", "country"];', 'var lastAcked = null; var state;',
      'function defaultState(){ return { targetDate: "", preferredCity: "", country: "" }; }',
      extractFn(js, 'snapshotFields'), extractFn(js, 'fieldsChangedSinceAck'),
      'return function (acked, now) { lastAcked = acked ? snapshotFields(acked) : null; state = now; return fieldsChangedSinceAck(); };'].join('\n');
    // eslint-disable-next-line no-new-func
    const diff = new Function(src)();
    expect(diff({ targetDate: '2027-01-01', preferredCity: 'Perth', country: '' }, { targetDate: '2027-01-01', preferredCity: 'Sydney', country: '' })).toEqual(['preferredCity']);
    expect(diff(null, { targetDate: '2027-01-01', preferredCity: '', country: '' })).toEqual(['targetDate']);
  });
  it('opening the page does not save an unchanged server copy', () => {
    expect(js).toMatch(/if \(!startupNeedsSave && !state\._dirty && \(state\.currentStep \|\| 0\) === currentStep\) suppressNextStepSave = true;/);
  });

  it('another tab saving newer answers is adopted', () => {
    expect(js).toMatch(/addEventListener\("storage"/);
  });
});

describe('restored answers are painted into the fields', () => {
  it('hydrateFormFromState runs after the server merge and on waitlist go-back', () => {
    const fn = extractFn(js, 'hydrateFormFromState');
    for (const needle of ['targetDateInput.value', 'citySelect.value', 'countrySearch.value', 'updateWhoUI()', 'renderQualDocSlots()']) {
      expect(fn).toContain(needle);
    }
    expect(js).toMatch(/mergeServerOnboarding\(blob, selCountry\);\s*\n\s*hydrateFormFromState\(\);/);
    const exit = extractFn(js, 'exitEligibilityOfframp');
    expect(exit).toMatch(/hydrateFormFromState\(\)/);
    expect(exit).toMatch(/goToStep\(currentStep\)/);
  });
});

describe('completion only celebrates a confirmed save', () => {
  const submit = extractFn(js, 'submitOnboarding');
  it('a failed /complete keeps the GP on the step with an error', () => {
    expect(submit).toMatch(/if \(!completed\)/);
    expect(submit).toMatch(/We couldn't finish setting up your account/);
    expect(submit.indexOf('if (!completed)')).toBeLessThan(submit.indexOf('successScreen.classList.add("show")'));
  });
  it('no parallel server save races /complete, and the backup PUT is wrapped in {state}', () => {
    expect(submit).toMatch(/saveState\(\{ localOnly: true \}\)/);
    expect(submit).not.toMatch(/saveState\(\);/);
    expect(submit).toMatch(/JSON\.stringify\(\{ state: \{ gp_onboarding_complete: true/);
  });
  it('the final gate re-checks Plan your move (?step=4 skip)', () => {
    expect(js).toMatch(/!DOCS_ONLY_MODE && !canBypassOnboardingValidation\(\) && !validateStep\(1\)/);
  });
});

describe('smaller fixes', () => {
  it('an interrupted scan is never restored as "scanning"', () => {
    // eslint-disable-next-line no-new-func
    const clear = new Function(extractFn(js, 'clearInterruptedScans') + '; return clearInterruptedScans;')();
    const s = clear({ idVerification: { status: 'scanning', fileName: 'p.png' }, qualDocs: { a: { status: 'scanning' }, b: { status: 'verified' } } });
    expect(s.idVerification).toBeNull();
    expect(s.qualDocs.a.status).toBe('');
    expect(s.qualDocs.b.status).toBe('verified');
  });
  it('changing country clears the register number', () => {
    expect(extractFn(js, 'selectCountry')).toMatch(/state\.country !== c\.code\) state\.registerNumber = ""/);
  });
  it('review date is a local calendar date', () => {
    // eslint-disable-next-line no-new-func
    const fmt = new Function(extractFn(js, 'formatLocalDate') + '; return formatLocalDate;')();
    expect(fmt('2027-03-15')).toMatch(/15 March 2027/);
  });
  it('raw AI failure text is humanised', () => {
    expect(js).toMatch(/invalid response\|empty response/);
  });
  it('children_count is only stored when children are moving', () => {
    // eslint-disable-next-line no-new-func
    const has = new Function(extractFn(server, 'onboardingHasChildren') + '; return onboardingHasChildren;')();
    expect(has('just_me')).toBe(false);
    expect(has('me_partner')).toBe(false);
    expect(has('me_partner_children')).toBe(true);
    expect(server).not.toMatch(/if \(body\.childrenCount\) profileUpdate\.children_count = body\.childrenCount;/);
  });
  it('copy: dual-qualification hint, ID step, completion email', () => {
    expect(html).toMatch(/CCFP and MRCGP/);
    expect(html).not.toMatch(/match it to your qualifications/);
    expect(server).not.toMatch(/The next step is MyIntealth, this is where your qualification verification begins/);
  });
});
