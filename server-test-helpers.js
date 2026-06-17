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
  buildScheduledCallInsertPayload,
  buildScheduledCallNotificationPatch,
  getScheduledCallRegistrationTaskId,
  normalizeScheduledCallForApi,
  verifyCalendlySignature,
  verifyZoomWebhookSignature,
  buildZoomValidationResponse
};
