// Owner report 2026-08-06 (Dr Deepika's practice page): the revealed page was
// headed "ForHealth Group" while the website beneath it read
// riverlinkmedicalcentre.com.au — the corporation, not the practice.
//
// Root cause is the corporate-group trap already documented for the WEBSITE: a
// corporate owner is ONE `practices` row shared by every clinic under it, so
// `career_roles.practice_name` (and `practices.name`) can only ever hold the
// GROUP. The clinic's own name lives in `career_roles.title`. 48 of the 59 live
// roles sit under ForHealth / GP West / Spectrum, so this was all of them.
//
// The masked card, the match email and the matching board already solved this
// with atsJobDisplayNames; the REVEALED surfaces never called it. These tests
// pin both halves of the fix:
//   A. the revealed name resolves to the clinic, and still falls back to the
//      owner for an ordinary single-practice row (no regression);
//   B. the leak guard no longer has a corporate-group hole — a title that reads
//      as a clinic name is a leak even when practice_name names the GROUP, which
//      is what let 4 live Spectrum roles ship their real clinic name to
//      pre-reveal doctors as the card's "Role type".
import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
const { __testUtils } = require('../server.js');

const {
  resolveCareerRolePracticeName,
  careerRoleTitleLeaksPracticeName,
  mapCareerRoleRowToClient
} = __testUtils;

// Real shapes from prod (2026-08-06).
const FORHEALTH = {
  id: 20,
  provider: 'zoho',
  practice_name: 'ForHealth Group',
  title: 'Riverlink Medical & Dental Centre (Ipswich)',
  masked_title: 'DPA - North Ipswich - Bulk Billing',
  suburb: 'North Ipswich',
  location_state: 'QLD'
};
const GPWEST = {
  id: 42,
  provider: 'zoho',
  practice_name: 'GP West Group',
  title: 'General Practitioner || Wattle Grove Medical Centre',
  masked_title: 'DPA - Wattle Grove - Bulk Billing'
};
const SPECTRUM = {
  id: 93099,
  provider: 'internal_ats',
  practice_name: 'Spectrum Group',
  title: 'Connolly Drive Medical Centre',
  masked_title: 'DPA - Butler - Mixed Billing'
};
const SINGLE_PRACTICE = {
  id: 57,
  provider: 'zoho',
  practice_name: 'Thornton Medical Centre',
  title: 'Thornton Medical Centre || General Practitioner',
  masked_title: 'DPA - Thornton - Bulk Billing'
};

describe('A. revealed practice name — the clinic, never the corporation', () => {
  it('names the clinic for a ForHealth role, not the group', () => {
    expect(resolveCareerRolePracticeName(FORHEALTH, { name: 'ForHealth Group' }))
      .toBe('Riverlink Medical & Dental Centre (Ipswich)');
  });

  it('splits the "||" shape GP West uses and keeps the separator out of GP copy', () => {
    const name = resolveCareerRolePracticeName(GPWEST, { name: 'GP West Group' });
    expect(name).toBe('Wattle Grove Medical Centre');
    expect(name).not.toContain('||');
  });

  it('handles the internal-ATS Spectrum shape (clinic name is the whole title)', () => {
    expect(resolveCareerRolePracticeName(SPECTRUM, { name: 'Spectrum Group' }))
      .toBe('Connolly Drive Medical Centre');
  });

  it('leaves an ordinary single-practice row on its own name', () => {
    expect(resolveCareerRolePracticeName(SINGLE_PRACTICE, { name: 'Thornton Medical Centre' }))
      .toBe('Thornton Medical Centre');
  });

  it('falls back to the owner name when the title carries no clinic', () => {
    expect(resolveCareerRolePracticeName(
      { practice_name: 'The Doctors Werribee', title: 'General Practitioner' }, null
    )).toBe('The Doctors Werribee');
    // and to the practices row when the role column is empty
    expect(resolveCareerRolePracticeName({ title: '' }, { name: 'Erina Medical Centre' }))
      .toBe('Erina Medical Centre');
  });

  it('never returns the bare group name for a corporate role', () => {
    for (const row of [FORHEALTH, GPWEST, SPECTRUM]) {
      expect(resolveCareerRolePracticeName(row, { name: row.practice_name }))
        .not.toBe(row.practice_name);
    }
  });
});

describe('B. leak guard — a clinic name in `title` leaks even under a group owner', () => {
  it('SECURITY: flags a clinic-named title whose practice_name is the CORPORATION', () => {
    // Before the fix this returned false — "Connolly Drive Medical Centre" and
    // "Spectrum Group" share no tokens — so the raw title was judged safe.
    expect(careerRoleTitleLeaksPracticeName(SPECTRUM)).toBe(true);
  });

  it('SECURITY: the masked card shows the masked title, not the clinic', () => {
    const card = mapCareerRoleRowToClient(SPECTRUM);
    expect(card.roleType).toBe('DPA - Butler - Mixed Billing');
    expect(card.roleType).not.toContain('Connolly');
  });

  it('SECURITY: no masked card built from a corporate role names its clinic', () => {
    // NB the suburb is deliberately public (masked_title is
    // "<DPA> - <suburb> - <billing>"), and clinics are often named after their
    // suburb — so the assertion is on the clinic NAME as a whole, not on the
    // individual words it happens to share with the masked title.
    for (const row of [FORHEALTH, GPWEST, SPECTRUM]) {
      const card = mapCareerRoleRowToClient(row);
      const clinic = resolveCareerRolePracticeName(row, null);
      expect(JSON.stringify(card).toLowerCase()).not.toContain(clinic.toLowerCase());
      expect(card.roleType).not.toBe(clinic);
      expect(card.roleType).toBe(row.masked_title);
    }
  });

  it('still keeps a generic role title visible (does not over-mask)', () => {
    expect(careerRoleTitleLeaksPracticeName({
      title: 'General Practitioner', practice_name: 'Spectrum Group'
    })).toBe(false);
    // the masked_title format itself must survive — it is not a clinic name
    expect(careerRoleTitleLeaksPracticeName({
      title: 'DPA - Erina (Central Coast) - Mixed Billing', practice_name: 'Erina Medical Centre'
    })).toBe(false);
  });

  it('keeps flagging the original single-practice leak shape', () => {
    expect(careerRoleTitleLeaksPracticeName(SINGLE_PRACTICE)).toBe(true);
  });
});

describe('wiring — the revealed surfaces call the resolver', () => {
  const fs = require('fs');
  const path = require('path');
  const serverSrc = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');

  it('the revealed job page resolves the clinic rather than reading the raw column', () => {
    expect(serverSrc).toMatch(
      /roleClientPayload\.realPracticeName = resolveCareerRolePracticeName\(finalRoleRow, practiceRow\)/
    );
    expect(serverSrc).not.toMatch(
      /roleClientPayload\.realPracticeName = finalRoleRow\.practice_name/
    );
  });

  it('the placement page and the offer page resolve it too', () => {
    expect(serverSrc).toContain('o.practice_name || resolveCareerRolePracticeName(roleRow, practiceRow)');
    expect(serverSrc).toContain('moOffer.practice_name || resolveCareerRolePracticeName(moRole, moPractice)');
  });

  it('interview reminder emails name the clinic', () => {
    expect(serverSrc).toContain('practiceName: resolveCareerRolePracticeName(irRole, null)');
    expect(serverSrc).toContain('irScPractice = resolveCareerRolePracticeName(irScRole, null)');
  });
});
