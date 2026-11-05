'use strict';

// lib/ads-actions.js — the changes the morning review proposes for the Meta
// account itself, and the executor that applies the ones the owner ticks.
//
// The model (lib/ads-review.js) writes `account_changes`: pause or resume an
// ad or an ad set, change an ad set's daily budget, launch a draft that is
// ready on the page. Each names the exact Meta id it means. The owner ticks
// the ones to make and presses Submit; POST /api/ceo/ads/changes/apply hands
// them here.
//
// Nothing is applied on the model's word alone. Every change is checked
// against the account AS IT IS WHEN THE BUTTON IS PRESSED (fresh ad / ad set
// reads), not as it was when the review ran hours earlier: an ad that is
// already paused is skipped, a budget jump over the ceiling is refused, a
// pause that would leave an ad set with nothing running is refused, a draft
// with problems is refused. Only the six listed kinds of change exist; the
// model cannot ask for anything else, so a confused suggestion can never
// touch targeting, lead forms or creatives.
//
// Pure except applyChanges(), which takes injectable Meta calls (fetchImpl)
// and an injectable draft launcher, so the whole flow is testable offline.

const metaAds = require('./meta-ads.js');

const ACTIONS = ['pause_ad', 'resume_ad', 'pause_adset', 'resume_adset', 'set_adset_daily_budget', 'launch_draft'];
const ACTION_LABELS = {
  pause_ad: 'Pause ad',
  resume_ad: 'Resume ad',
  pause_adset: 'Pause ad set',
  resume_adset: 'Resume ad set',
  set_adset_daily_budget: 'Daily budget',
  launch_draft: 'Launch draft'
};

// Floors and ceilings the executor enforces whatever the model proposed.
const DEFAULT_MIN_LIVE_ADS = 1;        // a pause may never empty an ad set
const DEFAULT_MAX_DAILY_BUDGET = 300;  // account currency per day, per ad set
const MAX_BUDGET_STEP = 2;             // at most double in one change
const MAX_CHANGES = 8;

// Structured-output schema for one change. Same Meta-rule as the rest of the
// review schema: no maxItems / minimum / maximum (the API rejects them), so
// every limit is in the description and enforced by normaliseChanges().
const CHANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: 'chg-1, chg-2, ...' },
    action: {
      type: 'string',
      enum: ACTIONS,
      description: 'pause_ad / resume_ad: an ad by its ad_id. pause_adset / resume_adset: an ad set by its id. set_adset_daily_budget: a new daily budget for an ad set. launch_draft: create a live ad from a draft that is ready on the page, by its draft_id.'
    },
    target_id: { type: 'string', description: 'The exact id from the data: ad_id for an ad, the ad set id for an ad set, draft_id for a draft. Never invent one.' },
    target_name: { type: 'string', description: 'The ad, ad set or draft name as the owner sees it.' },
    daily_budget: { type: 'number', description: 'Only for set_adset_daily_budget: the new daily budget per day in the account currency (whole dollars are fine). 0 for every other action.' },
    title: { type: 'string', description: 'Plain English, under 100 characters, e.g. "Pause the No QOF before ad".' },
    why: { type: 'string', description: 'The numbers this rests on, one or two sentences.' },
    priority: { type: 'integer', description: '1 (do first) to 3 (nice to have).' }
  },
  required: ['id', 'action', 'target_id', 'target_name', 'daily_budget', 'title', 'why', 'priority']
};

function limits(env) {
  const e = env || process.env || {};
  const minLive = Number(e.ADS_MIN_LIVE_ADS);
  const maxBudget = Number(e.ADS_MAX_DAILY_BUDGET);
  return {
    minLiveAds: Number.isFinite(minLive) && minLive >= 0 ? Math.floor(minLive) : DEFAULT_MIN_LIVE_ADS,
    maxDailyBudget: Number.isFinite(maxBudget) && maxBudget > 0 ? maxBudget : DEFAULT_MAX_DAILY_BUDGET,
    maxBudgetStep: MAX_BUDGET_STEP
  };
}

function short(s, n) {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function money(v, currency) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const sym = !currency || currency === 'AUD' ? 'A$' : (currency + ' ');
  return sym + (Math.round(n * 100) / 100).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function statusWord(s) {
  return ({ ACTIVE: 'live', PAUSED: 'paused', ADSET_PAUSED: 'paused with its ad set', CAMPAIGN_PAUSED: 'paused with the campaign', PENDING_REVIEW: 'in review', WITH_ISSUES: 'flagged with issues', DISAPPROVED: 'disapproved', ARCHIVED: 'archived', DELETED: 'deleted', IN_PROCESS: 'processing' })[s] || String(s || 'unknown').toLowerCase();
}

function defaultTitle(action, name) {
  const n = name ? ' "' + name + '"' : '';
  return ({
    pause_ad: 'Pause the ad' + n,
    resume_ad: 'Resume the ad' + n,
    pause_adset: 'Pause the ad set' + n,
    resume_adset: 'Resume the ad set' + n,
    set_adset_daily_budget: 'Change the daily budget of' + (n || ' the ad set'),
    launch_draft: 'Launch the draft' + n
  })[action] || 'Change';
}

// ── normalising what the model wrote ───────────────────────────────────────
function normaliseChange(x, idx) {
  const y = x || {};
  const action = ACTIONS.indexOf(y.action) !== -1 ? y.action : '';
  const target = String(y.target_id == null ? '' : y.target_id).trim().slice(0, 64);
  if (!action || !target) return null;
  const budget = action === 'set_adset_daily_budget' ? Math.round((Number(y.daily_budget) || 0) * 100) / 100 : 0;
  if (action === 'set_adset_daily_budget' && !(budget > 0)) return null;
  const name = short(y.target_name, 160);
  return {
    id: /^chg-\d+$/.test(String(y.id || '')) ? String(y.id) : ('chg-' + (idx + 1)),
    action: action,
    target_id: target,
    target_name: name,
    daily_budget: budget,
    title: short(y.title, 160) || defaultTitle(action, name),
    why: short(y.why, 600),
    priority: Math.min(3, Math.max(1, Math.round(Number(y.priority)) || 2)),
    // Set by the executor once the owner has applied it (or tried to).
    applied: null
  };
}

function normaliseChanges(list) {
  // Valid entries first, then the cap: a malformed entry must not use up a slot.
  const out = (Array.isArray(list) ? list : []).map(normaliseChange).filter(Boolean).slice(0, MAX_CHANGES);
  const seen = {};
  out.forEach(function (c, i) { if (seen[c.id]) c.id = 'chg-' + (i + 1) + 'b'; seen[c.id] = true; });
  return out;
}

// ── describing a change against the account ───────────────────────────────
function findAd(ctx, id) { return ((ctx && ctx.ads) || []).find(function (a) { return String(a.id) === String(id); }) || null; }
function findAdset(ctx, id) { return ((ctx && ctx.adsets) || []).find(function (a) { return String(a.id) === String(id); }) || null; }
function findDraft(ctx, id) { return ((ctx && ctx.drafts) || []).find(function (d) { return String(d.id) === String(id); }) || null; }

// One sentence saying exactly what will happen, for the tick box and the
// confirmation. `ctx` is the latest snapshot ({ ads, adsets, drafts, currency }).
function describeChange(change, ctx) {
  const c = change || {};
  const cur = ctx && ctx.currency;
  if (c.action === 'pause_ad' || c.action === 'resume_ad') {
    const ad = findAd(ctx, c.target_id);
    const name = (ad && (ad.name || (ad.creative && ad.creative.headline))) || c.target_name || c.target_id;
    const verb = c.action === 'pause_ad' ? 'Pauses' : 'Resumes';
    return verb + ' the ad "' + name + '"' + (ad ? ' (' + statusWord(ad.effective_status) + ' now' + (ad.adset_name ? ', in ' + ad.adset_name : '') + ').' : '. It is not in the latest snapshot; it will be checked when applied.');
  }
  if (c.action === 'pause_adset' || c.action === 'resume_adset') {
    const set = findAdset(ctx, c.target_id);
    const name = (set && set.name) || c.target_name || c.target_id;
    const count = ((ctx && ctx.ads) || []).filter(function (a) { return String(a.adset_id) === String(c.target_id); }).length;
    if (c.action === 'pause_adset') {
      return 'Pauses the ad set "' + name + '"' + (set ? ' (' + statusWord(set.effective_status) + ' now, ' + money(set.daily_budget, cur) + ' a day)' : '') + '. Every ad in it stops delivering' + (count ? ' (' + count + ' ad' + (count === 1 ? '' : 's') + ')' : '') + '.';
    }
    return 'Resumes the ad set "' + name + '"' + (set ? ' (' + statusWord(set.effective_status) + ' now, ' + money(set.daily_budget, cur) + ' a day)' : '') + '. Its ads start delivering again' + (count ? ' (' + count + ' ad' + (count === 1 ? '' : 's') + ')' : '') + '.';
  }
  if (c.action === 'set_adset_daily_budget') {
    const set = findAdset(ctx, c.target_id);
    const name = (set && set.name) || c.target_name || c.target_id;
    return 'Changes the daily budget of "' + name + '" ' + (set ? 'from ' + money(set.daily_budget, cur) + ' ' : '') + 'to ' + money(c.daily_budget, cur) + ' a day.';
  }
  if (c.action === 'launch_draft') {
    const d = findDraft(ctx, c.target_id);
    const name = (d && (d.angle || d.headline)) || c.target_name || c.target_id;
    return 'Launches the draft "' + name + '"' + (d && d.headline && d.headline !== name ? ' ("' + d.headline + '")' : '') + ' as a new live ad' + (d && d.status ? ' (draft is ' + d.status + ')' : '') + '.';
  }
  return c.title || 'Change';
}

function describeChanges(list, ctx) {
  return (Array.isArray(list) ? list : []).map(function (c) {
    return Object.assign({}, c, { label: ACTION_LABELS[c.action] || c.action, effect: describeChange(c, ctx) });
  });
}

// ── checking a change against the live account ────────────────────────────
// `live` = { ads, adsets } as fetched now (mutated by the executor as changes
// land, so a later pause sees an earlier launch). `drafts` = the ad_drafts
// rows. Returns { ok: true } | { ok: false, skip: true, message } (already in
// that state, nothing to do) | { ok: false, message } (refused).
function liveAdsInSet(live, adsetId, exceptId) {
  return ((live && live.ads) || []).filter(function (a) {
    return String(a.adset_id) === String(adsetId) && a.effective_status === 'ACTIVE' && String(a.id) !== String(exceptId || '');
  }).length;
}

function checkChange(change, live, drafts, lim) {
  const c = change || {};
  const L = lim || limits();
  if (ACTIONS.indexOf(c.action) === -1) return { ok: false, message: 'Unknown kind of change.' };
  if (c.action === 'pause_ad' || c.action === 'resume_ad') {
    const ad = findAd(live, c.target_id);
    if (!ad) return { ok: false, message: 'This ad is no longer in the campaign.' };
    if (c.action === 'pause_ad') {
      if (ad.effective_status === 'PAUSED' || ad.status === 'PAUSED') return { ok: false, skip: true, message: 'Already paused.' };
      if (ad.effective_status !== 'ACTIVE') return { ok: false, skip: true, message: 'Not running (' + statusWord(ad.effective_status) + '), so there is nothing to pause.' };
      const left = liveAdsInSet(live, ad.adset_id, ad.id);
      if (left < L.minLiveAds) {
        return { ok: false, message: 'Refused: pausing this would leave ' + left + ' live ad' + (left === 1 ? '' : 's') + ' in its ad set (the floor is ' + L.minLiveAds + '). Launch or resume another ad first.' };
      }
      return { ok: true };
    }
    if (ad.status === 'ACTIVE' && ad.effective_status === 'ACTIVE') return { ok: false, skip: true, message: 'Already live.' };
    if (ad.effective_status === 'DELETED' || ad.effective_status === 'ARCHIVED') return { ok: false, message: 'This ad is ' + statusWord(ad.effective_status) + ' and cannot be resumed.' };
    return { ok: true };
  }
  if (c.action === 'pause_adset' || c.action === 'resume_adset') {
    const set = findAdset(live, c.target_id);
    if (!set) return { ok: false, message: 'This ad set is no longer in the campaign.' };
    const wantPaused = c.action === 'pause_adset';
    const isPaused = set.status === 'PAUSED' || set.effective_status === 'PAUSED';
    if (wantPaused && isPaused) return { ok: false, skip: true, message: 'Already paused.' };
    if (!wantPaused && !isPaused && set.effective_status === 'ACTIVE') return { ok: false, skip: true, message: 'Already live.' };
    if (wantPaused) {
      const others = ((live && live.adsets) || []).filter(function (s) { return String(s.id) !== String(set.id) && s.effective_status === 'ACTIVE'; }).length;
      if (others < 1 && L.minLiveAds > 0) return { ok: false, message: 'Refused: this is the only ad set running. Pausing it would stop the whole campaign; resume another ad set first.' };
    }
    return { ok: true };
  }
  if (c.action === 'set_adset_daily_budget') {
    const set = findAdset(live, c.target_id);
    if (!set) return { ok: false, message: 'This ad set is no longer in the campaign.' };
    const next = Number(c.daily_budget);
    const now = Number(set.daily_budget) || 0;
    if (!(next > 0)) return { ok: false, message: 'The new daily budget must be above zero.' };
    if (next > L.maxDailyBudget) return { ok: false, message: 'Refused: ' + money(next) + ' a day is above the ceiling of ' + money(L.maxDailyBudget) + ' (ADS_MAX_DAILY_BUDGET).' };
    if (now > 0 && next > now * L.maxBudgetStep) return { ok: false, message: 'Refused: ' + money(next) + ' is more than double the current ' + money(now) + ' a day. Raise it in smaller steps.' };
    if (Math.abs(next - now) < 0.005) return { ok: false, skip: true, message: 'Already ' + money(now) + ' a day.' };
    return { ok: true };
  }
  if (c.action === 'launch_draft') {
    const d = findDraft({ drafts: drafts }, c.target_id);
    if (!d) return { ok: false, message: 'This draft no longer exists.' };
    if (d.status === 'live' || d.meta_ad_id) return { ok: false, skip: true, message: 'Already live' + (d.meta_ad_id ? ' (ad ' + d.meta_ad_id + ')' : '') + '.' };
    if (d.status === 'launching') return { ok: false, message: 'A launch is already in progress for this draft.' };
    if (d.status === 'archived') return { ok: false, message: 'This draft is archived.' };
    const problems = metaAds.draftProblems(d);
    if (problems.length) return { ok: false, message: 'The draft is not ready: ' + problems.join(' ') };
    return { ok: true };
  }
  return { ok: false, message: 'Unknown kind of change.' };
}

// Resumes and launches first, then budgets, then pauses: a pause is judged
// against the ads that are live after the additions, which is how the
// rotation rule reads ("add the next creative when one is paused").
const ORDER = { resume_adset: 0, resume_ad: 1, launch_draft: 2, set_adset_daily_budget: 3, pause_ad: 4, pause_adset: 5 };
function orderChanges(list) {
  return (Array.isArray(list) ? list : []).slice().sort(function (a, b) {
    const d = (ORDER[a.action] || 0) - (ORDER[b.action] || 0);
    return d || ((a.priority || 2) - (b.priority || 2));
  });
}

// ── applying ───────────────────────────────────────────────────────────────
function clone(v) { return JSON.parse(JSON.stringify(v == null ? [] : v)); }

async function execute(change, live, drafts, o) {
  const c = change;
  const cfg = o.config;
  const call = { config: cfg, fetchImpl: o.fetchImpl };
  if (c.action === 'pause_ad' || c.action === 'resume_ad') {
    const ad = findAd(live, c.target_id);
    const want = c.action === 'pause_ad' ? 'PAUSED' : 'ACTIVE';
    const r = await metaAds.setEntityStatus(c.target_id, want, call);
    if (!r.ok) return { ok: false, message: metaAds.explainMetaError(r) };
    const before = ad.effective_status;
    ad.status = want;
    ad.effective_status = want === 'PAUSED' ? 'PAUSED' : (findAdset(live, ad.adset_id) && findAdset(live, ad.adset_id).effective_status !== 'ACTIVE' ? 'ADSET_PAUSED' : 'ACTIVE');
    return { ok: true, message: want === 'PAUSED' ? 'Paused.' : (ad.effective_status === 'ACTIVE' ? 'Live again.' : 'Resumed, but its ad set is paused so it is not delivering yet.'), before: before, after: ad.effective_status };
  }
  if (c.action === 'pause_adset' || c.action === 'resume_adset') {
    const set = findAdset(live, c.target_id);
    const want = c.action === 'pause_adset' ? 'PAUSED' : 'ACTIVE';
    const r = await metaAds.setEntityStatus(c.target_id, want, call);
    if (!r.ok) return { ok: false, message: metaAds.explainMetaError(r) };
    const before = set.effective_status;
    set.status = want; set.effective_status = want;
    ((live && live.ads) || []).forEach(function (a) {
      if (String(a.adset_id) !== String(set.id)) return;
      if (want === 'PAUSED') { if (a.effective_status === 'ACTIVE') a.effective_status = 'ADSET_PAUSED'; }
      else if (a.effective_status === 'ADSET_PAUSED') a.effective_status = a.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE';
    });
    return { ok: true, message: want === 'PAUSED' ? 'Ad set paused.' : 'Ad set live again.', before: before, after: want };
  }
  if (c.action === 'set_adset_daily_budget') {
    const set = findAdset(live, c.target_id);
    const r = await metaAds.setAdsetDailyBudget(c.target_id, c.daily_budget, call);
    if (!r.ok) return { ok: false, message: metaAds.explainMetaError(r) };
    const before = set.daily_budget;
    set.daily_budget = c.daily_budget;
    return { ok: true, message: 'Daily budget is now ' + money(c.daily_budget, cfg && cfg.currency) + ' (was ' + money(before, cfg && cfg.currency) + ').', before: before, after: c.daily_budget };
  }
  if (c.action === 'launch_draft') {
    if (typeof o.launch !== 'function') return { ok: false, message: 'No launcher is wired in.' };
    const r = await o.launch(c.target_id);
    if (!r || !r.ok) return { ok: false, held: !!(r && r.held), message: (r && (r.error || r.message)) || 'The launch failed.' };
    const d = findDraft({ drafts: drafts }, c.target_id) || {};
    live.ads.push({ id: String(r.meta_ad_id || ''), name: d.angle || '', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: String(d.adset_id || (cfg && cfg.adsetId) || '') });
    return { ok: true, message: 'Launched as ad ' + (r.meta_ad_id || '?') + '.', meta_ad_id: r.meta_ad_id || null, before: d.status || null, after: 'live' };
  }
  return { ok: false, message: 'Unknown kind of change.' };
}

// Applies `changes` in a safe order against `ads` / `adsets` as read from
// Meta just now. One result per change, in the order they were tried:
// { id, ok, skipped, message, before, after, meta_ad_id }. A failure never
// stops the others; the owner reads each line.
async function applyChanges(opts) {
  const o = opts || {};
  const cfg = o.config || metaAds.adsConfig(o.env);
  const live = { ads: clone(o.ads), adsets: clone(o.adsets) };
  const drafts = Array.isArray(o.drafts) ? o.drafts : [];
  const lim = limits(o.env);
  const results = [];
  const run = Object.assign({}, o, { config: cfg });
  for (const ch of orderChanges(o.changes)) {
    const check = checkChange(ch, live, drafts, lim);
    if (!check.ok) {
      results.push({ id: ch.id, ok: false, skipped: !!check.skip, message: check.message });
      continue;
    }
    let r;
    try { r = await execute(ch, live, drafts, run); }
    catch (err) { r = { ok: false, message: 'Unexpected error: ' + String((err && err.message) || err) }; }
    results.push({
      id: ch.id, ok: !!r.ok, skipped: false, held: !!r.held, message: r.message || (r.ok ? 'Done.' : 'Failed.'),
      before: r.before === undefined ? null : r.before, after: r.after === undefined ? null : r.after,
      meta_ad_id: r.meta_ad_id || null
    });
  }
  const counts = {
    applied: results.filter(function (r) { return r.ok; }).length,
    skipped: results.filter(function (r) { return r.skipped; }).length,
    failed: results.filter(function (r) { return !r.ok && !r.skipped; }).length
  };
  return { ok: counts.failed === 0, results: results, counts: counts, live: live };
}

// One line for the toast: "2 applied, 1 already done, 1 refused".
function summarise(counts) {
  const c = counts || {};
  const bits = [];
  if (c.applied) bits.push(c.applied + ' applied');
  if (c.skipped) bits.push(c.skipped + ' already done');
  if (c.failed) bits.push(c.failed + ' not applied');
  return bits.length ? bits.join(', ') + '.' : 'Nothing was changed.';
}

module.exports = {
  ACTIONS,
  ACTION_LABELS,
  CHANGE_SCHEMA,
  MAX_CHANGES,
  DEFAULT_MIN_LIVE_ADS,
  DEFAULT_MAX_DAILY_BUDGET,
  MAX_BUDGET_STEP,
  limits,
  money,
  normaliseChange,
  normaliseChanges,
  describeChange,
  describeChanges,
  checkChange,
  orderChanges,
  applyChanges,
  summarise
};
