import { describe, it, expect } from 'vitest';
import {
  getZohoSignAccountsServer,
  getZohoSignApiBase,
  getZohoSignOauthRedirectUri,
  mapZohoSignConnectionRow
} from '../lib/zoho-sign.js';

describe('Zoho Sign — URL helpers', () => {
  it('getZohoSignAccountsServer returns AU region by default', () => {
    delete process.env.ZOHO_SIGN_ACCOUNTS_SERVER;
    expect(getZohoSignAccountsServer()).toBe('https://accounts.zoho.com.au');
  });
  it('getZohoSignAccountsServer respects override', () => {
    process.env.ZOHO_SIGN_ACCOUNTS_SERVER = 'https://accounts.zoho.com/';
    expect(getZohoSignAccountsServer()).toBe('https://accounts.zoho.com');
    delete process.env.ZOHO_SIGN_ACCOUNTS_SERVER;
  });
  it('getZohoSignApiBase defaults to AU', () => {
    delete process.env.ZOHO_SIGN_API_BASE;
    expect(getZohoSignApiBase()).toBe('https://sign.zoho.com.au/api/v1');
  });
  it('getZohoSignOauthRedirectUri builds default callback URL', () => {
    delete process.env.ZOHO_SIGN_REDIRECT_URI;
    delete process.env.PUBLIC_BASE_URL;
    expect(getZohoSignOauthRedirectUri()).toBe('https://www.mygplink.com.au/api/admin/integrations/zoho-sign/callback');
  });
});

describe('Zoho Sign — connection mapper', () => {
  it('maps integration_connections row to a normalized connection object', () => {
    const row = {
      provider: 'zoho_sign',
      status: 'connected',
      accounts_server: 'https://accounts.zoho.com.au',
      api_domain: 'https://sign.zoho.com.au',
      refresh_token: 'rt-abc',
      scopes: ['ZohoSign.documents.ALL'],
      connected_email: 'admin@mygplink.com.au',
      metadata: {
        access_token: 'at-123',
        token_expires_at: '2026-04-18T00:00:00Z',
        webhook_secret: 'hmac-shhh',
        org_name: 'GP Link Org',
        template_id: 'tpl-xyz'
      }
    };
    const c = mapZohoSignConnectionRow(row);
    expect(c.status).toBe('connected');
    expect(c.accessToken).toBe('at-123');
    expect(c.refreshToken).toBe('rt-abc');
    expect(c.webhookSecret).toBe('hmac-shhh');
    expect(c.orgName).toBe('GP Link Org');
    expect(c.tokenExpiresAt).toBe('2026-04-18T00:00:00Z');
  });
  it('returns null-like fields when metadata is empty', () => {
    const c = mapZohoSignConnectionRow({ provider: 'zoho_sign', status: 'connected', metadata: null });
    expect(c.accessToken).toBe('');
    expect(c.webhookSecret).toBe('');
  });
  it('returns null when row is null', () => {
    expect(mapZohoSignConnectionRow(null)).toBeNull();
  });
  it('treats non-object metadata as empty', () => {
    const c = mapZohoSignConnectionRow({ provider: 'zoho_sign', status: 'connected', metadata: 'not-an-object' });
    expect(c.accessToken).toBe('');
    expect(c.webhookSecret).toBe('');
  });
  it('returns empty array when scopes is not an array', () => {
    const c = mapZohoSignConnectionRow({ provider: 'zoho_sign', status: 'connected', scopes: 'ZohoSign.documents.ALL', metadata: {} });
    expect(c.scopes).toEqual([]);
  });
  it('exposes last_refresh_error from metadata', () => {
    const c = mapZohoSignConnectionRow({
      provider: 'zoho_sign',
      status: 'error',
      metadata: { last_refresh_error: 'invalid_grant' }
    });
    expect(c.lastRefreshError).toBe('invalid_grant');
  });
});
