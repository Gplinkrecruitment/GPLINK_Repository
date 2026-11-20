// WP-09: the practice-facing candidate introduction for an OVERSEAS doctor is
// byte-identical to what it was before WP-09.
//
// tests/fixtures/au-wp09-overseas-intro-snapshot.json was written from the
// UNTOUCHED tree (commit aad17b6f, before any WP-09 change) by running this
// file with WP09_WRITE_SNAPSHOT=1. It holds, for six representative overseas
// doctors, everything a practice receives when staff submit them:
//   - the introduction email as handed to Resend (to, cc, subject, html, text,
//     attachment names),
//   - the WhatsApp template name and the values filled into it,
//   - the decision page's payload.
// Every run compares all of it, byte for byte, with the switch ON (nothing
// recorded = overseas) and with the switch OFF.
//
// Do NOT regenerate the snapshot to make this pass. A difference here means an
// overseas doctor's introduction changed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildAuDoctor } = require('./helpers/au-fixtures.js');
const { bootIntroRig } = require('./helpers/au-wp09-intro-rig.js');

const SNAPSHOT_FILE = path.join(__dirname, 'fixtures', 'au-wp09-overseas-intro-snapshot.json');
const WRITE = process.env.WP09_WRITE_SNAPSHOT === '1';

function ob(extra) {
  return Object.assign({ completedAt: '2026-10-02T00:00:00.000Z', step: 5 }, extra || {});
}

// Six overseas doctors. None has a pathway recorded except the Irish one,
// whose pathway staff recorded as overseas_esp.
const DOCTORS = {
  uk_esp: buildAuDoctor('overseas_null', {
    state: { gp_onboarding: ob({ country: 'GB', targetDate: '2027-03', qualDocs: { mrcgp_cert: true } }) }
  }),
  ie: buildAuDoctor('overseas_explicit', {
    state: { gp_onboarding: ob({ country: 'IE', targetDate: '2027-05', qualDocs: { micgp_cert: true } }) }
  }),
  nz: buildAuDoctor('overseas_null', {
    idSuffix: '3',
    profile: { first_name: 'Test', last_name: 'Nzgp', registration_country: 'New Zealand', qualification_country: 'NZ',
      target_arrival_date: '2027-08', gmc_number: '', register_body: 'mcnz', register_number: '90001', register_status: 'verified' },
    state: { gp_onboarding: ob({ country: 'NZ', targetDate: '2027-08', qualDocs: { frnzcgp_cert: true } }) }
  }),
  pep: buildAuDoctor('overseas_null', {
    idSuffix: '4',
    profile: { first_name: 'Test', last_name: 'Pepgp', account_status: 'pep_waitlist', register_status: 'pending', target_arrival_date: '2027-11' },
    state: { account_status: 'pep_waitlist', gp_onboarding: ob({ country: 'GB', targetDate: '2027-11', specialty: 'General Practice' }) }
  }),
  bare: buildAuDoctor('overseas_null', {
    idSuffix: '5',
    profile: { first_name: '', last_name: '', registration_country: '', qualification_country: '', target_arrival_date: '',
      gmc_number: '', register_body: null, register_number: null, register_status: null },
    state: { gp_onboarding: {} }
  }),
  uk_with_cv: buildAuDoctor('overseas_null', {
    idSuffix: '6',
    profile: { first_name: 'Dr Test', last_name: 'Cvgp' },
    state: { gp_onboarding: ob({ country: 'uk', targetDate: '2027-01-15', qualDocs: { mrcgp_certified: true } }) }
  })
};
const KEYS = Object.keys(DOCTORS);

function capture(out) {
  const e = out.email || {};
  return {
    status: out.status,
    submission_mode: out.json && out.json.submission_mode,
    responseKeys: out.json ? Object.keys(out.json).sort() : [],
    emailCount: out.emails.length,
    email: {
      from: e.from, to: e.to, cc: e.cc === undefined ? null : e.cc, subject: e.subject, html: e.html, text: e.text,
      attachments: Array.isArray(e.attachments) ? e.attachments.map((a) => ({ filename: a.filename, bytes: String(a.content || '').length })) : null
    },
    whatsappCount: out.whatsapps.length,
    whatsapp: out.whatsapp,
    decisionStatus: out.decisionStatus,
    decision: out.decision
  };
}

let rig;
const taken = { on: {}, off: {} };

beforeAll(async () => {
  rig = await bootIntroRig({
    name: 'wp09-parity',
    doctors: KEYS.map((k) => DOCTORS[k]),
    tables: {
      user_documents: [{
        id: 'doc-wp09-cv', user_id: DOCTORS.uk_with_cv.userId, document_key: 'career_cv', status: 'uploaded',
        storage_bucket: 'gp-link-documents', storage_path: 'account-career/uk/test/career_cv/test-cv.pdf',
        file_name: 'Test-Cvgp-CV.pdf', mime_type: 'application/pdf', updated_at: '2026-10-03T00:00:00.000Z'
      }]
    }
  });
  for (const mode of ['on', 'off']) {
    rig.setSwitch(mode === 'on');
    for (const k of KEYS) {
      rig.resetApplication(DOCTORS[k]);
      taken[mode][k] = capture(await rig.introduce(DOCTORS[k]));
    }
  }
  rig.setSwitch(true);
  if (WRITE) {
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(taken.off, null, 2) + '\n');
  }
}, 120000);

afterAll(async () => { if (rig) await rig.close(); });

describe('WP-09: an overseas doctor is introduced to a practice exactly as before', () => {
  const snapshot = fs.existsSync(SNAPSHOT_FILE) ? JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')) : {};

  it('the snapshot covers all six doctors and every send really happened', () => {
    expect(Object.keys(snapshot).sort()).toEqual(KEYS.slice().sort());
    KEYS.forEach((k) => {
      expect(snapshot[k].status).toBe(200);
      expect(snapshot[k].emailCount).toBe(1);
      expect(snapshot[k].whatsappCount).toBe(1);
      expect(snapshot[k].decisionStatus).toBe(200);
      expect(String(snapshot[k].email.html).length).toBeGreaterThan(500);
    });
    // The snapshot is today's overseas wording, not something neutral.
    expect(snapshot.uk_esp.email.text).toContain('internationally trained GP from the United Kingdom');
    expect(snapshot.uk_esp.email.text).toContain('Expedited Specialist Pathway');
    expect(snapshot.pep.email.text).toContain('Practice Experience Program (PEP) pathway');
    expect(snapshot.uk_with_cv.email.attachments).toHaveLength(1);
  });

  KEYS.forEach((k) => {
    it(k + ': switch ON, nothing Australian recorded: identical email, WhatsApp and decision payload', () => {
      expect(taken.on[k]).toEqual(snapshot[k]);
      expect(JSON.stringify(taken.on[k])).toBe(JSON.stringify(snapshot[k]));
    });
    it(k + ': switch OFF: identical email, WhatsApp and decision payload', () => {
      expect(taken.off[k]).toEqual(snapshot[k]);
      expect(JSON.stringify(taken.off[k])).toBe(JSON.stringify(snapshot[k]));
    });
  });
});
