// Duplicate-prevention guard for document review tasks.
//
// Prod evidence (2026-07-12): a GP uploaded her degree 3 times in ~18 minutes;
// each upload's fire-and-forget background pipeline (processDocumentUpload ->
// createDocReviewTask) created its OWN "Review uploaded Primary Medical
// Degree" task. createDocReviewTask/createFlaggedDocTask dedupe with a
// read-then-insert SELECT, which is not airtight under serverless burst load
// (3 open tasks landed; only the first has a "Task created" timeline row).
//
// Fix: supabase/migrations/20260713100000_unique_open_doc_review_tasks.sql
// enforces uniqueness in Postgres with a partial unique index; _createRegTask
// (server.js) degrades gracefully on the resulting 23505/409 by reopening +
// reusing the existing task instead of losing the review.
//
// This file drives __testUtils._createRegTask directly against a Supabase
// REST emulator (no auth cookies needed), scaffolding pattern copied from
// tests/onboarding-review-roundtrip.test.js.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-doc-task-guard-${RUN_ID}.json`);
let server, sbServer, sbPort;
let testUtils;

const NOW = new Date().toISOString();
const CASE_X = 'case-x-1';

const db = {
  registration_tasks: [
    {
      id: 't-seed-1', case_id: CASE_X, task_type: 'doc_review', status: 'open',
      related_stage: 'ahpra', related_document_key: 'primary_medical_degree',
      title: 'Review uploaded Primary Medical Degree for Dr Test', created_at: NOW
    }
  ],
  task_timeline: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'not'];
function buildMatcher(searchParams) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    const dot = raw.indexOf('.');
    const op = dot > 0 ? raw.slice(0, dot) : '';
    if (!FILTER_OPS.includes(op)) continue;
    const val = raw.slice(dot + 1);
    filters.push({ col: key, op, val });
  }
  return (row) => filters.every(({ col, op, val }) => {
    const cell = row ? row[col] : undefined;
    if (op === 'eq') return String(cell) === val;
    if (op === 'neq') return String(cell) !== val;
    if (op === 'is') return val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
    if (op === 'not') return val === 'is.null' ? !(cell === null || cell === undefined) : true;
    if (op === 'gt') return cell != null && String(cell) > val;
    if (op === 'gte') return cell != null && String(cell) >= val;
    if (op === 'lt') return cell != null && String(cell) < val;
    if (op === 'lte') return cell != null && String(cell) <= val;
    if (op === 'in') {
      return val.replace(/^\(/, '').replace(/\)$/, '').split(',')
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, ''))
        .includes(String(cell));
    }
    if (op === 'ilike') {
      const pat = val.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/%/g, '.*');
      return new RegExp('^' + pat + '$', 'i').test(String(cell));
    }
    return true;
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); }
      catch { resolve(null); }
    });
  });
}

// The two guarded task types + the three "active" statuses the partial
// unique index (uniq_open_doc_check_task) covers, mirrors the migration.
const GUARDED_TASK_TYPES = new Set(['doc_review', 'flagged_doc']);
const ACTIVE_STATUSES = new Set(['open', 'in_progress', 'waiting']);

function startSupabaseEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const table = decodeURIComponent(m[1]);
      const rows = tableOf(table);
      const matches = buildMatcher(u.searchParams);

      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out);
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        const conflict = (u.searchParams.get('on_conflict') || '').split(',').map((s) => s.trim()).filter(Boolean);

        // Emulate the partial unique index uniq_open_doc_check_task:
        //   UNIQUE (case_id, task_type, related_document_key)
        //   WHERE task_type IN ('doc_review','flagged_doc')
        //     AND status IN ('open','in_progress','waiting')
        //     AND related_document_key IS NOT NULL
        // Real Postgres column default is status = 'open' (see
        // supabase/migrations/20260403000000_registration_cases_tasks.sql),
        // and every doc_review/flagged_doc payload _createRegTask ever posts
        // either sets status explicitly ('open') or omits it entirely
        // (createFlaggedDocTask's payload), so a missing status must be
        // treated as 'open' here to match the real column's behavior.
        if (table === 'registration_tasks') {
          for (const r of incoming) {
            if (!GUARDED_TASK_TYPES.has(r.task_type)) continue;
            if (r.related_document_key === undefined || r.related_document_key === null) continue;
            const incomingStatus = (r.status === undefined || r.status === null) ? 'open' : r.status;
            if (!ACTIVE_STATUSES.has(incomingStatus)) continue;
            const clash = rows.find((row) =>
              row.task_type === r.task_type &&
              String(row.case_id) === String(r.case_id) &&
              row.related_document_key === r.related_document_key &&
              ACTIVE_STATUSES.has(row.status));
            if (clash) {
              send(409, { message: 'duplicate key value violates unique constraint "uniq_open_doc_check_task"' });
              return;
            }
          }
        }

        const saved = incoming.map((r) => {
          if (conflict.length) {
            const existing = rows.find((row) => conflict.every((c) => String(row[c]) === String(r[c])));
            if (existing) { Object.assign(existing, r); return existing; }
          }
          const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
          rows.push(row);
          return row;
        });
        send(201, saved);
        return;
      }
      if (req.method === 'PATCH') {
        const patch = await readBody(req);
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched);
        return;
      }
      if (req.method === 'DELETE') {
        db[table] = rows.filter((r) => !matches(r));
        send(200, []);
        return;
      }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'doc-task-guard-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.CRON_SECRET = 'test-cron-secret-' + RUN_ID;

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    return Promise.resolve(new Response('{}', { status: 200 }));
  };

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('_createRegTask duplicate-prevention guard (uniq_open_doc_check_task)', () => {
  it('a racing duplicate doc_review create reuses the existing open task (no second row, no lost review)', async () => {
    const result = await testUtils._createRegTask(CASE_X, {
      task_type: 'doc_review',
      title: 'Review uploaded Primary Medical Degree for Dr Test',
      status: 'open',
      related_document_key: 'primary_medical_degree',
      source_trigger: 'doc_upload',
      _actor: 'system'
    });

    // Reused the seeded task, not a fresh insert.
    expect(result).toBeTruthy();
    expect(result.id).toBe('t-seed-1');

    // Still exactly ONE active doc_review row for (case, key), the index's
    // whole job is to make a second one impossible.
    const activeRows = db.registration_tasks.filter((t) =>
      t.case_id === CASE_X && t.task_type === 'doc_review' &&
      t.related_document_key === 'primary_medical_degree' &&
      ACTIVE_STATUSES.has(t.status));
    expect(activeRows.length).toBe(1);

    // The graceful-degrade path leaves an honest timeline trail instead of
    // silently swallowing the duplicate attempt.
    const timelineRow = db.task_timeline.find((e) =>
      e.task_id === 't-seed-1' && e.title === 'Duplicate task creation blocked, existing task reused');
    expect(timelineRow).toBeTruthy();
    expect(timelineRow.event_type).toBe('system');
    expect(timelineRow.detail).toBe('Review uploaded Primary Medical Degree for Dr Test');
  });

  it('a non-conflicting create (different document_key) still inserts a NEW row and logs "Task created"', async () => {
    const before = db.registration_tasks.length;
    const result = await testUtils._createRegTask(CASE_X, {
      task_type: 'doc_review',
      title: 'Review uploaded IELTS Certificate for Dr Test',
      status: 'open',
      related_document_key: 'ielts_certificate',
      source_trigger: 'doc_upload',
      _actor: 'system'
    });

    expect(result).toBeTruthy();
    expect(result.id).not.toBe('t-seed-1');
    expect(db.registration_tasks.length).toBe(before + 1);

    const timelineRow = db.task_timeline.find((e) => e.task_id === result.id && e.title === 'Task created');
    expect(timelineRow).toBeTruthy();
    expect(timelineRow.detail).toBe('Review uploaded IELTS Certificate for Dr Test');
  });

  it('the guard is scoped to doc_review/flagged_doc, a same-key conflict on an unguarded task_type is NOT blocked', async () => {
    db.registration_tasks.push({
      id: 't-zoom-1', case_id: CASE_X, task_type: 'zoom_call', status: 'open',
      related_stage: 'ahpra', related_document_key: 'shared_key',
      title: 'Existing zoom call', created_at: NOW
    });

    const result = await testUtils._createRegTask(CASE_X, {
      task_type: 'zoom_call',
      title: 'New zoom call',
      status: 'open',
      related_document_key: 'shared_key',
      _actor: 'system'
    });

    // Not a guarded type, so no 409 from the emulator, a genuine duplicate
    // row is created, proving the guard doesn't over-reach.
    expect(result).toBeTruthy();
    expect(result.id).not.toBe('t-zoom-1');
    const zoomRows = db.registration_tasks.filter((t) =>
      t.case_id === CASE_X && t.task_type === 'zoom_call' && t.related_document_key === 'shared_key');
    expect(zoomRows.length).toBe(2);
  });
});

describe('migration: uniq_open_doc_check_task partial unique index', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '20260713100000_unique_open_doc_review_tasks.sql'),
    'utf8'
  );

  it('exists and creates the expected index name on registration_tasks', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_doc_check_task');
    expect(sql).toContain('registration_tasks');
    expect(sql).toContain('case_id, task_type, related_document_key');
  });

  it('covers both document-check task types', () => {
    expect(sql).toContain("'doc_review'");
    expect(sql).toContain("'flagged_doc'");
  });

  it('covers exactly the three "active" statuses the code-level dedupe checks', () => {
    expect(sql).toContain("'open'");
    expect(sql).toContain("'in_progress'");
    expect(sql).toContain("'waiting'");
  });

  it('is partial: excludes null document keys', () => {
    expect(sql).toContain('related_document_key IS NOT NULL');
  });

  it('dedupes existing active duplicates BEFORE creating the index (keeps oldest, completes the rest)', () => {
    // The migration must be safe standalone (e.g. re-applied on a restored
    // backup): the UPDATE completes all-but-the-oldest of any active
    // duplicate group so CREATE UNIQUE INDEX can never fail to apply.
    const updatePos = sql.indexOf('UPDATE public.registration_tasks');
    const indexPos = sql.indexOf('CREATE UNIQUE INDEX');
    expect(updatePos).toBeGreaterThan(-1);
    expect(indexPos).toBeGreaterThan(-1);
    expect(updatePos).toBeLessThan(indexPos);
    expect(sql).toContain("completed_by = 'ops-dedupe-migration'");
    expect(sql).toContain('ORDER BY created_at ASC');
    expect(sql).toContain('r.rn > 1');
  });
});
