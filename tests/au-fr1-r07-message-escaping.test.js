// Fix bundle FR-1, defect R-07: a name that contains HTML is never sent live.
//
// Every Australian message builder is fed hostile values in EVERY input it
// reads (a Proxy answers any property the builder asks for), and every string
// that comes out is checked:
//   - nothing a browser would treat as a tag, unless the builder wrote that
//     tag itself (then the hostile value inside it must be escaped);
//   - a subject or title never carries a line break (no header injection);
//   - the shared email shell (server.js buildCareerEmailHtml) therefore never
//     switches such a body to its "already HTML" path.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const safe = require('../lib/au-safe-text.js');
const auMessages = require('../lib/au-messages.js');
const placement = require('../lib/au-placement-messages.js');
const staffTools = require('../lib/au-staff-tools.js');
const leadCopy = require('../lib/au-lead-copy.js');
const careerIntro = require('../lib/career-intro.js');
const lifecycle = require('../lib/au-lifecycle.js');
const prestart = require('../lib/au-prestart.js');
const segmentB = require('../lib/au-segment-b.js');

const ROOT = path.resolve(__dirname, '..');
const PAYLOADS = [
  'Evil <script>alert(1)</script> Clinic',
  '"><img src=x onerror=alert(1)>',
  'Line one\r\nBcc: victim@gplink-test.local\nSubject: injected',
  '<a href="https://evil.example">click</a>',
  '</p><iframe src=//evil.example></iframe>',
  'O\'Brien & Sons <b>Medical</b>',
  'x\u2028<svg/onload=alert(1)>'
];
// The shell's own test for "this body is already HTML" (server.js buildCareerEmailHtml).
const SHELL_HTML_RE = /<[a-z][^>]*>/i;

// An input object that answers every property with the hostile value, except
// the few a builder needs in a particular shape to get past its own checks.
function hostile(payload, fixed) {
  const base = Object.assign({
    appBaseUrl: 'https://app.gplink-test.local', startDate: '2027-02-01', oldStartDate: '2027-01-25', newStartDate: '2027-02-01',
    commencedAt: '2027-02-01', noticeDate: '2026-12-01', date: '2027-02-01', week: 4, index: 0, step: 1, daysWaiting: 14, window: 14,
    then: undefined, toJSON: undefined, length: undefined
  }, fixed || {});
  return new Proxy(base, {
    get(target, key) {
      if (typeof key === 'symbol') return undefined;
      if (Object.prototype.hasOwnProperty.call(target, key)) return target[key];
      return payload;
    },
    has() { return true; }
  });
}
function strings(value, trail, out) {
  const acc = out || [];
  if (typeof value === 'string') acc.push([trail, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, trail + '[' + i + ']', acc));
  else if (value && typeof value === 'object') Object.keys(value).forEach((k) => strings(value[k], trail ? trail + '.' + k : k, acc));
  return acc;
}
// A string is safe when it has no tag at all, or when every "<" in it belongs
// to a tag the builder itself writes (a fixed allow-list) and no hostile
// fragment survives un-escaped.
const BUILDER_TAGS = /<\/?(p|br|strong|b|em|ul|ol|li|a|div|span|table|tr|td|th|h1|h2|h3|hr|small)(\s[^<>]*)?>/gi;
function assertSafe(label, trail, text) {
  const where = label + ' -> ' + trail;
  expect(/<\s*script/i.test(text), where + ' has a script tag').toBe(false);
  expect(/<\s*(img|svg|iframe|object|embed|form|input|style|link|meta)\b/i.test(text), where + ' has a live tag').toBe(false);
  expect(/<[^<>]*\son[a-z]+\s*=/i.test(text), where + ' has an event handler inside a tag').toBe(false);
  expect(/<[^<>]*(href|src)\s*=\s*["']?(https:)?\/\/evil\.example/i.test(text), where + ' carries the hostile link live').toBe(false);
  if (/(^|\.)(ctaUrl|secondaryCtaUrl|unsubscribeUrl|joinUrl|url|href)$/i.test(trail)) {
    // A link is put into href="..." by the shell: it must be a clean http(s) link or empty.
    expect(text === '' || safe.safeUrl(text) === text, where + ' is not a clean link: ' + text.slice(0, 80)).toBe(true);
    return;
  }
  const withoutOwnTags = text.replace(BUILDER_TAGS, '');
  expect(safe.hasLiveTag(withoutOwnTags), where + ' has a tag the builder did not write: ' + withoutOwnTags.slice(0, 160)).toBe(false);
  if (/(^|\.)(subject|title|ctaText|templateName)$/.test(trail) || /bell\.(title|body)$/.test(trail)) {
    expect(/[\r\n\u2028\u2029]/.test(text), where + ' carries a line break').toBe(false);
    expect(text.indexOf('<'), where + ' carries "<"').toBe(-1);
  }
  if (/(^|\.)(body|text)$/.test(trail) && !/html/i.test(trail)) {
    // A plain-text body must stay plain for the shell: otherwise it is pasted in as HTML.
    expect(SHELL_HTML_RE.test(text), where + ' would be treated as ready-made HTML by the email shell').toBe(false);
  }
}

const TASK_KINDS = [].concat(prestart.PRESTART_TASK_TYPES || [], prestart.EARLY_TASK_TYPES || [],
  Object.keys(lifecycle.KIND || {}).map((k) => lifecycle.KIND[k]), Object.keys(segmentB.KIND || {}).map((k) => segmentB.KIND[k]),
  segmentB.TRANSFER_TASK_MARKS || [], [1, 4, 8, 12]);

// The builders the catalogue (lib/au-messages.js AU_MESSAGES) renders with its
// own realistic inputs; they are run with hostile sample values below.
const REGISTRY_BUILDERS = new Set();
REGISTRY_BUILDERS.add('buildStaffCallReminderMessage');   // has its own test below (it needs a real link to build at all)
Object.keys(auMessages.AU_MESSAGES).forEach((id) => String(auMessages.AU_MESSAGES[id].builder || '').split(/[^A-Za-z0-9_]+/).forEach((n) => { if (/^build/.test(n)) REGISTRY_BUILDERS.add(n); }));

function everyBuilder() {
  const list = [];
  const add = (lib, libName, fixedFor) => Object.keys(lib).filter((k) => /^build[A-Z]/.test(k) && typeof lib[k] === 'function').forEach((name) => {
    list.push({ label: libName + '.' + name, fn: lib[name], fixed: (fixedFor && fixedFor[name]) || null });
  });
  add(auMessages, 'au-messages', { buildDurableBellEntry: 'skip' });
  add(placement, 'au-placement-messages', { buildDurableBellEntry: 'skip' });
  add(staffTools, 'au-staff-tools');
  add(lifecycle, 'au-lifecycle');
  add(prestart, 'au-prestart');
  add(segmentB, 'au-segment-b');
  // de-duplicate (au-messages re-exports the placement builders)
  const seen = new Set();
  return list.filter((b) => b.fixed !== 'skip' && !seen.has(b.fn) && seen.add(b.fn));
}

describe('R-07: the shared helper', () => {
  it('safeText: one line, nothing that can look like a tag, the words still readable', () => {
    expect(safe.safeText('Evil <script>alert(1)</script> Clinic')).toBe('Evil \u2039script\u203aalert(1)\u2039/script\u203a Clinic');
    expect(safe.safeText('a\r\nBcc: x@y\n\tz')).toBe('a Bcc: x@y z');
    expect(safe.safeText('x\u2028y\u202ez')).toBe('x y z');
    expect(safe.safeText('  Test Metro Practice (FAKE)  ')).toBe('Test Metro Practice (FAKE)');
    expect(safe.safeText('O\'Brien & Sons')).toBe('O\'Brien & Sons');
    expect(safe.safeText('abcdef', 3)).toBe('abc');
    for (const junk of [null, undefined, 7, {}, [], true]) expect(typeof safe.safeText(junk)).toBe('string');
    for (const p of PAYLOADS) {
      const out = safe.safeText(p, 500);
      expect(out.indexOf('<')).toBe(-1);
      expect(out.indexOf('>')).toBe(-1);
      expect(/[\r\n]/.test(out)).toBe(false);
      expect(SHELL_HTML_RE.test(out)).toBe(false);
    }
  });
  it('safeBlock keeps paragraphs and nothing else; escapeHtml and safeUrl', () => {
    expect(safe.safeBlock('one\n\n\n\ntwo <b>x</b>\r\nthree')).toBe('one\n\ntwo \u2039b\u203ax\u2039/b\u203a\nthree');
    expect(safe.escapeHtml('"><img src=x onerror=1> & \'')).toBe('&quot;&gt;&lt;img src=x onerror=1&gt; &amp; &#39;');
    expect(safe.safeUrl('https://app.gplink-test.local/pages/prestart?x=1')).toBe('https://app.gplink-test.local/pages/prestart?x=1');
    for (const bad of ['javascript:alert(1)', 'https://x" onmouseover="1', 'https://x/<script>', 'data:text/html,x', '//evil.example', 'https://x y', '']) expect(safe.safeUrl(bad), bad).toBe('');
  });
  it('the source file holds no raw control character', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/au-safe-text.js'), 'utf8');
    for (let i = 0; i < src.length; i++) {
      const c = src.charCodeAt(i);
      if ((c < 32 && c !== 10) || c === 0x2028 || c === 0x2029) throw new Error('raw control character at offset ' + i);
    }
  });
  it('every Australian message file takes its cleaner from the one helper', () => {
    for (const f of ['au-messages.js', 'au-placement-messages.js', 'au-lead-copy.js', 'au-lifecycle.js', 'au-prestart.js', 'au-segment-b.js', 'au-commencement.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8');
      expect(src, f).toContain("require('./au-safe-text.js')");
      // no private copy of the old cleaner is left behind
      expect(src, f).not.toMatch(/function clean(Line|Text)?\(value, max\) \{\n\s+return String\(value == null \? '' : value\)/);
    }
  });
});

describe('R-07: every builder, every input hostile', () => {
  const builders = everyBuilder();
  it('the registry is the whole set (a new builder is covered the day it is exported)', () => {
    expect(builders.length).toBeGreaterThanOrEqual(30);
    const names = builders.map((b) => b.label);
    for (const must of ['buildPlacementSecuredMessage', 'buildNoticeStartGpMessage', 'buildNoticeStartPracticeMessage', 'buildClearedToStartMessage',
      'buildStalledReminderMessage', 'buildCommencementCheckinGpMessage', 'buildCommencementCheckinPracticeMessage', 'buildWeekCheckinGpMessage',
      'buildWeekCheckinPracticeMessage', 'buildReferralAskMessage', 'buildPlacementConfirmedPracticeMessage', 'buildPrestartItemRequestMessage',
      'buildPracticeFormNeededMessage', 'buildSegmentBOutcomeGpMessage', 'buildSegmentBOutcomePracticeMessage', 'buildSupervisionPracticeReminder',
      'buildWelcomeMessage', 'buildOnboardingNudgeMessage', 'buildProfileCompleteMessage', 'buildAhpraVerifiedMessage', 'buildAhpraNotMatchedMessage',
      'buildCandidateInviteEmail', 'buildOwnerDigestBlock', 'buildStaffCallReminderMessage']) {
      expect(names.some((n) => n.endsWith('.' + must)), must).toBe(true);
    }
  });

  for (const b of everyBuilder()) {
    it(b.label, () => {
      let calls = 0;
      for (const payload of PAYLOADS) {
        // every input hostile; then with the shapes some builders branch on
        const variants = [
          hostile(payload),
          hostile(payload, { variant: 'B', group: 'safe', audience: 'practice', outcome: 'not_matched', week: 8, kind: 'checkin', mark: 'lodged', type: 'credentialing_pack' }),
          hostile(payload, { variant: 'C', group: 'main', week: 12, items: [payload, payload], itemKeys: ['provider_number', payload], notes: [payload],
            rows: [{ name: payload, practiceName: payload, note: payload, label: payload }], reasons: [payload], derivation: { reasons: [payload], pathway: payload, segment: payload } })
        ];
        for (const input of variants) {
          let out;
          const outs = [];
          try { outs.push(b.fn.length >= 2 ? b.fn(input, input, input) : b.fn(input)); } catch (e) { /* a builder may refuse junk; it must not leak it */ }
          // builders whose first argument is a kind (a task type, a week, a mark): every kind they know
          if (b.fn.length >= 2) {
            for (const first of TASK_KINDS) { try { outs.push(b.fn(first, input, input)); } catch (e) { /* not a kind this builder takes */ } }
          }
          for (const out of outs) {
          if (out == null) continue;
          // A staff TASK (it has a task_type) is stored, not sent: its title and
          // description are the words; the rest are identifiers the caller owns.
          calls += 1;
          const isTask = out && typeof out === 'object' && typeof out.task_type === 'string';
          strings(out, '').forEach(([trail, text]) => {
            if (isTask && trail !== 'title' && trail !== 'description') return;
            if (/(^|\.)(key|ledgerKey|id|templateKey)$/.test(trail)) return;   // ledger / lookup keys, never shown
            assertSafe(b.label, trail, text);
          });
          }
        }
      }
      const name = b.label.split('.').pop();
      expect(calls > 0 || REGISTRY_BUILDERS.has(name), b.label + ' was exercised here or by the registry run').toBe(true);
    });
  }

  it('the registry N04 to N22: every sample message, rendered with hostile practice, doctor and contact names', () => {
    let rendered = 0;
    const seenBuilders = new Set();
    for (const payload of PAYLOADS) {
      const reg = auMessages.registryWith({ practiceName: payload, gpName: payload, contactName: payload, placementKey: 'APP-EXAMPLE' });
      Object.keys(reg).forEach((id) => {
        const entry = reg[id];
        String(entry.builder || '').split(/[^A-Za-z0-9_]+/).forEach((n) => { if (/^build/.test(n)) seenBuilders.add(n); });
        const samples = typeof entry.samples === 'function' ? entry.samples() : [];
        samples.forEach((s) => {
          if (!s || !s.message) return;
          rendered += 1;
          strings(s.message, '').forEach(([trail, text]) => {
            if (/(^|\.)(key|ledgerKey|id|templateKey)$/.test(trail)) return;
            assertSafe(id + ' "' + s.label + '"', trail, text);
          });
          // and the message as the shell would send it: a plain body stays plain
          if (typeof s.message.body === 'string') expect(SHELL_HTML_RE.test(s.message.body), id + ' body').toBe(false);
          if (typeof s.message.title === 'string') expect(s.message.title.indexOf('<'), id + ' title').toBe(-1);
          if (typeof s.message.subject === 'string') expect(/[<\r\n]/.test(s.message.subject), id + ' subject').toBe(false);
        });
      });
    }
    expect(rendered).toBeGreaterThan(PAYLOADS.length * 20);
    // the hostile name really did reach the messages (so the test is not vacuous)
    const one = auMessages.registryWith({ practiceName: 'Evil <script>x</script> Clinic' }).N11.samples()[0].message;
    expect(one.body).toContain('Evil \u2039script\u203Ax\u2039/script\u203A Clinic');
    for (const must of ['buildPlacementSecuredMessage', 'buildNoticeStartGpMessage', 'buildClearedToStartMessage', 'buildStalledReminderMessage']) expect(seenBuilders.has(must), must).toBe(true);
  });

  it('builders the catalogue does not render, with realistic inputs', () => {
    for (const payload of PAYLOADS) {
      const outs = [
        auMessages.buildStaffCallReminderMessage({ joinUrl: 'https://zoom.us/j/0000000000', whenText: payload, firstName: payload, window: 'day' }),
        auMessages.buildStaffCallReminderMessage({ joinUrl: 'https://zoom.us/j/0000000000', whenText: payload, firstName: payload, window: 'soon' }),
        auMessages.buildStaffCallReminderMessage({ joinUrl: payload, whenText: 'Monday', firstName: 'Test' })
      ];
      expect(outs[0]).toBeTruthy();
      expect(outs[2]).toBeNull();      // a hostile "link" is not a link: no message at all
      outs.filter(Boolean).forEach((o) => strings(o, '').forEach(([trail, text]) => assertSafe('buildStaffCallReminderMessage', trail, text)));
    }
  });

  it('the bell entry built from a message carries no tag', () => {
    for (const payload of PAYLOADS) {
      const msg = placement.buildPlacementSecuredMessage(hostile(payload));
      const entry = placement.buildDurableBellEntry('k1', msg.bell, '2026-11-23T00:00:00.000Z');
      strings(entry, 'bell').forEach(([trail, text]) => { expect(safe.hasLiveTag(text), trail).toBe(false); });
    }
  });
});

describe('R-07: the lead and consult copy', () => {
  it('every message id, both groups, hostile name and time', () => {
    let n = 0;
    for (const payload of PAYLOADS) for (const id of leadCopy.MESSAGE_IDS) for (const group of ['main', 'safe']) {
      const ctx = { displayName: payload, whenText: payload, clockText: payload };
      for (const [kind, fn] of [['plainEmail', leadCopy.plainEmail], ['dripEmail', leadCopy.dripEmail]]) {
        let out = null;
        try { out = fn(id, group, ctx); } catch (e) { out = null; }
        if (!out) continue;
        n += 1;
        strings(out, '').forEach(([trail, text]) => assertSafe('au-lead-copy.' + kind + '(' + id + ',' + group + ')', trail, text));
        try { strings(leadCopy.dripText(out), 'text').forEach(([trail, text]) => assertSafe('au-lead-copy.dripText(' + id + ')', trail, text)); } catch (e) { /* not a drip */ }
      }
    }
    expect(n).toBeGreaterThan(20);
    expect(leadCopy.displayNameOf('Jane <script>x</script>')).toBe('Dr \u2039script\u203ax\u2039/script\u203a');
  });
});

describe('R-07: the practice introduction for an Australian doctor', () => {
  it('a hostile doctor name, state, practice or recommendation is never live in the paragraph, the chips or the email', () => {
    const cp = require('../lib/candidate-pathway.js');
    for (const payload of PAYLOADS) {
      const credentials = { ahpra_number: 'MED0001234567', fellowship_type: 'fracgp', staff_verified_at: '2026-11-20T00:00:00Z', work_rights: 'citizen', specialist_gp: true };
      const profile = { candidate_pathway: 'au_vr', pathway_confirmed_at: '2026-11-20T00:00:00Z', pathway_confirmed_by: 'ceo@gplink-test.local', current_state: payload, current_suburb: payload, register_status: 'verified', notice_period_weeks: 4 };
      const pathwayResult = cp.resolvePathwayFromRecords({ profile, credentials, flagEnabled: true });
      const facts = careerIntro.auIntroFactsFromRecords({ pathwayResult, credentials, profile });
      let intro = null;
      try { intro = careerIntro.buildAuCandidateIntro({ facts, firstName: payload, lastName: payload, displayName: payload, practiceName: payload, roleTitle: payload, recommendation: payload, name: payload }); } catch (e) { intro = null; }
      if (!intro) continue;
      strings(intro, '').forEach(([trail, text]) => {
        expect(/<\s*(script|img|svg|iframe)\b/i.test(text), 'career-intro ' + trail).toBe(false);
        expect(/href="https:\/\/evil\.example"/i.test(text), 'career-intro ' + trail).toBe(false);
      });
    }
  });
});

describe('R-07: the overseas builders are not touched', () => {
  it('no overseas message file uses the Australian helper', () => {
    for (const f of ['consult-whatsapp.js', 'consult-lead.js', 'booker-nudge-email.js', 'onboarding-nudge.js', 'match-whatsapp.js', 'consult-reminders.js']) {
      const p = path.join(ROOT, 'lib', f);
      if (!fs.existsSync(p)) continue;
      expect(fs.readFileSync(p, 'utf8'), f).not.toContain('au-safe-text');
    }
  });
});
