import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Why this cron has to exist (Dr Mercy Obanimoh, 2026-08-11).
//
// The SPPA-00 conflict scan is kicked off fire-and-forget from every path that
// completes one of its prerequisites — _completeRegTask, the practice-doc
// approve endpoint, and "Submit to Drive & Complete". None of them await it.
//
// This app runs on @vercel/node, where the function is frozen the moment the
// HTTP response is sent. The scan reads two PDFs through the model, so it
// simply does not survive being started and abandoned. When it dies the
// SPPA-00 task stays `deferred` for ever and NOTHING on screen explains why:
// her supervisor CV and offer/contract were both completed, both carried their
// documents, and SPPA-00 still never appeared for admin.
//
// /api/cron/sppa-backfill-scan awaits the scan inside the request, so it is the
// only path that reliably finishes. It existed already but was never added to
// vercel.json, so it only ever ran if somebody called it by hand. These tests
// pin it as scheduled — the endpoint being present is not enough.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const vercelConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const CRON_PATH = '/api/cron/sppa-backfill-scan';

describe('the SPPA-00 backfill sweep is actually scheduled', () => {
  it('is declared in vercel.json — an endpoint nobody calls never runs', () => {
    const entry = (vercelConfig.crons || []).find((c) => c.path === CRON_PATH);
    expect(entry, CRON_PATH + ' missing from vercel.json crons').toBeTruthy();
    expect(entry.schedule).toBe('*/15 * * * *');
  });

  it('is heartbeat-tracked, so a silently-dead sweep shows on cron-health', () => {
    // CRON_SCHEDULES drives GET /api/admin/cron-health. A cron absent from it
    // can stop firing without anyone noticing — which is how this one would
    // regress back to "exists but never runs".
    expect(server).toContain("'sppa-backfill-scan': { schedule: '*/15 * * * *', cadenceMinutes: 15 }");
  });

  it('the handler still awaits the scan rather than firing and forgetting', () => {
    // The whole point of the sweep. If this ever becomes fire-and-forget too,
    // there is no path left that can finish a conflict scan.
    const handler = (server.match(
      /if \(pathname === '\/api\/cron\/sppa-backfill-scan'[\s\S]*?\n  \}/
    ) || [''])[0];
    expect(handler).toBeTruthy();
    expect(handler).toContain('await _maybeRunSppaConflictScan(sbRow.case_id, sbUid)');
  });

  it('accepts a single case id, so one stuck GP can be recovered on demand', () => {
    const handler = (server.match(
      /if \(pathname === '\/api\/cron\/sppa-backfill-scan'[\s\S]*?\n  \}/
    ) || [''])[0];
    expect(handler).toContain("url.searchParams.get('caseId')");
    expect(handler).toContain('isValidCronSecret');
  });
});
