// Phase 6 I1 (audit M2), outbound email template library.
//
// lib/email-templates.js: curated defaults + {{placeholder}} rendering + merge
// with DB override rows. /api/admin/email-templates: read = any admin, manage =
// super admin only. Local-JSON harness idiom from tests/admin-leads.test.js.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DEFAULT_EMAIL_TEMPLATES, renderEmailTemplate, mergeEmailTemplates } from '../lib/email-templates.js';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-email-templates-${RUN_ID}.json`);
const SUPER_HOST = 'tpl-super.local';
const ADMIN_HOST = 'tpl-admin.local';
let server, port;

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function cookieFor(email, role) {
  const payload = b64url(JSON.stringify({ userProfile: { email, adminRole: role }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
const superCookie = () => cookieFor('super@gplink-test.local', 'super_admin');
const adminCookie = () => cookieFor('staff@gplink-test.local', 'admin');

function req(method, p, { cookie, host, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host || SUPER_HOST };
    if (cookie) headers.Cookie = cookie;
    let payload = null;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let json = null; try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'email-templates-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_ALLOWED_HOSTS = ADMIN_HOST;
  process.env.ADMIN_EMAILS = 'staff@gplink-test.local';

  fs.writeFileSync(DB_FILE, JSON.stringify({}));
  const mod = await import('../server.js');
  server = mod.createServer ? mod.createServer() : mod.default.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('email templates, curated defaults + rendering (lib)', () => {
  it('ships a genuinely useful seeded set', () => {
    const keys = DEFAULT_EMAIL_TEMPLATES.map((t) => t.key);
    expect(keys).toEqual(expect.arrayContaining([
      'request_document_gp', 'chase_practice_sppa', 'ahpra_followup',
      'interview_confirmation', 'welcome_next_steps'
    ]));
    DEFAULT_EMAIL_TEMPLATES.forEach((t) => {
      expect(t.name).toBeTruthy();
      expect(t.subject).toBeTruthy();
      expect(t.body).toBeTruthy();
    });
  });

  it('substitutes {{placeholders}} the context provides and leaves the rest visible', () => {
    const tpl = { subject: 'Interview confirmed, {{practiceName}}', body: 'Hi {{firstName}},\n\n{{rsoName}}' };
    const out = renderEmailTemplate(tpl, { firstName: 'Amara', practiceName: 'Sunshine Medical' });
    expect(out.subject).toBe('Interview confirmed, Sunshine Medical');
    expect(out.body).toContain('Hi Amara,');
    // Unknown/empty tokens stay visible so the sender can fill them in.
    expect(out.body).toContain('{{rsoName}}');
  });

  it('merge: DB rows override defaults by key, extras append, inactive hides', () => {
    const rows = [
      { id: 'r1', template_key: 'ahpra_followup', name: 'AHPRA follow-up (custom)', subject: 'S', body: 'B', active: true },
      { id: 'r2', template_key: null, name: 'Zed extra', subject: 'S2', body: 'B2', active: true },
      { id: 'r3', template_key: 'welcome_next_steps', name: '', subject: '', body: '', active: false },
      { id: 'r4', template_key: null, name: 'Inactive custom', subject: '', body: 'x', active: false }
    ];
    const merged = mergeEmailTemplates(DEFAULT_EMAIL_TEMPLATES, rows);
    const byKey = Object.fromEntries(merged.filter((t) => t.key).map((t) => [t.key, t]));
    expect(byKey.ahpra_followup.name).toBe('AHPRA follow-up (custom)');
    expect(byKey.ahpra_followup.source).toBe('custom');
    expect(byKey.welcome_next_steps).toBeUndefined(); // hidden default
    expect(byKey.request_document_gp.source).toBe('default'); // untouched default kept
    expect(merged.some((t) => t.name === 'Zed extra')).toBe(true);
    expect(merged.some((t) => t.name === 'Inactive custom')).toBe(false);
  });
});

describe('GET /api/admin/email-templates', () => {
  it('is auth-gated (401 without a session)', async () => {
    const r = await req('GET', '/api/admin/email-templates');
    expect(r.status).toBe(401);
  });

  it('returns the seeded default set to an admin', async () => {
    const r = await req('GET', '/api/admin/email-templates', { cookie: adminCookie(), host: ADMIN_HOST });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const keys = r.body.templates.map((t) => t.key);
    expect(keys).toEqual(expect.arrayContaining(['request_document_gp', 'chase_practice_sppa', 'ahpra_followup', 'interview_confirmation', 'welcome_next_steps']));
    expect(r.body.templates.every((t) => t.source === 'default')).toBe(true);
  });
});

describe('template management (super admin only)', () => {
  it('a non-super admin cannot add templates (403)', async () => {
    const r = await req('POST', '/api/admin/email-templates', {
      cookie: adminCookie(), host: ADMIN_HOST,
      body: { name: 'Nope', body: 'Nope body' }
    });
    expect(r.status).toBe(403);
  });

  it('the CEO can add a custom template and it shows up in the list', async () => {
    const add = await req('POST', '/api/admin/email-templates', {
      cookie: superCookie(),
      body: { name: 'Visa lodgement heads-up', category: 'visa', stage: 'visa', subject: 'Your visa lodgement', body: 'Hi {{firstName}}, your visa application has been lodged.' }
    });
    expect(add.status).toBe(200);
    expect(add.body.ok).toBe(true);
    expect(add.body.template.id).toBeTruthy();

    const list = await req('GET', '/api/admin/email-templates', { cookie: superCookie() });
    const found = list.body.templates.find((t) => t.name === 'Visa lodgement heads-up');
    expect(found).toBeTruthy();
    expect(found.source).toBe('custom');
  });

  it('rejects a template without name/body', async () => {
    const r = await req('POST', '/api/admin/email-templates', { cookie: superCookie(), body: { name: '   ' } });
    expect(r.status).toBe(400);
  });

  it('the CEO can edit a built-in default by key (override row is created)', async () => {
    const patch = await req('PATCH', '/api/admin/email-templates', {
      cookie: superCookie(),
      body: { key: 'ahpra_followup', subject: 'Custom follow-up subject' }
    });
    expect(patch.status).toBe(200);
    expect(patch.body.template.subject).toBe('Custom follow-up subject');
    // Body was not patched → seeded from the default.
    expect(patch.body.template.body).toContain('follow up on the registration application');

    const list = await req('GET', '/api/admin/email-templates', { cookie: superCookie() });
    const tpl = list.body.templates.find((t) => t.key === 'ahpra_followup');
    expect(tpl.subject).toBe('Custom follow-up subject');
    expect(tpl.source).toBe('custom');
  });

  it('the CEO can hide a default (DELETE by key) without losing the others', async () => {
    const del = await req('DELETE', '/api/admin/email-templates?key=welcome_next_steps', { cookie: superCookie() });
    expect(del.status).toBe(200);
    const list = await req('GET', '/api/admin/email-templates', { cookie: superCookie() });
    const keys = list.body.templates.map((t) => t.key);
    expect(keys).not.toContain('welcome_next_steps');
    expect(keys).toContain('request_document_gp');
  });

  it('PATCH by id updates a custom template', async () => {
    const list = await req('GET', '/api/admin/email-templates', { cookie: superCookie() });
    const custom = list.body.templates.find((t) => t.name === 'Visa lodgement heads-up');
    const patch = await req('PATCH', '/api/admin/email-templates', {
      cookie: superCookie(), body: { id: custom.id, name: 'Visa lodgement update' }
    });
    expect(patch.status).toBe(200);
    const list2 = await req('GET', '/api/admin/email-templates', { cookie: superCookie() });
    expect(list2.body.templates.some((t) => t.name === 'Visa lodgement update')).toBe(true);
  });

  it('management is auth-gated (401 unauthenticated)', async () => {
    const r = await req('POST', '/api/admin/email-templates', { body: { name: 'x', body: 'y' } });
    expect(r.status).toBe(401);
    const d = await req('DELETE', '/api/admin/email-templates?key=ahpra_followup');
    expect(d.status).toBe(401);
  });
});
