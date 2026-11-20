import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { describe, it, expect, afterEach } from 'vitest';

/*
 * WP-28: the DRAFT Australian-GP presentation of the 2026 practice agreement.
 *
 * Two promises are pinned here:
 *
 *   1. The draft can never be offered to, sent to, or signed by a practice. Every
 *      list, picker, validator and resolver behaves exactly as it does without the
 *      draft, with AU_PATHWAY_ENABLED off AND on.
 *   2. The draft is a re-skin, not a re-draft. Once the draft markings are stripped,
 *      pages 4 to 16 (fee schedule, agreement-to-terms page, clauses 1 to 16) are
 *      character-for-character the standard agreement: same fees, same payment
 *      timing, same guarantee, same clauses.
 *
 * server.js is not booted (it exports nothing for these routes); its call sites are
 * pinned by reading the source, the same way tests/practice-sign-only-link.test.js does.
 */

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const LIB_PATH = path.join(ROOT, 'lib/agreement-variants.js');
const variants = require(LIB_PATH);

const DRAFT_KEY = 'au-2026-draft';
const MARK = 'DRAFT - FOR LEGAL REVIEW - NOT FOR SIGNATURE';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const serverJs = read('server.js');
const practicesJs = read('js/ceo-ats-practices.js');
const intakeHtml = read('pages/practice-intake.html');
const standardSrc = read('assets/legal/src/agreement-2026.html');
const draftRecord = variants.getDraftAgreementVariant(DRAFT_KEY);
const draftSrc = read(draftRecord.source);

function withFlag(value, fn) {
  const before = process.env.AU_PATHWAY_ENABLED;
  if (value === undefined) delete process.env.AU_PATHWAY_ENABLED; else process.env.AU_PATHWAY_ENABLED = value;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.AU_PATHWAY_ENABLED; else process.env.AU_PATHWAY_ENABLED = before;
  }
}

/** A fresh copy of the module, loaded while the switch is in the given state. */
function freshLib() {
  delete require.cache[require.resolve(LIB_PATH)];
  return require(LIB_PATH);
}

afterEach(() => { delete require.cache[require.resolve(LIB_PATH)]; });

/* ── 1. never selectable, never sendable, never signable ─────────────────── */

describe('the draft variant is unreachable through every selectable path', () => {
  // Spellings a caller might try. None may reach the draft.
  const SPELLINGS = [
    DRAFT_KEY, ' ' + DRAFT_KEY + ' ', DRAFT_KEY.toUpperCase(), 'au-2026', 'au', 'draft',
    'AU-2026-DRAFT', 'au_2026_draft', 'australian', 'au-draft'
  ];

  [['off', '0'], ['on', '1'], ['unset', undefined]].forEach(([name, value]) => {
    describe('AU_PATHWAY_ENABLED ' + name, () => {
      it('the selectable list is exactly the two existing agreements', () => {
        withFlag(value, () => {
          const lib = freshLib();
          expect(lib.listAgreementVariants()).toEqual([
            { key: 'standard', label: 'Standard 2026 rates' },
            { key: 'discounted-2026', label: 'Discounted 2026 rates' }
          ]);
          expect(Object.keys(lib.VARIANTS)).toEqual(['standard', 'discounted-2026']);
          expect(lib.DEFAULT_VARIANT).toBe('standard');
        });
      });

      it('the send validator rejects the draft key in every spelling', () => {
        withFlag(value, () => {
          const lib = freshLib();
          SPELLINGS.forEach((k) => expect(lib.isAgreementVariant(k), k).toBe(false));
          // ...and still accepts the two real ones.
          expect(lib.isAgreementVariant('standard')).toBe(true);
          expect(lib.isAgreementVariant('discounted-2026')).toBe(true);
        });
      });

      it('a practice row that names the draft is shown and signs the STANDARD agreement', () => {
        withFlag(value, () => {
          const lib = freshLib();
          SPELLINGS.forEach((k) => {
            expect(lib.getAgreementVariant(k).key, k).toBe('standard');
            const practice = { metadata: { agreement_variant: k, sign_only: true } };
            const resolved = lib.resolveAgreementVariant(practice);
            expect(resolved.key, k).toBe('standard');
            expect(resolved.file, k).toBe('assets/legal/gp-link-practice-agreement-2026.pdf');
            expect(resolved.draft).toBeUndefined();
          });
        });
      });

      it('no selectable variant is, points at, or shares a key with a draft', () => {
        withFlag(value, () => {
          const lib = freshLib();
          const drafts = lib.listDraftAgreementVariants();
          expect(drafts.map((d) => d.key)).toEqual([DRAFT_KEY]);
          Object.values(lib.VARIANTS).forEach((v) => {
            expect(v.draft, v.key).toBeUndefined();
            expect(lib.isDraftAgreementVariant(v.key), v.key).toBe(false);
            drafts.forEach((d) => {
              expect(v.key).not.toBe(d.key);
              expect(v.source).not.toBe(d.source);
              expect(v.label).not.toBe(d.label);
            });
          });
        });
      });
    });
  });

  it('the draft record says what it is, and has no PDF to serve', () => {
    expect(draftRecord).toMatchObject({ key: DRAFT_KEY, draft: true, selectable: false, file: null, basedOn: 'standard' });
    expect(draftRecord.label).toMatch(/^DRAFT/);
    expect(draftRecord.label).toMatch(/not for signature/i);
    expect(fs.existsSync(path.join(ROOT, draftRecord.source))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, draftRecord.legalReview))).toBe(true);
  });

  it('draft accessors hand out copies and never fall back to a real agreement', () => {
    const a = variants.getDraftAgreementVariant(DRAFT_KEY);
    a.selectable = true; a.draft = false; a.file = 'assets/legal/gp-link-practice-agreement-2026.pdf';
    const b = variants.getDraftAgreementVariant(DRAFT_KEY);
    expect(b.selectable).toBe(false);
    expect(b.draft).toBe(true);
    expect(b.file).toBe(null);
    const listed = variants.listDraftAgreementVariants();
    listed[0].selectable = true;
    expect(variants.listDraftAgreementVariants()[0].selectable).toBe(false);

    [null, undefined, '', 'standard', 'discounted-2026', 'nope', '__proto__', 'constructor']
      .forEach((k) => expect(variants.getDraftAgreementVariant(k), String(k)).toBe(null));
    expect(variants.isDraftAgreementVariant('standard')).toBe(false);
    // The raw draft map is not exported, so nothing outside the module can edit it.
    expect(variants.DRAFT_VARIANTS).toBeUndefined();
  });

  it('nothing built or public exists for the draft', () => {
    // Everything under assets/ is served publicly by server.js (PUBLIC_STATIC_DIRS).
    expect(serverJs).toContain("const PUBLIC_STATIC_DIRS = new Set(['pages', 'js', 'css', 'media', 'documents', 'assets']);");
    const publicRoots = ['pages', 'js', 'css', 'media', 'documents', 'assets'];
    expect(publicRoots).not.toContain(draftRecord.source.split('/')[0]);
    const legalDir = fs.readdirSync(path.join(ROOT, 'assets/legal'));
    expect(legalDir.sort()).toEqual([
      'gp-link-practice-agreement-2026-discounted.pdf', 'gp-link-practice-agreement-2026.pdf', 'src'
    ]);
    expect(fs.readdirSync(path.join(ROOT, 'assets/legal/src')).sort())
      .toEqual(['agreement-2026-discounted.html', 'agreement-2026.html', 'logo.png', 'strip.png']);
  });

  it('the draft build script cannot write into the public assets folder', () => {
    const sh = read('scripts/build-au-draft-agreement-pdf.sh');
    expect(sh).toContain('"$ROOT"/assets/*)');
    expect(sh).toContain('Refusing to write the draft into assets/');
    expect(sh).toContain('docs/au-gp/legal-draft/agreement-2026-au-draft.html');
    // The real build script is untouched and knows nothing of the draft.
    expect(read('scripts/build-practice-agreement-pdf.sh')).not.toMatch(/draft/i);
  });
});

describe('server and admin call sites still go only through the selectable functions', () => {
  it('server.js never reaches for a draft', () => {
    expect(serverJs).not.toContain(DRAFT_KEY);
    expect(serverJs).not.toMatch(/DraftAgreementVariant|DRAFT_VARIANTS/);
    expect(serverJs).not.toContain('legal-draft');
  });

  it('every agreementVariants.* use in server.js is one of the known selectable-only calls', () => {
    const uses = serverJs.match(/agreementVariants\.[A-Za-z_]+/g) || [];
    expect(uses.length).toBeGreaterThan(0);
    const allowed = new Set([
      'agreementVariants.DEFAULT_VARIANT',
      'agreementVariants.getAgreementVariant',
      'agreementVariants.resolveAgreementVariant',
      'agreementVariants.isAgreementVariant',
      'agreementVariants.isSignOnlyPractice'
    ]);
    uses.forEach((u) => expect(allowed.has(u), u).toBe(true));
  });

  it('the sign-link endpoint refuses any key the validator does not know, before saving anything', () => {
    const start = serverJs.indexOf("if (pathname === '/api/ats/practice/sign-link' && req.method === 'POST') {");
    expect(start).toBeGreaterThan(-1);
    const block = serverJs.slice(start, start + 4000);
    const guard = block.indexOf('if (!agreementVariants.isAgreementVariant(slVariantKey)) {');
    const save = block.indexOf('atsUpdatePracticeRow(');
    expect(guard).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(guard);
    expect(block.slice(guard, guard + 200)).toContain("sendJson(res, 400, { ok: false, message: 'Unknown agreement variant.' });");
    // Which is exactly the answer the draft key gets.
    expect(variants.isAgreementVariant(DRAFT_KEY)).toBe(false);
  });

  it('the PDF and signing endpoints resolve through the fallback-to-standard resolver', () => {
    expect(serverJs).toContain('const agVariant = agreementVariants.resolveAgreementVariant(agPractice);');
    expect(serverJs).toContain('const signVariant = agreementVariants.resolveAgreementVariant(practice);');
    expect(serverJs).toContain('const getVariant = agreementVariants.resolveAgreementVariant(practice);');
  });

  it('the admin picker and the practice signing page offer no draft', () => {
    const options = practicesJs.match(/<option value="[^"]*">[^<]*<\/option>/g) || [];
    const variantOptions = options.filter((o) => /2026 rates/.test(o));
    expect(variantOptions).toEqual([
      '<option value="standard">Standard 2026 rates</option>',
      '<option value="discounted-2026">Discounted 2026 rates</option>'
    ]);
    [practicesJs, intakeHtml].forEach((text) => {
      expect(text).not.toContain(DRAFT_KEY);
      expect(text).not.toContain('legal-draft');
    });
  });
});

/* ── 2. the draft document itself ─────────────────────────────────────────── */

function pages(html) {
  // `<div class="page">` or `<div class="page lr-page">`, but not `class="pagenum"`.
  return html.split(/<div class="page(?=[" ])/).slice(1);
}

/** Remove everything the draft adds on top of the standard wording. */
function stripDraftAdditions(html) {
  return html
    .replace(/<span class="lr">LR-\d+<\/span>/g, '')
    .replace(/^ {2}<div class="draft-mark">[^<]*<\/div>\n/gm, '');
}

function fromPage4(html, endMarker) {
  const start = html.indexOf('PAGE 4 — RECRUITMENT FEES');
  const end = html.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end).trim();
}

describe('the draft document', () => {
  it('carries the visible draft mark on every page, three ways', () => {
    const ps = pages(draftSrc);
    expect(ps.length).toBe(17);
    ps.forEach((p, i) => {
      expect(p, 'page ' + (i + 1)).toContain('<div class="draft-mark">' + MARK + '</div>');
    });
    // Generated marks apply to every .page, including any page added later.
    expect(draftSrc).toMatch(/\.page::before \{ content: "DRAFT - FOR LEGAL REVIEW - NOT FOR SIGNATURE";/);
    expect(draftSrc).toMatch(/\.page::after \{ content: "DRAFT - FOR LEGAL REVIEW - NOT FOR SIGNATURE";/);
    expect(draftSrc).toMatch(/<title>DRAFT - [^<]*NOT FOR SIGNATURE<\/title>/);
    // The mark must be shown, not hidden by a later rule.
    expect(draftSrc).not.toMatch(/\.draft-mark[^}]*display:\s*none/);
  });

  it('pages 4 to 16 are the standard agreement, word for word', () => {
    const std = fromPage4(standardSrc, '</body>');
    const draft = fromPage4(stripDraftAdditions(draftSrc), '<!-- ═══════════════ PAGE 17');
    expect(draft).toBe(std);
  });

  it('states the same fees and the same payment timing as the standard agreement', () => {
    [standardSrc, draftSrc].forEach((src) => {
      const s = stripDraftAdditions(src);
      // Based in Australia: nothing on acceptance, the whole fee on commencement.
      expect(s).toContain('For Australian-based\n    GPs, the full fee is invoiced when the placed doctor commences work.');
      expect(s.match(/<td class="bold">\$0<\/td>/g).length).toBe(2);
      expect(s).toContain('<td class="bold">Full-time &mdash; Australian GP</td>\n        <td>$21,000</td>\n        <td class="left">On commencement</td>');
      expect(s).toContain('<td class="bold">Part-time &mdash; Australian GP</td>\n        <td>$18,000</td>\n        <td class="left">On commencement</td>');
      // Overseas tiers are still in the schedule, unchanged.
      expect(s).toContain('<td>$25,000 (two payments of $12,500)</td>');
      expect(s).toContain('<td>$21,000 (two payments of $10,500)</td>');
      // Guarantee credits and locum as written.
      expect(s).toContain('<span>Up to 4 weeks</span>80% of the placement fee');
      expect(s).toContain('<span>Between 4&ndash;8 weeks</span>50% of the placement fee');
      expect(s).toContain('<span>Between 8&ndash;12 weeks</span>35% of the placement fee');
      expect(s).toContain('20% of the gross fees or billings');
    });
    // No new price anywhere: every dollar figure in the draft is in the standard.
    const dollars = (src) => Array.from(new Set(src.match(/\$[\d,]+/g))).sort();
    expect(dollars(draftSrc)).toEqual(dollars(standardSrc));
  });

  it('re-skins the introductory pages for GPs already in Australia', () => {
    const intro = draftSrc.slice(draftSrc.indexOf('<body>'), draftSrc.indexOf('PAGE 4 — RECRUITMENT FEES'));
    expect(intro).toContain('FOR GPs ALREADY BASED IN AUSTRALIA');
    expect(intro).toContain('GPs already based in Australia');
    expect(intro).toContain('public Ahpra register of practitioners');
    expect(intro).toContain('Medicare provider number');
    expect(intro).toContain('12-week guarantee period');
    // The overseas positioning is gone from these pages.
    expect(intro).not.toContain('6&ndash;9 months');
    expect(intro).not.toContain('Registration support for doctors based overseas');
    expect(intro).not.toMatch(/AMC|EPIC|migration agents/);
    // Things a practice must never be told about an Australian GP (AGENT-RULES section 4).
    expect(draftSrc).not.toMatch(/internationally trained|Expedited Specialist Pathway/i);
    // New Australian-facing copy spells the regulator "Ahpra".
    expect(intro).not.toContain('AHPRA');
    // The cover title is an open owner decision: unchanged.
    expect(intro).toContain('<div class="cover-sub">Australia Medical Recruitment<br>Pricing Schedule 2026</div>');
  });

  it('marks every open legal question in the document and lists each on the notes page', () => {
    const notes = draftSrc.slice(draftSrc.indexOf('<!-- ═══════════════ PAGE 17'));
    const body = draftSrc.slice(0, draftSrc.indexOf('<!-- ═══════════════ PAGE 17'));
    expect(notes).toContain('not part of the agreement');
    for (let n = 1; n <= 10; n++) {
      const tag = '<span class="lr">LR-' + n + '</span>';
      expect(notes, 'note LR-' + n).toContain('<div class="k">' + tag + '</div>');
      expect(body, 'spot LR-' + n).toContain(tag);
    }
    // And the owner-facing document covers the same ten.
    const review = read(draftRecord.legalReview);
    for (let n = 1; n <= 10; n++) expect(review, 'LR-' + n).toContain('LR-' + n);
    expect(review).toContain(MARK);
  });

  it('has no stray control characters and keeps its image placeholders', () => {
    // eslint-disable-next-line no-control-regex
    expect(draftSrc).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    expect(draftSrc.match(/\{\{LOGO\}\}/g).length).toBe(17);
    expect(draftSrc.match(/\{\{STRIP\}\}/g).length).toBe(1);
  });

  it('the standard and discounted sources were not touched', () => {
    expect(standardSrc).not.toMatch(/draft-mark|class="lr"|FOR LEGAL REVIEW/);
    expect(read('assets/legal/src/agreement-2026-discounted.html')).not.toMatch(/draft-mark|class="lr"|FOR LEGAL REVIEW/);
  });
});
