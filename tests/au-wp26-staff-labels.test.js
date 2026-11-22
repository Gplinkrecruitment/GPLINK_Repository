// WP-26 (Australian GP build): js/au-staff-labels.js, the one place the two
// staff dashboards turn a stored key into words for an Australian case.
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const L = require('../js/au-staff-labels.js');
const ladders = require('../lib/journey-ladders.js');
const prestart = require('../lib/au-prestart.js');
const roleEligibility = require('../lib/role-eligibility.js');
const matchLib = require('../lib/ai-candidate-job-match.js');
const staffTools = require('../lib/au-staff-tools.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('the labels agree with the server-side sources they stand for', () => {
  it('the Australian stage labels are the staff labels of lib/journey-ladders.js', () => {
    expect(L.AU_STAGES.map((s) => s.key)).toEqual(ladders.AU_STAGES);
    ladders.AU_LADDER.forEach((s) => expect(L.stageLabel(s.key, true), s.key).toBe(s.label));
    // an overseas stage keeps its own name; 'complete' is on both ladders
    ['myintealth', 'amc', 'ahpra', 'visa', 'pbs', 'commencement'].forEach((k) => expect(L.stageLabel(k, false)).toBe(ladders.stageLabel(k)));
    expect(L.stageLabel('complete', true)).toBe('Complete');
    expect(L.auStageOptions().map((o) => o.value)).toEqual(ladders.AU_STAGES);
  });

  it('every Australian-only stage is known, and no raw key comes back for one', () => {
    ladders.AU_ONLY_STAGES.forEach((k) => {
      expect(L.isAuOnlyStage(k)).toBe(true);
      expect(L.stageLabel(k)).not.toBe(k);
    });
    expect(L.isAuOnlyStage('complete')).toBe(false);
    expect(L.isAuOnlyStage('ahpra')).toBe(false);
    expect(L.stageLabel('prestart')).toBe('Pre-start');
    expect(L.stageLabel('commenced')).toBe('Commenced');
  });

  it('a case not yet moved off an overseas stage is shown at the first Australian rung', () => {
    expect(L.auStageOf('myintealth')).toBe('placement');
    expect(L.auStageOf('')).toBe('placement');
    expect(L.auStageOf('guarantee')).toBe('guarantee');
  });

  it('every pathway has a label and the Australian ones say their segment', () => {
    ['au_vr', 'au_restricted', 'au_non_vr', 'au_registrar'].forEach((p) => {
      expect(L.pathwayLabel(p)).toBe(staffTools.pathwayChipLabel(p));
      expect(L.pathwayBadge(p)).toMatch(/\(segment [ABC]\)$/);
      expect(L.isAuPathway(p)).toBe(true);
    });
    expect(L.pathwayBadge('overseas_esp')).toBe('Overseas');
    expect(L.isAuPathway('overseas_esp')).toBe(false);
    expect(L.isAuPathway(null)).toBe(false);
    expect(L.pathwayLabel('')).toBe('Overseas');
  });

  it('every Australian task type has words (never an underscore)', () => {
    const types = prestart.MANUAL_TASK_TYPES.concat(['ahpra_register_check', 'segment_review', 'invoice_due', 'guarantee_checkin']);
    types.forEach((t) => {
      const label = L.taskTypeLabel(t);
      expect(label, t).toBeTruthy();
      expect(label, t).not.toMatch(/_/);
      expect(label, t).not.toBe(t);
    });
    // an unknown type still reads as words
    expect(L.taskTypeLabel('some_future_type')).toBe('Some future type');
  });

  it('every block code the role rule can produce has a readable reason', () => {
    Object.keys(matchLib.ROLE_REASON_TO_BLOCK).forEach((reason) => {
      const block = matchLib.ROLE_REASON_TO_BLOCK[reason];
      if (block === 'dpa_ineligible') return; // the board already knows this one
      expect(L.blockLabel(block), block).toBeTruthy();
      expect(L.blockLabel(block), block).not.toMatch(/_/);
    });
    Object.keys(roleEligibility.REASON).forEach((k) => expect(typeof roleEligibility.REASON[k]).toBe('string'));
    // a code it does not know is left to the caller
    expect(L.blockLabel('no_cv')).toBe('');
  });
});

describe('who owns a task', () => {
  const task = (owner, then) => ({ task_type: 'reference_check', metadata: { au: true, owner, owner_then: then || null, what_to_do: 'x' } });
  it('reads the owner from the task itself, as words', () => {
    expect(L.ownerLabel(task('consultant'))).toBe('Consultant');
    expect(L.ownerLabel(task('consultant', 'rso'))).toBe('Consultant, then RSO');
    expect(L.ownerLabel(task('rso'))).toBe('RSO');
    expect(L.ownerLabel(task('ceo'))).toBe('CEO');
    expect(L.ownerShort(task('consultant', 'rso'))).toBe('Consultant');
    // the metadata may arrive as text
    expect(L.ownerLabel({ task_type: 'x', metadata: JSON.stringify({ au: true, owner: 'ceo' }) })).toBe('CEO');
  });
  it('says nothing for a task that is not an Australian one', () => {
    expect(L.ownerLabel({ task_type: 'manual', metadata: { owner: 'rso' } })).toBe('');
    expect(L.ownerLabel({ task_type: 'manual' })).toBe('');
    expect(L.ownerLabel(null)).toBe('');
  });
});

describe('due dates are calendar dates: due ON the day, overdue from the day after (W3-D24)', () => {
  const at = (iso) => new Date(iso);
  it('a date-only value is compared day against day on the viewer\'s own calendar', () => {
    const noon = new Date(2026, 10, 22, 12, 0, 0); // 22 Nov 2026, viewer-local
    expect(L.dueInDays('2026-11-22', noon)).toBe(0);
    expect(L.dueInDays('2026-11-23', noon)).toBe(1);
    expect(L.dueInDays('2026-11-21', noon)).toBe(-1);
    expect(L.dueWords('2026-11-22', noon)).toBe('Due today');
    expect(L.dueWords('2026-11-21', noon)).toBe('Overdue by 1 day');
    expect(L.dueWords('2026-11-19', noon)).toBe('Overdue by 3 days');
    expect(L.dueWords('2026-11-23', noon)).toBe('Due tomorrow');
    expect(L.dueWords('2026-11-30', noon)).toBe('Due in 8 days');
  });
  it('is the same at the first and the last minute of the day (the old check called the morning of the due day overdue)', () => {
    expect(L.dueInDays('2026-11-22', new Date(2026, 10, 22, 0, 1, 0))).toBe(0);
    expect(L.dueInDays('2026-11-22', new Date(2026, 10, 22, 23, 59, 0))).toBe(0);
    // what the page did before: midnight UTC is already in the past by then
    expect(at('2026-11-22') < new Date(Date.UTC(2026, 10, 22, 1, 0, 0))).toBe(true);
  });
  it('a date stored as midnight UTC is still that calendar day', () => {
    const noon = new Date(2026, 10, 22, 12, 0, 0);
    expect(L.dueInDays('2026-11-22T00:00:00.000Z', noon)).toBe(0);
    expect(L.dueInDays('2026-11-22T00:00:00+00:00', noon)).toBe(0);
  });
  it('nothing sensible in, nothing out', () => {
    expect(L.dueInDays('', new Date())).toBe(null);
    expect(L.dueInDays('not a date', new Date())).toBe(null);
    expect(L.dueWords(null, new Date())).toBe('');
  });
  it('formats a date-only value as written, whatever zone the viewer is in', () => {
    expect(L.formatDate('2026-11-22')).toBe('22 Nov 2026');
    expect(L.formatDate('2027-02-01')).toBe('1 Feb 2027');
    expect(L.formatDate('')).toBe('');
  });
  it('never pins a display formatter to a fixed zone', () => {
    expect(read('js/au-staff-labels.js')).not.toMatch(/timeZone\s*:/);
  });
});

describe('week 4, 8 and 12 come in date order (W3-D24)', () => {
  it('open first, then by due date, then by title', () => {
    const list = [
      { id: 'w12', title: 'Guarantee check-in: week 12', due_date: '2027-02-14', open: true },
      { id: 'done', title: 'First-week check-in', due_date: '2026-11-29', open: false },
      { id: 'w8', title: 'Guarantee check-in: week 8', due_date: '2027-01-17', open: true },
      { id: 'none', title: 'No date', due_date: null, open: true },
      { id: 'w4', title: 'Guarantee check-in: week 4', due_date: '2026-12-20', open: true }
    ];
    expect(L.sortTasks(list).map((t) => t.id)).toEqual(['w4', 'w8', 'w12', 'none', 'done']);
    // the input is not reordered
    expect(list[0].id).toBe('w12');
  });
});

describe('the Australian journey rail', () => {
  it('is five steps, none of them an overseas stage', () => {
    const steps = L.railSteps('prestart');
    expect(steps.map((s) => s.label)).toEqual(['Secure placement', 'Pre-start', 'Commenced', 'Guarantee', 'Complete']);
    expect(steps.map((s) => s.status)).toEqual(['done', 'current', 'pending', 'pending', 'pending']);
    const html = L.railHtml('prestart', { practiceName: 'Test Metro Practice (FAKE)' });
    expect(html).not.toMatch(/MyIntealth|AMC|AHPRA|Visa|PBS/);
    expect(html).toContain('Secure placement — Test Metro Practice (FAKE)');
    expect(html).toContain('data-au-rail="1"');
  });
  it('a finished case shows every step done', () => {
    expect(L.railSteps('complete').map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
  });
  it('a practice name is written as text', () => {
    const html = L.railHtml('guarantee', { practiceName: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('which case is Australian', () => {
  it('only a case whose own row says so', () => {
    expect(L.caseIsAu({ pathway: 'au_vr', stage: 'placement' })).toBe(true);
    expect(L.caseIsAu({ pathway: null, stage: 'prestart' })).toBe(true);
    expect(L.caseIsAu({ pathway: 'overseas_esp', stage: 'ahpra' })).toBe(false);
    expect(L.caseIsAu({ pathway: null, stage: 'complete' })).toBe(false);
    expect(L.caseIsAu({ pathway: null, stage: 'myintealth' })).toBe(false);
    expect(L.caseIsAu(null)).toBe(false);
  });
});

describe('both dashboards load the one helper, and nothing else new', () => {
  it('one tag each, the same version, before the code that uses it', () => {
    const admin = read('pages/admin.html');
    const ceo = read('pages/ceo-dashboard.html');
    const tag = /<script src="\/js\/au-staff-labels\.js\?v=(\d{8}[a-z])"><\/script>/;
    expect(admin.match(tag)[1]).toBe(ceo.match(tag)[1]);
    expect(admin.split('<script src="/js/au-staff-labels.js').length - 1).toBe(1);
    expect(ceo.split('<script src="/js/au-staff-labels.js').length - 1).toBe(1);
    expect(ceo.indexOf('au-staff-labels.js')).toBeLessThan(ceo.indexOf('var STAGE_LABELS = {'));
    expect(ceo.indexOf('au-staff-labels.js')).toBeLessThan(ceo.indexOf('/js/ceo-ats-shared.js'));
  });
  it('the helper makes no request, keeps nothing, and touches no page', () => {
    const src = read('js/au-staff-labels.js');
    expect(src).not.toMatch(/fetch\(|XMLHttpRequest|localStorage|sessionStorage|document\.|addEventListener/);
    expect(src).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  });
});
