import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(__dirname, '..');
describe('location labels never render ", NSW"', () => {
  it('server concat sites use filtered join', () => {
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    // NOTE: the brief's regex hardcoded the loop variable name `r`
    // (`/location_city \|\| ''\) \+ \(r\.location_state \? ', '/`), but the
    // same bug pattern also exists under other variable names (e.g. `role.`
    // at the /api/ats/new-applications and /api/ats/waiting-on-practice
    // sites). Broadened to \w+ so every offending site is caught, not just
    // the ones spelled with `r.`.
    expect(srv).not.toMatch(/\w+\.location_city \|\| ''\) \+ \(\w+\.location_state \? ', '/);
  });
  it('application-detail trims a leading comma', () => {
    const p = fs.readFileSync(path.join(ROOT, 'pages', 'application-detail.html'), 'utf8');
    expect(p).toMatch(/replace\(\/\^\[\\s,\]\+\//);
  });
});
