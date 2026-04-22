// lib/zoho-sign.js
'use strict';

const crypto = require('crypto');

function normalizeUrlBase(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return String(fallback || '').trim().replace(/\/$/, '');
  return raw.replace(/\/$/, '');
}

const ZOHO_SIGN_SCOPES = [
  'ZohoSign.documents.ALL',
  'ZohoSign.templates.READ',
  'ZohoSign.account.READ'
];

function getZohoSignAccountsServer() {
  return normalizeUrlBase(process.env.ZOHO_SIGN_ACCOUNTS_SERVER, 'https://accounts.zoho.com.au');
}

function getZohoSignApiBase() {
  return normalizeUrlBase(process.env.ZOHO_SIGN_API_BASE, 'https://sign.zoho.com.au/api/v1');
}

function getZohoSignOauthRedirectUri() {
  const override = String(process.env.ZOHO_SIGN_REDIRECT_URI || '').trim();
  if (override) return override;
  const base = String(process.env.PUBLIC_BASE_URL || 'https://www.mygplink.com.au').trim().replace(/\/$/, '');
  return `${base}/api/admin/integrations/zoho-sign/callback`;
}

function mapZohoSignConnectionRow(row) {
  if (!row) return null;
  const meta = (row.metadata && typeof row.metadata === 'object') ? row.metadata : {};
  return {
    provider: 'zoho_sign',
    status: String(row.status || 'disconnected'),
    accountsServer: String(row.accounts_server || ''),
    apiDomain: String(row.api_domain || ''),
    refreshToken: String(row.refresh_token || ''),
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    connectedEmail: String(row.connected_email || ''),
    connectedByUserId: String(row.connected_by_user_id || ''),
    accessToken: String(meta.access_token || ''),
    tokenExpiresAt: meta.token_expires_at ? String(meta.token_expires_at) : '',
    webhookSecret: String(meta.webhook_secret || ''),
    webhookRegisteredAt: meta.webhook_registered_at ? String(meta.webhook_registered_at) : '',
    lastRefreshError: meta.last_refresh_error ? String(meta.last_refresh_error) : '',
    orgName: String(meta.org_name || ''),
    orgId: String(meta.org_id || ''),
    templateId: String(meta.template_id || ''),
    tokenLastRefreshedAt: row.token_last_refreshed_at || null,
    metadata: meta
  };
}

/**
 * @param {Array<{field_label: string, field_value: string, section: string}>} oldFields
 * @param {string[]} flaggedSections
 * @returns {Array<{field_label: string, field_value: string, section: string}>}
 */
function buildCorrectionFieldData(oldFields, flaggedSections) {
  if (!Array.isArray(oldFields) || oldFields.length === 0) return [];
  const flagged = new Set((flaggedSections || []).map(String));
  return oldFields.map((f) => ({
    field_label: String(f.field_label || ''),
    field_value: flagged.has(String(f.section || '')) ? '' : String(f.field_value || ''),
    section: String(f.section || '')
  }));
}

/**
 * Map a Zoho Sign webhook event to an internal envelope status.
 * Returns null for events that do not change status (e.g. RequestViewed).
 */
function mapZohoSignEventToStatus(event) {
  if (!event || !event.event_type) return null;
  const et = String(event.event_type);
  const idx = Number(event.recipient_index || 0);
  if (et === 'RequestSentToRecipient') return idx === 2 ? 'sent_to_candidate' : 'sent_to_contact';
  if (et === 'RequestRecipientSigned') return idx === 2 ? 'candidate_signed' : 'contact_signed';
  if (et === 'RequestCompleted') return 'awaiting_review';
  if (et === 'RequestDeclined') return 'declined';
  if (et === 'RequestVoided') return 'voided';
  if (et === 'RequestExpired') return 'expired';
  if (et === 'RequestRecipientEmailBounced') return 'recipient_delivery_failed';
  return null;
}

function validateZohoSignSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;
  try {
    const expected = crypto.createHmac('sha256', String(secret)).update(String(rawBody || ''), 'utf-8').digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signatureHeader));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

function pickCorrectionRecipient(side, contact, candidate) {
  if (side === 'practice') {
    return { role: 'Medical Practice Contact', email: String((contact && contact.email) || ''), name: String((contact && contact.name) || ''), signing_order: 1 };
  }
  if (side === 'candidate') {
    return { role: 'Candidate', email: String((candidate && candidate.email) || ''), name: String((candidate && candidate.name) || ''), signing_order: 1 };
  }
  throw new Error('Invalid correction side: ' + side);
}

module.exports = {
  ZOHO_SIGN_SCOPES,
  getZohoSignAccountsServer,
  getZohoSignApiBase,
  getZohoSignOauthRedirectUri,
  normalizeUrlBase,
  mapZohoSignConnectionRow,
  buildCorrectionFieldData,
  mapZohoSignEventToStatus,
  validateZohoSignSignature,
  pickCorrectionRecipient
};
