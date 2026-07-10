// One-time launch backfill: mark every EXISTING user's walkthrough as fully seen so the
// auto-tour and first-visit tips only ever fire for brand-new sign-ups.
// Pure transform `backfillStateBlob` is unit-tested; the runner is guarded behind `main`.
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
  // Lazy-require so unit tests never touch the network.
  const { createClient } = requireSupabase();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('Missing SUPABASE_URL / SERVICE_ROLE_KEY'); process.exit(1); }
  const db = createClient(url, key);

  const PAGE = 500;
  let from = 0, updated = 0, skipped = 0;
  for (;;) {
    const { data, error } = await db.from('user_state').select('user_id,state').range(from, from + PAGE - 1);
    if (error) { console.error(error); process.exit(1); }
    if (!data || !data.length) break;
    for (const row of data) {
      const next = backfillStateBlob(row.state);
      if (!next) { skipped++; continue; }
      const upd = await db.from('user_state').update({ state: next }).eq('user_id', row.user_id);
      if (upd.error) { console.error('update failed', row.user_id, upd.error); } else { updated++; }
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log('Backfill complete. updated=' + updated + ' skipped=' + skipped);
}

function requireSupabase() {
  try { return require('@supabase/supabase-js'); }
  catch (e) { console.error('Install @supabase/supabase-js or adapt to supabaseDbRequest before running.'); process.exit(1); }
}

module.exports = { backfillStateBlob };
if (require.main === module) main();
