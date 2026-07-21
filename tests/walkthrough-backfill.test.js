import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { backfillStateBlob } = require(path.join(__dirname, '..', 'scripts', 'backfill-walkthrough-state.js'));

describe('backfillStateBlob', () => {
  it('adds an all-seen gp_walkthrough_state to a blob that lacks it', () => {
    const out = backfillStateBlob({ gp_selected_country: 'GB' });
    const w = JSON.parse(out.gp_walkthrough_state);
    expect(w.tourDone).toBe(true);
    expect(Object.values(w.tips).every(Boolean)).toBe(true);
    expect(out.gp_selected_country).toBe('GB'); // other keys untouched
  });
  it('is idempotent, leaves an existing value unchanged', () => {
    const existing = { gp_walkthrough_state: JSON.stringify({ tourDone: false, tips: {} }) };
    expect(backfillStateBlob(existing)).toBe(null); // null => skip (already set)
  });
  it('handles a null/empty blob', () => {
    const out = backfillStateBlob(null);
    expect(JSON.parse(out.gp_walkthrough_state).tourDone).toBe(true);
  });
});
