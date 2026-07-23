// A practice can ask for MORE THAN ONE GP on the intake form (gps_needed). The
// opening must stay open — and its other candidates stay live — until that many
// are hired. This covers the parsing of the free-text count, the pure fill
// decision, and asserts every place that closes an opening or redirects the
// remaining candidates is gated on the opening actually being full.
const fs = require('fs');
const path = require('path');
const { parseGpsNeeded, computeJobFill } = require('../lib/practice-intake-logic');

const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

describe('parseGpsNeeded — free-text headcount', () => {
  it('reads a plain number', () => {
    expect(parseGpsNeeded('3')).toBe(3);
    expect(parseGpsNeeded('1')).toBe(1);
  });
  it('defaults to 1 when absent or unparseable, so old jobs are unchanged', () => {
    expect(parseGpsNeeded('')).toBe(1);
    expect(parseGpsNeeded(null)).toBe(1);
    expect(parseGpsNeeded(undefined)).toBe(1);
    expect(parseGpsNeeded('a few')).toBe(1);
  });
  it('takes the larger end of a range, so it never closes before the maximum', () => {
    expect(parseGpsNeeded('2-3')).toBe(3);
    expect(parseGpsNeeded('2 to 4')).toBe(4);
  });
  it('reads a number embedded in words', () => {
    expect(parseGpsNeeded('We need 2 GPs')).toBe(2);
  });
  it('clamps out-of-range values', () => {
    expect(parseGpsNeeded('0')).toBe(1);
    expect(parseGpsNeeded('-5')).toBe(5); // digits only; magnitude, never < 1
    expect(parseGpsNeeded('999')).toBe(50);
  });
});

describe('computeJobFill — the single gate', () => {
  it('is NOT full until hired reaches the target', () => {
    expect(computeJobFill('3', 0)).toMatchObject({ needed: 3, hired: 0, isFull: false, remaining: 3 });
    expect(computeJobFill('3', 1)).toMatchObject({ needed: 3, hired: 1, isFull: false, remaining: 2 });
    expect(computeJobFill('3', 2)).toMatchObject({ needed: 3, hired: 2, isFull: false, remaining: 1 });
  });
  it('is full once hired meets or exceeds the target', () => {
    expect(computeJobFill('3', 3)).toMatchObject({ isFull: true, remaining: 0 });
    expect(computeJobFill('3', 4)).toMatchObject({ isFull: true, remaining: 0 });
  });
  it('a single-GP opening fills on the first hire (backward compatible)', () => {
    expect(computeJobFill('1', 0).isFull).toBe(false);
    expect(computeJobFill('1', 1).isFull).toBe(true);
    // No value at all behaves as a single-GP opening.
    expect(computeJobFill(null, 1).isFull).toBe(true);
  });
  it('never reports negative remaining or counts a negative hired', () => {
    expect(computeJobFill('2', -3)).toMatchObject({ hired: 0, remaining: 2, isFull: false });
  });
});

describe('server wiring — every close/redirect path is gated on the opening being full', () => {
  it('exposes the fill-state helpers', () => {
    expect(serverSrc).toMatch(/function jobPositionsNeeded\(/);
    expect(serverSrc).toMatch(/async function atsJobFillState\(/);
    expect(serverSrc).toMatch(/async function atsJobHiredCount\(/);
    // Hired count is the "Hired lane" — ats_stage='hired'.
    const idxCount = serverSrc.indexOf('async function atsJobHiredCount');
    expect(serverSrc.slice(idxCount, idxCount + 600)).toContain('ats_stage=eq.hired');
  });

  it('placement finalize only flips job_status to filled once the opening is full', () => {
    // Step (7) of finalizeInAppPlacement.
    const idx = serverSrc.indexOf('Internal (in-app) jobs are filled by this acceptance');
    expect(idx).toBeGreaterThan(-1);
    const block = serverSrc.slice(idx, idx + 700);
    expect(block).toContain('atsJobFillState');
    // The atsUpdateJobRow(... job_status: 'filled') must sit INSIDE an isFull check.
    const idxFill = block.indexOf('.isFull');
    const idxMark = block.indexOf("job_status: 'filled'");
    expect(idxFill).toBeGreaterThan(-1);
    expect(idxMark).toBeGreaterThan(idxFill);
  });

  it('the kanban-hire fan-out only fires once the opening is full', () => {
    const idx = serverSrc.indexOf("pathname === '/api/ats/application' && req.method === 'PATCH'");
    const idxTrigger = serverSrc.indexOf('redirectOthersForJob(updatedAP.career_role_id, apId)', idx);
    const guard = serverSrc.slice(idx, idxTrigger);
    // Still opt-in via redirect_others (unchanged), now ALSO gated on fill.
    expect(guard).toContain("newStage === 'hired' && upAP.prevStage !== 'hired' && bodyAP.redirect_others === true");
    expect(guard).toContain('atsJobFillState');
    expect(guard).toMatch(/\.isFull/);
  });

  it('the mark-placement-secured fan-out only fires once the opening is full', () => {
    const idx = serverSrc.indexOf("pathname === '/api/ats/placement' && req.method === 'POST'");
    const idxTrigger = serverSrc.indexOf('redirectOthersForJob(plcApp.career_role_id, plcAppId)', idx);
    const guard = serverSrc.slice(idx, idxTrigger);
    expect(guard).toContain('bodyPlc && bodyPlc.redirect_others === true');
    expect(guard).toContain('atsJobFillState');
    expect(guard).toMatch(/\.isFull/);
  });

  it('reports the headcount back to the client so the UI can explain the deferral', () => {
    // Both fill paths return a `positions` block with needed/hired/full.
    expect(serverSrc).toMatch(/positions:\s*(ap|plc)Positions/);
    expect(serverSrc).toMatch(/needed:.*hired:.*full:/s);
  });
});
