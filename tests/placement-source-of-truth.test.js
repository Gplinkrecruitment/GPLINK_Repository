import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
const lib = require('../lib/practice-contact.js');
const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

// Dr Mercy Obanimoh's real prod shape (2026-08-01): the authoritative application says
// The Doctors Werribee, while her career-state mirror carried Sana Ahsan's Halekulani
// placement — a DIFFERENT practice, contact email and phone.
const REAL_APP = {
  user_id: 'mercy', career_role_id: 93103, practice_id: 'e94d2352',
  practice_contact_name: 'Dr Chamira Ranatunga', practice_contact_email: 'chamiraranatunga@yahoo.com',
  status: 'placement_secured', ats_stage: 'hired',
};
const REAL_ROLE = { id: 93103, practice_name: 'The Doctors Werribee', title: 'General Practitioner', location_city: 'Werribee', location_state: 'VIC' };
const REAL_PRACTICE = { id: 'e94d2352', name: 'The Doctors Werribee', contact_name: 'Dr Chamira Ranatunga', contact_email: 'chamiraranatunga@yahoo.com', contact_phone: '0432608285' };
const WRONG_MIRROR = {
  applications: [{
    isPlacementSecured: true,
    roleId: 'zoho_recruit:11734000000743945',
    placement: {
      practiceName: 'Halekulani Medical Centre',
      practiceContact: { name: 'Tarig Mahmoud', email: 'drtarig@yahoo.co.uk', phone: '+61493844634' },
    },
  }],
};

describe('buildPlacementProfile', () => {
  it('builds the display shape from the owned rows', () => {
    const p = lib.buildPlacementProfile(REAL_APP, REAL_ROLE, REAL_PRACTICE);
    expect(p.practiceName).toBe('The Doctors Werribee');
    expect(p.contactEmail).toBe('chamiraranatunga@yahoo.com');
    expect(p.contactName).toBe('Dr Chamira Ranatunga');
    expect(p.contactPhone).toBe('0432608285');
    expect(p.location).toBe('Werribee, VIC');
    expect(p.roleTitle).toBe('General Practitioner');
  });

  it('falls back to the career role practice name when no practices row is loaded', () => {
    const p = lib.buildPlacementProfile(REAL_APP, REAL_ROLE, null);
    expect(p.practiceName).toBe('The Doctors Werribee');
    expect(p.contactEmail).toBe('chamiraranatunga@yahoo.com');
  });

  it('returns null when there is nothing identifying, so the caller can fall through', () => {
    expect(lib.buildPlacementProfile(null, null, null)).toBeNull();
    expect(lib.buildPlacementProfile({ user_id: 'x' }, null, null)).toBeNull();
  });
});

describe('placementFromCareerStateMirror', () => {
  it('reads the secured placement out of the mirror', () => {
    const m = lib.placementFromCareerStateMirror(WRONG_MIRROR);
    expect(m.practiceName).toBe('Halekulani Medical Centre');
    expect(m.contactEmail).toBe('drtarig@yahoo.co.uk');
  });

  it('returns null when there is no secured placement', () => {
    expect(lib.placementFromCareerStateMirror(null)).toBeNull();
    expect(lib.placementFromCareerStateMirror({})).toBeNull();
    expect(lib.placementFromCareerStateMirror({ applications: [{ isPlacementSecured: false, placement: { practiceName: 'X' } }] })).toBeNull();
    expect(lib.placementFromCareerStateMirror({ applications: [{ isPlacementSecured: true, placement: {} }] })).toBeNull();
  });
});

describe('mergePlacementSources', () => {
  it('the authoritative placement wins outright over a wrong mirror', () => {
    const merged = lib.mergePlacementSources(
      lib.buildPlacementProfile(REAL_APP, REAL_ROLE, REAL_PRACTICE),
      lib.placementFromCareerStateMirror(WRONG_MIRROR));
    expect(merged.practiceName).toBe('The Doctors Werribee');
    expect(merged.contactEmail).toBe('chamiraranatunga@yahoo.com');
  });

  it('NEVER splices the other practice’s details onto the real one', () => {
    // The whole reason the merge is all-or-nothing: a field-by-field merge would take
    // Tarig's phone/name onto The Doctors Werribee, inventing a contact that does not exist.
    const authoritative = lib.buildPlacementProfile(REAL_APP, REAL_ROLE, null); // no phone available
    const merged = lib.mergePlacementSources(authoritative, lib.placementFromCareerStateMirror(WRONG_MIRROR));
    expect(merged.contactPhone).toBe('');
    expect(JSON.stringify(merged)).not.toContain('Tarig');
    expect(JSON.stringify(merged)).not.toContain('drtarig');
    expect(JSON.stringify(merged)).not.toContain('Halekulani');
  });

  it('uses the mirror only when there is no placed application at all', () => {
    const merged = lib.mergePlacementSources(null, lib.placementFromCareerStateMirror(WRONG_MIRROR));
    expect(merged.practiceName).toBe('Halekulani Medical Centre');
  });

  it('returns null when neither source can answer', () => {
    expect(lib.mergePlacementSources(null, null)).toBeNull();
  });
});

describe('server wiring', () => {
  it('the AI summary resolves the practice from the owned rows before the mirror', () => {
    const block = serverSrc.slice(serverSrc.indexOf('let practiceName = regCase.practice_name'));
    const authoritativeAt = block.indexOf('resolvePlacedPracticeProfile(userId)');
    const mirrorAt = block.indexOf('gp_career_state');
    expect(authoritativeAt).toBeGreaterThan(-1);
    expect(mirrorAt).toBeGreaterThan(-1);
    expect(authoritativeAt).toBeLessThan(mirrorAt);
  });

  it('both task-list enrichments use the authoritative-first map builder', () => {
    const uses = serverSrc.match(/buildPracticeContactMap\(\s*\n?\s*await resolvePlacedPracticeProfiles\(userIds\)/g) || [];
    expect(uses.length).toBe(2);
  });

  it('no task-list enrichment seeds its map straight from the mirror any more', () => {
    expect(serverSrc).not.toContain('practiceContactMap[uid] = {');
    expect(serverSrc).not.toContain('practiceContactMap[app.user_id] = {');
  });

  it('the batch resolver chunks its id lookups instead of one oversized in.(...)', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function resolvePlacedPracticeProfiles'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain("supabaseDbRequestByIds('career_roles'");
    expect(body).toContain("supabaseDbRequestByIds('practices'");
  });
});
