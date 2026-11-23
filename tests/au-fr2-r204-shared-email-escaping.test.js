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
    for (const s of ORDINARY) expect(safe.neutraliseForeignTags(s), s).toBe(s === '5 < 7 is a fact about numbers ' ? '5 \u2039 7 is a fact about numbers ' : s);
    // a bare "<" that is not a tag is the one ordinary character that changes (to its look-alike); nothing else ever does
    expect(safe.neutraliseForeignTags('a & b \' " > c')).toBe('a & b \' " > c');
  });
  it('every foreign tag is inert, including a formatting tag given attributes', () => {
    for (const s of HOSTILE) {
      const out = safe.neutraliseForeignTags(s);
      expect(/<\s*\/?\s*(script|img|a|iframe|svg|style|!--)/i.test(out), s).toBe(false);
      expect(/<[^<>]*\s(on[a-z]+|style|class|href|src)\s*=/i.test(out), s).toBe(false);
    }
    expect(safe.neutraliseForeignTags('<b onmouseover=alert(1)>x</b>')).toBe('\u2039b onmouseover=alert(1)>x</b>');
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
