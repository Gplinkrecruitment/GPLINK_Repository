// Australian GP build, WP-07: what a doctor on an Australian pathway is shown
// or sent by the documents feature, scanned for the words in AGENT-RULES
// section 4 (and for the overseas document names the report's acceptance line
// names: GMC, MRCGP, CCT).
//
// Scanned:
//   1. the Australian My Documents page and its script, whole source
//      (comments and identifiers included)
//   2. every label, one-line description and help step in the Australian set,
//      for every Australian pathway
//   3. the page's own answers from the real server (list, requirements)
//   4. the emails and bell items the real server produces for the Australian
//      document types: approved, sent back by the automatic review (unreadable,
//      wrong document), approved and sent back by staff
//   5. the expiry reminder wording
// Emails are captured from the outbound request the server would have made to
// the email provider; nothing is sent (the harness answers every outside
// request itself). The model is a stub.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const fx = require('./helpers/au-fixtures.js');
const docReq = require('../lib/document-requirements.js');
const docAiReview = require('../lib/doc-ai-review.js');

const pageHtml = read('pages/my-documents-au.html');
const pageJs = read('js/my-documents-au.js');
const overseasPage = read('pages/my-documents.html');
const serverJs = read('server.js');

// AGENT-RULES section 4, plus the three document names in WP-07's acceptance line.
const BANNED = [
  ['MyIntealth', /my\s?int(e)?alth/i],
  ['AMC', /\bAMC\b/i],
  ['EPIC', /\bEPIC\b/i],
  ['visa', /visa/i],
  ['relocate / relocation', /relocat/i],
  ['your move', /your\s+move/i],
  ['overseas', /overseas/i],
  ['internationally trained', /internationally[\s-]+trained/i],
  ['GMC', /\bGMC\b/i],
  ['SPPA', /SPPA/i],
  ['Section G', /section\s+G\b/i],
  ['supervisor CV', /supervisor\s+CV/i],
  ['Not yet eligible', /not\s+yet\s+eligible/i],
  ['MRCGP', /MRCGP/i],
  ['CCT', /\bCCT\b/i],
  ['Certificate of Good Standing', /good\s+standing/i],
  ['certified copy', /certified\s+(true\s+)?cop(y|ies)/i]
];
function bannedIn(text) {
  return BANNED.filter(([, re]) => re.test(String(text))).map(([name]) => name);
}

const AU_PATHWAYS = ['au_vr', 'au_restricted', 'au_non_vr', 'au_registrar'];
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% FAKE TEST DOCUMENT, NOT A REAL CERTIFICATE\n%%EOF\n').toString('base64');
const CRON = { headers: { Authorization: 'Bearer test-cron-secret' } };

describe('the scan itself works', () => {
  it('finds each banned word', () => {
    expect(bannedIn('Add my GMC number')).toEqual(['GMC']);
    expect(bannedIn('your visa and your move overseas')).toEqual(['visa', 'your move', 'overseas']);
    expect(bannedIn('a certified copy of your MRCGP and CCT')).toEqual(['MRCGP', 'CCT', 'certified copy']);
    expect(bannedIn('Indemnity certificate of currency')).toEqual([]);
    // the overseas page really does carry these words, so the scan would catch a leak
    expect(bannedIn(overseasPage).length).toBeGreaterThan(3);
  });
});

describe('the Australian My Documents page and its script', () => {
  it('the page source has none of the words (markup, styles, script, comments)', () => {
    expect(bannedIn(pageHtml)).toEqual([]);
  });
  it('the script source has none of the words (strings, comments, identifiers)', () => {
    expect(bannedIn(pageJs)).toEqual([]);
  });
  it('the tabs are "You provide" and "We prepare", and there is no "Direct to" tab', () => {
    expect(pageJs).toContain('You provide');
    expect(pageJs).toContain('We prepare');
    expect(pageJs + pageHtml).not.toMatch(/Direct to/i);
  });
  it('the page loads the helper and its own script with cache-busters, and the service worker precaches the script', () => {
    expect(pageHtml).toContain('<script src="/js/au-pathway.js?v=20261120b"></script>');
    expect(pageHtml).toContain('<script src="/js/my-documents-au.js?v=20261120b"></script>');
    expect(read('sw.js')).toContain('"/js/my-documents-au.js?v=20261120b"');
    expect(read('sw.js')).toContain('"/js/au-pathway.js?v=20261120b"');
    expect(read('sw.js')).toContain('var VERSION = "20261121c"');
  });
  it('the crop helper is loaded and used through its one entry point, and nothing else of the upload machinery is redefined', () => {
    expect(pageHtml).toContain('../js/doc-crop.js?v=20260813a');
    expect(pageJs).toMatch(/crop\.prepare\(file, \{ label: label, origin: 'upload' \}\)/);
    // a cancelled crop means "no file was picked"; a failed crop sends the original
    expect(pageJs).toMatch(/return out === null \? null : \(out \|\| file\)/);
    expect(pageJs).toMatch(/\.catch\(function \(\) \{ return file; \}\)/);
    // no list of documents lives in the browser
    expect(pageJs).not.toMatch(/au_indemnity_certificate|au_ahpra_certificate|au_wwcc/);
  });
  it('the inline script and the script file parse', () => {
    const inline = pageHtml.match(/<script>([\s\S]*?)<\/script>/g).map((s) => s.replace(/^<script>|<\/script>$/g, ''));
    expect(inline.length).toBeGreaterThanOrEqual(2);
    for (const src of inline) expect(() => new vm.Script(src)).not.toThrow();
    expect(() => new vm.Script(pageJs)).not.toThrow();
  });
});

describe('the rendered view (the script run against a sample list)', () => {
  const sandbox = { window: {}, module: { exports: {} } };
  sandbox.window = sandbox;
  vm.runInNewContext(pageJs, sandbox, { filename: 'my-documents-au.js' });
  const view = sandbox.GPMyDocumentsAu;
  const NOW = Date.parse('2026-11-20T00:00:00Z');

  function sampleFor(pathway) {
    const set = docReq.auDocumentRequirements(pathway);
    const item = (i, extra) => Object.assign({
      key: i.key, label: i.label, short: i.short, help: i.help, provider: i.provider, phase: i.phase, required: i.required,
      expiryTracked: i.expiryTracked, expiryLabel: i.expiryLabel, status: 'pending', fileName: '', updatedAt: null, expiresAt: null,
      note: '', canUpload: i.provider === 'you' && i.storage === 'au_reg', downloadUrl: '', manageUrl: i.storage === 'careers' ? '/pages/career.html' : ''
    }, extra || {});
    return {
      youProvide: set.youProvide.map((i, n) => item(i, n === 1
        ? { status: 'approved', fileName: 'FAKE.pdf', updatedAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', downloadUrl: '/api/gp/au-documents/download?key=' + i.key }
        : (n === 3 ? { status: 'rejected', fileName: 'FAKE.pdf', note: docAiReview.rejectionMessageFor('illegible', i.label, '') } : {}))),
      weProvide: set.weProvide.map((i) => item(i))
    };
  }

  for (const pathway of AU_PATHWAYS) {
    it(`${pathway}: both tabs render every item, with status, help and actions, and none of the words`, () => {
      const data = sampleFor(pathway);
      for (const tab of ['you', 'we']) {
        const html = view._viewHtml(data, tab, NOW);
        expect(bannedIn(html)).toEqual([]);
        expect(html).toContain('You provide');
        expect(html).toContain('We prepare');
        for (const i of data.youProvide.concat(data.weProvide)) expect(html).toContain('data-aud-key="' + i.key + '"');
      }
      const html = view._viewHtml(data, 'you', NOW);
      expect(html).toContain('What this is and where to find it');
      expect(html).toContain('data-aud-upload="au_indemnity_certificate"');
      expect(html).toContain('Replace');
      expect(html).toContain('Approved');
      expect(html).toContain('Needs another look');
      expect(html).toContain('Needed to apply');
      expect(html).toContain('Add on Careers');
      // the team's items offer no upload
      expect(html).not.toContain('data-aud-upload="au_references"');
      expect(html).not.toContain('data-aud-upload="offer_contract"');
    });
  }

  it('expiry wording: soon, today, past and far off', () => {
    const base = { expiryTracked: true, expiryLabel: 'Cover ends' };
    expect(view._expiryLine(Object.assign({ expiresAt: '2026-12-10T00:00:00Z' }, base), NOW).text).toMatch(/Cover ends .* \(in 20 days\)/);
    expect(view._expiryLine(Object.assign({ expiresAt: '2026-11-20T00:00:00Z' }, base), NOW).text).toMatch(/\(today\)/);
    expect(view._expiryLine(Object.assign({ expiresAt: '2026-11-01T00:00:00Z' }, base), NOW)).toMatchObject({ tone: 'bad' });
    expect(view._expiryLine(Object.assign({ expiresAt: '2027-11-01T00:00:00Z' }, base), NOW)).toMatchObject({ tone: 'idle' });
    expect(view._expiryLine({ expiryTracked: false, expiresAt: '2026-12-10T00:00:00Z' }, NOW)).toBeNull();
  });

  it('text from the server is escaped before it is put on the page', () => {
    const html = view._cardHtml({ key: 'k', label: '<img src=x onerror=1>', short: '"quoted"', help: { steps: ['<b>x</b>'] }, provider: 'you', status: 'rejected', note: '<script>1</script>', fileName: 'a<b>.pdf', canUpload: true }, NOW);
    expect(html).not.toMatch(/<img|<script|<b>/);
    expect(html).toContain('&lt;img');
  });
});

describe('the Australian set: every word a doctor can read', () => {
  for (const pathway of AU_PATHWAYS) {
    it(`${pathway}: labels, descriptions and help`, () => {
      for (const item of docReq.auDocumentRequirements(pathway).items) {
        const text = [item.label, item.short, item.help.title, item.help.steps.join(' '), item.help.reminder, item.expiryLabel].join(' | ');
        expect(bannedIn(text), item.key).toEqual([]);
        expect(text).not.toMatch(/AHPRA/); // new Australian-facing copy spells it "Ahpra"
        expect(text).not.toMatch(/—/); // no em dashes in doctor copy
      }
    });
  }
  it('the doctor label is used wherever a label reaches a doctor (emails, bell); the staff wording stays on the dashboards', () => {
    for (const key of docReq.AU_REG_DOCUMENT_KEYS) {
      expect(bannedIn(docReq.auDocumentLabel(key)), key).toEqual([]);
    }
    // the one staff label that uses a banned word is never the doctor label
    expect(docReq.auDocumentLabel('au_immigration_grant_notice', { staff: true })).toMatch(/Visa/);
    expect(docReq.auDocumentLabel('au_immigration_grant_notice')).not.toMatch(/visa/i);
  });
});

describe('what the real server shows and sends', () => {
  let h;
  const doctors = {};
  const sent = [];
  let realFetch;

  beforeAll(async () => {
    for (const p of AU_PATHWAYS) doctors[p] = fx.buildAuDoctor(p);
    const tables = fx.buildAuFixtureDb(Object.keys(doctors).map((k) => doctors[k]));
    tables.user_documents = [];
    tables.registration_tasks = [];
    tables.task_timeline = [];
    h = await bootAuTestServer({
      name: 'wp07copy', tables,
      env: { RESEND_API_KEY: 're_test_not_a_real_key' },
      emulator: { rpc: { rate_limit_hit: () => ({ allowed: true }) } }
    });
    h.setSwitch(true);
    // Record what would have gone to the email provider. Nothing leaves the machine.
    realFetch = globalThis.fetch;
    globalThis.fetch = function (url, init) {
      const u = String(url && url.url ? url.url : url);
      if (/resend\.com/.test(u)) {
        let body = {};
        try { body = JSON.parse((init && init.body) || '{}'); } catch (e) { body = {}; }
        sent.push(body);
        return Promise.resolve(new Response(JSON.stringify({ id: 'test-email-' + sent.length }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return realFetch(url, init);
    };
  });

  afterAll(async () => {
    if (realFetch) globalThis.fetch = realFetch;
    if (h) { h.testUtils.__setAuDocumentVerifierForTest(null); await h.close(); }
  });

  const cookieFor = (d) => h.gpCookie(d.email, d.userId);
  const upload = (d, key) => h.put('/api/gp/au-documents', {
    key, fileName: 'FAKE ' + key + '.pdf', mimeType: 'application/pdf', fileSize: 60, fileDataUrl: PDF
  }, { cookie: cookieFor(d) });
  const bell = (d) => {
    const row = h.emu.table('user_state').find((r) => r.user_id === d.userId);
    let list = row && row.state ? row.state.gp_link_updates : [];
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = []; } }
    return Array.isArray(list) ? list : [];
  };

  it('the list a doctor receives, for every Australian pathway', async () => {
    for (const p of AU_PATHWAYS) {
      const res = await h.get('/api/gp/au-documents', { cookie: cookieFor(doctors[p]) });
      expect(res.status).toBe(200);
      expect(bannedIn(res.raw), p).toEqual([]);
      const req = await h.get('/api/gp/document-requirements', { cookie: cookieFor(doctors[p]) });
      expect(req.status).toBe(200);
      expect(bannedIn(req.raw), p).toEqual([]);
    }
  });

  it('approved by the automatic review: email and bell', async () => {
    const d = doctors.au_vr;
    const nextYear = (new Date().getUTCFullYear() + 1) + '-06-30';
    h.testUtils.__setAuDocumentVerifierForTest(async () => ({ ok: true, verification: {
      verified: true, legible: true, documentType: 'Certificate of currency', nameFound: 'Test Auvr', coverEnd: nextYear
    } }));
    expect((await upload(d, 'au_indemnity_certificate')).status).toBe(200);
    sent.length = 0;
    const run = await h.get('/api/cron/doc-ai-review', CRON);
    expect(run.json.approved).toBe(1);
    expect(sent.length).toBe(1);
    expect(sent[0].to).toEqual([d.email]);
    expect(String(sent[0].html)).toContain('Indemnity certificate of currency');
    expect(bannedIn(sent[0].subject + ' ' + sent[0].html)).toEqual([]);
    const items = bell(d);
    expect(items[0].title).toBe('Indemnity certificate of currency approved');
    expect(bannedIn(JSON.stringify(items))).toEqual([]);
  });

  it('sent back by the automatic review (unreadable, and a clearly different document): the model\'s own words never reach the doctor', async () => {
    const d = doctors.au_restricted;
    h.testUtils.__setAuDocumentVerifierForTest(async ({ documentKey }) => ({ ok: true, verification: documentKey === 'au_wwcc'
      ? { verified: false, legible: false, documentType: 'unreadable overseas visa page' }
      : { verified: false, legible: true, documentType: 'Overseas visa label for EPIC and AMC', issues: ['This is an overseas visa, not the right document.'] } }));
    expect((await upload(d, 'au_wwcc')).status).toBe(200);
    expect((await upload(d, 'au_right_to_work')).status).toBe(200);
    sent.length = 0;
    const run = await h.get('/api/cron/doc-ai-review', CRON);
    expect(run.json.rejected).toBe(2);
    expect(sent.length).toBe(2);
    for (const mail of sent) {
      expect(mail.to).toEqual([d.email]);
      expect(bannedIn(mail.subject + ' ' + mail.html)).toEqual([]);
    }
    expect(bannedIn(JSON.stringify(bell(d)))).toEqual([]);
    const mine = await h.get('/api/gp/au-documents', { cookie: cookieFor(d) });
    expect(bannedIn(mine.raw)).toEqual([]);
    expect(mine.json.youProvide.find((i) => i.key === 'au_right_to_work').note).toMatch(/does not look like your Right to work in Australia/);
    // the bell item links to the card on My Documents
    expect(bell(d).some((i) => i.target === '/pages/my-documents.html?reupload=au_right_to_work')).toBe(true);
  });

  it('approved and sent back by staff: the decision lands on the au_reg row and the emails are clean', async () => {
    const d = doctors.au_non_vr;
    h.testUtils.__setAuDocumentVerifierForTest(async () => { throw new Error('model unavailable'); });
    expect((await upload(d, 'au_indemnity_certificate')).status).toBe(200);
    expect((await upload(d, 'au_wwcc')).status).toBe(200);
    await h.get('/api/cron/doc-ai-review', CRON); // leaves both with a person
    const tasks = h.emu.table('registration_tasks').filter((t) => t.case_id === d.caseId && t.status === 'open');
    expect(tasks.map((t) => t.related_document_key).sort()).toEqual(['au_indemnity_certificate', 'au_wwcc']);
    expect(tasks.every((t) => t.related_stage === 'prestart')).toBe(true);
    const sa = h.superAdmin();
    sent.length = 0;
    const approve = await h.post('/api/admin/va/task/review-flagged-doc',
      { task_id: tasks.find((t) => t.related_document_key === 'au_indemnity_certificate').id, decision: 'approve' }, sa);
    expect(approve.status).toBe(200);
    const reject = await h.post('/api/admin/va/task/review-flagged-doc',
      { task_id: tasks.find((t) => t.related_document_key === 'au_wwcc').id, decision: 'reject', note: 'The expiry date is cut off. Please upload a photo of the whole card.' }, sa);
    expect(reject.status).toBe(200);

    const rows = h.emu.table('user_documents').filter((r) => r.user_id === d.userId);
    // one row per document, still under au_reg: the decision did not create a 'uk' twin
    expect(rows.map((r) => r.document_key + ':' + r.country_code).sort()).toEqual(['au_indemnity_certificate:au_reg', 'au_wwcc:au_reg']);
    const ind = rows.find((r) => r.document_key === 'au_indemnity_certificate');
    const wwcc = rows.find((r) => r.document_key === 'au_wwcc');
    expect(ind.status).toBe('approved');
    expect(ind.file_name).toBe('FAKE au_indemnity_certificate.pdf'); // the doctor's file name is kept
    expect(wwcc.status).toBe('rejected');
    expect(wwcc.rejection_reason).toMatch(/expiry date is cut off/);

    expect(sent.length).toBe(2);
    for (const mail of sent) expect(bannedIn(mail.subject + ' ' + mail.html)).toEqual([]);
    expect(String(sent[0].html)).toContain('Indemnity certificate of currency');
    const mine = await h.get('/api/gp/au-documents', { cookie: cookieFor(d) });
    expect(mine.json.youProvide.find((i) => i.key === 'au_indemnity_certificate').status).toBe('approved');
    expect(mine.json.youProvide.find((i) => i.key === 'au_wwcc').status).toBe('rejected');
    // approving did not flag an overseas-style "name change" on the profile
    const prof = h.emu.table('user_profiles').find((r) => r.user_id === d.userId);
    expect(prof.name_change_detected === true).toBe(false);
  });
});

describe('expiry reminders', () => {
  it('the reminder wording, filled in with each expiry-tracked Australian label, has none of the words', () => {
    const block = serverJs.slice(serverJs.indexOf("var wsNudgeTitle = wsExpired"), serverJs.indexOf("var wsDocTarget = '/pages/my-documents.html?reupload='"));
    expect(block.length).toBeGreaterThan(200);
    const literals = (block.match(/'[^'\n]*'/g) || []).map((s) => s.slice(1, -1));
    expect(literals.join(' ')).toMatch(/expires on/);
    for (const key of docReq.AU_EXPIRY_TRACKED_KEYS) {
      const text = literals.join(' ' + docReq.auDocumentLabel(key) + ' ');
      expect(bannedIn(text), key).toEqual([]);
    }
    // an Australian document's "expired" reminder does not talk about a registration being held up
    expect(block).toMatch(/isAuDocumentCountry\(wsDoc\.country_code\) && wsExpired/);
    expect(block).toContain('so your file stays up to date');
  });
});

describe('the standard My Documents page (what an Australian doctor must never be left looking at)', () => {
  it('loads the helper, asks GPAuPathway, and replaces itself for a doctor on an Australian pathway', () => {
    expect(overseasPage).toContain('<script src="/js/au-pathway.js?v=20261120b"></script>');
    expect(overseasPage).toMatch(/window\.GPAuPathway\.init\(\)\.then/);
    expect(overseasPage).toMatch(/isAu = au\.enabled\(\) === true && au\.mine\(\)\.isAu === true/);
    expect(overseasPage).toMatch(/if \(!isAu\) \{ reveal\(\); return; \}/);
    expect(overseasPage).toContain('window.location.replace(next)');
    // a remembered hint hides the page before anything is painted
    expect(overseasPage).toContain("localStorage.getItem('gp_au_pathway_hint')==='1'");
  });
  it('the words it can put in front of an Australian doctor while it replaces itself are clean', () => {
    const guard = overseasPage.slice(overseasPage.indexOf('// Australian GP build (WP-07). Who is this page for?'), overseasPage.indexOf('<div class="legal-footer"'));
    const literals = (guard.match(/'[^'\n]*'|"[^"\n]*"/g) || []).join(' ');
    expect(literals).toContain('Loading your documents');
    expect(bannedIn(literals)).toEqual([]);
  });
  it('every inline script on the page still parses', () => {
    const scripts = overseasPage.match(/<script>([\s\S]*?)<\/script>/g).map((s) => s.replace(/^<script>|<\/script>$/g, ''));
    expect(scripts.length).toBeGreaterThanOrEqual(4);
    for (const src of scripts) expect(() => new vm.Script(src)).not.toThrow();
  });
  it('the legacy default is named, in one place, and the rest of the page is otherwise what it was', () => {
    expect(overseasPage).toContain('const LEGACY_OVERSEAS_DOC_COUNTRY = "uk";');
    expect((overseasPage.match(/return "uk";/g) || []).length).toBe(1); // only the genuine "this is the UK" branch
    expect(overseasPage).toContain('let COUNTRY_DOCS = FALLBACK_COUNTRY_DOCS');
    expect(overseasPage).toContain('data-doc-tab="direct_to_ahpra"');
  });
});
