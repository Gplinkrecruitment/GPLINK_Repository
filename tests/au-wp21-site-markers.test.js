import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

// WP-21: the marker mechanism for public website pages (lib/site-au-pages.js,
// docs/au-gp/CONVENTIONS.md section 33). The rules, and the lint that every
// real page obeys them. A page with broken markers fails HERE, not in
// production (where it is served as the switch-off page and logged).

const require = createRequire(import.meta.url);
const site = require('../lib/site-au-pages.js');
const ROOT = path.resolve(__dirname, '..');

const pageFiles = fs.readdirSync(path.join(ROOT, 'pages'))
  .filter((f) => /^(site-[a-z0-9-]+|blog)\.html$/.test(f))
  .sort();

describe('site page markers: the rules', () => {
  it('a page with no markers is returned untouched in both states', () => {
    const src = '<p>Hello</p>\n<!-- an ordinary comment -->\n';
    expect(site.renderSource(src, { on: false })).toEqual({ html: src, ok: true, errors: [] });
    expect(site.renderSource(src, { on: true })).toEqual({ html: src, ok: true, errors: [] });
  });

  it('au:on content exists only with the switch on; au:off only with it off; markers always go', () => {
    const src = 'A\n<!--au:on-->ON\n<!--/au:on--><!--au:off-->OFF\n<!--/au:off-->B\n';
    expect(site.renderSource(src, { on: false }).html).toBe('A\nOFF\nB\n');
    expect(site.renderSource(src, { on: true }).html).toBe('A\nON\nB\n');
  });

  it('a marker eats nothing but itself (the line break belongs to the block)', () => {
    const main = '  <a>One</a>\n  <a>Two</a>\n';
    const marked = '  <a>One</a><!--au:on-->\n  <a>New</a><!--/au:on-->\n  <a>Two</a>\n';
    expect(site.renderSource(marked, { on: false }).html).toBe(main);
    expect(site.renderSource(marked, { on: true }).html).toBe('  <a>One</a>\n  <a>New</a>\n  <a>Two</a>\n');
  });

  it('nested markers fail, and fall back to the switch-off page', () => {
    const src = 'A<!--au:on-->x<!--au:off-->y<!--/au:off-->z<!--/au:on-->B';
    const on = site.renderSource(src, { on: true });
    expect(on.ok).toBe(false);
    expect(on.errors.join(' ')).toMatch(/do not nest/);
    // Nothing that sat inside au:on is served.
    expect(on.html).not.toContain('x');
    expect(on.html).not.toContain('z');
    expect(on.html).not.toMatch(/au:/);
    expect(site.renderSource(src, { on: false }).ok).toBe(false);
  });

  it('unbalanced markers fail in both directions', () => {
    for (const src of ['A<!--au:on-->never closed', 'A<!--/au:on-->B', 'A<!--au:on-->x<!--/au:off-->B', 'A<!--au:off-->x']) {
      const r = site.renderSource(src, { on: true });
      expect(r.ok, src).toBe(false);
      expect(r.html, src).not.toMatch(/<!--\/?au:/);
    }
    // An au:on block that is never closed serves nothing after it opens.
    expect(site.renderSource('A<!--au:on-->secret', { on: true }).html).toBe('A');
  });

  it('an unknown or misspelt marker fails', () => {
    for (const src of ['<!--au:onn-->x<!--/au:onn-->', '<!--au:on extra-->x<!--/au:on-->', '<!--au:-->', '<!--/au:use a.html#b-->']) {
      expect(site.renderSource(src, { on: true }).ok, src).toBe(false);
    }
  });

  it('parts: the markers vanish, the content stays, and another page can pull the part in', () => {
    const lender = 'top\n<!--au:part bit--><b>shared<!--au:on--> on<!--/au:on--><!--au:off--> off<!--/au:off--></b><!--/au:part-->\nend\n';
    expect(site.renderSource(lender, { on: false }).html).toBe('top\n<b>shared off</b>\nend\n');
    expect(site.renderSource(lender, { on: true }).html).toBe('top\n<b>shared on</b>\nend\n');
    expect(site.renderSource(lender, { on: true, onlyPart: 'bit' }).html).toBe('<b>shared on</b>');
    expect(site.renderSource(lender, { on: true, onlyPart: 'nope' }).ok).toBe(false);

    const borrower = 'x<!--au:on--><!--au:use site-a.html#bit--><!--/au:on-->y';
    const resolvePart = (file, name) => (file === 'site-a.html' && name === 'bit' ? '[bit]' : null);
    expect(site.renderSource(borrower, { on: true, resolvePart }).html).toBe('x[bit]y');
    expect(site.renderSource(borrower, { on: false, resolvePart }).html).toBe('xy');
    // A part that cannot be found is a failure, not a silent hole.
    expect(site.renderSource('x<!--au:on--><!--au:use site-a.html#gone--><!--/au:on-->y', { on: true, resolvePart }).ok).toBe(false);
  });

  it('use and var must sit inside au:on in a page that is also served with the switch off', () => {
    expect(site.renderSource('<!--au:use site-a.html#bit-->', { on: true, resolvePart: () => 'z' }).ok).toBe(false);
    expect(site.renderSource('<!--au:var canonical-->', { on: true, vars: { canonical: 'z' } }).ok).toBe(false);
    // In a page that exists only with the switch on they may sit anywhere.
    expect(site.renderSource('<!--au:use site-a.html#bit-->', { on: true, auOnly: true, resolvePart: () => 'z' }).html).toBe('z');
  });

  it('var: escaped, and a missing value fails', () => {
    const src = '<!--au:on--><link href="<!--au:var canonical-->"><!--/au:on-->';
    expect(site.renderSource(src, { on: true, vars: { canonical: 'https://x/"><script>' } }).html)
      .toBe('<link href="https://x/&quot;&gt;&lt;script&gt;">');
    expect(site.renderSource(src, { on: true, vars: {} }).ok).toBe(false);
    expect(site.renderSource(src, { on: false }).html).toBe('');
  });

  it('parts do not nest and cannot open inside another marker', () => {
    expect(site.renderSource('<!--au:part a-->x<!--au:part b-->y<!--/au:part--><!--/au:part-->', { on: true }).ok).toBe(false);
    expect(site.renderSource('<!--au:on--><!--au:part a-->x<!--/au:part--><!--/au:on-->', { on: true }).ok).toBe(false);
    expect(site.renderSource('<!--au:part a-->x', { on: true }).ok).toBe(false);
  });
});

describe('site page markers: every real page', () => {
  it('finds the site pages', () => {
    expect(pageFiles).toContain('site-home.html');
    expect(pageFiles).toContain('site-start.html');
    expect(pageFiles).toContain('blog.html');
    expect(pageFiles.length).toBeGreaterThanOrEqual(12);
  });

  for (const file of pageFiles) {
    const rel = '/pages/' + file;
    const auOnly = site.isAuOnlyPagePath(rel);

    it(`${file}: markers are balanced and resolve, switch on`, () => {
      const page = site.renderPageFile(rel, { on: true, vars: file === 'blog.html' ? { canonical: 'https://www.mygplink.com.au/blog' } : undefined });
      expect(page, 'file readable').not.toBeNull();
      expect(page.errors).toEqual([]);
      expect(page.ok).toBe(true);
      expect(page.html).not.toMatch(/<!--\/?au:/);
    });

    if (!auOnly) {
      it(`${file}: markers resolve with the switch off, and no marker is left`, () => {
        const page = site.renderPageFile(rel, { on: false });
        expect(page.errors).toEqual([]);
        expect(page.ok).toBe(true);
        expect(page.html).not.toMatch(/<!--\/?au:/);
      });
    }

    it(`${file}: every inline script still parses, in each state it is served in`, () => {
      const states = auOnly ? [true] : [true, false];
      for (const on of states) {
        const page = site.renderPageFile(rel, { on, vars: on && file === 'blog.html' ? { canonical: 'https://www.mygplink.com.au/blog' } : undefined });
        const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;
        let m;
        let seen = 0;
        while ((m = re.exec(page.html)) !== null) {
          const attrs = m[1] || '';
          if (/\ssrc=/.test(attrs)) continue;
          if (/type="application\/ld\+json"/.test(attrs)) {
            expect(() => JSON.parse(m[2]), `${file} JSON-LD (switch ${on ? 'on' : 'off'})`).not.toThrow();
            continue;
          }
          seen += 1;
          expect(() => new Function(m[2]), `${file} inline script #${seen} (switch ${on ? 'on' : 'off'})`).not.toThrow();
        }
      }
    });
  }

  it('every Australian-only route has its file, and the file is named as a site page', () => {
    for (const [route, file] of Object.entries(site.AU_ONLY_SITE_ROUTES)) {
      expect(route.startsWith('/australian-gps'), route).toBe(true);
      expect(site.isSitePagePath('/' + file), file).toBe(true);
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
      expect(site.auOnlyFileForRoute(route)).toBe('/' + file);
      expect(site.auOnlyRouteForFile('/' + file)).toBe(route);
    }
    expect(site.auOnlyFileForRoute('/start')).toBe('');
    expect(site.auOnlyFileForRoute('constructor')).toBe('');
    expect(site.isAuOnlyPagePath('/pages/site-home.html')).toBe(false);
  });

  it('the file cache follows the file: an edit is picked up, and the two states never share an entry', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wp21-'));
    fs.mkdirSync(path.join(tmp, 'pages'));
    const f = path.join(tmp, 'pages', 'site-x.html');
    fs.writeFileSync(f, 'a<!--au:on-->1<!--/au:on-->');
    expect(site.renderPageFile('/pages/site-x.html', { on: true, root: tmp }).html).toBe('a1');
    expect(site.renderPageFile('/pages/site-x.html', { on: false, root: tmp }).html).toBe('a');
    fs.writeFileSync(f, 'a<!--au:on-->22<!--/au:on-->');
    expect(site.renderPageFile('/pages/site-x.html', { on: true, root: tmp }).html).toBe('a22');
    expect(site.renderPageFile('/pages/site-missing.html', { on: true, root: tmp })).toBeNull();
    expect(site.renderPageFile('/pages/../server.js', { on: true, root: tmp })).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
