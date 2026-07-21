// AI bug-fix pipeline, the executor end to end, against a stubbed network.
//
// WHAT IS REAL HERE: every line of dispatchApprovedFixProposal, the claim/
// double-dispatch guard, the stale-reclaim sweep, the response parsing, the
// in-memory edit application, the syntax check, the guardrails, the branch and
// PR payload construction, the status transitions, and the local-JSON store.
//
// WHAT IS STUBBED: global.fetch only. Anthropic and GitHub are both replaced by
// a recording router, so the tests assert on the EXACT requests the executor
// would have sent. Nothing here proves the real GitHub API accepts them, that
// cannot be proven without a token, and the token is not available locally.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
// Imported directly: explainFailure is a pure function on the executor lib and
// is not re-exported through server.js's __testUtils handle.
import executor from '../lib/error-fix-executor.js';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-fix-exec-${RUN_ID}.json`);
const REPO = 'Gplinkrecruitment/GPLINK_Repository';
const TARGET = 'js/career-list.js';

let ef;
let realFetch;

// The file the executor believes is on `main`.
// `let`, not `const`: the ambiguity test needs a file where the anchor genuinely
// appears twice. It restores this immediately afterwards.
const BASE_SRC_DEFAULT = [
  '(function () {',
  '  "use strict";',
  '  function renderJobs(jobs) {',
  '    return jobList.map(toCard).join("");',
  '  }',
  '})();'
].join('\n');
let BASE_SRC = BASE_SRC_DEFAULT;

// ── The network stub ─────────────────────────────────────────────────────────
// Records every call so tests can assert what did (and did not) happen.
let calls;
let patchPayload;      // what "Anthropic" returns
let githubOverrides;   // per-test failure injection

function jsonResponse(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Map()
  });
}

function installFetchStub() {
  global.fetch = (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    let body = null;
    try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch (e) { body = null; }
    calls.push({ url: u, method, body });

    // ── Anthropic ──
    if (u.indexOf('api.anthropic.com') !== -1) {
      if (githubOverrides.anthropicStatus && githubOverrides.anthropicStatus !== 200) {
        return jsonResponse(githubOverrides.anthropicStatus, { error: 'nope' });
      }
      return jsonResponse(200, {
        content: [{ type: 'text', text: JSON.stringify(patchPayload) }],
        usage: { input_tokens: 1000, output_tokens: 200 }
      });
    }

    // ── GitHub ──
    const key = method + ' ' + u.replace('https://api.github.com', '');
    for (const pattern of Object.keys(githubOverrides.routes || {})) {
      if (key.indexOf(pattern) === 0) {
        const o = githubOverrides.routes[pattern];
        return jsonResponse(o.status, o.body || {});
      }
    }

    if (method === 'GET' && u.endsWith('/repos/' + REPO)) {
      return jsonResponse(200, { full_name: REPO, private: true, default_branch: 'main', permissions: { push: true, admin: false, pull: true } });
    }
    if (method === 'GET' && u.indexOf('/contents/') !== -1) {
      return jsonResponse(200, { encoding: 'base64', content: Buffer.from(BASE_SRC, 'utf8').toString('base64'), sha: 'basefilesha' });
    }
    if (method === 'GET' && u.indexOf('/git/ref/heads/main') !== -1) {
      return jsonResponse(200, { object: { sha: 'basecommitsha' } });
    }
    if (method === 'POST' && u.endsWith('/git/refs')) return jsonResponse(201, { ref: (body && body.ref) || '' });
    if (method === 'PUT' && u.indexOf('/contents/') !== -1) return jsonResponse(200, { commit: { sha: 'newcommitsha' } });
    if (method === 'POST' && u.endsWith('/pulls')) {
      return jsonResponse(201, { number: 42, html_url: 'https://github.com/' + REPO + '/pull/42' });
    }
    if (method === 'POST' && u.indexOf('/issues/42/labels') !== -1) return jsonResponse(200, [{ name: 'safe-auto' }]);
    if (method === 'GET' && u.indexOf('/pulls?') !== -1) return jsonResponse(200, []);
    if (method === 'GET' && u.indexOf('/actions/workflows') !== -1) return jsonResponse(200, { total_count: 4 });

    return jsonResponse(404, { message: 'unstubbed: ' + key });
  };
}

// A well-formed, in-scope, boring fix.
const GOOD_PATCH = {
  summary: 'Used the jobs argument instead of a name that does not exist.',
  edits: [{
    file: TARGET,
    old_string: '    return jobList.map(toCard).join("");',
    new_string: '    return jobs.map(toCard).join("");'
  }]
};

function seedProposal(id, over) {
  return Object.assign({
    id,
    error_hash: 'hash' + id,
    status: 'approved',
    error_message: 'jobList is not defined',
    page_url: '/pages/career.html',
    plain_explanation: 'The list of jobs never appears, so doctors see an empty page.',
    technical_diagnosis: 'jobList is not defined in js/career-list.js.',
    proposed_fix: 'Use the jobs argument.',
    suspect_files: [{ file: TARGET, startLine: 1, endLine: 6 }],
    risk_class: 'safe_auto',
    risk_reason: 'Small and self-contained.',
    occurrence_count: 9,
    affected_users: 3,
    approved_by: 'owner@example.com',
    approved_at: '2026-07-20T01:00:00Z',
    created_at: '2026-07-20T00:00:00Z'
  }, over || {});
}

function writeDb(rows) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ errorFixProposals: rows }));
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'fix-exec-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.GITHUB_TOKEN = 'ghp_stub_token_never_asserted_on';
  process.env.GITHUB_REPO = REPO;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-stub';
  writeDb([]);

  realFetch = global.fetch;
  const mod = await import('../server.js');
  ef = mod.__testUtils;
});

afterAll(() => {
  global.fetch = realFetch;
  try { fs.unlinkSync(DB_FILE); } catch {}
});

beforeEach(() => {
  calls = [];
  patchPayload = JSON.parse(JSON.stringify(GOOD_PATCH));
  githubOverrides = { routes: {} };
  installFetchStub();
});

const reload = async (rows) => {
  writeDb(rows);
  // server.js caches dbState in memory; re-read it the same way the app does.
  await ef.loadDbState?.();
};

// Because the local store is in-memory, seed through the module's own writer.
async function seedRows(rows) {
  const existing = await ef.listErrorFixProposals({ limit: 200 });
  for (const r of existing.rows) await ef.updateErrorFixProposal(r.id, { status: 'rejected' });
  for (const r of rows) await ef.insertErrorFixProposal(r);
}

const urlsOf = (m, frag) => calls.filter((c) => c.method === m && c.url.indexOf(frag) !== -1);

describe('the happy path: approved proposal → validated edit → pull request', () => {
  it('opens a PR, labels it safe-auto, and records branch + pr_url', async () => {
    await seedRows([seedProposal('p-happy')]);
    const row = await ef.getErrorFixProposalById('p-happy');

    const out = await ef.dispatchApprovedFixProposal(row, {});

    expect(out.ok).toBe(true);
    expect(out.dispatched).toBe(true);
    expect(out.pr_url).toBe('https://github.com/' + REPO + '/pull/42');
    expect(out.branch.startsWith('autofix/')).toBe(true);
    expect(out.labels).toEqual(['safe-auto']);

    const after = await ef.getErrorFixProposalById('p-happy');
    expect(after.status).toBe('shipped');
    expect(after.branch_name).toBe(out.branch);
    expect(after.pr_url).toBe(out.pr_url);
    expect(after.execution_started_at).toBeTruthy();
    expect(after.execution_finished_at).toBeTruthy();
    expect(after.execution_error).toBeFalsy();
  });

  it('branches from main and NEVER commits to it', async () => {
    await seedRows([seedProposal('p-branch')]);
    await ef.dispatchApprovedFixProposal(await ef.getErrorFixProposalById('p-branch'), {});

    const refCall = urlsOf('POST', '/git/refs')[0];
    expect(refCall.body.ref).toMatch(/^refs\/heads\/autofix\//);
    expect(refCall.body.sha).toBe('basecommitsha');

    // Every write names the autofix branch, nothing targets main.
    urlsOf('PUT', '/contents/').forEach((c) => {
      expect(c.body.branch).toMatch(/^autofix\//);
      expect(c.body.branch).not.toBe('main');
    });
    // A PR is opened INTO main, which is the only way main is touched.
    const pr = urlsOf('POST', '/pulls')[0];
    expect(pr.body.base).toBe('main');
    expect(pr.body.head).toMatch(/^autofix\//);
  });

  it('sends the file’s base SHA as an optimistic lock, so a changed file is rejected by GitHub', async () => {
    await seedRows([seedProposal('p-lock')]);
    await ef.dispatchApprovedFixProposal(await ef.getErrorFixProposalById('p-lock'), {});
    const put = urlsOf('PUT', '/contents/')[0];
    expect(put.body.sha).toBe('basefilesha');
  });

  it('commits the edited content, read from GitHub, not from local disk', async () => {
    await seedRows([seedProposal('p-content')]);
    await ef.dispatchApprovedFixProposal(await ef.getErrorFixProposalById('p-content'), {});

    // The file contents were fetched from the API before any edit was applied.
    expect(urlsOf('GET', '/contents/').length).toBe(1);

    const put = urlsOf('PUT', '/contents/')[0];
    const written = Buffer.from(put.body.content, 'base64').toString('utf8');
    expect(written).toContain('return jobs.map(toCard)');
    expect(written).not.toContain('jobList');
    // Only the targeted line changed.
    expect(written.split('\n').length).toBe(BASE_SRC.split('\n').length);
  });

  it('labels a needs_review proposal needs-review, so it can never auto-merge', async () => {
    await seedRows([seedProposal('p-review', { risk_class: 'needs_review' })]);
    const out = await ef.dispatchApprovedFixProposal(await ef.getErrorFixProposalById('p-review'), {});
    expect(out.dispatched).toBe(true);
    expect(out.labels).toEqual(['needs-review']);
    const labelCall = urlsOf('POST', '/labels')[0];
    expect(labelCall.body.labels).toEqual(['needs-review']);
    expect(labelCall.body.labels).not.toContain('safe-auto');
  });

  it('the PR body explains the bug in plain words', async () => {
    await seedRows([seedProposal('p-body')]);
    await ef.dispatchApprovedFixProposal(await ef.getErrorFixProposalById('p-body'), {});
    const pr = urlsOf('POST', '/pulls')[0];
    expect(pr.body.body).toContain('The list of jobs never appears');
    expect(pr.body.body).toContain('js/career-list.js');
    expect(pr.body.title).toContain('Auto-fix');
  });

  it('asks Opus 4.8 without temperature or top_p (4.7/4.8 reject them with a 400)', async () => {
    await seedRows([seedProposal('p-model')]);
    await ef.dispatchApprovedFixProposal(await ef.getErrorFixProposalById('p-model'), {});
    const call = calls.find((c) => c.url.indexOf('anthropic') !== -1);
    expect(call.body.model).toBe('claude-opus-4-8');
    expect(call.body).not.toHaveProperty('temperature');
    expect(call.body).not.toHaveProperty('top_p');
  });
});

describe('the double-dispatch guard', () => {
  it('two overlapping runs on the same proposal produce ONE pull request', async () => {
    await seedRows([seedProposal('p-race')]);
    const row = await ef.getErrorFixProposalById('p-race');

    const [a, b] = await Promise.all([
      ef.dispatchApprovedFixProposal(row, {}),
      ef.dispatchApprovedFixProposal(row, {})
    ]);

    const winners = [a, b].filter((r) => r.dispatched);
    const losers = [a, b].filter((r) => !r.dispatched);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0].reason).toBe('already_claimed');

    // And exactly one PR was actually opened.
    expect(urlsOf('POST', '/pulls').length).toBe(1);
  });

  it('a proposal already in_progress is never picked up again', async () => {
    await seedRows([seedProposal('p-inflight', { status: 'in_progress', execution_started_at: new Date().toISOString() })]);
    const out = await ef.dispatchApprovedFixProposal(await ef.getErrorFixProposalById('p-inflight'), {});
    expect(out.dispatched).toBe(false);
    expect(out.reason).toBe('already_claimed');
    expect(urlsOf('POST', '/pulls').length).toBe(0);
  });

  it('a shipped or rejected proposal is never re-run', async () => {
    await seedRows([seedProposal('p-done', { status: 'shipped' }), seedProposal('p-no', { status: 'rejected' })]);
    for (const id of ['p-done', 'p-no']) {
      const out = await ef.dispatchApprovedFixProposal(await ef.getErrorFixProposalById(id), {});
      expect(out.dispatched).toBe(false);
    }
    expect(urlsOf('POST', '/pulls').length).toBe(0);
  });
});

describe('guardrails stop the change BEFORE anything reaches GitHub', () => {
  const expectRefused = async (id, matcher) => {
    const out = await ef.dispatchApprovedFixProposal(await ef.getErrorFixProposalById(id), {});
    expect(out.dispatched).toBe(false);
    const after = await ef.getErrorFixProposalById(id);
    expect(after.status).toBe('failed');
    expect(after.execution_error).toMatch(matcher);
    expect(after.execution_finished_at).toBeTruthy();
    // THE point of this describe block: nothing was created on GitHub.
    expect(urlsOf('POST', '/git/refs').length, 'no branch created').toBe(0);
    expect(urlsOf('PUT', '/contents/').length, 'no file written').toBe(0);
    expect(urlsOf('POST', '/pulls').length, 'no PR opened').toBe(0);
    return after;
  };

  it('refuses when the anchor is not in the file', async () => {
    await seedRows([seedProposal('g-missing')]);
    patchPayload.edits[0].old_string = '    return jobsList.map(toCard).join("");';
    await expectRefused('g-missing', /was not found in the file/i);
  });

  it('refuses when the anchor is ambiguous', async () => {
    await seedRows([seedProposal('g-ambig')]);
    // This must exercise AMBIGUITY, not the minimum-length rule. A short anchor
    // is rejected for being too short before ambiguity is ever considered, so
    // the anchor here is the full 37-character line (comfortably over the 24
    // minimum) and the FILE is changed so that line genuinely appears twice.
    const dupLine = '    return jobList.map(toCard).join("");';
    BASE_SRC = BASE_SRC_DEFAULT.replace(dupLine, dupLine + '\n' + dupLine);
    expect(BASE_SRC.split(dupLine).length - 1).toBe(2);  // the setup is real
    expect(dupLine.length).toBeGreaterThan(24);          // so length is not the reason
    try {
      patchPayload.edits[0].old_string = dupLine;
      await expectRefused('g-ambig', /appears more than once/i);
    } finally {
      BASE_SRC = BASE_SRC_DEFAULT;
    }
  });

  it('refuses a change that breaks the file’s syntax', async () => {
    await seedRows([seedProposal('g-syntax')]);
    patchPayload.edits[0].new_string = '    return jobs.map(toCard).join(";'; // unterminated string
    await expectRefused('g-syntax', /left the file broken/i);
  });

  it('refuses a change bigger than the size limit', async () => {
    await seedRows([seedProposal('g-big')]);
    patchPayload.edits[0].new_string = '    return jobs.map(toCard).join(""); // ' + 'x'.repeat(1300);
    await expectRefused('g-big', /too big|characters/i);
  });

  it('refuses a file outside the ones the bug was traced to', async () => {
    await seedRows([seedProposal('g-scope')]);
    patchPayload.edits[0].file = 'js/somewhere-else.js';
    await expectRefused('g-scope', /not one of the files/i);
  });

  it('refuses a sensitive change even when the model insists', async () => {
    await seedRows([seedProposal('g-sensitive')]);
    patchPayload.edits[0].new_string = '    return jobs.map(toCard).join(""); // sessionStorage.setItem("password", p);';
    await expectRefused('g-sensitive', /never changed automatically/i);
  });

  it('refuses when the model declines to make the change', async () => {
    await seedRows([seedProposal('g-declined')]);
    patchPayload = { summary: 'This touches sign-in; a person should do it.', edits: [] };
    await expectRefused('g-declined', /person to do it by hand/i);
  });

  it('refuses when the model returns nonsense', async () => {
    await seedRows([seedProposal('g-garbage')]);
    patchPayload = { nope: true };
    await expectRefused('g-garbage', /usable change|could not read/i);
  });

  it('refuses when the proposal has no file to change', async () => {
    await seedRows([seedProposal('g-nofiles', { suspect_files: [] })]);
    const out = await ef.dispatchApprovedFixProposal(await ef.getErrorFixProposalById('g-nofiles'), {});
    expect(out.dispatched).toBe(false);
    const after = await ef.getErrorFixProposalById('g-nofiles');
    expect(after.status).toBe('failed');
    expect(after.execution_error).toMatch(/which file to change/i);
    // Not even the AI was called, this fails before any spend.
    expect(calls.filter((c) => c.url.indexOf('anthropic') !== -1).length).toBe(0);
  });

  it('never lets a proposal name a file it may not write, even via suspect_files', async () => {
    await seedRows([seedProposal('g-badfile', {
      suspect_files: [{ file: 'server.js' }, { file: 'supabase/migrations/x.sql' }, { file: '../../.env' }]
    })]);
    const out = await ef.dispatchApprovedFixProposal(await ef.getErrorFixProposalById('g-badfile'), {});
    expect(out.dispatched).toBe(false);
    expect((await ef.getErrorFixProposalById('g-badfile')).execution_error).toMatch(/which file to change/i);
  });
});

describe('failure never leaves a row stuck, and never crashes the cron', () => {
  it('fails readably when there is no GitHub token, before any AI spend', async () => {
    const saved = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = '';
    try {
      await seedRows([seedProposal('f-notoken')]);
      const out = await ef.dispatchApprovedFixProposal(await ef.getErrorFixProposalById('f-notoken'), {});
      expect(out.dispatched).toBe(false);
      const after = await ef.getErrorFixProposalById('f-notoken');
      expect(after.status).toBe('failed');
      expect(after.execution_error).toMatch(/GitHub is not connected/);
      expect(calls.filter((c) => c.url.indexOf('anthropic') !== -1).length).toBe(0);
    } finally {
      process.env.GITHUB_TOKEN = saved;
    }
  });

  it('fails readably when GitHub rejects the branch creation, and does not force anything', async () => {
    await seedRows([seedProposal('f-branch')]);
    githubOverrides.routes['POST /repos/' + REPO + '/git/refs'] = { status: 422, body: { message: 'Reference already exists' } };
    const out = await ef.dispatchApprovedFixProposal(await ef.getErrorFixProposalById('f-branch'), {});
    expect(out.dispatched).toBe(false);
    const after = await ef.getErrorFixProposalById('f-branch');
    expect(after.status).toBe('failed');
    expect(after.execution_error).toMatch(/already exists/i);
    // No retry, no delete, no force.
    expect(calls.filter((c) => c.method === 'DELETE').length).toBe(0);
    expect(calls.filter((c) => c.method === 'PATCH').length).toBe(0);
    expect(urlsOf('PUT', '/contents/').length).toBe(0);
  });

  it('keeps the branch for review when the PR cannot be opened', async () => {
    await seedRows([seedProposal('f-pr')]);
    githubOverrides.routes['POST /repos/' + REPO + '/pulls'] = { status: 500, body: { message: 'boom' } };
    const out = await ef.dispatchApprovedFixProposal(await ef.getErrorFixProposalById('f-pr'), {});
    expect(out.dispatched).toBe(false);
    const after = await ef.getErrorFixProposalById('f-pr');
    expect(after.status).toBe('failed');
    expect(after.branch_name).toMatch(/^autofix\//); // recorded, not discarded
    expect(after.execution_error).toMatch(/pull request could not be opened/i);
  });

  it('fails readably when the AI call errors', async () => {
    await seedRows([seedProposal('f-ai')]);
    githubOverrides.anthropicStatus = 500;
    const out = await ef.dispatchApprovedFixProposal(await ef.getErrorFixProposalById('f-ai'), {});
    expect(out.dispatched).toBe(false);
    expect((await ef.getErrorFixProposalById('f-ai')).status).toBe('failed');
    expect(urlsOf('POST', '/pulls').length).toBe(0);
  });

  it('an unexpected throw still closes the row out rather than stranding it', async () => {
    await seedRows([seedProposal('f-throw')]);
    global.fetch = () => { throw new Error('network exploded'); };
    const out = await ef.dispatchApprovedFixProposal(await ef.getErrorFixProposalById('f-throw'), {});
    expect(out.dispatched).toBe(false);
    const after = await ef.getErrorFixProposalById('f-throw');
    expect(after.status).toBe('failed');
    expect(after.status).not.toBe('in_progress');
  });

  // Asserts the CONTRACT, not whatever rows happen to be left over. Each test
  // rewrites the db file, so the previous version of this test could only ever
  // see the last test's single row and was order-dependent. Every reason code
  // the executor can emit is checked here, including ones no test exercises.
  it('every failure message is a sentence the owner can read', () => {
    const ALL_REASONS = [
      'no_api_key', 'no_github_token', 'no_github_repo', 'api_error', 'timeout',
      'empty_response', 'unparseable_response', 'no_edits_array', 'malformed_edit',
      'model_declined', 'no_edits', 'no_suspect_files', 'fetch_failed', 'github_error',
      'branch_exists', 'claim_lost', 'anchor_not_found', 'anchor_too_short',
      'anchor_ambiguous', 'syntax_error', 'change_too_large', 'too_many_edits',
      'too_many_files', 'file_not_in_scope', 'file_not_editable', 'file_not_loaded',
      'unknown_file_type', 'unsupported_module_script', 'sensitive_area', 'noop_edit',
      'a_totally_unknown_reason'   // the fallback must be readable too
    ];
    // Details the executor really does pass through, including hostile ones.
    const DETAILS = [
      undefined, null, '', 'Invalid or unexpected token', 'anchor_not_found',
      'undefined', 'Branch autofix/x already exists.', 'x'.repeat(400)
    ];

    ALL_REASONS.forEach((reason) => {
      DETAILS.forEach((detail) => {
        const msg = executor.explainFailure(reason, detail);
        const where = reason + ' / ' + String(detail).slice(0, 24);
        expect(msg, where).toBeTruthy();
        expect(msg, where).toMatch(/[.!?]$/);                       // a sentence
        expect(msg, where).not.toMatch(/_[a-z]+_/);                 // no raw codes
        expect(msg, where).not.toMatch(/\bundefined\b|\bnull\b/i);  // no placeholders
        expect(msg.length, where).toBeLessThanOrEqual(400);         // readable length
      });
    });

    // And every reason the executor can emit has a REAL message, not the fallback.
    const fallback = executor.explainFailure('a_totally_unknown_reason', '');
    ALL_REASONS.slice(0, -1).forEach((reason) => {
      expect(executor.explainFailure(reason, ''), reason).not.toBe(fallback);
    });
  });
});

describe('stale reclaim', () => {
  it('moves an orphaned in_progress row to failed, and leaves a fresh one alone', async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    await seedRows([
      seedProposal('s-old', { status: 'in_progress', execution_started_at: old }),
      seedProposal('s-new', { status: 'in_progress', execution_started_at: now })
    ]);

    const r = await ef.reclaimStaleFixProposals(15 * 60 * 1000);
    expect(r.reclaimed).toBe(1);
    expect((await ef.getErrorFixProposalById('s-old')).status).toBe('failed');
    expect((await ef.getErrorFixProposalById('s-old')).execution_error).toMatch(/interrupted part-way/i);
    expect((await ef.getErrorFixProposalById('s-new')).status).toBe('in_progress');
  });

  it('reclaims to a CLOSED status, so the error can be proposed again later', async () => {
    // 'failed' is not in OPEN_PROPOSAL_STATUSES, which is what frees the
    // partial unique index for a fresh proposal on the same error_hash.
    const proposals = require('../lib/error-fix-proposals.js');
    expect(proposals.OPEN_PROPOSAL_STATUSES).not.toContain('failed');
  });
});

describe('the executor cron pass', () => {
  it('drains approved proposals oldest-first and reports what it did', async () => {
    await seedRows([
      seedProposal('c-1', { approved_at: '2026-07-20T01:00:00Z' }),
      seedProposal('c-2', { approved_at: '2026-07-20T02:00:00Z' })
    ]);
    const out = await ef.runErrorFixExecutor({ limit: 1 });
    expect(out.ok).toBe(true);
    expect(out.dispatched).toBe(1);
    // The older approval went first.
    expect((await ef.getErrorFixProposalById('c-1')).status).toBe('shipped');
    expect((await ef.getErrorFixProposalById('c-2')).status).toBe('approved');
    expect(out.pending).toBe(1);
  });

  it('does the stale sweep as part of the same pass', async () => {
    await seedRows([seedProposal('c-stale', {
      status: 'in_progress',
      execution_started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString()
    })]);
    const out = await ef.runErrorFixExecutor({ limit: 1 });
    expect(out.reclaimed).toBe(1);
  });
});

describe('the GitHub credential check never leaks the token', () => {
  it('sends the token only in the Authorization header, never in a URL', async () => {
    await seedRows([seedProposal('t-leak')]);
    await ef.dispatchApprovedFixProposal(await ef.getErrorFixProposalById('t-leak'), {});
    calls.forEach((c) => {
      expect(c.url).not.toContain(process.env.GITHUB_TOKEN);
      expect(JSON.stringify(c.body || {})).not.toContain(process.env.GITHUB_TOKEN);
    });
  });

  it('the endpoint source never puts the token in a response', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
    const start = src.indexOf("pathname === '/api/ceo/technical/github-check'");
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, start + 4200);
    // The only use of the token in the handler is the boolean presence check.
    expect(block).toContain('token_present: !!githubToken()');
    expect(block).not.toMatch(/token:\s*githubToken\(\)/);
    expect(block).not.toMatch(/githubToken\(\)\.(slice|substring|substr)/);
    expect(block).toMatch(/requireCeoSession/);
  });
});
