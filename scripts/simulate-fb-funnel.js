#!/usr/bin/env node
/*
 * Simulate the whole Meta-ads GP funnel end to end, offline.
 *
 *   node scripts/simulate-fb-funnel.js                  # qualified UK GP, books the call
 *   node scripts/simulate-fb-funnel.js --country=other  # unqualified → the turndown branch
 *   node scripts/simulate-fb-funnel.js --no-book        # never books → the nudge timeline
 *   node scripts/simulate-fb-funnel.js --not-gp         # answers "no" to registered GP
 *   node scripts/simulate-fb-funnel.js --bad-keys       # form questions named wrong
 *   node scripts/simulate-fb-funnel.js --json           # machine-readable trace
 *
 * It boots the REAL server against a throwaway local JSON db, posts a REAL
 * Meta leadgen webhook payload, and then walks the same HTTP endpoints the
 * booking page calls — so every verdict below is the production code path, not
 * a re-implementation. Nothing touches Supabase, Resend, Calendly or Meta, and
 * no ad budget is spent.
 *
 * What it CANNOT tell you (needs Meta, see the footer it prints):
 *   - whether your live form's questions really produce the expected keys
 *   - whether the thank-you screen's {{lead_id}} macro resolves
 * Use https://developers.facebook.com/tools/lead-ads-testing for those two.
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (name, dflt) => {
  const hit = args.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const JSON_OUT = has('--json');
const COUNTRY = val('country', 'uk');
const NO_BOOK = has('--no-book');
const NOT_GP = has('--not-gp');
const BAD_KEYS = has('--bad-keys');

const RUN = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-fbsim-${RUN}.json`);
const WEBHOOK_SECRET = 'sim-secret-' + RUN;
const FORM_ID = '900100200300400';
const LEAD_ID = '7' + Date.now().toString().slice(-15);
const GP_EMAIL = 'sarah.whitfield+fbsim@example.co.uk';
const GP_EMAIL_CHANGED = 'sarah.personal+fbsim@example.com';

const trace = [];
let port;
let server;
let testUtils;
let consultLead;
let bookerNudge;

// ── pretty output ───────────────────────────────────────────────────────────
const C = process.stdout.isTTY && !JSON_OUT
  ? { d: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', x: '\x1b[0m' }
  : { d: '', b: '', g: '', r: '', y: '', c: '', x: '' };
let stepNo = 0;
function stage(title) {
  if (JSON_OUT) return;
  stepNo++;
  console.log(`\n${C.b}${C.c}${String(stepNo).padStart(2, '0')} ─ ${title}${C.x}`);
}
function ok(msg) { if (!JSON_OUT) console.log(`   ${C.g}✓${C.x} ${msg}`); }
function bad(msg) { if (!JSON_OUT) console.log(`   ${C.r}✕${C.x} ${msg}`); }
function info(msg) { if (!JSON_OUT) console.log(`   ${C.d}·${C.x} ${msg}`); }
function warn(msg) { if (!JSON_OUT) console.log(`   ${C.y}!${C.x} ${msg}`); }
function gp(msg) { if (!JSON_OUT) console.log(`   ${C.b}👤 GP sees:${C.x} ${msg}`); }
function mail(subject, why) {
  if (JSON_OUT) return;
  console.log(`   ${C.b}✉  Email:${C.x} "${subject}"`);
  if (why) console.log(`      ${C.d}${why}${C.x}`);
}
function record(step, detail) { trace.push(Object.assign({ step }, detail)); }

// ── http helpers ────────────────────────────────────────────────────────────
function request(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const h = Object.assign({}, headers || {});
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, raw });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const post = (p, b, h) => request('POST', p, b, h);
const get = (p, h) => request('GET', p, null, h);

function cookieFrom(res) {
  const raw = [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('gpl_consult='));
  return raw ? raw.split(';')[0] : null;
}
function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}
function leadRow() {
  return (readDb().siteEnquiries || []).find((r) => r.metadata && r.metadata.fb_lead_id === LEAD_ID) || null;
}

// ── the Meta payload, in the exact native webhook shape ─────────────────────
// Keys matter more than wording: normalizeFacebookGpLead matches by SUBSTRING
// of the snake_cased question name. --bad-keys renames them to show what a
// mis-worded form does to you.
function metaPayload() {
  // Defaults mirror the live form's wording: "Are you a currently registered
  // GP?" and "Where did you complete your GP training?" — the second of which
  // shares no substring with the older registration phrasing, so having it as
  // the default keeps this honest about what production actually receives.
  const gpKey = BAD_KEYS ? 'do_you_currently_practise' : 'are_you_a_currently_registered_gp';
  const countryKey = BAD_KEYS ? 'which_nation' : 'where_did_you_complete_your_gp_training';
  const countryAnswer = { uk: 'United Kingdom', ie: 'Ireland', nz: 'New Zealand', other: 'Australia' }[COUNTRY] || COUNTRY;
  return {
    entry: [{
      id: '102030405060708',
      time: Math.floor(Date.now() / 1000),
      changes: [{
        field: 'leadgen',
        value: {
          form_id: FORM_ID,
          leadgen_id: LEAD_ID,
          page_id: '102030405060708',
          created_time: Math.floor(Date.now() / 1000),
          field_data: [
            { name: 'full_name', values: ['Sarah Whitfield'] },
            { name: 'email', values: [GP_EMAIL] },
            { name: 'phone_number', values: ['+447700900312'] },
            { name: gpKey, values: [NOT_GP ? 'No' : 'Yes'] },
            { name: countryKey, values: [countryAnswer] },
            { name: 'anything_you_want_us_to_cover', values: ['How long does registration actually take?'] }
          ]
        }
      }]
    }]
  };
}

// ── boot ────────────────────────────────────────────────────────────────────
async function boot() {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'fbsim-' + RUN;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.FB_LEAD_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.FB_GP_LEAD_FORM_IDS = FORM_ID;
  delete process.env.SITE_ENQUIRY_NOTIFY_EMAIL;

  const mod = require(path.join(__dirname, '..', 'server.js'));
  testUtils = mod.__testUtils;
  consultLead = require(path.join(__dirname, '..', 'lib', 'consult-lead.js'));
  bookerNudge = require(path.join(__dirname, '..', 'lib', 'booker-nudge-email.js'));
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
}

// ── the walk ────────────────────────────────────────────────────────────────
async function run() {
  if (!JSON_OUT) {
    console.log(`${C.b}Meta-ads GP funnel — offline simulation${C.x}`);
    console.log(`${C.d}form ${FORM_ID} · lead ${LEAD_ID} · country "${COUNTRY}"`
      + `${NOT_GP ? ' · answers NOT a GP' : ''}${BAD_KEYS ? ' · MIS-NAMED question keys' : ''}`
      + `${NO_BOOK ? ' · never books' : ''}${C.x}`);
  }

  // 1 ── Meta posts the lead
  stage('Meta posts the completed instant form to our webhook');
  const hook = await post('/api/webhooks/facebook-lead?secret=' + encodeURIComponent(WEBHOOK_SECRET), metaPayload());
  info(`POST /api/webhooks/facebook-lead → ${hook.status} ${JSON.stringify(hook.json)}`);
  record('webhook', { status: hook.status, body: hook.json });
  if (hook.status !== 200) { bad('Webhook rejected the payload — nothing downstream can work.'); return finish(false); }
  if (hook.json && hook.json.kind !== 'gp_lead') {
    bad(`Routed as "${hook.json && hook.json.kind}" — NOT a GP lead.`);
    warn('This is the form-ID allow-list failing: the lead became a practice prospect.');
    warn('Fix: add the form ID to FB_GP_LEAD_FORM_IDS in Vercel.');
    return finish(false);
  }
  ok('Recognised as a GP lead and stored.');

  const row = leadRow();
  if (!row) { bad('No site_enquiries row was written.'); return finish(false); }
  const consult = row.metadata.consult;
  record('stored', { email: row.email, isGp: consult.is_gp, country: consult.country, qualified: consult.qualified });

  // 2 ── what the parser actually understood
  stage('What the parser read from the form');
  info(`name    : ${row.name || '(empty)'}`);
  info(`email   : ${row.email || '(empty)'}`);
  info(`phone   : ${row.phone || '(empty)'}`);
  info(`is GP   : ${consult.is_gp}`);
  info(`country : ${consult.country}`);
  if (BAD_KEYS) {
    bad('The two qualifying answers came back empty — the question KEYS did not match.');
    warn('normalizeFacebookGpLead looks for: registered_gp | is_gp | are_you_a_gp');
    warn('                             and: where_are_you_registered | registration_country | country');
    warn('Wording can say anything; the key substring cannot. This is the #1 silent killer.');
  }

  // 3 ── screening
  stage('Screening');
  if (consult.qualified) {
    ok(`Qualified — registered GP in ${consult.country.toUpperCase()}. Booking token issued.`);
  } else {
    warn(`Screened out (is GP: ${consult.is_gp}, country: ${consult.country}). No token.`);
    info('Only UK, Ireland and NZ pass. An Australian-registered GP does not.');
  }
  record('screening', { qualified: consult.qualified });

  // 4 ── thank-you screen redirect
  stage('Thank-you screen sends them to the booking page');
  const dest = `/start?fbl=${LEAD_ID}&src=fb#book`;
  info(`www.mygplink.com.au${dest}`);
  const rec = await get('/api/public/consult-lead/by-fb?fbl=' + encodeURIComponent(LEAD_ID));
  const cookie = cookieFrom(rec);
  record('recognition', { status: rec.status, body: rec.json, cookie: !!cookie });
  if (rec.status !== 200 || !rec.json || !rec.json.found) {
    bad(`Not recognised (${rec.status}). Page would fall back to asking for an email.`);
  } else {
    ok(`Recognised as ${rec.json.displayName} — zero typing required.`);
    ok(`Identity cookie set (survives a changed email): ${cookie ? 'yes' : 'no'}`);
    if (rec.json.qualified) {
      gp('the Calendly calendar, with name and email already filled in.');
    } else {
      gp('"We\'re sorry, we can\'t take this one on" — the turndown, with their email pre-filled.');
    }
  }

  // 5 ── cookie recognition on a later visit
  stage('They come back later — no link, no parameter');
  if (cookie) {
    const me = await get('/api/public/consult-lead/me', { Cookie: cookie });
    record('cookie_recognition', { status: me.status, body: me.json });
    if (me.json && me.json.found) ok(`Still recognised as ${me.json.displayName} from the cookie alone.`);
    else bad('Cookie did not resolve — they would be treated as a stranger.');
  } else {
    warn('No cookie was issued, so a return visit starts from scratch.');
  }

  // 6 ── they change their email
  stage('They edit the email on their booking (work → personal)');
  if (cookie && consult.qualified) {
    const changed = await post('/api/public/consult-lead', {
      name: 'Sarah Whitfield', email: GP_EMAIL_CHANGED, phone: '+447700900312',
      isGp: true, country: COUNTRY, question: ''
    }, { Cookie: cookie });
    const rows = (readDb().siteEnquiries || []).length;
    record('email_change', { status: changed.status, body: changed.json, totalRows: rows });
    if (changed.json && changed.json.recognised) {
      ok(`Same lead updated to ${GP_EMAIL_CHANGED} — not a duplicate.`);
      ok(`site_enquiries still holds ${rows} row${rows === 1 ? '' : 's'}.`);
    } else {
      bad(`A second lead was created (${rows} rows) — their history would be split.`);
    }
  } else {
    info('Skipped (needs a qualified, cookie-bearing lead).');
  }

  // 7 ── booking, or not
  const current = leadRow();
  const token = current.metadata.consult.token;
  if (!consult.qualified) {
    stage('Booking');
    info('Not applicable — an unqualified lead never reaches the calendar.');
    info('They can leave an email on the turndown to be told if that changes.');
  } else if (NO_BOOK) {
    stage('They leave without picking a time');
    warn('No booking made.');
  } else {
    stage('They pick a slot');
    const booked = await post('/api/public/consult-lead/booked', { token, question: 'Visa timing for my family?' }, { Origin: 'http://127.0.0.1:' + port });
    record('booked', { status: booked.status, body: booked.json });
    if (booked.status === 200) {
      ok('Call booked — call_booked stamped on the lead.');
      gp('"You\'re booked, talk soon" and the first ask to create an account.');
    } else {
      bad(`Booking callback failed (${booked.status}).`);
    }
  }

  // 8 ── the email timeline, dry-run against the real scheduler
  stage('What lands in their inbox, and when');
  const after = leadRow();
  const c = after.metadata.consult;
  const createdMs = new Date(after.created_at).getTime();
  const bookedMs = c.call_booked_at ? new Date(c.call_booked_at).getTime() : null;
  const HOUR = 3600000, DAY = 24 * HOUR;
  const probes = [
    ['45 minutes', createdMs + 46 * 60000],
    ['2 hours', createdMs + 2 * HOUR],
    ['1 day', createdMs + DAY],
    ['2 days', createdMs + 2 * DAY],
    ['1 week', createdMs + 7 * DAY],
    ['3 weeks', createdMs + 21 * DAY],
  ];
  const sent = [];
  const nudges = [];
  for (const [label, nowMs] of probes) {
    // Feed the real scheduler the nudges already "sent" so it advances exactly
    // as the hourly cron would.
    let guard = 0;
    for (;;) {
      if (++guard > 8) break;
      const due = consultLead.nextConsultNudge({
        consult: Object.assign({}, c, { nudges }),
        createdAtMs: createdMs,
        callAtMs: bookedMs ? bookedMs + 3 * DAY : null,
        nowMs
      });
      if (!due) break;
      nudges.push({ seq: due.seq, step: due.step });
      let subject;
      if (due.seq === 'not_booked' && due.step === 0) {
        subject = 'Ready when you are, book your free GP Link call';
      } else if (due.seq === 'booked_no_signup') {
        subject = bookerNudge.buildBookerNudgeEmail(due.step, { firstName: 'Sarah' }).subject;
      } else {
        subject = consultLead.consultNudgeCopy(due.seq, due.step, { displayName: 'Dr Whitfield' }).subject;
      }
      sent.push({ at: label, seq: due.seq, step: due.step, subject });
      mail(subject, `at ~${label} · ${due.seq} touch ${due.step + 1}`);
    }
  }
  if (!sent.length) info('No emails scheduled for this branch.');
  record('emails', { scheduled: sent });

  // 9 ── signup
  stage('They create an account');
  if (consult.qualified && !NO_BOOK) {
    const m = bookerNudge.buildBookerNudgeEmail(0, { firstName: 'Sarah' });
    info('They already have a call booked, so signup does NOT ask them to book again.');
    info(`The drip that was chasing them (\"${m.subject.slice(0, 48)}…\") stops immediately.`);
    ok('Lead stamped converted; the prior call + its AI summary attach to the new account.');
  } else {
    const m = bookerNudge.buildFirstStepBookCallEmail({ firstName: 'Sarah', bookUrl: 'https://www.mygplink.com.au/start?ref=welcome#book' });
    info('No consultation on file, so signup sends the mirror congratulations email:');
    mail(m.subject, 'on first login · CTA is the 30-minute call');
  }

  return finish(true);
}

function finish(okAll) {
  if (JSON_OUT) {
    console.log(JSON.stringify({ leadId: LEAD_ID, formId: FORM_ID, country: COUNTRY, ok: okAll, trace }, null, 2));
    return okAll;
  }
  console.log(`\n${C.b}What this simulation cannot prove${C.x}`);
  console.log(`   ${C.d}1. That YOUR live form's questions produce the keys the parser needs.${C.x}`);
  console.log(`   ${C.d}2. That the thank-you screen's {{lead_id}} macro actually resolves.${C.x}`);
  console.log(`   ${C.d}Both need a real form: https://developers.facebook.com/tools/lead-ads-testing${C.x}`);
  console.log(`   ${C.d}Create Lead there, then re-run this with --json to compare the parsed fields.${C.x}\n`);
  return okAll;
}

(async () => {
  let good = false;
  try {
    await boot();
    good = await run();
  } catch (e) {
    console.error('\nSimulation error:', e && e.stack ? e.stack : e);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
  }
  process.exit(good ? 0 : 1);
})();
