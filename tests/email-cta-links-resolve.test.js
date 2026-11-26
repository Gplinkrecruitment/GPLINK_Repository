import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Guards a whole class of silent, user-facing breakage: an email CTA that
// points at a /pages/ file that does not exist.
//
// The bug this was written for: sendOnboardingCompleteEmail's "Start MyIntealth"
// button pointed at /pages/myintealth.html; the real file is myinthealth.html
// (no 'h' after 'myint'). Nothing caught it, because the request 302s from
// /pages/x.html to the clean /pages/x *before* any file check, and the auth gate
// then bounces an anonymous request to /pages/signin — so the link looks alive
// until a signed-in GP clicks it and gets "Not found". It was the first email a
// GP receives after finishing onboarding.
//
// mapRegistrationPath() rescues the same typo, but only for /registration/*
// paths (it requires parts[0] === 'registration'), so it never applies here.

const ROOT = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// APP_BASE_URL + '/pages/foo.html'  /  CONSULT_START_BASE + "/pages/bar.html"
const PAGE_URL_RE = /(?:APP_BASE_URL|CONSULT_START_BASE)\s*\+\s*['"](\/pages\/[A-Za-z0-9._-]+?\.html)['"]/g;

function referencedPages(source) {
  const found = new Map(); // page path -> first char index (for a useful message)
  for (const m of source.matchAll(PAGE_URL_RE)) {
    if (!found.has(m[1])) found.set(m[1], m.index);
  }
  return found;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

describe('email/notification CTA links resolve to real page files', () => {
  it('finds page-file CTA links to check (guard against the regex silently matching nothing)', () => {
    expect(referencedPages(server).size).toBeGreaterThan(3);
  });

  it('every /pages/*.html URL built from a base URL in server.js exists on disk', () => {
    const missing = [];
    for (const [pagePath, idx] of referencedPages(server)) {
      const onDisk = path.join(ROOT, pagePath.replace(/^\//, ''));
      if (!fs.existsSync(onDisk)) {
        missing.push(`${pagePath} (server.js:${lineOf(server, idx)}) -> no such file: ${pagePath.slice(1)}`);
      }
    }
    expect(missing, `email CTA links point at page files that do not exist:\n${missing.join('\n')}`).toEqual([]);
  });

  it('the onboarding-complete email points at a real page (the dashboard, not the locked MyIntealth step)', () => {
    // Pinned explicitly: this is the first email a GP gets after onboarding.
    // It used to say "Start MyIntealth", but right after onboarding that page
    // is locked and bounced to /pages/career?locked=myintealth (QA 26 Nov
    // 2026), so the CTA now goes straight to the dashboard. The old
    // misspelling guard stays.
    const fn = server.slice(server.indexOf('async function sendOnboardingCompleteEmail'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain("/pages/career.html");
    expect(body).not.toContain("/pages/myintealth.html");
    expect(fs.existsSync(path.join(ROOT, 'pages/career.html'))).toBe(true);
  });
});
