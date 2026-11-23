// Australian GP build, WP-23 (G): the CEO Practices view and the job editor
// show which GPs a practice will consider and its DPA status (yes / no /
// "ask"), and only when the server sends `au_gp` / `au_intake` (switch on).
// No jsdom: the render functions are extracted and run against a stand-in.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const gp = require('../lib/practice-gp-types.js');
const ROOT = path.resolve(__dirname, '..');
const practicesJs = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-practices.js'), 'utf8');
const jobsJs = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-jobs.js'), 'utf8');
const ceoHtml = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const block = practicesJs.slice(practicesJs.indexOf('  var AU_SHORT_TYPE = {'), practicesJs.indexOf('  function practiceCardHtml(p) {'));
const ui = new Function('ATS', block + '\n return { chips: auGpChipsHtml, card: auGpCardHtml };')({ esc, escAttr: esc });
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const VR_ONLY = { vr: true, non_vr: false, registrar: false, supervised: false, overseas: false };
const practice = (au, over) => Object.assign({ dpa_suggested: false, metadata: { intake: { dpa: false, au_gp: Object.assign({ gp_types: VR_ONLY, dpa_answer: 'no', engagement_type: 'permanent', sessions_min: 6, sessions_max: 10, special_interests: ['Mental health'] }, au || {}) } } }, over || {});

describe('CEO Practices view', () => {
  it('draws nothing without au_gp (switch off, or an older server)', () => {
    expect(ui.chips({ id: 'p1', name: 'Test Practice (FAKE)' })).toBe('');
    expect(ui.card({ id: 'p1' })).toBe('');
    expect(ui.chips(null)).toBe('');
  });

  it('a non-DPA practice that accepts only VR GPs: the card chip and the record say so', () => {
    const p = { id: 'p1', au_gp: gp.staffSummary(practice()) };
    expect(text(ui.chips(p))).toBe('Not in a DPA Open to: VR GPs');
    const card = text(ui.card(p));
    expect(card).toContain('GPs this practice will consider');
    expect(card).toContain('DPA status Not in a DPA Practice answered: No · Official look-up: Not in a DPA');
    expect(card).toContain('Will consider Vocationally registered Australian GPs');
    expect(card).toContain('Will not consider Non-VR GPs');
    expect(card).toContain('Engagement Permanent');
    expect(card).toContain('Sessions 6 to 10 sessions a week');
    expect(card).toContain('Special interests Mental health');
    expect(ui.card(p)).not.toContain('au-gp-flag');
  });

  it('unknown DPA reads "ask the practice", never "not DPA"; a disagreement is flagged', () => {
    const lead = { id: 'p2', au_gp: gp.staffSummary({ metadata: {} }) };
    expect(text(ui.chips(lead))).toBe('DPA: ask the practice');
    expect(ui.chips(lead)).toContain('ats-pill amber');
    expect(text(ui.card(lead))).toContain('Not asked yet');
    const clash = { id: 'p3', au_gp: gp.staffSummary(practice({ dpa_answer: 'yes', gp_types: Object.assign({}, VR_ONLY, { overseas: true }) }, { dpa_suggested: false, metadata: undefined })) };
    clash.au_gp = gp.staffSummary({ dpa_suggested: false, metadata: { intake: { dpa: true, au_gp: { gp_types: Object.assign({}, VR_ONLY, { overseas: true }), dpa_answer: 'yes', engagement_type: '', sessions_min: null, sessions_max: null, special_interests: [] } } } });
    expect(text(ui.chips(clash))).toContain('DPA: ask the practice');
    expect(text(ui.chips(clash))).toContain('Check before approving');
    expect(ui.card(clash)).toContain('au-gp-flag');
    expect(text(ui.card(clash))).toContain('Practice answered: Yes · Official look-up: Not in a DPA');
  });

  it('practice-supplied words are escaped', () => {
    const p = { id: 'p4', au_gp: gp.staffSummary(practice()) };
    p.au_gp.specialInterests = ['<img src=x onerror=1>'];
    expect(ui.card(p)).not.toContain('<img src=x');
  });

  it('is wired into both card kinds and the practice record, and the script was re-versioned', () => {
    expect(practicesJs.match(/auGpChipsHtml\(p\) \+/g).length).toBe(2);
    expect(practicesJs).toContain("contractCardHtml(p) + auGpCardHtml(p) + '</div>'");
    expect(ceoHtml).toContain('/js/ceo-ats-practices.js?v=20261123a');
    expect(ceoHtml).toContain('/js/ceo-ats-jobs.js?v=20261123a');
    expect(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8')).toContain('var VERSION = "20261123e"');
  });
});

describe('job editor: what the practice told us, above the fields staff can change', () => {
  const fnSrc = jobsJs.slice(jobsJs.indexOf('  function auIntakeAnswersHtml(a) {'), jobsJs.indexOf('  function auRoleFieldsSection(f, intakeAnswers) {'));
  const html = new Function('A', fnSrc + '\n return auIntakeAnswersHtml;')({ esc, escAttr: esc });

  it('nothing for a job that did not come from an intake that asked', () => {
    expect(html(undefined)).toBe('');
    expect(html(null)).toBe('');
  });
  it('accepted types, DPA in three states, and the notes', () => {
    const out = text(html({
      accepted: ['Vocationally registered Australian GPs'], declined: ['Non-VR GPs'],
      dpa: { label: 'DPA: ask the practice', practiceAnswer: 'yes', lookup: 'no' },
      notes: ['The practice says it is in a Distribution Priority Area; the official look-up says it is not in one.']
    }));
    expect(out).toContain('What the practice told us on its form');
    expect(out).toContain('Will consider: Vocationally registered Australian GPs');
    expect(out).toContain('DPA: DPA: ask the practice (practice answered yes; official look-up says no)');
    expect(out).toContain('the official look-up says it is not in one');
  });
  it('the section passes the answers through', () => {
    expect(jobsJs).toContain('auRoleFieldsSection(e.au_role_fields, e.au_intake)');
    expect(jobsJs).toContain('auIntakeAnswersHtml(intakeAnswers) +');
  });
});
