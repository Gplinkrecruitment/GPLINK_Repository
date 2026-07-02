'use strict';

/**
 * ATS offers storage adapter (standalone-ATS Task B).
 *
 * Three storage tiers, in order:
 *  1. Supabase table `ats_offers` (migration 20260703091000 — may NOT be applied yet).
 *  2. runtime_kv fallback when the table is missing: one key per offer
 *     (`ats_offer:{application_id}`) plus an `ats_offers_index` key holding the
 *     list of application ids, so offers can still be listed for board flags.
 *     The missing-table determination is CACHED per store instance (and logged
 *     once), so the fallback never pays for a second failing query.
 *  3. Local-JSON dev mode: `dbState.atsOffers` array.
 *
 * The adapter deliberately has NO imports from server.js — it RECEIVES the
 * database/kv capabilities from the caller via createAtsOffersStore(ctx), the
 * same "callers pass capabilities" philosophy as the other lib/ modules
 * (lib/interview-meetings.js et al. are pure and take rows; this one takes
 * accessors because it owns the dual-mode read/write logic):
 *
 *   ctx = {
 *     isSupabaseDbConfigured: () => bool,
 *     supabaseDbRequest:      (table, query, opts) => Promise<{ok,status,data}>,
 *     getRuntimeKv:           (key) => Promise<{key,value}|null>,
 *     setRuntimeKv:           (key, value, expiresAtMs?) => Promise<bool>,
 *     getDbState:             () => localJsonDbState,   // local mode only
 *     saveDbState:            () => void,                // local mode only
 *     log:                    optional (…args) => void   // defaults to console.log
 *   }
 *
 * Offers are keyed on application_id (one live offer per application; a re-send
 * upserts the same record).
 */

var OFFER_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'withdrawn'];
var KV_OFFER_PREFIX = 'ats_offer:';
var KV_INDEX_KEY = 'ats_offers_index';
var TABLE = 'ats_offers';

// PostgREST "relation is missing" detection: Postgres 42P01 = undefined_table,
// PGRST205 = table not found in the schema cache. Message probes cover older
// PostgREST wordings. Anything else (RLS, network, validation) is NOT a signal
// to fall back — those errors surface as a failed save instead.
function isMissingRelationError(result) {
  if (!result || result.ok) return false;
  var d = result.data;
  var code = (d && typeof d === 'object') ? String(d.code || '') : '';
  var msg = d ? (typeof d === 'string' ? d : String(d.message || '')) : '';
  if (code === '42P01' || code === 'PGRST205') return true;
  return /relation .* does not exist|could not find the table/i.test(msg);
}

function nowIso() { return new Date().toISOString(); }

function localOfferId() {
  return 'offer_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function createAtsOffersStore(ctx) {
  if (!ctx || typeof ctx.isSupabaseDbConfigured !== 'function') {
    throw new Error('createAtsOffersStore requires a ctx with db/kv accessors');
  }
  var log = typeof ctx.log === 'function' ? ctx.log : function () { console.log.apply(console, arguments); };

  // Cached determination: once the ats_offers table is seen to be missing we
  // stop querying it for the life of the process and use runtime_kv directly.
  var tableMissing = false;

  function markTableMissing() {
    if (!tableMissing) {
      tableMissing = true;
      log('[ats-offers] ats_offers table not found — falling back to runtime_kv (apply migration 20260703091000 to persist offers as rows)');
    }
  }

  function localRows() {
    var db = ctx.getDbState ? ctx.getDbState() : null;
    if (!db) return [];
    if (!Array.isArray(db.atsOffers)) db.atsOffers = [];
    return db.atsOffers;
  }

  // ---- runtime_kv tier ------------------------------------------------------

  async function kvReadIndex() {
    var kv = await ctx.getRuntimeKv(KV_INDEX_KEY);
    var v = kv && kv.value;
    return (v && Array.isArray(v.ids)) ? v.ids.map(String) : [];
  }

  async function kvGetOffer(applicationId) {
    var kv = await ctx.getRuntimeKv(KV_OFFER_PREFIX + String(applicationId));
    var v = kv && kv.value;
    return (v && v.application_id) ? v : null;
  }

  async function kvSaveOffer(offer) {
    await ctx.setRuntimeKv(KV_OFFER_PREFIX + String(offer.application_id), offer);
    var ids = await kvReadIndex();
    if (ids.indexOf(String(offer.application_id)) === -1) {
      ids.push(String(offer.application_id));
      await ctx.setRuntimeKv(KV_INDEX_KEY, { ids: ids });
    }
    return offer;
  }

  // ---- public API -----------------------------------------------------------

  // Upsert (keyed on application_id). `offer` carries the full field set; the
  // existing record's id/created_at survive a re-send. Returns the saved offer
  // or null when the write failed for a non-missing-table reason.
  async function saveAtsOffer(offer) {
    var appId = String(offer && offer.application_id || '');
    if (!appId) return null;
    var stamp = nowIso();

    if (!ctx.isSupabaseDbConfigured()) {
      var rows = localRows();
      var existing = rows.find(function (o) { return String(o.application_id) === appId; });
      if (existing) {
        Object.assign(existing, offer, { id: existing.id, created_at: existing.created_at, updated_at: stamp });
        ctx.saveDbState();
        return existing;
      }
      var localRow = Object.assign({ id: localOfferId(), created_at: stamp }, offer, { updated_at: stamp });
      rows.push(localRow);
      ctx.saveDbState();
      return localRow;
    }

    if (!tableMissing) {
      var found = await ctx.supabaseDbRequest(TABLE, 'select=id,created_at&application_id=eq.' + encodeURIComponent(appId) + '&limit=1');
      if (isMissingRelationError(found)) {
        markTableMissing();
      } else if (found.ok) {
        var row = Array.isArray(found.data) && found.data[0] ? found.data[0] : null;
        var body = Object.assign({}, offer, { updated_at: stamp });
        delete body.id; delete body.created_at;
        var written;
        if (row) {
          written = await ctx.supabaseDbRequest(TABLE, 'id=eq.' + encodeURIComponent(row.id), {
            method: 'PATCH', headers: { Prefer: 'return=representation' }, body: body
          });
        } else {
          written = await ctx.supabaseDbRequest(TABLE, '', {
            method: 'POST', headers: { Prefer: 'return=representation' }, body: [body]
          });
        }
        if (isMissingRelationError(written)) {
          markTableMissing();
        } else {
          return (written.ok && Array.isArray(written.data) && written.data[0]) ? written.data[0] : null;
        }
      }
      // found failed for another reason (network/RLS): fall through to kv so a
      // transient table error doesn't lose the offer — the kv copy is the
      // durable record until the table answers again.
    }

    var prior = await kvGetOffer(appId);
    var merged = Object.assign(
      { id: (prior && prior.id) || localOfferId(), created_at: (prior && prior.created_at) || stamp },
      offer,
      { updated_at: stamp }
    );
    return kvSaveOffer(merged);
  }

  async function getAtsOfferByApplication(applicationId) {
    var appId = String(applicationId || '');
    if (!appId) return null;

    if (!ctx.isSupabaseDbConfigured()) {
      return localRows().find(function (o) { return String(o.application_id) === appId; }) || null;
    }

    if (!tableMissing) {
      var r = await ctx.supabaseDbRequest(TABLE, 'select=*&application_id=eq.' + encodeURIComponent(appId) + '&order=created_at.desc&limit=1');
      if (isMissingRelationError(r)) {
        markTableMissing();
      } else if (r.ok) {
        var hit = Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
        if (hit) return hit;
        // Not in the table — an offer may have been parked in kv during an
        // earlier missing-table window; check there before answering "none".
        return kvGetOffer(appId);
      }
    }
    return kvGetOffer(appId);
  }

  // Merge {status, updated_at, ...extra} onto the stored offer. Returns the
  // updated offer, or null when no offer exists / the status is unknown.
  async function updateAtsOfferStatus(applicationId, status, extra) {
    var appId = String(applicationId || '');
    if (!appId || OFFER_STATUSES.indexOf(String(status)) === -1) return null;
    var current = await getAtsOfferByApplication(appId);
    if (!current) return null;
    var merged = Object.assign({}, current, extra || {}, { status: String(status), updated_at: nowIso() });
    return saveAtsOffer(merged);
  }

  // List offers, optionally narrowed to a set of application ids — the cheap
  // "does this application have an offer?" flag source for board/drawer views.
  async function listAtsOffers(applicationIds) {
    var filter = Array.isArray(applicationIds) ? applicationIds.map(String).filter(Boolean) : null;
    if (filter && filter.length === 0) return [];

    if (!ctx.isSupabaseDbConfigured()) {
      var rows = localRows();
      return filter
        ? rows.filter(function (o) { return filter.indexOf(String(o.application_id)) !== -1; })
        : rows.slice();
    }

    if (!tableMissing) {
      var q = filter
        ? 'select=*&application_id=in.(' + encodeURIComponent(filter.join(',')) + ')&limit=2000'
        : 'select=*&limit=2000';
      var r = await ctx.supabaseDbRequest(TABLE, q);
      if (isMissingRelationError(r)) {
        markTableMissing();
      } else if (r.ok) {
        return Array.isArray(r.data) ? r.data : [];
      } else {
        return [];
      }
    }

    var ids = await kvReadIndex();
    if (filter) ids = ids.filter(function (id) { return filter.indexOf(id) !== -1; });
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var offer = await kvGetOffer(ids[i]);
      if (offer) out.push(offer);
    }
    return out;
  }

  return {
    saveAtsOffer: saveAtsOffer,
    getAtsOfferByApplication: getAtsOfferByApplication,
    updateAtsOfferStatus: updateAtsOfferStatus,
    listAtsOffers: listAtsOffers
  };
}

module.exports = {
  createAtsOffersStore: createAtsOffersStore,
  isMissingRelationError: isMissingRelationError,
  OFFER_STATUSES: OFFER_STATUSES,
  KV_OFFER_PREFIX: KV_OFFER_PREFIX,
  KV_INDEX_KEY: KV_INDEX_KEY
};
