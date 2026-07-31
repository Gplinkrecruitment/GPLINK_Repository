// Owner decision 2026-07-31 — the "paste the practice's emailed reply" route.
//
// Practices can either use the buttons in our email (a form, fully checked) or
// just write back in English. For the second case an operator pastes the text
// into the candidate's card and an AI turns it into dates and times.
//
// That second path had none of the first path's safeguards:
//   1. NO validation — raw model output went straight to the row, so a misread
//      month was saved, the card said "times received", and the doctor was
//      offered nothing because the scheduler never looks that far ahead.
//   2. NO timezone recorded — the interpretation was re-derived on every read,
//      so editing the practice's state later silently changed what already-
//      saved times meant. The AI was also told to use Sydney for every
//      practice in the country.
//   3. It REPLACED rather than added — a practice that submitted three days by
//      form and then emailed "we can also do Friday" ended up with Friday
//      alone, no warning and no way back.
//
// Runs against the local-JSON path (no Supabase, no ANTHROPIC_API_KEY), so the
// deterministic fallback parser is used and nothing touches the network.
//
// NOTE ON SEEDING: server.js loads the local database into memory when it is
// imported, so every row has to exist BEFORE that import — writing the file
// afterwards is invisible to it. Hence the fixed row ids below.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ingest-safety-${RUN_ID}.json`);

// A fixed "now" the whole test reasons from. The route parses the reply
// relative to this and — since the fix — judges the result against it too.
const NOW = '2026-07-01T00:00:00Z';
const inDays = (n) => new Date(Date.parse(NOW) + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// 'weekdays 6-10pm' from 1 Jul lands on every weekday in the next 14 days.
// The first two fall inside the 48-hour notice period, so they must be
// refused — which is exactly the "reported, not silently dropped" case.
const REPLY = 'weekdays 6-10pm';
const PRE_EXISTING = { date: inDays(4), fromMin: 540, toMin: 720, tz: 'Australia/Perth' };

function row(id, extra) {
  return Object.assign({
    id, meeting_kind: 'interview', status: 'invited',
    application_id: null, user_id: null, case_id: null,
    practice_name: 'Perth Family Medical',
    practice_availability_status: 'requested',
    practice_availability_windows: null
  }, extra || {});
}

const TEN_EXISTING = [];
for (let i = 2; i <= 11; i++) TEN_EXISTING.push({ date: inDays(i), fromMin: 540, toMin: 600, tz: 'Australia/Perth' });

let ingest, testUtils;
const readRow = (id) => (JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).scheduledCalls || []).find((r) => r.id === id);

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'ingest-safety-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ANTHROPIC_API_KEY = '';   // force the deterministic fallback parser
  process.env.DB_FILE_PATH = DB_FILE;

  fs.writeFileSync(DB_FILE, JSON.stringify({
    scheduledCalls: [
      row('iv-clean'),
      row('iv-unreadable'),
      row('iv-tz'),
      row('iv-merge', { practice_availability_windows: [PRE_EXISTING], practice_availability_status: 'received' }),
      row('iv-replace', { practice_availability_windows: [PRE_EXISTING], practice_availability_status: 'received' }),
      row('iv-dupe'),
      row('iv-overflow', { practice_availability_windows: TEN_EXISTING, practice_availability_status: 'received' })
    ]
  }));

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  ingest = testUtils.ingestPracticeAvailabilityReply;
  expect(typeof ingest).toBe('function');
});

describe('1 — the AI’s answer is checked before it is saved', () => {
  it('keeps only usable windows, and every one the parser produced is accounted for', async () => {
    const res = await ingest('iv-clean', REPLY, NOW);
    expect(res).toBeTruthy();

    const saved = readRow('iv-clean').practice_availability_windows;
    expect(Array.isArray(saved)).toBe(true);
    expect(saved.length).toBeGreaterThan(0);
    // Nothing saved is outside the bookable range.
    saved.forEach((w) => {
      expect(w.date >= inDays(2)).toBe(true);
      expect(w.date <= inDays(14)).toBe(true);
    });
    // Nothing vanished without being counted — the whole point.
    expect(res.parsed).toBe(res.added + res.dropped.length + res.duplicates + res.overflow);
    // The dates inside the notice period were refused, WITH a reason.
    expect(res.dropped.length).toBeGreaterThan(0);
    res.dropped.forEach((d) => expect(String(d.reason || '')).not.toBe(''));
  });

  it('applies the same rules the practice’s own form gets', async () => {
    const bounds = testUtils.practiceAvailabilityDateBounds(Date.parse(NOW));
    const check = testUtils.validateOnePracticeAvailabilityWindow;
    expect(check({ date: inDays(40), fromMin: 1080, toMin: 1200 }, bounds)).toMatch(/between/);   // beyond the horizon
    expect(check({ date: inDays(0), fromMin: 1080, toMin: 1200 }, bounds)).toMatch(/between/);    // inside the notice period
    expect(check({ date: inDays(5), fromMin: 1200, toMin: 1080 }, bounds)).toMatch(/finish after it starts/);
    expect(check({ date: 'not-a-date', fromMin: 1080, toMin: 1200 }, bounds)).toBeTruthy();
    expect(check({ date: inDays(5), fromMin: 1080, toMin: 1200 }, bounds)).toBeNull();            // the good one
  });

  // ⚠️ KNOWN GAP, pinned rather than fixed — found while testing the above and
  // deliberately left alone because it was outside the agreed scope.
  //
  // _parseAvailabilityFallback has no "I could not read this" answer. With no
  // day signal it assumes EVERY weekday in the horizon; with no time signal it
  // assumes 17:00-21:00. So a reply that mentions no times at all still yields
  // availability the practice never offered, and a doctor could book into a
  // slot nobody at the practice is expecting.
  //
  // It only bites when ANTHROPIC_API_KEY is unset — the AI path returns [] when
  // it cannot extract anything, and production has a key. Recorded here so the
  // behaviour is visible and cannot change unnoticed.
  it('KNOWN GAP: with no AI key, a reply containing no times still invents weekday evenings', async () => {
    const res = await ingest('iv-unreadable', 'thanks for getting in touch, we will come back to you shortly', NOW);
    expect(res.added).toBeGreaterThan(0);
    expect(readRow('iv-unreadable').practice_availability_status).toBe('received');
    // The invented windows are at least sane — the new validation still applies.
    readRow('iv-unreadable').practice_availability_windows.forEach((w) => {
      expect(w.date >= inDays(2)).toBe(true);
      expect(w.date <= inDays(14)).toBe(true);
    });
  });
});

describe('2 — the timezone the times were meant in is recorded', () => {
  it('stamps the practice’s own zone on every window it saves', async () => {
    const res = await ingest('iv-tz', REPLY, NOW);
    expect(res.tz).toBe('Australia/Perth');
    const saved = readRow('iv-tz').practice_availability_windows;
    expect(saved.length).toBeGreaterThan(0);
    saved.forEach((w) => expect(w.tz).toBe('Australia/Perth'));
  });

  it('the AI is told THIS practice’s zone, not Sydney for everyone', () => {
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const idx = serverSrc.indexOf('async function _parseAvailabilityViaAI');
    const fnSrc = serverSrc.slice(idx, idx + 3000);
    expect(fnSrc).toContain('function _parseAvailabilityViaAI(replyText, nowIso, practiceTz)');
    expect(fnSrc).toContain("sanitizeViewerTz(practiceTz) || 'Australia/Sydney'");
    expect(fnSrc).toContain("Use ' + tzLabel + ' time");
    // ...and it asks for the window the scheduler will actually read.
    expect(fnSrc).toContain('interviewMeetings.INTERVIEW_HORIZON_DAYS');
    expect(fnSrc).toContain('interviewMeetings.INTERVIEW_LEAD_HOURS');
  });
});

describe('3 — pasting ADDS to what the practice already gave us', () => {
  it('does not wipe windows submitted through the form', async () => {
    const res = await ingest('iv-merge', REPLY, NOW);
    const saved = readRow('iv-merge').practice_availability_windows;
    // The original survives — this is the whole point.
    expect(saved.some((w) => w.date === PRE_EXISTING.date && w.fromMin === 540 && w.toMin === 720)).toBe(true);
    expect(saved.length).toBeGreaterThan(1);
    expect(res.mode).toBe('add');
    expect(res.added).toBeGreaterThan(0);
  });

  it('replace is available, but only when explicitly asked for', async () => {
    const res = await ingest('iv-replace', REPLY, NOW, { mode: 'replace' });
    const saved = readRow('iv-replace').practice_availability_windows;
    expect(res.mode).toBe('replace');
    expect(saved.some((w) => w.date === PRE_EXISTING.date && w.fromMin === 540)).toBe(false);
  });

  it('pasting the same email twice does not duplicate anything', async () => {
    const first = await ingest('iv-dupe', REPLY, NOW);
    const countAfterFirst = readRow('iv-dupe').practice_availability_windows.length;
    expect(first.added).toBeGreaterThan(0);

    const second = await ingest('iv-dupe', REPLY, NOW);
    expect(readRow('iv-dupe').practice_availability_windows).toHaveLength(countAfterFirst);
    expect(second.added).toBe(0);
    expect(second.duplicates).toBe(first.added);
  });

  it('never stores more than the 10 the form allows, and says how many missed out', async () => {
    const res = await ingest('iv-overflow', REPLY, NOW);
    expect(readRow('iv-overflow').practice_availability_windows.length).toBeLessThanOrEqual(10);
    expect(res.overflow).toBeGreaterThan(0);
  });
});

describe('the operator can see what happened', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const uiSrc = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-candidates.js'), 'utf8');

  it('the endpoint reports added / ignored / timezone, not just a count', () => {
    const idx = serverSrc.indexOf("pathname === '/api/ats/interview/ingest-reply'");
    expect(idx).toBeGreaterThan(-1);
    const routeSrc = serverSrc.slice(idx, idx + 4500);
    expect(routeSrc).toContain('mode: ingMode');
    expect(routeSrc).toContain('dropped:');
    expect(routeSrc).toContain('practice_tz:');
  });

  it('the paste box offers add-or-replace, defaulting to add', () => {
    expect(uiSrc).toContain('name="ats-paste-mode" value="add" checked');
    expect(uiSrc).toContain('name="ats-paste-mode" value="replace"');
    expect(uiSrc).toContain('mode: mode');
  });

  it('the confirmation tells the operator what was ignored and why', () => {
    expect(uiSrc).toContain('r.dropped.length');
    expect(uiSrc).toContain('ignored:');
    expect(uiSrc).toContain('read as ');
  });

  it('the changed script is cache-busted, or the dashboard keeps serving the old one', () => {
    const dash = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');
    expect(dash).toContain('ceo-ats-candidates.js?v=20260731d');
    expect(dash).not.toContain('ceo-ats-candidates.js?v=20260730c');
    expect(dash).not.toContain('ceo-ats-candidates.js?v=20260731b');
  });
});
