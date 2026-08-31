// The AI contract scan (split %, relocation package, contract length) used to run
// from resolveCareerContractTerms, which pulled the contract out of a ZOHO
// attachment. That orchestrator was deleted with the rest of the Zoho machinery on
// 2026-07-06 (3f96a6f) — but the extractors survived the cut with ZERO call sites,
// and the placement view kept reading a `career_contract_extract:` cache that
// nothing writes any more. Its own comment said the extraction "is no longer
// produced". So every GP placed after that date showed Split/Relocation as
// "Pending" for ever: Dr Sana Ahsan's contract was filed 2026-07-09, three days
// later. Only the supply line broke — this pins the extractors being fed from
// where contracts actually live now, the GP's offer_contract in Supabase Storage.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const BUCKET = 'gp-link-documents';
let sbServer, sbPort, resolveTerms;

const UID = 'u-contract-' + RUN_ID;
const APP_ID = 'zoho-app-' + RUN_ID;
const STORAGE_PATH = 'users/' + UID + '/offer-documents/offer_contract/current';

// A text contract the heuristic can read on its own, so the test needs no API key.
const CONTRACT_TEXT = [
  'INDEPENDENT CONTRACTOR AGREEMENT',
  'The Service Provider retains 35% + GST of billings; the Independent Doctor receives 65%.',
  'A relocation package of $10,000 is payable to the Doctor.',
  'The term of this agreement is 3 years from the commencement date.'
].join('\n');

let db;
const storage = new Map();

function freshDb() {
  return {
    user_documents: [{
      id: 'ud-contract', user_id: UID, document_key: 'offer_contract', country_code: 'uk',
      status: 'approved', file_name: 'Contract.txt', mime_type: 'text/plain',
      storage_path: STORAGE_PATH, file_url: STORAGE_PATH,
      updated_at: '2026-08-01T00:00:00.000Z'
    }],
    runtime_kv: []
  };
}
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }
function buildMatcher(params) {
  const filters = [];
  for (const [k, v] of params.entries()) {
    if (['select', 'limit', 'order', 'on_conflict'].includes(k)) continue;
    const mm = /^(eq|neq)\.(.*)$/s.exec(v);
    if (mm) filters.push({ col: k, op: mm[1], val: mm[2] });
  }
  return (row) => filters.every((f) => {
    const eq = String(row ? row[f.col] : undefined) === String(f.val);
    return f.op === 'eq' ? eq : !eq;
  });
}

function startEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const sendJson = (s, p) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(p)); };
      const readBody = () => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });

      const sm = u.pathname.match(/^\/storage\/v1\/object\/(.+)$/);
      if (sm && req.method === 'GET') {
        const key = decodeURIComponent(sm[1]).split('/').map(decodeURIComponent).join('/');
        const buf = storage.get(key);
        if (!buf) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(buf); return;
      }
      if (u.pathname.startsWith('/storage/v1/')) { sendJson(404, { message: 'no' }); return; }

      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { sendJson(404, { message: 'not found' }); return; }
      const rows = tableOf(decodeURIComponent(m[1]));
      const matches = buildMatcher(u.searchParams);
      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        sendJson(200, out); return;
      }
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody()).toString('utf8') || 'null');
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        // runtime_kv upserts on `key`
        const saved = incoming.map((r) => {
          const existing = r && r.key ? rows.find((x) => x.key === r.key) : null;
          if (existing) { Object.assign(existing, r); return existing; }
          const row = { id: crypto.randomUUID(), ...r }; rows.push(row); return row;
        });
        sendJson(201, saved); return;
      }
      if (req.method === 'PATCH') {
        const patch = JSON.parse((await readBody()).toString('utf8') || 'null');
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        sendJson(200, matched); return;
      }
      sendJson(405, { message: 'no' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

const kv = (key) => db.runtime_kv.find((r) => r.key === key);
const CACHE_KEY = 'career_contract_extract:' + APP_ID;

beforeAll(async () => {
  db = freshDb();
  storage.set(BUCKET + '/' + STORAGE_PATH, Buffer.from(CONTRACT_TEXT, 'utf8'));
  await startEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.AUTH_SECRET = 'contract-terms-' + RUN_ID;
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.SUPABASE_DOCUMENT_BUCKET = BUCKET;
  process.env.DB_FILE_PATH = path.join('/tmp', `gplink-contract-terms-${RUN_ID}.json`);
  // No ANTHROPIC_API_KEY: the AI arm returns null, so this exercises the
  // heuristic arm end-to-end. The AI arm is what reads scanned PDFs in prod.
  delete process.env.ANTHROPIC_API_KEY;
  const mod = await import('../server.js');
  resolveTerms = mod.__testUtils.resolveCareerContractTermsFromStorage;
});

afterAll(async () => { if (sbServer) await new Promise((r) => sbServer.close(r)); });

describe('contract terms are extracted from the contract in Supabase Storage', () => {
  it('exposes the re-pointed resolver', () => {
    expect(typeof resolveTerms).toBe('function');
  });

  it('reads split, relocation and length from the stored contract', async () => {
    const terms = await resolveTerms(UID, APP_ID);
    expect(terms).toBeTruthy();
    expect(terms.status).toBe('ready');
    // The GP's share, not the practice's 35% cut.
    expect(terms.splitDisplay).toBe('65%');
    expect(terms.relocationPackageDisplay).toBe('$10,000');
    expect(terms.contractLengthDisplay).toBe('3 years');
  });

  it('caches the result so the next placement view costs nothing', async () => {
    const cached = kv(CACHE_KEY);
    expect(cached).toBeTruthy();
    expect(cached.value.status).toBe('ready');
    expect(cached.value.splitDisplay).toBe('65%');
    // Signature ties the cache to THIS contract file.
    expect(cached.value.attachmentSignature).toContain(STORAGE_PATH);
  });

  it('serves the cached value without re-reading Storage', async () => {
    storage.delete(BUCKET + '/' + STORAGE_PATH); // any re-read would now fail
    const terms = await resolveTerms(UID, APP_ID);
    expect(terms.splitDisplay).toBe('65%');
    storage.set(BUCKET + '/' + STORAGE_PATH, Buffer.from(CONTRACT_TEXT, 'utf8'));
  });

  it('re-extracts when the contract is REPLACED', async () => {
    storage.set(BUCKET + '/' + STORAGE_PATH, Buffer.from(
      'The Doctor receives 70% of billings. Relocation assistance of $15,000 is payable. Term: 2 years.', 'utf8'));
    const row = db.user_documents[0];
    row.file_name = 'Contract v2.txt';
    row.updated_at = '2026-09-01T00:00:00.000Z'; // newer than the extraction
    const terms = await resolveTerms(UID, APP_ID);
    expect(terms.splitDisplay).toBe('70%');
    expect(terms.relocationPackageDisplay).toBe('$15,000');
    expect(terms.contractLengthDisplay).toBe('2 years');
  });

  it('keeps Zoho-era figures when nothing newer exists', async () => {
    // A pre-2026-07-06 extraction: real agreed figures, signature we can never match.
    db.runtime_kv.length = 0;
    db.runtime_kv.push({
      key: CACHE_KEY,
      value: {
        status: 'ready', splitDisplay: '65%', relocationPackageDisplay: '$10,000',
        contractLengthDisplay: '3 years', attachmentSignature: '11734000001078175|old.docx|zoho',
        extractedAt: '2026-06-21T09:00:28.108Z'
      }
    });
    db.user_documents[0].updated_at = '2026-04-01T00:00:00.000Z'; // contract predates it
    const terms = await resolveTerms(UID, APP_ID);
    expect(terms.splitDisplay).toBe('65%');
    expect(terms.extractedAt).toBe('2026-06-21T09:00:28.108Z');
  });

  it('records "unavailable" when the GP has no contract on file', async () => {
    db.user_documents.length = 0;
    db.runtime_kv.length = 0;
    const terms = await resolveTerms(UID, APP_ID);
    expect(terms).toBeNull();
    expect(kv(CACHE_KEY).value.status).toBe('unavailable');
    expect(kv(CACHE_KEY).value.reason).toBe('no_contract_document');
  });
});
