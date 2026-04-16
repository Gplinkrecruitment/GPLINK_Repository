import { describe, it, expect } from 'vitest';
import {
  getZohoSignAccountsServer,
  getZohoSignApiBase,
  getZohoSignOauthRedirectUri
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
