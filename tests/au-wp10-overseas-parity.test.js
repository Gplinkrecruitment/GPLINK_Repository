// WP-10 (Australian GP build): overseas parity.
//
// tests/fixtures/au-wp10-overseas-parity.snapshot.json was produced by
// tests/helpers/au-wp10-parity.js on the tree BEFORE WP-10 changed any code
// (it is in its own commit, ahead of the code). This test recomputes it and
// demands equality, with the switch on and with it off: for UK / Irish / New
// Zealand / unknown-country leads and doctors, every zone, calling window,
// interview slot and rendered time label is exactly what it was.
//
// Never regenerate the fixture to make this pass.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { computeOverseasParitySnapshot, LEADS, INSTANTS } = require('./helpers/au-wp10-parity.js');
const frozen = require('./fixtures/au-wp10-overseas-parity.snapshot.json');

const saved = process.env.AU_PATHWAY_ENABLED;
afterEach(() => {
  if (saved === undefined) delete process.env.AU_PATHWAY_ENABLED;
  else process.env.AU_PATHWAY_ENABLED = saved;
});

// One computation per switch state (it renders several thousand labels).
const computed = {};
function snapshotFor(state) {
  if (!computed[state]) {
    process.env.AU_PATHWAY_ENABLED = state;
    computed[state] = computeOverseasParitySnapshot();
  }
  return computed[state];
}

describe('WP-10 overseas parity: zones, windows and labels are what they were', () => {
  for (const state of ['true', 'false']) {
    describe('switch ' + (state === 'true' ? 'ON' : 'OFF'), () => {
      // A long walk through the real server (many requests in sequence). It takes about 3 seconds (pure computation over every zone and label, no server) alone and several times that when the whole suite is running, so it has its own limit instead of the suite's 15 seconds (walk-findings R15).
      it('every lead zone and every rendered time label is unchanged', { timeout: 45000 }, () => {
        const now = snapshotFor(state);
        expect(Object.keys(now.leads)).toEqual(LEADS.map((l) => l.key));
        for (const key of Object.keys(frozen.leads)) {
          expect(now.leads[key].zone, key + ' zone').toBe(frozen.leads[key].zone);
          for (const iso of INSTANTS) {
            expect(now.leads[key].times[iso], key + ' @ ' + iso).toEqual(frozen.leads[key].times[iso]);
          }
        }
      });

      it("Hazel's decision, calling hours, from-number and prompt variables are unchanged for every hour of a week", () => {
        const now = snapshotFor(state);
        expect(now.callWindows).toEqual(frozen.callWindows);
      });

      it('the country-to-zone guess for a doctor is unchanged', () => {
        const now = snapshotFor(state);
        expect(now.doctors).toEqual(frozen.doctors);
      });

      it('interview slots (host 11:00 to 02:00 Sydney, practice evenings and weekends, doctor 06:00 to 23:00) are unchanged', () => {
        const now = snapshotFor(state);
        expect(now.constants).toEqual(frozen.constants);
        expect(Object.keys(now.interview)).toEqual(Object.keys(frozen.interview));
        for (const key of Object.keys(frozen.interview)) {
          expect(now.interview[key], key).toEqual(frozen.interview[key]);
        }
      });
    });
  }

  it('the frozen snapshot really holds the overseas answers (guards against an empty or regenerated file)', () => {
    expect(frozen.leads.uk_country.zone).toBe('Europe/London');
    expect(frozen.leads.ie_country.zone).toBe('Europe/Dublin');
    expect(frozen.leads.nz_country.zone).toBe('Pacific/Auckland');
    expect(frozen.leads.nothing_known.zone).toBe('Europe/London');
    // The UK-trained GP living in Australia stays on UK time in WP-10 (known
    // limitation, resolved by WP-15's segment question).
    expect(frozen.leads.uk_trained_au_mobile.zone).toBe('Europe/London');
    expect(frozen.leads.uk_country.times['2026-11-24T09:30:00.000Z'].long).toBe('Tuesday 24 November, 9:30 am (UK time)');
    expect(frozen.leads.nz_country.times['2026-11-24T09:30:00.000Z'].long).toBe('Tuesday 24 November, 10:30 pm (New Zealand time)');
    expect(frozen.constants.host).toEqual({ tz: 'Australia/Sydney', weekday: [660, 1560], weekend: [660, 1560] });
    expect(frozen.interview['uk|nsw|2026-11-23T00:00:00.000Z'].count).toBe(136);
    expect(frozen.callWindows.uk_country.perHour.filter((x) => x.startsWith('call:Europe/London')).length).toBeGreaterThan(40);
  });
});
