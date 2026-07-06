// Phase 6 H1 — PEP-launch button (static checks): /api/ceo/pep-waitlist/launch
// existed but NOTHING called it (the owner would have had to curl it). The CEO
// dashboard Waitlist card must now carry a guarded "Launch PEP pathway" button:
//  1. button present in the PEP waitlist pane, wired to the launch endpoint;
//  2. a confirm step guards it (releasing waitlisted GPs is irreversible-ish);
//  3. the result (how many released/notified) is surfaced;
//  4. the endpoint itself is super-admin gated server-side (requireCeoSession).
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(__dirname, '..', 'pages', 'ceo-dashboard.html');
const SERVER = path.join(__dirname, '..', 'server.js');

let html;
let serverSrc;
beforeAll(() => {
  html = fs.readFileSync(PAGE, 'utf8');
  serverSrc = fs.readFileSync(SERVER, 'utf8');
});

describe('CEO Waitlist card — Launch PEP pathway button', () => {
  it('the Waitlist card renders a launch button', () => {
    expect(html).toContain('data-pep-launch');
    expect(html).toContain('Launch PEP pathway');
    // Rendered inside the PEP waitlist pane's summary row (Waitlist card style).
    expect(html).toContain('pep-wl-launch');
    expect(html).toContain('pep-wl-summary-row');
  });

  it('the button is wired to POST /api/ceo/pep-waitlist/launch with a confirm step', () => {
    expect(html).toContain("'/api/ceo/pep-waitlist/launch'");
    // The click handler must confirm BEFORE calling the endpoint, with
    // irreversible-ish wording.
    const handlerStart = html.indexOf('data-pep-launch');
    const handler = html.slice(handlerStart, handlerStart + 4000);
    const launchHandlerIdx = html.indexOf("closest('[data-pep-launch]')");
    expect(launchHandlerIdx).toBeGreaterThan(-1);
    const clickHandler = html.slice(launchHandlerIdx, launchHandlerIdx + 2000);
    expect(clickHandler).toContain('window.confirm');
    expect(clickHandler.indexOf('window.confirm')).toBeLessThan(clickHandler.indexOf('/api/ceo/pep-waitlist/launch'));
    expect(clickHandler).toMatch(/can.t be undone|irreversible/i);
    expect(handler).toBeTruthy();
  });

  it('surfaces the result (released / notified counts)', () => {
    const launchHandlerIdx = html.indexOf("closest('[data-pep-launch]')");
    const clickHandler = html.slice(launchHandlerIdx, launchHandlerIdx + 2000);
    expect(clickHandler).toContain('d.released');
    expect(clickHandler).toContain('d.notified');
  });

  it('the launch endpoint is super-admin gated server-side', () => {
    const routeIdx = serverSrc.indexOf("'/api/ceo/pep-waitlist/launch' && req.method === 'POST'");
    expect(routeIdx).toBeGreaterThan(-1);
    const routeBody = serverSrc.slice(routeIdx, routeIdx + 500);
    expect(routeBody).toContain('requireCeoSession');
  });
});
