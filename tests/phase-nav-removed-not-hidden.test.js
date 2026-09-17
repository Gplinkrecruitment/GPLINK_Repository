// Owner 2026-09-18: "the nav item menu is glitching which presumes me to think
// you have just hidden the additional menu items instead of removing them for
// gps who have not secured placement yet" — correct on both counts. The items
// were class-hidden, so a real <a href="/pages/my-documents"> stayed in the
// markup, and because app-shell.js is deferred the full five-item nav painted
// first and was genuinely clickable before handleDocumentClick existed.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const shell = read('js/app-shell.js');
const html = read('pages/app-shell.html');
const fn = shell.slice(shell.indexOf('function applyNavVisibility'), shell.indexOf('// Phases only move forward mid-session'));

describe('nav items are removed from the DOM, not hidden', () => {
  it('detaches an item that does not belong to the phase', () => {
    expect(fn).toContain('entry.marker = document.createComment("gp-nav:" + entry.key);');
    expect(fn).toContain('entry.el.parentNode.replaceChild(entry.marker, entry.el);');
    // The class survives only as belt and braces, never as the mechanism.
    expect(fn).toContain('entry.el.classList.toggle("gp-nav-hidden", hide);');
  });

  it('puts it back in its original slot when the phase upgrades', () => {
    expect(fn).toContain('entry.marker.parentNode.replaceChild(entry.el, entry.marker);');
    expect(fn).toContain('entry.marker = null;');
  });

  it('captures the item list ONCE — a later query would not see detached nodes', () => {
    const reg = shell.slice(shell.indexOf('var navRegistry = null;'), shell.indexOf('function applyNavVisibility'));
    expect(reg).toContain('if (navRegistry) return navRegistry;');
    expect(reg).toContain('.mobile-nav .mobile-tab');
    expect(reg).toContain('item.getAttribute("data-nav")');
  });

  it('the registration-only nav items really are in the served markup, so removal matters', () => {
    expect(html).toContain('href="/pages/my-documents" data-route="/pages/my-documents" data-nav="documents"');
    expect(html).toContain('data-nav="home"');
    expect(html).toContain('data-nav="support"');
  });
});

describe('the strict nav paints first, so nothing wrong is ever clickable', () => {
  it('hides the phase-optional items until the phase resolves', () => {
    expect(html).toContain('html:not(.gp-phase-resolved) .nav-item[data-nav="home"]');
    expect(html).toContain('html:not(.gp-phase-resolved) .nav-item[data-nav="documents"]');
    expect(html).toContain('html:not(.gp-phase-resolved) .nav-item[data-nav="support"]');
    expect(html).toContain('html:not(.gp-phase-resolved) .mobile-nav');
  });

  it('career and account are NEVER gated — every phase has them', () => {
    const gate = html.slice(html.indexOf('html:not(.gp-phase-resolved) .nav-item[data-nav="home"]'), html.indexOf('display: none !important;', html.indexOf('html:not(.gp-phase-resolved)')));
    expect(gate).not.toContain('data-nav="career"');
    expect(gate).not.toContain('data-nav="account"');
  });

  it('applyNavVisibility is what releases the gate', () => {
    expect(fn).toContain('root.classList.add("gp-phase-resolved");');
    // and it is the only writer of that class
    expect(shell.split('gp-phase-resolved').length - 1).toBe(1);
  });
});
