// Tests for support-ticket display names + grouping helpers (reported 2026-07-09).
//
// Two behaviours were requested:
//   1. Group a person's same-channel support messages into ONE ticket within a
//      sliding 24h window; a different channel is a separate ticket.
//   2. The GP column must never say "Unknown": a known in-app GP shows their
//      name; an external sender (not on the app) shows "EXTERNAL (Not on App)".
//
// The DB-touching grouping/name-resolution code paths call these pure helpers,
// exported via server.js __testUtils, so the decision logic is locked in here.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { __testUtils } = require('../server.js');
const {
  supportDisplayName,
  isWithinGroupingWindow,
  extractEmailAddress,
  phoneFromSupportItem,
  contactNameFromSupportItem,
  EXTERNAL_SUPPORT_LABEL,
  SUPPORT_GROUP_WINDOW_MS,
} = __testUtils;

describe('supportDisplayName, no more "Unknown"', () => {
  it('shows a known GP their full name', () => {
    expect(supportDisplayName({ first_name: 'Smith', last_name: 'Miller' }))
      .toEqual({ name: 'Smith Miller', isExternal: false });
  });

  it('marks a sender with no matching profile as EXTERNAL (Not on App)', () => {
    expect(supportDisplayName({})).toEqual({ name: EXTERNAL_SUPPORT_LABEL, isExternal: true });
    expect(supportDisplayName(null)).toEqual({ name: EXTERNAL_SUPPORT_LABEL, isExternal: true });
  });

  it('never returns the literal string "Unknown"', () => {
    expect(supportDisplayName({}).name).not.toBe('Unknown');
    expect(supportDisplayName({ email: 'x@y.com' }).name).not.toBe('Unknown');
  });

  it('falls back to email (not EXTERNAL) for in-app tickets, which are always registered users', () => {
    expect(supportDisplayName({ email: 'gp@example.com' }, { allowEmailFallback: true }))
      .toEqual({ name: 'gp@example.com', isExternal: false });
  });

  it('does NOT use the email fallback for the merged endpoint (genuine externals possible)', () => {
    // No opts → external senders must be labelled, not shown by email.
    expect(supportDisplayName({ email: 'random@stranger.com' }))
      .toEqual({ name: EXTERNAL_SUPPORT_LABEL, isExternal: true });
  });

  it('prefers the real name even when an email is present', () => {
    expect(supportDisplayName({ first_name: 'Helen', last_name: 'Wazalski', email: 'h@x.com' }, { allowEmailFallback: true }))
      .toEqual({ name: 'Helen Wazalski', isExternal: false });
  });
});

describe('isWithinGroupingWindow, sliding 24h', () => {
  const now = 1_800_000_000_000; // fixed epoch ms

  it('groups a message that arrives inside the window', () => {
    expect(isWithinGroupingWindow(now - 1000, now, SUPPORT_GROUP_WINDOW_MS)).toBe(true);
    expect(isWithinGroupingWindow(now - (SUPPORT_GROUP_WINDOW_MS - 1), now, SUPPORT_GROUP_WINDOW_MS)).toBe(true);
  });

  it('starts a fresh ticket once the window has elapsed (24h+ of silence)', () => {
    expect(isWithinGroupingWindow(now - (SUPPORT_GROUP_WINDOW_MS + 1), now, SUPPORT_GROUP_WINDOW_MS)).toBe(false);
  });

  it('exactly at the window boundary still groups (<=)', () => {
    expect(isWithinGroupingWindow(now - SUPPORT_GROUP_WINDOW_MS, now, SUPPORT_GROUP_WINDOW_MS)).toBe(true);
  });

  it('defaults to the 24h window when none is passed', () => {
    expect(SUPPORT_GROUP_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(isWithinGroupingWindow(now - 1000, now)).toBe(true);
    expect(isWithinGroupingWindow(now - (25 * 60 * 60 * 1000), now)).toBe(false);
  });

  it('does not group when a timestamp is missing (no accidental fold)', () => {
    expect(isWithinGroupingWindow(0, now, SUPPORT_GROUP_WINDOW_MS)).toBe(false);
    expect(isWithinGroupingWindow(now, 0, SUPPORT_GROUP_WINDOW_MS)).toBe(false);
  });
});

describe('identity extraction for grouping + naming', () => {
  it('extracts a bare, lower-cased address from a display-name sender', () => {
    expect(extractEmailAddress('Nohier Jackman <Nohier@Gmail.com>')).toBe('nohier@gmail.com');
    expect(extractEmailAddress('plain@address.com')).toBe('plain@address.com');
    expect(extractEmailAddress('')).toBe('');
    expect(extractEmailAddress(null)).toBe('');
  });

  it('reads the phone from an unregistered WhatsApp task body "Name (+phone)"', () => {
    expect(phoneFromSupportItem({ body: 'Nohier Jackman (+61406281243)\n\nHi there' }, null))
      .toBe('+61406281243');
  });

  it('prefers a registered GP profile phone over the body', () => {
    expect(phoneFromSupportItem({ body: 'x (+61999999999)' }, { phone_number: '+61406281243' }))
      .toBe('+61406281243');
  });

  it('returns empty string when no phone is present', () => {
    expect(phoneFromSupportItem({ body: 'just a message, no number' }, null)).toBe('');
    expect(phoneFromSupportItem({}, {})).toBe('');
  });

  it('reads the contact name from a WhatsApp task body / title', () => {
    expect(contactNameFromSupportItem({ body: 'Smith Miller (61494565783)\n\nNeeding some help' }))
      .toBe('Smith Miller');
    expect(contactNameFromSupportItem({ body: '', title: 'WhatsApp enquiry from Nohier Jackman' }))
      .toBe('Nohier Jackman');
    expect(contactNameFromSupportItem({ body: 'no name here', title: 'GP requested WhatsApp help, AMC' }))
      .toBe('');
  });
});
