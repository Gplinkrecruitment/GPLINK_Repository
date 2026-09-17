// Owner 2026-09-10: "i have reloaded but when i click 'done' on the walkthrough
// it does not take me straight to myintealth step" — Home's three-step
// first-visit tour ended on the journey list and just closed.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('Home first-visit tour → Done opens the current registration step', () => {
  it('runArea waits for the tour and, on Done (not Skip/Escape), opens the current journey step', () => {
    const js = read('js/gp-walkthrough.js');
    expect(js).toContain("C.run(steps, { label: firstVisitLabel }).then(function (reason) {");
    expect(js).toContain("if (area === 'home' && reason === 'done') openCurrentJourneyStep();");
    expect(read('js/gp-coach.js')).toContain("cleanup('done')");
  });
  it("uses the row's own Continue target through the shell, never for a done step or before a position is secured", () => {
    const js = read('js/gp-walkthrough.js');
    const fn = js.slice(js.indexOf('function openCurrentJourneyStep()'), js.indexOf("window.addEventListener('message'"));
    expect(fn).toContain("document.querySelector('[data-journey-step=\"myinthealth\"]')");
    expect(fn).toContain("if (!row || row.classList.contains('done')) return;");
    expect(fn).toContain("row.querySelector('.journey-body-cta[data-route]')");
    expect(fn).toContain("if (!route || route === '/pages/career') return;");
    expect(fn).toContain("window.parent.gpShellNavigate(route, { replace: false })");
    // the row builder really emits that CTA with a data-route
    expect(read('pages/index.html')).toContain('<a class="journey-body-cta" href="/pages/${step.page}" data-route="/pages/${step.page}">Continue');
  });
  it('every page that loads the controller moved to the new buster, and the worker precaches it', () => {
    ['pages/index.html', 'pages/account.html', 'pages/career.html', 'pages/messages.html'].forEach((p) => expect(read(p)).toContain('/js/gp-walkthrough.js?v=20260918c'));
    expect(read('sw.js')).toContain('"/js/gp-walkthrough.js?v=20260918c"');
    expect(read('sw.js')).toContain('var VERSION = "20260918f"');
  });
});
