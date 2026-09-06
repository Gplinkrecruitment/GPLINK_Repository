// Test-recipient allowlist (owner 2026-09-07): with NOTIFY_TEST_RECIPIENTS set,
// outbound email (Resend) and WhatsApp (DoubleTick) may only reach the listed
// recipients. Localhost carries production keys against the production DB, so
// without this every test action could message a real doctor or practice.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createNotifyAllowlist, maskRecipient } from '../lib/notify-allowlist.js';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('lib/notify-allowlist — pure rules', () => {
  const list = createNotifyAllowlist('Smith@Example.com, hello@mygplink.com.au, +61 406 000 111;0400222333');

  it('parses emails case-insensitively and phones by significant digits', () => {
    expect(list.active).toBe(true);
    expect(list.size).toBe(4);
    expect(list.permitsEmail('smith@example.com')).toBe(true);
    expect(list.permitsEmail('GP Link <HELLO@mygplink.com.au>')).toBe(true);
    expect(list.permitsEmail('someone@else.com')).toBe(false);
    expect(list.permitsPhone('+61406000111')).toBe(true);
    expect(list.permitsPhone('0406000111')).toBe(true);     // local form of the same number
    expect(list.permitsPhone('+61400222333')).toBe(true);   // E.164 form of a local entry
    expect(list.permitsPhone('+61499999999')).toBe(false);
    expect(list.permitsPhone('')).toBe(false);
  });

  it('is inactive (permits everything) when the env var is empty', () => {
    const off = createNotifyAllowlist('');
    expect(off.active).toBe(false);
    expect(off.permitsEmail('anyone@anywhere.com')).toBe(true);
    expect(off.permitsPhone('+61499999999')).toBe(true);
    const v = off.filterBody('email', '{"to":["anyone@anywhere.com"]}');
    expect(v.body).toBe('{"to":["anyone@anywhere.com"]}');
    expect(v.blocked).toEqual([]);
  });

  it('email: drops blocked cc/bcc but sends, and blocks outright when no permitted "to" is left', () => {
    const partial = list.filterBody('email', JSON.stringify({ to: ['smith@example.com'], cc: ['boss@else.com'], bcc: [], subject: 'x' }));
    expect(JSON.parse(partial.body)).toEqual({ to: ['smith@example.com'], cc: [], bcc: [], subject: 'x' });
    expect(partial.blocked).toEqual(['boss@else.com']);
    const blocked = list.filterBody('email', JSON.stringify({ to: 'dr@realclinic.com.au', subject: 'x' }));
    expect(blocked.body).toBeNull();
    expect(blocked.blocked).toEqual(['dr@realclinic.com.au']);
  });

  it('whatsapp: text {to} and template {messages:[{to}]} shapes', () => {
    expect(list.filterBody('whatsapp', JSON.stringify({ to: '+61406000111', body: 'hi' })).body).toContain('"to":"+61406000111"');
    expect(list.filterBody('whatsapp', JSON.stringify({ to: '+61499999999', body: 'hi' })).body).toBeNull();
    const tpl = list.filterBody('whatsapp', JSON.stringify({ messages: [{ to: '+61499999999', from: 'x' }, { to: '0406000111', from: 'x' }] }));
    expect(JSON.parse(tpl.body).messages).toEqual([{ to: '0406000111', from: 'x' }]);
    expect(tpl.blocked).toEqual(['+61499999999']);
  });

  it('fails closed on a body whose recipients cannot be read', () => {
    expect(list.filterBody('whatsapp', 'not json').body).toBeNull();
    expect(list.filterBody('whatsapp', JSON.stringify({ template: 'x' })).body).toBeNull();
    expect(list.filterBody('email', JSON.stringify({ subject: 'no recipients' })).body).toBeNull();
  });

  it('never logs a full address or number', () => {
    expect(maskRecipient('smithmiller1234@gmail.com')).toBe('sm…@gmail.com');
    expect(maskRecipient('+61406000111')).toBe('+61…111');
    expect(maskRecipient('')).toBe('(empty)');
  });
});

describe('server.js — every message send goes through the guard', () => {
  const server = read('server.js');
  it('builds one allowlist from NOTIFY_TEST_RECIPIENTS and warns at boot', () => {
    expect(server).toContain("require('./lib/notify-allowlist.js').createNotifyAllowlist(process.env.NOTIFY_TEST_RECIPIENTS)");
    expect(server).toContain("console.warn('[notify-allowlist] ACTIVE");
    expect(server).toContain('async function guardedNotifyFetch(kind, url, init) {');
    // Resolves the global fetch at call time (test stubs replace globalThis.fetch).
    expect(server).toContain('if (!notifyAllowlist.active) return fetch(url, init);');
    expect(server).toContain("error: 'blocked_by_test_allowlist'");
  });
  it('routes Resend and every DoubleTick message call through it — no raw sends remain', () => {
    expect(server).toContain("guardedNotifyFetch('email', RESEND_API_URL, {");
    expect(server.split("guardedNotifyFetch('whatsapp', DOUBLETICK_BASE_URL + '/whatsapp/message/template', {").length - 1).toBe(3);
    expect(server.split("guardedNotifyFetch('whatsapp', DOUBLETICK_BASE_URL + '/whatsapp/message/text', doubleTickTextRequest(").length - 1).toBe(7);
    expect(server).toContain("guardedNotifyFetch('whatsapp', fullUrl, {");
    expect(server).toContain("guardedNotifyFetch('whatsapp', DOUBLETICK_BASE_URL + path, init)"); // match-accepted sender
    expect(server).not.toMatch(/[^a-zA-Z]fetch\(DOUBLETICK_BASE_URL \+ '\/whatsapp\/message/);
    expect(server).not.toMatch(/[^a-zA-Z]fetch\(RESEND_API_URL/);
  });
  it('documents the env var', () => {
    expect(read('.env.example')).toContain('NOTIFY_TEST_RECIPIENTS=');
  });
});
