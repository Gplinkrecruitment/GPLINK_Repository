// Australian GP build, WP-06: the staff tools on the CEO dashboard's
// Candidates tab (js/ceo-ats-candidates.js). There is no DOM in the test
// runner, so the render functions are extracted from the file and run with a
// stub ATS, the same way the other candidate-profile tests do.
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SRC = read('js/ceo-ats-candidates.js');
const HTML = read('pages/ceo-dashboard.html');
const CSS = read('css/ceo-ats.css');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('missing function ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
function extractVar(src, name) {
  const start = src.indexOf('var ' + name + ' = ');
  if (start === -1) throw new Error('missing var ' + name);
  const end = src.indexOf('\n  ];', start) !== -1 && src.indexOf('\n  ];', start) < src.indexOf('\n  };', start) || src.indexOf('\n  };', start) === -1
    ? src.indexOf('\n  ];', start) + 5 : src.indexOf('\n  };', start) + 5;
  return src.slice(start, end);
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function load(opts) {
  const o = opts || {};
  const body = [
    'var auOn = ' + (o.auOn === false ? 'false' : 'true') + ';',
    'var auFilters = ' + JSON.stringify(o.filters || []) + ';',
    'var auPathwayFilter = ' + JSON.stringify(o.pathway || '') + ';',
    extractVar(SRC, 'AU_REGISTRATION_TYPES'), extractVar(SRC, 'AU_FELLOWSHIPS'), extractVar(SRC, 'AU_WORK_RIGHTS'),
    extractVar(SRC, 'AU_PATHWAY_OPTIONS'), extractVar(SRC, 'AU_DPA_REASON'),
    extractFn(SRC, 'field'), extractFn(SRC, 'shortDate'), extractFn(SRC, 'registerInputMode'), extractFn(SRC, 'registerRowInner'),
    extractFn(SRC, 'auOptions'), extractFn(SRC, 'auToolbarInner'), extractFn(SRC, 'auRowChip'), extractFn(SRC, 'auAddCandidateModalHtml'),
    extractFn(SRC, 'auWaitlistRowsHtml'), extractFn(SRC, 'auPathwayCardInner'), extractFn(SRC, 'auYesNo'), extractFn(SRC, 'auCheckCardInner'),
    extractFn(SRC, 'auCollectCheck'), extractFn(SRC, 'auTasksCardInner'), extractFn(SRC, 'auCardsHtml'),
    'return { registerInputMode: registerInputMode, registerRowInner: registerRowInner, auToolbarInner: auToolbarInner, auRowChip: auRowChip,',
    '  auAddCandidateModalHtml: auAddCandidateModalHtml, auWaitlistRowsHtml: auWaitlistRowsHtml, auPathwayCardInner: auPathwayCardInner,',
    '  auCheckCardInner: auCheckCardInner, auCollectCheck: auCollectCheck, auTasksCardInner: auTasksCardInner, auCardsHtml: auCardsHtml };'
  ].join('\n');
  const ATS = { esc, escAttr: esc, emptyHtml: (l) => '<div class="ats-empty">' + esc(l) + '</div>', loadingHtml: (l) => '<div>' + esc(l) + '</div>', isConsultant: () => true };
  return new Function('ATS', body)(ATS);
}

const FILTERS = [
  { value: '', label: 'All pathways' }, { value: 'overseas', label: 'Overseas' }, { value: 'au_vr', label: 'Australian VR' },
  { value: 'au_restricted', label: 'Australian restricted' }, { value: 'au_non_vr', label: 'Non-VR' },
  { value: 'au_registrar', label: 'Registrar' }, { value: 'needs_review', label: 'Needs review' }
];

function auCandidate(over) {
  return Object.assign({
    case_id: 'case-1', user_id: 'user-1', name: 'Test Auvr',
    onboarding: { completed: false, registerBody: 'ahpra', registerNumber: 'MED0001234567', registerStatus: 'pending_verification', registerLabel: 'Ahpra' },
    au: {
      enabled: true, chip: 'Australian VR', stage_label: 'Placement', placing_consultant: 'consultant@gplink-test.local',
      public_register_url: 'https://www.ahpra.gov.au/Registration/Registers-of-Practitioners.aspx',
      pathway: { pathway: 'au_vr', segment: 'A', isAu: true, launched: true, recorded: true, confirmed: false, needsStaffReview: true, dpaRestricted: true, dpaRestrictedReason: 'self_declared_no_awaiting_staff_confirmation' },
      record: { candidate_pathway: 'au_vr', pathway_set_by: 'consultant@gplink-test.local' },
      credentials: { ahpra_number: 'MED0001234567', has_conditions: false, moratorium_19ab_status: 'no' },
      case: { id: 'case-1', stage: 'placement' },
      check_task: { id: 't1', status: 'open', due_date: '2026-11-22' }, segment_review_task: null
    }
  }, over || {});
}

describe('the switch: nothing Australian renders until the server says it is on', () => {
  it('learns it from the candidate list (or a profile), never from a request of its own', () => {
    expect(SRC).toContain("if (d.au_pathway_enabled === true) auEnable(d.pathway_filters);");
    expect(SRC).toContain('if (d.candidate.au && d.candidate.au.enabled === true) auOn = true;');
    expect(SRC).toMatch(/var auOn = false;/);
    // The pathway filter is only added to the request once the switch is known on.
    expect(SRC).toContain("(auOn && auPathwayFilter ? '&pathway=' + encodeURIComponent(auPathwayFilter) : '')");
    // No Australian endpoint is called outside the Australian section.
    const before = SRC.slice(0, SRC.indexOf('AUSTRALIAN GP BUILD (WP-06): staff tools'));
    expect(before).not.toMatch(/\/api\/ats\/candidate\/options|\/api\/admin\/eligibility-waitlist|\/api\/ats\/candidate\/tasks|\/api\/admin\/candidate\/pathway/);
    // The toolbar is injected, not part of the scaffold markup.
    const scaffold = extractFn(SRC, 'listScaffold');
    expect(scaffold).not.toMatch(/ats-au-|ats-cand-pathway|Add candidate|Eligibility waitlist/);
    expect(extractFn(SRC, 'auEnsureToolbar')).toMatch(/if \(!auOn\) return;/);
    expect(extractFn(SRC, 'auHandleDetailClick')).toMatch(/if \(!auOn \|\| !e\.target\.closest\) return false;/);
    expect(extractFn(SRC, 'auLoadTasks')).toMatch(/if \(!auOn \|\|/);
  });

  it('switch off (no au data): no chip, no cards, and the profile register row is the one it always was', () => {
    const ui = load({ auOn: false });
    const c = { case_id: 'c', user_id: 'u', onboarding: { registerNumber: '7654321', registerLabel: 'GMC', registerStatus: 'pending_verification', registerSearchUrl: 'https://www.gmc-uk.org/registrants/register' } };
    expect(ui.auRowChip({ name: 'Test Ukgp' })).toBe('');
    expect(ui.auCardsHtml(c)).toBe('');
    expect(ui.auCardsHtml(auCandidate())).toBe('');   // even if a stale payload carried it
    const row = ui.registerRowInner(c);
    expect(row).toContain('GMC register: 7654321');
    expect(row).toContain('data-action="verified"');
    expect(row).toContain('data-action="auto"');
  });
});

describe('ADM-12: the register number field accepts an Ahpra number', () => {
  it('text keyboard for Ahpra, number pad for the digit-only registers as before', () => {
    const ui = load();
    expect(ui.registerInputMode({ registerBody: 'ahpra' })).toBe('text');
    expect(ui.registerInputMode({ registerLabel: 'Ahpra' })).toBe('text');
    expect(ui.registerInputMode({ registerBody: 'gmc', registerLabel: 'GMC' })).toBe('numeric');
    expect(ui.registerInputMode({ registerBody: 'mcnz' })).toBe('numeric');
    expect(ui.registerInputMode({})).toBe('numeric');
    expect(SRC).toContain('id="ats-register-input" inputmode="\' + registerInputMode(ob) + \'"');
    expect(SRC).not.toContain('id="ats-register-input" inputmode="numeric"');
  });

  it('the Ahpra check card has a text field for the number and a plain link to the public register', () => {
    const html = load().auCheckCardInner(auCandidate());
    expect(html).toMatch(/<input type="text" class="ats-au-input" id="ats-au-check-number" inputmode="text"[^>]*value="MED0001234567">/);
    expect(html).not.toMatch(/id="ats-au-check-number"[^>]*inputmode="numeric"/);
    expect(html).toContain('<a class="ats-btn ats-btn-ghost ats-btn-sm" id="ats-au-register-link" href="https://www.ahpra.gov.au/Registration/Registers-of-Practitioners.aspx" target="_blank" rel="noopener noreferrer">Open the public Ahpra register');
    // Nothing in the page fetches the register: it is only ever a link.
    expect(SRC).not.toMatch(/(fetch|ATS\.api|ATS\.swr)\([^)]*ahpra\.gov\.au/);
    // An Australian doctor is not offered the one-click stamps.
    expect(load().registerRowInner(auCandidate())).toBe('');
  });
});

describe('the pathway chip and filter', () => {
  const ui = load({ filters: FILTERS });
  it('one chip per row, in words; an unconfirmed Australian pathway says so; needs-review is flagged', () => {
    expect(ui.auRowChip({ au: { pathway: 'overseas_esp', label: 'Overseas', is_au: false, recorded: false } })).toBe(' <span class="ats-pill muted ats-au-chip" title="No pathway recorded: treated as overseas">Overseas</span>');
    const vr = ui.auRowChip({ au: { pathway: 'au_vr', label: 'Australian VR', is_au: true, recorded: true, confirmed: true, needs_review: false } });
    expect(vr).toContain('class="ats-pill green ats-au-chip"');
    expect(vr).toContain('>Australian VR</span>');
    expect(vr).not.toContain('Needs review');
    const b = ui.auRowChip({ au: { pathway: 'au_restricted', label: 'Australian restricted', is_au: true, recorded: true, confirmed: false, needs_review: true } });
    expect(b).toContain('class="ats-pill amber ats-au-chip"');
    expect(b).toContain('Australian restricted · unconfirmed');
    expect(b).toContain('<span class="ats-pill red ats-au-chip" title="Waiting on the Ahpra register check or a staff decision">Needs review</span>');
    expect(ui.auRowChip({ au: { label: '<b>x</b>', is_au: false } })).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(extractFn(SRC, 'rowHtml')).toContain('careerLockChip + auRowChip(c)');
  });

  it('the filter lists All / Overseas / Australian VR / Australian restricted / Non-VR / Registrar / Needs review', () => {
    const html = ui.auToolbarInner();
    expect((html.match(/<option value="[^"]*"[^>]*>([^<]*)</g) || []).map((s) => s.replace(/.*>/, '').replace('<', '')))
      .toEqual(['All pathways', 'Overseas', 'Australian VR', 'Australian restricted', 'Non-VR', 'Registrar', 'Needs review']);
    expect(html).toContain('id="ats-au-add-candidate">＋ Add candidate</button>');
    expect(html).toContain('id="ats-au-waitlist">Eligibility waitlist</button>');
    expect(load({ filters: FILTERS, pathway: 'needs_review' }).auToolbarInner()).toContain('<option value="needs_review" selected>Needs review</option>');
  });
});

describe('Add candidate', () => {
  const html = load().auAddCandidateModalHtml({
    me: 'consultant@gplink-test.local',
    pathways: [{ value: 'overseas_esp', label: 'Overseas', is_au: false, launched: true }, { value: 'au_vr', label: 'Australian VR', is_au: true, launched: true },
      { value: 'au_restricted', label: 'Australian restricted', is_au: true, launched: false }],
    states: ['NSW', 'VIC'],
    consultants: [{ email: 'consultant@gplink-test.local', name: 'Casey Test' }, { email: 'ceo@gplink-test.local', name: '' }]
  });
  it('works without an existing account: name, email, phone, pathway, Ahpra number, state, consultant, notes', () => {
    ['ats-au-add-first', 'ats-au-add-last', 'ats-au-add-email', 'ats-au-add-phone', 'ats-au-add-pathway', 'ats-au-add-ahpra', 'ats-au-add-state', 'ats-au-add-consultant', 'ats-au-add-notes']
      .forEach((id) => { expect(html).toContain('id="' + id + '"'); expect(html).toContain('for="' + id + '"'); });
    expect(html).toContain('<option value="au_vr" selected>Australian VR</option>');
    expect(html).toContain('Australian restricted (held for staff review)');
    expect(html).toContain('<option value="consultant@gplink-test.local" selected>Casey Test (consultant@gplink-test.local) (me)</option>');
    expect(html).toMatch(/id="ats-au-add-ahpra" inputmode="text"/);
    expect(html).toContain('it is not confirmed until the Ahpra register check is saved');
    expect(html).toContain('Create and send invite');
  });
  it('posts to the create endpoint and handles "already has an account" by offering their profile', () => {
    const fn = extractFn(SRC, 'auOpenAddCandidate');
    expect(fn).toContain("ATS.api('/api/ats/candidate', { method: 'POST', body: body })");
    expect(fn).toContain("res.code === 'candidate_exists' && res.case_id");
    expect(fn).toContain('window.atsOpenCandidate(res.case_id)');
    // The Australian-only fields are only sent for an Australian pathway.
    expect(fn).toContain('if (isAu) { body.ahpra_number');
  });
});

describe('Eligibility waitlist', () => {
  it('lists who is parked, each with "Release and invite"', () => {
    const ui = load();
    const html = ui.auWaitlistRowsHtml({ ok: true, items: [{ user_id: 'u-9', name: 'Test Parked', email: 'parked@gplink-test.local', country: 'Australia', waitlisted_at: '2026-11-10T00:00:00.000Z' }] });
    expect(html).toContain('Test Parked');
    expect(html).toContain('parked@gplink-test.local · said they trained in Australia');
    expect(html).toContain('<button type="button" class="ats-btn ats-btn-primary ats-btn-sm ats-au-waitlist-release" data-user-id="u-9">Release and invite</button>');
    expect(ui.auWaitlistRowsHtml({ ok: true, items: [] })).toContain('Nobody is parked');
    expect(ui.auWaitlistRowsHtml({ ok: false })).toContain('Could not load');
  });
  it('calls the WP-05 release endpoint with send_invite true', () => {
    const fn = extractFn(SRC, 'auOpenWaitlist');
    expect(fn).toContain("ATS.api('/api/admin/eligibility-waitlist/release', { method: 'POST', body: { user_id: uid, send_invite: true } })");
    expect(fn).toContain("ATS.api('/api/admin/eligibility-waitlist')");
  });
});

describe('the profile: pathway control, Ahpra check, tasks', () => {
  const ui = load();
  it('shows the pathway, who set it, whether it is confirmed, the DPA flag in words, and the owner', () => {
    const html = ui.auPathwayCardInner(auCandidate());
    expect(html).toContain('>Australian VR</span>');
    expect(html).toContain('<span class="ats-pill amber">Not confirmed</span>');
    expect(html).toContain('<span class="ats-pill red">Needs review</span>');
    expect(html).toContain('Yes, DPA roles only');
    expect(html).toContain('the doctor says it does not apply, but staff have not confirmed it');
    expect(html).toContain('consultant@gplink-test.local');
    expect(html).toContain('id="ats-au-pathway-save" data-user-id="user-1">Set and confirm pathway</button>');
    expect(html).toContain('id="ats-au-19ab-save" data-user-id="user-1">Confirm 19AB</button>');
    expect(html).toContain('id="ats-au-invite-again"');
    expect(html).toContain('<option value="au_vr" selected>Australian VR (segment A)</option>');
    const cleared = ui.auPathwayCardInner(auCandidate({
      onboarding: { completed: true },
      au: Object.assign({}, auCandidate().au, {
        pathway: { pathway: 'au_vr', segment: 'A', isAu: true, launched: true, recorded: true, confirmed: true, needsStaffReview: false, dpaRestricted: false, dpaRestrictedReason: 'staff_confirmed_19ab_not_applicable' },
        credentials: { moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: 'ceo@gplink-test.local', moratorium_19ab_status: 'no' }
      })
    }));
    expect(cleared).toContain('<span class="ats-pill green">Confirmed by staff</span>');
    expect(cleared).toContain('No, may see roles outside a DPA');
    expect(cleared).toContain('Does not apply (confirmed by ceo@gplink-test.local)');
    expect(cleared).not.toContain('Needs review');
    expect(cleared).not.toContain('ats-au-invite-again');
  });

  it('an overseas doctor gets the pathway control only (no Ahpra check, no 19AB)', () => {
    const c = auCandidate({ au: { enabled: true, chip: 'Overseas', pathway: { pathway: 'overseas_esp', segment: 'overseas', isAu: false, launched: true, recorded: false, confirmed: false, needsStaffReview: false, dpaRestricted: true, dpaRestrictedReason: 'legacy_country_restricted' }, record: {}, credentials: null } });
    const html = ui.auCardsHtml(c);
    expect(html).toContain('id="ats-au-pathway-card"');
    expect(html).not.toContain('ats-au-check-card');
    expect(html).not.toContain('ats-au-tasks-card');
    expect(html).not.toContain('ats-au-19ab-save');
    expect(html).toContain('Nothing recorded');
    expect(html).toContain('<option value="overseas_esp" selected>Overseas</option>');
  });

  it('the check card: three outcomes, and it reads the form into the body the server expects', () => {
    const html = ui.auCheckCardInner(auCandidate());
    ['verified', 'not_matched', 'pending'].forEach((o) => expect(html).toContain('class="ats-btn ' + (o === 'verified' ? 'ats-btn-primary' : 'ats-btn-ghost') + ' ats-btn-sm ats-au-check-save" data-outcome="' + o + '" data-user-id="user-1"'));
    expect(html).toContain('Check task open');
    expect(html).toContain('Not checked yet');
    ['ats-au-check-type', 'ats-au-check-expiry', 'ats-au-check-fellowship', 'ats-au-check-rights', 'ats-au-check-19ab'].forEach((id) => expect(html).toContain('id="' + id + '"'));
    ['specialist', 'conditions', 'undertakings', 'notations'].forEach((k) => expect(html).toContain('name="ats-au-check-' + k + '" value="yes"'));
    // The doctor's own answer is shown as a hint, never pre-ticked as a staff finding.
    expect(html).not.toMatch(/name="ats-au-check-conditions" value="(yes|no)" checked/);
    expect(html).toContain('The doctor told us: conditions, undertakings or notations no');

    const values = {
      'ats-au-check-number': 'med0001234567', 'ats-au-check-note': '', 'ats-au-check-type': 'specialist', 'ats-au-check-expiry': '2027-09-30',
      'ats-au-check-fellowship': 'fracgp', 'ats-au-check-rights': '', 'ats-au-check-19ab': 'no', 'ats-au-check-conditions-text': 'ignored', 'ats-au-check-notations-text': 'A notation (FAKE).'
    };
    const radios = { 'ats-au-check-specialist': 'yes', 'ats-au-check-conditions': 'no', 'ats-au-check-undertakings': 'no', 'ats-au-check-notations': 'yes' };
    const get = (id) => values[id] || '';
    const radio = (name) => radios[name] || '';
    expect(ui.auCollectCheck(get, radio, 'verified')).toEqual({
      action: 'ahpra_check', outcome: 'verified', ahpra_number: 'med0001234567', note: '', registration_type: 'specialist', registration_expiry: '2027-09-30',
      fellowship_type: 'fracgp', specialist_gp: true, has_conditions: false, has_undertakings: false, has_notations: true, notations_text: 'A notation (FAKE).',
      moratorium_19ab_confirmed: 'no'
    });
    // Not matched sends nothing about the registration; an unanswered flag is not sent at all.
    expect(ui.auCollectCheck(get, radio, 'not_matched')).toEqual({ action: 'ahpra_check', outcome: 'not_matched', ahpra_number: 'med0001234567', note: '' });
    expect(ui.auCollectCheck(() => '', () => '', 'pending')).toEqual({ action: 'ahpra_check', outcome: 'pending', ahpra_number: '', note: '' });
    expect(extractFn(SRC, 'auSaveCheck')).toContain("ATS.api('/api/ats/candidate/register-verification', { method: 'POST', body: body })");
  });

  it('the task list is read only and says so', () => {
    const html = ui.auTasksCardInner({ ok: true, tasks: [
      { id: 't1', task_type: 'ahpra_register_check', title: 'Check Ahpra registration on the public register: Dr Test Auvr', status: 'open', priority: 'normal', due_date: '2026-11-22', stage_label: 'Placement', open: true },
      { id: 't2', task_type: 'segment_review', title: 'Decide the segment <b>', status: 'completed', priority: 'high', open: false, completed_at: '2026-11-21T00:00:00Z', completed_by: 'ceo@gplink-test.local' }
    ] });
    expect(html).toContain('Read only');
    expect(html).toContain('Check Ahpra registration on the public register: Dr Test Auvr');
    expect(html).toContain('ahpra register check · Placement · due ');
    expect(html).toContain('Decide the segment &lt;b&gt;');
    expect(html).toContain('by ceo@gplink-test.local');
    expect(html).not.toMatch(/<button|<select|<input/);
    expect(ui.auTasksCardInner(null)).toContain('Loading');
    expect(ui.auTasksCardInner({ ok: false, message: 'Tasks can only be viewed here for a doctor on an Australian pathway.' })).toContain('Tasks can only be viewed here');
    expect(extractFn(SRC, 'auLoadTasks')).toContain("ATS.api('/api/ats/candidate/tasks?case_id=' + encodeURIComponent(c.case_id))");
  });
});

describe('cache busters and styles', () => {
  it('the candidates script and the ATS stylesheet are bumped, and the stylesheet is not behind the script', () => {
    const jsV = HTML.match(/ceo-ats-candidates\.js\?v=(\d{8}[a-z])/);
    const cssV = HTML.match(/ceo-ats\.css\?v=(\d{8}[a-z])/);
    expect(jsV[1] >= '20261120a').toBe(true);
    expect(cssV[1] >= jsV[1]).toBe(true);
    expect(HTML).not.toContain('ceo-ats-candidates.js?v=20261029b');
    expect(HTML).not.toContain('ceo-ats.css?v=20261030a');
    // No new script or stylesheet tag was added to the dashboard for this.
    expect(HTML).not.toMatch(/ceo-ats-au|au-staff/);
  });
  it('every class the Australian markup uses is styled, and the form stacks on a narrow screen', () => {
    ['.ats-au-toolbar', '.ats-au-chip', '.ats-au-grid', '.ats-au-controls', '.ats-au-input', '.ats-au-hint', '.ats-au-error', '.ats-au-yn', '.ats-au-radio', '.ats-au-flagtext']
      .forEach((cls) => expect(CSS, cls).toContain(cls));
    expect(CSS).toMatch(/@media \(max-width: 700px\) \{\s*\.ats-au-grid \{ grid-template-columns:1fr; \}/);
  });
});
