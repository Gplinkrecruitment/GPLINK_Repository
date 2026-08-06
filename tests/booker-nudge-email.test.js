// Rich post-consultation signup drip copy (sequence booked_no_signup, steps 0–4).
import { describe, it, expect } from 'vitest';
const { buildBookerNudgeEmail, BOOKER_NUDGE_STEP_COUNT, withRef } = require('../lib/booker-nudge-email.js');

const base = { firstName: 'Faraz', displayName: 'Dr Sonde', signupUrl: 'https://app.mygplink.com.au/pages/signin?signup=1&email=faraz%40x.com', unsubscribeUrl: 'https://app.mygplink.com.au/api/unsubscribe?token=t' };

describe('buildBookerNudgeEmail', () => {
  it('exposes a 5-step sequence', () => {
    expect(BOOKER_NUDGE_STEP_COUNT).toBe(5);
  });

  it('returns a subject + non-empty bodyHtml for every step 0–4', () => {
    for (let step = 0; step < 5; step++) {
      const out = buildBookerNudgeEmail(step, base);
      expect(typeof out.subject).toBe('string');
      expect(out.subject.length).toBeGreaterThan(5);
      expect(typeof out.bodyHtml).toBe('string');
      expect(out.bodyHtml.length).toBeGreaterThan(100);
      // a single primary CTA button pointing at signup
      expect(out.bodyHtml).toContain('/pages/signin?signup=1');
    }
  });

  it('personalises the subject with the first name on the name-led touches', () => {
    expect(buildBookerNudgeEmail(0, base).subject).toContain('Faraz');
    expect(buildBookerNudgeEmail(1, base).subject).toContain('Faraz');
    expect(buildBookerNudgeEmail(2, base).subject).toContain('Faraz');
    expect(buildBookerNudgeEmail(4, base).subject).toContain('Faraz');
  });

  it('tags each CTA with a per-touch ref for attribution', () => {
    for (let step = 0; step < 5; step++) {
      expect(buildBookerNudgeEmail(step, base).bodyHtml).toContain('ref=nudge-t' + step);
    }
  });

  it('step 0 carries the flagship elements (progress tracker + benefits + scarcity)', () => {
    const html = buildBookerNudgeEmail(0, base).bodyHtml;
    expect(html).toContain('Where you are right now');       // progress tracker
    expect(html).toContain('What your account unlocks');     // benefits
    expect(html).toContain('limited number of doctors');     // scarcity
    expect(html).toContain('The GP Link Team');              // sign-off
  });

  it('escapes a hostile first name (no raw tag reaches the HTML)', () => {
    const out = buildBookerNudgeEmail(0, { ...base, firstName: '<img src=x onerror=alert(1)>' });
    expect(out.bodyHtml).not.toContain('<img src=x');
    expect(out.bodyHtml).toContain('&lt;img src=x');
    expect(out.subject).not.toContain('<img src=x');
  });

  it('falls back to a safe greeting when no name is given', () => {
    const out = buildBookerNudgeEmail(1, { signupUrl: base.signupUrl });
    expect(out.subject).toContain('there');
    expect(out.bodyHtml).toContain('there');
  });

  it('withRef appends correctly whether or not the url already has a query', () => {
    expect(withRef('https://x/y', 3)).toBe('https://x/y?ref=nudge-t3');
    expect(withRef('https://x/y?a=1', 3)).toBe('https://x/y?a=1&ref=nudge-t3');
    expect(withRef('', 3)).toBe('');
  });
});

// The mirror of step 0: they made an ACCOUNT first, so the CTA is the call.
// Sent on first login only when no consultation is already on file.
describe('buildFirstStepBookCallEmail', () => {
  const { buildFirstStepBookCallEmail } = require('../lib/booker-nudge-email.js');
  const opts = { firstName: 'Faraz', displayName: 'Dr Sonde', bookUrl: 'https://www.mygplink.com.au/start?ref=welcome#book' };

  it('congratulates the account, and its single CTA is the call', () => {
    const out = buildFirstStepBookCallEmail(opts);
    expect(out.subject).toContain('Faraz');
    expect(out.subject).toMatch(/account is live/i);
    expect(out.bodyHtml).toContain('/start?ref=welcome#book');
    // never the signup CTA — that is the OTHER direction's email
    expect(out.bodyHtml).not.toContain('signup=1');
    expect(out.bodyHtml).toMatch(/first step/i);
    expect(out.bodyHtml).toMatch(/30-minute call/i);
  });

  it('shows the account step already ticked and the call as the current one', () => {
    const html = buildFirstStepBookCallEmail(opts).bodyHtml;
    expect(html).toContain('Free account created');
    expect(html).toContain('Book your free 30-minute call');
    // the booked-first wording must NOT leak into the account-first variant
    expect(html).not.toContain('Consultation booked');
    expect(html).not.toContain('Create your free account');
  });

  it('falls back to a neutral greeting when no name is known', () => {
    const out = buildFirstStepBookCallEmail({ bookUrl: 'https://x.test/start#book' });
    expect(out.subject).toContain('there');
    expect(out.bodyHtml).toContain('there');
  });

  it('escapes a hostile name rather than emitting raw HTML', () => {
    const out = buildFirstStepBookCallEmail({ ...opts, firstName: '<script>x</script>' });
    expect(out.bodyHtml).not.toContain('<script>');
    expect(out.subject).not.toContain('<script>');
  });

  it('leaves the booked-first step 0 tracker untouched', () => {
    const html = buildBookerNudgeEmail(0, base).bodyHtml;
    expect(html).toContain('Consultation booked');
    expect(html).toContain('Create your free account');
    expect(html).not.toContain('Free account created');
  });
});
