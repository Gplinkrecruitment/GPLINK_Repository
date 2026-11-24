// Fix bundle FR-2, defect R2-04: a practice or doctor name containing HTML went
// out live in doctor emails shared with overseas doctors ("a practice wants to
// meet you", "You have an offer to review"). The fix is in the one function
// every doctor email goes through (server.js sendGpNotificationEmail), for
// every doctor, with the switch on or off: it is a security fix.
//   - hostile values are inert in the email that is sent;
//   - any text without a foreign tag is returned BYTE FOR BYTE (parity).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootLeadCopyServer } = require('./helpers/au-wp16-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const safe = require('../lib/au-safe-text.js');
const practicePipeline = require('../lib/practice-pipeline.js');

const ORDINARY = [
  'Dr Siobhan O\'Brien', 'Smith & Sons Medical Centre', 'Zoë Müller-Núñez', 'Test Metro Practice (FAKE)', 'Dr "Jay" Patel', 'A > B clinic', '5 < 7 is a fact about numbers ',
  'Hi there,\n\nGreat news — Parramatta Family Practice wants to move forward.\n\n**bold** and a line\n• a bullet', 'AT&T Health; R&amp;D', '',
  // the app's own formatted copy (the interview reminder): allowed formatting tags stay as they are
  'Just a friendly reminder, you have an interview tomorrow.<br><br><strong>Interview Details:</strong><br>Practice: Smith & Sons<br>When: Monday<br/>',
  '<p>One</p><ul><li>a</li><li>b</li></ul><b>x</b><em>y</em><ol><li>z</li></ol></P><BR>'
];
const HOSTILE = [
  'Evil <script>alert(1)</script> Clinic', '"><img src=x onerror=alert(1)>', '<a href="https://evil.example">click</a>', '</p><iframe src=//evil.example></iframe>',
  '<svg/onload=alert(1)>', '<b onmouseover=alert(1)>x</b>', '<strong style="x">y</strong>', '<br onclick=1>', '<style>*{display:none}</style>', '<!-- x -->', '<p class="a">'
];

describe('R2-04: neutraliseForeignTags', () => {
  it('PARITY: ordinary text, names with apostrophes, ampersands, accents and quotes, and the app\'s own formatting tags come back byte for byte', () => {
    // FR-3 (S3-06), deliberate: a bare "<" is no longer changed either (it used
    // to become its look-alike, with the switch off too). Nothing ordinary changes.
    for (const s of ORDINARY) expect(safe.neutraliseForeignTags(s), s).toBe(s);
    expect(safe.neutraliseForeignTags('a & b \' " > c')).toBe('a & b \' " > c');
  });
  it('every foreign tag is inert, including a formatting tag given attributes', () => {
    for (const s of HOSTILE) {
      const out = safe.neutraliseForeignTags(s);
      expect(/<\s*\/?\s*(script|img|a|iframe|svg|style|!--)/i.test(out), s).toBe(false);
      expect(/<[^<>]*\s(on[a-z]+|style|class|href|src)\s*=/i.test(out), s).toBe(false);
    }
    // FR-3 (S3-06), deliberate: written as the entity (the reader sees "<"), not the look-alike.
    expect(safe.neutraliseForeignTags('<b onmouseover=alert(1)>x</b>')).toBe('&lt;b onmouseover=alert(1)>x</b>');
    for (const junk of [null, undefined, 7, {}]) expect(typeof safe.neutraliseForeignTags(junk)).toBe('string');
  });
});

describe('R2-04: the emails that are sent', () => {
  let h, w;
  const mails = (d) => h.emailsTo(d.email);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function settle() { let last = -1; for (let i = 0; i < 30; i++) { await sleep(30); if (h.emails.length === last) return; last = h.emails.length; } }
  function load(doctors) {
    const db = buildAuFixtureDb(doctors);
    ['gp_nudge_log', 'gp_applications', 'user_roles', 'registration_tasks', 'task_timeline', 'notification_preferences', 'email_suppression', 'site_enquiries', 'placements', 'user_documents', 'runtime_kv'].forEach((n) => { if (!db[n]) db[n] = []; });
    Object.keys(h.emu.db).forEach((n) => { if (n !== 'rso_team') delete h.emu.db[n]; });
    Object.keys(db).forEach((n) => { h.emu.db[n] = JSON.parse(JSON.stringify(db[n])); });
    h.emu.reset(); h.reset();
  }
  beforeAll(async () => { h = await bootLeadCopyServer({ name: 'fr2-r204', mode: 'supabase', tables: {} }); w = h.testUtils.__wp17; }, 60000);
  afterAll(async () => { if (h) await h.closeAll(); });

  const congrats = (practice) => practicePipeline.buildCongratsEmailCopy({ gpName: '{{name}}', practiceName: practice, secureUrl: 'https://app.gplink-test.local/pages/career' });
  const offerBody = (practice, job) => 'Wonderful news — ' + practice + ' would like to offer you the ' + job + ' role. Open your offer to see the billing split, sessions and start date, and accept when you\'re ready.';

  for (const sw of [true, false]) {
    it('the reviewer\'s two emails, hostile practice name AND hostile doctor name, overseas doctor, switch ' + (sw ? 'ON' : 'OFF') + ': nothing live', async () => {
      const d = buildAuDoctor('overseas_null', { idSuffix: sw ? 'e1' : 'e2', profile: { first_name: 'Nina<img src=x onerror=alert(1)>' } });
      load([d]);
      h.setSwitch(sw);
      try {
        const practice = 'Test Metro <script>alert(1)</script> & "Sons" <a href="https://evil.example">Practice</a> (FAKE)';
        const c = congrats(practice);
        await w.sendGpNotificationEmail(d.userId, c.subject, c.title, c.body, c.ctaText, c.ctaUrl, c.footer);
        await w.sendGpNotificationEmail(d.userId, 'You have an offer to review 🎉, GP Link', 'You have an offer, {{name}}!', offerBody(practice, 'GP <svg/onload=alert(1)>'), 'Review Your Offer', 'https://app.gplink-test.local/pages/offer-review', 'Questions about the offer?');
        await settle();
      } finally { h.setSwitch(true); }
      const got = mails(d);
      expect(got.length).toBe(2);
      got.forEach((m) => {
        expect(/<\s*(script|img|svg|iframe)\b/i.test(m.html), m.subject).toBe(false);
        expect(/<a [^>]*evil\.example/i.test(m.html), m.subject).toBe(false);
        expect(m.html).toContain('Test Metro');
        expect(m.html).toContain('alert(1)');   // still readable as text
      });
    });
  }

  it('PARITY: for ordinary names the email is byte-identical to what the shell produced before the fix', async () => {
    const d = buildAuDoctor('overseas_null', { idSuffix: 'e3', profile: { first_name: 'Siobhán' } });
    load([d]);
    const practices = ['Smith & Sons Medical Centre', 'O\'Brien Family Practice', 'Zoë Müller Clinic', 'Test Metro Practice (FAKE)', 'Dr "Jay" Patel Rooms'];
    for (const practice of practices) {
      const c = congrats(practice);
      await w.sendGpNotificationEmail(d.userId, c.subject, c.title, c.body, c.ctaText, c.ctaUrl, c.footer);
    }
    await settle();
    const got = mails(d);
    expect(got.length).toBe(practices.length);
    practices.forEach((practice, i) => {
      const c = congrats(practice);
      // what the shell made before: the same call with the title and body exactly as the builder wrote them
      const before = w.buildCareerEmailHtml({ title: c.title.replace(/\{\{name\}\}/g, 'Siobhán'), body: c.body.replace(/\{\{name\}\}/g, 'Siobhán'), ctaText: c.ctaText, ctaUrl: c.ctaUrl, footer: c.footer });
      expect(got[i].html, practice).toBe(before);
    });
  });

  // ── Fix bundle FR-3: S3-06 and M3-07 ──
  it('S3-06, the reviewer\'s example: a ticket titled "Is a scan <5MB OK" is sent byte for byte as the shell alone sends it (main), switch on and off', async () => {
    const d = buildAuDoctor('overseas_null', { idSuffix: 'e7', profile: { first_name: 'Asha' } });
    load([d]);
    const ORDINARY_BODIES = [
      ['Is a scan <5MB OK', 'Hi {{name}}, we replied to your ticket "Is a scan <5MB OK".\n\nA file <5MB is fine; x < y and 3 > 2 too.'],
      ['Your documents', 'Hi {{name}},\n\n- Passport\n- **CV** (under 5MB)\n\nThanks & regards, O\'Brien <3'],
      ['Interview booked', 'Hi {{name}},<br><br>Your interview is at <strong>10:00</strong>.<br>If the file is <5MB it uploads at once.'],
      ['A < B', 'a < b and c > d; 1<2; "quoted" & \'single\'; price < $5; <=3 and <-- arrows'],   // ("a<b ...>" with a letter straight after "<" is markup on main too, so it is not in this set)
      ['Emoji <3', 'We <3 our doctors.']
    ];
    for (const on of [true, false]) {
      h.setSwitch(on);
      h.reset();
      for (const [title, body] of ORDINARY_BODIES) await w.sendGpNotificationEmail(d.userId, 'Subject', title, body, 'Open', 'https://app.test/x', '');
      await settle();
      const got = mails(d);
      expect(got.length).toBe(ORDINARY_BODIES.length);
      ORDINARY_BODIES.forEach(([title, body], i) => {
        // main: the title and body handed to the shell exactly as written, with the name filled in
        const main = w.buildCareerEmailHtml({ title: title.replace(/\{\{name\}\}/g, 'Asha'), body: body.replace(/\{\{name\}\}/g, 'Asha'), ctaText: 'Open', ctaUrl: 'https://app.test/x', footer: '' });
        expect(got[i].html, (on ? 'on: ' : 'off: ') + title).toBe(main);
        expect(got[i].html).not.toContain('\u2039');
      });
    }
    h.setSwitch(true);
    // and the reader really gets "<5MB" (as an entity on the plain-text path), not a look-alike
    expect(mails(d)[0].html).toContain('A file &lt;5MB is fine');
    expect(safe.neutraliseForeignTags('Is a scan <5MB OK')).toBe('Is a scan <5MB OK');
  });

  it('M3-07: "<b>" in the doctor\'s own NAME is written out, not rendered bold; the subject keeps the name as typed; an ordinary name is unchanged', async () => {
    const d = buildAuDoctor('overseas_null', { idSuffix: 'e8', profile: { first_name: '<b>Jo</b>' } });
    const plain = buildAuDoctor('overseas_null', { idSuffix: 'e9', profile: { first_name: 'Jo' } });
    load([d, plain]);
    for (const who of [d, plain]) await w.sendGpNotificationEmail(who.userId, 'Hello {{name}}', 'Welcome, {{name}}', 'Hi {{name}},<br>Your interview is at <strong>10:00</strong>.', 'Open', 'https://app.test/x', '');
    await settle();
    const m = mails(d)[0];
    expect(m.html).not.toMatch(/<b>Jo<\/b>/);
    expect(m.html).toContain('&lt;b>Jo&lt;/b>');
    expect(m.html).toContain('<strong>10:00</strong>');          // the app's own formatting still works
    expect(m.subject).toBe('Hello <b>Jo</b>');
    expect(mails(plain)[0].html).toBe(w.buildCareerEmailHtml({ title: 'Welcome, Jo', body: 'Hi Jo,<br>Your interview is at <strong>10:00</strong>.', ctaText: 'Open', ctaUrl: 'https://app.test/x', footer: '' }));
    expect(safe.escapeTagLike('O\'Brien & Sons <3 5<7')).toBe('O\'Brien & Sons <3 5<7');
    expect(safe.escapeTagLike('<img src=x onerror=1>')).toBe('&lt;img src=x onerror=1>');
  });

  it('FR-4 M4-05: "<b>" in the doctor\'s LAST name (written into the body by the caller) is not bold either; an ordinary last name leaves the email byte for byte', async () => {
    const d = buildAuDoctor('overseas_null', { idSuffix: 'f1', profile: { first_name: 'Jo', last_name: '<b>Smith</b>' } });
    const plain = buildAuDoctor('overseas_null', { idSuffix: 'f2', profile: { first_name: 'Jo', last_name: "O'Brien-Smith" } });
    load([d, plain]);
    const body = (last) => 'Dear Dr ' + last + ',<br>Your interview is at <strong>10:00</strong>.';
    await w.sendGpNotificationEmail(d.userId, 'Hello', 'For Dr <b>Smith</b>', body('<b>Smith</b>'), 'Open', 'https://app.test/x', '');
    await w.sendGpNotificationEmail(plain.userId, 'Hello', "For Dr O'Brien-Smith", body("O'Brien-Smith"), 'Open', 'https://app.test/x', '');
    await settle();
    const m = mails(d)[0];
    expect(m.html).not.toMatch(/<b>Smith<\/b>/);
    expect(m.html).toContain('&lt;b>Smith&lt;/b>');
    expect(m.html).toContain('<strong>10:00</strong>');
    expect(mails(plain)[0].html).toBe(w.buildCareerEmailHtml({ title: "For Dr O'Brien-Smith", body: body("O'Brien-Smith"), ctaText: 'Open', ctaUrl: 'https://app.test/x', footer: '' }));
  });

  it('the app\'s own formatted email (interview reminder: <br> and <strong>) is unchanged, and a hostile practice inside it is inert', async () => {
    const d = buildAuDoctor('overseas_null', { idSuffix: 'e4' });
    load([d]);
    const detail = (p) => 'Just a friendly reminder, you have an interview tomorrow.<br><br><strong>Interview Details:</strong><br>Practice: ' + p + '<br>When: Monday<br>';
    await w.sendGpNotificationEmail(d.userId, 'Interview Tomorrow, GP Link', 'Interview reminder, {{name}}', detail('Smith & Sons'), 'Open GP Link', 'https://app.gplink-test.local/pages/career', '');
    await w.sendGpNotificationEmail(d.userId, 'Interview Tomorrow, GP Link', 'Interview reminder, {{name}}', detail('Evil <script>x</script>'), 'Open GP Link', 'https://app.gplink-test.local/pages/career', '');
    await settle();
    const got = mails(d);
    expect(got[0].html).toContain('<br><br><strong>Interview Details:</strong><br>Practice: Smith & Sons<br>');
    expect(got[1].html).toContain('<strong>Interview Details:</strong>');
    expect(/<script/i.test(got[1].html)).toBe(false);
  });
});
