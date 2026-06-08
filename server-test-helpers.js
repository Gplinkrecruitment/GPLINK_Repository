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
  const parts = {};
  for (const pair of signatureHeader.split(',')) {
    const [key, val] = pair.split('=', 2);
    if (key && val) parts[key.trim()] = val.trim();
  }
  const timestamp = parts['t'];
  const v1 = parts['v1'];
  if (!timestamp || !v1) return false;
  const age = Date.now() - Number(timestamp);
  if (age > 5 * 60 * 1000 || age < -60 * 1000) return false;
  const expected = crypto.createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
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
