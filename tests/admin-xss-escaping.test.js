import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Launch-readiness security regression: a GP's first name is rendered into
// double-quoted HTML attributes in the admin dashboard (e.g. the "Send Nudge"
// button's data-nudge-name="${esc(gp_first_name)}"). The old esc() encoded
// only & < > (textContent→innerHTML leaves quotes alone), so a name like
//   x" onmouseover=alert(document.cookie) z=
// broke out of the attribute and ran script in the admin origin when a staff
// member merely hovered their queue — a stored-XSS account takeover. esc() must
// encode " and ' so attribute interpolation is safe.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_HTML = fs.readFileSync(path.join(__dirname, '..', 'pages', 'admin.html'), 'utf8');

describe('admin.html esc() encodes quotes (attribute XSS)', () => {
  it('both esc definitions encode double AND single quotes', () => {
    // There are two esc() helpers in admin.html (two script scopes) — both must
    // quote-encode, or a sink using the weaker one is exploitable.
    const escDefs = ADMIN_HTML.match(/function esc\(s\)\{[^\n]*\}/g) || [];
    expect(escDefs.length).toBeGreaterThanOrEqual(2);
    escDefs.forEach((def) => {
      expect(def).toContain('&quot;');
      expect(def).toContain('&#39;');
    });
  });

  it('the pure-string esc neutralises an attribute-breakout payload', () => {
    // Extract the pure (non-DOM) esc — the one built from String().replace(...).
    const m = ADMIN_HTML.match(/function esc\(s\)\{return String\(s==null\?"":s\)[^\n]*\}/);
    expect(m).toBeTruthy();
    // eslint-disable-next-line no-new-func
    const esc = new Function('return (' + m[0].replace(/^function esc/, 'function') + ')')();
    const payload = 'x" onmouseover=alert(document.cookie) z=';
    const out = esc(payload);
    expect(out).not.toContain('"');       // no raw double-quote survives
    expect(out).toContain('&quot;');       // it is entity-encoded instead
    // And the whole thing, dropped into a double-quoted attribute, cannot break out.
    const attr = `data-x="${out}"`;
    expect(attr.match(/"/g).length).toBe(2); // exactly the two delimiters, none injected
  });

  it('the Send Nudge sinks pass the GP name through esc()', () => {
    // Guard against a future raw ${gp_first_name} interpolation sneaking back in.
    const nudgeLines = ADMIN_HTML.split('\n').filter((l) => l.includes('data-nudge-name='));
    expect(nudgeLines.length).toBeGreaterThan(0);
    nudgeLines.forEach((l) => {
      expect(l).toMatch(/data-nudge-name="\$\{esc\(|data-nudge-name="'\+esc\(/);
    });
  });
});
