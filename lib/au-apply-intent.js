'use strict';
/**
 * WP-22 (Australian GP build): "Apply now" on a public job ends with THAT job
 * open in Careers, however many steps (sign-up, email check, onboarding) sit
 * in between. This file holds the rules; server.js does the reading and
 * writing. Pure: no I/O, no switch read.
 *
 * THE MECHANISM, hop by hop
 *   1. The public job page links to  /jobs/apply?id=<public role id>.
 *   2. The server checks the role is on the public board, then:
 *        - signed in already  -> stores the intent on the account and sends
 *          the doctor to Careers (the app shell opens the job);
 *        - not signed in      -> puts the intent in a signed, HttpOnly cookie
 *          (the store "keyed to the browser" before an account exists) and
 *          sends them to sign-up.
 *   3. When that browser signs up or signs in (password or Google), the
 *      server moves the intent from the cookie to the ACCOUNT
 *      (runtime_kv `apply_intent:<user id>`, its own row, with an expiry) and
 *      writes one line on the doctor's case timeline for staff. From here it
 *      no longer depends on the browser: verifying the email on a phone and
 *      finishing there still works.
 *   4. The app shell asks  POST /api/career/apply-intent/claim  when the
 *      browser carries the small flag cookie. The server decides (decide()
 *      below) and, when the answer is final, marks the intent consumed in the
 *      same request, so it is acted on ONCE.
 *
 * The intent never applies for anyone. It only opens the job page; the doctor
 * still chooses, with the CV step and (Australian doctors) the consent tick.
 *
 * The role id is the public one (`<provider>:<provider_role_id>`), the same id
 * the in-app job page uses. Nothing about the practice is ever stored.
 */

const crypto = require('crypto');

const COOKIE_NAME = 'gp_apply_intent';
// Readable by the page, carries nothing: "ask the server about an intent".
const FLAG_COOKIE_NAME = 'gp_apply_intent_flag';
const KV_PREFIX = 'apply_intent:';
// Long enough to sign up today and finish onboarding next week; short enough
// that a forgotten click does not open a stale role months later.
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
// A consumed record is kept a little while so staff can still see it and a
// repeated claim answers "nothing to do" rather than acting twice.
const CONSUMED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const TIMELINE_MARKER = 'Applied from the public job board';

function isValidJobId(id) {
  const s = String(id == null ? '' : id);
  return s.length <= 200 && /^[a-z0-9_]{2,40}:[A-Za-z0-9._:\-]{1,150}$/.test(s);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function fromB64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function sign(secret, payload) {
  return crypto.createHmac('sha256', 'apply-intent:' + String(secret || '')).update(payload).digest('hex');
}

/** The cookie value for an intent: `<payload>.<signature>`. */
function encodeCookie(secret, intent) {
  const i = intent || {};
  if (!secret || !isValidJobId(i.job)) return '';
  const payload = b64url(JSON.stringify({ job: String(i.job), at: Number(i.at) || Date.now() }));
  return payload + '.' + sign(secret, payload);
}

/** `{ job, at }` from a cookie value, or null (missing, altered, expired, malformed). */
function decodeCookie(secret, value, nowMs) {
  const raw = String(value == null ? '' : value);
  const dot = raw.lastIndexOf('.');
  if (!secret || dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = sign(secret, payload);
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch (e) { return null; }
  let parsed = null;
  try { parsed = JSON.parse(fromB64url(payload)); } catch (e) { return null; }
  if (!parsed || !isValidJobId(parsed.job)) return null;
  const at = Number(parsed.at);
  const now = Number(nowMs) || Date.now();
  if (!Number.isFinite(at) || at > now + 60000 || now - at > TTL_MS) return null;
  return { job: String(parsed.job), at };
}

function kvKey(userKey) { return KV_PREFIX + String(userKey || '').trim().toLowerCase(); }

/** A fresh account record. */
function newRecord(intent, source) {
  const i = intent || {};
  const at = Number(i.at) || Date.now();
  return {
    v: 1,
    job: String(i.job || ''),
    at,
    expiresAt: at + TTL_MS,
    source: String(source || 'public_job_page'),
    status: 'pending',
    outcome: '',
    consumedAt: null
  };
}

function isRecord(record) {
  return !!(record && typeof record === 'object' && isValidJobId(record.job));
}
function isPending(record, nowMs) {
  if (!isRecord(record) || record.status !== 'pending') return false;
  const now = Number(nowMs) || Date.now();
  return Number(record.expiresAt) > now;
}

/** Should `incoming` (from a cookie) replace what the account already holds? */
function shouldReplace(existing, incoming, nowMs) {
  if (!incoming || !isValidJobId(incoming.job)) return false;
  if (!isRecord(existing)) return true;
  // The newest click wins; the same click is never written twice (and never
  // un-consumes a record that was already acted on).
  return Number(incoming.at) > Number(existing.at);
}

function consumed(record, outcome, nowMs) {
  return Object.assign({}, record, { status: 'consumed', outcome: String(outcome || ''), consumedAt: Number(nowMs) || Date.now() });
}

// What the doctor is told. No role, practice or place is ever named: a role
// the doctor may not see is not described back to them.
const MESSAGES = Object.freeze({
  closed: {
    title: 'That role has just closed',
    body: 'The role you chose from our job board is no longer open. Here are the roles open to you now.'
  },
  // Reasons from lib/role-eligibility.js roleEligibilityFor.
  au_dpa_restricted: {
    title: 'We could not open that role for you yet',
    body: 'Until we have confirmed your registration details, some roles are held back for you, including roles outside a Distribution Priority Area. Your GP Link consultant can tell you more. The roles below are open to you now.'
  },
  au_role_dpa_unknown: {
    title: 'We could not open that role for you yet',
    body: 'We are still confirming with the practice whether that role is in a Distribution Priority Area, so it is not open to you yet. The roles below are open to you now.'
  },
  vr_required: {
    title: 'That role is for vocationally registered GPs',
    body: 'The role you chose is only open to vocationally registered GPs. The roles below are open to you now.'
  },
  registrars_not_accepted: {
    title: 'That role is not open to GP registrars',
    body: 'The practice is not taking GP registrars for the role you chose. The roles below are open to you now.'
  },
  supervised_not_accepted: {
    title: 'That role cannot offer supervision',
    body: 'The practice cannot offer the supervision your registration needs for the role you chose. The roles below are open to you now.'
  },
  legacy_dpa_restricted: {
    title: 'We could not open that role for you',
    body: 'The role you chose is not in a Distribution Priority Area, and the roles we can put you forward for are in one. The roles below are open to you now.'
  },
  unreadable: {
    title: 'We could not open that role for you yet',
    body: 'We could not confirm your details just now, so the role you chose is not open to you yet. The roles below are open to you now.'
  },
  held: {
    title: 'We have noted the role you chose',
    body: 'Our team is confirming your details and will be in touch about that role and others that fit.'
  }
});

function ineligibleMessageKey(verdict, isAu) {
  const reasons = verdict && Array.isArray(verdict.reasons) ? verdict.reasons : [];
  if (reasons.indexOf('pathway_unreadable') !== -1) return 'unreadable';
  if (!isAu) return 'legacy_dpa_restricted';
  if (reasons.indexOf('vr_required') !== -1) return 'vr_required';
  if (reasons.indexOf('registrars_not_accepted') !== -1) return 'registrars_not_accepted';
  if (reasons.indexOf('supervised_not_accepted') !== -1) return 'supervised_not_accepted';
  if (reasons.indexOf('role_dpa_unknown') !== -1) return 'au_role_dpa_unknown';
  if (reasons.indexOf('dpa_restricted') !== -1) return 'au_dpa_restricted';
  return 'unreadable';
}

/**
 * THE decision for a claim.
 *
 * @param {object} facts
 * @param {object|null} facts.record          the account's record
 * @param {boolean} facts.onboardingComplete
 * @param {boolean} facts.roleOpen            the role is on the public board right now
 * @param {object|null} facts.verdict         roleEligibilityFor(pathway, role) (when the role is open)
 * @param {boolean} facts.isAu                the doctor is on an Australian pathway
 * @param {number} [facts.now]
 * @returns {{ action: 'none'|'wait'|'open'|'closed'|'not_eligible'|'held', consume: boolean,
 *             keepFlag: boolean, go?: string, notice?: { title: string, body: string }, outcome?: string }}
 *   consume:  write the record as consumed now (the answer is final)
 *   keepFlag: the browser should ask again later (false clears the flag cookie)
 */
function decide(facts) {
  const f = facts || {};
  const now = Number(f.now) || Date.now();
  if (!isPending(f.record, now)) return { action: 'none', consume: false, keepFlag: false };
  // Not through onboarding yet: nothing is shown, nothing is used up.
  if (!f.onboardingComplete) return { action: 'wait', consume: false, keepFlag: true };
  if (!f.roleOpen) {
    return { action: 'closed', consume: true, keepFlag: false, outcome: 'role_closed', notice: MESSAGES.closed };
  }
  const v = f.verdict && typeof f.verdict === 'object' ? f.verdict : null;
  // A doctor in a group that is not launched: the hold card is what they see.
  // The intent is KEPT (pending) so staff can see it and, if the group is
  // launched or staff confirm the doctor, it still opens the role.
  if (v && v.hold === true) {
    return { action: 'held', consume: false, keepFlag: false, outcome: 'held', notice: MESSAGES.held };
  }
  if (!v || v.canApply !== true) {
    const key = ineligibleMessageKey(v, f.isAu === true);
    return { action: 'not_eligible', consume: true, keepFlag: false, outcome: 'not_eligible:' + key, notice: MESSAGES[key] };
  }
  return {
    action: 'open',
    consume: true,
    keepFlag: false,
    outcome: 'opened',
    go: '/pages/job?id=' + encodeURIComponent(String(f.record.job))
  };
}

/** The one line staff read on the doctor's timeline. */
function timelineLine(roleLabel) {
  const label = String(roleLabel || '').trim();
  return { title: TIMELINE_MARKER, detail: label ? 'Pressed "Apply now" on: ' + label + '. Nothing has been applied for yet.' : 'Pressed "Apply now" on a role that is no longer listed.' };
}

module.exports = {
  COOKIE_NAME,
  FLAG_COOKIE_NAME,
  KV_PREFIX,
  TTL_MS,
  CONSUMED_KEEP_MS,
  TIMELINE_MARKER,
  MESSAGES,
  isValidJobId,
  encodeCookie,
  decodeCookie,
  kvKey,
  newRecord,
  isRecord,
  isPending,
  shouldReplace,
  consumed,
  ineligibleMessageKey,
  decide,
  timelineLine
};
