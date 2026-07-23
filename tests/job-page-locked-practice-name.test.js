// The public job advert (pages/site-job.html) is session-less, so the practice
// identity is masked. This adds a "locked practice name" teaser that tells a
// visitor only members can see the name and drives them to create an account.
//
// The load-bearing security property: the REAL practice name must never reach
// this page — not in the DOM, not in the payload. The teaser shows a fixed
// DECOY only. These tests pin both the teaser and that guarantee, since a
// regression here would leak a client's identity on a public URL.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'pages', 'site-job.html'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

describe('public job page — locked practice-name teaser', () => {
  it('shows a Practice name section that only members can unlock', () => {
    expect(html).toMatch(/class="job-locked"/);
    expect(html).toMatch(/Only GP Link members can see the practice name/);
  });

  it('has a create-account CTA pointing at the signup flow', () => {
    const idx = html.indexOf('class="job-locked"');
    const block = html.slice(idx, idx + 1200);
    expect(block).toMatch(/href="\/pages\/signin\?signup=1/);
    expect(block).toMatch(/Create a free account to see it/);
  });

  it('blurs the placeholder name and hides it from assistive tech', () => {
    // The decoy is CSS-blurred and aria-hidden; it is never selectable/readable.
    expect(html).toMatch(/\.job-locked-name \.decoy\{[^}]*filter:blur/);
    const idx = html.indexOf('class="decoy"');
    expect(idx).toBeGreaterThan(-1);
    expect(html.slice(idx - 30, idx + 60)).toMatch(/aria-hidden="true"/);
  });

  it('SECURITY: the real practice name is never wired into the page', () => {
    // The only allowed mention of practice_name is the explanatory CSS comment;
    // it must never be read from the job payload into the DOM.
    expect(html).not.toMatch(/job\.practice_name/);
    expect(html).not.toMatch(/job\.name\b/);
    // The decoy must be a literal, not interpolated from data.
    const idx = html.indexOf('class="decoy"');
    expect(html.slice(idx, idx + 80)).not.toMatch(/\$\{|innerHTML|textContent/);
  });

  it("SECURITY: the public payload allow-list still omits the real name", () => {
    // Backstop at the source of truth — PUBLIC_JOB_FIELDS must not carry
    // practice_name/name, so even a future template bug cannot leak it.
    const idx = serverSrc.indexOf('const PUBLIC_JOB_FIELDS = [');
    const block = serverSrc.slice(idx, serverSrc.indexOf('];', idx));
    expect(block).not.toMatch(/'practice_name'/);
    expect(block).not.toMatch(/'name'/);
    expect(block).toContain("'display_label'"); // the masked label it DOES send
  });
});
