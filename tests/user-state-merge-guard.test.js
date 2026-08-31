// readUserStateForMerge — the guard that stops a user_state read-modify-write
// from clobbering a doctor's whole journey state. Regression for 2026-08-31:
// pushCareerNotificationToUser's read transiently failed, its base object
// quietly became {}, and the follow-up PATCH replaced Dr Deepika Ganesh's
// entire user_state with only the notification list (restored from the weekly
// backup). The rule under test: a FAILED read returns null (callers must skip
// their write), never an empty merge base.
//
// Boots the real server in LOCAL-JSON mode, where supabaseDbRequest always
// answers ok:false — which IS the failed-read path in production.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-state-merge-${RUN_ID}.json`;
let testUtils;

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'test-state-merge-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.DB_FILE_PATH = DB_FILE;
  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
});

afterAll(() => {
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

describe('readUserStateForMerge', () => {
  it('returns null — NEVER an empty base — when the state read fails', async () => {
    // Local-JSON mode: supabaseDbRequest answers ok:false, exactly like a
    // transient prod failure. The old code turned this into {} and the
    // caller's PATCH then wiped the doctor's whole state.
    const base = await testUtils.readUserStateForMerge('any-user-id', 'guard test');
    expect(base).toBe(null);
  });
});

describe('parseGpLinkUpdatesList', () => {
  it('accepts the client-sync stringified form and the server array form', () => {
    expect(testUtils.parseGpLinkUpdatesList([{ id: 'a' }])).toEqual([{ id: 'a' }]);
    expect(testUtils.parseGpLinkUpdatesList('[{"id":"b"}]')).toEqual([{ id: 'b' }]);
  });

  it('degrades junk to an empty list instead of throwing', () => {
    expect(testUtils.parseGpLinkUpdatesList('not json')).toEqual([]);
    expect(testUtils.parseGpLinkUpdatesList(undefined)).toEqual([]);
    expect(testUtils.parseGpLinkUpdatesList({ id: 'x' })).toEqual([]);
  });
});
