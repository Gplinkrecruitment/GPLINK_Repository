# CEO Interview Scheduling + Meetings Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Book interview" work end to end — three-way (GP/practice/CEO) timezone-correct availability matching, direct Zoom creation, a Google-Calendar source-of-truth with two-way clash prevention, a CEO Meetings tab, and a per-application section with interview summary + offer/contract placeholder.

**Architecture:** Interviews are stored as rows in the existing `scheduled_calls` table (tagged `meeting_kind='interview'`, linked to a `gp_applications` row). A pure timezone engine (`lib/interview-scheduler.js`) computes the overlap of the CEO's, practice's and GP's availability. Booking creates a Zoom meeting (existing Zoom helpers) and writes the interview onto the CEO's Google Calendar (new `lib/google-calendar.js`, dual-mode) so Calendly blocks consultations over it; slot generation reads the same calendar's free/busy so it never offers a clashing slot. The existing Zoom AI Companion webhook saves interview summaries unchanged. New endpoints are dual-mode (Supabase + local-JSON) following the existing ATS pattern.

**Tech Stack:** Vanilla Node.js (`server.js`, single `handleApi` if-chain), pure helper modules in `lib/`, vitest tests in local-JSON mode, Supabase/PostgREST + local JSON DB, vanilla ES5-style browser JS (`var`, string-concat HTML, classic `<script>`), CSS `ats-`-prefixed. Spec: `docs/superpowers/specs/2026-06-30-ceo-interview-scheduling-meetings-design.md`.

## Global Constraints

- **Never break consultations.** All `scheduled_calls` changes are additive; existing consultation rows and flows must behave identically. Run the full suite after every task.
- **Dual-mode always.** Every endpoint and DB helper must work in both Supabase mode (`isSupabaseDbConfigured()` true) and local-JSON mode (`dbState.*` + `saveDbState()`). Tests run local-JSON.
- **Timezones via IANA + `Intl` only.** Never use fixed UTC offsets. Daylight saving must be correct. The scheduler takes an injected `now` (never reads the clock internally) for deterministic tests.
- **No dead buttons.** Every control added must call a real, working endpoint.
- **Cache-busters:** when editing `pages/ceo-dashboard.html` script/style tags, bump `?v=YYYYMMDD[letter]` (use `20260630a`, then `b`, …).
- **Commit after every task.** Branch: `worktree-ats-prototype` (preview). Push with `GIT_SSH_COMMAND='ssh -i ~/.ssh/gplink_deploy -o IdentitiesOnly=yes' git push origin worktree-ats-prototype`.
- **Node binary:** `/tmp/node-v20.18.1-darwin-arm64/bin/node`. Tests: `/tmp/node-v20.18.1-darwin-arm64/bin/node node_modules/.bin/vitest run <file>`.
- **Availability defaults (verbatim):** Host = Australia/Sydney 11:00–02:00(+1) every day. Practice = AU-local, weekdays 18:00–22:00, weekends all day. GP = UK/IE/NZ-local 06:00–23:00 every day (asleep 23:00–06:00). Interview 45 min · horizon 14 days · lead 48 h · 30-min grid · ≤12 slots offered.
- **Practice email copy (verbatim):** "Which evenings/weekends over the next 2 weeks suit to interview Dr {name}?"

---

## File Structure

**New files:**
- `supabase/migrations/20260630120000_interview_meetings.sql` — additive columns on `scheduled_calls`.
- `lib/interview-meetings.js` — constants, timezone derivation, row factory, API normalizer. Pure.
- `lib/interview-scheduler.js` — pure three-way timezone overlap engine.
- `lib/google-calendar.js` — Google Calendar free/busy read + event create (prod API request builders + parsers; pure, no fetch). Server wraps it with dual-mode + fetch.
- `js/ceo-ats-meetings.js` — Meetings master-tab module.
- `tests/interview-meetings.test.js`, `tests/interview-scheduler.test.js`, `tests/interview-endpoints.test.js`, `tests/ceo-meetings-endpoints.test.js`.
- `docs/owner-setup-interview-scheduling.md` — click-by-click owner setup (Google Calendar + Calendly conflict-check + Zoom).

**Modified files:**
- `server.js` — DB helpers (`gcalReadBusy`, `gcalCreateEvent`, `createZoomInterviewMeeting`), interview endpoints, hub reply ingestion hook, `/api/ceo/meetings`, `/api/ceo/candidate` apps extension, local-mode seed shape.
- `js/ceo-ats-jobs.js` — re-add Book-interview button; replace old manual modal with a confirm that calls `/api/ats/interview/request`.
- `js/ceo-ats-candidates.js` — Applications section (per-app interview summary + offer/contract placeholder) + GP slot-picker view.
- `pages/ceo-dashboard.html` — Meetings master tab (nav + panel + script/style includes, cache-bust).
- `css/ceo-ats.css` — Meetings + Applications + slot-picker styles.
- `scripts/seed-ats-dev.js` — seed an interview-ready application + a fake calendar entry for local screenshots.

---

## Task 1: Migration + meeting model module (`lib/interview-meetings.js`)

**Files:**
- Create: `supabase/migrations/20260630120000_interview_meetings.sql`
- Create: `lib/interview-meetings.js`
- Test: `tests/interview-meetings.test.js`

**Interfaces:**
- Produces:
  - `MEETING_KINDS = { CONSULTATION: 'consultation', INTERVIEW: 'interview' }`
  - `PRACTICE_AVAIL = { NOT_REQUESTED:'not_requested', REQUESTED:'requested', RECEIVED:'received', DEFAULTED:'defaulted' }`
  - `DEFAULT_HOST_CONFIG = { tz:'Australia/Sydney', weekday:[660,1560], weekend:[660,1560] }` (minutes from midnight; 1560 = 02:00 next day)
  - `DEFAULT_PRACTICE_CONFIG = { weekday:[1080,1320], weekend:[0,1440] }`
  - `DEFAULT_GP_CONFIG = { weekday:[360,1380], weekend:[360,1380] }`
  - `gpTzForCountry(country) -> string` (IANA; default `'Europe/London'`)
  - `practiceTzForLocation(loc) -> string` (IANA AU; default `'Australia/Sydney'`)
  - `buildInterviewRow({ caseId, userId, applicationId, careerRoleId, practiceName, createdBy, nowIso }) -> object`
  - `normalizeMeetingForApi(row) -> object` (adds `meeting_kind_label`, `is_interview`)

- [ ] **Step 1: Write the failing test** — `tests/interview-meetings.test.js`

```javascript
import { describe, it, expect } from 'vitest';
import m from '../lib/interview-meetings.js';

describe('interview-meetings model', () => {
  it('maps GP country to IANA timezone, defaulting to London', () => {
    expect(m.gpTzForCountry('uk')).toBe('Europe/London');
    expect(m.gpTzForCountry('ie')).toBe('Europe/Dublin');
    expect(m.gpTzForCountry('nz')).toBe('Pacific/Auckland');
    expect(m.gpTzForCountry('')).toBe('Europe/London');
  });

  it('defaults practice timezone to Sydney when location is unknown', () => {
    expect(m.practiceTzForLocation('')).toBe('Australia/Sydney');
    expect(m.practiceTzForLocation('Perth WA')).toBe('Australia/Perth');
  });

  it('builds an interview row tagged interview/ceo/requested', () => {
    const row = m.buildInterviewRow({
      caseId: 'c1', userId: 'u1', applicationId: 'a1', careerRoleId: 7,
      practiceName: 'Greenslopes', createdBy: 'ceo@x', nowIso: '2026-06-30T00:00:00.000Z'
    });
    expect(row.meeting_kind).toBe('interview');
    expect(row.host_kind).toBe('ceo');
    expect(row.application_id).toBe('a1');
    expect(row.practice_name).toBe('Greenslopes');
    expect(row.practice_availability_status).toBe('requested');
    expect(row.status).toBe('invited');
    expect(row.summary_status).toBe('not_requested');
  });

  it('normalizes a meeting row with kind label + is_interview flag', () => {
    const out = m.normalizeMeetingForApi({ meeting_kind: 'interview' });
    expect(out.is_interview).toBe(true);
    expect(out.meeting_kind_label).toBe('Interview');
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `/tmp/node-v20.18.1-darwin-arm64/bin/node node_modules/.bin/vitest run tests/interview-meetings.test.js` → FAIL (cannot find module).

- [ ] **Step 3: Implement `lib/interview-meetings.js`**

```javascript
'use strict';

var MEETING_KINDS = { CONSULTATION: 'consultation', INTERVIEW: 'interview' };
var PRACTICE_AVAIL = { NOT_REQUESTED: 'not_requested', REQUESTED: 'requested', RECEIVED: 'received', DEFAULTED: 'defaulted' };

// minutes from local midnight; values >1440 mean "past midnight into the next day"
var DEFAULT_HOST_CONFIG = { tz: 'Australia/Sydney', weekday: [660, 1560], weekend: [660, 1560] };   // 11:00–02:00(+1)
var DEFAULT_PRACTICE_CONFIG = { weekday: [1080, 1320], weekend: [0, 1440] };                          // 18:00–22:00 / all
var DEFAULT_GP_CONFIG = { weekday: [360, 1380], weekend: [360, 1380] };                               // 06:00–23:00

function gpTzForCountry(country) {
  switch (String(country || '').toLowerCase().trim()) {
    case 'ie': case 'ireland': return 'Europe/Dublin';
    case 'nz': case 'new zealand': return 'Pacific/Auckland';
    case 'uk': case 'gb': case 'united kingdom': default: return 'Europe/London';
  }
}

function practiceTzForLocation(loc) {
  var s = String(loc || '').toLowerCase();
  if (/\bwa\b|perth|western australia/.test(s)) return 'Australia/Perth';
  if (/\bsa\b|adelaide|south australia/.test(s)) return 'Australia/Adelaide';
  if (/\bnt\b|darwin|northern territory/.test(s)) return 'Australia/Darwin';
  if (/\bqld\b|brisbane|queensland|gold coast/.test(s)) return 'Australia/Brisbane';
  if (/\bwa\b/.test(s)) return 'Australia/Perth';
  return 'Australia/Sydney'; // NSW/VIC/ACT/TAS default
}

function buildInterviewRow(o) {
  var now = o.nowIso || new Date().toISOString();
  return {
    case_id: o.caseId || null,
    user_id: o.userId || null,
    meeting_kind: MEETING_KINDS.INTERVIEW,
    host_kind: 'ceo',
    application_id: o.applicationId || null,
    career_role_id: (o.careerRoleId === 0 || o.careerRoleId) ? o.careerRoleId : null,
    practice_name: o.practiceName || '',
    stage: null,
    status: 'invited',
    practice_availability_status: PRACTICE_AVAIL.REQUESTED,
    practice_availability_requested_at: now,
    summary_status: 'not_requested',
    created_by: o.createdBy || '',
    created_at: now,
    updated_at: now
  };
}

function normalizeMeetingForApi(row) {
  var r = Object.assign({}, row);
  r.is_interview = row.meeting_kind === MEETING_KINDS.INTERVIEW;
  r.meeting_kind_label = r.is_interview ? 'Interview' : 'Standard consultation';
  return r;
}

module.exports = {
  MEETING_KINDS, PRACTICE_AVAIL,
  DEFAULT_HOST_CONFIG, DEFAULT_PRACTICE_CONFIG, DEFAULT_GP_CONFIG,
  gpTzForCountry, practiceTzForLocation, buildInterviewRow, normalizeMeetingForApi
};
```

- [ ] **Step 4: Run tests, verify pass** — same vitest command → PASS (4 tests).

- [ ] **Step 5: Write the migration** — `supabase/migrations/20260630120000_interview_meetings.sql`

```sql
-- Interview meetings on scheduled_calls (additive; consultations unaffected).
ALTER TABLE scheduled_calls
  ADD COLUMN IF NOT EXISTS meeting_kind TEXT NOT NULL DEFAULT 'consultation',
  ADD COLUMN IF NOT EXISTS host_kind TEXT NOT NULL DEFAULT 'rso',
  ADD COLUMN IF NOT EXISTS application_id UUID NULL REFERENCES gp_applications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS career_role_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS practice_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS gcal_event_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS practice_availability_status TEXT NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS practice_availability_windows JSONB NULL,
  ADD COLUMN IF NOT EXISTS practice_availability_requested_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS practice_availability_received_at TIMESTAMPTZ NULL;

-- meeting_kind constraint
ALTER TABLE scheduled_calls DROP CONSTRAINT IF EXISTS scheduled_calls_meeting_kind_chk;
ALTER TABLE scheduled_calls ADD CONSTRAINT scheduled_calls_meeting_kind_chk
  CHECK (meeting_kind IN ('consultation','interview'));

-- stage was NOT NULL CHECK (myintealth/amc/ahpra). Interviews have no stage → relax.
ALTER TABLE scheduled_calls ALTER COLUMN stage DROP NOT NULL;
ALTER TABLE scheduled_calls DROP CONSTRAINT IF EXISTS scheduled_calls_stage_check;
ALTER TABLE scheduled_calls ADD CONSTRAINT scheduled_calls_stage_check
  CHECK (stage IS NULL OR stage IN ('myintealth','amc','ahpra'));

CREATE INDEX IF NOT EXISTS idx_scheduled_calls_kind_host ON scheduled_calls(meeting_kind, host_kind);
CREATE INDEX IF NOT EXISTS idx_scheduled_calls_application ON scheduled_calls(application_id);
```

(Local-JSON mode needs no migration — `dbState.scheduledCalls` rows are plain JSON. Note in the task commit message that this migration must be applied to the shared Supabase via `exec_sql` at deploy time — see [[supabase-migrations-exec-sql]].)

- [ ] **Step 6: Commit**

```bash
git add lib/interview-meetings.js tests/interview-meetings.test.js supabase/migrations/20260630120000_interview_meetings.sql
git commit -m "Interview meetings: model module + scheduled_calls migration"
```

---

## Task 2: Three-way timezone overlap engine (`lib/interview-scheduler.js`)

This is the riskiest unit. Full TDD with DST cases.

**Files:**
- Create: `lib/interview-scheduler.js`
- Test: `tests/interview-scheduler.test.js`

**Interfaces:**
- Consumes: nothing (pure). Configs shaped like `DEFAULT_*_CONFIG` from Task 1.
- Produces:
  - `computeInterviewSlots({ now, horizonDays, durationMin, leadHours, gridMin, maxSlots, host, practice, gp, busy }) -> { slots, horizonFromUtc, horizonToUtc }`
    - `host` = `{ tz, weekday:[a,b], weekend:[a,b] }`; `practice` = `{ tz, weekday, weekend, overrides:[{date:'YYYY-MM-DD', fromMin, toMin}] }`; `gp` = `{ tz, weekday, weekend }`.
    - `busy` = `[{ startUtc, endUtc }]` ISO strings (host busy intervals).
    - `now` = ISO string. All `*Utc` values ISO strings.
    - each slot = `{ startUtc, endUtc, local: { host:{tz,label}, practice:{tz,label}, gp:{tz,label} } }`.
  - `wallTimeToUtc(dateYMD, minutesFromMidnight, tz) -> Date` (exported for tests)
  - `formatLocal(utcIso, tz) -> string` (e.g. "Tue 1 Jul, 6:00 pm")

- [ ] **Step 1: Write the failing tests** — `tests/interview-scheduler.test.js`

```javascript
import { describe, it, expect } from 'vitest';
import s from '../lib/interview-scheduler.js';

const HOST = { tz: 'Australia/Sydney', weekday: [660, 1560], weekend: [660, 1560] };
const PRACTICE = { tz: 'Australia/Sydney', weekday: [1080, 1320], weekend: [0, 1440], overrides: [] };
const GP = { tz: 'Europe/London', weekday: [360, 1380], weekend: [360, 1380] };

function base(extra) {
  return Object.assign({
    now: '2026-07-01T00:00:00.000Z', horizonDays: 7, durationMin: 45,
    leadHours: 48, gridMin: 30, maxSlots: 12, host: HOST, practice: PRACTICE, gp: GP, busy: []
  }, extra || {});
}

describe('interview-scheduler', () => {
  it('wallTimeToUtc respects DST: Sydney 18:00 on 1 Jul (AEST, UTC+10) = 08:00Z', () => {
    const d = s.wallTimeToUtc('2026-07-01', 1080, 'Australia/Sydney');
    expect(d.toISOString()).toBe('2026-07-01T08:00:00.000Z');
  });

  it('wallTimeToUtc respects DST: Sydney 18:00 on 1 Feb (AEDT, UTC+11) = 07:00Z', () => {
    const d = s.wallTimeToUtc('2026-02-01', 1080, 'Australia/Sydney');
    expect(d.toISOString()).toBe('2026-02-01T07:00:00.000Z');
  });

  it('produces weekday slots inside the practice 6–10pm Sydney window (= UK morning)', () => {
    const out = s.computeInterviewSlots(base());
    expect(out.slots.length).toBeGreaterThan(0);
    // every slot must start at or after 08:00Z and end by 11:15Z (practice 18:00–22:00 AEST in July)
    out.slots.forEach(function (sl) {
      const h = new Date(sl.startUtc).getUTCHours();
      expect(h).toBeGreaterThanOrEqual(8);
      expect(h).toBeLessThan(12);
    });
  });

  it('never offers a slot inside the GP 11pm–6am sleep window', () => {
    const out = s.computeInterviewSlots(base());
    out.slots.forEach(function (sl) {
      const label = sl.local.gp.label; // London local
      // 08:00Z in July (BST, UTC+1) = 09:00 London — fine; assert hour 6..23 in London
      const lonHour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/London' }).format(new Date(sl.startUtc)));
      expect(lonHour).toBeGreaterThanOrEqual(6);
      expect(lonHour).toBeLessThan(23);
    });
  });

  it('honours the lead time (no slot sooner than now + leadHours)', () => {
    const out = s.computeInterviewSlots(base({ leadHours: 72 }));
    const minStart = new Date('2026-07-01T00:00:00.000Z').getTime() + 72 * 3600 * 1000;
    out.slots.forEach(function (sl) {
      expect(new Date(sl.startUtc).getTime()).toBeGreaterThanOrEqual(minStart);
    });
  });

  it('subtracts host busy intervals (a consultation blocks its slot)', () => {
    const withBusy = base({ busy: [{ startUtc: '2026-07-03T08:00:00.000Z', endUtc: '2026-07-03T11:00:00.000Z' }] });
    const out = s.computeInterviewSlots(withBusy);
    out.slots.forEach(function (sl) {
      const t = new Date(sl.startUtc).getTime();
      const bs = new Date('2026-07-03T08:00:00.000Z').getTime();
      const be = new Date('2026-07-03T11:00:00.000Z').getTime();
      const overlaps = t < be && (t + 45 * 60000) > bs;
      expect(overlaps).toBe(false);
    });
  });

  it('weekend opens the practice window all day (slots exist outside 6–10pm AU)', () => {
    // horizon includes Sat 4 / Sun 5 Jul 2026
    const out = s.computeInterviewSlots(base({ horizonDays: 7, maxSlots: 50 }));
    const weekendSlot = out.slots.find(function (sl) {
      const day = new Date(sl.startUtc).getUTCDay();
      const audow = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Australia/Sydney' }).format(new Date(sl.startUtc));
      return audow === 'Sat' || audow === 'Sun';
    });
    expect(weekendSlot).toBeTruthy();
  });

  it('a practice override narrows the window for that date', () => {
    const p = Object.assign({}, PRACTICE, { overrides: [{ date: '2026-07-02', fromMin: 1140, toMin: 1200 }] }); // 19:00–20:00
    const out = s.computeInterviewSlots(base({ practice: p, horizonDays: 3, maxSlots: 50 }));
    const onJul2 = out.slots.filter(function (sl) {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date(sl.startUtc)) === '2026-07-02';
    });
    onJul2.forEach(function (sl) {
      const h = new Date(sl.startUtc).getUTCHours(); // 19:00 AEST = 09:00Z, 20:00 = 10:00Z
      expect(h).toBeGreaterThanOrEqual(9);
      expect(h).toBeLessThan(10);
    });
  });
});
```

- [ ] **Step 2: Run, verify fail** — `/tmp/node-v20.18.1-darwin-arm64/bin/node node_modules/.bin/vitest run tests/interview-scheduler.test.js` → FAIL.

- [ ] **Step 3: Implement `lib/interview-scheduler.js`**

```javascript
'use strict';

// Convert a wall-clock time (date + minutes-from-midnight) in an IANA tz to a UTC Date,
// using Intl to discover the tz's offset on that date (DST-correct). minutesFromMidnight
// may exceed 1440 to mean "into the next day".
function wallTimeToUtc(dateYMD, minutesFromMidnight, tz) {
  var parts = dateYMD.split('-');
  var y = Number(parts[0]), mo = Number(parts[1]), d = Number(parts[2]);
  var addDays = Math.floor(minutesFromMidnight / 1440);
  var mins = minutesFromMidnight - addDays * 1440;
  var hh = Math.floor(mins / 60), mm = mins % 60;
  // Guess UTC, then correct by the tz offset at that instant.
  var guess = Date.UTC(y, mo - 1, d + addDays, hh, mm, 0);
  var offset = tzOffsetMs(guess, tz);
  var utc = guess - offset;
  // re-evaluate once in case the guess crossed a DST boundary
  var offset2 = tzOffsetMs(utc, tz);
  if (offset2 !== offset) utc = guess - offset2;
  return new Date(utc);
}

// Offset (ms) of tz at a given UTC instant = (local wall time interpreted as UTC) - instant.
function tzOffsetMs(utcMillis, tz) {
  var dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  var p = {}; dtf.formatToParts(new Date(utcMillis)).forEach(function (x) { p[x.type] = x.value; });
  var asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === '24' ? '0' : p.hour), +p.minute, +p.second);
  return asUtc - utcMillis;
}

function ymdInTz(utcMillis, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(utcMillis));
}
function dowInTz(utcMillis, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(utcMillis));
}
function isWeekendDow(dow) { return dow === 'Sat' || dow === 'Sun'; }

function formatLocal(utcIso, tz) {
  var d = new Date(utcIso);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true
  }).format(d);
}

// Build [start,end) UTC intervals for one party for the local date `ymd` (its own tz).
function partyIntervalsForDate(party, ymd, tz) {
  var sample = wallTimeToUtc(ymd, 12 * 60, tz).getTime(); // noon, to read the weekday safely
  var weekend = isWeekendDow(dowInTz(sample, tz));
  var win = weekend ? party.weekend : party.weekday;
  if (party.overrides && party.overrides.length) {
    var ov = party.overrides.filter(function (o) { return o.date === ymd; });
    if (ov.length) {
      return ov.map(function (o) {
        return { start: wallTimeToUtc(ymd, o.fromMin, tz).getTime(), end: wallTimeToUtc(ymd, o.toMin, tz).getTime() };
      });
    }
  }
  if (!win || win[0] === win[1]) return [];
  return [{ start: wallTimeToUtc(ymd, win[0], tz).getTime(), end: wallTimeToUtc(ymd, win[1], tz).getTime() }];
}

function intersect(aList, bList) {
  var out = [];
  aList.forEach(function (a) {
    bList.forEach(function (b) {
      var s = Math.max(a.start, b.start), e = Math.min(a.end, b.end);
      if (e > s) out.push({ start: s, end: e });
    });
  });
  return out;
}

function subtractBusy(list, busy) {
  var res = list.slice();
  busy.forEach(function (b) {
    var bs = new Date(b.startUtc).getTime(), be = new Date(b.endUtc).getTime();
    var next = [];
    res.forEach(function (iv) {
      if (be <= iv.start || bs >= iv.end) { next.push(iv); return; }
      if (bs > iv.start) next.push({ start: iv.start, end: Math.min(bs, iv.end) });
      if (be < iv.end) next.push({ start: Math.max(be, iv.start), end: iv.end });
    });
    res = next;
  });
  return res;
}

function computeInterviewSlots(opts) {
  var now = new Date(opts.now).getTime();
  var horizonDays = opts.horizonDays || 14;
  var durationMin = opts.durationMin || 45;
  var leadHours = opts.leadHours != null ? opts.leadHours : 48;
  var gridMin = opts.gridMin || 30;
  var maxSlots = opts.maxSlots || 12;
  var host = opts.host, practice = opts.practice, gp = opts.gp, busy = opts.busy || [];
  var earliest = now + leadHours * 3600 * 1000;
  var horizonTo = now + horizonDays * 24 * 3600 * 1000;

  var slots = [];
  // iterate dates in the HOST tz across the horizon
  for (var dayOffset = 0; dayOffset <= horizonDays; dayOffset++) {
    var ymdHost = ymdInTz(now + dayOffset * 24 * 3600 * 1000, host.tz);
    var hostIv = partyIntervalsForDate(host, ymdHost, host.tz);
    if (!hostIv.length) continue;
    hostIv = subtractBusy(hostIv, busy);
    // practice/gp evaluated on the local date that the host interval falls within
    var combined = [];
    hostIv.forEach(function (h) {
      var ymdP = ymdInTz(h.start, practice.tz), ymdP2 = ymdInTz(h.end - 1, practice.tz);
      var pIv = partyIntervalsForDate(practice, ymdP, practice.tz);
      if (ymdP2 !== ymdP) pIv = pIv.concat(partyIntervalsForDate(practice, ymdP2, practice.tz));
      var ymdG = ymdInTz(h.start, gp.tz), ymdG2 = ymdInTz(h.end - 1, gp.tz);
      var gIv = partyIntervalsForDate(gp, ymdG, gp.tz);
      if (ymdG2 !== ymdG) gIv = gIv.concat(partyIntervalsForDate(gp, ymdG2, gp.tz));
      var step1 = intersect([h], pIv);
      combined = combined.concat(intersect(step1, gIv));
    });
    // slice into grid starts
    combined.forEach(function (iv) {
      var start = Math.ceil(iv.start / (gridMin * 60000)) * (gridMin * 60000);
      for (var t = start; t + durationMin * 60000 <= iv.end; t += gridMin * 60000) {
        if (t < earliest || t > horizonTo) continue;
        slots.push(t);
      }
    });
  }
  slots = Array.from(new Set(slots)).sort(function (a, b) { return a - b; });
  // spread: take evenly across the list up to maxSlots
  if (slots.length > maxSlots) {
    var picked = [], stepN = slots.length / maxSlots;
    for (var i = 0; i < maxSlots; i++) picked.push(slots[Math.floor(i * stepN)]);
    slots = picked;
  }
  return {
    horizonFromUtc: new Date(now).toISOString(),
    horizonToUtc: new Date(horizonTo).toISOString(),
    slots: slots.map(function (t) {
      var startUtc = new Date(t).toISOString();
      var endUtc = new Date(t + durationMin * 60000).toISOString();
      return {
        startUtc: startUtc, endUtc: endUtc,
        local: {
          host: { tz: host.tz, label: formatLocal(startUtc, host.tz) },
          practice: { tz: practice.tz, label: formatLocal(startUtc, practice.tz) },
          gp: { tz: gp.tz, label: formatLocal(startUtc, gp.tz) }
        }
      };
    })
  };
}

module.exports = { wallTimeToUtc, tzOffsetMs, formatLocal, computeInterviewSlots };
```

- [ ] **Step 4: Run, verify pass** — vitest on the file → PASS (8 tests). If the "weekend" or "spread" tests are flaky on slot counts, adjust `maxSlots` in the test base, not the engine logic.

- [ ] **Step 5: Run the whole suite** — `/tmp/node-v20.18.1-darwin-arm64/bin/node node_modules/.bin/vitest run` → all green (no regressions).

- [ ] **Step 6: Commit**

```bash
git add lib/interview-scheduler.js tests/interview-scheduler.test.js
git commit -m "Interview scheduler: pure 3-way timezone overlap engine (DST-correct)"
```

---

## Task 3: Integration helpers — Zoom create + Google Calendar (dual-mode)

**Files:**
- Create: `lib/google-calendar.js` (pure request builders + parsers)
- Modify: `server.js` — add `createZoomInterviewMeeting`, `gcalReadBusy`, `gcalCreateEvent` near the existing Zoom helpers (`getZoomAccessToken` ~22185; existing create call ~22239) and near `isSupabaseDbConfigured`.
- Test: `tests/interview-meetings.test.js` (extend) for `lib/google-calendar.js` pure parts.

**Interfaces:**
- Consumes: `getZoomAccessToken()`, `isZoomConfigured()` (server.js ~22180), existing Zoom create pattern (~22239).
- Produces (server.js, async):
  - `createZoomInterviewMeeting({ topic, startUtc, durationMin }) -> { id, uuid, join_url, passcode }`
  - `gcalReadBusy({ fromUtc, toUtc }) -> [{ startUtc, endUtc }]`
  - `gcalCreateEvent({ summary, startUtc, endUtc, attendees, description }) -> { id }`
  - Local mode of both backed by `dbState.fakeCalendar = [{ id, startUtc, endUtc, summary }]`.
- Produces (`lib/google-calendar.js`, pure):
  - `buildFreeBusyRequest({ calendarId, fromUtc, toUtc }) -> { url, body }`
  - `parseFreeBusy(json, calendarId) -> [{ startUtc, endUtc }]`
  - `buildEventInsert({ calendarId, summary, startUtc, endUtc, attendees, description, zoomJoinUrl }) -> { url, body }`

- [ ] **Step 1: Add pure tests to `tests/interview-meetings.test.js`**

```javascript
import gcal from '../lib/google-calendar.js';
describe('google-calendar request builders', () => {
  it('builds a freebusy request for the calendar + window', () => {
    const { url, body } = gcal.buildFreeBusyRequest({ calendarId: 'hello@x', fromUtc: '2026-07-01T00:00:00Z', toUtc: '2026-07-08T00:00:00Z' });
    expect(url).toContain('/freeBusy');
    expect(body.items[0].id).toBe('hello@x');
    expect(body.timeMin).toBe('2026-07-01T00:00:00Z');
  });
  it('parses a freebusy response into busy intervals', () => {
    const json = { calendars: { 'hello@x': { busy: [{ start: '2026-07-03T08:00:00Z', end: '2026-07-03T11:00:00Z' }] } } };
    const out = gcal.parseFreeBusy(json, 'hello@x');
    expect(out).toEqual([{ startUtc: '2026-07-03T08:00:00Z', endUtc: '2026-07-03T11:00:00Z' }]);
  });
  it('builds an event insert with attendees + zoom link', () => {
    const { url, body } = gcal.buildEventInsert({ calendarId: 'hello@x', summary: 'Interview', startUtc: '2026-07-03T08:00:00Z', endUtc: '2026-07-03T08:45:00Z', attendees: ['gp@x','prac@x'], description: 'd', zoomJoinUrl: 'https://zoom/x' });
    expect(url).toContain('/calendars/hello%40x/events');
    expect(body.attendees.map(a => a.email)).toContain('gp@x');
    expect(body.start.dateTime).toBe('2026-07-03T08:00:00Z');
    expect(body.location).toBe('https://zoom/x');
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `lib/google-calendar.js`**

```javascript
'use strict';
var API = 'https://www.googleapis.com/calendar/v3';

function buildFreeBusyRequest(o) {
  return { url: API + '/freeBusy', body: { timeMin: o.fromUtc, timeMax: o.toUtc, items: [{ id: o.calendarId }] } };
}
function parseFreeBusy(json, calendarId) {
  var cal = (json && json.calendars && json.calendars[calendarId]) || { busy: [] };
  return (cal.busy || []).map(function (b) { return { startUtc: b.start, endUtc: b.end }; });
}
function buildEventInsert(o) {
  return {
    url: API + '/calendars/' + encodeURIComponent(o.calendarId) + '/events?sendUpdates=all&conferenceDataVersion=0',
    body: {
      summary: o.summary,
      description: (o.description || '') + (o.zoomJoinUrl ? ('\n\nZoom: ' + o.zoomJoinUrl) : ''),
      location: o.zoomJoinUrl || '',
      start: { dateTime: o.startUtc }, end: { dateTime: o.endUtc },
      attendees: (o.attendees || []).map(function (e) { return { email: e }; })
    }
  };
}
module.exports = { buildFreeBusyRequest, parseFreeBusy, buildEventInsert };
```

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Add server.js wrappers.** Insert after `getZoomAccessToken`/the existing Zoom create code (~22245). Use the existing create pattern; reuse its auth. For Google, mint an access token from the same Google credentials the app already uses for Gmail/Drive — **the executing subagent must grep `server.js` for the existing Google auth (`google`, `serviceAccount`, `getGoogleAccessToken`, `jwt`, `googleapis`) and reuse it, adding the Calendar scope `https://www.googleapis.com/auth/calendar.events`**. If no reusable Google auth exists, implement a Google service-account JWT mint behind `isGoogleCalendarConfigured()` (env `GOOGLE_CALENDAR_ID`, plus existing Google service-account creds) and leave it disabled until prod env is set.

```javascript
var gcalLib = require('./lib/google-calendar.js');
function isGoogleCalendarConfigured() { return !!process.env.GOOGLE_CALENDAR_ID && isGoogleServiceConfigured(); } // reuse existing google-config check

async function gcalReadBusy(o) {
  if (!isGoogleCalendarConfigured()) {
    return (dbState.fakeCalendar || []).filter(function (e) {
      return new Date(e.endUtc) > new Date(o.fromUtc) && new Date(e.startUtc) < new Date(o.toUtc);
    }).map(function (e) { return { startUtc: e.startUtc, endUtc: e.endUtc }; });
  }
  var token = await getGoogleAccessToken(['https://www.googleapis.com/auth/calendar.events']);
  var req = gcalLib.buildFreeBusyRequest({ calendarId: process.env.GOOGLE_CALENDAR_ID, fromUtc: o.fromUtc, toUtc: o.toUtc });
  var res = await fetch(req.url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
  var json = await res.json();
  return gcalLib.parseFreeBusy(json, process.env.GOOGLE_CALENDAR_ID);
}

async function gcalCreateEvent(o) {
  if (!isGoogleCalendarConfigured()) {
    var id = 'gcal_local_' + (dbState.fakeCalendar ? dbState.fakeCalendar.length + 1 : 1);
    dbState.fakeCalendar = dbState.fakeCalendar || [];
    dbState.fakeCalendar.push({ id: id, startUtc: o.startUtc, endUtc: o.endUtc, summary: o.summary });
    saveDbState();
    return { id: id };
  }
  var token = await getGoogleAccessToken(['https://www.googleapis.com/auth/calendar.events']);
  var req = gcalLib.buildEventInsert(Object.assign({ calendarId: process.env.GOOGLE_CALENDAR_ID }, o));
  var res = await fetch(req.url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
  var json = await res.json();
  return { id: json.id };
}

async function createZoomInterviewMeeting(o) {
  if (!isZoomConfigured()) {
    return { id: 'zoom_local_' + Date.now(), uuid: 'uuid_local', join_url: 'https://zoom.local/j/interview', passcode: '' };
  }
  var token = await getZoomAccessToken();
  var res = await fetch('https://api.zoom.us/v2/users/me/meetings', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: o.topic, type: 2, start_time: o.startUtc, duration: o.durationMin, timezone: 'UTC', settings: { join_before_host: false } })
  });
  var d = await res.json();
  return { id: String(d.id || ''), uuid: d.uuid || '', join_url: d.join_url || '', passcode: d.password || '' };
}
```

(The executing subagent verifies `isZoomConfigured`/`getZoomAccessToken` names at ~22180–22245 and the Google auth helper name, adjusting the reuse accordingly. Keep `createZoomInterviewMeeting` separate from the consultation Zoom path.)

- [ ] **Step 6: `node --check server.js`**, run full suite → green. Commit.

```bash
git add lib/google-calendar.js server.js tests/interview-meetings.test.js
git commit -m "Interview integration helpers: Zoom create + Google Calendar read/write (dual-mode)"
```

---

## Task 4: `POST /api/ats/interview/request` — create interview + email the practice

**Files:**
- Modify: `server.js` — new endpoint in the `handleApi` if-chain (place beside the other `/api/ats/*` handlers ~43723–43770); helper `atsGetApplicationContext(appId)`.
- Test: `tests/interview-endpoints.test.js`

**Interfaces:**
- Consumes: `buildInterviewRow` (Task 1), the practice email hub (`registrationHub` / the existing practice-email send used by the doc-request composer — subagent greps `composePracticeEmail`/`sendPracticeDocRequest`/`registrationHub.send`), `isSupabaseDbConfigured`, `supabaseDbRequest`, `dbState`, `saveDbState`, `requireCeoSession`/the existing CEO/super-admin guard used by `/api/ceo/*`.
- Produces: an interview `scheduled_calls` row with `practice_availability_status='requested'`; returns `{ ok:true, interview_id, already }`.

- [ ] **Step 1: Failing test** — `tests/interview-endpoints.test.js` (mirror the auth/bootstrap of `tests/ats-endpoints.test.js`: import the server, seed via local DB, mint `gp_admin_session`). Test:

```javascript
it('POST /api/ats/interview/request creates an interview row + marks practice requested', async () => {
  const res = await call('POST', '/api/ats/interview/request', { application_id: SEED_APP_ID });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  const row = readDb().scheduledCalls.find(r => r.id === res.body.interview_id);
  expect(row.meeting_kind).toBe('interview');
  expect(row.application_id).toBe(SEED_APP_ID);
  expect(row.practice_availability_status).toBe('requested');
});
it('is idempotent — a second request returns already:true', async () => {
  const a = await call('POST', '/api/ats/interview/request', { application_id: SEED_APP_ID });
  const b = await call('POST', '/api/ats/interview/request', { application_id: SEED_APP_ID });
  expect(b.body.already).toBe(true);
});
it('rejects without an admin session', async () => {
  const res = await callNoAuth('POST', '/api/ats/interview/request', { application_id: SEED_APP_ID });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement the endpoint.** Sketch (place before the 404, mirror existing `/api/ats/application` handler shape):

```javascript
if (req.method === 'POST' && pathname === '/api/ats/interview/request') {
  var sess = await requireCeoOrSuperAdmin(req, res); if (!sess) return; // existing guard pattern
  var body = await readJsonBody(req);
  var appId = body && body.application_id;
  if (!appId) { sendJson(res, 400, { ok: false, message: 'application_id required' }); return; }
  var ctx = await atsGetApplicationContext(appId); // { app, userId, caseId, careerRoleId, practiceName, gpName, gpCountry, practiceEmail }
  if (!ctx) { sendJson(res, 404, { ok: false, message: 'application not found' }); return; }
  var existing = await findInterviewForApplication(appId); // any non-cancelled interview row
  if (existing) { sendJson(res, 200, { ok: true, interview_id: existing.id, already: true }); return; }
  var row = interviewMeetings.buildInterviewRow({ caseId: ctx.caseId, userId: ctx.userId, applicationId: appId, careerRoleId: ctx.careerRoleId, practiceName: ctx.practiceName, createdBy: sess.email, nowIso: new Date().toISOString() });
  var saved = await insertScheduledCallRow(row); // dual-mode insert returning the row with id
  // email the practice via the hub
  var subject = 'Interview availability — Dr ' + ctx.gpName;
  var bodyText = 'Which evenings/weekends over the next 2 weeks suit to interview Dr ' + ctx.gpName + '?';
  await sendPracticeHubEmail({ to: ctx.practiceEmail, subject: subject, text: bodyText, correlation: { kind: 'interview_availability', interview_id: saved.id } });
  sendJson(res, 200, { ok: true, interview_id: saved.id, already: false });
  return;
}
```

Implement `atsGetApplicationContext`, `findInterviewForApplication`, `insertScheduledCallRow` (dual-mode; local pushes to `dbState.scheduledCalls`), and `sendPracticeHubEmail` (reuse the existing practice-email send path — subagent locates it; correlation token stored so the reply is matchable in Task 5b). If `requireCeoOrSuperAdmin`/`readJsonBody` differ in name, use the project's existing equivalents.

- [ ] **Step 4: Run tests, verify pass. Run full suite. Commit.**

```bash
git add server.js tests/interview-endpoints.test.js
git commit -m "Interview request endpoint: create interview row + email practice for availability"
```

---

## Task 5: Practice-reply ingestion (AI parse) → store windows → notify GP

**Files:**
- Modify: `server.js` — hook into the hub inbound-reply path (`registrationHubInbox` / the function that processes inbound hub mail) to detect an `interview_availability` reply, AI-parse it, store windows, set status, and notify the GP that slots are ready.
- Test: `tests/interview-endpoints.test.js` (extend) — drive a helper `ingestPracticeAvailabilityReply(interviewId, replyText, nowIso)` directly (don't simulate Gmail).

**Interfaces:**
- Consumes: the Anthropic call pattern (`api.anthropic.com/v1/messages`, model via `lib/anthropic-model.js`), the existing GP notification used by consultation invites (WhatsApp+email → `notification_channels`).
- Produces: `ingestPracticeAvailabilityReply(interviewId, replyText, nowIso) -> { windows }` that sets `practice_availability_status='received'`, stores `practice_availability_windows`, and notifies the GP.

- [ ] **Step 1: Failing test**

```javascript
it('parses a practice reply into windows and marks received', async () => {
  await call('POST', '/api/ats/interview/request', { application_id: SEED_APP_ID });
  const id = readDb().scheduledCalls.find(r => r.meeting_kind==='interview').id;
  await server.__test.ingestPracticeAvailabilityReply(id, 'Thursday or Friday after 7pm works for us', '2026-07-01T00:00:00Z');
  const row = readDb().scheduledCalls.find(r => r.id === id);
  expect(row.practice_availability_status).toBe('received');
  expect(Array.isArray(row.practice_availability_windows)).toBe(true);
});
```

(Expose a `__test` hook object on the server export for the ingestion function, OR test through a thin internal endpoint `POST /api/ats/interview/_ingest-test` guarded to test env. Prefer the `__test` hook — mirror any existing test hook; if none, add `module.exports.__test = { ingestPracticeAvailabilityReply }`.)

For the AI call: in local/test mode (no `ANTHROPIC_API_KEY`), short-circuit to a deterministic parser that turns "after 7pm" + named weekdays into windows, so the test is hermetic. Gate on `process.env.ANTHROPIC_API_KEY`.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement.** `ingestPracticeAvailabilityReply`:
  1. Load the interview row; if not found or not `interview`, return.
  2. If `ANTHROPIC_API_KEY` set → call Claude with a strict JSON schema prompt: "Extract interview availability windows in Australia/<tz> from this reply. Return JSON array of {date:'YYYY-MM-DD', from:'HH:MM', to:'HH:MM'} for the next 14 days." Else → deterministic fallback parser.
  3. Convert to `[{ date, fromMin, toMin }]`, store on the row, set `practice_availability_status='received'`, `practice_availability_received_at=now`.
  4. Notify the GP ("Your interview slots are ready to pick — open the app") via the existing consultation-invite notifier.
  5. Hook: in the hub inbound processor, when a reply's correlation/threading maps to an `interview_availability` request, call this function.

- [ ] **Step 4: Tests pass. Full suite. Commit.**

```bash
git add server.js tests/interview-endpoints.test.js
git commit -m "Interview availability: AI-parse practice reply into windows + notify GP"
```

---

## Task 6: GP slots + booking endpoints

**Files:**
- Modify: `server.js` — `GET /api/ats/interview/slots`, `POST /api/ats/interview/book`.
- Test: `tests/interview-endpoints.test.js` (extend).

**Interfaces:**
- Consumes: `computeInterviewSlots` (Task 2), `gcalReadBusy`/`gcalCreateEvent`/`createZoomInterviewMeeting` (Task 3), `gpTzForCountry`/`practiceTzForLocation`/`DEFAULT_*_CONFIG` (Task 1), `atsUpdateApplicationStageRow`/`atsRecordStageEvent` (server.js ~23084/~23100).
- Produces: slots `{ ok, status, slots:[{startUtc,endUtc,local}] }`; book `{ ok, interview_id, scheduled_at, zoom_join_url }`.

- [ ] **Step 1: Failing tests**

```javascript
it('GET /api/ats/interview/slots returns pre-cleared slots after a reply', async () => {
  await call('POST', '/api/ats/interview/request', { application_id: SEED_APP_ID });
  const id = readDb().scheduledCalls.find(r=>r.meeting_kind==='interview').id;
  await server.__test.ingestPracticeAvailabilityReply(id, 'weekdays 6-10pm', '2026-07-01T00:00:00Z');
  const res = await call('GET', '/api/ats/interview/slots?application_id=' + SEED_APP_ID + '&now=2026-07-01T00:00:00Z');
  expect(res.body.slots.length).toBeGreaterThan(0);
  expect(res.body.slots[0].local.gp.tz).toBe('Europe/London');
});
it('POST /api/ats/interview/book books, creates zoom+gcal, moves stage to interview', async () => {
  // ...request + ingest as above, read first slot...
  const slot = (await call('GET', '/api/ats/interview/slots?application_id=' + SEED_APP_ID + '&now=2026-07-01T00:00:00Z')).body.slots[0];
  const res = await call('POST', '/api/ats/interview/book', { application_id: SEED_APP_ID, slot_start_utc: slot.startUtc });
  expect(res.body.ok).toBe(true);
  const row = readDb().scheduledCalls.find(r=>r.meeting_kind==='interview');
  expect(row.status).toBe('booked');
  expect(row.gcal_event_id).toBeTruthy();
  expect(row.zoom_join_url).toBeTruthy();
  const app = readDb().atsApplications.find(a=>a.id===SEED_APP_ID);
  expect(app.ats_stage).toBe('interview');
  // a busy entry now exists on the fake calendar
  expect(readDb().fakeCalendar.length).toBe(1);
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement.**
  - **slots:** load interview row + app context; if `practice_availability_status` is `received`/`defaulted`, build configs (host=DEFAULT_HOST_CONFIG; practice=DEFAULT_PRACTICE_CONFIG + `overrides` from stored windows + tz from `practiceTzForLocation`; gp=DEFAULT_GP_CONFIG + tz from `gpTzForCountry`); `busy = await gcalReadBusy({fromUtc: now, toUtc: now+14d})` plus existing interview rows for the host; `computeInterviewSlots(...)`. Accept an optional `&now=` param (test only; default real now). Return slots.
  - **book:** re-run slots, assert `slot_start_utc` is still present (else 409 "slot no longer available"); `createZoomInterviewMeeting`; `gcalCreateEvent` (attendees = GP + practice emails; summary "Interview — Dr X @ Practice"); update row: `status='booked'`, `scheduled_at`, `zoom_*`, `gcal_event_id`, `booked_at`; `atsUpdateApplicationStageRow(appId,'interview',...)` + it records the stage event; notify GP + practice with the confirmed time in each local tz. Idempotent: if already booked, return the existing booking.

- [ ] **Step 4: Tests pass. Full suite. Commit.**

```bash
git add server.js tests/interview-endpoints.test.js
git commit -m "Interview slots + booking: 3-way picker, Zoom + Google Calendar write, stage move"
```

---

## Task 7: `GET /api/ceo/meetings` + candidate `apps[]` extension

**Files:**
- Modify: `server.js` — `GET /api/ceo/meetings`; extend the `apps` builder in `GET /api/ceo/candidate` (~23217–23228).
- Test: `tests/ceo-meetings-endpoints.test.js`

**Interfaces:**
- Produces:
  - `GET /api/ceo/meetings?kind=all|consultation|interview` → `{ ok, meetings: [normalizeMeetingForApi(row) + gp_name + scheduled_at + meeting_summary] }`, host meetings only (`host_kind='ceo'`), abandoned drafts filtered (reuse the consultation rule: `status==='cancelled' && !scheduled_at && !booked_at`).
  - `apps[]` each gains `interview: { status, scheduled_at, summary } | null` and `offer: { status: 'not_started', label: '—' }`.

- [ ] **Step 1: Failing tests** — assert filtering by `kind`, host-only scoping, abandoned-draft exclusion, and that a candidate's `apps[0].interview` reflects a booked interview + `apps[0].offer.status==='not_started'`.

- [ ] **Step 2–4:** Implement (dual-mode: prod groups `scheduled_calls` where `host_kind='ceo'` + optional `meeting_kind`; local filters `dbState.scheduledCalls`; for `apps[].interview`, prod joins `scheduled_calls` on `application_id`+`meeting_kind='interview'`, local reads `dbState.scheduledCalls`). Tests pass, full suite green, commit.

```bash
git add server.js tests/ceo-meetings-endpoints.test.js
git commit -m "CEO meetings endpoint + per-application interview summary/offer placeholder"
```

---

## Task 8: UI — Book interview button (`js/ceo-ats-jobs.js`)

**Files:**
- Modify: `js/ceo-ats-jobs.js` — re-add the button where `atsJobSchedBtn` was removed; replace `openInterviewModal`/`interviewModalHtml`/`submitInterview` (old manual modal) with a confirm that POSTs `/api/ats/interview/request`.
- Modify: `pages/ceo-dashboard.html` — bump `ceo-ats-jobs.js?v=20260630a`.

- [ ] **Step 1:** In the job pipeline drawer card render, where the comment "Interview scheduling is intentionally not surfaced yet…" sits, add:
  `'<button class="ats-btn ats-btn-primary" id="atsJobSchedBtn">📅 Book interview</button>'`.
- [ ] **Step 2:** Replace `openInterviewModal` with:

```javascript
function openInterviewModal() {
  if (!drawerCardId) return;
  if (!window.confirm('Send this candidate\'s practice an availability request and start interview scheduling?')) return;
  ATS.api('POST', '/api/ats/interview/request', { application_id: drawerCardId }).then(function (r) {
    if (r && r.ok) { ATS.toast(r.already ? 'Interview already in progress.' : 'Availability request sent to the practice.'); }
    else { ATS.toast('Could not start interview scheduling.', true); }
  });
}
```

Keep the existing `on('atsJobSchedBtn','click',openInterviewModal)` listener. Delete `interviewModalHtml`/`submitInterview` and the modal append. (Use the real `ATS.api`/`ATS.toast` names from `js/ceo-ats-shared.js`; if different, match them.)

- [ ] **Step 3:** `node --check` is N/A for browser JS; verify by loading the page in the Task 11 screenshot harness. Commit.

```bash
git add js/ceo-ats-jobs.js pages/ceo-dashboard.html
git commit -m "ATS: re-add Book interview button → POST /api/ats/interview/request"
```

---

## Task 9: UI — GP slot picker (candidate-facing)

**Files:**
- Modify: `js/ceo-ats-candidates.js` (or the GP-facing page that shows interview prompts — subagent confirms where the GP sees ATS prompts; if GP-facing lives elsewhere, add a small module there). For this preview, surface the picker inside the candidate detail view under the application, AND expose `window.atsRenderSlotPicker(applicationId, host)` reusable by the GP page.
- Modify: `css/ceo-ats.css` — `.ats-slot-grid`, `.ats-slot` styles.

- [ ] **Step 1:** Add a "Pick interview time" control on an application whose interview `status` is awaiting GP pick. On click, `GET /api/ats/interview/slots?application_id=…`, render slot buttons each labeled with `slot.local.gp.label` + a small "(your local time)" note.
- [ ] **Step 2:** On slot click, `POST /api/ats/interview/book {application_id, slot_start_utc}`; on success show "Interview booked for <gp local time>" and refresh the application.
- [ ] **Step 3:** Commit.

```bash
git add js/ceo-ats-candidates.js css/ceo-ats.css pages/ceo-dashboard.html
git commit -m "UI: GP interview slot picker (pre-cleared 3-way slots, GP-local times)"
```

---

## Task 10: UI — Meetings master tab

**Files:**
- Create: `js/ceo-ats-meetings.js`
- Modify: `pages/ceo-dashboard.html` — add the `Meetings` nav item + `#panel-meetings` + `<script src="js/ceo-ats-meetings.js?v=20260630a">`; bump `css/ceo-ats.css?v=20260630a`.
- Modify: `css/ceo-ats.css` — meeting list/group/row styles (reuse `.calls-*` look).
- Modify: `js/ceo-ats-shared.js` — register `#meetings` route in the tab switcher + hash router.

- [ ] **Step 1:** Build `loadMeetingsTab()` mirroring the RSO calls structure: filter chips (All / Standard consultation / Interview) + groups Upcoming / Past / Summaries. Fetch `GET /api/ceo/meetings?kind=…`. Classify with the existing consultation logic (Upcoming = invited/booked; Past = completed/no_show/cancelled minus abandoned drafts; Summaries = completed with `meeting_summary`). Render each row: GP name, type pill, Sydney time + GP-local time, status, Join link when booked + zoom URL; clicking a completed row shows the saved summary.
- [ ] **Step 2:** Wire the tab switch + hash deep-link `#meetings` (mirror `#candidates`/`#board=`).
- [ ] **Step 3:** Commit.

```bash
git add js/ceo-ats-meetings.js js/ceo-ats-shared.js pages/ceo-dashboard.html css/ceo-ats.css
git commit -m "UI: CEO Meetings master tab (consultations + interviews, filter + summaries)"
```

---

## Task 11: UI — Applications section on candidate detail

**Files:**
- Modify: `js/ceo-ats-candidates.js` — promote the apps list (`pipelineCardInner` ~369–405) into a dedicated **Applications** card after the pipeline card; per app show stage (existing pill + dropdown), interview status/summary (`a.interview`), and offer/contract placeholder (`a.offer`).
- Modify: `css/ceo-ats.css` — `.ats-app-card`, `.ats-app-interview`, `.ats-app-offer`.

- [ ] **Step 1:** Add `applicationsCardInner(c)` rendering one block per `c.apps[]`: title/practice, stage pill + the existing `select.ats-app-stage`, an "Interview" line (`a.interview ? (status + scheduled_at + summary) : 'Not scheduled'` with the Book-interview/Pick-time affordance), and an "Offer / contract" line showing `a.offer.label` ("—"). Insert into `detailHtml`.
- [ ] **Step 2:** Keep `wireDetailEvents` stage-change + add-job handlers working; add the slot-picker trigger from Task 9.
- [ ] **Step 3:** Commit.

```bash
git add js/ceo-ats-candidates.js css/ceo-ats.css pages/ceo-dashboard.html
git commit -m "UI: per-application Applications section (stage + interview summary + offer placeholder)"
```

---

## Task 12: Seed + screenshots + owner setup doc + final regression

**Files:**
- Modify: `scripts/seed-ats-dev.js` — ensure one application is interview-ready (a `received` interview row with windows) and a `dbState.fakeCalendar` entry, so the picker + Meetings tab render offline.
- Create: `docs/owner-setup-interview-scheduling.md`
- Use: the screenshot harness `/Users/gplinkrecruitment/.claude/jobs/02d7925b/tmp/shot.js` (extend to capture `#meetings`, the Applications section, and the slot picker).

- [ ] **Step 1:** Extend the seed; run `node scripts/seed-ats-dev.js`.
- [ ] **Step 2:** Run the full suite `vitest run` → all green (target: prior 753 + new tests).
- [ ] **Step 3:** Screenshot `#meetings` (All / Consultation / Interview), a candidate's Applications section, and the slot picker via the gated-page harness.
- [ ] **Step 4:** Write `docs/owner-setup-interview-scheduling.md` — click-by-click: (1) connect Google Calendar to Calendly conflict-checking; (2) grant the app Calendar access / set `GOOGLE_CALENDAR_ID` + Calendar scope; (3) confirm Calendly adds consultations to that calendar; (4) confirm Zoom create-meeting scope + AI Companion on; (5) set any new env vars in Vercel ([[vercel-api-access]]).
- [ ] **Step 5:** Commit + push the branch.

```bash
git add scripts/seed-ats-dev.js docs/owner-setup-interview-scheduling.md
git commit -m "Interview scheduling: dev seed + owner setup doc + screenshots"
GIT_SSH_COMMAND='ssh -i ~/.ssh/gplink_deploy -o IdentitiesOnly=yes' git push origin worktree-ats-prototype
```

---

## Deployment (after owner approves the build)
1. Apply `20260630120000_interview_meetings.sql` to the shared Supabase via `exec_sql` ([[supabase-migrations-exec-sql]]); `NOTIFY pgrst,'reload schema'`.
2. Set env: `GOOGLE_CALENDAR_ID`, the Google Calendar scope on the existing Google creds, confirm Zoom `meeting:write`. ([[vercel-api-access]])
3. Owner completes `docs/owner-setup-interview-scheduling.md`.
4. Merge to `main` only on explicit owner say-so (consistent with the ATS restructure).

## Self-review notes (author)
- **Spec coverage:** §4 source-of-truth → Tasks 3,6,7; §5 engine → Task 2; §5.4 practice email/AI → Tasks 4,5; §6 model → Tasks 1,3; §7 flow → Tasks 4–6; §9 Meetings → Task 10; §10 Applications → Tasks 7,11; §11 APIs → Tasks 4–7; §12 setup → Task 12; §13 testing → every task + Task 12. No section unmapped.
- **Type consistency:** `computeInterviewSlots` slot shape (`{startUtc,endUtc,local:{host,practice,gp}}`) is identical in Task 2 producer and Tasks 6/9 consumers; `buildInterviewRow` fields match the migration columns; `gcalReadBusy` busy shape (`{startUtc,endUtc}`) matches the scheduler's `busy` input.
- **Open verifications (carry into execution):** exact Google auth helper name + whether Calendar scope is grantable on existing creds (Task 3); exact practice-email-send + hub-reply-ingest hook names (Tasks 4,5); exact `ATS.api`/`ATS.toast` + tab-switcher names (Tasks 8–11); GP-facing surface for the picker (Task 9).
