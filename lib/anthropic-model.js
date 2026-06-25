'use strict';

/**
 * Single source of truth for the Claude model used across the SPPA-00 flow.
 *
 * Goals:
 *  1. Every SPPA AI call uses Opus 4.6 (`claude-opus-4-6`).
 *  2. If Anthropic ever retires 4.6, calls automatically fall through to the
 *     newest still-supported model — no code change or redeploy needed.
 *
 * How the auto-upgrade works:
 *  - We try the primary model first. If the API says the model id is unknown /
 *    retired / deprecated (HTTP 404, or a 400 whose error clearly names the
 *    model), we mark it dead for this process and retry on the next candidate,
 *    which is ordered NEWEST-first so we land on the latest supported model.
 *  - The first model that works is remembered (per process) so we don't keep
 *    probing a dead primary on every request.
 *
 * Forward-compatibility note: newer Opus models (4.7 / 4.8 / Fable 5) REJECT
 * the sampling params `temperature` / `top_p` / `top_k` (HTTP 400). So when we
 * fall through to one of those, we strip those fields automatically. Callers can
 * therefore keep passing `temperature: 0` for 4.6 without breaking the upgrade.
 */

var ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

// The model we WANT to use everywhere in the SPPA flow. An `ANTHROPIC_MODEL`
// env override (if set) wins, otherwise Opus 4.6.
var DEFAULT_PRIMARY_MODEL = 'claude-opus-4-6';
function primaryModel() { return process.env.ANTHROPIC_MODEL || DEFAULT_PRIMARY_MODEL; }

// Newest-first fallbacks. Used only if the primary becomes unsupported, so we
// land on the latest model that still works. Keep this list ordered newest →
// oldest. (Sonnet 4.6 is the final safety net — vision-capable and cheaper.)
var FALLBACK_MODELS = ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6'];

// Models that reject sampling params (temperature/top_p/top_k) and the legacy
// `thinking.budget_tokens`. We sanitize the request body before sending to one.
var STRICT_MODELS = new Set(['claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5', 'claude-mythos-5']);

// Per-process memory so we don't re-probe a dead model on every call.
var _resolvedModel = null;          // the model id that last worked
var _deadModels = new Set();        // model ids the API has rejected as unknown

/**
 * Ordered list of model ids to attempt, primary first, then newest fallbacks,
 * with anything already known-dead removed and any already-resolved model moved
 * to the front (so a retired primary isn't retried every request).
 */
function candidateModels() {
  var ordered = [primaryModel()].concat(FALLBACK_MODELS);
  if (_resolvedModel && ordered.indexOf(_resolvedModel) !== -1) {
    ordered = [_resolvedModel].concat(ordered.filter(function (m) { return m !== _resolvedModel; }));
  }
  var live = ordered.filter(function (m) { return !_deadModels.has(m); });
  // Never return an empty list — if everything got marked dead, reset and retry
  // from scratch (better to re-probe than to hard-fail forever).
  return live.length ? live : ordered;
}

/** Strip params a given model would reject, and pin the model id. */
function sanitizeBodyForModel(body, model) {
  var b = Object.assign({}, body);
  b.model = model;
  if (STRICT_MODELS.has(model)) {
    delete b.temperature;
    delete b.top_p;
    delete b.top_k;
    // Legacy fixed-budget thinking is rejected on these models too.
    if (b.thinking && b.thinking.type === 'enabled') delete b.thinking;
  }
  return b;
}

/**
 * Decide whether an API error means "this model id is no longer usable" (so we
 * should upgrade) versus a normal transient/other error (so we should NOT churn
 * through models).
 */
function isModelRetiredError(status, parsed, rawText) {
  if (status === 404) return true; // messages endpoint 404 == unknown/retired model id
  var type = parsed && parsed.error && parsed.error.type;
  if (type === 'not_found_error') return true;
  var msg = ((parsed && parsed.error && parsed.error.message) || rawText || '').toLowerCase();
  if (!msg) return false;
  return /model/.test(msg) &&
    /(not_found|not found|does not exist|deprecat|retir|no longer available|no longer supported|unsupported model|unknown model|invalid model)/.test(msg);
}

/**
 * Call the Anthropic Messages API with automatic model selection + upgrade.
 *
 * @param {Object} body  Full Messages API body (max_tokens, system, messages,
 *                        etc.). `model` is optional — it is set/overridden here.
 * @param {Object} [opts] { apiKey, timeoutMs }
 * @returns {Promise<{ok:boolean, status?:number, data?:object, model?:string,
 *                     error?:string, detail?:string}>}
 */
async function callAnthropicMessages(body, opts) {
  opts = opts || {};
  var apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: 'no_api_key' };
  var timeoutMs = opts.timeoutMs || 60000;

  var candidates = candidateModels();
  var lastErr = null;
  var lastDetail = null;

  for (var i = 0; i < candidates.length; i++) {
    var model = candidates[i];
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    try {
      var resp = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(sanitizeBodyForModel(body, model))
      });

      if (resp.ok) {
        var data = await resp.json();
        _resolvedModel = model; // remember the winner for next time
        return { ok: true, status: resp.status, data: data, model: model };
      }

      var rawText = '';
      try { rawText = await resp.text(); } catch (e) {}
      var parsed = null;
      try { parsed = JSON.parse(rawText); } catch (e) {}

      if (isModelRetiredError(resp.status, parsed, rawText)) {
        // Model id is dead — remember that and upgrade to the next candidate.
        _deadModels.add(model);
        if (_resolvedModel === model) _resolvedModel = null;
        lastErr = 'model_unsupported_' + model;
        lastDetail = rawText;
        console.error('[anthropic-model] ' + model + ' rejected as unsupported (' + resp.status + ') — upgrading to next model');
        continue; // try the next (newer) candidate
      }

      // A real, non-model error (rate limit, overload, bad request, etc.).
      // Don't churn through models — surface it.
      return { ok: false, status: resp.status, error: 'api_error_' + resp.status, detail: rawText, model: model };
    } catch (err) {
      // Network / abort — transient. Don't try every model; surface it.
      return { ok: false, error: 'fetch_error: ' + (err && err.message), model: model };
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, error: lastErr || 'all_models_unsupported', detail: lastDetail };
}

/** The model that will be tried first right now (primary, or a resolved upgrade). */
function activeModel() {
  return candidateModels()[0];
}

module.exports = {
  callAnthropicMessages,
  activeModel,
  primaryModel,
  DEFAULT_PRIMARY_MODEL,
  FALLBACK_MODELS,
  // exported for unit tests
  _internals: { sanitizeBodyForModel: sanitizeBodyForModel, isModelRetiredError: isModelRetiredError, candidateModels: candidateModels }
};
