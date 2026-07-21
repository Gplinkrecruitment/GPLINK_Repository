// Phase 6 Batch K1, server-side per-country document requirements.
//
// lib/document-requirements.js is the single source of truth for the uk/ie/nz
// document checklists that pages/my-documents.html renders (previously the
// lists lived only in that page's client JS, and an unknown country silently
// fell back to the UK list). GET /api/gp/document-requirements serves the
// config; unknown countries get an EXPLICIT unsupported response.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const docReq = require('../lib/document-requirements.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = crypto.randomBytes(4).toString('hex');
let server;
let port;

const GP = `doc-req-${RUN_ID}@example.com`;

// The document types each country showed in the OLD client-only COUNTRY_DOCS
// lists in pages/my-documents.html, the server config must not drop any of
// them, and must keep the order.
const EXPECTED = {
  uk: {
    label: 'United Kingdom',
    institution: ['certificate_good_standing', 'confirmation_training', 'criminal_history'],
    prepared: ['primary_medical_degree', 'mrcgp_certified', 'cct_certified', 'cv_signed_dated']
  },
  ie: {
    label: 'Ireland',
    institution: ['certificate_good_standing', 'criminal_history'],
    prepared: ['primary_medical_degree', 'micgp_certified', 'cscst_certified', 'icgp_confirmation_letter', 'cv_signed_dated']
  },
  nz: {
    label: 'New Zealand',
    institution: ['certificate_good_standing', 'criminal_history'],
    prepared: ['primary_medical_degree', 'frnzcgp_certified', 'rnzcgp_confirmation_letter', 'cv_signed_dated']
  }
};

function b64url(s) {
  return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function userCookie(email) {
  const payload = b64url(JSON.stringify({ userProfile: { email }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}

function request(method, p, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'doc-req-test-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-doc-req-${RUN_ID}.json`;

  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch {}
});

describe('lib/document-requirements.js, faithful reconciliation of the old client lists', () => {
  for (const country of Object.keys(EXPECTED)) {
    it(`${country}: keeps every doc type in the original order (none dropped)`, () => {
      const cfg = docReq.DOCUMENT_REQUIREMENTS[country];
      expect(cfg).toBeTruthy();
      expect(cfg.label).toBe(EXPECTED[country].label);
      expect(cfg.institution.map((d) => d.key)).toEqual(EXPECTED[country].institution);
      expect(cfg.prepared.map((d) => d.key)).toEqual(EXPECTED[country].prepared);
    });

    it(`${country}: every item carries a title and help steps (page can render "Show me how")`, () => {
      const cfg = docReq.DOCUMENT_REQUIREMENTS[country];
      [...cfg.institution, ...cfg.prepared].forEach((d) => {
        expect(typeof d.title).toBe('string');
        expect(d.title.length).toBeGreaterThan(0);
        expect(Array.isArray(d.help && d.help.steps)).toBe(true);
        expect(d.help.steps.length).toBeGreaterThan(0);
      });
      cfg.institution.forEach((d) => expect(d.actionLabel).toBe('Mark Requested'));
    });
  }

  it('carries the Fit2Work ICHC upload wording + sample link (the transform the page used to apply)', () => {
    for (const country of Object.keys(EXPECTED)) {
      const crim = docReq.DOCUMENT_REQUIREMENTS[country].institution.find((d) => d.key === 'criminal_history');
      expect(crim.help.steps.join(' ')).toContain('fit2work-ichc-example.pdf');
      expect(crim.help.steps.join(' ')).not.toContain('Enter this reference number below');
    }
  });

  it('normalizes aliases but NEVER maps an unknown country to UK', () => {
    expect(docReq.normalizeRequirementCountry('GB')).toBe('uk');
    expect(docReq.normalizeRequirementCountry('United Kingdom')).toBe('uk');
    expect(docReq.normalizeRequirementCountry('Ireland')).toBe('ie');
    expect(docReq.normalizeRequirementCountry('new zealand')).toBe('nz');
    expect(docReq.normalizeRequirementCountry('fr')).toBe('');
    expect(docReq.normalizeRequirementCountry('australia')).toBe('');
    expect(docReq.getDocumentRequirements('fr')).toBeNull();
  });
});

describe('GET /api/gp/document-requirements', () => {
  it('requires a GP session', async () => {
    const res = await request('GET', '/api/gp/document-requirements?country=uk');
    expect(res.status).toBe(401);
  });

  for (const country of Object.keys(EXPECTED)) {
    it(`returns the ${country} list for ?country=${country}`, async () => {
      const res = await request('GET', `/api/gp/document-requirements?country=${country}`, { cookie: userCookie(GP) });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.country).toBe(country);
      expect(res.body.requirements.label).toBe(EXPECTED[country].label);
      expect(res.body.requirements.institution.map((d) => d.key)).toEqual(EXPECTED[country].institution);
      expect(res.body.requirements.prepared.map((d) => d.key)).toEqual(EXPECTED[country].prepared);
    });
  }

  it('accepts country aliases (gb → uk)', async () => {
    const res = await request('GET', '/api/gp/document-requirements?country=gb', { cookie: userCookie(GP) });
    expect(res.status).toBe(200);
    expect(res.body.country).toBe('uk');
  });

  it('an UNKNOWN country gets an explicit unsupported response, not a silent UK list', async () => {
    const res = await request('GET', '/api/gp/document-requirements?country=fr', { cookie: userCookie(GP) });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.unsupported).toBe(true);
    expect(res.body.requirements).toBeUndefined();
    expect(res.body.supported).toEqual(['uk', 'ie', 'nz']);
  });

  it('a GP with NO resolvable country also gets explicit unsupported (no param, empty profile)', async () => {
    const res = await request('GET', '/api/gp/document-requirements', { cookie: userCookie(GP) });
    expect(res.status).toBe(400);
    expect(res.body.unsupported).toBe(true);
  });

  it('with no ?country=, resolves the GP\'s own stored country (gp_selected_country)', async () => {
    const cookie = userCookie(GP);
    const put = await request('PUT', '/api/state', {
      cookie,
      body: { state: { gp_selected_country: JSON.stringify('New Zealand') } }
    });
    expect(put.status).toBe(200);
    const res = await request('GET', '/api/gp/document-requirements', { cookie });
    expect(res.status).toBe(200);
    expect(res.body.country).toBe('nz');
    expect(res.body.requirements.prepared.map((d) => d.key)).toEqual(EXPECTED.nz.prepared);
  });
});

describe('pages/my-documents.html, consumes the server config with a graceful fallback (static)', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'pages', 'my-documents.html'), 'utf8');

  it('fetches the server endpoint on load and after hydration', () => {
    expect(page).toContain('/api/gp/document-requirements');
    expect(page).toMatch(/function loadServerDocRequirements/);
    expect((page.match(/loadServerDocRequirements\(\)/g) || []).length).toBeGreaterThanOrEqual(3); // definition + boot + hydration
  });

  it('keeps a minimal embedded fallback covering every doc type of every country', () => {
    expect(page).toContain('FALLBACK_COUNTRY_DOCS');
    const allKeys = new Set(Object.values(EXPECTED).flatMap((c) => [...c.institution, ...c.prepared]));
    for (const key of allKeys) {
      expect(page).toContain(`"${key}"`);
    }
  });

  it('no longer embeds the full lists as the source of truth (old const COUNTRY_DOCS gone)', () => {
    expect(page).not.toContain('const COUNTRY_DOCS = {');
    expect(page).toContain('let COUNTRY_DOCS = FALLBACK_COUNTRY_DOCS');
  });
});
