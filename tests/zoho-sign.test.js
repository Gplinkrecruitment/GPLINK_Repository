import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  getZohoSignAccountsServer,
  getZohoSignApiBase,
  getZohoSignOauthRedirectUri,
  mapZohoSignConnectionRow,
  buildCorrectionFieldData,
  mapZohoSignEventToStatus,
  validateZohoSignSignature,
  pickCorrectionRecipient
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

describe('Zoho Sign — correction prefill', () => {
  it('keeps fields outside flagged sections, blanks fields inside flagged sections', () => {
    const oldFields = [
      { field_label: 'practice_name', field_value: 'Acme Clinic', section: 'practice_details' },
      { field_label: 'start_date', field_value: '2026-05-01', section: 'commencement_terms' },
      { field_label: 'candidate_name', field_value: 'Jane Smith', section: 'candidate_details' }
    ];
    const result = buildCorrectionFieldData(oldFields, ['commencement_terms']);
    expect(result).toEqual([
      { field_label: 'practice_name', field_value: 'Acme Clinic', section: 'practice_details' },
      { field_label: 'start_date', field_value: '', section: 'commencement_terms' },
      { field_label: 'candidate_name', field_value: 'Jane Smith', section: 'candidate_details' }
    ]);
  });
  it('flags multiple sections', () => {
    const oldFields = [
      { field_label: 'a', field_value: 'x', section: 's1' },
      { field_label: 'b', field_value: 'y', section: 's2' },
      { field_label: 'c', field_value: 'z', section: 's3' }
    ];
    const r = buildCorrectionFieldData(oldFields, ['s1', 's3']);
    expect(r[0].field_value).toBe('');
    expect(r[1].field_value).toBe('y');
    expect(r[2].field_value).toBe('');
  });
  it('returns empty array for empty input', () => {
    expect(buildCorrectionFieldData([], ['any'])).toEqual([]);
    expect(buildCorrectionFieldData(null, ['any'])).toEqual([]);
  });
});

describe('Zoho Sign — event-to-status mapping', () => {
  it('RequestSentToRecipient (1) -> sent_to_contact', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestSentToRecipient', recipient_index: 1 })).toBe('sent_to_contact');
  });
  it('RequestRecipientSigned (1) -> contact_signed', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestRecipientSigned', recipient_index: 1 })).toBe('contact_signed');
  });
  it('RequestSentToRecipient (2) -> sent_to_candidate', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestSentToRecipient', recipient_index: 2 })).toBe('sent_to_candidate');
  });
  it('RequestRecipientSigned (2) -> candidate_signed', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestRecipientSigned', recipient_index: 2 })).toBe('candidate_signed');
  });
  it('RequestCompleted -> awaiting_review', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestCompleted' })).toBe('awaiting_review');
  });
  it('RequestDeclined -> declined', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestDeclined' })).toBe('declined');
  });
  it('RequestVoided -> voided', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestVoided' })).toBe('voided');
  });
  it('RequestExpired -> expired', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestExpired' })).toBe('expired');
  });
  it('RequestRecipientEmailBounced -> recipient_delivery_failed', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestRecipientEmailBounced' })).toBe('recipient_delivery_failed');
  });
  it('RequestViewed -> null (no status change)', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'RequestViewed' })).toBeNull();
  });
  it('unknown event -> null', () => {
    expect(mapZohoSignEventToStatus({ event_type: 'Whatever' })).toBeNull();
  });
});

describe('Zoho Sign — HMAC signature validation', () => {
  const secret = 'test-secret-123';
  const body = '{"notification_id":"n-1","event_type":"RequestCompleted"}';
  const valid = crypto.createHmac('sha256', secret).update(body, 'utf-8').digest('hex');

  it('accepts a valid hex signature', () => {
    expect(validateZohoSignSignature(body, valid, secret)).toBe(true);
  });
  it('rejects a mismatched signature', () => {
    expect(validateZohoSignSignature(body, 'deadbeef', secret)).toBe(false);
  });
  it('rejects when secret is empty', () => {
    expect(validateZohoSignSignature(body, valid, '')).toBe(false);
  });
  it('rejects when signature header is empty', () => {
    expect(validateZohoSignSignature(body, '', secret)).toBe(false);
  });
});

describe('Zoho Sign — correction recipient selection', () => {
  const contact = { email: 'pc@acme.com', name: 'Pat Contact' };
  const candidate = { email: 'c@gp.com', name: 'Dr Jane' };

  it('picks contact for practice side', () => {
    const r = pickCorrectionRecipient('practice', contact, candidate);
    expect(r.role).toBe('Practice Contact');
    expect(r.email).toBe('pc@acme.com');
    expect(r.signing_order).toBe(1);
  });
  it('picks candidate for candidate side', () => {
    const r = pickCorrectionRecipient('candidate', contact, candidate);
    expect(r.role).toBe('Candidate');
    expect(r.email).toBe('c@gp.com');
    expect(r.signing_order).toBe(1);
  });
  it('throws on unknown side', () => {
    expect(() => pickCorrectionRecipient('neither', contact, candidate)).toThrow();
  });
});
