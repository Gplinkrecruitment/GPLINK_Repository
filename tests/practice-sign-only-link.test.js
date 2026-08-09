import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { stampAgreementExecutionPage } from '../lib/practice-agreement-pdf.js';
import {
  VARIANTS, DEFAULT_VARIANT, listAgreementVariants, isAgreementVariant,
  getAgreementVariant, resolveAgreementVariant, isSignOnlyPractice
} from '../lib/agreement-variants.js';

/*
 * A practice on a negotiated rate could not e-sign at all. The agreement PDF was
 * hard-coded in two places — the intake page's iframe and the server-side stamper —
 * so whatever had been agreed over email, the practice signed the standard $25,000
 * schedule. And the sign endpoint refused outright without a completed five-step
 * intake (409 intake_incomplete), which is pointless friction for a practice that
 * was signed up over the phone.
 *
 * Both are now per-practice, off practices.metadata:
 *   sign_only         — skip the intake, land on the agreement
 *   agreement_variant — which PDF is shown AND stamped
 *
 * The failure direction is deliberate: an unknown variant resolves to standard, so
 * a typo can never quietly hand a practice a discounted contract.
 */

const ROOT = path.resolve(__dirname, '..');
const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const intakeHtml = fs.readFileSync(path.join(ROOT, 'pages/practice-intake.html'), 'utf8');
const practicesJs = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-practices.js'), 'utf8');

/* ── the variant registry ────────────────────────────────────────────────── */

describe('agreement variants', () => {
  it('ships both agreements, and the files actually exist', () => {
    expect(listAgreementVariants().map((v) => v.key).sort()).toEqual(['discounted-2026', 'standard']);
    Object.values(VARIANTS).forEach((v) => {
      expect(fs.existsSync(path.join(ROOT, v.file)), v.file).toBe(true);
      expect(fs.existsSync(path.join(ROOT, v.source)), v.source).toBe(true);
      // A truncated build would still "exist" — the real agreement is ~2.8 MB.
      expect(fs.statSync(path.join(ROOT, v.file)).size).toBeGreaterThan(1_000_000);
    });
  });

  it('the two PDFs are genuinely different documents', () => {
    const a = fs.readFileSync(path.join(ROOT, VARIANTS.standard.file));
    const b = fs.readFileSync(path.join(ROOT, VARIANTS['discounted-2026'].file));
    expect(a.equals(b)).toBe(false);
  });

  it('the discounted source carries the four agreed rates, struck through', () => {
    const src = fs.readFileSync(path.join(ROOT, VARIANTS['discounted-2026'].source), 'utf8');
    [['$25,000', '$20,000'], ['$21,000', '$19,000'], ['$21,000', '$18,000'], ['$18,000', '$17,000']]
      .forEach(([was, now]) => {
        expect(src, was + ' -> ' + now).toContain('<span class="was">' + was + '</span> <span class="now">' + now + '</span>');
      });
    // The standard agreement must not have been touched by the variant build.
    expect(fs.readFileSync(path.join(ROOT, VARIANTS.standard.source), 'utf8')).not.toContain('class="was"');
  });

  it('falls back to standard for anything unrecognised — never to a discount', () => {
    ['', null, undefined, 'nope', 'DISCOUNTED-2026', 'discounted', 0, {}].forEach((k) => {
      expect(getAgreementVariant(k).key, String(k)).toBe('standard');
    });
    expect(DEFAULT_VARIANT).toBe('standard');
    expect(isAgreementVariant('discounted-2026')).toBe(true);
    expect(isAgreementVariant('nope')).toBe(false);
  });

  it('reads the variant off the practice row', () => {
    expect(resolveAgreementVariant({ metadata: { agreement_variant: 'discounted-2026' } }).key).toBe('discounted-2026');
    expect(resolveAgreementVariant({ metadata: {} }).key).toBe('standard');
    expect(resolveAgreementVariant({}).key).toBe('standard');
    expect(resolveAgreementVariant(null).key).toBe('standard');
  });

  it('sign-only is opt-in and strictly boolean true', () => {
    expect(isSignOnlyPractice({ metadata: { sign_only: true } })).toBe(true);
    [{ metadata: { sign_only: 'true' } }, { metadata: { sign_only: 1 } },
     { metadata: {} }, {}, null].forEach((p) => {
      expect(isSignOnlyPractice(p)).toBe(false);
    });
  });
});

/* ── the discounted PDF can actually be executed ─────────────────────────── */

describe('stamping the discounted agreement', () => {
  const TINY_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('takes an execution page like the standard one does', async () => {
    // A variant that cannot be stamped is a variant that cannot be signed — this is
    // the one part of the server path worth executing rather than grepping.
    const bytes = fs.readFileSync(path.join(ROOT, VARIANTS['discounted-2026'].file));
    const before = (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount();

    const out = await stampAgreementExecutionPage({
      agreementBytes: bytes,
      signaturePngDataUrl: TINY_PNG,
      signedName: 'Jo Brand',
      practiceName: 'Riverstone Family Medical',
      legalEntityName: 'Riverstone Family Medical Pty Ltd',
      abnAcn: 'ABN 51824753556',
      signerJobTitle: 'Practice Manager',
      dateLabel: '09 August 2026',
      ipAddress: '203.0.113.42',
      token: 'tok_' + 'a'.repeat(28)
    });

    expect(Buffer.isBuffer(out)).toBe(true);
    expect((await PDFDocument.load(out)).getPageCount()).toBe(before + 1);
    // Deliberately NOT asserting the output is bigger: pdf-lib re-serialises and
    // dedupes the 900+ embedded images, so a correctly stamped copy comes out
    // smaller than the source. practice-agreement-pdf.test.js covers "real content
    // was added" properly, by diffing against an unmodified round trip.
    expect(out.length).toBeGreaterThan(1_000_000);
  });

  it('has the same page count as the standard agreement, so nothing reflowed', async () => {
    const std = (await PDFDocument.load(fs.readFileSync(path.join(ROOT, VARIANTS.standard.file)), { ignoreEncryption: true })).getPageCount();
    const disc = (await PDFDocument.load(fs.readFileSync(path.join(ROOT, VARIANTS['discounted-2026'].file)), { ignoreEncryption: true })).getPageCount();
    expect(disc).toBe(std);
  });
});

/* ── the server no longer hard-codes one PDF ─────────────────────────────── */

describe('the sign endpoint', () => {
  it('stamps the practice\'s own variant, not a single shared template', () => {
    expect(serverJs).toContain('const signVariant = agreementVariants.resolveAgreementVariant(practice);');
    expect(serverJs).toContain('agreementBytes: signAgreementBytes,');
    // The old single-slot cache would have served whichever variant was read first.
    expect(serverJs).not.toContain('let _agreementPdfBytes = null;');
    expect(serverJs).toContain('const _agreementPdfBytesByVariant = new Map();');
  });

  it('waives the intake requirement only for sign-only practices', () => {
    expect(serverJs).toContain('const signOnly = agreementVariants.isSignOnlyPractice(practice);');
    expect(serverJs).toContain('if (!intake && !signOnly) {');
    expect(serverJs).toContain("sendJson(res, 409, { ok: false, error: 'intake_incomplete' });");
  });

  it('does not try to build a job listing out of a missing intake', () => {
    // createPendingJobFromIntake dereferences intake.nearest_city on its first line,
    // so an unguarded call would throw AFTER the signed PDF was stored.
    expect(serverJs).toContain('const createdJob = intake ? await createPendingJobFromIntake(practice, intake) : null;');
    const fn = serverJs.slice(serverJs.indexOf('async function createPendingJobFromIntake'));
    expect(fn.slice(0, 400)).toContain('intake.nearest_city');
  });
});

describe('the agreement is served behind the token', () => {
  it('has its own endpoint rather than a public /assets path', () => {
    expect(serverJs).toContain("if (pathname === '/api/practice-intake/agreement' && req.method === 'GET')");
    expect(serverJs).toContain('const agPractice = await findPracticeByIntakeToken(agToken);');
    expect(serverJs).toContain("'Content-Type': 'application/pdf',");
  });

  it('a short or unknown token gets nothing', () => {
    const at = serverJs.indexOf("if (pathname === '/api/practice-intake/agreement'");
    const block = serverJs.slice(at, at + 1400);
    expect(block).toContain('if (agToken.length < 16) { sendJson(res, 404, { ok: false }); return; }');
    expect(block).toContain('if (!agPractice) { sendJson(res, 404, { ok: false }); return; }');
  });

  it('is never held by a shared cache — it is a per-practice document', () => {
    const at = serverJs.indexOf("if (pathname === '/api/practice-intake/agreement'");
    expect(serverJs.slice(at, at + 1400)).toContain("'Cache-Control': 'private, no-store'");
  });

  it('tells the page which mode and which PDF', () => {
    expect(serverJs).toContain('sign_only: agreementVariants.isSignOnlyPractice(practice),');
    expect(serverJs).toContain("agreement_url: '/api/practice-intake/agreement?token=' + encodeURIComponent(token)");
  });
});

/* ── minting the link ────────────────────────────────────────────────────── */

describe('POST /api/ats/practice/sign-link', () => {
  const at = serverJs.indexOf("if (pathname === '/api/ats/practice/sign-link'");
  const block = serverJs.slice(at, at + 2600);

  it('exists and is staff-only', () => {
    expect(at).toBeGreaterThan(-1);
    expect(block).toContain('requireAtsSession(req, res)');
  });

  it('rejects an unknown variant rather than silently defaulting', () => {
    expect(block).toContain('if (!agreementVariants.isAgreementVariant(slVariantKey)) {');
    expect(block).toContain("message: 'Unknown agreement variant.'");
  });

  it('refuses a practice that has already signed', () => {
    expect(block).toContain("if (slRow.agreement_status === 'signed')");
  });

  it('reuses an existing token so links already sent keep working', () => {
    expect(block).toContain('var slToken = slRow.intake_token || (slRow.metadata && slRow.metadata.intake_token);');
  });

  it('fails closed when the flags cannot be persisted', () => {
    // An unpersisted token never matches findPracticeByIntakeToken, so returning the
    // URL anyway hands over a link that always reads "expired".
    expect(block).toContain('if (!slSaved) {');
    expect(block).toContain("sendJson(res, 502, { ok: false, message: 'Could not save the signing link. Please try again.' });");
  });

  it('writes both flags together', () => {
    expect(block).toContain('sign_only: true,');
    expect(block).toContain('agreement_variant: slVariantKey');
  });
});

/* ── the practice-facing page ────────────────────────────────────────────── */

describe('the intake page in sign-only mode', () => {
  it('skips the five-step form and opens on the agreement', () => {
    expect(intakeHtml).toContain('function enterSignOnlyMode()');
    expect(intakeHtml).toContain("if (currentPractice.sign_only === true) { enterSignOnlyMode(); return; }");
    expect(intakeHtml).toContain("var rail = $('stepsRail'); if (rail) rail.classList.add('hidden');");
    const fn = intakeHtml.slice(intakeHtml.indexOf('function enterSignOnlyMode()'));
    expect(fn.slice(0, 400)).toContain('go(5);');
  });

  it('loads the PDF from the per-practice URL, not the hard-coded asset', () => {
    expect(intakeHtml).toContain("var frame = $('pdfFrame'); if (frame) frame.src = currentPractice.agreement_url;");
    expect(intakeHtml).toContain("var dl = $('pdfDownloadLink'); if (dl) dl.href = currentPractice.agreement_url;");
  });

  it('can actually reach the Sign button with no intake behind it', () => {
    // The first gate was `saved.length > 0`, which a sign-only practice can never meet.
    expect(intakeHtml).toContain('signOnly || saved.length > 0,');
  });

  it('still shows a Schedule 1 naming the practice', () => {
    expect(intakeHtml).toContain('signOnlyRow: true');
    expect(intakeHtml).toContain("(currentPractice && currentPractice.name) || 'Your practice'");
  });

  it('does not promise a job listing that was never created', () => {
    // The server skips job creation with no intake, so the stock success copy
    // ("Your job listing is with our team for approval") would be a lie, and the
    // tracking link would open an empty status page.
    expect(intakeHtml).toContain('if (signOnly) {');
    expect(intakeHtml).toContain('A copy is on its way to your inbox.');
    const at = intakeHtml.indexOf('function showSuccess()');
    const fn = intakeHtml.slice(at, at + 1200);
    expect(fn).toMatch(/if \(signOnly\)[\s\S]*successCopy[\s\S]*else[\s\S]*trackListingLink/);
  });

  it('knows it is sign-only before the already-signed branch runs', () => {
    // showSuccess() is reached directly when a signed link is reopened; the flag has
    // to be set above that check or the reopened page shows the wrong copy.
    const at = intakeHtml.indexOf('currentPractice = res.data.practice;');
    const after = intakeHtml.slice(at, at + 600);
    expect(after.indexOf('signOnly = currentPractice.sign_only === true;'))
      .toBeLessThan(after.indexOf("if (currentPractice.agreement_status === 'signed')"));
  });
});

/* ── the staff control ───────────────────────────────────────────────────── */

describe('the RSO console control', () => {
  it('offers both variants and creates the link', () => {
    expect(practicesJs).toContain('function signLinkHtml(p)');
    expect(practicesJs).toContain('data-ats="sign-link"');
    expect(practicesJs).toContain("else if (action === 'sign-link') createSignLink(id, t);");
    expect(practicesJs).toContain('<option value="discounted-2026">Discounted 2026 rates</option>');
  });

  it('hides itself once the practice has signed', () => {
    expect(practicesJs).toContain("if (p.agreement_status === 'signed') return '';");
  });

  it('renders the token-bearing URL as text, never as markup', () => {
    expect(practicesJs).toContain('a.textContent = d.url;');
    expect(practicesJs).not.toMatch(/atsSignLinkOut[\s\S]{0,200}innerHTML\s*=\s*[^']*d\.url/);
  });

  it('bumped its cache-buster, or the console keeps the old bundle', () => {
    const ceo = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');
    expect(ceo).toContain('/js/ceo-ats-practices.js?v=20260809a');
    expect(ceo).not.toContain('/js/ceo-ats-practices.js?v=20260805d');
  });
});
