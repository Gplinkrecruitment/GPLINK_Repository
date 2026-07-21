// Phase 6 I1, category-driven routing for the GENERIC email_triage path.
//
// resolveEmailRouting (lib/email-triage.js) is the pure decision the server's
// email_triage task creation now uses for related_stage + priority. The AHPRA
// 6-mode classifier path is untouched (server gates isAhpra BEFORE this runs).
import { describe, it, expect } from 'vitest';
import { resolveEmailRouting, parseTriageResponse, detectKeywordCategory, CATEGORY_STAGE_ROUTES } from '../lib/email-triage.js';

const matchedBase = { matched: true, gpStage: 'amc', senderIsGp: true, urgency: 'normal' };

describe('email category routing, stage-routable categories', () => {
  it('a visa email (AI category) files under the visa stage group, not the generic bucket', () => {
    const r = resolveEmailRouting({ ...matchedBase, sender: 'gp@example.com', subject: 'My 482 visa', bodySnippet: '', category: 'visa' });
    expect(r.related_stage).toBe('visa');
    expect(r.category).toBe('visa');
    expect(r.priority).toBe('normal');
  });

  it('a visa email is caught by keyword fallback even when the AI said "other"', () => {
    const r = resolveEmailRouting({ ...matchedBase, sender: 'gp@example.com', subject: 'Question about my subclass 482 nomination', bodySnippet: 'When will Home Affairs decide?', category: 'other' });
    expect(r.related_stage).toBe('visa');
  });

  it('a Medicare/PBS email files under the pbs stage group', () => {
    const r = resolveEmailRouting({ ...matchedBase, sender: 'gp@example.com', subject: 'Medicare provider number application', bodySnippet: '', category: 'medicare_pbs' });
    expect(r.related_stage).toBe('pbs');
    const kw = resolveEmailRouting({ ...matchedBase, sender: 'gp@example.com', subject: 'My prescriber number', bodySnippet: '', category: 'other' });
    expect(kw.related_stage).toBe('pbs');
  });

  it('a practice enquiry files under the synthetic practice_contact group', () => {
    const r = resolveEmailRouting({ ...matchedBase, senderIsGp: false, sender: 'manager@sunshinemedical.com.au', subject: 'Roster question for Dr A', bodySnippet: '', category: 'practice_enquiry' });
    expect(r.related_stage).toBe('practice_contact');
  });

  it('Home Affairs / Services Australia sender domains route deterministically', () => {
    const visa = resolveEmailRouting({ ...matchedBase, sender: 'noreply@homeaffairs.gov.au', subject: 'Visa grant notice', bodySnippet: '', category: 'other' });
    expect(visa.related_stage).toBe('visa');
    expect(visa.category).toBe('visa');
    const med = resolveEmailRouting({ ...matchedBase, sender: 'medicare@servicesaustralia.gov.au', subject: 'Provider registration', bodySnippet: '', category: 'other' });
    expect(med.related_stage).toBe('pbs');
    expect(med.category).toBe('medicare_pbs');
  });

  it('category → stage map covers exactly the routable categories', () => {
    expect(CATEGORY_STAGE_ROUTES).toEqual({ visa: 'visa', medicare_pbs: 'pbs', practice_enquiry: 'practice_contact', regulator: 'ahpra' });
  });
});

describe('email category routing, pre-existing behaviour preserved', () => {
  it('generic GP-sent mail keeps the GP\'s current stage and normal priority', () => {
    const r = resolveEmailRouting({ ...matchedBase, sender: 'gp@example.com', subject: 'Quick question', bodySnippet: 'about my documents', category: 'signing_question' });
    expect(r.related_stage).toBe('amc');
    expect(r.priority).toBe('normal');
  });

  it('generic third-party mail on a matched case still goes to practice_contact', () => {
    const r = resolveEmailRouting({ ...matchedBase, senderIsGp: false, sender: 'someone@somewhere.com', subject: 'About Dr A', bodySnippet: '', category: 'status_update' });
    expect(r.related_stage).toBe('practice_contact');
  });

  it('urgent urgency still escalates priority to urgent', () => {
    const r = resolveEmailRouting({ ...matchedBase, urgency: 'urgent', sender: 'gp@example.com', subject: 'HELP', bodySnippet: '', category: 'other' });
    expect(r.priority).toBe('urgent');
  });

  it('high urgency maps to high priority on matched mail', () => {
    const r = resolveEmailRouting({ ...matchedBase, urgency: 'high', sender: 'gp@example.com', subject: 'x', bodySnippet: '', category: 'other' });
    expect(r.priority).toBe('high');
  });
});

describe('email category routing, unmatched mail still lands in Support', () => {
  it('unmatched mail keeps low priority and no stage (case_id-null Support task)', () => {
    const r = resolveEmailRouting({ matched: false, sender: 'stranger@gmail.com', subject: 'hello', bodySnippet: '', category: 'other', urgency: 'normal' });
    expect(r.priority).toBe('low');
    expect(r.related_stage).toBe('');
  });

  it('unmatched urgent mail still escalates (existing behaviour)', () => {
    const r = resolveEmailRouting({ matched: false, sender: 'stranger@gmail.com', subject: 'URGENT', bodySnippet: '', category: 'other', urgency: 'urgent' });
    expect(r.priority).toBe('urgent');
  });

  it('unmatched keyword-visa mail is NOT promoted out of Support (stays low, no stage guess)', () => {
    const r = resolveEmailRouting({ matched: false, sender: 'stranger@gmail.com', subject: 'visa question', bodySnippet: '', category: 'other', urgency: 'normal' });
    expect(r.priority).toBe('low');
    expect(r.related_stage).toBe('');
  });
});

describe('email category routing, AI parser accepts the new categories', () => {
  it('parseTriageResponse keeps "visa" / "medicare_pbs" / "practice_enquiry" / "regulator"', () => {
    for (const cat of ['visa', 'medicare_pbs', 'practice_enquiry', 'regulator']) {
      const r = parseTriageResponse(JSON.stringify({ matched_gp_user_id: 'u-1', confidence: 0.9, category: cat, urgency: 'normal', summary: 'x', needs_triage: false }));
      expect(r.category).toBe(cat);
    }
  });
  it('still normalizes junk categories to other', () => {
    const r = parseTriageResponse(JSON.stringify({ matched_gp_user_id: 'u-1', confidence: 0.9, category: 'banana', urgency: 'normal', summary: 'x' }));
    expect(r.category).toBe('other');
  });
});

describe('email category routing, keyword detector stays narrow', () => {
  it('detects visa and medicare keywords', () => {
    expect(detectKeywordCategory('My visa expires soon', '')).toBe('visa');
    expect(detectKeywordCategory('', 'my medicare provider number came through')).toBe('medicare_pbs');
  });
  it('does not fire on unrelated text', () => {
    expect(detectKeywordCategory('Dinner on Friday', 'see you there')).toBeNull();
    expect(detectKeywordCategory('Advisable to review', 'the plan')).toBeNull();
  });
});
