// WP-16 (Australian GP build): overseas parity for the lead and consult
// messages.
//
// tests/fixtures/au-wp16-overseas-parity.snapshot.json was produced by
// tests/helpers/au-wp16-parity.js on the tree BEFORE WP-16 changed any code
// (its own commit, ahead of the code). This test sends the same UK, Irish and
// New Zealand doctors every message again and demands byte equality, with the
// Australian switch ON and with it OFF:
//
//   - the words: subject, HTML, text, sender and headers of every email, the
//     template and placeholders of every WhatsApp;
//   - the schedule: which step is handed out how long after the form, the
//     booking, the call and a missed call.
//
// Never regenerate the fixture to make this pass. (WP16_WRITE_PARITY=1 writes
// it; that was run once, before the code changed.)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { bootLeadCopyServer } = require('./helpers/au-wp16-harness.js');
const { computeLibParity, computeServerParity, PEOPLE } = require('./helpers/au-wp16-parity.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'au-wp16-overseas-parity.snapshot.json');
const WRITE = process.env.WP16_WRITE_PARITY === '1';

let h;
beforeAll(async () => {
  h = await bootLeadCopyServer({ name: 'wp16-parity' });
}, 60000);
afterAll(async () => { if (h) await h.closeAll(); });

describe('WP-16 overseas parity: UK / IE / NZ lead and consult messages', () => {
  it.runIf(WRITE)('writes the fixture (run once, before the code changed)', async () => {
    h.setSwitch(false);
    const snapshot = { lib: computeLibParity(false), server: await computeServerParity(h, 'write') };
    fs.writeFileSync(FIXTURE, JSON.stringify(snapshot, null, 2) + '\n');
    expect(Object.keys(snapshot.server)).toEqual(PEOPLE.map((p) => p.key));
  }, 120000);

  const saved = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

  it('the fixture covers every message for every doctor', () => {
    const s = saved();
    PEOPLE.forEach((p) => {
      const sv = s.server[p.key];
      ['magicLink', 'genericLink', 'nudge:not_booked:0', 'nudge:not_booked:1', 'nudge:not_booked:2',
        'nudge:booked_no_signup:0', 'nudge:booked_no_signup:1', 'nudge:booked_no_signup:2', 'nudge:booked_no_signup:3',
        'nudge:booked_no_signup:4', 'noShowEmail'].forEach((k) => {
        expect(sv[k], p.key + ' ' + k).toBeTruthy();
        expect(String(sv[k].html).length, p.key + ' ' + k + ' html').toBeGreaterThan(200);
        expect(String(sv[k].text).length, p.key + ' ' + k + ' text').toBeGreaterThan(20);
      });
      ['hello_5m', 'check_in_1h', 'day_after_24h', 'call_booked', 'signed_up', 'onboarding_incomplete', 'post_call_onboard'].forEach((k) => {
        expect(sv.whatsapp[k].ok, p.key + ' WhatsApp ' + k).toBe(true);
        expect(sv.whatsapp[k].content.templateName, p.key + ' WhatsApp ' + k).toMatch(/^gp_link_consult_/);
      });
      expect(sv.noShowWhatsApp.templateName).toBe('gp_link_consult_missed_call');
      expect(s.lib.schedule[p.key].neverBooks.map((x) => x.afterMinutes)).toEqual([5, 60, 1440]);
      expect(s.lib.schedule[p.key].booksThenAttends.filter((x) => x.seq === 'booked_no_signup').length).toBe(5);
    });
  });

  [['OFF', false], ['ON', true]].forEach(([label, on]) => {
    it('switch ' + label + ': the pure builders and the send schedule are byte-identical', () => {
      expect(computeLibParity(on)).toEqual(saved().lib);
    });
    it('switch ' + label + ': every email and WhatsApp the server sends is byte-identical', async () => {
      h.setSwitch(on);
      const now = await computeServerParity(h, 'check-' + label.toLowerCase());
      const before = saved().server;
      PEOPLE.forEach((p) => {
        Object.keys(before[p.key]).forEach((k) => {
          expect(now[p.key][k], 'switch ' + label + ' ' + p.key + ' ' + k).toEqual(before[p.key][k]);
        });
        expect(Object.keys(now[p.key]).sort()).toEqual(Object.keys(before[p.key]).sort());
      });
    }, 120000);
  });
});
