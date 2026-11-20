// WP-02: two things checked by reading files rather than booting the server.
//
//   1. js/au-pathway.js, the small page helper (GPAuPathway.enabled() / .mine()):
//      run in a sandbox with a fake fetch. Safe default is OFF / overseas.
//   2. The migration SQL and docs/au-gp/CONVENTIONS.md: a lint of the things
//      that have bitten this project before (not idempotent, not
//      schema-qualified for exec_sql's empty search_path, a default that
//      rewrites a table, a destructive statement), and that the documented
//      column inventory matches the code. There is no Postgres here: this does
//      NOT prove the SQL runs. The lead runs it on the local stack.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const ROOT = path.resolve(__dirname, '..');
const gc = require('../lib/gp-credentials.js');
const cp = require('../lib/candidate-pathway.js');
const { WP02_NEW_COLUMN_NAMES } = require('./helpers/au-fixtures.js');

const HELPER_SRC = fs.readFileSync(path.join(ROOT, 'js/au-pathway.js'), 'utf8');
const OVERSEAS = { pathway: 'overseas_esp', segment: 'overseas', isAu: false, launched: true };

// Load a fresh copy of the helper with a fake window.fetch. `routes` maps a
// URL to a body, a { status, body } pair, or the string 'throw'.
function loadHelper(routes) {
  const calls = [];
  const windowObj = {
    fetch: (url, init) => {
      calls.push({ url, init });
      const r = routes[url];
      if (r === 'throw') return Promise.reject(new Error('network down'));
      if (r === undefined) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
      const status = r && r.status ? r.status : 200;
      const body = r && r.status ? r.body : r;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => (body === 'not-json' ? Promise.reject(new Error('bad json')) : Promise.resolve(body))
      });
    }
  };
  const sandbox = { window: windowObj, Promise, Object, JSON };
  vm.runInNewContext(HELPER_SRC, sandbox, { filename: 'au-pathway.js' });
  return { au: windowObj.GPAuPathway, calls };
}

describe('js/au-pathway.js (GPAuPathway)', () => {
  it('before init: switch off, doctor overseas, not ready', () => {
    const { au, calls } = loadHelper({});
    expect(au.ready()).toBe(false);
    expect(au.enabled()).toBe(false);
    expect(au.mine()).toEqual(OVERSEAS);
    expect(calls).toEqual([]);
  });

  it('switch off: one small public request, the session is never asked', async () => {
    const { au, calls } = loadHelper({ '/api/public/features': { ok: true, auPathwayEnabled: false } });
    const out = await au.init();
    expect(out).toBe(au);
    expect(au.ready()).toBe(true);
    expect(au.enabled()).toBe(false);
    expect(au.mine()).toEqual(OVERSEAS);
    expect(calls.map((c) => c.url)).toEqual(['/api/public/features']);
  });

  it('switch on, Australian doctor: enabled, and mine() is the doctor\'s own pathway', async () => {
    const { au, calls } = loadHelper({
      '/api/public/features': { ok: true, auPathwayEnabled: true },
      '/api/auth/session': { ok: true, authenticated: true, profile: {}, auPathwayEnabled: true, auPathway: { pathway: 'au_vr', segment: 'A', isAu: true, launched: true } }
    });
    await au.init();
    expect(au.enabled()).toBe(true);
    expect(au.mine()).toEqual({ pathway: 'au_vr', segment: 'A', isAu: true, launched: true });
    expect(calls.map((c) => c.url)).toEqual(['/api/public/features', '/api/auth/session']);
    expect(calls[1].init.credentials).toBe('same-origin');
    // mine() hands out a copy: a page cannot corrupt the shared answer.
    au.mine().pathway = 'overseas_esp';
    expect(au.mine().pathway).toBe('au_vr');
  });

  it('segments B and C come through as not launched', async () => {
    for (const [pathway, segment] of [['au_restricted', 'B'], ['au_non_vr', 'C'], ['au_registrar', 'C']]) {
      const { au } = loadHelper({
        '/api/public/features': { auPathwayEnabled: true },
        '/api/auth/session': { auPathwayEnabled: true, auPathway: { pathway, segment, isAu: true, launched: false } }
      });
      await au.init();
      expect(au.mine()).toEqual({ pathway, segment, isAu: true, launched: false });
    }
  });

  it('switch on, signed out (401): enabled, doctor overseas', async () => {
    const { au } = loadHelper({
      '/api/public/features': { auPathwayEnabled: true },
      '/api/auth/session': { status: 401, body: { ok: false, authenticated: false } }
    });
    await au.init();
    expect(au.enabled()).toBe(true);
    expect(au.mine()).toEqual(OVERSEAS);
  });

  it('SAFE DEFAULT: any failure leaves the switch off and the doctor overseas', async () => {
    const failures = [
      { '/api/public/features': 'throw' },
      { '/api/public/features': { status: 500, body: {} } },
      { '/api/public/features': 'not-json' },
      { '/api/public/features': { auPathwayEnabled: 'true' } },   // must be a real boolean true
      { '/api/public/features': null },
      {}
    ];
    for (const routes of failures) {
      const { au } = loadHelper(routes);
      await au.init();
      expect(au.ready()).toBe(true);
      expect(au.enabled()).toBe(false);
      expect(au.mine()).toEqual(OVERSEAS);
    }
  });

  it('SAFE DEFAULT: a session that fails, or carries a muddled pathway, reads as overseas', async () => {
    const sessions = [
      'throw',
      { status: 500, body: {} },
      { auPathwayEnabled: true },                                             // no pathway object
      { auPathwayEnabled: true, auPathway: { pathway: 'australia', isAu: true } },   // unknown value
      { auPathwayEnabled: true, auPathway: 'au_vr' },
      { auPathwayEnabled: false, auPathway: { pathway: 'au_vr', segment: 'A', isAu: true, launched: true } },
      { auPathway: { pathway: 'au_vr', segment: 'A', isAu: true, launched: true } }  // an old cached response shape
    ];
    for (const session of sessions) {
      const { au } = loadHelper({ '/api/public/features': { auPathwayEnabled: true }, '/api/auth/session': session });
      await au.init();
      expect(au.mine()).toEqual(OVERSEAS);
    }
  });

  it('the pathway decides segment and isAu, not the flags sent alongside it', async () => {
    const { au } = loadHelper({
      '/api/public/features': { auPathwayEnabled: true },
      '/api/auth/session': { auPathwayEnabled: true, auPathway: { pathway: 'overseas_pep', segment: 'A', isAu: true, launched: false } }
    });
    await au.init();
    expect(au.mine()).toEqual({ pathway: 'overseas_pep', segment: 'overseas', isAu: false, launched: true });
    // An Australian pathway is only "launched" when the server says exactly true.
    const second = loadHelper({
      '/api/public/features': { auPathwayEnabled: true },
      '/api/auth/session': { auPathwayEnabled: true, auPathway: { pathway: 'au_vr' } }
    });
    await second.au.init();
    expect(second.au.mine()).toEqual({ pathway: 'au_vr', segment: 'A', isAu: true, launched: false });
  });

  it('init() is shared between callers; { force: true } asks again', async () => {
    const { au, calls } = loadHelper({ '/api/public/features': { auPathwayEnabled: false } });
    const [a, b] = await Promise.all([au.init(), au.init()]);
    expect(a).toBe(b);
    expect(calls.length).toBe(1);
    await au.init({ force: true });
    expect(calls.length).toBe(2);
  });

  it('its pathway list is the same six values as lib/candidate-pathway.js', () => {
    cp.ALL_PATHWAYS.forEach((p) => {
      expect(HELPER_SRC).toContain(p + ": '" + cp.segmentOf(p) + "'");
    });
    // The documented script tag carries a cache-buster, and CONVENTIONS quotes the same one.
    const tag = HELPER_SRC.match(/\/js\/au-pathway\.js\?v=(\d{8}[a-z])/);
    expect(tag).not.toBe(null);
    const conventions = fs.readFileSync(path.join(ROOT, 'docs/au-gp/CONVENTIONS.md'), 'utf8');
    expect(conventions).toContain('/js/au-pathway.js?v=' + tag[1]);
  });

  it('no page hard-codes the switch: nothing loads the helper yet except by the documented tag', () => {
    const pages = fs.readdirSync(path.join(ROOT, 'pages')).filter((f) => f.endsWith('.html'));
    pages.forEach((f) => {
      const html = fs.readFileSync(path.join(ROOT, 'pages', f), 'utf8');
      const tags = html.match(/au-pathway\.js[^"'\s>]*/g) || [];
      tags.forEach((tagText) => expect(tagText, f).toMatch(/^au-pathway\.js\?v=\d{8}[a-z]$/));
    });
  });
});

describe('migration lint: supabase/migrations/*au_gp_wp02*', () => {
  const dir = path.join(ROOT, 'supabase/migrations');
  const files = fs.readdirSync(dir).filter((f) => /au_gp_wp02/.test(f));
  const raw = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  // The executable part: comment lines removed (the rollback note is comments).
  const sql = raw.split('\n').filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/\s--.*$/, '')).join('\n');
  const lower = sql.toLowerCase();

  it('there is one, and its name carries au_gp', () => {
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^\d{14}_au_gp_wp02_[a-z0-9_]+\.sql$/);
  });

  it('additive only: nothing dropped, renamed, narrowed, rewritten or deleted', () => {
    expect(lower).not.toMatch(/\bdrop\s+(table|column|constraint|index|schema|type|function)\b/);
    expect(lower).not.toMatch(/\brename\b/);
    expect(lower).not.toMatch(/\balter\s+column\b/);
    // No statement that touches existing rows. ("before update on" is the new table's trigger clause.)
    expect(lower).not.toMatch(/\bupdate\s+\S+\s+set\b/);
    expect(lower).not.toMatch(/\b(delete\s+from|truncate|insert\s+into)\b/);
    expect((lower.match(/\bupdate\b/g) || []).length).toBe((lower.match(/before update on public\.gp_credentials/g) || []).length);
    // The only drops are the idempotent "drop ... if exists" before re-creating a policy / trigger on the NEW table.
    const drops = lower.match(/\bdrop\s+\w+[^;]*;/g) || [];
    drops.forEach((d) => expect(d).toMatch(/^drop\s+(policy|trigger)\s+if\s+exists\s+\S+\s+on\s+public\.gp_credentials;$/));
    expect(drops.length).toBe(2);
  });

  it('every column added to an existing table is nullable with no default (no table rewrite, no backfill)', () => {
    const adds = lower.match(/add\s+column\s+if\s+not\s+exists\s+[^,;]+/g) || [];
    expect(adds.length).toBe(WP02_NEW_COLUMN_NAMES.length + 1);   // + registration_cases.pathway
    adds.forEach((a) => {
      expect(a, a).not.toMatch(/not\s+null/);
      expect(a, a).not.toMatch(/\bdefault\b/);
      expect(a, a).not.toMatch(/\bcheck\b|\breferences\b|\bunique\b/);
    });
    expect((lower.match(/add\s+column(?!\s+if\s+not\s+exists)/g) || []).length).toBe(0);
  });

  it('idempotent: create table / index use IF NOT EXISTS, constraints are guarded and added NOT VALID then validated', () => {
    expect((lower.match(/create\s+table(?!\s+if\s+not\s+exists)/g) || []).length).toBe(0);
    expect((lower.match(/create\s+(unique\s+)?index(?!\s+if\s+not\s+exists)/g) || []).length).toBe(0);
    const added = lower.match(/add\s+constraint\s+(\w+)/g) || [];
    expect(added.length).toBe(3);
    added.forEach((a) => {
      const name = a.replace(/add\s+constraint\s+/, '');
      expect(lower).toContain("conname = '" + name + "'");                       // guarded by a pg_constraint lookup
      expect(lower).toMatch(new RegExp('add\\s+constraint\\s+' + name + '[\\s\\S]*?not valid;'));
      expect(lower).toContain('validate constraint ' + name + ';');
    });
  });

  it('runs under exec_sql: everything is schema-qualified and there is no transaction control', () => {
    expect(lower).not.toMatch(/^\s*(begin|commit|rollback)\s*;/m);
    expect(lower).not.toMatch(/set\s+(local\s+)?search_path/);
    (lower.match(/alter\s+table\s+\S+/g) || []).forEach((s) => expect(s).toMatch(/alter\s+table\s+public\./));
    (lower.match(/create\s+table\s+if\s+not\s+exists\s+\S+/g) || []).forEach((s) => expect(s).toMatch(/public\./));
    (lower.match(/\bon\s+(table\s+)?(user_profiles|registration_cases|gp_credentials)\b/g) || []).forEach((s) => expect(s).toBe('never: unqualified table'));
    (lower.match(/references\s+\S+/g) || []).forEach((s) => expect(s).toMatch(/references\s+public\./));
    expect(lower).toContain('execute function public.set_updated_at()');
    expect(lower).toContain('pg_catalog.pg_constraint');
    expect(lower).toContain("pg_catalog.to_regclass('public.");
  });

  it('gp_credentials is service-role only: RLS on, one service_role policy, public grants revoked', () => {
    expect(lower).toContain('alter table public.gp_credentials enable row level security;');
    const policies = lower.match(/create\s+policy[^;]+;/g) || [];
    expect(policies.length).toBe(1);
    expect(policies[0]).toContain("(select auth.role()) = 'service_role'");
    expect(policies[0]).not.toMatch(/\bto\s+(anon|authenticated)\b/);
    expect(lower).toContain('revoke all on table public.gp_credentials from anon, authenticated;');
    expect(lower).toMatch(/user_id uuid primary key references public\.user_profiles\(user_id\) on delete cascade/);
  });

  it('the CHECK lists are exactly the values the code uses', () => {
    const list = (values) => values.map((v) => "'" + v + "'").join(', ');
    expect((lower.replace(/\s+/g, ' ').match(new RegExp(list(cp.ALL_PATHWAYS).replace(/[()]/g, '\\$&'), 'g')) || []).length).toBe(2);   // profile + case
    expect(lower).toContain("candidate_basis in ('overseas', 'australia')");
    expect(lower).toContain('fellowship_type in (' + list(gc.FELLOWSHIP_TYPES) + ')');
    expect(lower).toContain('vr_status in (' + list(gc.VR_STATUSES) + ')');
    expect(lower).toContain('work_rights in (' + list(gc.WORK_RIGHTS) + ')');
    expect(lower).toContain("moratorium_19ab_status in ('yes', 'no', 'unsure')");
    expect(lower).toContain("moratorium_19ab_confirmed_status in ('yes', 'no')");
    // Every CHECK allows NULL, so existing rows (all NULL) pass.
    const checks = lower.match(/\bcheck\s*\(\s*\w+[^;]*?\bin\s*\(/g) || [];
    expect(checks.length).toBe(8);
    checks.forEach((c) => expect(c, c).toMatch(/^check\s*\(\s*\w+ is null or \w+ in\s*\($/));
  });

  it('creates every column the code reads and writes', () => {
    gc.PATHWAY_PROFILE_COLUMNS.concat(gc.PREFERENCE_COLUMNS).forEach((c) => {
      expect(lower, c).toMatch(new RegExp('add column if not exists ' + c + ' '));
    });
    const tableBody = lower.slice(lower.indexOf('create table if not exists public.gp_credentials'), lower.indexOf('alter table public.gp_credentials enable row level security'));
    gc.CREDENTIAL_COLUMNS.forEach((c) => expect(tableBody, c).toMatch(new RegExp('\\n\\s+' + c + ' ')));
    expect(lower).toMatch(/alter table public\.registration_cases\s+add column if not exists pathway text;/);
  });

  it('carries a rollback note, as comments only', () => {
    expect(raw).toMatch(/ROLLBACK NOTE\. DO NOT RUN/);
    expect(raw).toMatch(/--\s+drop table if exists public\.gp_credentials;/);
  });

  it('no stray control characters in the new files', () => {
    const paths = ['lib/candidate-pathway.js', 'lib/gp-credentials.js', 'js/au-pathway.js', 'docs/au-gp/CONVENTIONS.md',
      'tests/helpers/au-fixtures.js', 'tests/helpers/au-supabase-emulator.js', 'tests/helpers/au-server-harness.js']
      .map((p) => path.join(ROOT, p)).concat(files.map((f) => path.join(dir, f)));
    paths.forEach((p) => {
      const text = fs.readFileSync(p, 'utf8');
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 32 && code !== 9 && code !== 10 && code !== 13) throw new Error('control character ' + code + ' in ' + p + ' at ' + i);
      }
    });
  });
});

describe('docs/au-gp/CONVENTIONS.md lists every new column', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/au-gp/CONVENTIONS.md'), 'utf8');

  it('the inventory has a row for each user_profiles, registration_cases and gp_credentials column', () => {
    gc.PATHWAY_PROFILE_COLUMNS.concat(gc.PREFERENCE_COLUMNS).forEach((c) => {
      expect(doc, c).toContain('| `user_profiles` | `' + c + '` |');
    });
    expect(doc).toContain('| `registration_cases` | `pathway` |');
    gc.CREDENTIAL_COLUMNS.forEach((c) => {
      expect(doc, c).toContain('| `gp_credentials` | `' + c + '` |');
    });
    const rows = doc.match(/^\| `(user_profiles|registration_cases|gp_credentials)` \| `\w+` \|/gm) || [];
    expect(rows.length).toBe(gc.PATHWAY_PROFILE_COLUMNS.length + gc.PREFERENCE_COLUMNS.length + 1 + gc.CREDENTIAL_COLUMNS.length);
  });

  it('names every helper a later package needs', () => {
    ['resolveCandidatePathway', 'resolveCandidatePathwayForSession', 'setCandidatePathway', 'upsertGpCredentials',
      'setCandidatePreferences', 'readCandidatePreferences', 'readCandidatePathwayRecords', 'resolvePathwayFromRecords',
      'computeDpaRestricted', 'normalisePathway', 'isAuPathway', 'isOverseasPathway', 'segmentOf', 'isLaunchedAuPathway',
      'feeBasisFor', 'publicPathwayView', 'readAhpraRegistration', 'sanitiseCredentialsPatch', 'sanitisePreferencesPatch',
      'isAuPathwayEnabled', 'isAuSegmentLead', 'auHazelBlocked', 'auMessagesHeld', 'auPathwayOn',
      'GPAuPathway', '/api/public/features', '/api/admin/candidate/pathway', 'admin_set_candidate_pathway',
      'buildAuDoctor', 'bootAuTestServer', 'startAuSupabaseEmulator', 'apply-migrations.sh'
    ].forEach((name) => expect(doc, name).toContain(name));
  });
});
