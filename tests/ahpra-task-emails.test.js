import { describe, it, expect } from 'vitest';
import plan from '../lib/ahpra-task-emails.js';

const START = Date.parse('2026-07-04T00:00:00.000Z');

function mkTasks() {
  return [
    {
      id: 'task-upload-1',
      title: 'English language reference letters',
      mode: 'upload',
      gp_instructions: 'Upload reference letters covering the last two years.',
      how_to_steps: ['Ask your employer', 'Get it signed & dated'],
      deadline: '2026-08-29'
    },
    {
      id: 'task-req-2',
      title: 'Certificate of Good Standing from GMC',
      mode: 'request_institution',
      gp_instructions: 'Request this from the GMC, they send it to AHPRA directly.',
      institution: 'GMC',
      deadline: '2026-08-29'
    },
    {
      id: 'task-upload-3',
      title: 'Supervised practice plan attachments',
      mode: 'upload',
      detail: 'The following attachments have not been provided.',
      sub_items: ['Primary supervisor CV', { label: 'Position description' }]
    }
  ];
}

describe('buildAhpraTaskEmailPlan', () => {
  it('emits one email per task, staggered exactly 1 minute apart (first sends now)', () => {
    const out = plan.buildAhpraTaskEmailPlan(mkTasks(), { appBaseUrl: 'https://app.mygplink.com.au', startAtMs: START });
    expect(out).toHaveLength(3);
    expect(out[0].scheduledAt).toBeNull();
    expect(out[1].scheduledAt).toBe(new Date(START + 60000).toISOString());
    expect(out[2].scheduledAt).toBe(new Date(START + 120000).toISOString());
  });

  it('maps mode to the single action button: upload vs mark as requested', () => {
    const out = plan.buildAhpraTaskEmailPlan(mkTasks(), { appBaseUrl: 'https://app.mygplink.com.au', startAtMs: START });
    expect(out[0].ctaText).toBe('Upload document');
    expect(out[1].ctaText).toBe('Mark as requested');
    expect(out[2].ctaText).toBe('Upload document');
    // request_institution copy explains send-direct-then-mark
    expect(out[1].bodyHtml).toContain('mark it as requested');
    expect(out[1].bodyHtml).toContain('GMC');
  });

  it('deep-links every button straight to that task on the AHPRA page', () => {
    const out = plan.buildAhpraTaskEmailPlan(mkTasks(), { appBaseUrl: 'https://app.mygplink.com.au/', startAtMs: START });
    expect(out[0].ctaUrl).toBe('https://app.mygplink.com.au/pages/ahpra.html?task=task-upload-1');
    expect(out[1].ctaUrl).toBe('https://app.mygplink.com.au/pages/ahpra.html?task=task-req-2');
    // plain-text fallback carries the same link
    expect(out[1].text).toContain('?task=task-req-2');
  });

  it('numbers the sequence in the subject and body so nothing gets missed', () => {
    const out = plan.buildAhpraTaskEmailPlan(mkTasks(), { appBaseUrl: 'x', startAtMs: START });
    expect(out[0].subject).toContain('(1 of 3)');
    expect(out[2].subject).toContain('(3 of 3)');
    expect(out[0].bodyHtml).toContain('task 1 of 3');
    // single-task bundles skip the numbering noise
    const solo = plan.buildAhpraTaskEmailPlan([mkTasks()[0]], { appBaseUrl: 'x', startAtMs: START });
    expect(solo[0].subject).not.toContain('1 of 1');
  });

  it('includes instructions, how-to steps, sub-items and a formatted deadline', () => {
    const out = plan.buildAhpraTaskEmailPlan(mkTasks(), { appBaseUrl: 'x', startAtMs: START, reference: '1460970' });
    expect(out[0].bodyHtml).toContain('Upload reference letters');
    expect(out[0].bodyHtml).toContain('1. Ask your employer');
    expect(out[0].bodyHtml).toContain('29 August 2026');
    expect(out[0].bodyHtml).toContain('1460970');
    expect(out[2].bodyHtml).toContain('Primary supervisor CV');
    expect(out[2].bodyHtml).toContain('Position description');
    // no deadline on task 3 → no "action this by" line
    expect(out[2].bodyHtml).not.toContain('action this by');
  });

  it('escapes HTML coming from officer-email extraction', () => {
    const out = plan.buildAhpraTaskEmailPlan([{
      id: 't1', title: 'X', mode: 'upload', gp_instructions: '<script>alert(1)</script> & "quotes"'
    }], { appBaseUrl: 'x', startAtMs: START });
    expect(out[0].bodyHtml).not.toContain('<script>');
    expect(out[0].bodyHtml).toContain('&lt;script&gt;');
    expect(out[0].bodyHtml).toContain('&amp;');
  });

  it('skips falsy/id-less rows and handles an empty list', () => {
    expect(plan.buildAhpraTaskEmailPlan([], { appBaseUrl: 'x', startAtMs: START })).toEqual([]);
    expect(plan.buildAhpraTaskEmailPlan(null, { appBaseUrl: 'x', startAtMs: START })).toEqual([]);
    const out = plan.buildAhpraTaskEmailPlan([null, { title: 'no id' }, mkTasks()[0]], { appBaseUrl: 'x', startAtMs: START });
    expect(out).toHaveLength(1);
    expect(out[0].taskId).toBe('task-upload-1');
  });

  it('formatDeadline is forgiving about odd input', () => {
    expect(plan.formatDeadline('2026-01-05')).toBe('5 January 2026');
    expect(plan.formatDeadline('asap')).toBe('asap');
    expect(plan.formatDeadline('')).toBe('');
  });
});
