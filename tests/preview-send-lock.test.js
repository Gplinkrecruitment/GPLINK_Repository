// WP-00S — preview send lock, pure rules (lib/preview-send-lock.js).
//
// The Vercel preview shares the production database and production sending
// keys. On a preview (VERCEL_ENV set and not "production") nothing may reach
// anyone who is not in NOTIFY_TEST_RECIPIENTS, and an unset list blocks
// everything. Production, localhost and the test runner are untouched.
import { describe, it, expect } from 'vitest';
import lock from '../lib/preview-send-lock.js';
import { createNotifyAllowlist } from '../lib/notify-allowlist.js';

const LIST = 'owner@gplink-test.local, second@gplink-test.local, +61 400 000 111';
const REAL = 'dr.real@realclinic-test.local';

describe('isVercelPreview — VERCEL_ENV only, never NODE_ENV', () => {
  it('is true only when VERCEL_ENV is set and is not production', () => {
    expect(lock.isVercelPreview({ VERCEL_ENV: 'preview' })).toBe(true);
    expect(lock.isVercelPreview({ VERCEL_ENV: ' Preview\n' })).toBe(true);
    expect(lock.isVercelPreview({ VERCEL_ENV: 'development' })).toBe(true);
    expect(lock.isVercelPreview({ VERCEL_ENV: 'production' })).toBe(false);
    expect(lock.isVercelPreview({ VERCEL_ENV: ' PRODUCTION ' })).toBe(false);
    expect(lock.isVercelPreview({ VERCEL_ENV: '' })).toBe(false);
    expect(lock.isVercelPreview({})).toBe(false);
    expect(lock.isVercelPreview(undefined)).toBe(false);
  });
  it('ignores NODE_ENV and VERCEL entirely', () => {
    expect(lock.isVercelPreview({ NODE_ENV: 'production' })).toBe(false);
    expect(lock.isVercelPreview({ NODE_ENV: 'development' })).toBe(false);
    expect(lock.isVercelPreview({ NODE_ENV: 'test' })).toBe(false);
    expect(lock.isVercelPreview({ VERCEL: '1', NODE_ENV: 'production' })).toBe(false);
    expect(lock.isVercelPreview({ VERCEL_ENV: 'preview', NODE_ENV: 'production' })).toBe(true);
  });
  it('is not tied to AU_PATHWAY_ENABLED', () => {
    expect(lock.isVercelPreview({ VERCEL_ENV: 'preview', AU_PATHWAY_ENABLED: 'false' })).toBe(true);
    expect(lock.isVercelPreview({ VERCEL_ENV: 'production', AU_PATHWAY_ENABLED: 'true' })).toBe(false);
  });
});

describe('resolveSendLock — the five environments', () => {
  it('production, list unset: off and unrestricted, as today', () => {
    const l = lock.resolveSendLock({ VERCEL_ENV: 'production', NODE_ENV: 'production' });
    expect(l.preview).toBe(false);
    expect(l.mode).toBe('off');
    expect(l.allowlist.active).toBe(false);
    expect(l.allowlist.permitsEmail(REAL)).toBe(true);
    expect(l.allowlist.permitsPhone('+447700900123')).toBe(true);
    expect(lock.previewSendLockMode({ VERCEL_ENV: 'production' })).toBeNull();
  });
  it('production, list set: the ordinary allow-list, as today', () => {
    const l = lock.resolveSendLock({ VERCEL_ENV: 'production', NOTIFY_TEST_RECIPIENTS: LIST });
    expect(l.preview).toBe(false);
    expect(l.mode).toBe('off');
    expect(l.allowlist.active).toBe(true);
    expect(l.allowlist.permitsEmail('owner@gplink-test.local')).toBe(true);
    expect(l.allowlist.permitsEmail(REAL)).toBe(false);
    // Same verdicts as the module production has always used.
    const plain = createNotifyAllowlist(LIST);
    const body = JSON.stringify({ to: ['owner@gplink-test.local'], cc: [REAL], subject: 'x' });
    expect(l.allowlist.filterBody('email', body)).toEqual(plain.filterBody('email', body));
  });
  it('preview, list unset: block_all', () => {
    for (const env of [{ VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'preview', NOTIFY_TEST_RECIPIENTS: '' }, { VERCEL_ENV: 'preview', NOTIFY_TEST_RECIPIENTS: ' , ;\n' }]) {
      const l = lock.resolveSendLock(env);
      expect(l.preview).toBe(true);
      expect(l.mode).toBe('block_all');
      expect(l.allowlist.active).toBe(true);
      expect(l.allowlist.permitsEmail(REAL)).toBe(false);
      expect(l.allowlist.permitsEmail('owner@gplink-test.local')).toBe(false);
      expect(l.allowlist.permitsPhone('+61400000111')).toBe(false);
      const email = l.allowlist.filterBody('email', JSON.stringify({ to: [REAL], subject: 'x' }));
      expect(email.body).toBeNull();
      expect(email.blocked).toEqual([REAL]);
      expect(l.allowlist.filterBody('whatsapp', JSON.stringify({ to: '+447700900123', body: 'hi' })).body).toBeNull();
      expect(l.allowlist.filterBody('whatsapp', JSON.stringify({ messages: [{ to: '+447700900123' }] })).body).toBeNull();
      expect(lock.previewSendLockMode(env)).toBe('block_all');
    }
  });
  it('preview, list set: allowlist (filter)', () => {
    const env = { VERCEL_ENV: 'preview', NODE_ENV: 'production', NOTIFY_TEST_RECIPIENTS: LIST };
    const l = lock.resolveSendLock(env);
    expect(l.preview).toBe(true);
    expect(l.mode).toBe('allowlist');
    expect(l.allowlist.permitsEmail('Owner@GPLink-Test.local')).toBe(true);
    expect(l.allowlist.permitsEmail(REAL)).toBe(false);
    expect(l.allowlist.permitsPhone('0400000111')).toBe(true);
    expect(l.allowlist.permitsPhone('+447700900123')).toBe(false);
    const v = l.allowlist.filterBody('email', JSON.stringify({ to: ['owner@gplink-test.local', REAL], cc: [REAL], subject: 'x' }));
    expect(JSON.parse(v.body)).toEqual({ to: ['owner@gplink-test.local'], cc: [], subject: 'x' });
    expect(lock.previewSendLockMode(env)).toBe('allowlist');
  });
  it('localhost / test runner, list unset: off and unrestricted, as today', () => {
    for (const env of [{}, { NODE_ENV: 'test' }, { NODE_ENV: 'development' }, { NODE_ENV: 'production' }, { VERCEL_ENV: '' }]) {
      const l = lock.resolveSendLock(env);
      expect(l.preview).toBe(false);
      expect(l.mode).toBe('off');
      expect(l.allowlist.active).toBe(false);
      expect(l.allowlist.permitsEmail(REAL)).toBe(true);
      const body = '{"to":["' + REAL + '"]}';
      expect(l.allowlist.filterBody('email', body).body).toBe(body);
      expect(lock.previewSendLockMode(env)).toBeNull();
    }
  });
  it('re-reads the environment on every call (no stale answer)', () => {
    const env = { VERCEL_ENV: 'preview' };
    expect(lock.resolveSendLock(env).mode).toBe('block_all');
    env.NOTIFY_TEST_RECIPIENTS = LIST;
    expect(lock.resolveSendLock(env).mode).toBe('allowlist');
    env.VERCEL_ENV = 'production';
    expect(lock.resolveSendLock(env).mode).toBe('off');
    delete env.VERCEL_ENV;
    delete env.NOTIFY_TEST_RECIPIENTS;
    expect(lock.resolveSendLock(env).allowlist.active).toBe(false);
  });
  it('createNotifyAllowlist without options is unchanged: empty = inactive', () => {
    expect(createNotifyAllowlist('').active).toBe(false);
    expect(createNotifyAllowlist('', {}).active).toBe(false);
    expect(createNotifyAllowlist('', { failClosed: true }).active).toBe(true);
  });
});

describe('filterEmailRecipients — Gmail API sends', () => {
  const off = lock.resolveSendLock({ VERCEL_ENV: 'production' });
  const offListed = lock.resolveSendLock({ NOTIFY_TEST_RECIPIENTS: LIST });
  const listed = lock.resolveSendLock({ VERCEL_ENV: 'preview', NOTIFY_TEST_RECIPIENTS: LIST });
  const blockAll = lock.resolveSendLock({ VERCEL_ENV: 'preview' });

  it('off a preview nothing is touched, even with a list set', () => {
    for (const l of [off, offListed]) {
      const v = lock.filterEmailRecipients(l, { to: 'Dr Real <' + REAL + '>', cc: REAL });
      expect(v.unchanged).toBe(true);
      expect(v.send).toBe(true);
      expect(v.to).toBe('Dr Real <' + REAL + '>');
      expect(v.cc).toBe(REAL);
      expect(v.blocked).toEqual([]);
    }
  });
  it('preview with a list: mixed to/cc keeps only listed addresses, as bare addresses', () => {
    const v = lock.filterEmailRecipients(listed, {
      to: 'Owner Person <owner@gplink-test.local>, "Real, Dr" <' + REAL + '>',
      cc: [REAL, 'SECOND@gplink-test.local']
    });
    expect(v.unchanged).toBe(false);
    expect(v.send).toBe(true);
    expect(v.to).toBe('owner@gplink-test.local');
    expect(v.cc).toBe('second@gplink-test.local');
    expect(v.allowed).toEqual(['owner@gplink-test.local', 'second@gplink-test.local']);
    expect(v.blocked).toEqual(['"Real, Dr" <' + REAL + '>', REAL]);
  });
  it('preview with a list: no listed "to" means do not send, even if a cc is listed', () => {
    const v = lock.filterEmailRecipients(listed, { to: REAL, cc: 'owner@gplink-test.local' });
    expect(v.send).toBe(false);
  });
  it('preview with no list: nothing survives', () => {
    const v = lock.filterEmailRecipients(blockAll, { to: 'owner@gplink-test.local', cc: REAL });
    expect(v.send).toBe(false);
    expect(v.to).toBe('');
    expect(v.blocked.length).toBe(2);
  });
  it('fails closed on anything it cannot read as one clean address', () => {
    const cases = [
      'owner@gplink-test.local ' + REAL,                       // space-separated pair
      'owner@gplink-test.local; ' + REAL,                      // semicolon-separated pair
      '<owner@gplink-test.local> <' + REAL + '>',              // two angle groups
      'owner@gplink-test.local\r\nBcc: ' + REAL,               // header injection
      'not an address', ''
    ];
    for (const to of cases) {
      const v = lock.filterEmailRecipients(listed, { to });
      expect(v.send, to).toBe(false);
      expect(v.to).toBe('');
    }
  });
  it('a display name that looks like a listed address cannot carry an unlisted one', () => {
    const v = lock.filterEmailRecipients(listed, { to: '"owner@gplink-test.local" <' + REAL + '>' });
    expect(v.send).toBe(false);
  });
});

describe('calendarEventPlan / calendarChangeSendUpdates — Google Calendar', () => {
  const attendees = ['owner@gplink-test.local', REAL];
  it('off a preview: attendees untouched, sendUpdates=all', () => {
    for (const env of [{}, { VERCEL_ENV: 'production' }, { NOTIFY_TEST_RECIPIENTS: LIST }]) {
      const l = lock.resolveSendLock(env);
      const plan = lock.calendarEventPlan(l, attendees);
      expect(plan.attendees).toBe(attendees);
      expect(plan.sendUpdates).toBe('all');
      expect(plan.dropped).toEqual([]);
      expect(lock.calendarChangeSendUpdates(l)).toBe('all');
    }
  });
  it('preview with a list: unlisted attendees dropped and nobody notified', () => {
    const l = lock.resolveSendLock({ VERCEL_ENV: 'preview', NOTIFY_TEST_RECIPIENTS: LIST });
    const plan = lock.calendarEventPlan(l, attendees);
    expect(plan.attendees).toEqual(['owner@gplink-test.local']);
    expect(plan.dropped).toEqual([REAL]);
    expect(plan.sendUpdates).toBe('none');
  });
  it('preview with a list and every attendee listed: invites go out', () => {
    const l = lock.resolveSendLock({ VERCEL_ENV: 'preview', NOTIFY_TEST_RECIPIENTS: LIST });
    const plan = lock.calendarEventPlan(l, ['owner@gplink-test.local', 'second@gplink-test.local']);
    expect(plan.attendees).toEqual(['owner@gplink-test.local', 'second@gplink-test.local']);
    expect(plan.sendUpdates).toBe('all');
  });
  it('preview with no list: no attendees, sendUpdates=none (even for an event with no attendees)', () => {
    const l = lock.resolveSendLock({ VERCEL_ENV: 'preview' });
    expect(lock.calendarEventPlan(l, attendees)).toEqual({ attendees: [], sendUpdates: 'none', dropped: attendees });
    expect(lock.calendarEventPlan(l, []).sendUpdates).toBe('none');
    expect(lock.calendarEventPlan(l, undefined).sendUpdates).toBe('none');
  });
  it('preview never notifies on a delete, list or no list', () => {
    expect(lock.calendarChangeSendUpdates(lock.resolveSendLock({ VERCEL_ENV: 'preview' }))).toBe('none');
    expect(lock.calendarChangeSendUpdates(lock.resolveSendLock({ VERCEL_ENV: 'preview', NOTIFY_TEST_RECIPIENTS: LIST }))).toBe('none');
  });
});

describe('account writes, calls, single-address sends, reporting', () => {
  const prod = lock.resolveSendLock({ VERCEL_ENV: 'production' });
  const local = lock.resolveSendLock({});
  const preview = lock.resolveSendLock({ VERCEL_ENV: 'preview', NOTIFY_TEST_RECIPIENTS: LIST });
  const previewEmpty = lock.resolveSendLock({ VERCEL_ENV: 'preview' });

  it('account writes are skipped on every preview and nowhere else', () => {
    expect(lock.blocksAccountWrites(prod)).toBe(false);
    expect(lock.blocksAccountWrites(local)).toBe(false);
    expect(lock.blocksAccountWrites(preview)).toBe(true);
    expect(lock.blocksAccountWrites(previewEmpty)).toBe(true);
    expect(lock.blocksProductionOnlyReporting(prod)).toBe(false);
    expect(lock.blocksProductionOnlyReporting(local)).toBe(false);
    expect(lock.blocksProductionOnlyReporting(preview)).toBe(true);
  });
  it('calls: a preview rings only the test numbers; an empty test list rings nobody', () => {
    expect(lock.permitsCallTo(prod, '+447700900123', [])).toBe(true);
    expect(lock.permitsCallTo(local, '+447700900123', [])).toBe(true);
    expect(lock.permitsCallTo(preview, '+447700900123', [])).toBe(false);
    expect(lock.permitsCallTo(preview, '+447700900123', ['+61400000999'])).toBe(false);
    expect(lock.permitsCallTo(preview, '+61 400 000 999', ['+61400000999'])).toBe(true);
    expect(lock.permitsCallTo(preview, '', ['+61400000999'])).toBe(false);
    // NOTIFY_TEST_RECIPIENTS is not a calling list.
    expect(lock.permitsCallTo(preview, '+61400000111', [])).toBe(false);
  });
  it('single-address sends through a third party (Calendly bookings)', () => {
    expect(lock.permitsEmailTo(prod, REAL)).toBe(true);
    expect(lock.permitsEmailTo(local, REAL)).toBe(true);
    expect(lock.permitsEmailTo(preview, REAL)).toBe(false);
    expect(lock.permitsEmailTo(preview, 'owner@gplink-test.local')).toBe(true);
    expect(lock.permitsEmailTo(previewEmpty, 'owner@gplink-test.local')).toBe(false);
    expect(lock.permitsEmailTo(preview, '')).toBe(false);
  });
});

describe('mask — what reaches the logs', () => {
  it('never prints a full address, number or display name', () => {
    expect(lock.mask('Dr Real Person <' + REAL + '>')).toBe('dr…@realclinic-test.local');
    expect(lock.mask(REAL)).toBe('dr…@realclinic-test.local');
    expect(lock.mask('+447700900123')).toBe('+44…123');
    expect(lock.mask('')).toBe('(empty)');
    expect(lock.mask(undefined)).toBe('(empty)');
  });
});

describe('describeSendLock — the startup line', () => {
  it('says nothing off a preview', () => {
    expect(lock.describeSendLock(lock.resolveSendLock({}))).toBe('');
    expect(lock.describeSendLock(lock.resolveSendLock({ VERCEL_ENV: 'production', NOTIFY_TEST_RECIPIENTS: LIST }))).toBe('');
  });
  it('names the mode on a preview and never prints an address', () => {
    const on = lock.describeSendLock(lock.resolveSendLock({ VERCEL_ENV: 'preview', NOTIFY_TEST_RECIPIENTS: LIST }));
    expect(on).toContain('preview send lock ACTIVE: 3 allow-listed recipients');
    expect(on).not.toContain('owner@');
    const all = lock.describeSendLock(lock.resolveSendLock({ VERCEL_ENV: 'preview' }));
    expect(all).toContain('preview send lock ACTIVE: blocking ALL outbound email/WhatsApp (NOTIFY_TEST_RECIPIENTS not set)');
  });
});
