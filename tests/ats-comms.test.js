import { describe, it, expect } from 'vitest';
import * as C from '../lib/ats-comms.js';

// ── Frozen clock ────────────────────────────────────────────────
const NOW = Date.UTC(2026, 5, 14, 12, 0, 0); // 2026-06-14T12:00:00Z
const DAY = 86400000;
const HOUR = 3600000;
const isoAgoH = (h) => new Date(NOW - h * HOUR).toISOString();
const isoAgoD = (d) => new Date(NOW - d * DAY).toISOString();

// ── computeReplyLatencyHrs ──────────────────────────────────────
describe('computeReplyLatencyHrs', () => {
  it('averages the gaps from a known outbound→inbound pair set', () => {
    const msgs = [
      { direction: 'outbound', at: isoAgoH(10) },
      { direction: 'inbound', at: isoAgoH(8) },  // 2h gap
      { direction: 'outbound', at: isoAgoH(6) },
      { direction: 'inbound', at: isoAgoH(2) }   // 4h gap
    ];
    expect(C.computeReplyLatencyHrs(msgs)).toBe(3); // (2 + 4) / 2
  });

  it('rounds the average to 1 decimal place', () => {
    const msgs = [
      { direction: 'outbound', at: isoAgoH(10) },
      { direction: 'inbound', at: isoAgoH(9) },  // 1h
      { direction: 'outbound', at: isoAgoH(6) },
      { direction: 'inbound', at: isoAgoH(4) }   // 2h
    ];
    expect(C.computeReplyLatencyHrs(msgs)).toBe(1.5);
  });

  it('sorts unsorted input and skips bad/missing timestamps', () => {
    const msgs = [
      { direction: 'inbound', at: isoAgoH(2) },
      { direction: 'outbound', at: 'not-a-date' }, // skipped
      { direction: 'outbound', at: isoAgoH(6) },
      { direction: 'inbound', at: null }           // skipped
    ];
    // valid + sorted: out(-6h), in(-2h) => 4h
    expect(C.computeReplyLatencyHrs(msgs)).toBe(4);
  });

  it('returns null when there is no measurable pair', () => {
    expect(C.computeReplyLatencyHrs([{ direction: 'inbound', at: isoAgoH(1) }])).toBe(null);
    expect(C.computeReplyLatencyHrs([])).toBe(null);
    expect(C.computeReplyLatencyHrs(null)).toBe(null);
  });
});

// ── countMessages30d ────────────────────────────────────────────
describe('countMessages30d', () => {
  it('counts messages inside the 30-day window and excludes older ones', () => {
    const msgs = [
      { at: isoAgoD(1) },   // inside
      { at: isoAgoD(29) },  // inside (boundary)
      { at: isoAgoD(31) },  // > 30 days -> excluded
      { at: 'garbage' }     // unparseable -> skipped
    ];
    expect(C.countMessages30d(msgs, NOW)).toBe(2);
  });

  it('is null-safe and defaults nowMs to Date.now()', () => {
    expect(C.countMessages30d(null)).toBe(0);
    expect(C.countMessages30d(undefined)).toBe(0);
    // recent message counts under the default clock too
    expect(C.countMessages30d([{ at: new Date(Date.now() - DAY).toISOString() }])).toBe(1);
  });
});

// ── buildCommsPrompt ────────────────────────────────────────────
describe('buildCommsPrompt', () => {
  it('includes section headers, the candidate name, and (none on file) for empty sections', () => {
    const prompt = C.buildCommsPrompt({
      candidateName: 'Dr Jane Smith',
      whatsappInbound: ['Hi, looking forward to it!'],
      outboundEmails: [],
      emailSnippets: [],
      calls: []
    });
    expect(prompt).toContain('Dr Jane Smith');
    expect(prompt).toContain('--- WHATSAPP (inbound) ---');
    expect(prompt).toContain('--- EMAILS (outbound, full) ---');
    expect(prompt).toContain('--- EMAIL SNIPPETS (inbound, metadata) ---');
    expect(prompt).toContain('--- CALLS ---');
    expect(prompt).toContain('Hi, looking forward to it!');
    expect(prompt).toContain('(none on file)');
    // strict-json contract is spelled out
    expect(prompt).toContain('messages30d');
    expect(prompt).toContain('avgReplyHrs');
    expect(prompt).toContain('engagementVal');
    expect(prompt).toContain('aiRead');
  });

  it('caps a section to ~15 items and each message to ~240 chars', () => {
    const many = Array.from({ length: 30 }, (_, i) => 'msg ' + i);
    const longMsg = 'x'.repeat(500);
    const prompt = C.buildCommsPrompt({
      candidateName: 'A',
      whatsappInbound: [longMsg].concat(many), // 31 items, first is over-long
      outboundEmails: [],
      emailSnippets: [],
      calls: []
    });
    expect(prompt).not.toContain('16. '); // no 16th numbered item
    expect(prompt).not.toContain('x'.repeat(300)); // long message truncated
  });
});

// ── parseCommsVerdict ───────────────────────────────────────────
describe('parseCommsVerdict', () => {
  it('parses a clean JSON object', () => {
    const v = C.parseCommsVerdict('{"messages30d": 5, "avgReplyHrs": 3.5, "tone": "warm", "engagementVal": 0.8, "aiRead": "Engaged."}');
    expect(v).toEqual({ messages30d: 5, avgReplyHrs: 3.5, tone: 'warm', engagementVal: 0.8, aiRead: 'Engaged.' });
  });

  it('parses code-fenced JSON', () => {
    const txt = '```json\n{"messages30d": 2, "avgReplyHrs": null, "tone": "neutral", "engagementVal": 0.5, "aiRead": "Ok."}\n```';
    const v = C.parseCommsVerdict(txt);
    expect(v.messages30d).toBe(2);
    expect(v.avgReplyHrs).toBe(null);
    expect(v.engagementVal).toBe(0.5);
  });

  it('extracts JSON embedded in surrounding prose', () => {
    const txt = 'Sure, here is my read: {"messages30d": 9, "avgReplyHrs": 1.2, "tone": "keen", "engagementVal": 1, "aiRead": "Very responsive."} Hope that helps!';
    expect(C.parseCommsVerdict(txt).messages30d).toBe(9);
  });

  it('clamps engagementVal above 1 down to 1 and below 0 up to 0', () => {
    expect(C.parseCommsVerdict('{"engagementVal": 1.7}').engagementVal).toBe(1);
    expect(C.parseCommsVerdict('{"engagementVal": -0.4}').engagementVal).toBe(0);
  });

  it('coerces messages30d to a non-negative integer', () => {
    expect(C.parseCommsVerdict('{"messages30d": "12"}').messages30d).toBe(12);
    expect(C.parseCommsVerdict('{"messages30d": -3}').messages30d).toBe(0);
    expect(C.parseCommsVerdict('{"messages30d": 4.7}').messages30d).toBe(5);
  });

  it('returns the safe default for non-JSON garbage without throwing', () => {
    expect(C.parseCommsVerdict('the model refused and wrote only prose'))
      .toEqual({ messages30d: 0, avgReplyHrs: null, tone: 'No data', engagementVal: 0, aiRead: '' });
    expect(C.parseCommsVerdict('{not valid json}'))
      .toEqual({ messages30d: 0, avgReplyHrs: null, tone: 'No data', engagementVal: 0, aiRead: '' });
  });

  it('returns the safe default for null/empty input', () => {
    expect(C.parseCommsVerdict(null).tone).toBe('No data');
    expect(C.parseCommsVerdict('').engagementVal).toBe(0);
  });
});

// ── API surface ─────────────────────────────────────────────────
describe('ats-comms API surface', () => {
  const required = ['computeReplyLatencyHrs', 'countMessages30d', 'buildCommsPrompt', 'parseCommsVerdict'];
  it('exports every helper', () => {
    for (const name of required) {
      expect(typeof C[name], name).toBe('function');
    }
  });
});
