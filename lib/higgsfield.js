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
// Two things the docs disagree on, handled here rather than guessed: the
// quickstart posts to /higgsfield-ai/soul/v2/standard while the OpenAPI spec
// lists /higgsfield-ai/soul/standard (prompt, num_images 1-4, resolution
// 2K|4K, aspect_ratio incl. 4:5). The client tries the configured path, then
// the other on a 404, and drops the optional fields if a 400 names one.

const API_BASE = 'https://api.higgsfield.ai';
const DEFAULT_PATHS = ['/higgsfield-ai/soul/v2/standard', '/higgsfield-ai/soul/standard'];
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
    resolution: String(e.HIGGSFIELD_RESOLUTION || '2K').trim() || '2K'
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
function photoPrompt(brief) {
  const b = String(brief || '').trim();
  return (b ? b + ' ' : '') +
    'Documentary photograph, natural light, realistic, no text, no lettering, no logos, no watermark, ' +
    'no one looking at the camera, muted editorial colour, suitable as the background for a headline. Vertical 4:5.';
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
  const full = { prompt: photoPrompt(o.prompt), aspect_ratio: o.aspectRatio || '4:5', resolution: cfg.resolution, num_images: 1 };
  const bare = { prompt: full.prompt };
  let last = null;
  for (let i = 0; i < cfg.paths.length; i++) {
    const url = cfg.apiBase + cfg.paths[i];
    let r = await request('POST', url, full, cfg, o);
    if (!r.ok && r.status === 400 && /aspect_ratio|resolution|num_images|unknown|extra|not permitted|unexpected/i.test(String(r.error))) {
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

async function pollRequest(statusUrl, opts) {
  const o = opts || {};
  const cfg = o.config || higgsfieldConfig();
  const sleep = o.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const intervalMs = o.intervalMs || 2500;
  const maxWaitMs = o.maxWaitMs || 150000;
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
    if (Date.now() - started > maxWaitMs) return { ok: false, error: 'Higgsfield is still working after ' + Math.round(maxWaitMs / 1000) + 's; try again in a minute.', status: lastStatus, timeout: true };
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

module.exports = { API_BASE, DEFAULT_PATHS, TERMINAL, higgsfieldConfig, configProblems, photoPrompt, submitImage, pollRequest, generatePhoto };
