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

module.exports = {
  ZOHO_SIGN_SCOPES,
  getZohoSignAccountsServer,
  getZohoSignApiBase,
  getZohoSignOauthRedirectUri,
  normalizeUrlBase
};
