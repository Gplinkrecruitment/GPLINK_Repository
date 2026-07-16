# Meta Ads → GP Funnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Meta-ads → `/start` landing page → book-a-call/signup funnel with Facebook lead-form recognition, screening, Calendly embed, and automated nudges, per `docs/superpowers/specs/2026-07-14-meta-ads-gp-funnel-design.md`.

**Architecture:** Pure decision logic (screening, FB payload normalization, nudge scheduling, email copy) lives in a new CommonJS module `lib/consult-lead.js`, mirroring `lib/onboarding-nudge.js`. All I/O (Supabase/dbState storage, HTTP endpoints, webhook branch, cron, email sends) is added to `server.js` following its existing dual-path idioms. The landing page is a new static marketing page `pages/site-start.html` in the existing `site.css` design system. Leads are rows in the existing `site_enquiries` table (kind `gp`), with all funnel state in the `metadata` jsonb column — **no DB migration**.

**Tech Stack:** Vanilla Node.js (no framework) single-file server, vanilla HTML/JS marketing page, Supabase via PostgREST (`supabaseDbRequest`), Resend email (`sendEmail`), Vitest.

## Global Constraints

- Supported screening countries: `['uk', 'ie', 'nz']` (lowercase codes). Everything else — and any non-GP — is screened out.
- Nudge cadences: not-booked → 2 h then 48 h; booked-but-no-signup → 3 d then 7 d after booking. Max 2 emails per sequence.
- All lead-facing email sends `from: { email: GP_OWNER_EMAIL, name: 'GP Link' }` (`GP_OWNER_EMAIL` is `'hello@mygplink.com.au'`, server.js:145). Magic-link email is `category` transactional (default); nudges are `category: 'marketing'` (auto suppression + auto List-Unsubscribe headers — see server.js:24974-25015).
- New env vars: `FB_GP_LEAD_FORM_IDS` (comma-separated Meta form IDs), reuses existing `FB_LEAD_VERIFY_TOKEN`/`FB_LEAD_WEBHOOK_SECRET`/`SITE_ENQUIRY_NOTIFY_EMAIL`/`CRON_SECRET`.
- Public-site base URL for links in emails: `const CONSULT_START_BASE = (process.env.SITE_PUBLIC_BASE_URL || 'https://mygplink.com.au');`
- Cache buster for new/edited static assets: `?v=20260714`.
- Marketing pages load ONLY `/css/site.css?v=20260703` + `/js/site.js?v=20260703` — never `auth-guard.js`/`nav-shell-bridge.js`.
- After every server.js edit: `node --check server.js` must pass before commit.
- Copy is plain English, warm, no jargon (owner's brand voice — see existing marketing pages).
- Commit at the end of every task on the current branch (`worktree-meta-ads-gp-funnel-spec`). Never push to main.
- DO NOT touch `pages/site-employers.html` (practice audience keeps raw Calendly) or `pages/ahpra.html` (in-app page) when repointing links.

**Orientation for implementers (read once):**
- `server.js` is ~59,500 lines. Never read it whole. Line numbers below were verified on this branch; if an edit anchor has drifted, grep the quoted code.
- Key existing pieces you will reuse: `SITE_PUBLIC_ROUTES` (server.js:58332), enquiry intake block (server.js:33573-33627), `insertSiteEnquiryRow` (19381), `listSiteEnquiryRows` (19406), `checkSiteEnquiryRateLimit`/`recordSiteEnquiryRateLimitHit` (19351/19363), `maybeNotifySiteEnquiry` (19632), `handleFacebookLeadWebhook` (10018), `normalizeFacebookLeadPayload` (lib/practice-pipeline.js:89), `sendEmail` (24974), `buildCareerEmailHtml` (25734), `buildMarketingUnsubUrl` (grep it; used at 25010), onboarding cron pattern (30431-30530), `checkRateLimitWindow` (10336), `getSupabaseUserIdByEmail` (23098), `readJsonBody` (9468), `sendJson` (9006), `getClientIp`, `supabaseDbRequest` (16031), `isSupabaseDbConfigured` (16027), `APP_BASE_URL` (grep), `CRON_SCHEDULES` (7342), export block at end of file (~59445).
- Tests boot the real server in local-JSON mode. Copy the harness from `tests/site-enquiry.test.js` (dynamic `await import('../server.js')`, `createServer()`, `listen(0)`, helper `post()`; reads `data/app-db.json` via a `readDb()` helper). Pure-lib tests copy `tests/onboarding-nudge.test.js` (`createRequire` + `require('../lib/...')`).

---

### Task 1: Pure logic module `lib/consult-lead.js`

**Files:**
- Create: `lib/consult-lead.js`
- Test: `tests/consult-lead.test.js`

**Interfaces:**
- Consumes: nothing (pure module; only `require('crypto')`).
- Produces (exact exports used by Tasks 2-4):
  - `SUPPORTED_CONSULT_COUNTRIES` — `['uk','ie','nz']`
  - `CONSULT_NUDGE_SCHEDULE_MS` — `{ not_booked: [2h, 48h], booked_no_signup: [3d, 7d] }` (ms values)
  - `screenConsultLead({ isGp, country })` → `boolean`
  - `generateConsultToken()` → 32-char base64url string
  - `parseGpFormIds(envValue)` → `string[]`
  - `parseYesNo(raw)` → `true | false | null`
  - `parseCountryAnswer(raw)` → `'uk' | 'ie' | 'nz' | 'other'`
  - `normalizeFacebookGpLead(body, allowedFormIds)` → `null` or `{ leadId, formId, name, email, phone, isGp, country, question }`
  - `validateConsultLeadPayload(body)` → `{ ok:true, value:{name,email,phone,isGp,country,question} } | { ok:false, error }`
  - `nextConsultNudge({ consult, createdAtMs, nowMs })` → `null | { seq:'not_booked'|'booked_no_signup', step:0|1 }`
  - `consultNudgeCopy(seq, step, { displayName, bookUrl, signupUrl })` → `{ subject, title, body, ctaText, ctaUrl }`
  - `consultDisplayName(name)` → `'Dr <last word>'` (falls back to trimmed full name, then `'there'`)

- [ ] **Step 1: Write the failing tests**

Create `tests/consult-lead.test.js`:

```js
import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  SUPPORTED_CONSULT_COUNTRIES,
  CONSULT_NUDGE_SCHEDULE_MS,
  screenConsultLead,
  generateConsultToken,
  parseGpFormIds,
  parseYesNo,
  parseCountryAnswer,
  normalizeFacebookGpLead,
  validateConsultLeadPayload,
  nextConsultNudge,
  consultNudgeCopy,
  consultDisplayName,
} = require('../lib/consult-lead.js');

const H = 60 * 60 * 1000;
const D = 24 * H;

describe('screenConsultLead', () => {
  it('passes a registered GP from uk/ie/nz only', () => {
    expect(screenConsultLead({ isGp: true, country: 'uk' })).toBe(true);
    expect(screenConsultLead({ isGp: true, country: 'ie' })).toBe(true);
    expect(screenConsultLead({ isGp: true, country: 'nz' })).toBe(true);
    expect(screenConsultLead({ isGp: true, country: 'other' })).toBe(false);
    expect(screenConsultLead({ isGp: false, country: 'uk' })).toBe(false);
    expect(screenConsultLead({ isGp: null, country: 'uk' })).toBe(false);
  });
});

describe('parseYesNo / parseCountryAnswer', () => {
  it('parses yes/no answers tolerantly', () => {
    expect(parseYesNo('Yes')).toBe(true);
    expect(parseYesNo('yes — fully registered')).toBe(true);
    expect(parseYesNo('No')).toBe(false);
    expect(parseYesNo('')).toBe(null);
    expect(parseYesNo(undefined)).toBe(null);
  });
  it('maps country answers to codes (northern ireland is uk)', () => {
    expect(parseCountryAnswer('United Kingdom')).toBe('uk');
    expect(parseCountryAnswer('UK (GMC)')).toBe('uk');
    expect(parseCountryAnswer('Northern Ireland')).toBe('uk');
    expect(parseCountryAnswer('Ireland')).toBe('ie');
    expect(parseCountryAnswer('New Zealand')).toBe('nz');
    expect(parseCountryAnswer('NZ')).toBe('nz');
    expect(parseCountryAnswer('South Africa')).toBe('other');
    expect(parseCountryAnswer('')).toBe('other');
  });
});

describe('parseGpFormIds', () => {
  it('splits and trims a comma list, dropping empties', () => {
    expect(parseGpFormIds(' 123, 456 ,,789 ')).toEqual(['123', '456', '789']);
    expect(parseGpFormIds('')).toEqual([]);
    expect(parseGpFormIds(undefined)).toEqual([]);
  });
});

describe('generateConsultToken', () => {
  it('returns a url-safe token of decent length, unique per call', () => {
    const a = generateConsultToken();
    const b = generateConsultToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    expect(a).not.toBe(b);
  });
});

function nativeFbBody(overrides = {}) {
  return {
    entry: [{
      changes: [{
        value: Object.assign({
          leadgen_id: 'L-1001',
          form_id: 'F-77',
          field_data: [
            { name: 'full_name', values: ['Aisha Khan'] },
            { name: 'email', values: ['aisha@example.co.uk'] },
            { name: 'phone_number', values: ['+447700900123'] },
            { name: 'are_you_a_currently_registered_gp?', values: ['Yes'] },
            { name: 'where_are_you_registered?', values: ['United Kingdom'] },
            { name: 'whats_your_main_question?', values: ['Visa timing'] },
          ],
        }, overrides),
      }],
    }],
  };
}

describe('normalizeFacebookGpLead', () => {
  it('parses the native Meta webhook shape when form id is allow-listed', () => {
    const lead = normalizeFacebookGpLead(nativeFbBody(), ['F-77']);
    expect(lead).toMatchObject({
      leadId: 'L-1001', formId: 'F-77', name: 'Aisha Khan',
      email: 'aisha@example.co.uk', phone: '+447700900123',
      isGp: true, country: 'uk', question: 'Visa timing',
    });
  });
  it('returns null when the form id is not allow-listed', () => {
    expect(normalizeFacebookGpLead(nativeFbBody(), ['OTHER'])).toBe(null);
    expect(normalizeFacebookGpLead(nativeFbBody(), [])).toBe(null);
  });
  it('parses the flat (Zapier-relay) shape', () => {
    const lead = normalizeFacebookGpLead({
      form_id: 'F-77', lead_id: 'L-2002', full_name: 'Sean Byrne',
      email: 'sean@example.ie', phone: '+353860000000',
      is_gp: 'yes', country: 'Ireland', question: '',
    }, ['F-77']);
    expect(lead).toMatchObject({
      leadId: 'L-2002', formId: 'F-77', name: 'Sean Byrne',
      email: 'sean@example.ie', isGp: true, country: 'ie',
    });
  });
  it('returns null without an email', () => {
    const body = nativeFbBody({ field_data: [{ name: 'full_name', values: ['X'] }] });
    expect(normalizeFacebookGpLead(body, ['F-77'])).toBe(null);
  });
});

describe('validateConsultLeadPayload', () => {
  const good = { name: 'Aisha Khan', email: 'a@b.co', phone: '+4477', isGp: true, country: 'uk', question: 'hi' };
  it('accepts a valid payload and normalizes country to lowercase', () => {
    const r = validateConsultLeadPayload({ ...good, country: 'UK' });
    expect(r.ok).toBe(true);
    expect(r.value.country).toBe('uk');
  });
  it('rejects missing name/email, bad email, bad country, non-boolean isGp', () => {
    expect(validateConsultLeadPayload({ ...good, name: '' }).ok).toBe(false);
    expect(validateConsultLeadPayload({ ...good, email: 'nope' }).ok).toBe(false);
    expect(validateConsultLeadPayload({ ...good, country: 'fr' }).ok).toBe(false);
    expect(validateConsultLeadPayload({ ...good, isGp: 'yes' }).ok).toBe(false);
  });
  it('caps question at 2000 chars', () => {
    const r = validateConsultLeadPayload({ ...good, question: 'x'.repeat(3000) });
    expect(r.ok).toBe(true);
    expect(r.value.question.length).toBe(2000);
  });
});

describe('nextConsultNudge', () => {
  const t0 = Date.parse('2026-07-14T00:00:00Z');
  it('not-booked: fires step 0 at 2h, step 1 at 48h, one per pass, never repeats', () => {
    const base = { consult: { call_booked: false, nudges: [] }, createdAtMs: t0 };
    expect(nextConsultNudge({ ...base, nowMs: t0 + 1 * H })).toBe(null);
    expect(nextConsultNudge({ ...base, nowMs: t0 + 3 * H })).toEqual({ seq: 'not_booked', step: 0 });
    // after step 0 recorded, step 1 not due until 48h even if 3h elapsed
    const afterStep0 = { consult: { call_booked: false, nudges: [{ seq: 'not_booked', step: 0 }] }, createdAtMs: t0 };
    expect(nextConsultNudge({ ...afterStep0, nowMs: t0 + 3 * H })).toBe(null);
    expect(nextConsultNudge({ ...afterStep0, nowMs: t0 + 49 * H })).toEqual({ seq: 'not_booked', step: 1 });
    const done = { consult: { call_booked: false, nudges: [{ seq: 'not_booked', step: 0 }, { seq: 'not_booked', step: 1 }] }, createdAtMs: t0 };
    expect(nextConsultNudge({ ...done, nowMs: t0 + 90 * D })).toBe(null);
  });
  it('booked: switches to booked_no_signup anchored at call_booked_at; not_booked stops', () => {
    const consult = { call_booked: true, call_booked_at: new Date(t0 + 1 * H).toISOString(), nudges: [] };
    expect(nextConsultNudge({ consult, createdAtMs: t0, nowMs: t0 + 2 * D })).toBe(null);
    expect(nextConsultNudge({ consult, createdAtMs: t0, nowMs: t0 + 1 * H + 3 * D + 1 })).toEqual({ seq: 'booked_no_signup', step: 0 });
  });
  it('stopped / screened / unqualified leads never nudge', () => {
    const late = t0 + 10 * D;
    expect(nextConsultNudge({ consult: { stopped: 'signed_up', nudges: [] }, createdAtMs: t0, nowMs: late })).toBe(null);
    expect(nextConsultNudge({ consult: { screened_out: true, nudges: [] }, createdAtMs: t0, nowMs: late })).toBe(null);
    expect(nextConsultNudge({ consult: { qualified: false, nudges: [] }, createdAtMs: t0, nowMs: late })).toBe(null);
  });
});

describe('consultNudgeCopy + consultDisplayName', () => {
  it('builds all four copies with the right cta url', () => {
    const opts = { displayName: 'Dr Khan', bookUrl: 'https://x/start?lead=T#book', signupUrl: 'https://x/pages/signin?signup=1' };
    for (const [seq, steps] of [['not_booked', 2], ['booked_no_signup', 2]]) {
      for (let s = 0; s < steps; s++) {
        const c = consultNudgeCopy(seq, s, opts);
        expect(c.subject.length).toBeGreaterThan(4);
        expect(c.body).toContain('Dr Khan');
        expect(c.ctaUrl).toBe(seq === 'not_booked' ? opts.bookUrl : opts.signupUrl);
      }
    }
  });
  it('booked copy is no-show tolerant (mentions grabbing another time)', () => {
    const c = consultNudgeCopy('booked_no_signup', 0, { displayName: 'Dr K', bookUrl: 'https://b', signupUrl: 'https://s' });
    expect(c.body.toLowerCase()).toContain('another time');
  });
  it('consultDisplayName uses the last word', () => {
    expect(consultDisplayName('Aisha Khan')).toBe('Dr Khan');
    expect(consultDisplayName('Cher')).toBe('Dr Cher');
    expect(consultDisplayName('')).toBe('there');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/consult-lead.test.js`
Expected: FAIL — `Cannot find module '../lib/consult-lead.js'`

- [ ] **Step 3: Write `lib/consult-lead.js`**

```js
// lib/consult-lead.js — pure decision logic for the Meta-ads GP consult funnel.
// No I/O beyond crypto randomness. Consumed by server.js (endpoints, FB webhook
// GP branch, consult-nudge cron). See docs/superpowers/specs/2026-07-14-meta-ads-gp-funnel-design.md.
'use strict';

const crypto = require('crypto');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const SUPPORTED_CONSULT_COUNTRIES = ['uk', 'ie', 'nz'];

// Sequence A (not_booked) anchors at lead creation; sequence B
// (booked_no_signup) anchors at call_booked_at. Two emails each, then silence.
const CONSULT_NUDGE_SCHEDULE_MS = {
  not_booked: [2 * HOUR, 48 * HOUR],
  booked_no_signup: [3 * DAY, 7 * DAY],
};

function screenConsultLead(input) {
  const isGp = !!(input && input.isGp === true);
  const country = String((input && input.country) || '').toLowerCase();
  return isGp && SUPPORTED_CONSULT_COUNTRIES.includes(country);
}

function generateConsultToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function parseGpFormIds(envValue) {
  return String(envValue || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseYesNo(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!v) return null;
  if (/^y(es)?\b/.test(v) || v === 'true') return true;
  if (/^no?\b/.test(v) || v === 'false') return false;
  return null;
}

function parseCountryAnswer(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!v) return 'other';
  if (v.includes('northern ireland')) return 'uk'; // before the 'ireland' check
  if (v.includes('united kingdom') || /\buk\b/.test(v) || v.includes('britain') || v.includes('england') || v.includes('scotland') || v.includes('wales')) return 'uk';
  if (v.includes('ireland') || /\bie\b/.test(v)) return 'ie';
  if (v.includes('new zealand') || /\bnz\b/.test(v)) return 'nz';
  return 'other';
}

// Meta lead-gen field_data is [{ name, values: [...] }]. Custom questions get
// snake_cased keys; match by substring so form wording tweaks don't break us.
function _fbFieldMap(fieldData) {
  const map = {};
  (Array.isArray(fieldData) ? fieldData : []).forEach((f) => {
    if (!f || !f.name) return;
    const key = String(f.name).toLowerCase();
    const val = Array.isArray(f.values) ? String(f.values[0] == null ? '' : f.values[0]) : '';
    map[key] = val;
  });
  return map;
}

function _pickByKeySubstring(map, substrings) {
  for (const key of Object.keys(map)) {
    if (substrings.some((s) => key.includes(s))) return map[key];
  }
  return '';
}

function normalizeFacebookGpLead(body, allowedFormIds) {
  const allowed = Array.isArray(allowedFormIds) ? allowedFormIds : [];
  if (allowed.length === 0 || !body || typeof body !== 'object') return null;

  let formId = '';
  let leadId = '';
  let name = '';
  let email = '';
  let phone = '';
  let isGpRaw = '';
  let countryRaw = '';
  let question = '';

  const nativeValue = body.entry && body.entry[0] && body.entry[0].changes &&
    body.entry[0].changes[0] && body.entry[0].changes[0].value;

  if (nativeValue && typeof nativeValue === 'object' && nativeValue.field_data) {
    formId = String(nativeValue.form_id || '');
    leadId = String(nativeValue.leadgen_id || '');
    const map = _fbFieldMap(nativeValue.field_data);
    name = _pickByKeySubstring(map, ['full_name']) || '';
    email = map.email || _pickByKeySubstring(map, ['email']) || '';
    phone = _pickByKeySubstring(map, ['phone_number', 'phone']) || '';
    isGpRaw = _pickByKeySubstring(map, ['registered_gp', 'is_gp', 'are_you_a_gp']);
    countryRaw = _pickByKeySubstring(map, ['where_are_you_registered', 'registration_country', 'country']);
    question = _pickByKeySubstring(map, ['question', 'anything']) || '';
  } else {
    // Flat relay shape (Zapier-style): fields at the top level.
    formId = String(body.form_id || '');
    leadId = String(body.lead_id != null ? body.lead_id : (body.id || ''));
    name = String(body.full_name || body.name || '');
    email = String(body.email || '');
    phone = String(body.phone || body.phone_number || '');
    isGpRaw = body.is_gp;
    countryRaw = body.country;
    question = String(body.question || '');
  }

  if (!formId || !allowed.includes(formId)) return null;
  email = email.trim();
  if (!email) return null;
  if (!leadId) {
    leadId = 'sha1:' + crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex');
  }

  return {
    leadId,
    formId,
    name: name.trim().slice(0, 200),
    email: email.slice(0, 200),
    phone: phone.trim().slice(0, 40),
    isGp: parseYesNo(isGpRaw),
    country: parseCountryAnswer(countryRaw),
    question: question.trim().slice(0, 2000),
  };
}

const _EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONSULT_COUNTRY_INPUTS = ['uk', 'ie', 'nz', 'other'];

function validateConsultLeadPayload(body) {
  const raw = body && typeof body === 'object' ? body : {};
  const name = String(raw.name || '').trim().slice(0, 200);
  if (!name) return { ok: false, error: 'name is required.' };
  const email = String(raw.email || '').trim().slice(0, 200);
  if (!email || !_EMAIL_RE.test(email)) return { ok: false, error: 'a valid email is required.' };
  const phone = String(raw.phone || '').trim().slice(0, 40);
  if (typeof raw.isGp !== 'boolean') return { ok: false, error: 'isGp must be true or false.' };
  const country = String(raw.country || '').trim().toLowerCase();
  if (!CONSULT_COUNTRY_INPUTS.includes(country)) {
    return { ok: false, error: 'country must be one of: uk, ie, nz, other.' };
  }
  const question = String(raw.question || '').trim().slice(0, 2000);
  return { ok: true, value: { name, email, phone, isGp: raw.isGp, country, question } };
}

function _sentSet(nudges) {
  const sent = {};
  (Array.isArray(nudges) ? nudges : []).forEach((n) => {
    if (n && n.seq != null && n.step != null) sent[n.seq + ':' + n.step] = true;
  });
  return sent;
}

function nextConsultNudge(input) {
  const consult = (input && input.consult) || {};
  if (consult.stopped || consult.unsubscribed || consult.screened_out) return null;
  if (consult.qualified === false) return null;
  const nowMs = Number(input && input.nowMs);
  const createdAtMs = Number(input && input.createdAtMs);
  if (!isFinite(nowMs) || !isFinite(createdAtMs)) return null;
  const sent = _sentSet(consult.nudges);

  const seq = consult.call_booked ? 'booked_no_signup' : 'not_booked';
  const anchorMs = consult.call_booked
    ? (Date.parse(consult.call_booked_at || '') || createdAtMs)
    : createdAtMs;
  const schedule = CONSULT_NUDGE_SCHEDULE_MS[seq];
  for (let i = 0; i < schedule.length; i++) {
    if (sent[seq + ':' + i]) continue;
    if (nowMs - anchorMs >= schedule[i]) return { seq, step: i };
    return null; // ascending thresholds: first unsent not yet due -> nothing due
  }
  return null;
}

// Plain-text bodies; buildCareerEmailHtml wraps them (it auto-formats
// paragraphs when the body has no HTML tags).
function consultNudgeCopy(seq, step, opts) {
  const displayName = (opts && opts.displayName) || 'there';
  const bookUrl = (opts && opts.bookUrl) || '';
  const signupUrl = (opts && opts.signupUrl) || '';
  if (seq === 'not_booked') {
    if (step === 0) {
      return {
        subject: 'Still want that chat about working in Australia?',
        title: 'Your free call is waiting',
        body: 'Hi ' + displayName + ',\n\nYou started booking a free 30-minute call with GP Link but didn’t pick a time. No pressure at all — the offer stands whenever suits you.\n\nWe’ll answer your questions about registration, visas, timing and pay — honestly, and without any commitment.\n\nIf you’ve already booked, you can ignore this email.',
        ctaText: 'Pick a time',
        ctaUrl: bookUrl,
      };
    }
    return {
      subject: 'Your questions about Australia, answered in 30 minutes',
      title: 'Shall we find you a time?',
      body: 'Hi ' + displayName + ',\n\nJust a final nudge — you asked about working as a GP in Australia and we’d love to walk you through how it actually works: the registration steps, how long it takes, and what life and pay look like on the other side.\n\nOne 30-minute call, no obligation. If now isn’t the right time, that’s completely fine — we won’t keep emailing.',
      ctaText: 'Book your free call',
      ctaUrl: bookUrl,
    };
  }
  if (step === 0) {
    return {
      subject: 'Ready to get started with GP Link?',
      title: 'Your next step takes two minutes',
      body: 'Hi ' + displayName + ',\n\nThanks for booking a call with us. The next step is creating your free GP Link account — it takes about two minutes, and it’s where your whole journey to practising in Australia gets tracked: registration, visa, placement, all of it.\n\nIf we missed each other on the call, no stress — you can grab another time using your booking link, or just reply to this email.',
      ctaText: 'Create my free account',
      ctaUrl: signupUrl,
    };
  }
  return {
    subject: 'Your place in the GP Link app is still open',
    title: 'Whenever you’re ready',
    body: 'Hi ' + displayName + ',\n\nJust one last note from us. Creating your free account is the step that makes things real — you’ll see your personal pathway to practising in Australia, and our team starts working on your behalf.\n\nIf the timing isn’t right, no problem at all — we’ll leave you be. And if we missed each other on the call, you’re always welcome to grab another time.',
    ctaText: 'Create my free account',
    ctaUrl: signupUrl,
  };
}

function consultDisplayName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return 'there';
  const parts = trimmed.split(/\s+/);
  return 'Dr ' + parts[parts.length - 1];
}

module.exports = {
  SUPPORTED_CONSULT_COUNTRIES,
  CONSULT_NUDGE_SCHEDULE_MS,
  screenConsultLead,
  generateConsultToken,
  parseGpFormIds,
  parseYesNo,
  parseCountryAnswer,
  normalizeFacebookGpLead,
  validateConsultLeadPayload,
  nextConsultNudge,
  consultNudgeCopy,
  consultDisplayName,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/consult-lead.test.js`
Expected: PASS (all describes green)

- [ ] **Step 5: Commit**

```bash
git add lib/consult-lead.js tests/consult-lead.test.js
git commit -m "feat(consult): pure logic module for Meta-ads GP consult funnel"
```

---

### Task 2: Storage helpers + public consult-lead endpoints + `/start` route registration

**Files:**
- Modify: `server.js` — (a) require near other lib requires (grep `require('./lib/onboarding-nudge`), (b) helpers next to the site-enquiry block (~19420), (c) endpoints right after the `/api/public/enquiry` handler block (ends ~33627), (d) `SITE_PUBLIC_ROUTES` (~58332), (e) export block (~59445).
- Test: `tests/consult-lead-endpoints.test.js`

**Interfaces:**
- Consumes from Task 1: `validateConsultLeadPayload`, `screenConsultLead`, `generateConsultToken`, `consultDisplayName` via `const consultLead = require('./lib/consult-lead.js');`
- Produces (used by Tasks 3-4):
  - `async updateSiteEnquiryRow(id, patch)` → boolean. PATCH `site_enquiries?id=eq.<id>` in Supabase mode; `Object.assign` on the dbState row locally.
  - `async findConsultLeadByToken(token)` → row | null (kind `gp`, `metadata.consult.token` match).
  - `async findRecentConsultLeadByEmail(email)` → row | null — newest kind-`gp` row ≤30 days old with `metadata.source === 'meta_lead_ad'`, `metadata.consult` present, not screened out; email compared lowercased.
  - `buildConsultLeadRow({ name, email, phone, isGp, country, question, source, utm, ip, userAgent, leadId })` → the row object (shared by the endpoint and Task 3's webhook branch). Sets `kind:'gp'`, `state:` country code, `message:` question, `status:'new'`, and `metadata: { source, ip, user_agent, utm, fb_lead_id, consult: { token, qualified, is_gp, country, screened_out, call_booked:false, nudges: [] } }` (token only when qualified).
  - Routes: `POST /api/public/consult-lead`, `GET /api/public/consult-lead`, `POST /api/public/consult-lead/match`, `POST /api/public/consult-lead/booked`; `'/start': 'pages/site-start.html'` in `SITE_PUBLIC_ROUTES`.

- [ ] **Step 1: Write the failing tests**

Create `tests/consult-lead-endpoints.test.js`. Copy the boot harness verbatim from `tests/site-enquiry.test.js` (dynamic import, `createServer()`, `listen(0)`, `post(path, body)` + add a `get(path)` helper, `readDb()`; `beforeEach` calls `testUtils.__resetSiteEnquiryRateLimitForTest()` and `testUtils.__resetSiteEnquiriesForTest()`). Then:

```js
const goodLead = () => ({
  name: 'Aisha Khan', email: 'aisha@example.co.uk', phone: '+447700900123',
  isGp: true, country: 'uk', question: 'Visa timing?',
  utm: { utm_source: 'facebook', utm_campaign: 'video1' },
});

describe('POST /api/public/consult-lead', () => {
  it('stores a qualified lead and returns a token', async () => {
    const res = await post('/api/public/consult-lead', goodLead());
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.qualified).toBe(true);
    expect(typeof res.json.token).toBe('string');
    const row = readDb().siteEnquiries[0];
    expect(row.kind).toBe('gp');
    expect(row.state).toBe('uk');
    expect(row.message).toBe('Visa timing?');
    expect(row.metadata.source).toBe('site_start_form');
    expect(row.metadata.utm.utm_campaign).toBe('video1');
    expect(row.metadata.consult.token).toBe(res.json.token);
    expect(row.metadata.consult.qualified).toBe(true);
  });
  it('stores a screened-out lead with no token', async () => {
    const res = await post('/api/public/consult-lead', { ...goodLead(), country: 'other' });
    expect(res.json).toMatchObject({ ok: true, qualified: false });
    expect(res.json.token).toBeUndefined();
    const row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.screened_out).toBe(true);
  });
  it('honeypot returns fake success and stores nothing', async () => {
    const res = await post('/api/public/consult-lead', { ...goodLead(), website: 'spam.com' });
    expect(res.json).toEqual({ ok: true, qualified: true });
    expect(readDb().siteEnquiries.length).toBe(0);
  });
  it('rejects invalid payloads with 400', async () => {
    expect((await post('/api/public/consult-lead', { ...goodLead(), email: 'bad' })).status).toBe(400);
    expect((await post('/api/public/consult-lead', { ...goodLead(), isGp: 'yes' })).status).toBe(400);
  });
});

describe('GET /api/public/consult-lead?token=', () => {
  it('returns displayName + email for a valid token; 404 otherwise', async () => {
    const created = await post('/api/public/consult-lead', goodLead());
    const hit = await get('/api/public/consult-lead?token=' + created.json.token);
    expect(hit.status).toBe(200);
    expect(hit.json).toMatchObject({ ok: true, displayName: 'Dr Khan', email: 'aisha@example.co.uk', qualified: true });
    expect((await get('/api/public/consult-lead?token=nope')).status).toBe(404);
  });
});

describe('POST /api/public/consult-lead/match', () => {
  it('finds a recent FB lead by email (case-insensitive) and returns its token', async () => {
    // Seed an FB-webhook-shaped row directly (source meta_lead_ad).
    testUtils.__seedSiteEnquiriesForTest([{
      id: 'e-1', created_at: new Date().toISOString(), kind: 'gp',
      name: 'Aisha Khan', email: 'aisha@example.co.uk', phone: '', status: 'new',
      metadata: { source: 'meta_lead_ad', consult: { token: 'TOK123', qualified: true, call_booked: false, nudges: [] } },
    }]);
    const res = await post('/api/public/consult-lead/match', { email: 'AISHA@example.co.uk' });
    expect(res.json).toMatchObject({ ok: true, found: true, displayName: 'Dr Khan', token: 'TOK123' });
  });
  it('does not match site-form leads, old leads, or unknown emails', async () => {
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    testUtils.__seedSiteEnquiriesForTest([
      { id: 'e-2', created_at: new Date().toISOString(), kind: 'gp', name: 'A', email: 'site@x.co', status: 'new', metadata: { source: 'site_start_form', consult: { token: 'T2', qualified: true, nudges: [] } } },
      { id: 'e-3', created_at: old, kind: 'gp', name: 'B', email: 'old@x.co', status: 'new', metadata: { source: 'meta_lead_ad', consult: { token: 'T3', qualified: true, nudges: [] } } },
    ]);
    expect((await post('/api/public/consult-lead/match', { email: 'site@x.co' })).json.found).toBe(false);
    expect((await post('/api/public/consult-lead/match', { email: 'old@x.co' })).json.found).toBe(false);
    expect((await post('/api/public/consult-lead/match', { email: 'none@x.co' })).json.found).toBe(false);
  });
});

describe('POST /api/public/consult-lead/booked', () => {
  it('flips call_booked and status to contacted', async () => {
    const created = await post('/api/public/consult-lead', goodLead());
    const res = await post('/api/public/consult-lead/booked', { token: created.json.token });
    expect(res.json.ok).toBe(true);
    const row = readDb().siteEnquiries[0];
    expect(row.status).toBe('contacted');
    expect(row.metadata.consult.call_booked).toBe(true);
    expect(typeof row.metadata.consult.call_booked_at).toBe('string');
  });
  it('404s on unknown token', async () => {
    expect((await post('/api/public/consult-lead/booked', { token: 'nope' })).status).toBe(404);
  });
});

describe('GET /start', () => {
  it('serves the landing page shell', async () => {
    const res = await get('/start');
    expect(res.status).toBe(200); // page file lands in Task 5; a 404 here means route not registered
  });
});
```

Note: until Task 5 creates `pages/site-start.html`, the `GET /start` test asserts route registration; if `serveStatic` 404s on the missing file, mark that single test `it.skip` with a `// un-skip in Task 5` comment rather than weakening the others.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/consult-lead-endpoints.test.js`
Expected: FAIL — 404s from unknown routes.

- [ ] **Step 3: Implement in server.js**

(a) Next to the other lib requires (grep `require('./lib/onboarding-nudge.js')` and add below it):

```js
var consultLead = require('./lib/consult-lead.js');
const CONSULT_START_BASE = (process.env.SITE_PUBLIC_BASE_URL || 'https://mygplink.com.au');
```

(b) After `__seedSiteEnquiriesForTest` (~19402), add the helpers:

```js
// ── Consult-lead helpers (Meta-ads GP funnel) ──────────────────────────────
// Funnel state lives in site_enquiries.metadata.consult (jsonb) — no migration.
async function updateSiteEnquiryRow(id, patch) {
  if (isSupabaseDbConfigured()) {
    const r = await supabaseDbRequest('site_enquiries', 'id=eq.' + encodeURIComponent(id), {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: patch
    });
    return !!r.ok;
  }
  const rows = Array.isArray(dbState.siteEnquiries) ? dbState.siteEnquiries : [];
  const row = rows.find((r) => String(r.id) === String(id));
  if (!row) return false;
  Object.assign(row, patch);
  saveDbState();
  return true;
}

function _consultRowHasToken(row, token) {
  return !!(row && row.kind === 'gp' && row.metadata && row.metadata.consult &&
    row.metadata.consult.token && row.metadata.consult.token === token);
}

async function findConsultLeadByToken(token) {
  const tok = String(token || '').trim();
  if (!tok || tok.length < 20) return null;
  if (isSupabaseDbConfigured()) {
    const r = await supabaseDbRequest('site_enquiries',
      'select=*&kind=eq.gp&metadata->consult->>token=eq.' + encodeURIComponent(tok) + '&limit=1',
      { method: 'GET' });
    return r.ok && Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
  }
  const rows = Array.isArray(dbState.siteEnquiries) ? dbState.siteEnquiries : [];
  return rows.find((row) => _consultRowHasToken(row, tok)) || null;
}

const CONSULT_MATCH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
async function findRecentConsultLeadByEmail(email) {
  const addr = String(email || '').trim().toLowerCase();
  if (!addr) return null;
  const cutoffIso = new Date(Date.now() - CONSULT_MATCH_WINDOW_MS).toISOString();
  let rows = [];
  if (isSupabaseDbConfigured()) {
    const r = await supabaseDbRequest('site_enquiries',
      'select=*&kind=eq.gp&email=ilike.' + encodeURIComponent(addr) +
      '&created_at=gte.' + encodeURIComponent(cutoffIso) + '&order=created_at.desc&limit=10',
      { method: 'GET' });
    rows = r.ok && Array.isArray(r.data) ? r.data : [];
  } else {
    rows = (Array.isArray(dbState.siteEnquiries) ? dbState.siteEnquiries : [])
      .filter((row) => row.kind === 'gp' && String(row.email || '').toLowerCase() === addr &&
        new Date(row.created_at).getTime() >= Date.now() - CONSULT_MATCH_WINDOW_MS)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
  return rows.find((row) =>
    String(row.email || '').toLowerCase() === addr &&
    row.metadata && row.metadata.source === 'meta_lead_ad' &&
    row.metadata.consult && row.metadata.consult.token &&
    row.metadata.consult.qualified === true &&
    !row.metadata.consult.screened_out) || null;
}

function _capUtm(utm) {
  const out = {};
  if (utm && typeof utm === 'object') {
    for (const key of Object.keys(utm)) {
      if (!/^utm_[a-z_]{1,30}$/.test(key)) continue;
      out[key] = String(utm[key] == null ? '' : utm[key]).slice(0, 200);
      if (Object.keys(out).length >= 8) break;
    }
  }
  return out;
}

function buildConsultLeadRow(input) {
  const qualified = consultLead.screenConsultLead({ isGp: input.isGp, country: input.country });
  const consult = {
    qualified,
    is_gp: input.isGp === true,
    country: input.country || 'other',
    call_booked: false,
    nudges: []
  };
  if (qualified) consult.token = consultLead.generateConsultToken();
  else consult.screened_out = true;
  return {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    kind: 'gp',
    name: input.name,
    email: input.email,
    phone: input.phone || null,
    practice_name: null,
    state: input.country || null,
    message: input.question || null,
    status: 'new',
    metadata: {
      source: input.source,
      ip: input.ip || null,
      user_agent: String(input.userAgent || '').slice(0, 300),
      utm: _capUtm(input.utm),
      fb_lead_id: input.leadId || null,
      consult
    }
  };
}
```

(c) Immediately after the closing `}` of the `/api/public/enquiry` block (~33627), add the four routes. Follow the enquiry block's exact idioms (readJsonBody → honeypot → validate → rate limit → store → record hit → notify):

```js
  // ── Meta-ads GP consult funnel (public, no session) ──────────────────────
  if (pathname === '/api/public/consult-lead' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, error: 'Invalid JSON body.' }); return; }
    if (isSiteEnquiryHoneypotFilled(body)) { sendJson(res, 200, { ok: true, qualified: true }); return; }
    const validated = consultLead.validateConsultLeadPayload(body);
    if (!validated.ok) { sendJson(res, 400, { ok: false, error: validated.error }); return; }
    const ip = getClientIp(req);
    if (!checkSiteEnquiryRateLimit(ip)) { sendJson(res, 429, { ok: false, error: 'Too many requests from this address. Please try again later.' }); return; }
    const row = buildConsultLeadRow(Object.assign({}, validated.value, {
      source: 'site_start_form', utm: body.utm, ip, userAgent: req.headers['user-agent']
    }));
    const stored = await insertSiteEnquiryRow(row);
    if (!stored) { sendJson(res, 500, { ok: false, error: 'Failed to store enquiry.' }); return; }
    recordSiteEnquiryRateLimitHit(ip);
    await maybeNotifySiteEnquiry(row);
    const out = { ok: true, qualified: row.metadata.consult.qualified };
    if (row.metadata.consult.token) out.token = row.metadata.consult.token;
    sendJson(res, 200, out);
    return;
  }

  if (pathname === '/api/public/consult-lead' && req.method === 'GET') {
    const tok = String(url.searchParams.get('token') || '').trim();
    const row = tok ? await findConsultLeadByToken(tok) : null;
    if (!row || row.metadata.consult.qualified !== true) { sendJson(res, 404, { ok: false }); return; }
    sendJson(res, 200, { ok: true, displayName: consultLead.consultDisplayName(row.name), email: row.email, qualified: true });
    return;
  }

  if (pathname === '/api/public/consult-lead/match' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, error: 'Invalid JSON body.' }); return; }
    const ip = getClientIp(req);
    const allowed = await checkRateLimitWindow('consult_match:' + ip, 10, 60 * 60 * 1000);
    if (!allowed) { sendJson(res, 429, { ok: false, error: 'Too many attempts. Please try again later.' }); return; }
    const row = await findRecentConsultLeadByEmail(body && body.email);
    if (!row) { sendJson(res, 200, { ok: true, found: false }); return; }
    // Privacy: display name + token only — never phone or answers.
    sendJson(res, 200, { ok: true, found: true, displayName: consultLead.consultDisplayName(row.name), token: row.metadata.consult.token });
    return;
  }

  if (pathname === '/api/public/consult-lead/booked' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, error: 'Invalid JSON body.' }); return; }
    const row = await findConsultLeadByToken(body && body.token);
    if (!row) { sendJson(res, 404, { ok: false }); return; }
    const metadata = Object.assign({}, row.metadata);
    metadata.consult = Object.assign({}, metadata.consult, {
      call_booked: true,
      call_booked_at: metadata.consult.call_booked_at || new Date().toISOString()
    });
    await updateSiteEnquiryRow(row.id, { status: 'contacted', metadata });
    sendJson(res, 200, { ok: true });
    return;
  }
```

(d) In `SITE_PUBLIC_ROUTES` (~58332) add:

```js
  '/start': 'pages/site-start.html',
```

(e) In the export block that already lists `insertSiteEnquiryRow, listSiteEnquiryRows` (~59445), add:

```js
  updateSiteEnquiryRow,
  findConsultLeadByToken,
  findRecentConsultLeadByEmail,
  buildConsultLeadRow,
```

- [ ] **Step 4: Syntax check + run tests**

Run: `node --check server.js && npx vitest run tests/consult-lead-endpoints.test.js tests/site-enquiry.test.js`
Expected: PASS (consult tests green; existing site-enquiry suite untouched and green).

- [ ] **Step 5: Commit**

```bash
git add server.js tests/consult-lead-endpoints.test.js
git commit -m "feat(consult): public consult-lead endpoints, storage helpers, /start route"
```

---

### Task 3: Facebook webhook GP branch + magic-link email + owner alert

**Files:**
- Modify: `server.js` — inside `handleFacebookLeadWebhook` (after `readJsonBody` at ~10064-10076, BEFORE `practicePipeline.normalizeFacebookLeadPayload`), plus a new `sendConsultMagicLinkEmail` helper next to `buildConsultLeadRow`.
- Test: `tests/fb-gp-lead-webhook.test.js`

**Interfaces:**
- Consumes: `consultLead.parseGpFormIds`, `consultLead.normalizeFacebookGpLead` (Task 1); `buildConsultLeadRow`, `insertSiteEnquiryRow`, `maybeNotifySiteEnquiry` (Task 2); existing `checkAndRecordWebhookEvent`, `sendEmail`, `buildCareerEmailHtml`, `GP_OWNER_EMAIL`, `CONSULT_START_BASE`.
- Produces: webhook responses `{ ok: true, kind: 'gp_lead', lead_id }` (and `{ ok: true, action: 'duplicate_ignored' }` for dupes); `sendConsultMagicLinkEmail(row)` (also used nowhere else — keep private, no export needed).

- [ ] **Step 1: Write the failing tests**

Create `tests/fb-gp-lead-webhook.test.js`. Boot harness as in Task 2's test (copy from `tests/site-enquiry.test.js`). Set env in the test file BEFORE importing the server:

```js
process.env.FB_LEAD_WEBHOOK_SECRET = 'test-fb-secret';
process.env.FB_GP_LEAD_FORM_IDS = 'F-77, F-88';
```

Reuse the `nativeFbBody()` fixture from `tests/consult-lead.test.js` (copy it in — implementers may read tasks out of order). Tests:

```js
const WH = '/api/webhooks/facebook-lead?secret=test-fb-secret';

describe('facebook-lead webhook — GP form branch', () => {
  it('routes an allow-listed GP form to site_enquiries (not practices)', async () => {
    const res = await post(WH, nativeFbBody());
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, kind: 'gp_lead' });
    const db = readDb();
    expect((db.siteEnquiries || []).length).toBe(1);
    const row = db.siteEnquiries[0];
    expect(row.kind).toBe('gp');
    expect(row.metadata.source).toBe('meta_lead_ad');
    expect(row.metadata.fb_lead_id).toBe('L-1001');
    expect(row.metadata.consult.qualified).toBe(true);
    expect(typeof row.metadata.consult.token).toBe('string');
    expect((db.atsPractices || []).length).toBe(0);
  });
  it('screens out a non-GP answer but still stores the lead', async () => {
    const body = nativeFbBody();
    body.entry[0].changes[0].value.field_data = body.entry[0].changes[0].value.field_data
      .map((f) => f.name.includes('registered_gp') ? { ...f, values: ['No'] } : f);
    body.entry[0].changes[0].value.leadgen_id = 'L-1002';
    const res = await post(WH, body);
    expect(res.json.kind).toBe('gp_lead');
    const row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.qualified).toBe(false);
    expect(row.metadata.consult.screened_out).toBe(true);
  });
  it('a form NOT in the allow-list falls through to the practice path', async () => {
    const body = nativeFbBody();
    body.entry[0].changes[0].value.form_id = 'F-UNKNOWN';
    // practice normalizer requires practice_name or contact_email — email is present, so it creates a practice
    const res = await post(WH, body);
    expect(res.status).toBe(200);
    expect(res.json.kind).toBeUndefined();
    expect((readDb().siteEnquiries || []).length).toBe(0);
  });
  it('rejects a wrong secret with 401', async () => {
    const res = await post('/api/webhooks/facebook-lead?secret=wrong', nativeFbBody());
    expect(res.status).toBe(401);
  });
});
```

Note on duplicates: `checkAndRecordWebhookEvent` is Supabase-backed and returns `false` in local-JSON mode (no `webhook_events` table locally) — check its body first; if it short-circuits without Supabase, do NOT write a duplicate test (document that in a comment instead).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/fb-gp-lead-webhook.test.js`
Expected: FAIL — GP body currently creates a practice row / response has no `kind: 'gp_lead'`.

- [ ] **Step 3: Implement the GP branch**

In `handleFacebookLeadWebhook`, right after the `normalizeFacebookLeadPayload` guard's *body parse* (i.e., after `body = await readJsonBody(req)` succeeds, ~10072) and BEFORE `const lead = practicePipeline.normalizeFacebookLeadPayload(body);`, insert:

```js
  // GP lead-gen forms (Meta-ads GP funnel): allow-listed form IDs route to
  // site_enquiries as consult leads instead of the practice pipeline.
  const gpFormIds = consultLead.parseGpFormIds(process.env.FB_GP_LEAD_FORM_IDS);
  const gpLead = gpFormIds.length ? consultLead.normalizeFacebookGpLead(body, gpFormIds) : null;
  if (gpLead) {
    const gpDup = await checkAndRecordWebhookEvent('facebook_lead', gpLead.leadId, 'gp_lead', {
      event: 'gp_lead', created_at: new Date().toISOString()
    });
    if (gpDup) { sendJson(res, 200, { ok: true, action: 'duplicate_ignored' }); return; }
    const gpRow = buildConsultLeadRow({
      name: gpLead.name || gpLead.email, email: gpLead.email, phone: gpLead.phone,
      isGp: gpLead.isGp === true, country: gpLead.country, question: gpLead.question,
      source: 'meta_lead_ad', leadId: gpLead.leadId, ip: getClientIp(req),
      userAgent: req.headers['user-agent']
    });
    const gpStored = await insertSiteEnquiryRow(gpRow);
    if (!gpStored) { sendJson(res, 500, { ok: false, error: 'store_failed' }); return; }
    // Speed-to-lead: owner alert (uses SITE_ENQUIRY_NOTIFY_EMAIL; no-op if unset)
    await maybeNotifySiteEnquiry(gpRow);
    // Magic link so they can book with zero re-typing (qualified leads only)
    if (gpRow.metadata.consult.qualified) {
      try { await sendConsultMagicLinkEmail(gpRow); }
      catch (e) { console.error('[fb-gp-lead] magic-link email failed:', e.message); }
    }
    sendJson(res, 200, { ok: true, kind: 'gp_lead', lead_id: gpRow.id });
    return;
  }
```

Add the email helper next to `buildConsultLeadRow`:

```js
async function sendConsultMagicLinkEmail(row) {
  const consult = row.metadata && row.metadata.consult;
  if (!consult || !consult.token) return { ok: false, error: 'no token' };
  const displayName = consultLead.consultDisplayName(row.name);
  const bookUrl = CONSULT_START_BASE + '/start?lead=' + encodeURIComponent(consult.token) + '#book';
  const body = 'Hi ' + displayName + ',\n\n' +
    'Thanks for reaching out about working as a GP in Australia. The next step is a free 30-minute call — we’ll answer your questions about registration, visas, timing and pay, with no obligation.\n\n' +
    'Your details are already saved, so booking takes about 20 seconds. Just pick a time that suits you.';
  return sendEmail({
    to: row.email,
    subject: 'Ready when you are — book your free GP Link call',
    html: buildCareerEmailHtml({
      title: 'Your free call is ready to book',
      body,
      ctaText: 'Pick a time',
      ctaUrl: bookUrl,
      footer: 'Questions in the meantime? Just reply to this email.'
    }),
    text: body + '\n\nBook here: ' + bookUrl,
    from: { email: GP_OWNER_EMAIL, name: 'GP Link' }
  });
}
```

- [ ] **Step 4: Syntax check + run tests (including the existing practice-webhook suite)**

Run: `node --check server.js && npx vitest run tests/fb-gp-lead-webhook.test.js && npx vitest run tests/ -t facebook 2>/dev/null || npx vitest run tests/`
Expected: new suite PASS; grep test output to confirm no previously-passing facebook/practice webhook test regressed. (If a dedicated practice-webhook test file exists, run it explicitly.)

- [ ] **Step 5: Commit**

```bash
git add server.js tests/fb-gp-lead-webhook.test.js
git commit -m "feat(consult): FB webhook GP-form branch — lead row, owner alert, magic-link email"
```

---

### Task 4: Consult-nudge cron + schedule registration

**Files:**
- Modify: `server.js` — cron endpoint next to `/api/cron/onboarding-nudge` (~30431), `CRON_SCHEDULES` (~7356), plus `sendConsultNudgeEmail` helper next to `sendConsultMagicLinkEmail`.
- Modify: `vercel.json` — add to `crons` array.
- Test: `tests/consult-nudge-cron.test.js`

**Interfaces:**
- Consumes: `consultLead.nextConsultNudge`, `consultLead.consultNudgeCopy`, `consultLead.consultDisplayName` (Task 1); `listSiteEnquiryRows`, `updateSiteEnquiryRow` (Task 2); existing `sendEmail`, `buildCareerEmailHtml`, `buildMarketingUnsubUrl`, `getSupabaseUserIdByEmail`, `CRON_SECRET` gate pattern (copy from onboarding-nudge at 30431-30434), 45s time-box pattern (30436-30456).
- Produces: `GET /api/cron/consult-nudge` returning `{ ok: true, scanned, sent, stopped, skipped, partial }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/consult-nudge-cron.test.js` (same boot harness; set `process.env.CRON_SECRET = 'test-cron-secret'` before import; `get(path, headers)` helper that passes an `Authorization` header):

```js
const CRON = '/api/cron/consult-nudge';
const AUTH = { Authorization: 'Bearer test-cron-secret' };
const H = 3600 * 1000;

function seedLead(overrides = {}) {
  const created = overrides.created_at || new Date(Date.now() - 3 * H).toISOString();
  return Object.assign({
    id: 'lead-1', created_at: created, kind: 'gp', name: 'Aisha Khan',
    email: 'aisha@example.co.uk', status: 'new',
    metadata: { source: 'meta_lead_ad', consult: { token: 'TOK1', qualified: true, is_gp: true, country: 'uk', call_booked: false, nudges: [] } },
  }, overrides);
}

describe('GET /api/cron/consult-nudge', () => {
  it('401s without the secret', async () => {
    expect((await get(CRON)).status).toBe(401);
    expect((await get(CRON, { Authorization: 'Bearer wrong' })).status).toBe(401);
  });
  it('records a due not-booked nudge on the lead (send skipped when email unconfigured)', async () => {
    testUtils.__seedSiteEnquiriesForTest([seedLead()]);
    const res = await get(CRON, AUTH);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.scanned).toBe(1);
    // Email is unconfigured in tests (no RESEND_API_KEY): send fails → nudge NOT recorded, no crash.
    const row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.nudges.length).toBe(0);
  });
  it('skips screened-out, unqualified, and not-yet-due leads', async () => {
    testUtils.__seedSiteEnquiriesForTest([
      seedLead({ id: 'l1', metadata: { source: 'meta_lead_ad', consult: { qualified: false, screened_out: true, nudges: [] } } }),
      seedLead({ id: 'l2', created_at: new Date().toISOString() }), // 0 min old — not due
    ]);
    const res = await get(CRON, AUTH);
    expect(res.json.sent).toBe(0);
  });
  it('marks a signed-up lead converted and stops nudging', async () => {
    // Local mode: dbState.users is keyed by lowercased email — testUtils has a seeding helper;
    // grep __testUtils for an existing user-seeding helper (e.g. used by other cron tests).
    // If none exists, write the user directly into data/app-db.json via readDb/writeDb in the test.
    seedLocalUser('aisha@example.co.uk');
    testUtils.__seedSiteEnquiriesForTest([seedLead()]);
    const res = await get(CRON, AUTH);
    expect(res.json.stopped).toBe(1);
    const row = readDb().siteEnquiries[0];
    expect(row.status).toBe('converted');
    expect(row.metadata.consult.stopped).toBe('signed_up');
  });
});
```

(`seedLocalUser` — small helper in the test file that reads `data/app-db.json`, sets `users['aisha@example.co.uk'] = { email: 'aisha@example.co.uk' }`, writes it back. Check first whether `__testUtils` already exposes a user seeder; use it if so.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/consult-nudge-cron.test.js`
Expected: FAIL — 404 on the cron route.

- [ ] **Step 3: Implement**

(a) `CRON_SCHEDULES` (~7356), add:

```js
  'consult-nudge': { schedule: '20 * * * *', cadenceMinutes: 60 },
```

(b) `vercel.json` crons array, add (offset :20 to avoid stacking with the :00 crons):

```json
    { "path": "/api/cron/consult-nudge", "schedule": "20 * * * *" },
```

(c) Email helper next to `sendConsultMagicLinkEmail`:

```js
async function sendConsultNudgeEmail(row, due) {
  const consult = row.metadata.consult;
  const displayName = consultLead.consultDisplayName(row.name);
  const bookUrl = consult.token
    ? CONSULT_START_BASE + '/start?lead=' + encodeURIComponent(consult.token) + '#book'
    : CONSULT_START_BASE + '/start#book';
  const signupUrl = CONSULT_START_BASE + '/pages/signin?signup=1&email=' + encodeURIComponent(row.email);
  const copy = consultLead.consultNudgeCopy(due.seq, due.step, { displayName, bookUrl, signupUrl });
  const unsubUrl = buildMarketingUnsubUrl(row.email);
  return sendEmail({
    to: row.email,
    subject: copy.subject,
    html: buildCareerEmailHtml({
      title: copy.title,
      body: copy.body,
      ctaText: copy.ctaText,
      ctaUrl: copy.ctaUrl,
      footer: '<a href="' + unsubUrl + '" style="color:#8a94a6;font-size:11px;text-decoration:underline">Unsubscribe from these emails</a>'
    }),
    text: copy.body + '\n\n' + copy.ctaText + ': ' + copy.ctaUrl + '\n\nUnsubscribe: ' + unsubUrl,
    category: 'marketing',
    from: { email: GP_OWNER_EMAIL, name: 'GP Link' }
  });
}
```

(Verify `buildMarketingUnsubUrl(email)` exists and takes a recipient email — grep it; it's used inside `sendEmail`'s marketing branch ~25010. `category: 'marketing'` gives automatic suppression checks and List-Unsubscribe headers.)

(d) Cron endpoint — place directly after the onboarding-nudge cron block (~30530), copying its gate + time-box:

```js
  if (req.method === 'GET' && pathname === '/api/cron/consult-nudge') {
    var cnSecret = String(process.env.CRON_SECRET || '').trim();
    var cnAuth = req.headers['authorization'] || '';
    if (!cnSecret || cnAuth !== 'Bearer ' + cnSecret) { sendJson(res, 401, { ok: false, error: 'Unauthorized' }); return; }
    var cnStart = Date.now();
    var CN_TIME_BUDGET_MS = 45000;
    var cnScanned = 0, cnSent = 0, cnStopped = 0, cnSkipped = 0, cnPartial = false;
    try {
      var cnRows = await listSiteEnquiryRows();
      for (var cnRow of cnRows) {
        if (Date.now() - cnStart > CN_TIME_BUDGET_MS) { cnPartial = true; break; }
        var cnMeta = cnRow && cnRow.metadata;
        if (!cnMeta || cnRow.kind !== 'gp' || !cnMeta.consult) continue;
        var cnConsult = cnMeta.consult;
        cnScanned++;
        if (cnConsult.stopped || cnConsult.screened_out || cnConsult.qualified !== true) { cnSkipped++; continue; }
        // Signed up? → converted, stop forever.
        var cnUserExists = false;
        if (isSupabaseDbConfigured()) {
          cnUserExists = !!(await getSupabaseUserIdByEmail(cnRow.email));
        } else {
          cnUserExists = !!(dbState.users && dbState.users[String(cnRow.email || '').toLowerCase()]);
        }
        if (cnUserExists) {
          var cnMetaConv = Object.assign({}, cnMeta, { consult: Object.assign({}, cnConsult, { stopped: 'signed_up' }) });
          await updateSiteEnquiryRow(cnRow.id, { status: 'converted', metadata: cnMetaConv });
          cnStopped++;
          continue;
        }
        var cnDue = consultLead.nextConsultNudge({
          consult: cnConsult,
          createdAtMs: new Date(cnRow.created_at).getTime(),
          nowMs: Date.now()
        });
        if (!cnDue) { cnSkipped++; continue; }
        var cnSendRes = await sendConsultNudgeEmail(cnRow, cnDue);
        if (cnSendRes && cnSendRes.suppressed) {
          var cnMetaUnsub = Object.assign({}, cnMeta, { consult: Object.assign({}, cnConsult, { stopped: 'unsubscribed' }) });
          await updateSiteEnquiryRow(cnRow.id, { metadata: cnMetaUnsub });
          cnStopped++;
          continue;
        }
        if (cnSendRes && cnSendRes.ok) {
          var cnNudges = (Array.isArray(cnConsult.nudges) ? cnConsult.nudges : []).concat([
            { seq: cnDue.seq, step: cnDue.step, sent_at: new Date().toISOString() }
          ]);
          var cnMetaSent = Object.assign({}, cnMeta, { consult: Object.assign({}, cnConsult, { nudges: cnNudges }) });
          await updateSiteEnquiryRow(cnRow.id, { metadata: cnMetaSent });
          cnSent++;
        } else {
          cnSkipped++; // send failed (e.g. email unconfigured) — try again next hour
        }
      }
      sendJson(res, 200, { ok: true, scanned: cnScanned, sent: cnSent, stopped: cnStopped, skipped: cnSkipped, partial: cnPartial });
    } catch (e) {
      console.error('[ConsultNudge] cron failed:', e.message);
      sendJson(res, 500, { ok: false, error: 'Internal error' });
    }
    return;
  }
```

- [ ] **Step 4: Syntax check + run tests**

Run: `node --check server.js && npx vitest run tests/consult-nudge-cron.test.js tests/onboarding-nudge-cron.test.js`
Expected: PASS (new suite green; onboarding cron suite unaffected).

- [ ] **Step 5: Commit**

```bash
git add server.js vercel.json tests/consult-nudge-cron.test.js
git commit -m "feat(consult): hourly consult-nudge cron — not-booked + booked-no-signup sequences"
```

---

### Task 5: Landing page `pages/site-start.html`

**Files:**
- Create: `pages/site-start.html`
- Modify: `tests/consult-lead-endpoints.test.js` — un-skip the `GET /start` test if it was skipped in Task 2.

**Interfaces:**
- Consumes: `POST/GET /api/public/consult-lead`, `POST /api/public/consult-lead/match`, `POST /api/public/consult-lead/booked` (Task 2 response shapes, exactly as specified there); Calendly inline widget (`https://assets.calendly.com/assets/external/widget.js`, event `calendly.event_scheduled` via postMessage); `/css/site.css?v=20260703`, `/js/site.js?v=20260703`.
- Produces: the `/start` page with `#book` anchor; recognised-lead collapsed flow; stranger form with screening; turn-down + leave-email; UTM capture.

Design notes (bind the implementer): marketing design system ONLY (`site.css` tokens/classes — `.container`, `.reveal`, `.btn primary|ghost|white`, `.sec-eyebrow`, `.sec-title`, `.sec-sub`, header/footer cloned from `site-home.html` lines 238-257 / 480-490 with the footer's own "Book a call" pointing at `#book`). Page-local `<style>` for the doors/form/embed. Mobile-first. No app scripts. Invoke the frontend-design skill when building this page if available to the implementer, but the structure below is the contract.

- [ ] **Step 1: Build the page skeleton + static sections**

Create `pages/site-start.html` with (in order):
1. Standard site head (`<title>Start your journey — GP Link</title>`, meta description, `site.css` link) + the cloned header nav.
2. **Hero** (`section.start-hero`): eyebrow "For UK, Irish & NZ GPs", H1 "Your medicine. Australia's lifestyle. We handle the in-between.", sub-line "GP Link walks you from where you are now to practising in an Australian clinic — registration, visa, placement — at no cost to you.", CTA row: `.btn primary` "Create my free account →" href `/pages/signin?signup=1` (id `doorSignupTop`), `.btn ghost` "Have questions? Book a free 30-min call" href `#book`.
3. **How it works** — three `.reveal` cards: "1 · Free account or free call — start whichever way suits", "2 · We run your registration, visa and paperwork", "3 · You choose your practice and start work".
4. **Trust strip** — reuse the stats pattern from `site-home.html` (static numbers consistent with the site: 240+ doctors helped, 230+ clinics, 22 yrs experience).
5. **The two doors** (`section#doors`) — two equal cards: Door 1 signup (btn primary → `/pages/signin?signup=1`), Door 2 "Book a free call" (btn ghost → `#book`).
6. **Booking section** (`section#book`) — see Step 2.
7. Cloned footer (Contact column's Calendly link replaced with `<a href="#book">Book a call</a>`) + `<script src="/js/site.js?v=20260703"></script>` + the page script block.

- [ ] **Step 2: Build the booking section — four visible states, one at a time**

Markup (inside `section#book`, all states as sibling `<div>`s toggled by JS, only one visible):

```html
<div id="bookRecognised" class="book-state" hidden>
  <h3 id="recogHeading">Welcome back</h3>
  <p>Your details are already saved. Anything you'd like us to cover on the call?</p>
  <textarea id="recogQuestion" maxlength="2000" placeholder="Optional — e.g. visa timing, pay, bringing family…"></textarea>
  <button class="btn primary" id="recogContinue">Choose a time →</button>
</div>

<div id="bookEmailMatch" class="book-state" hidden>
  <h3>Quick one — what's your email?</h3>
  <p>So we can match the details you gave us on Facebook.</p>
  <input id="matchEmail" type="email" autocomplete="email" placeholder="you@example.com">
  <button class="btn primary" id="matchBtn">Continue →</button>
  <p class="book-err" id="matchErr" hidden></p>
</div>

<div id="bookForm" class="book-state" hidden>
  <h3>Book your free 30-minute call</h3>
  <p>Tell us a little about you — takes 30 seconds.</p>
  <form id="consultForm" novalidate>
    <input id="cfName" type="text" autocomplete="name" maxlength="200" placeholder="Full name" required>
    <input id="cfEmail" type="email" autocomplete="email" maxlength="200" placeholder="Email" required>
    <input id="cfPhone" type="tel" autocomplete="tel" maxlength="40" placeholder="Phone (with country code)">
    <label>Are you a currently registered GP?</label>
    <select id="cfIsGp"><option value="">Choose…</option><option value="yes">Yes</option><option value="no">No</option></select>
    <label>Where are you registered?</label>
    <select id="cfCountry"><option value="">Choose…</option><option value="uk">United Kingdom</option><option value="ie">Ireland</option><option value="nz">New Zealand</option><option value="other">Somewhere else</option></select>
    <textarea id="cfQuestion" maxlength="2000" placeholder="Optional — what's your main question?"></textarea>
    <input id="cfWebsite" name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px">
    <button class="btn primary" type="submit">Continue to booking →</button>
    <p class="book-err" id="cfErr" hidden></p>
    <p class="book-consent">We'll only contact you about your enquiry. <a href="/pages/privacy" target="_blank" rel="noopener">Privacy policy</a>.</p>
  </form>
</div>

<div id="bookTurndown" class="book-state" hidden>
  <h3>We're sorry — we can't take this one on</h3>
  <p>Right now GP Link works with general practitioners registered in the <b>UK, Ireland or New Zealand</b>. If that changes, we'd love to let you know.</p>
  <div class="turndown-row">
    <input id="tdEmail" type="email" placeholder="Your email (optional)">
    <button class="btn ghost" id="tdSave">Keep me posted</button>
  </div>
  <p id="tdThanks" hidden>Done — we'll be in touch if things change.</p>
</div>

<div id="bookCalendly" class="book-state" hidden>
  <p class="book-kicker" id="calGreeting"></p>
  <div id="calendlyEmbed" style="min-width:320px;height:760px"></div>
</div>

<div id="bookConfirmed" class="book-state" hidden>
  <h3>You're booked — talk soon 🎉</h3>
  <p>A calendar invite is on its way to your inbox. In the meantime, why not set up your free account so we can hit the ground running?</p>
  <a class="btn primary" id="confirmedSignup" href="/pages/signin?signup=1">Create my free account →</a>
</div>
```

- [ ] **Step 3: Write the page script (full logic, verbatim contract)**

In the page's closing `<script>` block (plain ES5-friendly JS like the other site pages):

```js
(function () {
  var CAL_BASE = 'https://calendly.com/hello-mygplink/30min';
  var params = new URLSearchParams(window.location.search);
  var lead = { token: null, name: '', email: '' };

  var utm = {};
  params.forEach(function (v, k) { if (/^utm_/.test(k)) utm[k] = v; });

  function show(id) {
    ['bookRecognised', 'bookEmailMatch', 'bookForm', 'bookTurndown', 'bookCalendly', 'bookConfirmed']
      .forEach(function (s) { document.getElementById(s).hidden = (s !== id); });
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); });
  }

  function loadCalendly(displayName) {
    document.getElementById('calGreeting').textContent = displayName
      ? displayName + ', pick a time that suits you — your details are pre-filled.'
      : 'Pick a time that suits you.';
    show('bookCalendly');
    var mount = function () {
      window.Calendly.initInlineWidget({
        url: CAL_BASE + '?hide_gdpr_banner=1',
        parentElement: document.getElementById('calendlyEmbed'),
        prefill: { name: lead.name || '', email: lead.email || '' }
      });
    };
    if (window.Calendly) { mount(); return; }
    var s = document.createElement('script');
    s.src = 'https://assets.calendly.com/assets/external/widget.js';
    s.async = true; s.onload = mount;
    document.head.appendChild(s);
  }

  // Booked signal: Calendly inline widget posts calendly.event_scheduled
  window.addEventListener('message', function (e) {
    if (e.origin !== 'https://calendly.com') return;
    if (!e.data || e.data.event !== 'calendly.event_scheduled') return;
    if (lead.token) { post('/api/public/consult-lead/booked', { token: lead.token }); }
    var su = document.getElementById('confirmedSignup');
    if (lead.email) su.href = '/pages/signin?signup=1&email=' + encodeURIComponent(lead.email);
    show('bookConfirmed');
  });

  function enterRecognised(displayName) {
    document.getElementById('recogHeading').textContent = 'Welcome back, ' + displayName + '.';
    show('bookRecognised');
    document.getElementById('recogContinue').onclick = function () {
      loadCalendly(displayName); // the optional question stays client-side; the lead row already exists
    };
    // Door 1 also gets the email prefill for recognised leads
    if (lead.email) {
      document.querySelectorAll('a[href="/pages/signin?signup=1"]').forEach(function (a) {
        a.href = '/pages/signin?signup=1&email=' + encodeURIComponent(lead.email);
      });
    }
  }

  // Entry routing
  var tokenParam = params.get('lead');
  if (tokenParam) {
    fetch('/api/public/consult-lead?token=' + encodeURIComponent(tokenParam))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.ok) { lead.token = tokenParam; lead.name = j.displayName; lead.email = j.email; enterRecognised(j.displayName); }
        else { show('bookForm'); }
      })
      .catch(function () { show('bookForm'); });
  } else if (params.get('src') === 'fb') {
    show('bookEmailMatch');
  } else {
    show('bookForm');
  }

  document.getElementById('matchBtn').onclick = function () {
    var em = document.getElementById('matchEmail').value.trim();
    var err = document.getElementById('matchErr');
    if (!em) { err.textContent = 'Please enter your email.'; err.hidden = false; return; }
    post('/api/public/consult-lead/match', { email: em }).then(function (r) {
      if (r.json && r.json.found) {
        lead.token = r.json.token; lead.name = r.json.displayName; lead.email = em;
        enterRecognised(r.json.displayName);
      } else {
        document.getElementById('cfEmail').value = em;
        show('bookForm');
      }
    });
  };

  document.getElementById('consultForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var err = document.getElementById('cfErr');
    var isGpRaw = document.getElementById('cfIsGp').value;
    var country = document.getElementById('cfCountry').value;
    var payload = {
      name: document.getElementById('cfName').value.trim(),
      email: document.getElementById('cfEmail').value.trim(),
      phone: document.getElementById('cfPhone').value.trim(),
      isGp: isGpRaw === 'yes',
      country: country,
      question: document.getElementById('cfQuestion').value.trim(),
      website: document.getElementById('cfWebsite').value,
      utm: utm
    };
    if (!payload.name || !payload.email || !isGpRaw || !country) {
      err.textContent = 'Please fill in your name, email and both dropdowns.'; err.hidden = false; return;
    }
    err.hidden = true;
    post('/api/public/consult-lead', payload).then(function (r) {
      if (r.status !== 200 || !r.json.ok) {
        err.textContent = (r.json && r.json.error) || 'Something went wrong — please try again.'; err.hidden = false; return;
      }
      if (r.json.qualified) {
        lead.token = r.json.token; lead.name = payload.name; lead.email = payload.email;
        loadCalendly('Dr ' + payload.name.split(/\s+/).pop());
      } else {
        show('bookTurndown');
      }
    });
  });

  document.getElementById('tdSave').onclick = function () {
    var em = document.getElementById('tdEmail').value.trim();
    if (em) {
      post('/api/public/consult-lead', {
        name: 'Future-country lead', email: em, isGp: false, country: 'other',
        question: 'Keep me posted when GP Link supports my country.', utm: utm
      });
    }
    document.getElementById('tdThanks').hidden = false;
    this.disabled = true;
  };
})();
```

- [ ] **Step 4: Verify by serving**

Run: `npx vitest run tests/consult-lead-endpoints.test.js` (un-skip the `GET /start` test — must now be 200)
Then run `npm start` in the background, open `http://localhost:3000/start`, and click through: stranger form → qualified → Calendly iframe appears; stranger form with country "Somewhere else" → turn-down; `?src=fb` → email-match state; `?lead=<token from a curl POST>` → recognised state. Kill the server. Fix anything broken.
Expected: all four states reachable; no console errors (Calendly iframe itself may be blocked offline — the embed div mounting is the check).

- [ ] **Step 5: Commit**

```bash
git add pages/site-start.html tests/consult-lead-endpoints.test.js
git commit -m "feat(consult): /start landing page — two doors, screening, Calendly embed, booked signal"
```

---

### Task 6: Signin email prefill + repoint marketing "Book a call" links

**Files:**
- Modify: `pages/signin.html` (~line 1663-1666, the init tail)
- Modify: `pages/site-home.html` (lines 475, 487), `pages/site-gp-jobs.html` (232, 244), `pages/site-app.html` (313, 338), `pages/site-exclusive.html` (139, 152), `pages/site-about.html` (161, 174), `pages/site-faq.html` (151), `pages/site-jobs.html` (216), `pages/site-job.html` (199, 214)
- DO NOT touch: `pages/site-employers.html`, `pages/ahpra.html`

**Interfaces:**
- Consumes: `/start#book` (Task 5); signin page's existing `GP_SIGNIN_SIGNUP` flag (signin.html:1054-1058) and `#signupEmail` input (signin.html:735).
- Produces: `?email=` prefill on the signup panel (used by Task 4's nudge signup links and Task 5's recognised-lead door).

- [ ] **Step 1: Signin prefill**

In `pages/signin.html`, immediately after the final `setPanel(GP_SIGNIN_SIGNUP ? "signup" : "signin");` (line ~1666), add:

```js
    // Meta-ads funnel: recognised leads arrive with ?signup=1&email=… — prefill only.
    try {
      var gpPrefillEmail = new URLSearchParams(window.location.search).get("email") || "";
      if (GP_SIGNIN_SIGNUP && gpPrefillEmail) {
        var gpSignupEmailEl = document.getElementById("signupEmail");
        if (gpSignupEmailEl && !gpSignupEmailEl.value) gpSignupEmailEl.value = gpPrefillEmail.slice(0, 120);
      }
    } catch (e) { /* no-op */ }
```

- [ ] **Step 2: Repoint the 15 GP-facing Calendly links**

For each file:line in the Files list above, replace the anchor's `href="https://calendly.com/hello-mygplink/30min" target="_blank" rel="noopener"` with `href="/start#book"` (drop `target`/`rel`; keep the class and update nothing else about surrounding markup). Keep the existing link text.
Verify completeness:

Run: `grep -rn "calendly.com/hello-mygplink" pages/*.html`
Expected: matches ONLY in `pages/site-employers.html` (3) and `pages/ahpra.html` (1).

- [ ] **Step 3: Manual spot-check**

Run `npm start`, load `/` and `/gp-jobs`, confirm footer + CTA "Book a call" links navigate to `/start#book` and the booking section scrolls into view. Load `/pages/signin?signup=1&email=test%40x.co` and confirm the signup email input is prefilled. Kill the server.

- [ ] **Step 4: Commit**

```bash
git add pages/signin.html pages/site-home.html pages/site-gp-jobs.html pages/site-app.html pages/site-exclusive.html pages/site-about.html pages/site-faq.html pages/site-jobs.html pages/site-job.html
git commit -m "feat(consult): signup email prefill + all GP-facing Book-a-call links -> /start#book"
```

---

### Task 7: Full verification pass

**Files:** none new.

- [ ] **Step 1: Whole test suite + syntax**

Run: `node --check server.js && npx vitest run`
Expected: all suites pass, including every pre-existing test. Any regression gets fixed before proceeding.

- [ ] **Step 2: End-to-end dev click-through (local JSON mode)**

With `npm start` running:
1. `curl -s -X POST localhost:3000/api/webhooks/facebook-lead?secret=... ` — with `FB_LEAD_WEBHOOK_SECRET` + `FB_GP_LEAD_FORM_IDS` set in the shell, POST the native fixture body; confirm `{ ok:true, kind:'gp_lead' }` and a `siteEnquiries` row in `data/app-db.json` with a token.
2. Open `/start?lead=<that token>` → recognised state greets "Welcome back, Dr …".
3. Open `/start` → full form → submit qualified → Calendly section appears; submit `country=other` → turn-down.
4. `curl -s -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/consult-nudge` → `{ ok: true, ... }` summary shape.
Document actual outputs in the final report — never claim untested behavior.

- [ ] **Step 3: Commit any fixes; push branch**

```bash
git push -u origin worktree-meta-ads-gp-funnel-spec
```

---

## Plan Self-Review (completed)

- **Spec coverage:** landing page + two doors (T5), FB webhook GP branch + allow-list + dedupe (T3), magic link (T3), email match (T2/T5), booked signal (T2/T5), screening + turn-down + leave-email (T1/T2/T5), nudges A+B with no-show copy + unsubscribe + converted detection (T1/T4), speed-to-lead owner alert (T3 via `maybeNotifySiteEnquiry`; site-form path already calls it in T2's handler), signin prefill (T6), link repointing minus employers/ahpra (T6), consent line + privacy link (T5), UTM capture (T2/T5), no migration (metadata jsonb). Owner activation items (Meta form, env vars, Calendly hours) are ops, not code — they stay in the spec §7.
- **Deviation from spec, deliberate:** the spec named `POST /api/public/enquiry` as the storage route; the plan adds a dedicated `POST /api/public/consult-lead` (same table, same honeypot/rate-limit primitives) because the generic endpoint can't return the token/qualified flag and its response shape is frozen by the existing practice form. Spec intent (storage, protections, admin visibility) is preserved.
- **Type consistency check:** `consult.token`/`qualified`/`screened_out`/`call_booked`/`call_booked_at`/`nudges[{seq,step,sent_at}]`/`stopped` used identically in T1 lib, T2 rows/endpoints, T3 webhook branch, T4 cron, T5 page. Response shapes `{ok,qualified,token}`, `{ok,displayName,email,qualified}`, `{ok,found,displayName,token}` consistent between T2 endpoints and T5 page script.
