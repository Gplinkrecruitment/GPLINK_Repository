// TDD test file for Task 7: GET /api/ceo/meetings + candidate apps[] extension.
// Mirrors the bootstrap pattern in tests/interview-endpoints.test.js.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-mtg-${RUN_ID}.json`);
const SUPER_HOST = 'ats-test.local';

// IDs for the seeded calls; keep them deterministic so assertions can reference them.
const CEO_INTERVIEW_ID   = 'sc_ceo_int_' + RUN_ID;
const CEO_CONSULT_ID     = 'sc_ceo_con_' + RUN_ID;
const RSO_CONSULT_ID     = 'sc_rso_con_' + RUN_ID;
const CEO_DRAFT_ID       = 'sc_ceo_dft_' + RUN_ID;
// An unsolicited Calendly booking: no user_id / case_id, name only knowable via the lead row.
const CEO_DIRECT_ID      = 'sc_ceo_dir_' + RUN_ID;
const DIRECT_EMAIL       = 'khaleedmahmoud1211@gmail.com';
// The lead row carries ip + user_agent in metadata, exactly as the real capture
// paths write them, so the privacy assertion has something real to catch.
const PRIVATE_IP         = '203.0.113.77';
const PRIVATE_UA         = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) SecretAgent/1.0';
const DIRECT_NOTES       = 'Please share your phone number for contact via WhatsApp: +61 406 281 243';
const DIRECT_QUESTION    = 'testing123';
const DIRECT_PHONE       = '0406281243';
// c1 is seeded by seed-ats-dev.js (application id 'c1', career_role_id 'j1').
const SEED_APP_ID        = 'c1';

let server, port;

function b64url(s) {
  return Buffer.from(String(s), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function superCookie() {
  const payload = b64url(JSON.stringify({
    userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' },
    expiresAt: Date.now() + 3600000
  }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}

function httpReq(method, p, { host, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (host)   headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject); r.end(data);
  });
}

const call       = (method, p, body) => httpReq(method, p, { host: SUPER_HOST, cookie: superCookie(), body });
const callNoAuth = (method, p, body) => httpReq(method, p, { host: SUPER_HOST, body });

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV      = 'true';
  process.env.NODE_ENV               = 'test';
  process.env.AUTH_SECRET            = 'int-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB    = 'false';
  process.env.SUPABASE_URL           = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN    = 'false';
  process.env.DB_FILE_PATH           = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS     = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS           = '';

  // 1. Seed standard ATS data (practices, jobs, applications, candidates).
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-ats-dev.js')], {
    env: { ...process.env, DB_FILE_PATH: DB_FILE }
  });

  // 2. Inject scheduledCalls fixtures:
  //    - a CEO interview (booked, has meeting_summary, linked to app c1)
  //    - a CEO consultation (completed)
  //    - an RSO consultation (must be EXCLUDED from /api/ceo/meetings)
  //    - a CEO abandoned draft (status=cancelled, no scheduled_at/booked_at, EXCLUDED)
  const state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  state.scheduledCalls = [
    {
      id: CEO_INTERVIEW_ID,
      meeting_kind: 'interview',
      host_kind: 'ceo',
      application_id: SEED_APP_ID,
      case_id: 'g6',           // Dr Aisha Khan is seeded at id g6 and has app c1
      status: 'booked',
      scheduled_at: '2026-07-10T09:00:00.000Z',
      booked_at: '2026-07-01T08:00:00.000Z',
      meeting_summary: 'Candidate presented well. Strong fit for GP role.',
      gp_name: 'Dr Aisha Khan',
      created_at: '2026-07-01T07:00:00.000Z',
      updated_at: '2026-07-01T08:00:00.000Z'
    },
    {
      id: CEO_CONSULT_ID,
      meeting_kind: 'consultation',
      host_kind: 'ceo',
      application_id: null,
      case_id: 'g1',
      status: 'completed',
      scheduled_at: '2026-07-05T11:00:00.000Z',
      booked_at: '2026-07-01T06:00:00.000Z',
      meeting_summary: 'Great initial consultation.',
      gp_name: 'Dr Yuki Tanaka',
      created_at: '2026-07-01T06:00:00.000Z',
      updated_at: '2026-07-05T12:00:00.000Z'
    },
    {
      id: RSO_CONSULT_ID,
      meeting_kind: 'consultation',
      host_kind: 'rso',         // MUST be excluded, not the CEO's meeting
      // assigned to a DIFFERENT RSO than the test session email, so the assigned-email
      // branch of the scope filter does not pull it in.
      assigned_rso_email: 'other-rso@gplink-test.local',
      application_id: null,
      case_id: 'g2',
      status: 'completed',
      scheduled_at: '2026-07-04T10:00:00.000Z',
      booked_at: '2026-07-01T05:00:00.000Z',
      meeting_summary: 'RSO-hosted call.',
      gp_name: 'Dr Sofia Ramos',
      created_at: '2026-07-01T05:00:00.000Z',
      updated_at: '2026-07-04T11:00:00.000Z'
    },
    {
      id: CEO_DRAFT_ID,
      meeting_kind: 'consultation',
      host_kind: 'ceo',         // CEO-hosted but abandoned, MUST be excluded
      application_id: null,
      case_id: 'g3',
      status: 'cancelled',
      scheduled_at: null,       // no scheduled_at → abandoned draft
      booked_at: null,          // no booked_at → abandoned draft
      meeting_summary: null,
      gp_name: 'Dr Marcus Webb',
      created_at: '2026-07-01T04:00:00.000Z',
      updated_at: '2026-07-01T04:00:00.000Z'
    },
    {
      // The production bug: a stranger booked the owner's Calendly with no invite.
      // Shaped exactly like buildScheduledCallFromCalendly's output, null user_id
      // (no profile to read a name from) and host_kind 'ceo' (the visibility key).
      id: CEO_DIRECT_ID,
      meeting_kind: 'consultation',
      host_kind: 'ceo',
      application_id: null,
      case_id: null,
      user_id: null,
      stage: null,
      status: 'booked',
      invitee_email: DIRECT_EMAIL,
      // The Calendly booking questions & answers, plus the call's shape.
      invitee_notes: DIRECT_NOTES,
      timezone: 'Australia/Sydney',
      duration_minutes: 30,
      scheduled_at: '2026-07-20T04:30:00.000Z',
      booked_at: '2026-07-16T09:00:00.000Z',
      meeting_summary: null,
      created_at: '2026-07-16T09:00:00.000Z',
      updated_at: '2026-07-16T09:00:00.000Z'
    }
  ];
  // The lead row captured at booking time, the ONLY place this person's name,
  // phone, country answer and typed question exist. Shaped exactly like the
  // production row for this booker (screened via /start, then booked).
  state.siteEnquiries = [
    {
      id: 'se_direct_' + RUN_ID,
      created_at: '2026-07-16T09:00:00.000Z',
      kind: 'gp',
      name: 'Khaleed Mahmoud',
      email: DIRECT_EMAIL,
      phone: DIRECT_PHONE,
      state: 'uk',
      message: DIRECT_QUESTION,
      status: 'new',
      metadata: {
        source: 'site_start_form',
        ip: PRIVATE_IP,
        user_agent: PRIVATE_UA,
        consult: {
          is_gp: true, qualified: true, country: 'uk', call_booked: true,
          call_booked_at: '2026-07-16T09:00:00.000Z', nudges: [], token: 'tok_' + RUN_ID
        }
      }
    }
  ];
  fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));

  // 3. Boot server against the seeded file.
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

// ─── GET /api/ceo/meetings ──────────────────────────────────────────────────

describe('GET /api/ceo/meetings, kind=all', () => {
  it('returns exactly the 3 CEO non-draft meetings (excludes RSO + draft)', async () => {
    const res = await call('GET', '/api/ceo/meetings?kind=all');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const ids = (res.body.meetings || []).map((m) => m.id);
    expect(ids).toContain(CEO_INTERVIEW_ID);
    expect(ids).toContain(CEO_CONSULT_ID);
    expect(ids).toContain(CEO_DIRECT_ID);          // unsolicited booking, still the CEO's meeting
    expect(ids).not.toContain(RSO_CONSULT_ID);    // RSO-owned, must be excluded
    expect(ids).not.toContain(CEO_DRAFT_ID);       // abandoned draft, must be excluded
    expect(res.body.meetings.length).toBe(3);
  });

  it('each meeting has is_interview and meeting_kind_label fields (normalizeMeetingForApi applied)', async () => {
    const res = await call('GET', '/api/ceo/meetings?kind=all');
    expect(res.status).toBe(200);
    const interview = (res.body.meetings || []).find((m) => m.id === CEO_INTERVIEW_ID);
    expect(interview).toBeTruthy();
    expect(interview.is_interview).toBe(true);
    expect(interview.meeting_kind_label).toBe('Interview');
    const consult = (res.body.meetings || []).find((m) => m.id === CEO_CONSULT_ID);
    expect(consult.is_interview).toBe(false);
    expect(consult.meeting_kind_label).toBe('Standard consultation');
  });

  it('meetings carry gp_name + scheduled_at + meeting_summary', async () => {
    const res = await call('GET', '/api/ceo/meetings?kind=all');
    const interview = (res.body.meetings || []).find((m) => m.id === CEO_INTERVIEW_ID);
    expect(interview.gp_name).toBe('Dr Aisha Khan');
    expect(interview.scheduled_at).toBe('2026-07-10T09:00:00.000Z');
    expect(interview.meeting_summary).toBe('Candidate presented well. Strong fit for GP role.');
  });

  it('rejects without an admin session', async () => {
    const res = await callNoAuth('GET', '/api/ceo/meetings?kind=all');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/ceo/meetings, kind=interview', () => {
  it('returns only the interview meeting', async () => {
    const res = await call('GET', '/api/ceo/meetings?kind=interview');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.meetings.length).toBe(1);
    expect(res.body.meetings[0].id).toBe(CEO_INTERVIEW_ID);
    expect(res.body.meetings[0].meeting_kind).toBe('interview');
  });
});

describe('GET /api/ceo/meetings, kind=consultation', () => {
  it('returns only the consultation meetings', async () => {
    const res = await call('GET', '/api/ceo/meetings?kind=consultation');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.meetings.length).toBe(2);
    expect(res.body.meetings.map((m) => m.id).sort()).toEqual([CEO_CONSULT_ID, CEO_DIRECT_ID].sort());
    res.body.meetings.forEach((m) => expect(m.meeting_kind).toBe('consultation'));
  });
});

// ─── Regression: unsolicited Calendly booking (null user_id) ───────────────
// A GP booked the owner's Calendly with no correlation token; the webhook dropped
// the booking, so the meeting never reached this tab.
describe('GET /api/ceo/meetings, direct booking with null user_id', () => {
  it('appears in kind=consultation despite having no user_id/case_id', async () => {
    const res = await call('GET', '/api/ceo/meetings?kind=consultation');
    expect(res.status).toBe(200);
    const direct = (res.body.meetings || []).find((m) => m.id === CEO_DIRECT_ID);
    expect(direct).toBeTruthy();
    expect(direct.user_id).toBeNull();
    expect(direct.case_id).toBeNull();
    expect(direct.host_kind).toBe('ceo');
    expect(direct.status).toBe('booked');
    expect(direct.scheduled_at).toBe('2026-07-20T04:30:00.000Z');
  });

  it('resolves gp_name from the lead row, the UI must not render "-"', async () => {
    const res = await call('GET', '/api/ceo/meetings?kind=consultation');
    const direct = (res.body.meetings || []).find((m) => m.id === CEO_DIRECT_ID);
    expect(direct.gp_name).toBe('Khaleed Mahmoud');
    // js/ceo-ats-meetings.js renders `m.gp_name || '-'`.
    expect(direct.gp_name || '-').not.toBe('-');
  });

  it('is labelled a standard consultation, not an interview', async () => {
    const res = await call('GET', '/api/ceo/meetings?kind=consultation');
    const direct = (res.body.meetings || []).find((m) => m.id === CEO_DIRECT_ID);
    expect(direct.is_interview).toBe(false);
    expect(direct.meeting_kind_label).toBe('Standard consultation');
  });
});

// ─── Booking context on the meeting row ────────────────────────────────────
// The owner takes the call off this tab: the name + time alone are useless. The
// funnel already holds what they told us, what they asked, and how to ring them.
describe('GET /api/ceo/meetings, lead context', () => {
  it('attaches a lead object resolved from the booker email', async () => {
    const res = await call('GET', '/api/ceo/meetings?kind=all');
    const direct = (res.body.meetings || []).find((m) => m.id === CEO_DIRECT_ID);
    expect(direct.lead).toBeTruthy();
    expect(direct.lead.question).toBe(DIRECT_QUESTION);
    expect(direct.lead.phone).toBe(DIRECT_PHONE);
    expect(direct.lead.country).toBe('uk');
    expect(direct.lead.is_gp).toBe(true);
    expect(direct.lead.qualified).toBe(true);
    expect(direct.lead.source).toBe('site_start_form');
    expect(direct.lead.not_screened).toBe(false);
    expect(direct.lead.nudges_sent).toBe(0);
    expect(direct.lead.call_booked_at).toBe('2026-07-16T09:00:00.000Z');
  });

  it('keeps the Calendly booking answers + call shape on the row', async () => {
    const res = await call('GET', '/api/ceo/meetings?kind=all');
    const direct = (res.body.meetings || []).find((m) => m.id === CEO_DIRECT_ID);
    expect(direct.invitee_notes).toBe(DIRECT_NOTES);
    expect(direct.invitee_email).toBe(DIRECT_EMAIL);
    expect(direct.timezone).toBe('Australia/Sydney');
    expect(direct.duration_minutes).toBe(30);
  });

  it('a meeting with no matching lead still returns fine, with no lead object', async () => {
    const res = await call('GET', '/api/ceo/meetings?kind=all');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const consult = (res.body.meetings || []).find((m) => m.id === CEO_CONSULT_ID);
    expect(consult).toBeTruthy();
    expect(consult.lead).toBeUndefined();
    const interview = (res.body.meetings || []).find((m) => m.id === CEO_INTERVIEW_ID);
    expect(interview.lead).toBeUndefined();
    expect(interview.gp_name).toBe('Dr Aisha Khan'); // unchanged by the lead join
  });
});

// PRIVACY: site_enquiries.metadata holds the booker's IP + user agent. The lead
// projection is explicit precisely so these can never reach the browser; assert
// on the RAW body so a nested/renamed leak is still caught.
describe('GET /api/ceo/meetings, privacy', () => {
  it('never returns raw metadata.ip or metadata.user_agent', async () => {
    const res = await call('GET', '/api/ceo/meetings?kind=all');
    expect(res.status).toBe(200);
    expect(res.raw).not.toContain(PRIVATE_IP);
    expect(res.raw).not.toContain(PRIVATE_UA);
    expect(res.raw).not.toContain('SecretAgent');
    expect(res.raw).not.toContain('user_agent');
    expect(res.raw).not.toContain('"ip"');
    // And no meeting's lead carries a metadata blob at all.
    (res.body.meetings || []).forEach((m) => {
      if (!m.lead) return;
      expect(m.lead.metadata).toBeUndefined();
      expect(m.lead.ip).toBeUndefined();
      expect(m.lead.user_agent).toBeUndefined();
      expect(m.lead.token).toBeUndefined();
    });
  });

  it('keeps ip/user_agent out of every kind-filtered response too', async () => {
    for (const p of ['?kind=consultation', '?kind=interview']) {
      const res = await call('GET', '/api/ceo/meetings' + p);
      expect(res.raw).not.toContain(PRIVATE_IP);
      expect(res.raw).not.toContain(PRIVATE_UA);
    }
  });
});

// ─── Lead capture for a direct booker (safety) ─────────────────────────────
// Someone who books the public Calendly link answered NO screening questions. The
// consult-nudge cron skips rows where metadata.consult.qualified !== true, so this
// lead MUST stay unqualified, otherwise strangers (possibly practice owners) start
// receiving GP-targeted nudge emails.
describe('captureCalendlyDirectBookerLead, nudge safety', () => {
  const NOW = '2026-07-16T09:00:00.000Z';
  const NEW_EMAIL = 'stranger-' + RUN_ID + '@example.com';
  let testUtils, consultLead;

  beforeAll(async () => {
    testUtils = (await import('../server.js')).__testUtils;
    consultLead = (await import('../lib/consult-lead.js')).default;
  });

  it('creates a lead for a booker the funnel has never seen', async () => {
    await testUtils.captureCalendlyDirectBookerLead({
      nowIso: NOW, email: NEW_EMAIL, name: 'Jane Stranger', inviteeNotes: 'Curious about Australia'
    });
    const lead = await testUtils.findSiteEnquiryByEmail(NEW_EMAIL);
    expect(lead).toBeTruthy();
    expect(lead.name).toBe('Jane Stranger');
    expect(lead.metadata.source).toBe('calendly_direct');
  });

  it('records that they booked a call', async () => {
    const lead = await testUtils.findSiteEnquiryByEmail(NEW_EMAIL);
    expect(lead.metadata.consult.call_booked).toBe(true);
    expect(lead.metadata.consult.call_booked_at).toBe(NOW);
  });

  it('SAFETY: the lead is NOT qualified, so the nudge cron skips it', async () => {
    const lead = await testUtils.findSiteEnquiryByEmail(NEW_EMAIL);
    expect(lead.metadata.consult.qualified).toBeFalsy();
    expect(lead.metadata.consult.qualified).not.toBe(true);
    // The cron's own gate: `if (cnConsult.stopped || cnConsult.screened_out || cnConsult.qualified !== true) continue;`
    const cn = lead.metadata.consult;
    expect(cn.stopped || cn.screened_out || cn.qualified !== true).toBe(true);
  });

  it('SAFETY: nextConsultNudge never returns a due nudge, however long we wait', async () => {
    const lead = await testUtils.findSiteEnquiryByEmail(NEW_EMAIL);
    const createdAtMs = Date.parse(lead.created_at);
    // Well past every threshold in both sequences (max is 7 days).
    [1, 3, 49, 24 * 30].forEach((hours) => {
      expect(consultLead.nextConsultNudge({
        consult: lead.metadata.consult,
        createdAtMs,
        nowMs: createdAtMs + hours * 60 * 60 * 1000
      })).toBeNull();
    });
  });

  it('never issues a consult token to someone who was not screened', async () => {
    const lead = await testUtils.findSiteEnquiryByEmail(NEW_EMAIL);
    expect(lead.metadata.consult.token).toBeUndefined();
  });

  it('does not duplicate or clobber an existing lead (the /start funnel owns it)', async () => {
    const before = await testUtils.findSiteEnquiryByEmail(DIRECT_EMAIL);
    await testUtils.captureCalendlyDirectBookerLead({
      nowIso: '2026-07-17T09:00:00.000Z', email: DIRECT_EMAIL, name: 'Someone Else'
    });
    const rows = (await testUtils.listSiteEnquiryRows('', 'gp'))
      .filter((r) => String(r.email).toLowerCase() === DIRECT_EMAIL);
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe(before.name);
    expect(rows[0].metadata).toEqual(before.metadata);
  });
});

// ─── GET /api/ceo/candidate, apps[] extension ─────────────────────────────

describe('GET /api/ceo/candidate, apps[] has interview + offer', () => {
  // g6 = Dr Aisha Khan; she has app c1 which is linked to CEO_INTERVIEW_ID
  const CANDIDATE_ID = 'g6';

  it('returns apps[] with interview reflecting the booked CEO interview', async () => {
    const res = await call('GET', `/api/ceo/candidate?case_id=${CANDIDATE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const apps = res.body.candidate.apps;
    expect(Array.isArray(apps)).toBe(true);
    expect(apps.length).toBeGreaterThan(0);
    const app = apps.find((a) => a.id === SEED_APP_ID);
    expect(app).toBeTruthy();
    expect(app.interview).toBeTruthy();
    expect(app.interview.status).toBe('booked');
    expect(app.interview.scheduled_at).toBe('2026-07-10T09:00:00.000Z');
    expect(app.interview.summary).toBe('Candidate presented well. Strong fit for GP role.');
  });

  it('returns apps[] with offer placeholder (status=not_started)', async () => {
    const res = await call('GET', `/api/ceo/candidate?case_id=${CANDIDATE_ID}`);
    expect(res.status).toBe(200);
    const apps = res.body.candidate.apps;
    const app = apps.find((a) => a.id === SEED_APP_ID);
    expect(app).toBeTruthy();
    expect(app.offer).toBeTruthy();
    expect(app.offer.status).toBe('not_started');
    expect(app.offer.label).toBe('-');
  });

  it('returns interview:null for an app with no interview row', async () => {
    // g10 = Dr Emma Wilson; has app c10, no scheduledCalls seeded for her
    const res = await call('GET', '/api/ceo/candidate?case_id=g10');
    expect(res.status).toBe(200);
    const apps = res.body.candidate.apps;
    expect(Array.isArray(apps)).toBe(true);
    expect(apps.length).toBeGreaterThan(0);
    expect(apps[0].interview).toBeNull();
  });
});
