// lib/zoho-sign.js
'use strict';

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

module.exports = {
  ZOHO_SIGN_SCOPES,
  getZohoSignAccountsServer,
  getZohoSignApiBase,
  getZohoSignOauthRedirectUri,
  normalizeUrlBase,
  mapZohoSignConnectionRow
};
