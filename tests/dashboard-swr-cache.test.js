// Dashboard speed fix (2026-07-24): CEO + RSO dashboards were slow because
// every view blocked on ~0.5-1.5s AU→US-East API round trips with zero
// client-side caching, and /api/admin/gp-documents ran its Supabase reads,
// Drive reconcile, and per-subfolder Drive listings strictly sequentially.
//
// This pins the three layers of the fix so a refactor can't silently drop them:
//  1. SWR (stale-while-revalidate) cache in pages/ceo-dashboard.html — paint
//     from sessionStorage instantly, always revalidate, purge on mutations.
//  2. Same SWR layer in pages/admin.html (boot snapshot + gp-documents/case).
//  3. server.js gp-documents: parallelized Supabase batch, parallel subfolder
//     Drive listings, and a per-lambda reconcile TTL memo.
//
// Static source-string checks by repo convention (no jsdom).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

describe('CEO dashboard SWR cache', () => {
  const html = read('pages/ceo-dashboard.html');

  it('defines the gpSwr helper on the sessionStorage namespace', () => {
    expect(html).toContain("var GP_SWR_NS = 'gpSwr1:ceo:'");
    expect(html).toContain('function gpSwr(');
    // sessionStorage on purpose — cached PII must die with the tab.
    expect(html).toContain('sessionStorage.getItem(GP_SWR_NS');
    expect(html).not.toContain('localStorage.setItem(GP_SWR_NS');
  });

  it('only caches ok payloads and always revalidates over the network', () => {
    expect(html).toMatch(/if \(d && d\.ok\) gpSwrWrite\(path, d\); else gpSwrDrop\(path\);/);
  });

  it('purges the cache on mutations (non-GET apiFetch)', () => {
    expect(html).toMatch(/gpSwrPurge\(\)/);
  });

  it('serves the main dashboard feed and GP profile reads through gpSwr', () => {
    expect(html).toContain("gpSwr('/api/ceo/dashboard'");
    expect(html).toContain("gpSwr('/api/ceo/trends'");
    expect(html).toContain("gpSwr('/api/admin/case?id='");
    expect(html).toContain("gpSwr('/api/admin/gp-documents?case_id='");
  });

  it('never serves the auth/session check from cache', () => {
    expect(html).not.toContain("gpSwr('/api/admin/auth/session'");
  });

  it('exposes the storage helpers to the ATS modules', () => {
    expect(html).toContain('window.__gpSwr');
  });
});

describe('ATS shared module SWR', () => {
  const js = read('js/ceo-ats-shared.js');

  it('exposes ATS.swr with cached-paint + network revalidate', () => {
    expect(js).toContain('swr: swr');
    expect(js).toContain('window.__gpSwr');
  });
});

describe('RSO admin dashboard SWR cache', () => {
  const html = read('pages/admin.html');

  it('defines the gpSwr helper on its own namespace', () => {
    expect(html).toContain("gpSwr1:admin:");
    expect(html).toContain('function gpSwrRead(');
    expect(html).not.toContain('localStorage.setItem(GP_SWR_NS');
  });

  it('boot-paints from a state snapshot and keeps writing it after refreshes', () => {
    expect(html).toContain("bootSnapshot");
  });

  it('caches the slow gp-documents profile fetch', () => {
    expect(html).toMatch(/gpSwr(Read|Write)\("\/api\/admin\/gp-documents\?case_id="|gpSwr(Read|Write)\(.{0,40}gp-documents/);
  });
});

describe('server gp-documents parallelization', () => {
  const server = read('server.js');

  it('throttles reconcileGpDrive with a per-lambda TTL memo', () => {
    expect(server).toContain('_gpDocsReconcileAt');
  });

  it('lists per-document subfolders in parallel, not sequentially', () => {
    // The subfolder fan-out must go through Promise.all — the old sequential
    // for-loop of awaited files.list calls was the endpoint's biggest cost.
    const gd = server.slice(server.indexOf("'/api/admin/gp-documents'"));
    const handler = gd.slice(0, gd.indexOf('/api/admin/redeliver-section-g'));
    expect(handler).toContain('Promise.all');
  });
});
