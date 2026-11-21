// WP-15 (Australian GP build): overseas parity for the lead funnel.
//
// tests/fixtures/au-wp15-overseas-parity.snapshot.json was produced by
// tests/helpers/au-wp15-parity.js on the tree BEFORE WP-15 changed any code
// (its own commit, ahead of the code). This test walks the same UK / Irish /
// New Zealand / "somewhere else" doctors through the real server again and
// demands:
//
//   switch OFF  everything is identical: the answer, the stored row, the
//               screening result, the owner's email, the recognition answer
//               and the Leads tab row.
//   switch ON   the same doctors, now answering "No" to "Are you currently
//               registered with Ahpra?", get the same result except for the
//               additive keys listed in ADDITIVE below.
//
// Never regenerate the fixture to make this pass. (WP15_WRITE_PARITY=1 writes
// it; that was run once, before the code changed.)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { computeLeadParity, PEOPLE } = require('./helpers/au-wp15-parity.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'au-wp15-overseas-parity.snapshot.json');
const WRITE = process.env.WP15_WRITE_PARITY === '1';

// What WP-15 adds for an overseas doctor who answers "No" with the switch on.
// Everything else must be equal.
const ADDITIVE = {
  // on site_enquiries.metadata.consult
  consult: ['segment', 'ahpra_registered', 'consent'],
  // on a GET /api/ceo/leads row
  leadsTabRow: ['segment', 'segment_label', 'au_state', 'vr_status', 'tz_label']
};

let h;
beforeAll(async () => {
  h = await bootAuTestServer({ name: 'wp15-parity', mode: 'local', localDb: {}, env: { RESEND_API_KEY: 're_test_wp15', SITE_ENQUIRY_NOTIFY_EMAIL: 'owner@gplink-test.local' } });
}, 60000);
afterAll(async () => { if (h) await h.close(); });

function strip(obj, keys) {
  const o = Object.assign({}, obj || {});
  keys.forEach((k) => { delete o[k]; });
  return o;
}

describe('WP-15 overseas parity: the lead funnel for UK / IE / NZ / other doctors', () => {
  it.runIf(WRITE)('writes the fixture (run once, before the code changed)', async () => {
    const snapshot = {
      on: await computeLeadParity(h, { on: true, tag: 'on' }),
      off: await computeLeadParity(h, { on: false, tag: 'off' })
    };
    fs.writeFileSync(FIXTURE, JSON.stringify(snapshot, null, 2) + '\n');
    expect(Object.keys(snapshot.on)).toEqual(PEOPLE.map((p) => p.key));
  });

  it.skipIf(WRITE)('switch OFF: the old page payload gives a byte-identical result', async () => {
    const frozen = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const now = await computeLeadParity(h, { on: false, tag: 'off1' });
    expect(now).toEqual(frozen.off);
  });

  it.skipIf(WRITE)('switch OFF: the new answers, if a page ever sent them, are ignored (nothing stored, nothing changes)', async () => {
    const frozen = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const now = await computeLeadParity(h, {
      on: false, tag: 'off2', ipBase: 20,
      extra: () => ({ ahpraRegistered: true, state: 'WA', vrStatus: 'yes', restriction19ab: 'no', rightToWork: 'citizen_pr', consentVersion: 'au_a1_draft_2026_11' })
    });
    expect(now).toEqual(frozen.off);
  });

  it.skipIf(WRITE)('switch ON: an old cached page (no first question) gives a byte-identical result', async () => {
    const frozen = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const now = await computeLeadParity(h, { on: true, tag: 'on1' });
    for (const person of PEOPLE) {
      const a = now[person.key];
      // no answer to the first question: nothing is recorded on the lead, so
      // the row is the old row. The Leads tab still names the segment it reads.
      expect(a.stored, person.key + ' stored row').toEqual(frozen.on[person.key].stored);
      expect(Object.assign({}, a, { leadsTabRow: strip(a.leadsTabRow, ADDITIVE.leadsTabRow) }), person.key).toEqual(frozen.on[person.key]);
    }
  });

  it.skipIf(WRITE)('switch ON, answering "No": equal except for the documented additive keys', async () => {
    const frozen = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const now = await computeLeadParity(h, {
      on: true, tag: 'on2', ipBase: 40,
      extra: () => ({ ahpraRegistered: false, consentVersion: 'overseas_v0' })
    });
    for (const person of PEOPLE) {
      const a = now[person.key];
      const b = frozen.on[person.key];
      expect(a.status, person.key).toBe(b.status);
      expect(a.answer, person.key + ' answer').toEqual(b.answer);
      expect(a.screening, person.key + ' screening').toEqual(b.screening);
      expect(a.ownerAlerts, person.key + ' owner alert').toEqual(b.ownerAlerts);
      expect(a.recognition, person.key + ' recognition').toEqual(b.recognition);
      // the stored row
      const consultNow = a.stored.metadata.consult;
      expect(consultNow.segment, person.key).toBe('overseas');
      expect(consultNow.ahpra_registered, person.key).toBe(false);
      expect(consultNow.consent, person.key).toMatchObject({ wording_version: 'overseas_v0', ai_call: 'not_asked' });
      const storedNow = Object.assign({}, a.stored, { metadata: Object.assign({}, a.stored.metadata, { consult: strip(consultNow, ADDITIVE.consult) }) });
      expect(storedNow, person.key + ' stored row').toEqual(b.stored);
      // the Leads tab row
      expect(a.leadsTabRow.segment, person.key).toBe('overseas');
      expect(strip(a.leadsTabRow, ADDITIVE.leadsTabRow), person.key + ' leads row').toEqual(b.leadsTabRow);
    }
  });
});
