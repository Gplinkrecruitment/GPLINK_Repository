'use strict';

// lib/higgsfield.js — photographs for new ads, generated server-side through
// the Higgsfield Cloud API (api.higgsfield.ai) from the draft's photo brief.
//
// Shape of the API (docs.higgsfield.ai, read 2026-10-29): POST a model path
// with a JSON body and `Authorization: Key <KEY_ID>:<KEY_SECRET>`; the answer
// is { status: 'queued', request_id, status_url, cancel_url }; GET status_url
// until status is terminal (completed | failed | nsfw | canceled); a completed
// image job carries images[].url, and those URLs expire (7 days by default),
// so the bytes are copied into our own storage straight away.
//
// Measured live on 2026-11-04 with the real key, because the docs disagree
// with each other: /higgsfield-ai/soul/v2/standard accepts anything and
// IGNORES aspect_ratio (returned 1536x1152, 4:3); /higgsfield-ai/soul/standard
// validates (HTTP 422) and honours aspect_ratio from the set 9:16, 16:9, 4:3,
// 3:4, 1:1, 2:3, 3:2 with resolution 720p | 1080p. 4:5 is not offered, so a
// 4:5 creative asks for 3:4 (the closest portrait frame; the composer crops
// the rest). The validated path goes first; the v2 path is the fallback on a
// 404, and a 4xx that names a field retries with the bare prompt.

const API_BASE = 'https://api.higgsfield.ai';
const DEFAULT_PATHS = ['/higgsfield-ai/soul/standard', '/higgsfield-ai/soul/v2/standard'];
const ASPECTS = ['9:16', '16:9', '4:3', '3:4', '1:1', '2:3', '3:2'];
// What the composer wants → what the API offers.
function nearestAspect(wanted) {
  const w = String(wanted || '').trim();
  if (ASPECTS.indexOf(w) !== -1) return w;
  const m = /^(\d+):(\d+)$/.exec(w);
  const target = m ? Number(m[1]) / Number(m[2]) : 0.75;
  let best = '3:4', bestDiff = Infinity;
  ASPECTS.forEach(function (a) {
    const p = a.split(':');
    const diff = Math.abs(Number(p[0]) / Number(p[1]) - target);
    if (diff < bestDiff) { bestDiff = diff; best = a; }
  });
  return best;
}
const TERMINAL = ['completed', 'failed', 'nsfw', 'canceled'];

function higgsfieldConfig(env) {
  const e = env || process.env;
  const combined = String(e.HIGGSFIELD_API_KEY || '').trim();
  let id = String(e.HIGGSFIELD_API_KEY_ID || '').trim();
  let secret = String(e.HIGGSFIELD_API_KEY_SECRET || '').trim();
  if (!id && !secret && combined.indexOf(':') !== -1) {
    id = combined.slice(0, combined.indexOf(':')).trim();
    secret = combined.slice(combined.indexOf(':') + 1).trim();
  }
  const customPath = String(e.HIGGSFIELD_IMAGE_PATH || '').trim();
  return {
    keyId: id,
    keySecret: secret,
    configured: !!(id && secret),
    apiBase: (String(e.HIGGSFIELD_API_BASE || '').trim() || API_BASE).replace(/\/+$/, ''),
    paths: customPath ? [customPath].concat(DEFAULT_PATHS.filter(function (p) { return p !== customPath; })) : DEFAULT_PATHS.slice(),
    resolution: String(e.HIGGSFIELD_RESOLUTION || '1080p').trim() || '1080p'
  };
}

function configProblems(cfg) {
  const c = cfg || higgsfieldConfig();
  if (c.configured) return [];
  return ['HIGGSFIELD_API_KEY is not set (format KEY_ID:KEY_SECRET from console.higgsfield.ai → API keys).'];
}

function authHeader(cfg) { return 'Key ' + cfg.keyId + ':' + cfg.keySecret; }

// The brief the model wrote, plus the house constraints so a generator cannot
// drift into text, logos or a face to camera.
// The brief's own words first, minus any aspect-ratio note ("4:5", "3:4",
// "portrait 4:5"): the model read that as a print to draw and returned a
// landscape photograph sitting on a 3:4 white canvas, 19% padding top and
// bottom (2026-11-04). The frame is set by aspect_ratio on the request.
const ASPECT_NOTE_RE = /\(?\b(?:in |at |format |ratio |aspect )?(?:4:5|5:4|3:4|4:3|1:1|9:16|16:9|2:3|3:2)\b\)?(?:\s*\b(?:aspect|ratio|format|portrait|vertical|crop|frame)\b)*/gi;
function stripAspectNotes(text) {
  return String(text || '')
    .replace(ASPECT_NOTE_RE, '')
    .replace(/,\s*,/g, ',').replace(/,\s*\./g, '.').replace(/\.\s*\./g, '.')
    .replace(/\s+([,.;])/g, '$1').replace(/\s{2,}/g, ' ').trim().replace(/[,;]\s*$/, '');
}
function photoPrompt(brief) {
  const b = stripAspectNotes(brief);
  return (b ? b + ' ' : '') +
    'Documentary photograph, natural light, realistic. No text, no signs, no lettering of any kind, no logos, no watermark, no borders or frames, ' +
    'no one looking at the camera, muted editorial colour, suitable as the background for a headline. Vertical portrait, full bleed: ' +
    'the photograph fills the whole frame edge to edge, with no margin, mat or white space around it.';
}

async function request(method, url, body, cfg, opts) {
  const o = opts || {};
  const doFetch = o.fetchImpl || globalThis.fetch;
  const headers = { Authorization: authHeader(cfg), Accept: 'application/json' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = o.idempotencyKey || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(function () { controller.abort(); }, o.timeoutMs || 30000) : null;
  let r;
  try {
    r = await doFetch(url, { method: method, headers: headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: controller ? controller.signal : undefined });
  } catch (err) {
    if (timer) clearTimeout(timer);
    return { ok: false, status: 0, error: 'Could not reach Higgsfield: ' + String((err && err.message) || err), network: true };
  }
  if (timer) clearTimeout(timer);
  let data = null;
  try { data = await r.json(); } catch (err) { data = null; }
  if (!r.ok) {
    const msg = (data && (data.detail || data.error || data.message)) || ('HTTP ' + r.status);
    return { ok: false, status: r.status, error: typeof msg === 'string' ? msg : JSON.stringify(msg), data: data };
  }
  return { ok: true, status: r.status, data: data || {} };
}

// Submit one image job. Tries the known paths in order on 404; on a 400 that
// names an optional field, retries with the bare prompt.
async function submitImage(opts) {
  const o = opts || {};
  const cfg = o.config || higgsfieldConfig();
  if (!cfg.configured) return { ok: false, error: configProblems(cfg)[0] };
  const full = { prompt: photoPrompt(o.prompt), aspect_ratio: nearestAspect(o.aspectRatio || '4:5'), resolution: cfg.resolution, num_images: 1 };
  const bare = { prompt: full.prompt };
  let last = null;
  for (let i = 0; i < cfg.paths.length; i++) {
    const url = cfg.apiBase + cfg.paths[i];
    let r = await request('POST', url, full, cfg, o);
    if (!r.ok && (r.status === 400 || r.status === 422) && /aspect_ratio|resolution|num_images|unknown|extra|not permitted|unexpected|literal_error/i.test(String(r.error))) {
      r = await request('POST', url, bare, cfg, o);
    }
    if (r.ok) {
      const d = r.data || {};
      if (!d.status_url && !d.request_id) return { ok: false, error: 'Higgsfield accepted the job but returned no request id.', data: d };
      return { ok: true, requestId: String(d.request_id || ''), statusUrl: String(d.status_url || (cfg.apiBase + '/requests/' + d.request_id + '/status')), path: cfg.paths[i], status: d.status || 'queued' };
    }
    last = r;
    if (r.status !== 404) break;
  }
  return { ok: false, error: (last && last.error) || 'Unknown error', status: last && last.status, auth: !!(last && (last.status === 401 || last.status === 403)) };
}

// opts.once: one status check, then return (timeout:true while still running).
// That is what the page's poller and the cron backstop use; the blocking wait
// is for generatePhoto().
async function pollRequest(statusUrl, opts) {
  const o = opts || {};
  const cfg = o.config || higgsfieldConfig();
  const sleep = o.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const intervalMs = o.intervalMs || 2500;
  const maxWaitMs = Number.isFinite(o.maxWaitMs) ? o.maxWaitMs : 150000;
  const started = Date.now();
  let lastStatus = 'queued';
  for (;;) {
    const r = await request('GET', statusUrl, undefined, cfg, o);
    if (!r.ok) return { ok: false, error: 'Status check failed: ' + r.error, status: lastStatus };
    const d = r.data || {};
    lastStatus = String(d.status || '');
    if (lastStatus === 'completed') {
      const url = Array.isArray(d.images) && d.images[0] && d.images[0].url ? String(d.images[0].url) : '';
      if (!url) return { ok: false, error: 'Higgsfield finished but returned no image URL.', status: lastStatus, data: d };
      return { ok: true, status: lastStatus, imageUrl: url, expiresAt: d.expires_at || null };
    }
    if (TERMINAL.indexOf(lastStatus) !== -1) {
      const why = lastStatus === 'nsfw' ? 'content moderation rejected the prompt or the result' : (d.error || lastStatus);
      return { ok: false, error: 'Higgsfield did not produce an image (' + why + ').', status: lastStatus };
    }
    if (o.once) return { ok: false, error: 'Still ' + (lastStatus || 'queued') + '.', status: lastStatus, timeout: true };
    if (Date.now() - started >= maxWaitMs) return { ok: false, error: 'Higgsfield is still working after ' + Math.round(maxWaitMs / 1000) + 's; try again in a minute.', status: lastStatus, timeout: true };
    await sleep(intervalMs);
  }
}

// Submit, wait, download. Returns the bytes so the caller can store them on
// our side before the result URL expires.
async function generatePhoto(opts) {
  const o = opts || {};
  const cfg = o.config || higgsfieldConfig();
  const sub = await submitImage(Object.assign({}, o, { config: cfg }));
  if (!sub.ok) return sub;
  const done = await pollRequest(sub.statusUrl, Object.assign({}, o, { config: cfg }));
  if (!done.ok) return Object.assign({ requestId: sub.requestId }, done);
  const doFetch = o.fetchImpl || globalThis.fetch;
  let img;
  try { img = await doFetch(done.imageUrl); } catch (err) { return { ok: false, error: 'Could not download the generated image: ' + String((err && err.message) || err), requestId: sub.requestId }; }
  if (!img || !img.ok) return { ok: false, error: 'Could not download the generated image (HTTP ' + (img && img.status) + ').', requestId: sub.requestId };
  const buffer = Buffer.from(await img.arrayBuffer());
  const contentType = String((img.headers && img.headers.get && img.headers.get('content-type')) || 'image/jpeg');
  return { ok: true, requestId: sub.requestId, imageUrl: done.imageUrl, expiresAt: done.expiresAt, buffer: buffer, contentType: contentType, path: sub.path };
}

module.exports = { API_BASE, DEFAULT_PATHS, ASPECTS, TERMINAL, nearestAspect, higgsfieldConfig, configProblems, photoPrompt, stripAspectNotes, submitImage, pollRequest, generatePhoto };
