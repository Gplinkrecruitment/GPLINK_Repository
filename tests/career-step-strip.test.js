import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { deriveCareerStep, STEPS } = require(path.join(__dirname, '..', 'js', 'career-step-strip.js'));

const app = (over) => Object.assign({ id: 'a1', roleId: 'r9', practiceName: 'Practice', rawStatus: 'applied', offerPending: false, contractStage: null, interview: null, isPlacementSecured: false }, over);

describe('career step strip — which step, what to do now', () => {
  it('four fixed steps', () => {
    expect(STEPS.map((s) => s.label)).toEqual(['Find your practice', 'Interview', 'Offer & contract', 'Registration']);
  });
  it('no applications → step 1, browse/apply/enquire', () => {
    const r = deriveCareerStep([]);
    expect(r.step).toBe(1);
    expect(r.key).toBe('browse');
    expect(r.hint).toMatch(/apply or send an enquiry/);
    expect(r.href).toBe('');
  });
  it('closed applications do not count', () => {
    expect(deriveCareerStep([app({ rawStatus: 'withdrawn' }), app({ rawStatus: 'not_proceeding' })]).key).toBe('browse');
  });
  it('applied / submitted / reviewing → step 1 waiting, linking to the application', () => {
    for (const s of ['applied', 'submitted', 'reviewing', 'under_review']) {
      const r = deriveCareerStep([app({ rawStatus: s })]);
      expect(r.step, s).toBe(1);
      expect(r.key).toBe('applied');
      expect(r.hint).toMatch(/the practice/);
      expect(r.href).toBe('application-detail?id=a1&role=r9');
    }
    expect(deriveCareerStep([app({ rawStatus: 'submitted', practiceName: 'SOP Erina' })]).hint).toContain('with SOP Erina');
  });
  it('interview offered → step 2 choose a time; booked → step 2 with the date; done → waiting on the practice', () => {
    const pick = deriveCareerStep([app({ rawStatus: 'interview' })]);
    expect(pick.step).toBe(2); expect(pick.key).toBe('interview_pick'); expect(pick.ctaLabel).toBe('Choose a time');
    const booked = deriveCareerStep([app({ rawStatus: 'interview_scheduled', interview: { status: 'booked', scheduledAt: '2026-09-10T02:00:00Z' } })]);
    expect(booked.key).toBe('interview_booked'); expect(booked.hint).toMatch(/booked for/);
    const done = deriveCareerStep([app({ rawStatus: 'interview_completed' })]);
    expect(done.key).toBe('interview_done');
    expect(deriveCareerStep([app({ rawStatus: 'interview', interview: { status: 'completed' } })]).key).toBe('interview_done');
  });
  it('offer pending → step 3 review offer; contract out → sign; practice reviewing changes → wait', () => {
    const offer = deriveCareerStep([app({ rawStatus: 'interview', offerPending: true })]);
    expect(offer.step).toBe(3); expect(offer.key).toBe('offer_pending'); expect(offer.href).toBe('offer-review?applicationId=a1');
    const sign = deriveCareerStep([app({ rawStatus: 'offer_accepted_pending', contractStage: 'sent_to_gp' })]);
    expect(sign.key).toBe('contract_sign'); expect(sign.ctaLabel).toBe('Sign my contract');
    expect(deriveCareerStep([app({ contractStage: 'practice_review' })]).key).toBe('contract_review');
    expect(deriveCareerStep([app({ rawStatus: 'finalising_placement' })]).key).toBe('finalising');
  });
  it('a pending match outranks a plain application and is never "your application is with…" (owner 2026-09-07)', () => {
    const r = deriveCareerStep([app({ id: 'p', rawStatus: 'applied', practiceName: 'GP Link Sandbox Practice' }), app({ id: 'm', roleId: 'r2', rawStatus: 'matched', practiceName: 'Sandbox Coastal Medical Centre' })]);
    expect(r.step).toBe(1);
    expect(r.key).toBe('match_pending');
    expect(r.hint).toContain('matched you to Sandbox Coastal Medical Centre');
    expect(r.hint).not.toContain('application is with');
    expect(r.href).toBe('job?id=r2&match=m');
    expect(r.ctaLabel).toBe('View matched practice');
    // shortlisted (raw stage spelling) reads the same way
    expect(deriveCareerStep([app({ rawStatus: 'shortlisted' })]).key).toBe('match_pending');
    // and a plain application alone still names its own practice
    const only = deriveCareerStep([app({ rawStatus: 'applied', practiceName: 'GP Link Sandbox Practice' })]);
    expect(only.key).toBe('applied');
    expect(only.hint).toContain('put you forward to GP Link Sandbox Practice');
  });
  it('secured → step 4', () => {
    expect(deriveCareerStep([app({ isPlacementSecured: true })]).step).toBe(4);
    expect(deriveCareerStep([app({ rawStatus: 'placement_secured' })]).step).toBe(4);
  });
  it('the furthest application wins when several are live', () => {
    const r = deriveCareerStep([app({ id: 'x', rawStatus: 'applied' }), app({ id: 'y', rawStatus: 'interview' })]);
    expect(r.step).toBe(2); expect(r.href).toContain('id=y');
  });
  it('tolerates garbage', () => {
    expect(deriveCareerStep(null).step).toBe(1);
    expect(deriveCareerStep([null, 5, 'x']).step).toBe(1);
  });
});

// Owner 2026-09-07: an accepted match "becomes an application for the GP view"
// — but the strip must say they accepted and we are arranging the interview,
// never "your application is with…".
describe('accepted match (fast_tracked)', () => {
  it('reads as an accepted match being arranged and opens the timeline', () => {
    const r = deriveCareerStep([app({ id: 'f', rawStatus: 'fast_tracked', practiceName: 'Sandbox Coastal Medical Centre' })]);
    expect(r.step).toBe(1);
    expect(r.key).toBe('fast_tracked');
    expect(r.hint).toContain('You accepted the match with Sandbox Coastal Medical Centre');
    expect(r.hint).not.toContain('Your application is with');
    expect(r.href).toContain('application-detail?id=f');
    expect(r.ctaLabel).toBe('See my application');
  });
  it('outranks a plain applied row', () => {
    const r = deriveCareerStep([app({ id: 'p', rawStatus: 'applied', practiceName: 'A' }), app({ id: 'f', roleId: 'r2', rawStatus: 'fast_tracked', practiceName: 'B' })]);
    expect(r.key).toBe('fast_tracked');
  });
});
