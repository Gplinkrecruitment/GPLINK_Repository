// Owner ask 2026-09-02: "on the website have a book meeting button up here"
// (screenshot of the marketing header, pointing between "Sign in" and
// "Create free account").
//
// The header is copy-pasted into every pages/site-*.html rather than
// templated, so a nav change is 11 hand edits and the failure mode is one
// page silently keeping the old chrome. These assertions pin the button on
// every GP-facing page, in BOTH the desktop bar and the ☰ mobile menu.
//
// pages/site-employers.html is deliberately excluded: /start#book is the GP
// consult calendar and its bookings are screened as GP leads, so pointing a
// practice at it would drop them into the wrong funnel. That page keeps its
// own "Secure my GP" → #enquire CTA.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const GP_FACING_PAGES = [
  'pages/site-about.html',
  'pages/site-app.html',
  'pages/site-exclusive.html',
  'pages/site-faq.html',
  'pages/site-gp-jobs.html',
  'pages/site-home.html',
  'pages/site-job.html',
  'pages/site-jobs.html',
  'pages/site-start.html',
  'pages/site-visa.html',
];

const BOOK_LINK = '<a class="nav-book" href="/start#book">Book meeting</a>';

describe('"Book meeting" header button on the marketing site', () => {
  it.each(GP_FACING_PAGES)('%s carries it in both the desktop bar and the mobile menu', (page) => {
    const html = read(page);
    // Two copies: one in .nav-right, one in .site-mobile-menu.
    expect(html.split(BOOK_LINK).length - 1).toBe(2);
  });

  // Owner ask 2026-09-02 (second screenshot): "move sign in to the right of
  // book meeting". Desktop bar reads Book meeting · Sign in · Create free
  // account. The ☰ panel deliberately keeps the original order — it is a
  // vertical list, so "right of" has no meaning there, and links → Sign in →
  // the two buttons keeps the plain text row out from between two buttons.
  it.each(GP_FACING_PAGES)('%s orders the desktop bar book → sign-in → account CTA', (page) => {
    const html = read(page);
    const header = html.slice(html.indexOf('<header class="site-header"'), html.indexOf('</header>'));
    expect(header).toContain(
      '\n      ' + BOOK_LINK +
      '\n      <a class="nav-signin" href="/pages/signin">Sign in</a>' +
      '\n      <a class="nav-cta" href="/pages/signin?signup=1">Create free account</a>\n',
    );
  });

  it.each(GP_FACING_PAGES)('%s keeps the ☰ panel as sign-in → book → account CTA', (page) => {
    const html = read(page);
    const header = html.slice(html.indexOf('<header class="site-header"'), html.indexOf('</header>'));
    expect(header).toContain(
      '\n    <a class="nav-signin" href="/pages/signin">Sign in</a>' +
      '\n    ' + BOOK_LINK +
      '\n    <a class="nav-cta" href="/pages/signin?signup=1">Create free account</a>\n',
    );
  });

  it('points at the Calendly booking section that /start actually renders', () => {
    expect(read('pages/site-start.html')).toContain('<section class="block" id="book">');
  });

  it('site-employers.html keeps its own practice CTA and no GP consult link', () => {
    const html = read('pages/site-employers.html');
    expect(html).not.toContain('nav-book');
    expect(html).toContain('<a class="nav-cta" href="#enquire">Secure my GP</a>');
  });

  it('css/site.css styles .nav-book, including the mobile-menu override', () => {
    const css = read('css/site.css');
    expect(css).toContain('.nav-book {');
    // `.site-mobile-menu a` (0,1,1) outranks `.nav-book` (0,1,0), so without
    // this rule the button flattens into a plain list row inside the ☰ panel.
    expect(css).toContain('.site-mobile-menu .nav-book {');
    // Narrow viewports hide it from the top bar — it lives in the ☰ menu
    // there, same as "Sign in".
    expect(css).toContain('.nav-right > .nav-book { display: none; }');
    // `.reveal.in` must stay the last `.reveal` rule (see the 2026-07-17
    // source-order bug); nothing here may be appended after it.
    expect(css.lastIndexOf('.nav-book')).toBeLessThan(css.lastIndexOf('.reveal.in'));
  });

  it('the shared stylesheet cache-buster moved with the markup', () => {
    for (const page of [...GP_FACING_PAGES, 'pages/site-employers.html']) {
      expect(read(page)).toContain('/css/site.css?v=20260902a');
      expect(read(page)).not.toContain('/css/site.css?v=20260717a');
    }
    // Marketing navigations are served stale-while-revalidate from the
    // VERSION-keyed PAGE_CACHE for anyone who has used the app, so the new
    // header only lands on the first navigation if sw.js moved too.
    expect(read('sw.js')).toContain('var VERSION = "20260902c"');
  });
});
