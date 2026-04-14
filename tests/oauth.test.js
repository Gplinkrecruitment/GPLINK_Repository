import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const PORT = 0; // let OS pick a free port
let server;
let baseUrl;

function post(path, body = {}, { headers = {}, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const hdrs = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
      ...headers,
    };
    if (cookie) hdrs.Cookie = cookie;

    const url = new URL(path, baseUrl);
    const req = http.request(url, { method: 'POST', headers: hdrs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(raw); } catch { json = null; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: json,
          raw,
          cookies: parseCookies(res.headers['set-cookie']),
        });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function get(path, { cookie } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const hdrs = {};
    if (cookie) hdrs.Cookie = cookie;
    http.get(url, { headers: hdrs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(raw); } catch { json = null; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: json,
          raw,
          cookies: parseCookies(res.headers['set-cookie']),
        });
      });
    }).on('error', reject);
  });
}

function parseCookies(setCookieHeaders) {
  if (!setCookieHeaders) return {};
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  const out = {};
  for (const entry of list) {
    const [kv] = entry.split(';');
    const eq = kv.indexOf('=');
    if (eq > 0) {
      out[kv.slice(0, eq).trim()] = decodeURIComponent(kv.slice(eq + 1).trim());
    }
  }
  return out;
}

function cookieHeader(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
}

// Generate a unique email per test run to avoid collisions
const RUN_ID = crypto.randomBytes(4).toString('hex');
const TEST_EMAIL = `oauth-test-${RUN_ID}@gplink-test.local`;
const TEST_PASSWORD = 'SecureP@ssw0rd!2026';
const WEAK_PASSWORD = 'short1';

// ---------------------------------------------------------------------------
// Boot the server in test mode
// ---------------------------------------------------------------------------
beforeAll(async () => {
  // Force test configuration — AGENT_SKIP_DOTENV must be set first to prevent
  // scripts/agents.js from loading the .env file and overriding our test values.
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-secret-for-oauth-tests-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-test-${RUN_ID}.json`;
  process.env.OAUTH_ACCESS_TTL_MS = '5000';   // 5s for test
  process.env.OAUTH_REFRESH_TTL_MS = '30000';  // 30s for test
  process.env.AUTH_RATE_MAX_ATTEMPTS = '500';  // high limit for tests
  process.env.AUTH_RATE_WINDOW_MS = '60000';

  // Import server after env is set
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  // Cleanup temp DB
  const fs = await import('fs');
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch {}
});

// ---------------------------------------------------------------------------
// 1. SIGNUP via OAuth token endpoint
// ---------------------------------------------------------------------------
describe('POST /api/auth/oauth/token (grant_type=signup)', () => {
  it('creates a new account and returns access + refresh tokens', async () => {
    const res = await post('/api/auth/oauth/token', {
      grant_type: 'signup',
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      firstName: 'Test',
      lastName: 'User',
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();
    expect(res.body.expires_in).toBeGreaterThan(0);
    expect(res.body.profile).toBeTruthy();
    expect(res.body.profile.email).toBe(TEST_EMAIL);
  });

  it('rejects duplicate email signup', async () => {
    const res = await post('/api/auth/oauth/token', {
      grant_type: 'signup',
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      firstName: 'Test',
      lastName: 'User',
    });

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('account_exists');
  });

  it('rejects weak passwords', async () => {
    const res = await post('/api/auth/oauth/token', {
      grant_type: 'signup',
      email: `weak-${RUN_ID}@test.local`,
      password: WEAK_PASSWORD,
      firstName: 'Weak',
      lastName: 'Pass',
    });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('weak_password');
  });

  it('rejects invalid email format', async () => {
    const res = await post('/api/auth/oauth/token', {
      grant_type: 'signup',
      email: 'not-an-email',
      password: TEST_PASSWORD,
      firstName: 'Bad',
      lastName: 'Email',
    });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('invalid_email');
  });

  it('rejects signup without required fields', async () => {
    const res = await post('/api/auth/oauth/token', {
      grant_type: 'signup',
      email: `missing-${RUN_ID}@test.local`,
      password: TEST_PASSWORD,
      // firstName and lastName missing
    });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('missing_fields');
  });
});

// ---------------------------------------------------------------------------
// 2. LOGIN via OAuth token endpoint
// ---------------------------------------------------------------------------
describe('POST /api/auth/oauth/token (grant_type=password)', () => {
  it('authenticates with correct credentials and returns tokens', async () => {
    const res = await post('/api/auth/oauth/token', {
      grant_type: 'password',
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();
    expect(res.body.expires_in).toBeGreaterThan(0);
    expect(res.body.profile.email).toBe(TEST_EMAIL);
  });

  it('rejects wrong password', async () => {
    const res = await post('/api/auth/oauth/token', {
      grant_type: 'password',
      email: TEST_EMAIL,
      password: 'WrongPassword!123',
    });

    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('rejects non-existent user', async () => {
    const res = await post('/api/auth/oauth/token', {
      grant_type: 'password',
      email: `no-such-user-${RUN_ID}@test.local`,
      password: TEST_PASSWORD,
    });

    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('rejects missing email', async () => {
    const res = await post('/api/auth/oauth/token', {
      grant_type: 'password',
      password: TEST_PASSWORD,
    });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('rejects missing password', async () => {
    const res = await post('/api/auth/oauth/token', {
      grant_type: 'password',
      email: TEST_EMAIL,
    });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. TOKEN REFRESH
// ---------------------------------------------------------------------------
describe('POST /api/auth/oauth/token (grant_type=refresh_token)', () => {
  let validRefreshToken;
  let validAccessToken;

  beforeEach(async () => {
    // Get fresh tokens
    const res = await post('/api/auth/oauth/token', {
      grant_type: 'password',
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    validRefreshToken = res.body.refresh_token;
    validAccessToken = res.body.access_token;
  });

  it('issues new access token with valid refresh token', async () => {
    const res = await post('/api/auth/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: validRefreshToken,
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.expires_in).toBeGreaterThan(0);
    // New access token should differ from the old one
    expect(res.body.access_token).not.toBe(validAccessToken);
  });

  it('rotates the refresh token (old one becomes invalid)', async () => {
    // First refresh — succeeds
    const res1 = await post('/api/auth/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: validRefreshToken,
    });
    expect(res1.status).toBe(200);
    const newRefreshToken = res1.body.refresh_token;

    // Second refresh with OLD token — must fail (rotation)
    const res2 = await post('/api/auth/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: validRefreshToken,
    });
    expect(res2.status).toBe(401);
    expect(res2.body.error).toBe('invalid_refresh_token');

    // Third refresh with NEW token — succeeds
    const res3 = await post('/api/auth/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: newRefreshToken,
    });
    expect(res3.status).toBe(200);
    expect(res3.body.access_token).toBeTruthy();
  });

  it('rejects invalid refresh token', async () => {
    const res = await post('/api/auth/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: 'totally-fake-refresh-token',
    });

    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('invalid_refresh_token');
  });

  it('rejects missing refresh token', async () => {
    const res = await post('/api/auth/oauth/token', {
      grant_type: 'refresh_token',
    });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. ACCESS TOKEN VALIDATION (protected resource)
// ---------------------------------------------------------------------------
describe('GET /api/auth/oauth/userinfo', () => {
  let accessToken;

  beforeEach(async () => {
    const res = await post('/api/auth/oauth/token', {
      grant_type: 'password',
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    accessToken = res.body.access_token;
  });

  it('returns user info with valid Bearer token', async () => {
    const res = await get('/api/auth/oauth/userinfo', {
      cookie: '',
    });
    // Use Authorization header instead
    const res2 = await new Promise((resolve, reject) => {
      const url = new URL('/api/auth/oauth/userinfo', baseUrl);
      http.get(url, { headers: { Authorization: `Bearer ${accessToken}` } }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: r.statusCode, body: JSON.parse(raw) });
        });
      }).on('error', reject);
    });

    expect(res2.status).toBe(200);
    expect(res2.body.ok).toBe(true);
    expect(res2.body.profile.email).toBe(TEST_EMAIL);
    expect(res2.body.profile.firstName).toBe('Test');
    expect(res2.body.profile.lastName).toBe('User');
  });

  it('rejects request without token', async () => {
    const res = await get('/api/auth/oauth/userinfo');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('missing_token');
  });

  it('rejects expired access token', async () => {
    // Wait for the access token to expire (5s TTL in test config)
    await new Promise((r) => setTimeout(r, 6000));

    const res = await new Promise((resolve, reject) => {
      const url = new URL('/api/auth/oauth/userinfo', baseUrl);
      http.get(url, { headers: { Authorization: `Bearer ${accessToken}` } }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: r.statusCode, body: JSON.parse(raw) });
        });
      }).on('error', reject);
    });

    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('token_expired');
  });

  it('rejects malformed Bearer token', async () => {
    const res = await new Promise((resolve, reject) => {
      const url = new URL('/api/auth/oauth/userinfo', baseUrl);
      http.get(url, { headers: { Authorization: 'Bearer garbage.token.here' } }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: r.statusCode, body: JSON.parse(raw) });
        });
      }).on('error', reject);
    });

    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. TOKEN REVOCATION
// ---------------------------------------------------------------------------
describe('POST /api/auth/oauth/revoke', () => {
  it('revokes a refresh token so it can no longer be used', async () => {
    const login = await post('/api/auth/oauth/token', {
      grant_type: 'password',
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    const refreshToken = login.body.refresh_token;

    // Revoke it
    const revoke = await post('/api/auth/oauth/revoke', {
      token: refreshToken,
    });
    expect(revoke.status).toBe(200);
    expect(revoke.body.ok).toBe(true);

    // Try to use the revoked token
    const refresh = await post('/api/auth/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    expect(refresh.status).toBe(401);
    expect(refresh.body.error).toBe('invalid_refresh_token');
  });

  it('returns 200 even for unknown tokens (safe revocation)', async () => {
    const res = await post('/api/auth/oauth/revoke', {
      token: 'non-existent-token-value',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. INVALID GRANT TYPE
// ---------------------------------------------------------------------------
describe('POST /api/auth/oauth/token (invalid grant_type)', () => {
  it('rejects unsupported grant type', async () => {
    const res = await post('/api/auth/oauth/token', {
      grant_type: 'client_credentials',
    });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('unsupported_grant_type');
  });

  it('rejects missing grant type', async () => {
    const res = await post('/api/auth/oauth/token', {});

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('unsupported_grant_type');
  });
});

// ---------------------------------------------------------------------------
// 7. BACKWARDS COMPATIBILITY — existing session cookie still works
// ---------------------------------------------------------------------------
describe('backwards compatibility with cookie sessions', () => {
  it('OAuth login also sets a session cookie', async () => {
    const res = await post('/api/auth/oauth/token', {
      grant_type: 'password',
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });

    expect(res.status).toBe(200);
    expect(res.cookies.gp_session).toBeTruthy();
  });

  it('session cookie from OAuth login works with /api/auth/session', async () => {
    const login = await post('/api/auth/oauth/token', {
      grant_type: 'password',
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });

    const sessionCookie = cookieHeader({ gp_session: login.cookies.gp_session });
    const session = await get('/api/auth/session', { cookie: sessionCookie });

    expect(session.status).toBe(200);
    expect(session.body.ok).toBe(true);
    expect(session.body.authenticated).toBe(true);
    expect(session.body.profile.email).toBe(TEST_EMAIL);
  });
});

// ---------------------------------------------------------------------------
// 8. PASSWORD CHANGE INVALIDATES REFRESH TOKENS
// ---------------------------------------------------------------------------
describe('password change invalidates refresh tokens', () => {
  const PC_EMAIL = `pwchange-${RUN_ID}@gplink-test.local`;
  const PC_PASSWORD = 'OriginalP@ss1234!';
  const PC_NEW_PASSWORD = 'NewSecureP@ss5678!';
  let sessionCookie;

  beforeAll(async () => {
    // Create the test account
    const signup = await post('/api/auth/oauth/token', {
      grant_type: 'signup',
      email: PC_EMAIL,
      password: PC_PASSWORD,
      firstName: 'PwChange',
      lastName: 'Test',
    });
    expect(signup.status).toBe(200);
  });

  it('revokes all refresh tokens when password is changed via set-password', async () => {
    // Login and get tokens
    const login = await post('/api/auth/oauth/token', {
      grant_type: 'password',
      email: PC_EMAIL,
      password: PC_PASSWORD,
    });
    expect(login.status).toBe(200);
    const refreshToken = login.body.refresh_token;
    sessionCookie = cookieHeader({ gp_session: login.cookies.gp_session });

    // Change password
    const change = await post('/api/auth/set-password', {
      currentPassword: PC_PASSWORD,
      newPassword: PC_NEW_PASSWORD,
    }, { cookie: sessionCookie });
    expect(change.status).toBe(200);
    expect(change.body.ok).toBe(true);

    // Old refresh token must now be rejected
    const refresh = await post('/api/auth/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    expect(refresh.status).toBe(401);
    expect(refresh.body.error).toBe('invalid_refresh_token');
  });

  it('revokes multiple outstanding refresh tokens on password change', async () => {
    // Login twice to create two refresh tokens
    const login1 = await post('/api/auth/oauth/token', {
      grant_type: 'password',
      email: PC_EMAIL,
      password: PC_NEW_PASSWORD,
    });
    const login2 = await post('/api/auth/oauth/token', {
      grant_type: 'password',
      email: PC_EMAIL,
      password: PC_NEW_PASSWORD,
    });
    expect(login1.status).toBe(200);
    expect(login2.status).toBe(200);
    const rt1 = login1.body.refresh_token;
    const rt2 = login2.body.refresh_token;
    sessionCookie = cookieHeader({ gp_session: login1.cookies.gp_session });

    // Change password again
    const change = await post('/api/auth/set-password', {
      currentPassword: PC_NEW_PASSWORD,
      newPassword: PC_PASSWORD, // swap back
    }, { cookie: sessionCookie });
    expect(change.status).toBe(200);

    // Both old refresh tokens must be rejected
    const r1 = await post('/api/auth/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: rt1,
    });
    expect(r1.status).toBe(401);

    const r2 = await post('/api/auth/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: rt2,
    });
    expect(r2.status).toBe(401);
  });

  it('clears session cookie on password change', async () => {
    const login = await post('/api/auth/oauth/token', {
      grant_type: 'password',
      email: PC_EMAIL,
      password: PC_PASSWORD,
    });
    sessionCookie = cookieHeader({ gp_session: login.cookies.gp_session });

    const change = await post('/api/auth/set-password', {
      currentPassword: PC_PASSWORD,
      newPassword: PC_NEW_PASSWORD,
    }, { cookie: sessionCookie });
    expect(change.status).toBe(200);

    // Response should clear the session cookie
    expect(change.cookies.gp_session).toBeDefined();
    // The cleared cookie value should be empty (Max-Age=0)
    const rawSetCookie = change.headers['set-cookie'];
    const cookieStr = Array.isArray(rawSetCookie) ? rawSetCookie.join('; ') : rawSetCookie || '';
    expect(cookieStr).toContain('Max-Age=0');
  });
});

// ---------------------------------------------------------------------------
// 9. PASSWORD RESET REQUEST DOES NOT PREMATURELY REVOKE TOKENS
// ---------------------------------------------------------------------------
describe('password reset request does not prematurely revoke tokens', () => {
  const PR_EMAIL = `pwreset-${RUN_ID}@gplink-test.local`;
  const PR_PASSWORD = 'ResetTestP@ss1234!';

  beforeAll(async () => {
    const signup = await post('/api/auth/oauth/token', {
      grant_type: 'signup',
      email: PR_EMAIL,
      password: PR_PASSWORD,
      firstName: 'Reset',
      lastName: 'Test',
    });
    expect(signup.status).toBe(200);
  });

  it('refresh token survives a password reset request', async () => {
    // Login to get refresh token
    const login = await post('/api/auth/oauth/token', {
      grant_type: 'password',
      email: PR_EMAIL,
      password: PR_PASSWORD,
    });
    expect(login.status).toBe(200);
    const refreshToken = login.body.refresh_token;

    // Request password reset (local DB will log the token)
    const resetReq = await post('/api/auth/request-password-reset', {
      email: PR_EMAIL,
    });
    expect(resetReq.status).toBe(200);

    // Verify the refresh token still works (reset was only requested, not completed)
    const r1 = await post('/api/auth/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    expect(r1.status).toBe(200);
  });
});
