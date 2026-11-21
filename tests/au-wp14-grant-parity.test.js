// WP-14 (Australian GP build) overseas parity, on the real server: an OVERSEAS
// doctor's AHPRA final notice does exactly what it did before WP-14.
//
// The snapshot (tests/fixtures/au-wp14-grant-parity.snapshot.json) was written
// by running tests/helpers/au-wp14-grant-parity.js against the tree at commit
// 4b08e987, the commit WP-14 started from, BEFORE it changed any code (the
// helper's header says how). This test runs the same capture against the
// working tree, with the switch on and with it off, and compares everything:
// the case row, every task and its drafts, the visa case, the passport
// requests, the dependants, the timeline, the bell, every outbound call and
// every table written.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const { captureGrant } = require('./helpers/au-wp14-grant-parity.js');
const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/au-wp14-grant-parity.snapshot.json'), 'utf8'));

describe('an overseas doctor\'s registration-granted flow is unchanged by WP-14', () => {
  it('switch ON (nothing recorded) and switch OFF: the same records, tasks, visa case, passport requests and messages as before', async () => {
    const now = await captureGrant(ROOT);
    for (const state of ['switchOn', 'switchOff']) {
      for (const key of Object.keys(snapshot[state])) {
        expect(now[state][key], state + ' ' + key).toEqual(snapshot[state][key]);
      }
      expect(Object.keys(now[state]).sort(), state).toEqual(Object.keys(snapshot[state]).sort());
    }
    // what the snapshot pins, so it cannot quietly be a snapshot of nothing:
    // the overseas flow moves the case to visa, opens a FRESH visa case (never
    // a transfer) and asks for four passports
    const on = snapshot.switchOn;
    expect(on.summary).toMatchObject({ ok: true, stage: 'visa', hasVisaCase: true, dependants: 3, passportRequests: 4, skipped: null });
    expect(on.caseRow.stage).toBe('visa');
    expect(on.visaApplications.length).toBe(1);
    expect(on.visaApplications[0].case_type === undefined || on.visaApplications[0].case_type === null).toBe(true);
    expect(on.tasks.map((t) => t.task_type)).toEqual(['ahpra_correspondence', 'verify', 'migration_agent', 'visa_stage', 'followup', 'followup', 'followup']);
    expect(on.tasks.find((t) => t.task_type === 'migration_agent').outbound_email.bodyText).toMatch(/Subclass 482 nomination/);
    expect(JSON.stringify(on)).not.toMatch(/nomination_transfer|visa_transfer_decision|supervision_relodgement|au_segment_b/);
  }, 60000);
});
