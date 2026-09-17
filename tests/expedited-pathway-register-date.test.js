// Cross-checking the GP Register date against the expedited-pathway cutoff, so
// a UK GP who cannot have completed the nMRCGP curriculum is spotted when they
// type their GMC number rather than weeks later when the certificate lands.
// Owner 2026-09-17: "when a gp enters their gmc number can we cross check the
// date they were on the gp register and ensure they would have completed the
// nMRCGP curriculum".
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

const requireCjs = createRequire(import.meta.url);
const reg = requireCjs('../lib/register-lookup.js');
const { PEP_DATE_CUTOFFS } = requireCjs('../lib/document-pipeline.js');

describe('parseRegisterDate', () => {
  it('reads the NHS performers spelling and ISO, and refuses anything else', () => {
    expect(reg.parseRegisterDate('05 February 2026')).toBe('2026-02-05');
    expect(reg.parseRegisterDate('7 June 2019')).toBe('2019-06-07');
    expect(reg.parseRegisterDate('2019-06-07')).toBe('2019-06-07');
    expect(reg.parseRegisterDate('2019-06-07T00:00:00Z')).toBe('2019-06-07');
    expect(reg.parseRegisterDate('05 Febuary 2026')).toBe(''); // misspelt month, not a guess
    expect(reg.parseRegisterDate('Feb 2026')).toBe('');
    expect(reg.parseRegisterDate('')).toBe('');
    expect(reg.parseRegisterDate(null)).toBe('');
  });
});

describe('assessExpeditedPathway', () => {
  it('reuses the one cutoff table the certificate check already uses', () => {
    expect(PEP_DATE_CUTOFFS.GB).toBe('2007-08-01');
    expect(reg.assessExpeditedPathway({ country: 'GB', gpRegisterDate: '05 February 2026' }).cutoff)
      .toBe(PEP_DATE_CUTOFFS.GB);
  });

  it('a GP Register date before August 2007 is conclusive: PEP, not expedited', () => {
    const v = reg.assessExpeditedPathway({ country: 'GB', gpRegisterDate: '14 March 2004' });
    expect(v.verdict).toBe('before_cutoff');
    expect(v.reason).toContain('PEP');
  });

  it('the day the nMRCGP cutoff starts counts as on-time, the day before does not', () => {
    expect(reg.assessExpeditedPathway({ country: 'GB', gpRegisterDate: '01 August 2007' }).verdict).toBe('consistent');
    expect(reg.assessExpeditedPathway({ country: 'GB', gpRegisterDate: '31 July 2007' }).verdict).toBe('before_cutoff');
  });

  it('accepts the real doctor whose two dates we verified against the GMC page', () => {
    // GMC 7705439: GMC register "From 05 Feb 2026", "Full registration date 07 Jun 2019".
    const v = reg.assessExpeditedPathway({
      country: 'GB', gpRegisterDate: '05 February 2026', fullRegistrationDate: '07 June 2019'
    });
    expect(v.verdict).toBe('consistent');
    expect(v.reason).toContain('6.7 years after full registration');
  });

  it('flags a timeline too short to hold a three-year training programme (Portfolio route)', () => {
    const v = reg.assessExpeditedPathway({
      country: 'GB', gpRegisterDate: '10 March 2026', fullRegistrationDate: '01 June 2024'
    });
    expect(v.verdict).toBe('short_gap');
    expect(v.reason).toContain('Portfolio');
    expect(reg.MIN_UK_GP_TRAINING_YEARS).toBe(3);
  });

  it('treats the "01 January 1900" placeholder as no date, never as pre-cutoff', () => {
    // 58 GP Performer rows carried this placeholder on 2026-09-17. Read
    // literally it would lock each of those doctors out over a missing field.
    const v = reg.assessExpeditedPathway({ country: 'GB', gpRegisterDate: '01 January 1900' });
    expect(v.verdict).toBe('unknown');
    expect(v.reason).toContain('placeholder');
    expect(reg.REGISTER_DATE_FLOOR).toBe('1960-01-01');
    // A genuine old date is still a real answer.
    expect(reg.assessExpeditedPathway({ country: 'GB', gpRegisterDate: '03 July 1968' }).verdict).toBe('before_cutoff');
  });

  it('never guesses: no date, unreadable date or an ungated country stays unknown', () => {
    expect(reg.assessExpeditedPathway({ country: 'GB', gpRegisterDate: '' }).verdict).toBe('unknown');
    expect(reg.assessExpeditedPathway({ country: 'GB', gpRegisterDate: 'Feb 2026' }).verdict).toBe('unknown');
    expect(reg.assessExpeditedPathway({ country: 'FR', gpRegisterDate: '05 February 2026' }).verdict).toBe('unknown');
  });

  it('says plainly that the register cannot tell CCT from Portfolio', () => {
    const v = reg.assessExpeditedPathway({ country: 'GB', gpRegisterDate: '05 February 2026' });
    expect(v.reason).toContain('certificate is still the proof');
  });
});

describe('performersVerdict carries the pathway screen', () => {
  const row = (over = {}) => Object.assign({
    alignment: 'Medical', role: 'GP Performer', foreNames: 'Mohammed Avais', surname: 'Hussain',
    number: '7705439', registeredDate: '07 June 2019', status: 'Included',
    firstOnListDate: '25 July 2025', gpRegisterDate: '05 February 2026', region: 'MIDLANDS', probationary: ''
  }, over);
  const doctor = { number: '7705439', firstName: 'Mohammed', lastName: 'Hussain' };

  it('verifies AND reports the pathway in the evidence staff already read', () => {
    const v = reg.performersVerdict([row()], doctor);
    expect(v.outcome).toBe('verified');
    expect(v.pathway.verdict).toBe('consistent');
    expect(v.evidence).toContain('Expedited pathway:');
  });

  it('a pre-2007 GP still verifies on the register but is called out for PEP', () => {
    const v = reg.performersVerdict([row({ gpRegisterDate: '02 April 2003', registeredDate: '01 August 1998' })], doctor);
    expect(v.outcome).toBe('verified'); // the register check is unchanged
    expect(v.pathway.verdict).toBe('before_cutoff');
    expect(v.evidence).toContain('PEP');
  });

  it('adds nothing when the row has no GP Register date', () => {
    const v = reg.performersVerdict([row({ gpRegisterDate: '' })], doctor);
    expect(v.outcome).toBe('verified');
    expect(v.pathway.verdict).toBe('unknown');
  });
});

// A pre-cutoff GP must not merely be noted — they belong behind the PEP page,
// the same place the certificate scan sends them weeks later.
// Owner 2026-09-17: "so if they were on the gp register before august 2007 then
// they will be taken to the pep pathway waitlist page?"
describe('a before_cutoff register date applies the PEP gate', () => {
  const server = read('server.js');
  // The whole function, not a fixed-size window: the gate sits near its end.
  const fnStart = server.indexOf('async function attemptAutomaticRegisterVerification');
  const fn = server.slice(fnStart, server.indexOf('\nasync function ', fnStart + 10));

  it('reuses the certificate path gate rather than a second mechanism', () => {
    expect(fn).toContain('await applyPepWaitlistGate(');
    // One gate, called from both the certificate scan and the register check.
    expect(server.split('async function applyPepWaitlistGate').length - 1).toBe(1);
    expect(server.split('await applyPepWaitlistGate(').length - 1).toBe(2);
  });

  it('gates ONLY on before_cutoff — a short gap is a suspicion, never a lockout', () => {
    expect(fn).toContain("pathwayScreen.verdict === 'before_cutoff'");
    const gateBlock = fn.slice(fn.indexOf('const pathwayScreen'), fn.indexOf('return {\n    outcome: \'verified\''));
    expect(gateBlock).not.toContain("'short_gap'");
  });

  it('records the register date as the evidence behind the gate', () => {
    expect(fn).toContain("certType: 'GP Register entry (NHS England performers list)'");
    expect(fn).toContain('dateFound: pathwayScreen.gpRegisterDate');
    expect(fn).toContain('cutoffDate: pathwayScreen.cutoff');
  });

  it('reads the email and phone the waitlist row needs', () => {
    expect(fn).toContain('select=user_id,first_name,last_name,email,phone,register_body');
  });

  it('is best-effort: a failed gate never loses a good register verification', () => {
    expect(fn).toContain("console.error('[PEP] register-date gate failed (verification kept):'");
    const gateIdx = fn.indexOf('applyPepWaitlistGate');
    expect(fn.lastIndexOf('try {', gateIdx)).toBeGreaterThan(-1);
  });

  it('tells callers the doctor is now gated', () => {
    expect(fn).toContain("pepGated: !!(pathwayScreen && pathwayScreen.verdict === 'before_cutoff')");
  });

  it('the gate the auth guard enforces still points at the PEP page', () => {
    const guard = read('js/auth-guard.js');
    expect(guard).toContain('window.location.replace("/pages/pep-pathway")');
    expect(guard).toContain('status === "pep_waitlist"');
  });
});
