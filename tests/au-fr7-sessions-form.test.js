// FR-7 (guide walk): "Submit to GP" (and "Send offer") asked for sessions a
// week in a bare browser box. Pressing OK with it empty SENT the contract with
// no sessions, and the fee could then not be worked out until commencement.
//
// The question is now a form in the page: the number is required; an empty or
// unusable answer is refused before anything is sent; "not known yet" is a box
// a person ticks on purpose; Cancel sends nothing.
//
// Only a candidate on an Australian pathway is ever asked (the server sends
// the two codes for them alone). On `main` there is no question at all, and
// an overseas contract goes exactly as it does there.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const require = createRequire(import.meta.url);
const fees = require('../lib/au-placement-fees.js');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const cand = read('js/ceo-ats-candidates.js');
const contracts = read('js/ceo-ats-contracts.js');

const grab = (src, name) => { const s0 = src.indexOf('function ' + name + '('); let depth = 0; let i = src.indexOf('{', s0); for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) break; } } return src.slice(s0, i + 1); };
// eslint-disable-next-line no-new-func
const ui = new Function('var AU_SESSIONS_MAX = 14;' + grab(cand, 'auSessionsAnswer') + grab(cand, 'auSessionsDialogHtml') + grab(cand, 'auSessionsAsked')
  + 'return { answer: auSessionsAnswer, html: auSessionsDialogHtml, asked: auSessionsAsked };')();

describe('the answer is checked before anything is sent', () => {
  it('empty is refused (the defect): nothing to send, and the person is told what to do', () => {
    for (const empty of ['', '   ', null, undefined]) {
      const a = ui.answer(empty, false);
      expect(a.body).toBeUndefined();
      expect(a.error).toMatch(/Enter how many sessions a week/);
      expect(a.error).toMatch(/Not known yet/);
    }
  });

  it('a number the server accepts is sent as typed; everything else is refused', () => {
    for (const ok of ['8', '7.5', '1', '0.5', '14', '10']) expect(ui.answer(ok, false)).toEqual({ body: { sessions_per_week_numeric: ok } });
    for (const bad of ['0', '15', '99', '-2', '8.25', 'eight', '6-8', 'full time', '8 sessions', '1e1', '.5', '100']) {
      const a = ui.answer(bad, false);
      expect(a.body, bad).toBeUndefined();
      expect(a.error, bad).toMatch(/must be a number above 0 and up to 14/);
    }
  });

  it('the form and the server agree on every value (one rule, two places)', () => {
    const samples = ['0', '0.5', '1', '7', '7.5', '8', '13.5', '14', '14.5', '15', '8.25', '08', '8.0', 'x', '', '-1', '3.', '.3', '1 ', ' 9'];
    for (const v of samples) {
      const client = ui.answer(v, false);
      const server = fees.cleanSessions(String(v).trim());
      expect(!!client.body, JSON.stringify(v)).toBe(server !== null);
    }
    expect(fees.MAX_SESSIONS).toBe(14);
  });

  it('"not known yet" is an explicit choice: ticked with nothing typed says unknown; a typed number wins over the tick', () => {
    expect(ui.answer('', true)).toEqual({ body: { sessions_unknown: true } });
    expect(ui.answer('8', true)).toEqual({ body: { sessions_per_week_numeric: '8' } });
    expect(ui.answer('abc', true).error).toBeTruthy();
  });
});

describe('the form', () => {
  it('is a real form: a required number field with the server\'s range, the explicit box, Send and Cancel', () => {
    const html = ui.html({ code: 'au_sessions_required' });
    expect(html).toContain('<input type="number" class="ats-au-input" id="ats-au-sessions-n" min="0.5" max="14" step="0.5" inputmode="decimal" required');
    expect(html).toContain('Sessions a week (required)');
    expect(html).toContain('id="ats-au-sessions-unknown"');
    expect(html).toContain('id="ats-au-sessions-send"');
    expect(html).toContain('id="ats-au-sessions-cancel"');
    expect(html).toContain('8 or more is full-time');
    expect(ui.html({ code: 'invalid_sessions' })).toContain('That was not a number we can use.');
    // staff screen: no fee figure
    expect(html).not.toMatch(/\$\s?\d/);
  });

  it('only the two Australian codes open it', () => {
    expect(ui.asked({ code: 'au_sessions_required' })).toBe(true);
    expect(ui.asked({ code: 'invalid_sessions' })).toBe(true);
    for (const other of [null, undefined, {}, { ok: true }, { code: 'email_not_sent' }, { ok: false, message: 'x' }]) expect(ui.asked(other)).toBe(false);
  });

  it('no browser box is left on either path, and neither path sends without an answer', () => {
    expect(cand).not.toMatch(/window\.prompt\([^)]*sessions/i);
    expect(contracts).not.toMatch(/window\.prompt\([^)]*sessions/i);
    expect(cand).not.toContain('auAskSessions');
    // "Send offer": sent again only inside the answer branch
    const offer = cand.slice(cand.indexOf('} else if (auSessionsAsked(res)) {'), cand.indexOf('} else if (auSessionsAsked(res)) {') + 900);
    expect(offer).toContain("if (!answer) { ATS.toast('Not sent: sessions a week is needed first.'); return; }");
    expect(offer.indexOf('if (!answer)')).toBeLessThan(offer.indexOf('post();'));
    // "Submit to GP"
    const decision = contracts.slice(contracts.indexOf('function submitDecision('), contracts.indexOf('function submitChangeDecision('));
    expect(decision).toContain("window.atsAuSessionsDialog(d).then(function (answer) {");
    expect(decision).toContain("if (!answer) { ATS.toast('Not sent: sessions a week is needed first.'); return; }");
    expect(decision).toContain("if (typeof window.atsAuSessionsDialog !== 'function') {");
    expect(decision).not.toContain('sessions_unknown: true }');   // never decided for the person
    expect(cand).toContain('window.atsAuSessionsDialog = auSessionsDialog;');
    // found in the real browser: outside the dashboard's own container the card had no background (its colours are defined on .ats-scope)
    expect(cand).toContain("wrap.className = 'ats-scope';");
  });
});

describe('an overseas contract is exactly as on main', () => {
  it('main asks nothing here; this build\'s only change to "Submit to GP" is the branch for the two Australian codes', () => {
    let mainSrc = '';
    try { mainSrc = execSync('git show origin/main:js/ceo-ats-contracts.js', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { mainSrc = ''; }
    if (!mainSrc) return;   // no origin/main in this checkout: nothing to compare against
    expect(mainSrc).not.toMatch(/prompt\(/);
    expect(mainSrc).not.toMatch(/sessions/i);
    // with the Australian branch cut out, the function is main's, apart from the extra argument
    const ours = contracts.slice(contracts.indexOf('function submitDecision('), contracts.indexOf('function submitChangeDecision('));
    const a = ours.indexOf("      if (d && !d.ok && (d.code === 'au_sessions_required'");
    const b = ours.indexOf("      if (!d || !d.ok) { ATS.toast((d && d.message) || 'Could not update the contract.'); return; }");
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    const withoutAu = ours.slice(0, a) + ours.slice(b);
    const mainFn = mainSrc.slice(mainSrc.indexOf('function submitDecision('), mainSrc.indexOf('function submitChangeDecision('));
    for (const line of ["ATS.api('/api/ceo/contract/decision', { method: 'POST', body:", "ATS.toast(action === 'submit_to_gp' ? 'Sent to the GP.' : 'Returned to the practice.');", 'state.expanded = null;', 'fetchAndRender();']) {
      expect(mainFn, line).toContain(line);
      expect(withoutAu, line).toContain(line);
    }
  });
});
