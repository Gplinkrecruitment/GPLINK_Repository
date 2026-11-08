// The drafts board's framing maths (js/ceo-ads-drafts.js frameLayout /
// faceInFrame / freeBand), run in a bare window stand-in. 2026-11-08: the
// headline was drawn straight across the GP's face, and a small figure low
// in the frame under a big sky; 2026-11-09, owner: "fix this once and for
// all". The measured head box now chooses the zone by the room it leaves for
// the words (the top whenever a full headline fits there, since the composer
// adds a dark fade and white type on a top that is not light), and the crop.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js/ceo-ads-drafts.js'), 'utf8');

function load() {
  const window = { ATS: {} };
  window.window = window;
  const document = { getElementById() { return null; }, createElement() { return { getContext() { return null; } }; } };
  const ctx = vm.createContext({ window, document, console, Math, Number, String, Array, Object, JSON, Promise, setTimeout, clearTimeout, setInterval, clearInterval, navigator: {}, Infinity });
  vm.runInContext(SRC, ctx, { filename: 'ceo-ads-drafts.js' });
  return window.AdsDrafts;
}

const box = (x, y, w, h) => ({ x, y, w, h });
const framing = (face, extra) => Object.assign({ person: true, face, body: box(0.2, 0.1, 0.6, 0.9), clear: 'neither', top_light: false }, extra || {});

describe('frameLayout', () => {
  const D = load();

  it('a head in the top band sends the headline to the foot; one low in the frame sends it to the top', () => {
    // Landscape 1600x1000: the full height shows, the crop slides sideways.
    const high = D.frameLayout(framing(box(0.7, 0.1, 0.08, 0.15)), 1600, 1000, null);
    expect(high.placement).toBe('bottom');
    // Window width 0.5 of the picture, head centre 0.74 → (0.74 - 0.25) / 0.5 = 0.98.
    expect(high.focus).toBe(0.98);
    expect(high.face.x).toBeCloseTo(0.42, 2);
    expect(high.band).toBeCloseTo(0.66, 2);
    // Tall 1000x1500: the head low in the picture leaves the whole top free, so the words go up.
    const low = D.frameLayout(framing(box(0.45, 0.75, 0.1, 0.1)), 1000, 1500, null);
    expect(low.placement).toBe('top');
    expect(low.face.y).toBeCloseTo(0.70, 2);
    expect(low.band).toBeCloseTo(0.67, 2);
  });

  it('a head mid-frame takes the top whether or not the top is light (the fade covers a dark top)', () => {
    // 1000x1250 is already 4:5: no crop at all.
    const mid = box(0.45, 0.45, 0.1, 0.1);
    expect(D.frameLayout(framing(mid, { clear: 'both', top_light: true }), 1000, 1250, null)).toMatchObject({ placement: 'top', focus: 0.5, band: 0.42 });
    expect(D.frameLayout(framing(mid, { clear: 'neither', top_light: false }), 1000, 1250, null)).toMatchObject({ placement: 'top', focus: 0.5, band: 0.42 });
  });

  it('a head in the upper third, as the brief asks, leaves too little room above for a full headline, so the words go to the foot over the figure', () => {
    const upper = D.frameLayout(framing(box(0.45, 0.22, 0.1, 0.1)), 1000, 1500, null);
    expect(upper.placement).toBe('bottom');
    expect(upper.focus).toBe(0);
    expect(upper.face.y).toBeCloseTo(0.264, 2);
    expect(upper.band).toBeCloseTo(0.53, 2);
  });

  it('no person, or no face: the zone follows the plain space and the crop stays centred', () => {
    expect(D.frameLayout({ person: false, face: null, body: null, clear: 'top', top_light: true }, 1000, 1250, null)).toEqual({ placement: 'top', focus: 0.5, face: null, band: 0.45 });
    expect(D.frameLayout({ person: true, face: null, body: box(0, 0, 1, 1), clear: 'neither', top_light: false }, 1000, 1250, null)).toEqual({ placement: 'bottom', focus: 0.5, face: null, band: 0.45 });
    expect(D.frameLayout(null, 1000, 1250, null)).toEqual({ placement: 'bottom', focus: 0.5, face: null, band: 0.45 });
  });

  it('a trimmed white band is taken off before the head is placed', () => {
    // 1000x1500 photo with a 300px white band at the top: the trimmed picture is 1000x1200.
    // Head at y 0.5 of the whole image = 750px = 450px into the trimmed picture = 0.375.
    const tb = { l: 0, t: 300, r: 1000, b: 1500, band: 0.2 };
    const face = D.faceInFrame(framing(box(0.45, 0.5, 0.1, 0.08)), 1000, 1500, tb, 0.5);
    // 1000x1200 is a touch wider than 4:5, so the full height shows and the head keeps its trimmed height.
    expect(face.y).toBeCloseTo(0.375, 2);
    expect(face.h).toBeCloseTo(0.1, 2);
  });

  it('freeBand is the room above the head for the top and below it for the foot', () => {
    expect(D.freeBand(null, 'top')).toBe(0.45);
    expect(D.freeBand(box(0.4, 0.5, 0.1, 0.1), 'top')).toBeCloseTo(0.47, 5);
    expect(D.freeBand(box(0.4, 0.5, 0.1, 0.1), 'bottom')).toBeCloseTo(0.31, 5);
    expect(D.MIN_BAND).toBe(0.16);
    expect(D.FULL_BAND).toBe(0.28);
  });
});
