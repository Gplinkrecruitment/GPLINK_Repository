// Practice-submission WhatsApp (DoubleTick) — lib/practice-submission-whatsapp.js
// + the sendConsultWhatsAppTemplate buttons passthrough it relies on. The
// template message rides the admin submit-to-practice action next to the
// introduction email and carries the SAME practice_action_token decision link
// as the template's URL button. Boots the real server in LOCAL-JSON mode with
// a stub DoubleTick server wired via env BEFORE import (same harness as
// tests/consult-whatsapp-followups.test.js).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import { createRequire } from 'module';

const requireCjs = createRequire(import.meta.url);
const waLib = requireCjs('../lib/practice-submission-whatsapp.js');

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-practice-wa-${RUN_ID}.json`;
let testUtils;
let dtServer;
let dtPort;
const dtCaptured = [];

beforeAll(async () => {
  dtServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* leave null */ }
      dtCaptured.push({ path: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages: [{ id: 'dt-' + dtCaptured.length }] }));
    });
  });
  await new Promise((resolve) => dtServer.listen(0, '127.0.0.1', resolve));
  dtPort = dtServer.address().port;

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'test-practice-wa-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.DB_FILE_PATH = DB_FILE;
  // Module-level consts in server.js — must exist before import.
  process.env.DOUBLETICK_API_KEY = 'test-dt-key';
  process.env.DOUBLETICK_BASE_URL = 'http://127.0.0.1:' + dtPort;

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
});

afterAll(async () => {
  if (dtServer) await new Promise((resolve) => dtServer.close(resolve));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

describe('lib/practice-submission-whatsapp pure logic', () => {
  const base = {
    contactName: 'Dr Chris Ifediora',
    practiceName: 'PKG Medical Centre',
    introParagraph: 'Dr Deepika Ganesh is an internationally trained GP from the United Kingdom, coming to Australia via the Expedited Specialist Pathway. Dr Ganesh is hoping to commence work by January 2027, with GP Link managing the registration process end-to-end.',
    actionToken: '11NG0ydN9LrVbBPcO0eLr45SloE254N8'
  };

  it('builds the three body placeholders and the token as the URL button parameter', () => {
    const msg = waLib.buildPracticeSubmissionWaMessage(base);
    expect(msg.templateName).toBe('gp_link_practice_candidate_intro');
    expect(msg.language).toBe('en');
    expect(msg.placeholders).toEqual([
      'Dr Chris Ifediora',
      'PKG Medical Centre',
      base.introParagraph
    ]);
    expect(msg.buttons).toEqual([{ type: 'URL', parameter: base.actionToken }]);
  });

  it('greets the practice team when there is no named contact', () => {
    const msg = waLib.buildPracticeSubmissionWaMessage({ ...base, contactName: '' });
    expect(msg.placeholders[0]).toBe('PKG Medical Centre team');
  });

  it('collapses whitespace WhatsApp refuses (newlines, tabs, space runs) and caps the summary', () => {
    const messy = 'Line one.\n\nLine two\twith    lots     of space.';
    const msg = waLib.buildPracticeSubmissionWaMessage({ ...base, introParagraph: messy });
    expect(msg.placeholders[2]).toBe('Line one. Line two with lots of space.');
    const long = 'word '.repeat(200);
    const capped = waLib.buildPracticeSubmissionWaMessage({ ...base, introParagraph: long });
    expect(capped.placeholders[2].length).toBeLessThanOrEqual(551);
    expect(/\s{2,}/.test(capped.placeholders[2])).toBe(false);
  });

  it('falls back to a generic summary when the intro paragraph is empty', () => {
    const msg = waLib.buildPracticeSubmissionWaMessage({ ...base, introParagraph: '' });
    expect(msg.placeholders[2].length).toBeGreaterThan(10);
  });

  it('refuses to build without a practice name or with a token that would mangle the URL', () => {
    expect(waLib.buildPracticeSubmissionWaMessage({ ...base, practiceName: '' })).toBe(null);
    expect(waLib.buildPracticeSubmissionWaMessage({ ...base, actionToken: '' })).toBe(null);
    expect(waLib.buildPracticeSubmissionWaMessage({ ...base, actionToken: 'has space' })).toBe(null);
    expect(waLib.buildPracticeSubmissionWaMessage({ ...base, actionToken: 'a&b=c' })).toBe(null);
  });
});

describe('sendConsultWhatsAppTemplate buttons passthrough', () => {
  it('forwards button parameters into templateData.buttons', async () => {
    dtCaptured.length = 0;
    const msg = waLib.buildPracticeSubmissionWaMessage({
      contactName: 'Dr Chris Ifediora',
      practiceName: 'PKG Medical Centre',
      introParagraph: 'An internationally trained GP.',
      actionToken: 'tok123'
    });
    const sent = await testUtils.sendConsultWhatsAppTemplate('+61458183994', msg);
    expect(sent.ok).toBe(true);
    const captured = dtCaptured.filter((c) => c.path === '/whatsapp/message/template');
    expect(captured.length).toBe(1);
    const content = captured[0].body.messages[0].content;
    expect(content.templateName).toBe('gp_link_practice_candidate_intro');
    expect(content.templateData.body.placeholders.length).toBe(3);
    expect(content.templateData.buttons).toEqual([{ type: 'URL', parameter: 'tok123' }]);
  });

  it('omits the buttons key entirely for button-less templates', async () => {
    dtCaptured.length = 0;
    const sent = await testUtils.sendConsultWhatsAppTemplate('+61458183994', {
      templateName: 'gp_link_consult_signup_welcome',
      language: 'en',
      placeholders: ['Louise']
    });
    expect(sent.ok).toBe(true);
    const captured = dtCaptured.filter((c) => c.path === '/whatsapp/message/template');
    expect(captured.length).toBe(1);
    const content = captured[0].body.messages[0].content;
    expect(Object.prototype.hasOwnProperty.call(content.templateData, 'buttons')).toBe(false);
  });
});
