// Australian GP build, WP-07: every card on the Australian My Documents page,
// in every state.
//
// Why this file exists. After an upload the page drew an EMPTY card (only a
// "Not uploaded" pill) for the document that had just been uploaded. The
// upload reply carried the uploaded item twice (as `document` and again inside
// `youProvide`), and the server's JSON writer replaces an object it meets a
// second time with the string "[redacted-circular]". The page took that string
// for an item and drew it. Three things are pinned here:
//   1. every item x every status x image / PDF draws a whole card: a title, a
//      status label, and an action or a line that says what happens next;
//   2. something that is not an item is never drawn, and never replaces the
//      list the page already has (the page reads the list again instead);
//   3. the counter says what it counts.
// The server half (the reply no longer repeats an object) is pinned in
// tests/au-wp07-documents-server.test.js.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pageJs = fs.readFileSync(path.join(ROOT, 'js/my-documents-au.js'), 'utf8');
const docReq = require('../lib/document-requirements.js');
const docAiReview = require('../lib/doc-ai-review.js');

const NOW = Date.parse('2026-11-20T00:00:00Z');
const AU_PATHWAYS = ['au_vr', 'au_restricted', 'au_non_vr', 'au_registrar'];
const REDACTED = '[redacted-circular]';

function loadPage(extra) {
  const sandbox = Object.assign({ module: { exports: {} } }, extra || {});
  sandbox.window = sandbox;
  vm.runInNewContext(pageJs, sandbox, { filename: 'my-documents-au.js' });
  return sandbox.GPMyDocumentsAu;
}
const view = loadPage();

// The item exactly as buildAuDocumentsView (server.js) sends it to a doctor.
function serverItem(i, state) {
  const base = {
    key: i.key, label: i.label, short: i.short, help: i.help, provider: i.provider, phase: i.phase,
    required: i.required, expiryTracked: i.expiryTracked, expiryLabel: i.expiryLabel,
    status: 'pending', fileName: '', updatedAt: null, expiresAt: null, note: '',
    canUpload: i.provider === 'you' && i.storage === 'au_reg', downloadUrl: '',
    manageUrl: i.storage === 'careers' ? '/pages/career.html' : ''
  };
  return Object.assign(base, state || {});
}

// Every state the status model allows, for a stored document.
function statesFor(i, fileName) {
  const onFile = { fileName, updatedAt: '2026-11-01T00:00:00Z', downloadUrl: i.storage === 'au_reg' && i.provider === 'you' ? '/api/gp/au-documents/download?key=' + i.key : '' };
  const list = [
    ['not uploaded', {}],
    ['uploaded', Object.assign({ status: 'uploaded' }, onFile)],
    ['being checked', Object.assign({ status: 'under_review' }, onFile)],
    ['approved', Object.assign({ status: 'approved' }, onFile)],
    ['needs another look, with a reason', Object.assign({ status: 'rejected', note: docAiReview.rejectionMessageFor('illegible', i.label, '') }, onFile)],
    ['needs another look, no reason given', Object.assign({ status: 'rejected', note: '' }, onFile)]
  ];
  if (i.expiryTracked) {
    list.push(['approved, expiring soon', Object.assign({ status: 'approved', expiresAt: '2026-12-05T00:00:00Z' }, onFile)]);
    list.push(['approved, expired', Object.assign({ status: 'approved', expiresAt: '2026-10-01T00:00:00Z' }, onFile)]);
    list.push(['being checked, expiry far off', Object.assign({ status: 'under_review', expiresAt: '2028-06-30T00:00:00Z' }, onFile)]);
  }
  return list;
}

// What a whole card must have.
function assertWholeCard(html, item, label) {
  const where = item.key + ' / ' + label;
  expect(html, where).toContain('data-aud-key="' + item.key + '"');
  // a title
  const title = (html.match(/<h3>([\s\S]*?)<\/h3>/) || [])[1] || '';
  expect(title.trim().length, where + ': title').toBeGreaterThan(1);
  // a status label, and one the page knows
  const pill = (html.match(/<span class="aud-pill tone-(\w+)">([^<]*)<\/span>/) || []);
  expect((pill[2] || '').trim().length, where + ': status label').toBeGreaterThan(1);
  const known = Object.values(view._STATUS).concat(Object.values(view._WE_STATUS)).map((s) => s.label);
  expect(known, where + ': status label').toContain(pill[2]);
  // an action, or a line that says what happens
  const hasAction = /class="aud-btn/.test(html);
  const hasLine = /<p class="aud-short">[^<]{10,}<\/p>/.test(html);
  expect(hasAction || hasLine, where + ': an action or an explanatory line').toBe(true);
  expect(hasLine, where + ': the "what this is" line').toBe(true);
  expect(html, where + ': help').toContain('What this is and where to find it');
  // not an empty shell
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  expect(text.length, where + ': visible text').toBeGreaterThan(60);
  expect(html, where).not.toContain(REDACTED);
  expect(html, where).not.toMatch(/undefined|null|NaN|\[object/);
}

describe('every card, in every state, for an image and for a PDF', () => {
  for (const pathway of AU_PATHWAYS) {
    const items = docReq.auDocumentRequirements(pathway).items;
    for (const fileName of ['FAKE-photo.png', 'FAKE-scan.pdf']) {
      it(`${pathway}, ${fileName}: each item x each status draws a whole card`, () => {
        let drawn = 0;
        for (const i of items) {
          for (const [label, state] of statesFor(i, fileName)) {
            const item = serverItem(i, state);
            const html = view._cardHtml(item, NOW);
            assertWholeCard(html, item, label);
            drawn++;
            // state-specific
            if (item.status !== 'pending' && item.fileName && i.storage !== 'delivered' && i.provider === 'you') expect(html, i.key + ' ' + label).toContain(fileName);
            if (item.provider === 'you' && item.canUpload) expect(html).toContain(item.status === 'pending' ? '>Upload<' : '>Replace<');
            if (item.status === 'rejected' && item.note) expect(html).toContain('could not read your');
            if (label === 'approved, expired') {
              expect(html).toMatch(/Expired on 1 Oct 2026/);
              // the pill does not go on saying "Approved" for a document that has run out
              expect(html).toContain('<span class="aud-pill tone-bad">Expired</span>');
              expect(html).not.toContain('>Approved<');
            }
            if (label === 'approved, expiring soon') expect(html).toContain('<span class="aud-pill tone-good">Approved</span>');
            if (label === 'approved, expiring soon') expect(html).toMatch(/\(in 15 days\)/);
            if (item.provider === 'we') expect(html).not.toContain('data-aud-upload');
          }
        }
        expect(drawn).toBeGreaterThanOrEqual(items.length * 6);
      });
    }
  }

  it('the whole view: both tabs, every item present once, no empty card', () => {
    for (const pathway of AU_PATHWAYS) {
      const set = docReq.auDocumentRequirements(pathway);
      const data = {
        youProvide: set.youProvide.map((i, n) => serverItem(i, n % 2 ? { status: 'under_review', fileName: 'FAKE.png', updatedAt: '2026-11-01T00:00:00Z' } : {})),
        weProvide: set.weProvide.map((i) => serverItem(i))
      };
      for (const tab of ['you', 'we']) {
        const html = view._viewHtml(data, tab, NOW);
        const cards = html.match(/<article class="aud-card"[\s\S]*?<\/article>/g) || [];
        expect(cards.length).toBe(set.items.length);
        cards.forEach((card) => {
          const key = (card.match(/data-aud-key="([^"]*)"/) || [])[1];
          expect(key, 'a card with no key').toBeTruthy();
          assertWholeCard(card, set.items.find((i) => i.key === key), tab + ' tab');
        });
        expect(html.match(/data-aud-panel="you"/g).length).toBe(1);
        expect(html.match(/data-aud-panel="we"/g).length).toBe(1);
      }
    }
  });
});

describe('something that is not an item is never drawn (the defect)', () => {
  const set = docReq.auDocumentRequirements('au_vr');
  const good = () => ({ youProvide: set.youProvide.map((i) => serverItem(i)), weProvide: set.weProvide.map((i) => serverItem(i)) });

  it('the exact reply that broke the page: the uploaded item replaced by the string "[redacted-circular]"', () => {
    const data = good();
    data.youProvide[1] = REDACTED; // what the old server sent for the item just uploaded
    const html = view._viewHtml(data, 'you', NOW);
    const cards = html.match(/<article class="aud-card"[\s\S]*?<\/article>/g) || [];
    // no empty card: every card drawn has a key and a title
    cards.forEach((card) => {
      expect((card.match(/data-aud-key="([^"]*)"/) || [])[1]).toBeTruthy();
      expect(((card.match(/<h3>([\s\S]*?)<\/h3>/) || [])[1] || '').trim().length).toBeGreaterThan(1);
    });
    expect(cards.length).toBe(set.items.length - 1);
    expect(html).not.toContain('data-aud-key=""');
  });

  it('other shapes that are not items', () => {
    for (const junk of [null, undefined, '', 42, [], {}, { key: 'x' }, { label: 'x' }, { key: '', label: 'x' }, { key: 'x', label: '' }]) {
      expect(view._isItem(junk)).toBe(false);
      const data = good();
      data.youProvide.push(junk);
      const html = view._viewHtml(data, 'you', NOW);
      expect((html.match(/<article class="aud-card"/g) || []).length).toBe(set.items.length);
    }
    expect(view._isItem(serverItem(set.items[0]))).toBe(true);
  });

  // The page object itself, with just enough of a browser around it.
  function mountWith(replies) {
    const calls = [];
    const el = { innerHTML: '', addEventListener() {}, querySelector() { return null; } };
    const page = loadPage({
      FileReader: class { readAsDataURL() { this.result = 'data:application/pdf;base64,JVBERi0xLjQK'; this.onload(); } },
      location: { search: '', origin: 'http://localhost' }
    });
    const fetcher = (url, init) => {
      const method = (init && init.method) || 'GET';
      calls.push(method + ' ' + url);
      const next = replies.shift();
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(next))) });
    };
    return { el, calls, mounted: page.mount(el, { fetch: fetcher, now: () => NOW }) };
  }
  const afterUpload = (key) => {
    const d = good();
    const item = d.youProvide.find((i) => i.key === key);
    Object.assign(item, { status: 'under_review', fileName: 'FAKE.pdf', updatedAt: '2026-11-20T00:00:00Z' });
    return d;
  };
  const cardFor = (html, key) => (html.match(new RegExp('<article class="aud-card" data-aud-key="' + key + '"[\\s\\S]*?</article>')) || [''])[0];

  it('a good upload reply: the uploaded card shows the file and "Being checked", and the counter moves', async () => {
    const key = 'au_ahpra_certificate';
    const reply = Object.assign({ ok: true }, afterUpload(key));
    const { el, calls, mounted } = mountWith([Object.assign({ ok: true }, good()), reply]);
    await mounted.load();
    expect(el.innerHTML).toContain('0 of 8 uploaded');
    expect(await mounted.upload(key, { name: 'FAKE.pdf', type: 'application/pdf', size: 20 })).toBe(true);
    const card = cardFor(el.innerHTML, key);
    assertWholeCard(card, mounted.state.data.youProvide.find((i) => i.key === key), 'after upload');
    expect(card).toContain('Being checked');
    expect(card).toContain('FAKE.pdf');
    expect(el.innerHTML).toContain('1 of 8 uploaded');
    expect(calls).toEqual(['GET /api/gp/au-documents', 'PUT /api/gp/au-documents']);
  });

  it('a broken upload reply never reaches the screen: the page reads the list again', async () => {
    const key = 'au_ahpra_certificate';
    const broken = Object.assign({ ok: true }, afterUpload(key));
    broken.youProvide[broken.youProvide.findIndex((i) => i.key === key)] = REDACTED;
    const fresh = Object.assign({ ok: true }, afterUpload(key));
    const { el, calls, mounted } = mountWith([Object.assign({ ok: true }, good()), broken, fresh]);
    await mounted.load();
    expect(await mounted.upload(key, { name: 'FAKE.pdf', type: 'application/pdf', size: 20 })).toBe(true);
    expect(calls).toEqual(['GET /api/gp/au-documents', 'PUT /api/gp/au-documents', 'GET /api/gp/au-documents']);
    const card = cardFor(el.innerHTML, key);
    expect(card).toContain('Ahpra registration certificate');
    expect(card).toContain('Being checked');
    expect((el.innerHTML.match(/<article class="aud-card"/g) || []).length).toBe(set.items.length);
    expect(el.innerHTML).not.toContain(REDACTED);
    expect(mounted.state.data.youProvide.every((i) => view._isItem(i))).toBe(true);
  });

  it('a list that arrives broken on first load shows the "could not load" message, not half a page', async () => {
    const broken = Object.assign({ ok: true }, good());
    broken.youProvide[2] = REDACTED;
    const { el, mounted } = mountWith([broken]);
    expect(await mounted.load()).toBe(false);
    expect(el.innerHTML).toContain('We could not load your documents');
    expect(el.innerHTML).toContain('data-aud-retry');
    expect(el.innerHTML).not.toContain('aud-card');
  });
});

describe('the counter says what it counts', () => {
  const set = docReq.auDocumentRequirements('au_vr');
  it('"You provide" counts what is on file, checked or not; "We prepare" counts what is ready', () => {
    const data = {
      youProvide: set.youProvide.map((i, n) => serverItem(i, n === 1 ? { status: 'under_review', fileName: 'a.png' } : n === 3 ? { status: 'approved', fileName: 'b.pdf' } : n === 4 ? { status: 'rejected', fileName: 'c.pdf' } : {})),
      weProvide: set.weProvide.map((i, n) => serverItem(i, n === 0 ? { status: 'approved', fileName: 'offer.pdf' } : { status: 'under_review' }))
    };
    const html = view._viewHtml(data, 'you', NOW);
    expect(html).toContain('<span class="aud-count">3 of 8 uploaded</span>');
    expect(html).toContain('<span class="aud-count">1 of 2 ready</span>');
    const empty = view._viewHtml({ youProvide: set.youProvide.map((i) => serverItem(i)), weProvide: set.weProvide.map((i) => serverItem(i)) }, 'you', NOW);
    expect(empty).toContain('0 of 8 uploaded');
    expect(empty).toContain('0 of 2 ready');
  });
});
