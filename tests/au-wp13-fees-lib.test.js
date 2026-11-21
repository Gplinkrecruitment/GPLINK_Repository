// WP-13 (Australian GP build): the agreement's commercial terms as code.
//
//   - the fee: every tier in both agreement variants, and every way it can be
//     "not known" (no amount is ever returned then);
//   - every figure in lib/au-placement-fees.js is checked against the two
//     agreement HTML sources, so a change to the agreement that is not carried
//     into the code fails here;
//   - which variant a practice signed;
//   - the guarantee period, the check-in dates, the part-time reminders;
//   - the credit schedule: each band, forfeiture, and each "a person decides".
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const fees = require('../lib/au-placement-fees.js');
const agreementVariants = require('../lib/agreement-variants.js');
const candidatePathway = require('../lib/candidate-pathway.js');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&mdash;/g, '-').replace(/&ndash;/g, '-').replace(/&rsquo;/g, "'").replace(/\s+/g, ' ');
const STANDARD = text(read('assets/legal/src/agreement-2026.html'));
const DISCOUNTED_HTML = read('assets/legal/src/agreement-2026-discounted.html');
const dollars = (n) => '$' + n.toLocaleString('en-AU');

describe('the fee table is the agreement\'s own', () => {
  it('standard: the Australian-GP rows of the fee summary carry the figures in the code', () => {
    expect(STANDARD).toContain('Full-time - Australian GP ' + dollars(fees.AU_BASED_FEES_EX_GST.standard.full_time) + ' On commencement');
    expect(STANDARD).toContain('Part-time - Australian GP ' + dollars(fees.AU_BASED_FEES_EX_GST.standard.part_time) + ' On commencement');
    expect(fees.AU_BASED_FEES_EX_GST.standard).toEqual({ full_time: 21000, part_time: 18000 });
  });

  it('discounted: the "now" figure in each Australian-GP row is the one in the code', () => {
    const row = (label) => {
      const at = DISCOUNTED_HTML.indexOf(label);
      expect(at, label).toBeGreaterThan(-1);
      const cell = DISCOUNTED_HTML.slice(at, at + 400);
      return /<span class="now">\$([\d,]+)<\/span>/.exec(cell)[1].replace(/,/g, '');
    };
    expect(Number(row('Full-time &mdash; Australian GP'))).toBe(fees.AU_BASED_FEES_EX_GST['discounted-2026'].full_time);
    expect(Number(row('Part-time &mdash; Australian GP'))).toBe(fees.AU_BASED_FEES_EX_GST['discounted-2026'].part_time);
    expect(fees.AU_BASED_FEES_EX_GST['discounted-2026']).toEqual({ full_time: 19000, part_time: 17000 });
  });

  it('there is a fee row for every agreement variant a practice can sign, and none for a draft', () => {
    expect(Object.keys(fees.AU_BASED_FEES_EX_GST).sort()).toEqual(Object.keys(agreementVariants.VARIANTS).sort());
    agreementVariants.listDraftAgreementVariants().forEach((d) => { expect(fees.AU_BASED_FEES_EX_GST[d.key]).toBeUndefined(); });
  });

  it('full-time, the timing, the terms, the guarantee and the credit schedule are the agreement\'s words', () => {
    expect(STANDARD).toContain('A full-time placement is an engagement averaging eight (8) or more sessions');
    expect(STANDARD).toContain('A part-time placement is an engagement averaging fewer than eight (8) sessions');
    expect(fees.FULL_TIME_MIN_SESSIONS).toBe(8);
    expect(STANDARD).toContain('For Australian-based GPs, the full fee is invoiced when the placed doctor commences work.');
    expect(fees.INVOICE_TIMING).toBe('on_commencement');
    expect(STANDARD).toContain('within seven (7) days of the date of invoice');
    expect(fees.INVOICE_PAYMENT_DAYS).toBe(7);
    expect(STANDARD).toContain('Guarantee period means the period of twelve (12) weeks from the date the candidate commences the placement');
    expect(fees.GUARANTEE_WEEKS).toBe(12);
    expect(STANDARD).toContain('Up to 4 weeks - 80% of the placement fee is credited');
    expect(STANDARD).toContain('Between 4-8 weeks - 50% of the placement fee is credited');
    expect(STANDARD).toContain('Between 8-12 weeks - 35% of the placement fee is credited');
    expect(fees.CREDIT_BANDS.map((b) => b.pct)).toEqual([80, 50, 35]);
    expect(STANDARD).toContain("All calculations are made on the candidate's last working day with you, not on the day they give notice");
    expect(STANDARD).toContain('the guarantee is forfeited where any invoice is or has been overdue');
    expect(STANDARD).toContain('within twelve (12) months of commencement, the difference between the part-time fee paid and the applicable full-time fee becomes payable');
    expect(fees.UPLIFT_WINDOW_MONTHS).toBe(12);
    // The discounted variant changes prices only: the same definitions and schedule.
    const disc = text(DISCOUNTED_HTML);
    expect(disc).toContain('A full-time placement is an engagement averaging eight (8) or more sessions');
    expect(disc).toContain('Up to 4 weeks - 80% of the placement fee is credited');
    expect(disc).toContain('Guarantee period means the period of twelve (12) weeks');
  });
});

describe('placementFeeFor: every tier in both variants', () => {
  const cases = [
    ['standard', 8, 'full_time', 21000], ['standard', 10, 'full_time', 21000], ['standard', 14, 'full_time', 21000],
    ['standard', 7.5, 'part_time', 18000], ['standard', 4, 'part_time', 18000], ['standard', 0.5, 'part_time', 18000],
    ['discounted-2026', 8, 'full_time', 19000], ['discounted-2026', 9.5, 'full_time', 19000],
    ['discounted-2026', 7.5, 'part_time', 17000], ['discounted-2026', 1, 'part_time', 17000]
  ];
  it.each(cases)('%s, %s sessions a week -> %s, $%s ex GST', (variant, sessions, tier, amount) => {
    const fee = fees.placementFeeFor({ basis: 'australia', sessionsPerWeek: sessions, variant });
    expect(fee).toEqual({
      tier, amountExGst: amount, variant, basis: 'australia', source: 'agreement', known: true, reason: '',
      invoiceTiming: 'on_commencement', sessionsPerWeek: sessions
    });
  });

  it('the boundary is the agreement\'s: exactly 8 is full-time, anything under is part-time', () => {
    expect(fees.feeTierForSessions(8)).toBe('full_time');
    expect(fees.feeTierForSessions(7.9)).toBe('part_time');
    expect(fees.feeTierForSessions('8')).toBe('full_time');
  });

  it('sessions unknown: no tier, no amount, in either variant', () => {
    for (const variant of ['standard', 'discounted-2026']) {
      for (const sessions of [null, undefined, '', '6-8', 'full time', 'eight', 0, -2, 15, NaN, '8 sessions']) {
        const fee = fees.placementFeeFor({ basis: 'australia', sessionsPerWeek: sessions, variant });
        expect(fee.known, String(sessions)).toBe(false);
        expect(fee.amountExGst, String(sessions)).toBeNull();
        expect(fee.tier, String(sessions)).toBeNull();
        expect(fee.reason).toBe('sessions_unknown');
      }
    }
  });

  it('variant unknown: the tier is still told, but never an amount', () => {
    for (const variant of [null, undefined, '', 'gold', 'au-2026-draft', 'STANDARD']) {
      const fee = fees.placementFeeFor({ basis: 'australia', sessionsPerWeek: 8, variant });
      expect(fee.known, String(variant)).toBe(false);
      expect(fee.amountExGst, String(variant)).toBeNull();
      expect(fee.variant, String(variant)).toBeNull();
      expect(fee.tier).toBe('full_time');
      expect(fee.reason).toBe('agreement_variant_unknown');
    }
    const flagged = fees.placementFeeFor({ basis: 'australia', sessionsPerWeek: 6, variant: 'standard', variantKnown: false, variantReason: 'agreement_not_signed' });
    expect(flagged).toMatchObject({ known: false, amountExGst: null, variant: null, tier: 'part_time', reason: 'agreement_not_signed' });
  });

  it('both unknown: sessions is the reason given first, and there is no amount', () => {
    const fee = fees.placementFeeFor({ basis: 'australia', sessionsPerWeek: null, variant: null });
    expect(fee).toMatchObject({ known: false, amountExGst: null, tier: null, reason: 'sessions_unknown' });
  });

  it('an overseas-based doctor: nothing is computed here at all', () => {
    for (const basis of ['overseas', null, undefined, 'uk', '']) {
      const fee = fees.placementFeeFor({ basis, sessionsPerWeek: 8, variant: 'standard' });
      expect(fee).toMatchObject({ known: false, amountExGst: null, tier: null, basis: 'overseas', invoiceTiming: null, reason: 'not_australian_basis' });
    }
  });

  it('the basis is the one the pathway resolver gives (feeBasisFor)', () => {
    expect(candidatePathway.feeBasisFor({ flagEnabled: true, basis: 'australia' })).toBe('australia');
    expect(candidatePathway.feeBasisFor({ flagEnabled: true, basis: 'overseas' })).toBe('overseas');
    expect(candidatePathway.feeBasisFor({ flagEnabled: false, basis: 'australia' })).toBe('overseas');
    expect(candidatePathway.feeBasisFor(null)).toBe('overseas');
  });

  it('never throws on rubbish', () => {
    for (const input of [null, undefined, 'x', 7, [], {}]) {
      expect(fees.placementFeeFor(input)).toMatchObject({ known: false, amountExGst: null });
    }
  });
});

describe('signedAgreementVariantFor: which agreement a practice signed', () => {
  const signed = (extra) => Object.assign({ agreement_status: 'signed', agreement_signed_at: '2026-09-01T03:00:00Z', metadata: {} }, extra || {});

  it('e-signed after the 2026 agreement went live, no variant recorded: standard', () => {
    expect(fees.signedAgreementVariantFor(signed())).toMatchObject({ known: true, variant: 'standard' });
  });
  it('e-signed with the discounted variant recorded', () => {
    expect(fees.signedAgreementVariantFor(signed({ metadata: { agreement_variant: 'discounted-2026' } }))).toMatchObject({ known: true, variant: 'discounted-2026' });
  });
  it('signed through the metadata stash (a database without the agreement columns)', () => {
    const p = { agreement_status: '', metadata: { pipeline_agreement: { agreement_status: 'signed', agreement_signed_at: '2026-10-02T00:00:00Z' } } };
    expect(fees.signedAgreementVariantFor(p)).toMatchObject({ known: true, variant: 'standard' });
  });
  it('not known: no practice, not signed, a paper agreement with no e-signature, an earlier agreement, an unrecognised or draft key', () => {
    expect(fees.signedAgreementVariantFor(null)).toMatchObject({ known: false, variant: null, reason: 'practice_not_on_file' });
    expect(fees.signedAgreementVariantFor({ agreement_status: 'unsigned', metadata: {} })).toMatchObject({ known: false, reason: 'agreement_not_signed' });
    expect(fees.signedAgreementVariantFor({ agreement_status: 'signed', agreement_manual_pdf_key: 'k', metadata: {} })).toMatchObject({ known: false, reason: 'no_esignature_on_file' });
    expect(fees.signedAgreementVariantFor(signed({ agreement_signed_at: '2026-07-15T23:00:00Z' }))).toMatchObject({ known: false, reason: 'signed_before_2026_agreement' });
    expect(fees.signedAgreementVariantFor(signed({ agreement_signed_at: '2025-11-01T00:00:00Z' }))).toMatchObject({ known: false, reason: 'signed_before_2026_agreement' });
    expect(fees.signedAgreementVariantFor(signed({ metadata: { agreement_variant: 'platinum' } }))).toMatchObject({ known: false, reason: 'agreement_variant_unrecognised' });
    expect(fees.signedAgreementVariantFor(signed({ metadata: { agreement_variant: 'au-2026-draft' } }))).toMatchObject({ known: false, reason: 'agreement_variant_unrecognised' });
  });
  it('the first day of the 2026 agreement counts', () => {
    expect(fees.signedAgreementVariantFor(signed({ agreement_signed_at: '2026-07-16T00:30:00Z' }))).toMatchObject({ known: true });
  });
});

describe('dates: the guarantee period, the check-ins, the part-time reminders', () => {
  it('the guarantee period ends twelve weeks (84 days) after commencement', () => {
    expect(fees.guaranteeEndsOn('2027-02-01')).toBe('2027-04-26');
    expect(fees.daysBetween('2027-02-01', fees.guaranteeEndsOn('2027-02-01'))).toBe(84);
    expect(fees.guaranteeEndsOn('2026-12-10')).toBe('2027-03-04');
    expect(fees.guaranteeEndsOn('nope')).toBe('');
  });
  it('check-ins fall at weeks 4, 8 and 12', () => {
    expect(fees.guaranteeCheckinDays('2027-02-01')).toEqual([
      { week: 4, date: '2027-03-01' }, { week: 8, date: '2027-03-29' }, { week: 12, date: '2027-04-26' }
    ]);
    expect(fees.guaranteeCheckinDays('')).toEqual([]);
  });
  it('an invoice is due seven days after its date', () => {
    expect(fees.invoicePaymentDueOn('2027-02-01')).toBe('2027-02-08');
  });
  it('the part-time reminders fall at calendar months 6 and 12 (month ends handled)', () => {
    expect(fees.upliftReminderDays('2027-02-01')).toEqual([{ month: 6, date: '2027-08-01' }, { month: 12, date: '2028-02-01' }]);
    expect(fees.upliftReminderDays('2026-08-31')).toEqual([{ month: 6, date: '2027-02-28' }, { month: 12, date: '2027-08-31' }]);
  });
  it('cleanDay refuses a day that does not exist', () => {
    expect(fees.cleanDay('2027-02-30')).toBe('');
    expect(fees.cleanDay('2027-02-28T10:00:00Z')).toBe('2027-02-28');
    expect(fees.cleanDay(null)).toBe('');
  });
});

describe('guaranteeCreditFor: the credit schedule and its conditions', () => {
  // A placement whose invoice was sent on commencement and paid on time, the
  // doctor resigned, and staff confirmed the other clause 7.2 conditions.
  const clean = (extra) => Object.assign({
    commencedAt: '2027-02-01', reason: 'doctor_resigned', conditionsConfirmed: 'yes',
    invoiceSentAt: '2027-02-01', invoicePaidAt: '2027-02-06', asOf: '2027-06-01'
  }, extra || {});
  const lastDay = (n) => fees.addDays('2027-02-01', n);

  it.each([
    [0, 80, 'up_to_4_weeks'], [1, 80, 'up_to_4_weeks'], [27, 80, 'up_to_4_weeks'],
    [29, 50, 'weeks_4_to_8'], [40, 50, 'weeks_4_to_8'], [55, 50, 'weeks_4_to_8'],
    [57, 35, 'weeks_8_to_12'], [70, 35, 'weeks_8_to_12'], [83, 35, 'weeks_8_to_12']
  ])('last working day %s days after commencement -> %s%% (%s)', (days, pct, band) => {
    const c = fees.guaranteeCreditFor(clean({ lastWorkingDay: lastDay(days) }));
    expect(c).toMatchObject({ creditPct: pct, known: true, reason: 'schedule', band, scheduleBandPct: pct, daysWorked: days, forfeited: false, withinGuarantee: true, needsDecision: [] });
  });

  it('the same bands apply when the practice ended it for performance (clause 7.1(a))', () => {
    expect(fees.guaranteeCreditFor(clean({ lastWorkingDay: lastDay(10), reason: 'performance_terminated' }))).toMatchObject({ creditPct: 80, known: true });
  });

  it('the edge days (exactly 4, 8 and 12 weeks) are a person\'s call: no figure', () => {
    for (const days of [28, 56, 84]) {
      const c = fees.guaranteeCreditFor(clean({ lastWorkingDay: lastDay(days) }));
      expect(c.known, String(days)).toBe(false);
      expect(c.creditPct, String(days)).toBeNull();
      expect(c.scheduleBandPct, String(days)).toBeNull();
      expect(c.needsDecision).toContain('band_edge_day');
    }
  });

  it('after the twelve weeks: nothing to credit, and that is known', () => {
    const c = fees.guaranteeCreditFor(clean({ lastWorkingDay: lastDay(85) }));
    expect(c).toMatchObject({ creditPct: 0, known: true, reason: 'outside_guarantee_period', withinGuarantee: false });
  });

  it('forfeited when the placement\'s invoice was paid late, or is unpaid past its seven days', () => {
    const paidLate = fees.guaranteeCreditFor(clean({ lastWorkingDay: lastDay(10), invoicePaidAt: '2027-02-09' }));
    expect(paidLate).toMatchObject({ creditPct: 0, known: true, forfeited: true, reason: 'forfeited_invoice_overdue' });
    const unpaid = fees.guaranteeCreditFor(clean({ lastWorkingDay: lastDay(10), invoicePaidAt: null, asOf: '2027-02-09' }));
    expect(unpaid).toMatchObject({ creditPct: 0, known: true, forfeited: true });
    // paid on the seventh day is on time
    expect(fees.guaranteeCreditFor(clean({ lastWorkingDay: lastDay(10), invoicePaidAt: '2027-02-08' }))).toMatchObject({ creditPct: 80, forfeited: false });
    // forfeiture wins even when everything else is unknown
    expect(fees.guaranteeCreditFor({ commencedAt: '2027-02-01', lastWorkingDay: lastDay(10), reason: 'other', invoiceSentAt: '2027-02-01', invoicePaidAt: '2027-03-01' }))
      .toMatchObject({ creditPct: 0, known: true, forfeited: true });
  });

  it('staff say the other clause 7.2 conditions were not met: no credit, known', () => {
    expect(fees.guaranteeCreditFor(clean({ lastWorkingDay: lastDay(10), conditionsConfirmed: 'no' }))).toMatchObject({ creditPct: 0, known: true, reason: 'conditions_not_met' });
  });

  it('anything that cannot be checked from what is on file: null, never a guessed number', () => {
    const unknowns = [
      [{ conditionsConfirmed: 'unknown' }, 'conditions_not_confirmed'],
      [{ conditionsConfirmed: undefined }, 'conditions_not_confirmed'],
      [{ reason: 'practice_side' }, 'discretionary_or_excluded_reason'],
      [{ reason: 'other' }, 'reason_unknown'],
      [{ reason: '' }, 'reason_unknown'],
      [{ invoiceSentAt: null, invoicePaidAt: null }, 'invoice_not_sent'],
      [{ invoicePaidAt: null, asOf: '2027-02-05' }, 'invoice_not_yet_paid'],
      [{ invoiceSentAt: null, invoicePaidAt: '2027-02-05' }, 'invoice_dates_unknown']
    ];
    for (const [extra, code] of unknowns) {
      const c = fees.guaranteeCreditFor(clean(Object.assign({ lastWorkingDay: lastDay(10) }, extra)));
      expect(c.known, code).toBe(false);
      expect(c.creditPct, code).toBeNull();
      expect(c.needsDecision, code).toContain(code);
      // the schedule's band is still reported, for the person deciding
      expect(c.scheduleBandPct, code).toBe(80);
      expect(fees.CREDIT_DECISION_TEXT[code], code).toBeTruthy();
    }
  });

  it('dates missing or impossible: null', () => {
    expect(fees.guaranteeCreditFor(clean({ lastWorkingDay: '' }))).toMatchObject({ creditPct: null, known: false, reason: 'dates_unknown' });
    expect(fees.guaranteeCreditFor(clean({ commencedAt: null, lastWorkingDay: '2027-02-10' }))).toMatchObject({ creditPct: null, known: false });
    expect(fees.guaranteeCreditFor(clean({ lastWorkingDay: '2027-01-20' }))).toMatchObject({ creditPct: null, known: false, reason: 'last_day_before_commencement' });
    expect(fees.guaranteeCreditFor(null)).toMatchObject({ creditPct: null, known: false });
  });

  it('a credit is only ever 0, 35, 50, 80 or null', () => {
    const seen = new Set();
    const reasons = ['doctor_resigned', 'performance_terminated', 'practice_side', 'other'];
    const conds = ['yes', 'no', 'unknown'];
    for (let days = 0; days <= 100; days += 1) {
      for (const reason of reasons) for (const conditionsConfirmed of conds) {
        for (const invoice of [{ invoiceSentAt: '2027-02-01', invoicePaidAt: '2027-02-03' }, { invoiceSentAt: '2027-02-01', invoicePaidAt: '2027-03-03' }, { invoiceSentAt: null, invoicePaidAt: null }]) {
          const c = fees.guaranteeCreditFor(Object.assign({ commencedAt: '2027-02-01', lastWorkingDay: lastDay(days), reason, conditionsConfirmed, asOf: '2027-06-01' }, invoice));
          seen.add(c.creditPct);
          expect(c.known).toBe(c.creditPct !== null);
        }
      }
    }
    expect(Array.from(seen).sort((a, b) => (a === null ? -1 : b === null ? 1 : a - b))).toEqual([null, 0, 35, 50, 80]);
  });
});
