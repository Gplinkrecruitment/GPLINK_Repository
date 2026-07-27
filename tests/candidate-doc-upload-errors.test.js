// Why this file exists (2026-07-28): the owner clicked "↑ Replace" on a candidate
// document and got a red toast reading exactly "Upload failed" — no code, no reason.
// Production's client_errors table recorded the real cause at that moment:
//
//   console.error: [VA] candidate doc upload failed: Failed to fetch
//   https://ceo.admin.mygplink.com.au/pages/admin?pov_rso=...
//
// "Failed to fetch" = the browser's fetch THREW (the transfer to Storage died at the
// network level), so the handler's catch fired with no message and the operator was
// told nothing. The server path itself was healthy — sign → PUT → finalize all
// returned 200 when driven against the production database.
//
// Two things had to change and are pinned here:
//   1. a dropped transfer is RETRIED, not surrendered on the first drop, and
//   2. no failure is ever reported bare — every path names a stage, a status, or a
//      cause (including the admin 401, which used to carry no message at all).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function extractFunction(source, name) {
  let start = source.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function not found: ' + name);
  // Keep a leading `async` — dropping it makes every `await` inside a syntax error.
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}

const admin = read('pages/admin.html');
const quietConsole = { error() {}, log() {}, warn() {} };
// Fire timers immediately: the retry backoff is real seconds we don't want to wait.
const fastTimeout = (fn) => { fn(); return 0; };

function buildPut(fetchImpl) {
  return new Function('fetch', 'console', 'setTimeout',
    extractFunction(admin, 'putCandidateDocFile') + '; return putCandidateDocFile;'
  )(fetchImpl, quietConsole, fastTimeout);
}

const FILE = { type: 'application/pdf', name: 'scan.pdf' };

describe('a dropped file transfer is retried, not surrendered', () => {
  it('recovers when the connection drops before succeeding', async () => {
    let calls = 0;
    const put = buildPut(async () => {
      calls++;
      if (calls < 3) throw new TypeError('Failed to fetch'); // the exact live failure
      return { ok: true, status: 200 };
    });
    await expect(put('https://storage.example/signed', FILE)).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it('retries a 5xx from Storage', async () => {
    let calls = 0;
    const put = buildPut(async () => { calls++; return calls < 2 ? { ok: false, status: 503 } : { ok: true, status: 200 }; });
    await expect(put('https://storage.example/signed', FILE)).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('gives up on a 4xx immediately — a rejection will not fix itself', async () => {
    let calls = 0;
    const put = buildPut(async () => { calls++; return { ok: false, status: 403 }; });
    const r = await put('https://storage.example/signed', FILE);
    expect(calls).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('403');
  });

  it('explains a transfer that never got through, instead of failing bare', async () => {
    const put = buildPut(async () => { throw new TypeError('Failed to fetch'); });
    const r = await put('https://storage.example/signed', FILE);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/interrupted/i);
    expect(r.message).toMatch(/connection/i);
    expect(r.message).not.toBe('Upload failed');
  });
});

describe('every upload failure names its cause', () => {
  const stageError = new Function(
    extractFunction(admin, 'docUploadStageError') + '; return docUploadStageError;'
  )();

  it('turns an expired admin sign-in into a re-login instruction', () => {
    // The live 401 body carried no message at all — this is the case that rendered bare.
    expect(stageError("Couldn't start the upload", { status: 401 }, { ok: false, authenticated: false }))
      .toMatch(/sign in again/i);
  });

  it('prefers the explanation the server gave, when there is one', () => {
    expect(stageError("Couldn't save the document", { status: 400 }, { ok: false, message: 'Invalid document_key.' }))
      .toBe('Invalid document_key.');
  });

  it('falls back to the stage and status, never to a bare failure', () => {
    const msg = stageError("Couldn't start the upload", { status: 502 }, {});
    expect(msg).toContain("Couldn't start the upload");
    expect(msg).toContain('502');
  });
});

describe('the CEO console reports failures the same way', () => {
  const ceo = read('pages/ceo-dashboard.html');
  const handler = extractFunction(ceo, 'ceoCandidateDocUpload');

  it('retries the transfer and surfaces the real reason', () => {
    expect(handler).toMatch(/for \(var i = 0; i < 3; i\+\+\)/);       // retry loop
    expect(handler).toMatch(/r\.status < 500/);                        // 4xx = no retry
    expect(handler).toMatch(/sign in again/i);                         // 401 handling
    expect(handler).toMatch(/interrupted/i);                           // dropped transfer
  });

  it('keeps the SWR cache invalidation it would have got from apiFetch', () => {
    expect(handler).toMatch(/gpSwrPurge\(\)/);
    expect(handler).toMatch(/refreshGpDocuments\(\)/);
  });
});
