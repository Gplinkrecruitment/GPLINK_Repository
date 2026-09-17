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
describe('a before_cutoff register date applies the PEP gate — at the END of onboarding', () => {
  const server = read('server.js');
  const slice = (name) => {
    const i = server.indexOf('async function ' + name);
    return server.slice(i, server.indexOf('\nasync function ', i + 10));
  };
  const gateFn = slice('applyRegisterPathwayPepGate');
  const verifyFn = slice('attemptAutomaticRegisterVerification');

  it('reuses the certificate path gate rather than a second mechanism', () => {
    expect(gateFn).toContain('await applyPepWaitlistGate(');
    expect(server.split('async function applyPepWaitlistGate').length - 1).toBe(1);
    // Two callers: the certificate scan, and the register-date helper.
    expect(server.split('await applyPepWaitlistGate(').length - 1).toBe(2);
  });

  it('gates ONLY on before_cutoff — a short gap is a suspicion, never a lockout', () => {
    expect(gateFn).toContain("if (!pathway || pathway.verdict !== 'before_cutoff') return false;");
    expect(gateFn).not.toContain("'short_gap'");
  });

  it('records the register date as the evidence behind the gate', () => {
    expect(gateFn).toContain("certType: 'GP Register entry (NHS England performers list)'");
    expect(gateFn).toContain('dateFound: pathway.gpRegisterDate');
    expect(gateFn).toContain('cutoffDate: pathway.cutoff');
  });

  it('is best-effort: a failed gate never loses a good register verification', () => {
    expect(gateFn).toContain("console.error('[PEP] register-date gate failed:'");
  });

  // The owner's 2026-09-18 decision: finish onboarding first, THEN gate.
  it('the verification path refuses to gate until onboarding is finished', () => {
    expect(verifyFn).toContain("pathwayScreen.verdict === 'before_cutoff' && await isOnboardingComplete(userId)");
    expect(slice('isOnboardingComplete')).toContain("state.gp_onboarding_complete === true");
  });

  it('the onboarding-complete handler screens and gates on its way out', () => {
    const handler = server.slice(server.indexOf("let obPepGated = false;"), server.indexOf("message: 'Onboarding complete.'") + 200);
    expect(handler).toContain('await screenExpeditedPathwayForUser(userId)');
    expect(handler).toContain("obScreen.pathway.verdict === 'before_cutoff'");
    expect(handler).toContain('pepGated: obPepGated');
  });

  it('the screen never runs the slow live NHS download at the finish line', () => {
    const scr = slice('screenExpeditedPathwayForUser');
    expect(scr).toContain('await lookupPerformersMirror(');
    expect(scr).not.toContain('scanPerformersCsvForNumbers');
    expect(scr).toContain('if (!mirror.ok || !mirror.fresh) return null;');
  });

  it('the gate the auth guard enforces still points at the PEP page', () => {
    const guard = read('js/auth-guard.js');
    expect(guard).toContain('window.location.replace("/pages/pep-pathway")');
    expect(guard).toContain('status === "pep_waitlist"');
  });
});

describe('Book a consultation', () => {
  const server = read('server.js');
  it('the PEP CTA marks the profile before handing back the booking link', () => {
    const epStart = server.indexOf("pathname === '/api/pep/consult'");
    const ep = server.slice(epStart, server.indexOf("Careers profile gate (Task 3)", epStart));
    expect(ep).toContain('buildCalendlyBookingUrl(generateCorrelationToken()');
    expect(ep).toContain("pcState.gp_pep_pathway = JSON.stringify({ initiated_at: pcNowIso, via: 'consultation' })");
    expect(ep).toContain("supabaseDbRequest('pep_waitlist'");
    expect(ep).toContain('consult_requested_at: pcNowIso');
  });

  it('every GP can book: one handler serves the career-lock and the open route', () => {
    expect(server).toContain("if ((pathname === '/api/career/lock/booking-url' || pathname === '/api/consult/booking-url') && req.method === 'GET') {");
  });

  it('the CTA is on the PEP page, the onboarding success screen and the career page', () => {
    expect(read('pages/pep-pathway.html')).toContain('id="pepConsultBtn"');
    expect(read('pages/pep-pathway.html')).toContain('/api/pep/consult');
    expect(read('pages/onboarding.html')).toContain('id="successConsultBtn"');
    expect(read('js/onboarding.js')).toContain('/api/consult/booking-url');
    expect(read('pages/career.html')).toContain('id="careerConsultBtn"');
    expect(read('pages/career.html')).toContain('/api/consult/booking-url');
  });

  it('is optional everywhere — it never blocks the doctor carrying on', () => {
    // The success screen keeps its own primary button; the career button sits
    // beside the board rather than in front of it.
    expect(read('pages/onboarding.html')).toContain('id="successContinueBtn"');
    expect(read('pages/career.html')).not.toContain('careerConsultBtn" disabled');
  });

  it('a placed GP keeps the career button even though the step strip goes', () => {
    const css = read('pages/career.html');
    expect(css).toContain('body.career-mode-secured .at-steps { display: none !important; }');
    expect(css).not.toContain('body.career-mode-secured .at-consult');
  });

  it('the waitlist stamp ships as a migration and the endpoint survives without it', () => {
    expect(read('supabase/migrations/20260918000000_pep_waitlist_consult_requested.sql'))
      .toContain('ADD COLUMN IF NOT EXISTS consult_requested_at');
    const epStart = server.indexOf("pathname === '/api/pep/consult'");
    const ep = server.slice(epStart, server.indexOf("Careers profile gate (Task 3)", epStart));
    expect(ep).toContain('column not applied yet');
  });
});
