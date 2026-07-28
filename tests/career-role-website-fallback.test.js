// Per-clinic practice website (2026-07-29).
//
// A corporate owner such as ForHealth Group is ONE `practices` row shared by
// dozens of individual clinics, so `practices.website` can only ever hold the
// group's site — the clinic the GP was actually matched to keeps its own URL on
// the career_roles row (source_payload.gpLink.websiteUrl, falling back to the
// original job-ad payload).
//
// Before this change the two GP-facing surfaces the owner cares about were
// silent: the direct-match card read `practice.website` ONLY (blank for every
// ForHealth role -> no website button at all), and the placement payload had no
// website field whatsoever. Both now resolve through resolveCareerRoleWebsiteUrl.
//
// Source-regex wiring checks — no server boot needed.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = fs.readFileSync(path.join(here, '..', 'server.js'), 'utf8');
const careerSrc = fs.readFileSync(path.join(here, '..', 'pages', 'career.html'), 'utf8');

describe('per-clinic practice website', () => {
  it('resolveCareerRoleWebsiteUrl reads the ROLE, not the practice row', () => {
    const idx = serverSrc.indexOf('function resolveCareerRoleWebsiteUrl(');
    expect(idx).toBeGreaterThan(-1);
    const fnSrc = serverSrc.slice(idx, idx + 500);
    // curated value wins, raw job-ad payload is the fallback
    expect(fnSrc).toContain('getCareerRoleGpLinkMeta(row)');
    expect(fnSrc).toContain('sanitizeHttpUrl(meta && meta.websiteUrl)');
    expect(fnSrc).toContain('extractCareerWebsiteUrl(getCareerRoleRawPayload(row))');
    // a missing row must not throw — my-matches passes a possibly-absent jobRow
    expect(fnSrc).toContain("if (!row) return '';");
  });

  it('the direct-match card falls back to the clinic website when the owner row has none', () => {
    const idx = serverSrc.indexOf('website: practice.website ||');
    expect(idx).toBeGreaterThan(-1);
    const src = serverSrc.slice(idx, idx + 160);
    expect(src).toContain('resolveCareerRoleWebsiteUrl(jobRow)');
    // the sibling fields on the match card are untouched
    expect(src).toContain('introVideoUrl: practice.intro_video_url');
  });

  it('the placement payload carries the hired clinic website', () => {
    const idx = serverSrc.indexOf('function buildInAppPlacementPayload(');
    expect(idx).toBeGreaterThan(-1);
    const fnSrc = serverSrc.slice(idx, idx + 4000);
    expect(fnSrc).toContain('const practiceWebsite = sanitizeHttpUrl(practice.website) || resolveCareerRoleWebsiteUrl(roleRow)');
    expect(fnSrc).toContain('website: practiceWebsite');
  });

  it('career.html renders the placement website through the http(s) gate and hides it when absent', () => {
    expect(careerSrc).toContain('id="securedPracticeWebsite"');
    expect(careerSrc).toContain('const securedPracticeWebsiteEl = document.getElementById("securedPracticeWebsite");');
    expect(careerSrc).toContain('const securedWebsite = matchSafeUrl(placement.website);');
    // no URL on file -> the anchor is hidden rather than rendered empty
    expect(careerSrc).toContain('securedPracticeWebsiteEl.hidden = true;');
    // and the normalizer actually forwards the server value
    expect(careerSrc).toContain('website: placementPayload.website ||');
  });

  // CEO dashboard -> Jobs tab -> job detail. atsJobCard feeds both the Jobs
  // board and the pipeline endpoint, so resolving it there lights up the meta
  // row under the job title.
  it('atsJobCard exposes the clinic website to the admin Jobs board', () => {
    const idx = serverSrc.indexOf('function atsJobCard(');
    expect(idx).toBeGreaterThan(-1);
    const fnSrc = serverSrc.slice(idx, idx + 2600);
    expect(fnSrc).toContain("website: (p && p.website) ? String(p.website) : resolveCareerRoleWebsiteUrl(job)");
  });

  it('the CEO job-detail meta row renders the website through an http(s) gate', () => {
    const jobsSrc = fs.readFileSync(path.join(here, '..', 'js', 'ceo-ats-jobs.js'), 'utf8');
    expect(jobsSrc).toContain('function boardSafeUrl(');
    expect(jobsSrc).toContain('var website = boardSafeUrl(job.website);');
    expect(jobsSrc).toContain('ats-board-weblink');
    // no website on file -> no empty span injected into the meta row
    expect(jobsSrc).toContain("        : '') +");
    const cssSrc = fs.readFileSync(path.join(here, '..', 'css', 'ceo-ats.css'), 'utf8');
    expect(cssSrc).toContain('.ats-board-weblink');
  });
});
