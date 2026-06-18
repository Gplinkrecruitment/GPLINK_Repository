const crypto = require('crypto');

const CALL_STATUS_TO_TASK_STATUS = {
  invited: 'waiting_on_gp',
  booked: 'waiting',
  completed: 'completed',
  cancelled: 'waiting_on_gp', // cancelled keeps the task open as "needs rebooking"
  no_show: 'waiting_on_gp'
};

function mapCallStatusToTaskStatus(callStatus) {
  return CALL_STATUS_TO_TASK_STATUS[callStatus] || 'open';
}

// GP-driven call failures (no-show or GP cancellation) get one rebooking grace;
// the 2nd failure auto-closes the linked task. Keep in sync with server.js.
function computeCallFailureOutcome(prevFailedCount) {
  const newCount = (Number(prevFailedCount) || 0) + 1;
  return { newCount, autoClose: newCount >= 2 };
}

function generateCorrelationToken() {
  return crypto.randomBytes(16).toString('hex');
}

function buildScheduledCallInsertPayload(input = {}) {
  const nowIso = input.nowIso || new Date().toISOString();
  return {
    case_id: input.caseId,
    user_id: input.userId,
    stage: input.stage,
    status: 'invited',
    admin_notes: input.adminNotes || null,
    meeting_reason: input.meetingReason || null,
    correlation_token: input.correlationToken,
    calendly_booking_url: input.bookingUrl,
    calendly_event_type_uri: input.calendlyEventTypeUri || null,
    duration_minutes: Number(input.durationMinutes || 30),
    summary_status: 'not_requested',
    created_by: input.createdBy || 'admin',
    created_at: nowIso,
    updated_at: nowIso
  };
}

// Pick which RSO hosts a scheduled call. Pure (no DB) so it can be unit-tested.
// Keep IDENTICAL to the copy in server.js.
// opts: { explicitEmail, isCeo, caseAssigneeUserId }
//   - An explicit RSO email is ONLY honored for a CEO/super-admin requester.
//   - Otherwise (or when no honored email matches) fall back to the GP's assigned RSO.
function pickScheduledCallRso(roster, opts) {
  const list = Array.isArray(roster) ? roster : [];
  const email = opts && opts.isCeo ? String(opts.explicitEmail || '').trim().toLowerCase() : '';
  let rso = email ? list.find(r => String(r.email || '').toLowerCase() === email) : null;
  if (!rso && opts && opts.caseAssigneeUserId) rso = list.find(r => r.user_id === opts.caseAssigneeUserId) || null;
  return rso || null;
}

// From/Reply-To options so an invite email is sent on behalf of the assigned RSO.
// Keep IDENTICAL to the copy in server.js.
function buildRsoEmailFromOpts(rso) {
  const opts = {};
  const addr = rso && rso.email ? String(rso.email).trim() : '';
  if (addr) {
    if (/@mygplink\.com\.au$/i.test(addr)) opts.from = { email: addr, name: (rso.name || 'GP Link') + ' (GP Link)' };
    opts.replyTo = addr;
  }
  return opts;
}

// Attendance verdict from Zoom past-meeting participants. Keep IDENTICAL to the copy in server.js.
function classifyCallAttendance(participants, rso) {
  const list = Array.isArray(participants) ? participants : [];
  const rsoEmail = String((rso && rso.email) || '').trim().toLowerCase();
  const rsoName = String((rso && rso.name) || '').trim().toLowerCase();
  const nonHost = list.filter(function (p) {
    const email = String((p && (p.email || p.user_email)) || '').trim().toLowerCase();
    const name = String((p && (p.name || p.user_name)) || '').trim().toLowerCase();
    if (rsoEmail && email === rsoEmail) return false;
    if (!email && rsoName && name === rsoName) return false;
    return true;
  });
  return nonHost.length > 0 ? 'attended' : 'no_show';
}

// No-show candidacy for a booked call. Keep IDENTICAL to the copy in server.js.
function isNoShowCandidate(call, nowMs, graceMinutes) {
  if (!call || call.status !== 'booked') return false;
  if (!call.scheduled_at || call.completed_at || call.no_show_at) return false;
  const start = Date.parse(call.scheduled_at);
  if (!Number.isFinite(start)) return false;
  const dur = Number(call.duration_minutes || 30);
  const grace = Number(graceMinutes == null ? 15 : graceMinutes);
  return (start + (dur + grace) * 60000) < Number(nowMs);
}

// Pure builder/validator for rso_team writes (create or update). No DB access so it
// can be unit-tested. Keep IDENTICAL to the copy in server.js.
// In 'update' mode only the supplied fields are included (partial PATCH); in 'create'
// mode required fields are enforced and sensible defaults are applied.
function buildRsoWritePayload(input = {}, opts = {}) {
  const mode = opts.mode === 'update' ? 'update' : 'create';
  const create = mode === 'create';
  const errors = [];
  const out = {};
  function has(k) { return Object.prototype.hasOwnProperty.call(input, k); }

  // NAME
  if (create || has('name')) {
    const name = String(input.name == null ? '' : input.name).trim();
    if (create && !name) errors.push('Name is required.');
    if (name || create) out.name = name;
  }

  // EMAIL
  if (create || has('email')) {
    const email = String(input.email == null ? '' : input.email).trim().toLowerCase();
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (create && !email) errors.push('Email is required.');
    else if (email && !emailOk) errors.push('Email is not a valid email address.');
    if (email || create) out.email = email;
  }

  // PHONE
  if (has('phone')) out.phone = String(input.phone == null ? '' : input.phone).trim();
  else if (create) out.phone = '';

  // ACTIVE
  if (has('active')) out.active = !!input.active;
  else if (create) out.active = true;

  // CALENDLY
  if (create || has('calendlyEventUrl') || has('calendly_event_url')) {
    const raw = input.calendlyEventUrl != null ? input.calendlyEventUrl : input.calendly_event_url;
    const url = String(raw == null ? '' : raw).trim();
    if (url && !/^https:\/\/calendly\.com\//i.test(url)) errors.push('Calendly link must start with https://calendly.com/');
    out.calendly_event_url = url || null;
  }

  // USER_ID (create only)
  if (create) {
    const userId = String(input.userId || input.user_id || '').trim();
    if (!userId) errors.push('user_id is required.');
    out.user_id = userId;
  }

  out.updated_at = input.nowIso || new Date().toISOString();
  return { valid: errors.length === 0, errors, payload: out };
}

function getScheduledCallRegistrationTaskId(callRecord) {
  if (!callRecord || typeof callRecord !== 'object') return null;
  return callRecord.registration_task_id || callRecord.task_id || null;
}

function buildScheduledCallNotificationPatch(waResult = {}, emailResult = {}, options = {}) {
  const nowIso = options.nowIso || new Date().toISOString();
  const whatsappMessageId = waResult.messageId || waResult.message_id || waResult.id || null;
  const emailMessageId = emailResult.messageId || emailResult.message_id || emailResult.id || null;
  const notificationChannels = {
    whatsapp: {
      requested: !!options.whatsappRequested,
      sent: !!waResult.ok,
      message_id: whatsappMessageId
    },
    email: {
      requested: !!options.emailRequested,
      sent: !!emailResult.ok,
      message_id: emailMessageId
    }
  };
  if (waResult.error) notificationChannels.whatsapp.error = String(waResult.error).slice(0, 500);
  if (emailResult.error) notificationChannels.email.error = String(emailResult.error).slice(0, 500);
  const patch = {
    invite_sent_at: nowIso,
    notification_channels: notificationChannels,
    whatsapp_message_id: whatsappMessageId,
    email_message_id: emailMessageId,
    updated_at: nowIso
  };
  if (options.resendCount !== undefined) patch.resend_count = options.resendCount;
  return patch;
}

function normalizeScheduledCallForApi(callRecord) {
  if (!callRecord || typeof callRecord !== 'object') return callRecord;
  return {
    ...callRecord,
    booking_url: callRecord.calendly_booking_url || callRecord.booking_url || '',
    task_id: getScheduledCallRegistrationTaskId(callRecord),
    calendly_event_url: callRecord.calendly_event_uri || callRecord.calendly_event_url || ''
  };
}

function verifyCalendlySignature(signatureHeader, rawBody, secret) {
  if (!signatureHeader || !secret) return false;
  const timestampCandidates = [];
  const signatures = [];
  for (const pair of signatureHeader.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key === 't' && val) timestampCandidates.push(val);
    if (key === 'v1' && val) signatures.push(val);
  }
  const timestamp = timestampCandidates[0];
  if (!timestamp || signatures.length === 0) return false;
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) return false;
  const timestampMs = timestampNumber < 10000000000 ? timestampNumber * 1000 : timestampNumber;
  const age = Date.now() - timestampMs;
  if (age > 5 * 60 * 1000 || age < -60 * 1000) return false;
  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(timestamp + '.', 'utf8');
  hmac.update(bodyBuffer);
  const expectedBuf = Buffer.from(hmac.digest('hex'), 'hex');
  return signatures.some((signature) => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const candidateBuf = Buffer.from(signature, 'hex');
    return candidateBuf.length === expectedBuf.length && crypto.timingSafeEqual(candidateBuf, expectedBuf);
  });
}

function verifyZoomWebhookSignature(timestamp, rawBody, signature, secret) {
  if (!timestamp || !signature || !secret) return false;
  const message = 'v0:' + timestamp + ':' + rawBody;
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update(message).digest('hex');
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function buildZoomValidationResponse(plainToken, secret) {
  const encryptedToken = crypto.createHmac('sha256', secret).update(plainToken).digest('hex');
  return { plainToken, encryptedToken };
}

module.exports = {
  mapCallStatusToTaskStatus,
  computeCallFailureOutcome,
  generateCorrelationToken,
  pickScheduledCallRso,
  buildRsoEmailFromOpts,
  classifyCallAttendance,
  isNoShowCandidate,
  buildScheduledCallInsertPayload,
  buildRsoWritePayload,
  buildScheduledCallNotificationPatch,
  getScheduledCallRegistrationTaskId,
  normalizeScheduledCallForApi,
  verifyCalendlySignature,
  verifyZoomWebhookSignature,
  buildZoomValidationResponse
};
