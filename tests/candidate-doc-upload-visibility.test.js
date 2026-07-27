// Why this file exists (2026-07-28): the "upload into Prepared by Candidate"
// controls shipped on 2026-07-27, but the owner still saw document cards with no
// upload button a day later and asked whether a REJECTED document blocks manual
// upload. It does not — nothing in the render path or the endpoints looks at
// status. The cards were stale HTML: sw.js serves page documents
// stale-while-revalidate from VERSION-keyed caches, and the 07-27 deploy changed
// pages/admin.html without bumping VERSION, so browsers kept the pre-deploy
// console until their NEXT navigation.
//
// So these tests pin the two things that were actually wrong:
//   1. staff consoles must never be served from the service-worker cache, and
//   2. the upload control must render for EVERY document status, rejected included.
//
// (2) executes the real card renderers lifted out of the pages — there is no jsdom
// in this repo, so inline page functions are extracted and built with new Function.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Pull `function <name>(...) { ... }` out of a page by counting braces.
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function not found: ' + name);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name);
}

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const docStatusLabel = (s) => String(s || 'Pending');
const stamp = () => '8d ago';

const ALL_STATUSES = ['pending', 'uploaded', 'under_review', 'approved', 'rejected', 'needs_correction', 'accepted'];

describe('service worker never serves a stale staff console', () => {
  const sw = read('sw.js');

  it('recognises the admin + CEO consoles as staff pages', () => {
    expect(sw).toMatch(/function isStaffConsolePage/);
    const fn = new Function(extractFunction(sw, 'isStaffConsolePage') + '; return isStaffConsolePage;')();
    // Clean URLs, .html variants and the sibling admin pages all bypass the cache.
    for (const p of ['/pages/admin', '/pages/admin.html', '/pages/admin-signin', '/pages/admin-visa',
      '/pages/admin-pbs', '/pages/ceo-dashboard', '/pages/ceo-dashboard.html']) {
      expect(isStaff(fn, p), p).toBe(true);
    }
    // GP-facing pages keep the fast cached paint.
    for (const p of ['/pages/app-shell', '/pages/career', '/pages/my-documents', '/pages/index.html']) {
      expect(isStaff(fn, p), p).toBe(false);
    }
  });

  function isStaff(fn, pathname) {
    return fn({ pathname });
  }

  it('bypasses the worker for staff consoles BEFORE the page-cache branch', () => {
    const bypass = sw.indexOf('if (isStaffConsolePage(url)) return;');
    const pageBranch = sw.indexOf('if (isPageDocument(request, url))');
    expect(bypass).toBeGreaterThan(-1);
    expect(pageBranch).toBeGreaterThan(-1);
    // Order matters: after the page branch it would never run.
    expect(bypass).toBeLessThan(pageBranch);
  });

  it('bumps the cache VERSION so already-cached consoles are purged', () => {
    const version = /var VERSION = "([^"]+)"/.exec(sw);
    expect(version).toBeTruthy();
    // The stale console the owner hit was cached under 20260724c.
    expect(version[1] > '20260724c').toBe(true);
  });
});

describe('RSO console: Prepared by Candidate cards can always be uploaded to', () => {
  const admin = read('pages/admin.html');
  const render = new Function('esc', 'escAttr', 'fmtR', 'docStatusLabel',
    extractFunction(admin, 'renderDocPlaceholderCard') + '; return renderDocPlaceholderCard;'
  )(esc, esc, stamp, docStatusLabel);

  it('offers the upload control for every status, rejected included', () => {
    for (const status of ALL_STATUSES) {
      const html = render({ key: 'primary_medical_degree', label: 'Primary medical degree', file_name: 'degree.pdf', updated_at: '2026-07-20T00:00:00Z' }, status, 'case-1');
      expect(html, status).toContain('data-candidate-doc-upload="primary_medical_degree"');
    }
  });

  it('says Upload on an empty slot and Replace once a file is there', () => {
    expect(render({ key: 'cv_signed_dated', label: 'Signed CV' }, 'pending', 'case-1')).toContain('+ Upload');
    expect(render({ key: 'cv_signed_dated', label: 'Signed CV', file_name: 'cv.pdf' }, 'rejected', 'case-1')).toContain('↑ Replace');
  });

  it('tells staff that uploading over a rejected slot clears the rejection', () => {
    const html = render({ key: 'cv_signed_dated', label: 'Signed CV', file_name: 'cv.pdf' }, 'rejected', 'case-1');
    expect(html).toMatch(/clears the rejection/);
  });
});

describe('CEO console: Prepared by Candidate cards can be uploaded to as well', () => {
  const ceo = read('pages/ceo-dashboard.html');
  const render = new Function('esc', 'escAttr', 'relativeTime', 'docStatusLabel',
    extractFunction(ceo, 'renderCeoCandidateDocCard') + '; return renderCeoCandidateDocCard;'
  )(esc, esc, stamp, docStatusLabel);

  it('offers the upload control for every status, rejected included', () => {
    for (const status of ALL_STATUSES) {
      const html = render({ key: 'mrcgp_certificate', label: 'MRCGP certificate', file_name: 'm.pdf', status }, 'case-1');
      expect(html, status).toContain('data-ceo-candidate-doc-upload="mrcgp_certificate"');
    }
  });

  it('tells staff that uploading over a rejected slot clears the rejection', () => {
    const html = render({ key: 'mrcgp_certificate', label: 'MRCGP certificate', file_name: 'm.pdf', status: 'rejected' }, 'case-1');
    expect(html).toMatch(/clears the rejection/);
    expect(html).toContain('↑ Replace');
  });

  it('is wired to a handler that uses the same two endpoints as the RSO console', () => {
    expect(ceo).toMatch(/data-ceo-candidate-doc-upload\]/);
    expect(ceo).toMatch(/ceoCandidateDocUpload\(/);
    const handler = extractFunction(ceo, 'ceoCandidateDocUpload');
    expect(handler).toContain('/api/admin/candidate-doc/sign-upload');
    expect(handler).toContain('/api/admin/candidate-doc/finalize');
    // Direct-to-Storage PUT: a multi-MB scan can't go through the JSON body.
    expect(handler).toMatch(/method:\s*'PUT'/);
  });
});
