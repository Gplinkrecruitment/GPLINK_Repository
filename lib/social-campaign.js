'use strict';

// Monthly social campaign: schedule maths, validation, and the Meta Graph calls.
//
// Everything here is pure except publishToFacebook / publishToInstagram, which
// are the only functions that touch the network. That split is deliberate: the
// scheduling rules are the part most likely to be wrong in a way nobody notices
// for a month, so they are unit-testable without a token.

const CAMPAIGN_STATUSES = ['draft', 'in_review', 'approved', 'publishing', 'complete', 'cancelled'];
const POST_STATUSES = ['draft', 'approved', 'rejected', 'posted', 'failed', 'skipped'];

// Meta's documented ceilings. We validate against them at ingest so a bad
// caption is caught while a human is still looking at it, not at 9am on a
// Tuesday inside a cron.
const FB_CAPTION_MAX = 63206;
const IG_CAPTION_MAX = 2200;
const IG_HASHTAG_MAX = 30;

// Instagram rejects anything outside 4:5 (0.8) and 1.91:1. Our creatives are
// 1080x1350, which is exactly 0.8, i.e. right on the lower bound.
const IG_MIN_ASPECT = 0.8;
const IG_MAX_ASPECT = 1.91;

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = 'https://graph.facebook.com/' + GRAPH_VERSION;

// How many times the publisher retries one post before parking it as 'failed'.
// Meta's transient errors clear in minutes, and the cron runs hourly, so three
// hourly attempts is a wide enough window without letting a genuinely broken
// creative retry all month.
const MAX_PUBLISH_ATTEMPTS = 3;


// ── month keys ─────────────────────────────────────────────────────────────
function monthKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return null;
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

function isMonthKey(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function nextMonthKey(key) {
  if (!isMonthKey(key)) return null;
  let [y, m] = key.split('-').map(Number);
  m += 1;
  if (m > 12) { m = 1; y += 1; }
  return y + '-' + String(m).padStart(2, '0');
}

function daysInMonth(key) {
  if (!isMonthKey(key)) return 0;
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}


// ── timezone ───────────────────────────────────────────────────────────────
// Turn a local wall-clock time in `timeZone` into the UTC instant it refers to,
// without pulling in a date library.
//
// The trick: format a guess back into the target zone, measure how far off it
// landed, and correct. Two passes settle it even across a DST boundary, because
// the first correction lands inside the new offset and the second confirms it.
function zonedWallTimeToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let ts = guess;
  for (let pass = 0; pass < 2; pass++) {
    const seen = wallClockPartsInZone(new Date(ts), timeZone);
    if (!seen) return new Date(guess);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, 0);
    const drift = seenAsUtc - guess;
    if (drift === 0) break;
    ts -= drift;
  }
  return new Date(ts);
}

function wallClockPartsInZone(date, timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
    const out = {};
    fmt.formatToParts(date).forEach(function (p) {
      if (p.type === 'year') out.year = Number(p.value);
      else if (p.type === 'month') out.month = Number(p.value);
      else if (p.type === 'day') out.day = Number(p.value);
      else if (p.type === 'hour') out.hour = Number(p.value) % 24;
      else if (p.type === 'minute') out.minute = Number(p.value);
    });
    return Number.isFinite(out.year) ? out : null;
  } catch (err) {
    return null;
  }
}

function parseSlotTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}


// ── the schedule ───────────────────────────────────────────────────────────
// Stamp publish_at across a month: `perDay` posts each day, at `slotTimes`,
// starting on day 1 (or today, if the month is already under way).
//
// Posts are consumed in the order given, so the caller controls which creative
// lands on which day simply by ordering them.
function buildSchedule(options) {
  const opts = options || {};
  const key = opts.monthKey;
  if (!isMonthKey(key)) return { ok: false, error: 'invalid_month', slots: [] };

  const times = (Array.isArray(opts.slotTimes) && opts.slotTimes.length
    ? opts.slotTimes
    : ['09:00', '15:00']).map(parseSlotTime).filter(Boolean);
  if (!times.length) return { ok: false, error: 'invalid_slot_times', slots: [] };

  const perDay = Math.max(1, Math.min(times.length, Number(opts.perDay) || times.length));
  const timeZone = opts.timeZone || 'Australia/Melbourne';
  const count = Math.max(0, Number(opts.count) || 0);
  const [year, month] = key.split('-').map(Number);
  const total = daysInMonth(key);

  // Never schedule into the past. If approval happens mid-month, the run starts
  // at the next slot that has not already passed rather than dumping a backlog
  // of "due" posts that the publisher would fire all at once.
  const notBefore = opts.notBefore ? new Date(opts.notBefore).getTime() : Date.now();

  const slots = [];
  for (let day = 1; day <= total && slots.length < count; day++) {
    for (let s = 0; s < perDay && slots.length < count; s++) {
      const t = times[s];
      const at = zonedWallTimeToUtc(year, month, day, t.hour, t.minute, timeZone);
      if (at.getTime() <= notBefore) continue;
      slots.push(at.toISOString());
    }
  }
  return { ok: true, slots, capacity: total * perDay, requested: count };
}

// Pair ordered posts with the schedule. Posts beyond the month's capacity get a
// null publish_at and are reported, never silently dropped.
function assignSchedule(posts, options) {
  const list = Array.isArray(posts) ? posts.slice() : [];
  const built = buildSchedule(Object.assign({}, options, { count: list.length }));
  if (!built.ok) return { ok: false, error: built.error, assigned: [], unscheduled: list.length };
  const assigned = [];
  let unscheduled = 0;
  list.forEach(function (post, i) {
    if (i < built.slots.length) assigned.push(Object.assign({}, post, { publish_at: built.slots[i] }));
    else { assigned.push(Object.assign({}, post, { publish_at: null })); unscheduled++; }
  });
  return { ok: true, assigned, unscheduled, capacity: built.capacity };
}


// ── validation ─────────────────────────────────────────────────────────────
function countHashtags(caption) {
  const m = String(caption || '').match(/(^|\s)#[\wÀ-ɏ]+/g);
  return m ? m.length : 0;
}

// Returns { ok, errors[], warnings[] }. Errors block publishing; warnings are
// shown to the CEO in the review UI but do not stop anything.
function validatePost(post, targets) {
  const errors = [];
  const warnings = [];
  const p = post || {};
  const want = targets || p.targets || { facebook: true, instagram: true };
  const caption = String(p.caption || '');

  if (!caption.trim()) errors.push('Caption is empty.');
  if (!p.image_path && !p.image_url) errors.push('No image.');

  if (want.facebook && caption.length > FB_CAPTION_MAX) {
    errors.push('Caption is too long for Facebook (' + caption.length + ' of ' + FB_CAPTION_MAX + ').');
  }
  if (want.instagram) {
    if (caption.length > IG_CAPTION_MAX) {
      errors.push('Caption is too long for Instagram (' + caption.length + ' of ' + IG_CAPTION_MAX + ').');
    }
    const tags = countHashtags(caption);
    if (tags > IG_HASHTAG_MAX) {
      errors.push('Instagram allows ' + IG_HASHTAG_MAX + ' hashtags; this has ' + tags + '.');
    }
    const w = Number(p.image_width) || 0;
    const h = Number(p.image_height) || 0;
    if (w && h) {
      const ratio = w / h;
      // Rounded before comparing: 1080/1350 is 0.8 exactly in decimal but binary
      // floating point lands a hair under, which would reject our own house size.
      if (Math.round(ratio * 1000) / 1000 < IG_MIN_ASPECT || ratio > IG_MAX_ASPECT) {
        errors.push('Instagram needs an aspect ratio between 4:5 and 1.91:1; this is ' + w + 'x' + h + '.');
      }
    }
  }

  if (/\[[^\]]+\]/.test(caption)) {
    warnings.push('Caption still contains a [placeholder].');
  }
  if (caption.indexOf('—') !== -1) {
    warnings.push('Caption contains an em dash, which the brand voice rules exclude.');
  }

  return { ok: errors.length === 0, errors, warnings };
}

// A campaign can only be approved once every post is either approved or
// rejected, and every approved post passes validation. Half-reviewed months
// are the thing most likely to put a placeholder on the page.
function canApproveCampaign(campaign, posts) {
  const list = Array.isArray(posts) ? posts : [];
  const live = list.filter(function (p) { return p.status !== 'rejected'; });
  if (!live.length) return { ok: false, reason: 'Nothing to approve: every post is rejected.' };
  const undecided = list.filter(function (p) { return p.status === 'draft'; });
  if (undecided.length) {
    return { ok: false, reason: undecided.length + ' post(s) still need a decision.' };
  }
  const bad = [];
  live.forEach(function (p) {
    const v = validatePost(p, (campaign && campaign.targets) || null);
    if (!v.ok) bad.push({ slot: p.slot, errors: v.errors });
  });
  if (bad.length) return { ok: false, reason: bad.length + ' approved post(s) fail validation.', failures: bad };
  return { ok: true, count: live.length };
}

function summariseCampaign(campaign, posts) {
  const list = Array.isArray(posts) ? posts : [];
  const by = {};
  POST_STATUSES.forEach(function (s) { by[s] = 0; });
  list.forEach(function (p) {
    const s = POST_STATUSES.indexOf(p.status) === -1 ? 'draft' : p.status;
    by[s]++;
  });
  const warnings = list.reduce(function (n, p) {
    return n + validatePost(p, campaign && campaign.targets).warnings.length;
  }, 0);
  return {
    month: campaign ? campaign.month : null,
    status: campaign ? campaign.status : null,
    total: list.length,
    by_status: by,
    needs_review: by.draft,
    warnings,
    // The dot on the CEO tab. Anything waiting on a human turns it on.
    needs_ceo: !!campaign && (campaign.status === 'in_review' || by.draft > 0)
  };
}

// What the publisher should pick up right now.
function selectDuePosts(posts, nowIso, limit) {
  const now = new Date(nowIso || Date.now()).getTime();
  const cap = Math.max(1, Number(limit) || 4);
  return (Array.isArray(posts) ? posts : [])
    .filter(function (p) {
      if (p.status !== 'approved') return false;
      if (!p.publish_at) return false;
      if ((Number(p.attempts) || 0) >= MAX_PUBLISH_ATTEMPTS) return false;
      return new Date(p.publish_at).getTime() <= now;
    })
    .sort(function (a, b) { return new Date(a.publish_at) - new Date(b.publish_at); })
    .slice(0, cap);
}


// ── Meta Graph ─────────────────────────────────────────────────────────────
function graphConfig(env) {
  const e = env || process.env;
  return {
    pageId: String(e.FB_PAGE_ID || '').trim(),
    pageToken: String(e.FB_PAGE_ACCESS_TOKEN || '').trim(),
    igUserId: String(e.IG_USER_ID || '').trim(),
    disabled: String(e.SOCIAL_PUBLISH_DISABLED || '').trim() === 'true'
  };
}

function graphConfigProblems(cfg, targets) {
  const want = targets || { facebook: true, instagram: true };
  const out = [];
  if (!cfg.pageToken) out.push('FB_PAGE_ACCESS_TOKEN is not set.');
  if (want.facebook && !cfg.pageId) out.push('FB_PAGE_ID is not set.');
  if (want.instagram && !cfg.igUserId) out.push('IG_USER_ID is not set.');
  return out;
}

// Which networks are actually publishable with the current configuration.
//
// This is what a new campaign targets, rather than assuming both. Instagram
// needs a Business account, a Page link and a use case that Facebook alone does
// not, so the two are routinely ready at different times. Defaulting to both
// would mean every post on a Facebook-only setup burned an Instagram failure
// against its retry budget and eventually parked as 'failed', despite having
// published perfectly well to the Page.
function configuredTargets(cfg) {
  const c = cfg || graphConfig();
  return {
    facebook: !!(c.pageToken && c.pageId),
    instagram: !!(c.pageToken && c.igUserId)
  };
}

// True when nothing at all can publish. The dashboard says so plainly instead of
// letting the owner approve a month into a void.
function nothingConfigured(cfg) {
  const t = configuredTargets(cfg);
  return !t.facebook && !t.instagram;
}

async function graphPost(path, params, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  const body = new URLSearchParams();
  Object.keys(params || {}).forEach(function (k) {
    if (params[k] !== undefined && params[k] !== null) body.append(k, String(params[k]));
  });
  const r = await doFetch(GRAPH_BASE + path, { method: 'POST', body });
  let data = null;
  try { data = await r.json(); } catch (err) { data = null; }
  if (!r.ok || (data && data.error)) {
    const msg = (data && data.error && data.error.message) || ('HTTP ' + r.status);
    return { ok: false, status: r.status, error: msg, data };
  }
  return { ok: true, status: r.status, data: data || {} };
}

// Facebook: one call. Graph fetches the image itself, so imageUrl must be
// publicly reachable with no auth — that is what /api/public/social-image is for.
async function publishToFacebook(opts) {
  const cfg = opts.config || graphConfig();
  const r = await graphPost('/' + encodeURIComponent(cfg.pageId) + '/photos', {
    url: opts.imageUrl,
    caption: opts.caption,
    published: 'true',
    access_token: cfg.pageToken
  }, opts.fetchImpl);
  if (!r.ok) return r;
  return { ok: true, postId: String((r.data && (r.data.post_id || r.data.id)) || '') };
}

// Instagram: three steps. Create a container, wait for Meta to finish pulling
// the image, then publish it. Skipping the wait is the classic failure — the
// container is not ready immediately and media_publish returns a confusing
// error rather than a retryable one.
async function publishToInstagram(opts) {
  const cfg = opts.config || graphConfig();
  const created = await graphPost('/' + encodeURIComponent(cfg.igUserId) + '/media', {
    image_url: opts.imageUrl,
    caption: opts.caption,
    access_token: cfg.pageToken
  }, opts.fetchImpl);
  if (!created.ok) return created;

  const creationId = String((created.data && created.data.id) || '');
  if (!creationId) return { ok: false, error: 'Instagram did not return a creation id.' };

  const ready = await waitForIgContainer(creationId, cfg, opts);
  if (!ready.ok) return ready;

  const published = await graphPost('/' + encodeURIComponent(cfg.igUserId) + '/media_publish', {
    creation_id: creationId,
    access_token: cfg.pageToken
  }, opts.fetchImpl);
  if (!published.ok) return published;
  return { ok: true, mediaId: String((published.data && published.data.id) || ''), creationId };
}

async function waitForIgContainer(creationId, cfg, opts) {
  const doFetch = (opts && opts.fetchImpl) || globalThis.fetch;
  const sleep = (opts && opts.sleep) || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const maxChecks = (opts && Number(opts.maxChecks)) || 8;
  for (let i = 0; i < maxChecks; i++) {
    const url = GRAPH_BASE + '/' + encodeURIComponent(creationId) +
      '?fields=status_code,status&access_token=' + encodeURIComponent(cfg.pageToken);
    const r = await doFetch(url);
    let data = null;
    try { data = await r.json(); } catch (err) { data = null; }
    const code = data && data.status_code;
    if (code === 'FINISHED') return { ok: true };
    if (code === 'ERROR' || code === 'EXPIRED') {
      return { ok: false, error: 'Instagram could not process the image (' + code + '): ' + ((data && data.status) || '') };
    }
    await sleep(2000);
  }
  return { ok: false, error: 'Instagram container was not ready in time.', retryable: true };
}

// Publish one post to whichever networks it still owes, and report per-network.
// A network that already succeeded is never re-posted, so a retry after a
// partial failure cannot double-post to Facebook.
async function publishPost(post, opts) {
  const options = opts || {};
  const cfg = options.config || graphConfig();
  const targets = post.targets || { facebook: true, instagram: true };
  const result = { facebook: null, instagram: null, ok: true, errors: [] };

  if (cfg.disabled) {
    return { ok: false, disabled: true, errors: ['SOCIAL_PUBLISH_DISABLED is true.'], facebook: null, instagram: null };
  }

  if (targets.facebook && !post.facebook_post_id) {
    const fb = await publishToFacebook({
      config: cfg, imageUrl: options.imageUrl, caption: post.caption, fetchImpl: options.fetchImpl
    });
    if (fb.ok) result.facebook = { postId: fb.postId };
    else { result.ok = false; result.errors.push('Facebook: ' + fb.error); result.facebook = { error: fb.error }; }
  }

  if (targets.instagram && !post.instagram_media_id) {
    const ig = await publishToInstagram({
      config: cfg, imageUrl: options.imageUrl, caption: post.caption,
      fetchImpl: options.fetchImpl, sleep: options.sleep, maxChecks: options.maxChecks
    });
    if (ig.ok) result.instagram = { mediaId: ig.mediaId };
    else { result.ok = false; result.errors.push('Instagram: ' + ig.error); result.instagram = { error: ig.error }; }
  }

  return result;
}


module.exports = {
  CAMPAIGN_STATUSES,
  POST_STATUSES,
  FB_CAPTION_MAX,
  IG_CAPTION_MAX,
  IG_HASHTAG_MAX,
  MAX_PUBLISH_ATTEMPTS,
  GRAPH_VERSION,
  monthKey,
  isMonthKey,
  nextMonthKey,
  daysInMonth,
  zonedWallTimeToUtc,
  wallClockPartsInZone,
  parseSlotTime,
  buildSchedule,
  assignSchedule,
  countHashtags,
  validatePost,
  canApproveCampaign,
  summariseCampaign,
  selectDuePosts,
  graphConfig,
  graphConfigProblems,
  configuredTargets,
  nothingConfigured,
  publishToFacebook,
  publishToInstagram,
  publishPost
};
