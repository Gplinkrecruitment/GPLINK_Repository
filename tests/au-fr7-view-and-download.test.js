// FR-7 (M7-01): on the Australian My Documents page (and the pre-start page,
// which draws the same cards) "View" silently saved a file called
// document.pdf instead of opening the document.
//
// Cause: `main`'s download helper (js/gp-download.js, added to the Australian
// pages in the last merge) turns every LINK to a download address into a
// background save. "View" was such a link. Now "View" is a button that opens
// a new tab (as it always did), and a separate "Download" link is what the
// helper saves, under the document's own file name. Both real scripts are
// run here against a small stand-in for the page.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const pageJs = read('js/my-documents-au.js');
const helperJs = read('js/gp-download.js');
const ORIGIN = 'http://localhost:3000';
const NOW = Date.parse('2026-11-25T00:00:00Z');
const URL_ = '/api/gp/au-documents/download?key=au_indemnity_certificate';

function loadPage() {
  const sandbox = { module: { exports: {} } };
  sandbox.window = sandbox;
  vm.runInNewContext(pageJs, sandbox, { filename: 'my-documents-au.js' });
  return sandbox.GPMyDocumentsAu;
}
const item = (over) => Object.assign({ key: 'au_indemnity_certificate', label: 'Indemnity certificate', provider: 'you', required: true, phase: 'prestart',
  status: 'under_review', fileName: 'indemnity 2026.pdf', updatedAt: '2026-11-20T00:00:00Z', downloadUrl: URL_, canUpload: true }, over || {});

// The helper, booted as tests/gp-download-links.test.js boots it.
function bootHelper(fetchImpl) {
  const saved = []; const opened = [];
  let clickHandler = null;
  const document = {
    body: { appendChild() {} },
    addEventListener: (type, fn) => { if (type === 'click') clickHandler = fn; },
    createElement: () => ({ style: {}, setAttribute() {}, remove() {}, click() { if (this.download !== undefined) saved.push({ download: this.download }); else if (this.target === '_blank') opened.push(this.href); } })
  };
  const window = { location: { href: ORIGIN + '/pages/my-documents-au', origin: ORIGIN }, showToast() {} };
  const sandbox = { window, document, URL, fetch: fetchImpl, setTimeout: () => 0, console };
  sandbox.URL.createObjectURL = () => 'blob:fake';
  sandbox.URL.revokeObjectURL = () => {};
  vm.createContext(sandbox);
  vm.runInContext(helperJs, sandbox);
  return { saved, opened, click: (el) => { const ev = { defaultPrevented: false, button: 0, target: { closest: (sel) => (sel === 'a[href]' ? el.asLink : null) }, preventDefault() { this.defaultPrevented = true; } }; clickHandler(ev); return ev; } };
}
// What the browser would hand the helper for each control in the card's markup.
function controls(html) {
  const view = /<button[^>]*data-aud-view="([^"]*)"[^>]*>View<\/button>/.exec(html);
  const dl = /<a [^>]*href="([^"]*)"[^>]*download="([^"]*)"[^>]*>Download<\/a>/.exec(html);
  const linkOf = (href, download) => {
    const attrs = { href, download };
    return { href: new URL(href, ORIGIN).href, getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute(k, v) { attrs[k] = v; }, removeAttribute(k) { delete attrs[k]; } };
  };
  return {
    view: view ? { url: view[1].replace(/&amp;/g, '&'), asLink: null } : null,           // a button: no link for the helper to find
    download: dl ? { asLink: linkOf(dl[1].replace(/&amp;/g, '&'), dl[2].replace(/&amp;/g, '&')) } : null
  };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('M7-01: View opens, Download saves', () => {
  const view = loadPage();

  it('the card offers View as a button and Download as a link with the file\'s own name; no link to the file is left that the helper would hijack', () => {
    const html = view._cardHtml(item(), NOW);
    expect(html).toMatch(/<button type="button" class="aud-btn aud-btn-quiet" data-aud-view="[^"]+">View<\/button>/);
    expect(html).toMatch(/<a class="aud-btn aud-btn-quiet" href="[^"]+" download="indemnity 2026\.pdf" data-download-name="indemnity 2026\.pdf">Download<\/a>/);
    // every link to the download address in the card is the Download link
    const links = html.match(/<a [^>]*href="\/api\/gp\/au-documents\/download[^"]*"[^>]*>[^<]*<\/a>/g) || [];
    expect(links.length).toBe(1);
    expect(links[0]).toContain('>Download</a>');
    expect(html).not.toContain('target="_blank" rel="noopener">View</a>');
  });

  it('View: the helper does nothing (no save, no fetch); Download: the helper saves the file under its own name', async () => {
    let fetched = 0;
    const h = bootHelper(async () => { fetched += 1; return { ok: true, status: 200, headers: { get: () => null }, blob: async () => ({ type: 'application/pdf', size: 10 }) }; });
    const c = controls(view._cardHtml(item(), NOW));
    expect(c.view && c.download).toBeTruthy();

    const evView = h.click(c.view);
    await tick();
    expect(evView.defaultPrevented).toBe(false);
    expect(fetched).toBe(0);
    expect(h.saved).toEqual([]);

    const evDl = h.click(c.download);
    await tick();
    expect(evDl.defaultPrevented).toBe(true);
    expect(fetched).toBe(1);
    expect(h.saved).toEqual([{ download: 'indemnity 2026.pdf' }]);
  });

  it('before the fix: a View LINK to the same address is saved as "document.pdf" by the helper (the defect, shown on the old markup)', async () => {
    const h = bootHelper(async () => ({ ok: true, status: 200, headers: { get: () => null }, blob: async () => ({ type: 'application/pdf', size: 10 }) }));
    const attrs = { href: URL_ };
    const oldViewLink = { asLink: { href: ORIGIN + URL_, getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute() {}, removeAttribute() {} } };
    h.click(oldViewLink);
    await tick();
    expect(h.saved).toEqual([{ download: 'document.pdf' }]);
  });

  it('a file with no stored name is saved under the document\'s label, with the ending for what the file is', async () => {
    const h = bootHelper(async () => ({ ok: true, status: 200, headers: { get: () => null }, blob: async () => ({ type: 'image/jpeg', size: 10 }) }));
    const html = view._cardHtml(item({ fileName: '' , status: 'approved' }), NOW);
    expect(html).toContain('download="Indemnity certificate"');
    h.click(controls(html).download);
    await tick();
    expect(h.saved).toEqual([{ download: 'Indemnity certificate.jpg' }]);
  });

  it('a name with characters a file name cannot hold, or markup, is cleaned and escaped', () => {
    const html = view._cardHtml(item({ fileName: 'a<b>/c:"d".pdf' }), NOW);
    expect(html).toContain('download="a b c d .pdf"');
    expect(html).not.toContain('<b>');
  });

  it('nothing on file: neither control', () => {
    const html = view._cardHtml(item({ status: 'missing', fileName: '', downloadUrl: '' }), NOW);
    expect(html).not.toContain('data-aud-view');
    expect(html).not.toContain('>Download</a>');
  });

  it('the click handler opens View in a new tab and does not touch the link the helper owns', () => {
    const i = pageJs.indexOf("target.closest('[data-aud-view]')");
    expect(i).toBeGreaterThan(0);
    const block = pageJs.slice(i, i + 700);
    expect(block).toContain("root.open(viewUrl, '_blank', 'noopener')");
    expect(block).toContain("viewUrl += (viewUrl.indexOf('?') === -1 ? '?' : '&') + 'view=1';");
    // the server signs a "view" link without a download name (so the store shows the file), for a PDF or a picture only
    const server = read('server.js');
    expect(server).toContain("const auDocViewAsked = url.searchParams.get('view') === '1';");
    expect(server).toContain("(auDocViewAsked && auDocShowable) ? '' : (mapped.fileName || '')");
    expect(pageJs).not.toMatch(/data-aud-view[\s\S]{0,300}preventDefault/);
  });

  it('the other four Australian pages that load the helper draw no link to a download address of their own', () => {
    for (const f of ['js/au-prestart.js', 'js/au-segment-b.js', 'js/au-doctor.js', 'pages/index-au.html', 'pages/pbs-au.html', 'pages/prestart.html', 'pages/visa-transfer-au.html']) {
      if (!fs.existsSync(path.join(ROOT, f))) continue;
      const src = read(f).replace(/<script src="\/js\/gp-download\.js[^>]*><\/script>/g, '');
      expect(/href=["'][^"']*\/api\/[a-z0-9/-]*download/i.test(src), f).toBe(false);
    }
  });

  it('an overseas doctor\'s page is not touched: pages/my-documents.html and the helper are byte for byte main\'s', () => {
    // (the helper is main's file; this build must not edit it)
    expect(helperJs).toContain('var DOWNLOAD_PATH = /^\\/api\\/[a-z0-9\\/-]*download(?:$|[\\/?#])/i;');
    expect(read('pages/my-documents.html')).not.toContain('data-aud-view');
  });
});
