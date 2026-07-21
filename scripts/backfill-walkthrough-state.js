// One-time launch backfill: mark every EXISTING user's walkthrough as fully seen so the
// auto-tour and first-visit tips only ever fire for brand-new sign-ups.
// Pure transform `backfillStateBlob` is unit-tested; the runner is guarded behind `main`.
// Runner talks to the Supabase REST API directly via Node's global `fetch` (Node 20),
// there is NO @supabase/supabase-js dependency (it is not installed in this repo). Needs
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SERVICE_ROLE_KEY) in the environment.
// Run once, in a quiet window, e.g.:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-walkthrough-state.js
const path = require('path');
const S = require(path.join(__dirname, '..', 'js', 'gp-walkthrough-state.js'));

// Returns the NEW state blob (object) to write, or null if the row already has the key.
function backfillStateBlob(stateBlob) {
  const blob = stateBlob && typeof stateBlob === 'object' ? stateBlob : {};
  if (Object.prototype.hasOwnProperty.call(blob, 'gp_walkthrough_state')) return null;
  const next = Object.assign({}, blob);
  next.gp_walkthrough_state = S.serializeState(S.allSeenState());
  return next;
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('Missing SUPABASE_URL / SERVICE_ROLE_KEY'); process.exit(1); }

  const headers = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };

  const PAGE = 500;
  let offset = 0, updated = 0, skipped = 0;
  for (;;) {
    let rows;
    try {
      const res = await fetch(
        `${url}/rest/v1/user_state?select=user_id,state&limit=${PAGE}&offset=${offset}`,
        { headers: Object.assign({ Prefer: 'count=none' }, headers) }
      );
      if (!res.ok) { console.error('List failed', res.status, await res.text()); break; }
      rows = await res.json();
    } catch (e) {
      console.error('List request failed', e);
      break;
    }
    if (!Array.isArray(rows) || !rows.length) break;

    for (const row of rows) {
      const next = backfillStateBlob(row.state);
      if (!next) { skipped++; continue; }
      try {
        const res = await fetch(
          `${url}/rest/v1/user_state?user_id=eq.${encodeURIComponent(row.user_id)}`,
          {
            method: 'PATCH',
            headers: Object.assign({ Prefer: 'return=minimal' }, headers),
            body: JSON.stringify({ state: next })
          }
        );
        if (!res.ok) { console.error('Update failed', row.user_id, res.status, await res.text()); continue; }
        updated++;
      } catch (e) {
        console.error('Update request failed', row.user_id, e);
        continue;
      }
    }

    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  console.log('Backfill complete. updated=' + updated + ' skipped=' + skipped);
}

module.exports = { backfillStateBlob };
if (require.main === module) main();
