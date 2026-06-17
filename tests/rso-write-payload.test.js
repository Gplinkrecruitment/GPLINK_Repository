import { describe, it, expect } from 'vitest';

const { buildRsoWritePayload } = require('../server-test-helpers.js');

describe('buildRsoWritePayload', () => {

  describe('create mode', () => {
    it('builds a full happy-path payload (email lowercased+trimmed, defaults applied, updated_at from nowIso)', () => {
      const out = buildRsoWritePayload({
        name: '  Jane RSO  ',
        email: '  Jane.RSO@Example.COM ',
        userId: 'u-123',
        nowIso: '2026-06-18T00:00:00.000Z'
      }, { mode: 'create' });
      expect(out.valid).toBe(true);
      expect(out.errors).toEqual([]);
      expect(out.payload.name).toBe('Jane RSO');
      expect(out.payload.email).toBe('jane.rso@example.com');
      expect(out.payload.user_id).toBe('u-123');
      expect(out.payload.active).toBe(true); // default when omitted
      expect(out.payload.phone).toBe(''); // default when omitted
      expect(out.payload.calendly_event_url).toBe(null); // null when blank
      expect(out.payload.updated_at).toBe('2026-06-18T00:00:00.000Z');
      expect('created_at' in out.payload).toBe(false); // DB defaults it
    });

    it('errors when name is missing', () => {
      const out = buildRsoWritePayload({ email: 'a@b.com', userId: 'u1' }, { mode: 'create' });
      expect(out.valid).toBe(false);
      expect(out.errors).toContain('Name is required.');
    });

    it('errors when email is missing', () => {
      const out = buildRsoWritePayload({ name: 'A', userId: 'u1' }, { mode: 'create' });
      expect(out.valid).toBe(false);
      expect(out.errors).toContain('Email is required.');
    });

    it('errors when email is invalid', () => {
      const out = buildRsoWritePayload({ name: 'A', email: 'not-an-email', userId: 'u1' }, { mode: 'create' });
      expect(out.valid).toBe(false);
      expect(out.errors).toContain('Email is not a valid email address.');
    });

    it('errors when user_id is missing', () => {
      const out = buildRsoWritePayload({ name: 'A', email: 'a@b.com' }, { mode: 'create' });
      expect(out.valid).toBe(false);
      expect(out.errors).toContain('user_id is required.');
    });

    it('errors when calendly link does not start with https://calendly.com/', () => {
      const out = buildRsoWritePayload({
        name: 'A', email: 'a@b.com', userId: 'u1',
        calendlyEventUrl: 'https://evil.com/jane'
      }, { mode: 'create' });
      expect(out.valid).toBe(false);
      expect(out.errors).toContain('Calendly link must start with https://calendly.com/');
    });

    it('keeps a valid calendly link', () => {
      const out = buildRsoWritePayload({
        name: 'A', email: 'a@b.com', userId: 'u1',
        calendlyEventUrl: 'https://calendly.com/jane/30min'
      }, { mode: 'create' });
      expect(out.valid).toBe(true);
      expect(out.payload.calendly_event_url).toBe('https://calendly.com/jane/30min');
    });

    it('accepts the snake_case user_id alias', () => {
      const out = buildRsoWritePayload({ name: 'A', email: 'a@b.com', user_id: 'snake-1' }, { mode: 'create' });
      expect(out.valid).toBe(true);
      expect(out.payload.user_id).toBe('snake-1');
    });

    it('accepts the snake_case calendly_event_url alias', () => {
      const out = buildRsoWritePayload({
        name: 'A', email: 'a@b.com', userId: 'u1',
        calendly_event_url: 'https://calendly.com/jane'
      }, { mode: 'create' });
      expect(out.valid).toBe(true);
      expect(out.payload.calendly_event_url).toBe('https://calendly.com/jane');
    });
  });

  describe('update mode (partial)', () => {
    it('includes only supplied fields plus updated_at, with no user_id or name', () => {
      const out = buildRsoWritePayload({
        calendlyEventUrl: 'https://calendly.com/jane',
        active: true,
        nowIso: '2026-06-18T01:00:00.000Z'
      }, { mode: 'update' });
      expect(out.valid).toBe(true);
      expect('user_id' in out.payload).toBe(false);
      expect('name' in out.payload).toBe(false);
      expect('email' in out.payload).toBe(false);
      expect('phone' in out.payload).toBe(false);
      expect(out.payload.calendly_event_url).toBe('https://calendly.com/jane');
      expect(out.payload.active).toBe(true);
      expect(out.payload.updated_at).toBe('2026-06-18T01:00:00.000Z');
    });

    it('errors on an invalid calendly link in update mode', () => {
      const out = buildRsoWritePayload({ calendlyEventUrl: 'http://calendly.com/x' }, { mode: 'update' });
      expect(out.valid).toBe(false);
      expect(out.errors).toContain('Calendly link must start with https://calendly.com/');
    });

    it('allows clearing a calendly link to null when blank', () => {
      const out = buildRsoWritePayload({ calendlyEventUrl: '' }, { mode: 'update' });
      expect(out.valid).toBe(true);
      expect(out.payload.calendly_event_url).toBe(null);
    });

    it('errors on an invalid email when email is supplied in update mode', () => {
      const out = buildRsoWritePayload({ email: 'bad' }, { mode: 'update' });
      expect(out.valid).toBe(false);
      expect(out.errors).toContain('Email is not a valid email address.');
    });

    it('does NOT require name/email/user_id in update mode', () => {
      const out = buildRsoWritePayload({ phone: '+61400000000' }, { mode: 'update' });
      expect(out.valid).toBe(true);
      expect(out.payload.phone).toBe('+61400000000');
      expect('name' in out.payload).toBe(false);
      expect('email' in out.payload).toBe(false);
      expect('user_id' in out.payload).toBe(false);
    });
  });

  describe('active coercion', () => {
    it('coerces active:0 to false', () => {
      const out = buildRsoWritePayload({ active: 0 }, { mode: 'update' });
      expect(out.payload.active).toBe(false);
    });

    it("coerces active:'yes' to true", () => {
      const out = buildRsoWritePayload({ active: 'yes' }, { mode: 'update' });
      expect(out.payload.active).toBe(true);
    });
  });
});
