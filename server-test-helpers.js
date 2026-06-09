const crypto = require('crypto');

const CALL_STATUS_TO_TASK_STATUS = {
  invited: 'waiting_on_gp',
  booked: 'waiting',
  completed: 'completed',
  cancelled: 'cancelled',
  no_show: 'waiting_on_gp'
};

function mapCallStatusToTaskStatus(callStatus) {
  return CALL_STATUS_TO_TASK_STATUS[callStatus] || 'open';
}

function generateCorrelationToken() {
  return crypto.randomBytes(16).toString('hex');
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
  generateCorrelationToken,
  verifyCalendlySignature,
  verifyZoomWebhookSignature,
  buildZoomValidationResponse
};
