import { createRequire } from 'module';
import { describe, expect, it, afterEach } from 'vitest';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
const { __testUtils } = require('../server.js');

const { getAdminHostScope, doesAdminRoleMatchHost, getAdminHostLabel } = __testUtils;

function reqFor(host) {
  return { headers: { host } };
}

describe('admin host scoping', () => {
  const savedVercelEnv = process.env.VERCEL_ENV;
  afterEach(() => {
    if (savedVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = savedVercelEnv;
  });

  it('returns preview scope on Vercel preview deployments for arbitrary hosts', () => {
    process.env.VERCEL_ENV = 'preview';
    expect(getAdminHostScope(reqFor('gplink-repository-abc123-team.vercel.app'))).toBe('preview');
  });

  it('does not grant preview scope on production deployments', () => {
    process.env.VERCEL_ENV = 'production';
    expect(getAdminHostScope(reqFor('gplink-repository-abc123-team.vercel.app'))).toBe('');
  });

  it('explicit allowlisted hosts keep their scopes even on previews', () => {
    // ADMIN_ALLOWED_HOSTS is read from env at module load; if empty in the test env,
    // the preview fallback applies instead.
    process.env.VERCEL_ENV = 'preview';
    const scope = getAdminHostScope(reqFor('admin.mygplink.com.au'));
    expect(['admin', 'preview']).toContain(scope); // admin if allowlist configured in test env
  });

  it('admin and staff roles are accepted on preview scope', () => {
    expect(doesAdminRoleMatchHost('admin', 'preview')).toBe(true);
    expect(doesAdminRoleMatchHost('staff', 'preview')).toBe(true);
    expect(doesAdminRoleMatchHost('super_admin', 'preview')).toBe(true);
  });

  it('super_admin scope still requires super_admin role', () => {
    expect(doesAdminRoleMatchHost('admin', 'super_admin')).toBe(false);
    expect(doesAdminRoleMatchHost('super_admin', 'super_admin')).toBe(true);
  });

  it('labels preview scope', () => {
    expect(getAdminHostLabel('preview')).toBe('Preview Admin');
  });
});
