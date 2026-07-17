'use strict';

/**
 * lib/job-writeup.js
 *
 * Pure logic for the AI job write-up feature: builds the prompt sent to the
 * model, parses the model's JSON reply, and — critically — a safety
 * backstop (`maskIdentity` / `scrubWriteup`) that strips any identifying
 * details (practice name, street address, doctor names) before the
 * write-up can reach the public, identity-masked job board.
 *
 * No I/O here: no network calls, no DB access. Callers (the API route)
 * are responsible for actually invoking the AI model with the prompt this
 * module builds, and for running the model's raw text through
 * parseWriteupResponse + scrubWriteup before anything is persisted or shown
 * publicly.
 */

const WRITEUP_SOURCES = ['form', 'website', 'area'];

/**
 * Escape a string for safe use inside a RegExp.
 */
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the prompt sent to the AI model to draft a masked job write-up.
 *
 * @param {object} params
 * @param {object} [params.details] - key/value facts about the role (e.g. percentage_split)
 * @param {string} [params.introText] - the practice's own raw intro text (free-form)
 * @param {string} [params.websiteText] - text scraped/summarised from the practice website, if any
 * @param {string} [params.suburb]
 * @param {string} [params.nearestCity]
 * @param {string} [params.state]
 * @returns {string}
 */
function buildWriteupPrompt({ details, introText, websiteText, suburb, nearestCity, state } = {}) {
  const safeDetails = details && typeof details === 'object' ? details : {};
  const detailLines = Object.entries(safeDetails)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  const areaBits = [suburb, nearestCity, state].filter(Boolean).join(', ');

  const lines = [];
  lines.push('You are a recruitment copywriter for a medical-jobs board. Your job is to write a short, honest job write-up using ONLY the allowed facts below.');
  lines.push('');
  lines.push('Allowed facts:');
  if (detailLines) {
    lines.push(detailLines);
  } else {
    lines.push('- (no structured details supplied)');
  }
  if (introText) {
    lines.push(`- Practice-supplied intro text: "${introText}"`);
  }
  if (websiteText) {
    lines.push(`- Practice website text: "${websiteText}"`);
  }
  if (areaBits) {
    lines.push(`- Area / region (for general area knowledge only): ${areaBits}`);
  }
  lines.push('');
  lines.push('Strict rules — this write-up will be published on a PUBLIC, identity-masked job board:');
  lines.push('- Do NOT name, mention, or include the practice name anywhere in your answer.');
  lines.push('- Do NOT name, mention, or include any doctor, owner, or staff member by name.');
  lines.push('- Do NOT mention or include the street address, or any part of it.');
  lines.push('- Do NOT invent clinical services, equipment, or facts that are not in the allowed facts above.');
  lines.push('- Do NOT use unverifiable superlatives (e.g. "the best", "award-winning") unless they appear in the allowed facts.');
  lines.push('- You may refer to the general suburb/region/area for context, but do not narrow it down to a specific street.');
  lines.push('');
  lines.push('Respond with JSON only, no prose before or after, in exactly this shape:');
  lines.push('{"about": "1-3 short paragraphs describing the role/opportunity", "highlights": ["up to 5 short highlight bullets"], "sources": ["form"|"website"|"area", ...]}');
  lines.push('Keep "about" to a maximum of about 3 short paragraphs, and "highlights" to a maximum of 5 items.');

  return lines.join('\n');
}

/**
 * Parse the AI model's raw text reply into a { about, highlights, sources }
 * object, or null if it can't be parsed / is missing a usable `about`.
 *
 * @param {string} rawModelText
 * @returns {{about: string, highlights: string[], sources: string[]}|null}
 */
function parseWriteupResponse(rawModelText) {
  if (typeof rawModelText !== 'string' || !rawModelText.trim()) return null;

  const match = rawModelText.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.about !== 'string' || !parsed.about.trim()) return null;

  const highlights = Array.isArray(parsed.highlights) ? parsed.highlights : [];
  const sources = Array.isArray(parsed.sources) ? parsed.sources : [];

  return { about: parsed.about, highlights, sources };
}

/**
 * Safety backstop: strip identifying details from a piece of text before it
 * can reach the public job board.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.practiceName]
 * @param {string} [opts.address]
 * @returns {string}
 */
function maskIdentity(text, { practiceName, address } = {}) {
  if (typeof text !== 'string' || !text) return text;

  let result = text;

  if (practiceName && typeof practiceName === 'string' && practiceName.trim()) {
    const pattern = new RegExp(escapeRegExp(practiceName.trim()), 'gi');
    result = result.replace(pattern, 'the practice');
  }

  if (address && typeof address === 'string' && address.trim()) {
    const street = address.split(',')[0].trim();
    if (street) {
      const pattern = new RegExp(escapeRegExp(street), 'gi');
      result = result.replace(pattern, '');
    }
  }

  result = result.replace(/\bDr\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g, 'our doctors');

  result = result.replace(/ {2,}/g, ' ');

  return result;
}

/**
 * Apply maskIdentity to every reader-facing field of a writeup object.
 * Never throws, even on empty/missing input.
 *
 * @param {{about?: string, highlights?: string[], sources?: string[]}} writeup
 * @param {object} [opts]
 * @param {string} [opts.practiceName]
 * @param {string} [opts.address]
 * @returns {{about: string, highlights: string[], sources: string[]}}
 */
function scrubWriteup(writeup, opts = {}) {
  const safe = writeup && typeof writeup === 'object' ? writeup : {};
  const about = maskIdentity(typeof safe.about === 'string' ? safe.about : '', opts);
  const highlights = Array.isArray(safe.highlights)
    ? safe.highlights.map((h) => maskIdentity(typeof h === 'string' ? h : '', opts))
    : [];
  const sources = Array.isArray(safe.sources) ? safe.sources : [];

  return { about, highlights, sources };
}

module.exports = {
  buildWriteupPrompt,
  parseWriteupResponse,
  maskIdentity,
  scrubWriteup,
  WRITEUP_SOURCES,
};
