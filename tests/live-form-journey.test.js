// END TO END, against the FIVE REAL OPTIONS on the live Meta form
// ("GP Link — Overseas GP enquiry", screenshotted by the owner 2026-08-15):
//
//   Are you a currently registered GP?   Yes | No
//   Where did you complete your GP Training?
//       United Kingdom | Ireland | New Zealand | Australia | Somewhere else
//
// The question the owner actually asked is "will the form now properly work and take
// them to the appropriate page on our website?", so this test answers that question
// rather than a proxy for it: it posts each real answer at the real webhook and asserts
// what the doctor receives and which screen she lands on.
//
// Meta delivers each choice as a snake_cased slug of the label the owner typed
// (proven: the stored prod row for lead 1044950714846926 holds `united_kingdom`, and the
// question labels in the same payload are slugged identically). Those slugs are used
// verbatim below - do NOT "tidy" them into display text, or this stops testing the thing
// that broke.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import fs from 'fs';

const RUN_ID = 'live-form-journey-' + process.pid;
const DB_FILE = './data/test-' + RUN_ID + '.json';

let server, addrPort, resendServer, sentEmails = [];

function post(path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request({
      host: '127.0.0.1', port: addrPort, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(extraHeaders || {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* leave null */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: addrPort, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* leave null */ }
        resolve({ status: res.statusCode, json });
      });
    }).on('error', reject);
  });
}

const FORM_ID = 'FORM-LIVE';

// The live form's field keys, verbatim from the stored prod row.
function leadFor(trainingSlug, gpSlug, email) {
  return {
    entry: [{ changes: [{ value: {
      leadgen_id: 'L-' + Math.random().toString(36).slice(2),
      form_id: FORM_ID,
      field_data: [
        { name: 'full_name', values: ['Test Doctor'] },
        { name: 'email', values: [email] },
        { name: 'phone_number', values: ['+447700900123'] },
        { name: 'are_you_a_currently_registered_gp?', values: [gpSlug] },
        { name: '_where_did_you_complete_your_gp_training?', values: [trainingSlug] },
        { name: "anything_you'd_like_us_to_cover_on_the_call?", values: ['pay and schools'] }
      ]
    } }] }]
  };
}

beforeAll(async () => {
  await new Promise((resolve) => {
    resendServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try { sentEmails.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { /* ignore */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'stub' }));
      });
    }).listen(0, '127.0.0.1', resolve);
  });

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.FB_LEAD_WEBHOOK_SECRET = 'test-secret';
  process.env.FB_GP_LEAD_FORM_IDS = FORM_ID;
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_API_URL = 'http://127.0.0.1:' + resendServer.address().port + '/emails';

  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  addrPort = server.address().port;
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (resendServer) await new Promise((r) => resendServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch { /* fine */ }
});

async function submit(trainingSlug, email) {
  sentEmails = [];
  const res = await post('/api/webhooks/facebook-lead?secret=test-secret',
    leadFor(trainingSlug, 'yes', email));
  expect(res.status).toBe(200);
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const row = (db.siteEnquiries || []).find((r) => r.email === email);
  return { row, consult: row && row.metadata.consult, emails: sentEmails.slice() };
}

describe('the four eligible choices reach the booking calendar', () => {
  for (const [label, slug, expected] of [
    ['United Kingdom', 'united_kingdom', 'uk'],
    ['Ireland', 'ireland', 'ie'],
    ['New Zealand', 'new_zealand', 'nz'],
    // Owner, 2026-08-15: an Australian-trained GP does not need the expedited
    // pathway, but she is still placeable, so she must be able to book.
    ['Australia', 'australia', 'au']
  ]) {
    it(`"${label}" qualifies, is emailed a booking link, and that link opens the calendar`, async () => {
      const email = slug + '@example.com';
      const { consult, emails } = await submit(slug, email);

      // 1. Screened correctly.
      expect(consult.qualified).toBe(true);
      expect(consult.country).toBe(expected);
      expect(consult.screened_out).toBeUndefined();
      expect(consult.token).toBeTruthy();

      // 2. She is emailed her booking link, unprompted.
      const toHer = emails.filter((e) => JSON.stringify(e.to || '').includes(email));
      expect(toHer.length).toBeGreaterThan(0);
      expect(JSON.stringify(toHer[0])).toContain(consult.token);

      // 3. Opening that link identifies her, so /start shows the calendar and asks
      //    her to type nothing. `qualified: true` is what drives loadCalendly().
      const landed = await get('/api/public/consult-lead?token=' + encodeURIComponent(consult.token));
      expect(landed.status).toBe(200);
      expect(landed.json.qualified).toBe(true);
      expect(landed.json.email).toBe(email);
    });
  }
});

describe('only \"Somewhere else\" reaches the turndown', () => {
  for (const [label, slug] of [
    ['Somewhere else', 'somewhere_else']
  ]) {
    it(`"${label}" is declined, gets no booking link, and is not left undecided`, async () => {
      const email = slug + '@example.com';
      const { consult, emails } = await submit(slug, email);

      expect(consult.qualified).toBe(false);
      expect(consult.screened_out).toBe(true);
      // Where they trained IS the governing fact (MRCGP alone is not enough for the
      // expedited pathway - the CCT comes from completing training there). "Somewhere
      // else" is therefore a real decline, not a near-miss for the review queue.
      expect(consult.country_unknown).toBeUndefined();
      expect(consult.token).toBeUndefined();

      // No booking link is emailed to a doctor we cannot place.
      const toHer = emails.filter((e) => JSON.stringify(e.to || '').includes(email));
      expect(toHer.length).toBe(0);
    });
  }
});

describe('what the doctor is shown on /start', () => {
  it('a declined doctor is marked declined, not undecided, so she gets the turndown', async () => {
    const email = 'elsewhere-match@example.com';
    await submit('somewhere_else', email);
    const r = await post('/api/public/consult-lead/match', { email });
    expect(r.status).toBe(200);
    expect(r.json.found).toBe(true);
    expect(r.json.qualified).toBe(false);
    expect(r.json.undecided).toBeFalsy(); // -> #bookTurndown
  });

  it('an eligible doctor is recognised as qualified, so she gets the calendar', async () => {
    const email = 'uk-match@example.com';
    await submit('united_kingdom', email);
    const r = await post('/api/public/consult-lead/match', { email });
    expect(r.status).toBe(200);
    expect(r.json.qualified).toBe(true);
    expect(r.json.token).toBeTruthy(); // -> loadCalendly()
  });
});

// The owner is duplicating the Meta form with "are you a currently registered GP?"
// REMOVED, leaving only the training question. That payload has never hit the
// webhook, so prove it works BEFORE the form goes live rather than discovering it
// through a week of leads that were never contacted. The field is not merely empty
// here — it is absent entirely, which is what Meta actually sends.
function leadNoGpQuestion(trainingSlug, email) {
  return {
    entry: [{ changes: [{ value: {
      leadgen_id: 'L-' + Math.random().toString(36).slice(2),
      form_id: FORM_ID,
      field_data: [
        { name: 'full_name', values: ['Test Doctor'] },
        { name: 'email', values: [email] },
        { name: 'phone_number', values: ['+447700900123'] },
        { name: '_where_did_you_complete_your_gp_training?', values: [trainingSlug] },
        { name: "anything_you'd_like_us_to_cover_on_the_call?", values: ['pay and schools'] }
      ]
    } }] }]
  };
}

async function submitNoGpQuestion(trainingSlug, email) {
  sentEmails = [];
  const res = await post('/api/webhooks/facebook-lead?secret=test-secret',
    leadNoGpQuestion(trainingSlug, email));
  expect(res.status).toBe(200);
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const row = (db.siteEnquiries || []).find((r) => r.email === email);
  return { row, consult: row && row.metadata.consult, emails: sentEmails.slice() };
}

describe('the new one-question form (no "are you a registered GP?")', () => {
  it('a UK-trained doctor still qualifies and is emailed her booking link', async () => {
    const email = 'newform-uk@example.com';
    const { consult, emails } = await submitNoGpQuestion('united_kingdom', email);
    expect(consult.qualified).toBe(true);
    expect(consult.country).toBe('uk');
    expect(consult.screened_out).toBeUndefined();
    expect(consult.country_unknown).toBeUndefined();
    expect(consult.token).toBeTruthy();
    // The point of the whole change: she qualifies on her ANSWER. Her +44 number
    // must not be what rescued her, or a GP on an overseas number is still lost.
    expect(consult.country_inferred_from_phone).toBeUndefined();
    const toHer = emails.filter((e) => JSON.stringify(e.to || '').includes(email));
    expect(toHer.length).toBeGreaterThan(0);
  });

  it('an overseas number does not stop a UK-trained doctor qualifying', async () => {
    const email = 'newform-overseas-phone@example.com';
    const payload = leadNoGpQuestion('united_kingdom', email);
    payload.entry[0].changes[0].value.field_data[2] = { name: 'phone_number', values: ['+919876543210'] };
    const res = await post('/api/webhooks/facebook-lead?secret=test-secret', payload);
    expect(res.status).toBe(200);
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const consult = (db.siteEnquiries || []).find((r) => r.email === email).metadata.consult;
    expect(consult.qualified).toBe(true);
    expect(consult.token).toBeTruthy();
  });

  it('"Somewhere else" is still declined without the GP question', async () => {
    const email = 'newform-elsewhere@example.com';
    const { consult, emails } = await submitNoGpQuestion('somewhere_else', email);
    expect(consult.qualified).toBe(false);
    expect(consult.screened_out).toBe(true);
    expect(consult.token).toBeUndefined();
    const toHer = emails.filter((e) => JSON.stringify(e.to || '').includes(email));
    expect(toHer.length).toBe(0);
  });

  // The phone fallback is NOT gone — it just stopped being the only way to qualify.
  // These two pin what it is now for: rescuing an answer we could not read.
  it('an unreadable training answer is still rescued by a served dialling code', async () => {
    const email = 'newform-unreadable-uk-phone@example.com';
    const { consult } = await submitNoGpQuestion('st_elsewhere_vts_1998', email);
    expect(consult.screened_out).toBeUndefined();
    expect(consult.qualified).toBe(true);
    expect(consult.country_inferred_from_phone).toBe(true);
  });

  it('an unreadable answer AND an overseas number goes to a human, not a turndown', async () => {
    const email = 'newform-unreadable-overseas@example.com';
    const payload = leadNoGpQuestion('st_elsewhere_vts_1998', email);
    payload.entry[0].changes[0].value.field_data[2] = { name: 'phone_number', values: ['+919876543210'] };
    const res = await post('/api/webhooks/facebook-lead?secret=test-secret', payload);
    expect(res.status).toBe(200);
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const consult = (db.siteEnquiries || []).find((r) => r.email === email).metadata.consult;
    // Failing to read her is never evidence about her — she waits for a human
    // rather than being told we cannot take her on.
    expect(consult.screened_out).toBeUndefined();
    expect(consult.qualified).not.toBe(true);
    expect(consult.country_unknown).toBe(true);
  });
});
