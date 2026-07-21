// Phase 6 Batch F1, hardening: /api/visa/status must not leak internal admin
// data to the GP session.
//
// The handler used to `select=*` on visa_applications and echo the raw row,
// which exposed the internal `notes` JSONB (admin author emails) and
// `sponsor_contact` to any GP hitting the API directly. It now builds an
// allowlisted response via pickVisaGpFields + the VISA_GP_*_FIELDS lists
// (exported through __testUtils), and sanitizes the related collections too
// (updates/timeline `created_by`, document reviewer identities/storage paths,
// dependant notes). These tests pin both the allowlists and the behaviour.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let utils;
let serverSrc;

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  const mod = await import('../server.js');
  utils = mod.__testUtils;
  serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
});

// A realistic select=* visa_applications row, including the internal fields
// that must never reach a GP.
const RAW_APPLICATION = {
  id: 'case-1',
  user_id: 'user-9',
  job_id: 'job-3',
  visa_subclass: '482',
  visa_type: 'Subclass 482, Temporary Skill Shortage',
  stage: 'lodgement',
  status_message: 'Lodged and waiting on the department.',
  reference_number: 'REF-123',
  sponsor_name: 'Sunrise Family Practice',
  sponsor_status: 'Approved sponsor',
  sponsor_contact: 'practice.manager@sunrise.example (0400 000 000)',
  responsible_party: 'GP Link',
  estimated_timeline: '4-6 weeks',
  current_action_title: 'Department processing',
  current_action_description: 'No action needed from you.',
  current_action_owner: 'Department of Home Affairs',
  current_action_due_date: '2026-08-01',
  nomination_date: '2026-06-01T00:00:00Z',
  lodgement_date: '2026-06-20T00:00:00Z',
  grant_date: null,
  notes: [{ author: 'admin@mygplink.com.au', body: 'internal: chased the lawyer' }],
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-21T00:00:00Z'
};

describe('/api/visa/status, GP application allowlist', () => {
  it('drops internal fields (notes, sponsor_contact, user_id, job_id)', () => {
    const out = utils.pickVisaGpFields(RAW_APPLICATION, utils.VISA_GP_APPLICATION_FIELDS);
    expect(out).not.toHaveProperty('notes');
    expect(out).not.toHaveProperty('sponsor_contact');
    expect(out).not.toHaveProperty('user_id');
    expect(out).not.toHaveProperty('job_id');
    expect(JSON.stringify(out)).not.toContain('admin@mygplink.com.au');
    expect(JSON.stringify(out)).not.toContain('practice.manager@sunrise.example');
  });

  it('keeps every field pages/visa.html renders', () => {
    const out = utils.pickVisaGpFields(RAW_APPLICATION, utils.VISA_GP_APPLICATION_FIELDS);
    // renderVisaStatus() reads exactly these from `application`.
    for (const field of [
      'stage', 'status_message', 'visa_type', 'reference_number',
      'sponsor_name', 'sponsor_status', 'nomination_date', 'lodgement_date',
      'grant_date', 'estimated_timeline', 'current_action_title',
      'current_action_description', 'current_action_owner'
    ]) {
      expect(out[field]).toEqual(RAW_APPLICATION[field]);
    }
    expect(out.id).toBe('case-1');
  });

  it('returns null for a missing application (no-case GPs keep application: null)', () => {
    expect(utils.pickVisaGpFields(null, utils.VISA_GP_APPLICATION_FIELDS)).toBeNull();
  });

  it('omits absent columns rather than fabricating undefined keys', () => {
    const out = utils.pickVisaGpFields({ id: 'x', stage: 'nomination' }, utils.VISA_GP_APPLICATION_FIELDS);
    expect(Object.keys(out).sort()).toEqual(['id', 'stage']);
  });
});

describe('/api/visa/status, related collections drop admin identities', () => {
  it('updates keep body/created_at but drop created_by (admin author)', () => {
    const out = utils.pickVisaGpFields(
      { id: 'u1', visa_case_id: 'case-1', body: 'Lodged today.', visibility: 'gp', created_by: 'admin@mygplink.com.au', created_at: '2026-06-20T00:00:00Z' },
      utils.VISA_GP_UPDATE_FIELDS
    );
    expect(out).toEqual({ id: 'u1', body: 'Lodged today.', created_at: '2026-06-20T00:00:00Z' });
  });

  it('timeline events drop created_by', () => {
    const out = utils.pickVisaGpFields(
      { id: 't1', event_title: 'Nomination approved', event_description: 'Step done', visible_to_gp: true, created_by: 'admin@mygplink.com.au', created_at: '2026-06-10T00:00:00Z' },
      utils.VISA_GP_TIMELINE_FIELDS
    );
    expect(out).not.toHaveProperty('created_by');
    expect(out.event_title).toBe('Nomination approved');
  });

  it('documents drop reviewer identity and internal storage path', () => {
    const out = utils.pickVisaGpFields(
      { id: 'd1', document_type: 'passport', file_path: 'internal/bucket/path.pdf', status: 'approved', rejection_reason: null, original_file_name: 'passport.pdf', verified: true, uploaded_by_user_id: 'user-9', reviewed_by: 'admin@mygplink.com.au', reviewed_at: '2026-06-11T00:00:00Z', uploaded_at: '2026-06-10T00:00:00Z' },
      utils.VISA_GP_DOCUMENT_FIELDS
    );
    expect(out).not.toHaveProperty('file_path');
    expect(out).not.toHaveProperty('reviewed_by');
    expect(out).not.toHaveProperty('uploaded_by_user_id');
    expect(out.document_type).toBe('passport');
    expect(out.status).toBe('approved');
  });

  it('dependants drop internal notes', () => {
    const out = utils.pickVisaGpFields(
      { id: 'dep1', full_name: 'Jane Doe', relationship: 'spouse', date_of_birth: '1990-01-01', passport_number: 'X123', passport_country: 'UK', visa_status: 'included', notes: 'admin-only note', created_at: '2026-06-01T00:00:00Z' },
      utils.VISA_GP_DEPENDANT_FIELDS
    );
    expect(out).not.toHaveProperty('notes');
    expect(out.full_name).toBe('Jane Doe');
  });
});

describe('server.js, the handler actually uses the allowlists', () => {
  it('sanitizes the /api/visa/status response instead of echoing raw rows', () => {
    const handler = serverSrc.slice(serverSrc.indexOf("pathname === '/api/visa/status'"));
    const block = handler.slice(0, handler.indexOf('/api/visa/update'));
    expect(block).toContain('pickVisaGpFields(application, VISA_GP_APPLICATION_FIELDS)');
    expect(block).toContain('pickVisaGpFields(u, VISA_GP_UPDATE_FIELDS)');
    expect(block).toContain('pickVisaGpFields(t, VISA_GP_TIMELINE_FIELDS)');
    expect(block).toContain('pickVisaGpFields(d, VISA_GP_DOCUMENT_FIELDS)');
    expect(block).toContain('pickVisaGpFields(dep, VISA_GP_DEPENDANT_FIELDS)');
    // No raw pass-through of the select=* row remains.
    expect(block).not.toMatch(/sendJson\(res, 200, \{ ok: true, application,/);
  });

  it('keeps the existing GP-visibility filters on updates and timeline', () => {
    const handler = serverSrc.slice(serverSrc.indexOf("pathname === '/api/visa/status'"));
    const block = handler.slice(0, handler.indexOf('/api/visa/update'));
    expect(block).toContain('visibility=eq.gp');
    expect(block).toContain('visible_to_gp=eq.true');
  });

  it('never allowlists the internal fields', () => {
    expect(utils.VISA_GP_APPLICATION_FIELDS).not.toContain('notes');
    expect(utils.VISA_GP_APPLICATION_FIELDS).not.toContain('sponsor_contact');
    expect(utils.VISA_GP_UPDATE_FIELDS).not.toContain('created_by');
    expect(utils.VISA_GP_TIMELINE_FIELDS).not.toContain('created_by');
    expect(utils.VISA_GP_DOCUMENT_FIELDS).not.toContain('reviewed_by');
    expect(utils.VISA_GP_DEPENDANT_FIELDS).not.toContain('notes');
  });
});
