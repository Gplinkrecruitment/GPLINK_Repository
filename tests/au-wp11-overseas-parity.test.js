// WP-11 (Australian GP build): overseas placement parity.
//
// tests/fixtures/au-wp11-overseas-placement.snapshot.json was produced by
// tests/helpers/au-wp11-overseas-snapshot.js on the tree BEFORE WP-11 changed
// any placement code (it is in its own commit, ahead of the code). This test
// places a fresh overseas doctor through every entry point and demands that
// every task, timeline line, document, email, WhatsApp, bell item and Drive
// call is exactly what it was: with the switch ON (nothing recorded, and a
// doctor whose pathway staff recorded as overseas) and with the switch OFF.
//
// Never regenerate the fixture to make this pass.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { bootPlacementRig, ENTRY_POINTS } = require('./helpers/au-wp11-placement-rig.js');
const { computeOverseasPlacementSnapshot } = require('./helpers/au-wp11-overseas-snapshot.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'au-wp11-overseas-placement.snapshot.json');
const WRITE = process.env.AU_WP11_WRITE_SNAPSHOT === '1';
const frozen = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

let rig;
beforeAll(async () => { rig = await bootPlacementRig({ name: 'wp11-parity' }); }, 60000);
afterAll(async () => { if (rig) await rig.close(); });

describe('WP-11 overseas parity: a placement produces exactly what it did before', () => {
  // A long walk through the real server (many requests in sequence). It takes about 5 seconds alone and several times that when the whole suite is running, so it has its own limit instead of the suite's 15 seconds (walk-findings R15).
  it('switch OFF: every entry point, every task and message', { timeout: 60000 }, async () => {
    rig.setSwitch(false);
    const now = await computeOverseasPlacementSnapshot(rig);
    if (WRITE) { fs.writeFileSync(FIXTURE, JSON.stringify(now, null, 2) + '\n'); return; }
    const was = frozen();
    expect(Object.keys(now)).toEqual(Object.keys(was));
    for (const key of Object.keys(was)) expect(now[key], key).toEqual(was[key]);
  }, 180000);

  // A long walk through the real server (many requests in sequence). It takes about 4 seconds alone and several times that when the whole suite is running, so it has its own limit instead of the suite's 15 seconds (walk-findings R15).
  it('switch ON, nothing recorded (the regression doctor): identical', { timeout: 60000 }, async () => {
    if (WRITE) return;
    rig.setSwitch(true);
    const now = await computeOverseasPlacementSnapshot(rig);
    const was = frozen();
    for (const key of Object.keys(was)) expect(now[key], key).toEqual(was[key]);
  }, 180000);

  // A long walk through the real server (many requests in sequence). It takes about 4 seconds alone and several times that when the whole suite is running, so it has its own limit instead of the suite's 15 seconds (walk-findings R15).
  it('switch ON, pathway recorded as overseas by staff: identical', { timeout: 60000 }, async () => {
    if (WRITE) return;
    rig.setSwitch(true);
    const now = await computeOverseasPlacementSnapshot(rig, { kind: 'overseas_explicit' });
    const was = frozen();
    for (const key of Object.keys(was)) expect(now[key], key).toEqual(was[key]);
  }, 180000);

  it('the snapshot is not vacuous: the whole overseas pack is in it', () => {
    if (WRITE) return;
    const was = frozen();
    for (const entry of ENTRY_POINTS) expect(was[entry], entry).toBeTruthy();
    const fin = was.finalize;
    const keys = fin.tasks.filter((t) => t.task_type === 'practice_pack_child').map((t) => t.related_document_key).sort();
    expect(keys).toEqual(['offer_contract', 'position_description', 'section_g', 'sppa_00', 'supervisor_cv']);
    expect(fin.emailsToDoctor.map((e) => e.subject)).toContain('Documents Needed, GP Link');
    expect(fin.emailsToPractice.map((e) => e.subject).join('|')).toMatch(/Placement confirmed/);
    expect(fin.documents.map((x) => x.document_key)).toContain('section_g');
    expect(JSON.stringify(fin.whatsapps)).toMatch(/ahpra/i);
    expect(fin.caseStage).toBe('ahpra');
  });
});
