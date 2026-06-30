import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
const { __testUtils } = require('../server.js');
const { ahpraConfidentMatch, buildAhpraGpDeliveryItem } = __testUtils;

// ── Confidence gate: only bind an officer email to a GP case on a high-confidence match. ──
// This guards the cross-contamination bug the audit found (the 6-card pipeline used to bind
// any non-null best-guess user_id to a case regardless of confidence/needs_triage).
describe('ahpraConfidentMatch', () => {
  it('accepts a confident, matched, non-triage result', () => {
    expect(ahpraConfidentMatch({ matched_gp_user_id: 'u1', confidence: 0.9, needs_triage: false })).toBe(true);
  });
  it('accepts exactly at the 0.7 boundary', () => {
    expect(ahpraConfidentMatch({ matched_gp_user_id: 'u1', confidence: 0.7 })).toBe(true);
  });
  it('rejects just below the 0.7 boundary', () => {
    expect(ahpraConfidentMatch({ matched_gp_user_id: 'u1', confidence: 0.69 })).toBe(false);
  });
  it('rejects when needs_triage is set, even at high confidence', () => {
    expect(ahpraConfidentMatch({ matched_gp_user_id: 'u1', confidence: 0.95, needs_triage: true })).toBe(false);
  });
  it('rejects when there is no matched GP', () => {
    expect(ahpraConfidentMatch({ matched_gp_user_id: null, confidence: 0.99 })).toBe(false);
  });
  it('rejects when confidence is missing', () => {
    expect(ahpraConfidentMatch({ matched_gp_user_id: 'u1' })).toBe(false);
  });
  it('coerces a string confidence', () => {
    expect(ahpraConfidentMatch({ matched_gp_user_id: 'u1', confidence: '0.8' })).toBe(true);
  });
  it('is safe on null/undefined input', () => {
    expect(ahpraConfidentMatch(null)).toBe(false);
    expect(ahpraConfidentMatch(undefined)).toBe(false);
  });
});

// ── Card -> GP-facing s80 item mapping (the "connect to doctor" hand-off). ──
// Guards that an AHPRA card delivered to the GP becomes a properly-shaped, GP-VISIBLE s80 item
// (s80=true, review_status=active, owner=gp, mode=upload) so it renders on the GP's AHPRA page.
describe('buildAhpraGpDeliveryItem', () => {
  const NOW = '2026-07-01T00:00:00.000Z';
  const baseCard = {
    id: 'card-1',
    case_id: 'case-1',
    title: 'AHPRA document request',
    description: 'AHPRA requires a freshly certified copy of the primary medical degree.',
    due_date: '2026-07-15'
  };

  it('produces a GP-visible active s80 upload item', () => {
    const meta = { summary: 'AHPRA needs a certified medical degree.', ahpra_deadline: '2026-07-20', ahpra_officer_name: 'Jane Patterson', ahpra_officer_email: 'jane@ahpra.gov.au' };
    const out = buildAhpraGpDeliveryItem(baseCard, meta, NOW);
    expect(out.task_type).toBe('ahpra_action_item');
    expect(out.status).toBe('waiting_on_gp');
    expect(out.related_stage).toBe('ahpra');
    expect(out.metadata.s80).toBe(true);
    expect(out.metadata.review_status).toBe('active'); // visible to GP immediately (RSO already reviewed by clicking)
    expect(out.metadata.owner).toBe('gp');
    expect(out.metadata.mode).toBe('upload');
    expect(out.metadata.source_card_task_id).toBe('card-1');
    expect(out.metadata.released_at).toBe(NOW);
    expect(out.metadata.officer).toEqual({ name: 'Jane Patterson', email: 'jane@ahpra.gov.au' });
  });

  it('prefers the AI summary for the GP instruction, then deadline from metadata', () => {
    const meta = { summary: 'Please upload your certified degree.', ahpra_deadline: '2026-07-20' };
    const out = buildAhpraGpDeliveryItem(baseCard, meta, NOW);
    expect(out.description).toBe('Please upload your certified degree.');
    expect(out.metadata.gp_instructions).toBe('Please upload your certified degree.');
    expect(out.due_date).toBe('2026-07-20');
    expect(out.ahpra_deadline).toBe('2026-07-20');
  });

  it('falls back to the card description and card due_date when metadata is sparse', () => {
    const out = buildAhpraGpDeliveryItem(baseCard, {}, NOW);
    expect(out.description).toBe(baseCard.description);
    expect(out.due_date).toBe('2026-07-15'); // card.due_date fallback
    expect(out.metadata.officer).toBe(null);
  });

  it('strips the RSO-only response-type suffix from the title', () => {
    const out = buildAhpraGpDeliveryItem({ ...baseCard, title: 'AHPRA amendment request (RSO fix)' }, {}, NOW);
    expect(out.title).toBe('AHPRA amendment request');
  });

  it('is safe with null inputs', () => {
    const out = buildAhpraGpDeliveryItem(null, null, NOW);
    expect(out.task_type).toBe('ahpra_action_item');
    expect(out.metadata.owner).toBe('gp');
    expect(typeof out.description).toBe('string');
  });
});
