import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Owner, 2026-08-18, looking at Dr Mercy Obanimoh's SPPA-00 chase:
// "on nudges why is the practice manager not cc'd too?"
//
// Three separate reasons they were not:
//   1. The SPPA-00 nudge composer had no CC control at all — To was the supervisor's
//      personal address and there was nowhere to add anyone else.
//   2. The Ops Queue never called loadCcContacts, so the CC boxes it DID render
//      (the practice-pack composers) sat on "Loading contacts…" for ever.
//   3. Where a CC box existed and was populated, nothing was ticked — a chase still
//      went to one person unless the RSO remembered to select someone.
//
// Chases are pre-ticked; first-contact composers keep their opt-in CC. The counterpart
// rule still holds and is guarded by sppa-candidate-no-practice-cc.test.js: a composer
// addressed to the DOCTOR gets no CC field at all.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const admin = fs.readFileSync(path.join(ROOT, 'pages', 'admin.html'), 'utf8');
const ceo = fs.readFileSync(path.join(ROOT, 'pages', 'ceo-dashboard.html'), 'utf8');

// Whole-line // comments name the very things asserted below (they explain the fix),
// so strip them before matching — same idiom as sppa-candidate-no-practice-cc.test.js.
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const block = (src, re) => stripComments((src.match(re) || [''])[0]);

// SPPA-00, sppa_state='sent_to_practice': the composer behind "Nudge Practice".
const sppaNudge = block(admin, /var nudgeTo = meta\.sent_to_practice_email[\s\S]*?Nudge Practice<\/button>/);
// SPPA-00, sppa_state='corrections_requested': the composer behind "Resend Request".
const sppaCorrections = block(admin, /var resendTo = meta\.sent_to_practice_email[\s\S]*?Resend Request<\/button>/);
// practice_pack_child State C: the generic "Nudge Practice" composer.
const genericNudge = block(admin, /var nudgeTo=practiceEmail;[\s\S]*?data-ops-nudge-toggle/);
// The CEO port of that same generic nudge.
const ceoNudge = block(ceo, /ceoNudgeWrap_[\s\S]*?Nudge Practice<\/button>/);

describe('a practice chase can copy the practice manager', () => {
  it('every nudge composer was found', () => {
    expect(sppaNudge).toBeTruthy();
    expect(sppaCorrections).toBeTruthy();
    expect(genericNudge).toBeTruthy();
    expect(ceoNudge).toBeTruthy();
  });

  it('the SPPA-00 nudge has a CC control (it had none — this is the reported bug)', () => {
    expect(sppaNudge).toContain('opsCcRow(');
    expect(sppaNudge).toMatch(/opsCcRow\(task\.id,\s*true/);
  });

  it('the SPPA-00 corrections chase has one too', () => {
    expect(sppaCorrections).toMatch(/opsCcRow\(task\.id,\s*true/);
  });

  it('the generic practice nudge pre-ticks its contacts on both consoles', () => {
    expect(genericNudge).toMatch(/opsCcRow\(task\.id,\s*true/);
    expect(ceoNudge).toMatch(/ceoCcRow\(task\.id,\s*true/);
  });

  it('a chase never offers the doctor, whichever address she wrote from', () => {
    // /email-contacts only strips user_profiles.email. Mercy replied from a personal
    // gmail we had emailed her at, so it is affiliation-proven and would be offered —
    // and, now that chases pre-tick, sent to — on an email aimed at her practice.
    expect(sppaNudge).toMatch(/opsCcRow\(task\.id, true, \[candidateEmail, meta\.sent_to_candidate_email\]\)/);
    expect(sppaCorrections).toMatch(/opsCcRow\(task\.id, true, \[candidateEmail, meta\.sent_to_candidate_email\]\)/);
    expect(genericNudge).toMatch(/opsCcRow\(task\.id, true, \[task\.candidate_email, task\.gp_email\]\)/);
    expect(ceoNudge).toMatch(/ceoCcRow\(task\.id, true, \[task\.candidate_email, task\.gp_email\]\)/);
  });
});

describe('the CC row honours preselect and exclusions', () => {
  for (const [label, src, fn] of [['admin', admin, 'opsCcRow'], ['CEO', ceo, 'ceoCcRow']]) {
    it(`${label}: ${fn} emits the preselect + exclude attributes`, () => {
      const helper = (src.match(new RegExp(`function ${fn}\\(taskId, preselect, never\\)[\\s\\S]*?\\n {2,6}\\}`)) || [''])[0];
      expect(helper).toBeTruthy();
      expect(helper).toContain('data-email-cc-preselect');
      expect(helper).toContain('data-email-cc-exclude');
      expect(helper).toContain('data-email-cc-note');
    });

    it(`${label}: loadCcContacts ticks preselected options and drops excluded ones`, () => {
      const loader = (src.match(/function loadCcContacts\(caseId\)[\s\S]*?\n {4,6}\}\n/) || [''])[0];
      expect(loader).toBeTruthy();
      expect(loader).toContain("hasAttribute('data-email-cc-preselect')");
      expect(loader).toContain("getAttribute('data-email-cc-exclude')");
      expect(loader).toContain('if (preselect) opt.selected = true;');
      expect(loader).toContain('never.indexOf(addr) === -1');
      // The recipient in "To" was already excluded and must stay excluded.
      expect(loader).toContain('addr !== toVal');
      // And it must say out loud who it is copying.
      expect(loader).toContain('Copying ');
    });
  }
});

describe('the Ops Queue actually loads its CC contacts', () => {
  it('renderExpandedOpsRow calls loadCcContacts after rendering', () => {
    const fn = (admin.match(/async function renderExpandedOpsRow\(task\)\{[\s\S]*?\n  \}/) || [''])[0];
    expect(fn).toBeTruthy();
    expect(fn).toContain('container.innerHTML=html;');
    expect(fn).toContain('loadCcContacts(');
    // Order matters: the selects have to exist before they can be filled.
    expect(fn.indexOf('loadCcContacts(')).toBeGreaterThan(fn.indexOf('container.innerHTML=html;'));
  });
});
