import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

// WP-24: with the Australian switch ON and no Australian campaign configured
// (today), the same cycle for the one existing campaign is exactly what it was
// before WP-24: same prompts, same review, same proposals, same Graph writes,
// same Conversions API requests. The page payload gains ONE key beside the old
// ones (`campaigns`), which the capture sets aside and reports; the public
// features answer gains the tracking block.
const require = createRequire(import.meta.url);
const parity = require('./helpers/au-wp24-parity.js');

describe('WP-24 parity, switch ON, no Australian campaign configured', () => {
  it('matches the pre-change snapshot', async () => {
    const got = await parity.captureSingleCampaign(vi, { switchOn: true });
    const want = parity.readSnapshot();
    const allowed = { features_keys: true, page_extra_keys: true };
    for (const key of Object.keys(want)) { if (!allowed[key]) expect(got[key], key).toEqual(want[key]); }
    expect(got.blocked_outbound).toEqual([]);
  }, 60000);
});
