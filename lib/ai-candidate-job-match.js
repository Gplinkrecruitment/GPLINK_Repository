// lib/ai-candidate-job-match.js
//
// AI Matching (Task 2 of docs/superpowers/plans/2026-07-06-ai-matching-implementation.md).
// Two responsibilities, kept in one small dependency-free module so both are
// easy to unit test in isolation:
//
//   1. `checkMatchEligibility(gp, job)` — a PURE, synchronous eligibility gate.
//      The server assembles plain `gp`/`job` objects (see JSDoc below) from
//      Supabase; this function has no I/O and never calls the network.
//   2. `aiRankCandidatesForJob` / `aiRankJobsForGp` — call the Anthropic
//      Messages API to score + explain a shortlist of the other side, batched
//      to respect a per-call candidate cap. `parseMatchRanking` is the
//      fence-stripping JSON parser shared by both directions (same shape as
//      `parseAIMatchResponse` in lib/ai-matching.js, the template for this file).
//
// HARD RULE (spec §3, Global Constraints): a match reason shown to a GP must
// NEVER mention money, salary, income, billing percentages or commission —
// only place/fit/visa/family reasons. The system prompt instructs this, and
// `parseMatchRanking` ALSO strips any reason that slips through as a second,
// defense-in-depth layer (never trust the model alone for a compliance rule).
'use strict';

var AI_MATCH_SYSTEM_PROMPT = [
  'You are a recruitment-matching assistant for GP Link, a medical recruitment company that places GPs (General Practitioners) into Australian medical practices.',
  'You will be given ONE side of a potential match (either a single job/role, or a single GP) and a list of candidates on the OTHER side.',
  'For EVERY candidate in the list, decide how strong the match is and explain why in short, plain, personal, everyday English a GP would understand — not corporate jargon.',
  'Compare using: preferred location/city, family circumstances (who is moving with them, children), qualifications and country of training, career background/handover summary, and the job/role\'s location, practice type, employment type, and any visa or regional-priority alignment.',
  'HARD RULES — never break these:',
  '- NEVER mention money, salary, income, billing, billing percentages, commission, bulk-billing, or any dollar figures — not even indirectly. Reasons are about place, fit, visa pathway, and family/lifestyle only.',
  '- NEVER invent facts that are not present in the data you were given.',
  '- Reasons must be personal and specific to THIS pair, not generic filler.',
  '- Each candidate needs 3 to 5 short reasons, each one plain-English sentence.',
  '- Score is 0-100 for how strong the overall match is.',
  'Return ONLY strict JSON — no markdown code fences, no commentary before or after:',
  '{"ranked":[{"id":"<the id you were given for this candidate>","score":0-100,"reasons":["reason 1","reason 2","reason 3"]}]}',
  'Every id from the candidate list you were given must appear exactly once in "ranked".'
].join('\n');

// Defense-in-depth filter: strip any reason that slipped past the system
// prompt's money/billing ban before it can ever reach a GP-facing surface.
var MONEY_PATTERN = /\$|%|\bpercent(age)?\b|\bcommission\b|\bsalary|\bsalaried\b|\bincome\b|\bbilling\b|\bbulk[- ]?bill\w*\b|\bearn(ing|ings)?\b|\bpay\b|\bwage\b/i;

function _chunk(list, size) {
  var out = [];
  var n = Math.max(1, size | 0);
  for (var i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * Pure eligibility gate — no I/O, no network. The server assembles `gp` and
 * `job` from Supabase and calls this synchronously per (gp, job) pair.
 *
 * @param {object} gp
 * @param {boolean} gp.onboardingComplete - mirrors `/api/career/apply`'s
 *   `userState.gp_onboarding_complete` gate.
 * @param {boolean} gp.hasCv - mirrors `/api/career/apply`'s
 *   `user_documents` (document_key='cv_signed_dated', status='uploaded') gate.
 * @param {boolean} gp.placed - true if the GP has a secured placement, from
 *   EITHER `user_state.state.gp_career_state.career_secured`/`.secured`, OR
 *   any `gp_applications` row whose status/stage means "placed"
 *   (`isCareerPlacementSecuredStatus` / `ats_stage === 'hired'`).
 * @param {Array<string|number>} gp.liveApplicationRoleIds - `career_role_id`
 *   values of this GP's applications currently in a non-terminal ATS stage
 *   (any of `ATS_STAGES` — i.e. NOT `not_proceeding`).
 * @param {boolean} gp.atInterviewStage - true if ANY of the GP's applications
 *   (on any job) is at ats_stage `interview`, OR has a `career_interviews`
 *   row with status `scheduled`/`confirmed`.
 * @param {boolean} gp.careerLocked - true when `user_state.state.career_lock`
 *   has a `locked_at` that has not been superseded by a later `released_at`
 *   (3-strike career lock, spec §10 — enforced fully in a later task).
 * @param {string} gp.accountStatus - raw `account_status` value. Split into
 *   two distinct block reasons (this module's own choice, since the two
 *   strings are both part of the caller-facing contract): `under_review` /
 *   `pep_waitlist` → 'account_gated' (an explicit holding state with its own
 *   release flow); anything else that isn't `active` → 'account_not_active'.
 * @param {boolean} gp.dpaEligible - mirrors `_resolveGpJobsProfile(...).australiaTrained`
 *   in server.js (the SAME input the `/api/career/roles` board-blur / `/api/career/apply`
 *   DPA gate uses) — true only when the GP's registration/training country is
 *   Australia. Fails closed (false/undefined) when unknown, exactly like that
 *   helper's own documented default.
 *
 * @param {object} job
 * @param {string|number} job.id - `career_roles.id`.
 * @param {boolean|null} job.dpa - `career_roles.dpa` ("District of Priority
 *   Area"). `dpa === true` means the role sits in a priority area and is open
 *   to every GP regardless of training country; anything else means the role
 *   is DPA-restricted and only an Australia-trained GP (`dpaEligible`) may be
 *   matched to it — this mirrors `practicePipeline.gpQualifiesForRole` exactly.
 *
 * @returns {{eligible: boolean, blocks: string[]}} `blocks` lists EVERY
 *   applicable reason (not just the first), so a caller can show more than
 *   one at once; `eligible` is `blocks.length === 0`.
 */
function checkMatchEligibility(gp, job) {
  var g = gp || {};
  var j = job || {};
  var blocks = [];

  if (!g.onboardingComplete) blocks.push('onboarding_incomplete');
  if (!g.hasCv) blocks.push('no_cv');
  if (g.placed === true) blocks.push('placed');

  var liveIds = Array.isArray(g.liveApplicationRoleIds) ? g.liveApplicationRoleIds.map(String) : [];
  if (j.id != null && liveIds.indexOf(String(j.id)) !== -1) blocks.push('existing_application');

  if (g.atInterviewStage === true) blocks.push('at_interview_stage');
  if (g.careerLocked === true) blocks.push('career_locked');

  var acct = String(g.accountStatus == null ? '' : g.accountStatus).trim().toLowerCase();
  if (acct === 'under_review' || acct === 'pep_waitlist') {
    blocks.push('account_gated');
  } else if (acct !== 'active') {
    blocks.push('account_not_active');
  }

  if (j.dpa !== true && g.dpaEligible !== true) blocks.push('dpa_ineligible');

  return { eligible: blocks.length === 0, blocks: blocks };
}

/**
 * Fence-stripping, defensive JSON parser for the model's ranking reply.
 * Returns `{ ranked: [{ id, score, reasons }] }` or `null` if the reply isn't
 * usable at all (no JSON object found, or `ranked` isn't an array).
 *
 * - `score` is coerced to a number clamped to 0-100, or `null` if not finite.
 * - `reasons` is filtered to non-empty strings, with any reason matching
 *   `MONEY_PATTERN` dropped (defense-in-depth — see file header).
 * - Entries missing an `id` are dropped rather than failing the whole parse.
 */
function parseMatchRanking(raw) {
  try {
    var cleaned = String(raw || '').trim();
    var codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) cleaned = codeBlockMatch[1].trim();
    var jsonStart = cleaned.indexOf('{');
    var jsonEnd = cleaned.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd < 0 || jsonEnd <= jsonStart) return null;
    var parsed = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
    if (!parsed || !Array.isArray(parsed.ranked)) return null;

    var ranked = parsed.ranked.map(function (entry) {
      if (!entry || entry.id == null || entry.id === '') return null;
      var score = Number(entry.score);
      if (!Number.isFinite(score)) score = null;
      else score = Math.max(0, Math.min(100, Math.round(score)));
      var reasons = Array.isArray(entry.reasons)
        ? entry.reasons
            .filter(function (r) { return typeof r === 'string' && r.trim(); })
            .map(function (r) { return r.trim(); })
            .filter(function (r) { return !MONEY_PATTERN.test(r); })
        : [];
      return { id: String(entry.id), score: score, reasons: reasons };
    }).filter(Boolean);

    return { ranked: ranked };
  } catch (e) {
    return null;
  }
}

function _gpForPrompt(gp) {
  var g = gp || {};
  return {
    id: String(g.id != null ? g.id : ''),
    name: g.name || '',
    qualification_country: g.qualificationCountry || '',
    preferred_city: g.preferredCity || '',
    target_arrival_date: g.targetArrivalDate || '',
    who_moving: g.whoMoving || '',
    children_count: g.childrenCount || '',
    background: String(g.handoverSummary || '').slice(0, 500)
  };
}

function _jobForPrompt(job) {
  var j = job || {};
  return {
    id: String(j.id != null ? j.id : ''),
    title: j.title || '',
    practice_name: j.practice_name || '',
    practice_type: j.practice_type || '',
    location_city: j.location_city || '',
    location_state: j.location_state || '',
    employment_type: j.employment_type || '',
    dpa: j.dpa === true,
    visa_pathway_aligned: j.visa_pathway_aligned === true,
    regional: j.regional === true,
    metro: j.metro === true,
    family_friendly: j.family_friendly === true,
    tags: Array.isArray(j.tags) ? j.tags : [],
    summary: j.summary || ''
  };
}

function _buildCandidatesForJobPrompt(job, candidates) {
  return 'JOB / ROLE:\n' + JSON.stringify(_jobForPrompt(job), null, 2)
    + '\n\nCANDIDATES (rank ALL of them):\n' + JSON.stringify(candidates.map(_gpForPrompt), null, 2)
    + '\n\nReturn the JSON described in the system prompt only.';
}

function _buildJobsForGpPrompt(gp, jobs) {
  return 'GP:\n' + JSON.stringify(_gpForPrompt(gp), null, 2)
    + '\n\nJOBS / ROLES (rank ALL of them):\n' + JSON.stringify(jobs.map(_jobForPrompt), null, 2)
    + '\n\nReturn the JSON described in the system prompt only.';
}

// Single Anthropic call. `opts.fetchImpl` lets callers/tests inject a fetch
// override; otherwise the global `fetch` is used (tests may instead just
// stub `globalThis.fetch`, same as lib/ai-matching.js's own test coverage).
// Graceful degradation: any failure (no key, non-2xx, timeout, bad JSON)
// resolves to `{ ranked: [], error: '<reason>' }` — it never throws.
async function _callAnthropicRanking(systemPrompt, userPrompt, opts) {
  var o = opts || {};
  var apiKey = o.apiKey || process.env.ANTHROPIC_API_KEY;
  var model = o.model || process.env.ANTHROPIC_MATCH_MODEL || process.env.ANTHROPIC_MODEL || 'claude-opus-4-6';
  var fetchImpl = o.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!apiKey || !fetchImpl) return { ranked: [], error: 'no_api_key' };

  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, 30000);
  try {
    var resp = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 2000,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userPrompt }]
      })
    });
    if (!resp.ok) return { ranked: [], error: 'api_error_' + resp.status };
    var data = await resp.json();
    var text = (data.content && data.content[0] && data.content[0].text) || '';
    var parsed = parseMatchRanking(text);
    if (!parsed) return { ranked: [], error: 'parse_error' };
    parsed._usage = data.usage || null;
    return parsed;
  } catch (err) {
    return { ranked: [], error: 'fetch_error: ' + (err && err.message) };
  } finally {
    clearTimeout(timeout);
  }
}

function _sortRanked(ranked) {
  ranked.sort(function (a, b) {
    var sa = a.score == null ? -1 : a.score;
    var sb = b.score == null ? -1 : b.score;
    return sb - sa;
  });
  return ranked;
}

/**
 * Rank a list of candidate GPs against one job. `candidates` is an array of
 * plain objects each carrying at least `id` (the caller's user_id) plus the
 * same descriptive fields `_gpForPrompt` reads (name, qualificationCountry,
 * preferredCity, targetArrivalDate, whoMoving, childrenCount, handoverSummary).
 * Batches at `opts.maxBatch` (default 25) candidates per Anthropic call and
 * merges + re-sorts the result. A failed batch degrades to null-score/empty-
 * reasons placeholders for that batch rather than dropping those candidates
 * or failing the whole call.
 */
async function aiRankCandidatesForJob(job, candidates, opts) {
  var list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return { ranked: [] };
  var maxBatch = (opts && opts.maxBatch) || 25;
  var batches = _chunk(list, maxBatch);
  var ranked = [];
  var errors = [];
  for (var i = 0; i < batches.length; i++) {
    var batch = batches[i];
    var result = await _callAnthropicRanking(AI_MATCH_SYSTEM_PROMPT, _buildCandidatesForJobPrompt(job, batch), opts);
    if (result.error) {
      errors.push(result.error);
      batch.forEach(function (c) { ranked.push({ id: String(c.id), score: null, reasons: [] }); });
    } else {
      ranked = ranked.concat(result.ranked || []);
    }
  }
  var out = { ranked: _sortRanked(ranked) };
  if (errors.length) out.error = errors.join('; ');
  return out;
}

/**
 * Mirror of `aiRankCandidatesForJob`: rank a list of open jobs against one GP.
 * `jobs` is an array of plain objects each carrying at least `id` plus the
 * fields `_jobForPrompt` reads.
 */
async function aiRankJobsForGp(gp, jobs, opts) {
  var list = Array.isArray(jobs) ? jobs : [];
  if (!list.length) return { ranked: [] };
  var maxBatch = (opts && opts.maxBatch) || 25;
  var batches = _chunk(list, maxBatch);
  var ranked = [];
  var errors = [];
  for (var i = 0; i < batches.length; i++) {
    var batch = batches[i];
    var result = await _callAnthropicRanking(AI_MATCH_SYSTEM_PROMPT, _buildJobsForGpPrompt(gp, batch), opts);
    if (result.error) {
      errors.push(result.error);
      batch.forEach(function (j) { ranked.push({ id: String(j.id), score: null, reasons: [] }); });
    } else {
      ranked = ranked.concat(result.ranked || []);
    }
  }
  var out = { ranked: _sortRanked(ranked) };
  if (errors.length) out.error = errors.join('; ');
  return out;
}

module.exports = {
  checkMatchEligibility,
  aiRankCandidatesForJob,
  aiRankJobsForGp,
  parseMatchRanking,
  AI_MATCH_SYSTEM_PROMPT
};
