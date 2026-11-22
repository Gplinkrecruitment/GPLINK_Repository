import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

// WP-24: with the Australian switch OFF, one full cycle of the ads hub and the
// conversion feed is exactly what it was before WP-24 changed any code.
// The snapshot (tests/fixtures/au-wp24/single-campaign.json) was written from
// the commit before the change; see tests/helpers/au-wp24-parity.js.
const require = createRequire(import.meta.url);
const parity = require('./helpers/au-wp24-parity.js');

describe('WP-24 parity, switch OFF: one campaign is exactly today', () => {
  it('prompts, review, page, account change, Conversions API requests and page tracking match the pre-change snapshot', async () => {
    const got = await parity.captureSingleCampaign(vi, { switchOn: false });
    if (process.env.WP24_WRITE_SNAPSHOT === '1') { parity.writeSnapshot(got); return; }
    const want = parity.readSnapshot();
    for (const key of Object.keys(want)) expect(got[key], key).toEqual(want[key]);
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    expect(got.page_extra_keys).toEqual([]);
    expect(got.blocked_outbound).toEqual([]);
  }, 60000);
});
