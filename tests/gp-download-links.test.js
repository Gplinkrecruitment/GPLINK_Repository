// Document downloads must never navigate the app-shell iframe.
//
// 24 Nov 2026 (Dr Hatice Akkas): every Download button on My Documents ended on Chrome's
// "This content is blocked. Contact the site owner to fix the issue." A plain
// <a href="/api/…/download"> navigates the iframe the page lives in; the endpoint
// redirects to the file store on another origin, which the site's CSP frame-src refuses
// to render in a frame. js/gp-download.js intercepts those clicks and saves the file via
// fetch → blob instead. Runs the real script in a sandbox with a fake DOM.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js', 'gp-download.js'), 'utf8');
const ORIGIN = 'https://app.mygplink.com.au';

function boot({ fetchImpl } = {}) {
  const saved = [];      // blob saves: { download, href }
  const opened = [];     // new-tab fallbacks
  const toasts = [];
  let clickHandler = null;
  const document = {
    body: { appendChild() {} },
    addEventListener: (type, fn, capture) => { if (type === 'click') { clickHandler = fn; expect(capture).toBe(true); } },
    createElement: (tag) => {
      const el = { tag, style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, remove() {},
        click() { if (this.download !== undefined) saved.push({ download: this.download, href: this.href }); else if (this.target === '_blank') opened.push(this.href); } };
      return el;
    }
  };
  const window = { location: { href: ORIGIN + '/pages/my-documents', origin: ORIGIN }, showToast: (m) => toasts.push(m), open: (u) => opened.push(u) };
  const sandbox = { window, document, URL, fetch: fetchImpl || (async () => { throw new Error('no fetch'); }), setTimeout: () => 0, console };
  sandbox.URL.createObjectURL = () => 'blob:fake';
  sandbox.URL.revokeObjectURL = () => {};
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { window, saved, opened, toasts, click: (a, extra) => {
    const ev = Object.assign({ defaultPrevented: false, button: 0, target: { closest: () => a }, preventDefault() { this.defaultPrevented = true; } }, extra || {});
    clickHandler(ev);
    return ev;
  } };
}
function anchor(href, download) {
  const attrs = { href };
  if (download !== undefined) attrs.download = download;
  return { href: new URL(href, ORIGIN + '/pages/my-documents').href, getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute(k, v) { attrs[k] = v; }, removeAttribute(k) { delete attrs[k]; }, attrs };
}
function response({ status = 200, type = 'application/pdf', disposition = null } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (h) => (h.toLowerCase() === 'content-disposition' ? disposition : h.toLowerCase() === 'content-type' ? type : null) }, blob: async () => ({ type, size: 10 }) };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('js/gp-download.js', () => {
  it('recognises our download endpoints and nothing else', () => {
    const { window } = boot();
    const is = window.gpDownload.isDownloadHref;
    expect(is('/api/prepared-documents/download?country=uk&key=mrcgp_certified')).toBe(true);
    expect(is('/api/practice-documents/download?key=sppa_00')).toBe(true);
    expect(is('/api/onboarding-documents/download?country=uk&key=x')).toBe(true);
    expect(is('/api/account-career-documents/download?key=cv')).toBe(true);
    expect(is('/pages/my-documents')).toBe(false);
    expect(is('https://drive.google.com/file/d/abc/view')).toBe(false);
    expect(is('https://evil.example/api/x/download')).toBe(false);
    expect(is('#')).toBe(false);
  });

  it('a click on a download link never navigates: it fetches and saves, named by the real file type', async () => {
    const calls = [];
    const env = boot({ fetchImpl: async (url, opts) => { calls.push({ url, opts }); return response({ type: 'image/jpeg' }); } });
    const a = anchor('/api/prepared-documents/download?country=uk&key=mrcgp_certified', 'MRCGP Certificate');
    const ev = env.click(a);
    expect(ev.defaultPrevented).toBe(true);           // the iframe is NOT navigated
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.credentials).toBe('same-origin');
    expect(env.saved).toEqual([{ download: 'MRCGP Certificate.jpg', href: 'blob:fake' }]);
    expect(env.opened).toEqual([]);
    expect(a.attrs['data-gp-downloading']).toBeUndefined();   // busy flag cleared
  });

  it('uses the server-given filename when it can read one', async () => {
    const env = boot({ fetchImpl: async () => response({ disposition: 'attachment; filename="Position Description.pdf"' }) });
    env.click(anchor('/api/practice-documents/download?key=position_description', ''));
    await tick();
    expect(env.saved[0].download).toBe('Position Description.pdf');
  });

  it('falls back to a NEW TAB (never the frame) when the fetch itself is impossible', async () => {
    const env = boot({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    const ev = env.click(anchor('/api/practice-documents/download?key=sppa_00', ''));
    expect(ev.defaultPrevented).toBe(true);
    await tick();
    expect(env.saved).toEqual([]);
    expect(env.opened).toEqual([ORIGIN + '/api/practice-documents/download?key=sppa_00']);
  });

  it('tells the doctor when the file does not exist instead of failing silently', async () => {
    const env = boot({ fetchImpl: async () => response({ status: 404 }) });
    env.click(anchor('/api/practice-documents/download?key=section_g', ''));
    await tick();
    expect(env.saved).toEqual([]);
    expect(env.opened).toEqual([]);
    expect(env.toasts[0]).toMatch(/isn't available yet/);
  });

  it('leaves ordinary links, modified clicks and already-handled clicks alone', () => {
    const env = boot({ fetchImpl: async () => response() });
    expect(env.click(anchor('/pages/my-documents')).defaultPrevented).toBe(false);
    expect(env.click(anchor('https://drive.google.com/file/d/abc/view')).defaultPrevented).toBe(false);
    expect(env.click(anchor('/api/practice-documents/download?key=sppa_00'), { metaKey: true }).defaultPrevented).toBe(false);
  });

  it('resolveFileName keeps an existing extension and never invents a wrong one', () => {
    const { window } = boot();
    const r = window.gpDownload.resolveFileName;
    expect(r('CV (Signed and dated)', null, 'application/pdf')).toBe('CV (Signed and dated).pdf');
    expect(r('scan.png', null, 'image/png')).toBe('scan.png');
    expect(r('', null, 'image/jpeg')).toBe('document.jpg');
    expect(r('Primary Medical Degree', null, '')).toBe('Primary Medical Degree.pdf');
  });
});

describe('every GP page loads the download helper', () => {
  const pagesDir = path.join(ROOT, 'pages');
  const pages = fs.readdirSync(pagesDir).filter((f) => f.endsWith('.html'));

  it('is included wherever the signed-in GP guard is loaded', () => {
    const missing = [];
    for (const f of pages) {
      const html = fs.readFileSync(path.join(pagesDir, f), 'utf8');
      if (/<script src="[^"]*js\/auth-guard\.js/.test(html) && !/<script src="\/js\/gp-download\.js/.test(html)) missing.push(f);
    }
    expect(missing, 'add <script src="/js/gp-download.js" defer> to: ' + missing.join(', ')).toEqual([]);
  });

  it('no non-admin page links to a download endpoint without it', () => {
    const offenders = [];
    for (const f of pages) {
      if (/^(admin|ceo)/.test(f)) continue;
      const html = fs.readFileSync(path.join(pagesDir, f), 'utf8');
      if (/\/api\/[a-z-]+\/download\?/.test(html) && !html.includes('/js/gp-download.js')) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('the file store is reachable by fetch under the CSP (connect-src), which is what the helper relies on', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    expect(server).toMatch(/`connect-src 'self'\$\{CSP_SUPABASE_ORIGIN \? ' ' \+ CSP_SUPABASE_ORIGIN : ''\}/);
  });
});
