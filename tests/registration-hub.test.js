import { describe, it, expect } from 'vitest';
import pkg from '../lib/registration-hub.js';
const { buildSenderDisplayName, resolveSender, isHubInbox } = pkg;

describe('buildSenderDisplayName', () => {
  it('appends the GP Link suffix when a name is given', () => {
    expect(buildSenderDisplayName('Hazel')).toBe('Hazel — GP Link');
    expect(buildSenderDisplayName('  Smith Miller ')).toBe('Smith Miller — GP Link');
  });
  it('falls back to the generic name when empty/null', () => {
    expect(buildSenderDisplayName('')).toBe('GP Link Registration');
    expect(buildSenderDisplayName(null)).toBe('GP Link Registration');
  });
});

describe('resolveSender', () => {
  it('hub OFF → current per-RSO behaviour (RSO mailbox + generic name)', () => {
    expect(resolveSender({ hubEmail: '', rsoEmail: 'hazel@mygplink.com.au', rsoName: 'Hazel', fallback: 'hazel@mygplink.com.au' }))
      .toEqual({ from: 'hazel@mygplink.com.au', fromName: 'GP Link Registration' });
  });
  it('hub OFF + non-mygplink RSO email → fallback mailbox', () => {
    expect(resolveSender({ hubEmail: '', rsoEmail: 'someone@gmail.com', rsoName: 'X', fallback: 'hazel@mygplink.com.au' }))
      .toEqual({ from: 'hazel@mygplink.com.au', fromName: 'GP Link Registration' });
  });
  it('hub ON → hub mailbox + RSO display name', () => {
    expect(resolveSender({ hubEmail: 'registration@mygplink.com.au', rsoEmail: 'hazel@mygplink.com.au', rsoName: 'Hazel', fallback: 'hazel@mygplink.com.au' }))
      .toEqual({ from: 'registration@mygplink.com.au', fromName: 'Hazel — GP Link' });
  });
  it('hub ON + no RSO name → hub mailbox + generic name', () => {
    expect(resolveSender({ hubEmail: 'registration@mygplink.com.au', rsoEmail: '', rsoName: '', fallback: 'hazel@mygplink.com.au' }))
      .toEqual({ from: 'registration@mygplink.com.au', fromName: 'GP Link Registration' });
  });
  it('misconfigured non-mygplink hub email is ignored → never violates the @mygplink.com.au sender rule', () => {
    expect(resolveSender({ hubEmail: 'registration@gmail.com', rsoEmail: 'hazel@mygplink.com.au', rsoName: 'Hazel', fallback: 'hazel@mygplink.com.au' }))
      .toEqual({ from: 'hazel@mygplink.com.au', fromName: 'GP Link Registration' });
  });
});

describe('isHubInbox', () => {
  it('true only for the hub address (case-insensitive) when hub is set', () => {
    expect(isHubInbox('Registration@MyGPLink.com.au', 'registration@mygplink.com.au')).toBe(true);
    expect(isHubInbox('hazel@mygplink.com.au', 'registration@mygplink.com.au')).toBe(false);
  });
  it('false when hub is off', () => {
    expect(isHubInbox('registration@mygplink.com.au', '')).toBe(false);
  });
});

import pkg2 from '../lib/registration-hub.js';
const { buildFromHeader } = pkg2;

describe('buildFromHeader', () => {
  it('uses the provided display name', () => {
    expect(buildFromHeader('Hazel — GP Link', 'registration@mygplink.com.au'))
      .toBe('From: "Hazel — GP Link" <registration@mygplink.com.au>');
  });
  it('defaults to GP Link Registration when no name', () => {
    expect(buildFromHeader('', 'hazel@mygplink.com.au'))
      .toBe('From: "GP Link Registration" <hazel@mygplink.com.au>');
  });
});
