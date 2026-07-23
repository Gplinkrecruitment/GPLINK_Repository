import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const C = require(path.join(__dirname, '..', 'js', 'gp-coach.js'));

const VP = { width: 390, height: 788 };
const TIP = { width: 280, height: 150 };

describe('gp-coach computePlacement', () => {
  it('places the tip BELOW a target in the top half', () => {
    const p = C.computePlacement({ left: 20, top: 100, width: 60, height: 40 }, TIP, VP, {});
    expect(p.placeBelow).toBe(true);
    expect(p.tip.top).toBeGreaterThan(100);
  });

  it('places the tip ABOVE a target in the bottom half (e.g. nav bar)', () => {
    const p = C.computePlacement({ left: 20, top: 720, width: 60, height: 44 }, TIP, VP, {});
    expect(p.placeBelow).toBe(false);
    expect(p.tip.top).toBeLessThan(720);
  });

  it('clamps the tip within the viewport horizontally', () => {
    const left = C.computePlacement({ left: 0, top: 100, width: 40, height: 40 }, TIP, VP, {});
    expect(left.tip.left).toBeGreaterThanOrEqual(12);
    const right = C.computePlacement({ left: 380, top: 100, width: 40, height: 40 }, TIP, VP, {});
    expect(right.tip.left + TIP.width).toBeLessThanOrEqual(VP.width - 12 + 0.001);
  });

  it('keeps the arrow inside the tip', () => {
    const p = C.computePlacement({ left: 0, top: 100, width: 20, height: 20 }, TIP, VP, {});
    expect(p.arrowLeft).toBeGreaterThanOrEqual(12);
    expect(p.arrowLeft).toBeLessThanOrEqual(TIP.width - 12);
  });

  it('spotlight box pads around the target', () => {
    const p = C.computePlacement({ left: 100, top: 100, width: 60, height: 40 }, TIP, VP, { pad: 8 });
    expect(p.spot).toEqual({ left: 92, top: 92, width: 76, height: 56 });
  });
});

describe('gp-coach cancel + lost-target teardown', () => {
  it('exposes a cancel() API that is a safe no-op when idle', () => {
    expect(typeof C.cancel).toBe('function');
    expect(() => C.cancel()).not.toThrow();
    expect(C.isActive()).toBe(false);
  });

  it('reposition ends the run when the target rect collapses to 0x0', () => {
    // A target hidden mid-run (nav chrome hidden for the onboarding gateway)
    // reads 0x0 at the viewport origin — rendering that strands the spotlight
    // in the top-left corner over whatever now owns the screen. The run must
    // end quietly instead (no onDone/onSkip, so nothing is marked seen).
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'gp-coach.js'), 'utf8');
    const block = src.slice(src.indexOf('function reposition'), src.indexOf('function renderActions'));
    expect(block).toContain("cleanup('lost')");
  });
});
