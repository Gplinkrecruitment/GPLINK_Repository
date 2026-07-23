import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Phase 3 Task 3 — static source pins on the CEO Practices tab client script
// (same style as tests/ceo-standalone-ui.test.js: readFile + regex asserts).
const root = process.cwd();
const src = fs.readFileSync(path.join(root, 'js/ceo-ats-practices.js'), 'utf8');
const ceo = fs.readFileSync(path.join(root, 'pages/ceo-dashboard.html'), 'utf8');

// The renderDetail region: from the function down to the modals section.
const detailStart = src.indexOf('function renderDetail');
const detailEnd = src.indexOf('==================== MODALS');
const detail = src.slice(detailStart, detailEnd);

describe('CEO Practices tab UI (Phase 3 Task 3)', () => {
  it('add/edit modal carries an Organisation type control wired into create/save', () => {
    expect(src).toMatch(/id="atsFOrgType"/);
    expect(src).toMatch(/value="corporation"/);
    // readForm reads it (defaulting to practice)…
    expect(src).toMatch(/org_type:\s*val\('atsFOrgType'\)\s*\|\|\s*'practice'/);
    // …and savePractice diffs it like every other field (sent only when changed).
    expect(src).toMatch(/'ahpra',\s*'org_type'/);
    expect(src).toMatch(/org_type:\s*p\.org_type\s*\|\|\s*'practice'/);
  });

  it('renders a Corporation badge for corporations only (cards + detail header)', () => {
    expect(src).toMatch(/org_type !== 'corporation'\) return ''/);
    expect(src).toMatch(/>Corporation<\/span>/);
    // Used on the mainstream card, the prospective card, and the detail h2.
    expect((src.match(/corpBadge\(p/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('contract card posts to the manual-upload endpoint and renders both PDF rows', () => {
    expect(src).toMatch(/\/api\/ats\/practice\/contract/);
    expect(src).toMatch(/Signed agreement \(e-signed\)/);
    expect(src).toMatch(/Signed agreement \(uploaded\)/);
    expect(src).toMatch(/agreement_signed_pdf_url/);
    expect(src).toMatch(/agreement_manual_pdf_url/);
    expect(src).toMatch(/agreement_manual_uploaded_at/);
    expect(src).toMatch(/agreement_manual_uploaded_by/);
    // Hidden PDF-only file input + FileReader → dataURL body.
    expect(src).toMatch(/accept="application\/pdf"/);
    expect(src).toMatch(/readAsDataURL/);
    expect(src).toMatch(/file_data:/);
    // Client-side guards mirror the server (type + 10MB) and a busy state exists.
    expect(src).toMatch(/10 \* 1024 \* 1024/);
    expect(src).toMatch(/Uploading…/);
    // Agreement status pill still driven by agreement_status.
    expect(src).toMatch(/agreementPillClass\(p\.agreement_status\)/);
  });

  it('detail view is slim: intake dump and operational fields removed', () => {
    // The whole intake-answers dump card is gone (function AND invocation).
    expect(src).not.toMatch(/intakeCardHtml/);
    expect(src).not.toMatch(/Intake answers/);
    expect(src).not.toMatch(/humanizeKey/);
    // Operational fields no longer render in the detail region.
    expect(detail).not.toMatch(/'Practice type'/);
    expect(detail).not.toMatch(/'AHPRA \/ reg no\.'/);
    expect(detail).not.toMatch(/'Website'/);
    expect(detail).not.toMatch(/'DPA'/);
    expect(detail).not.toMatch(/'Suburb'/);
    expect(detail).not.toMatch(/'Nearest city'/);
    expect(detail).not.toMatch(/Intro text/);
    expect(detail).not.toMatch(/Intro video/);
    // What remains: contact, email, phone, stage.
    expect(detail).toMatch(/'Primary contact'/);
    expect(detail).toMatch(/'Email'/);
    expect(detail).toMatch(/'Phone'/);
    expect(detail).toMatch(/atsStageSelect/);
  });

  it('stage select is retained and still PATCHes on change', () => {
    expect(src).toMatch(/function onStageChange/);
    expect(src).toMatch(/atsStageSelect'\)?\s*onStageChange|id === 'atsStageSelect'/);
  });

  it('jobs card is the doorway to operational detail (hint line present)', () => {
    expect(detail).toMatch(/Jobs at this practice/);
    expect(detail).toMatch(/Billing, DPA, address and role details live on each job/);
    expect(detail).toMatch(/Candidates in pipeline/);
  });

  it('ceo-dashboard.html loads the bumped script', () => {
    expect(ceo).toMatch(/\/js\/ceo-ats-practices\.js\?v=20260724b/);
  });
});

// Phase 6 I2 — corporation parent link + rollup view (same static-pin style).
describe('CEO Practices tab — corporation parent link + rollup (Phase 6 I2)', () => {
  it('add/edit modal carries a parent-corporation dropdown wired into create/save', () => {
    expect(src).toMatch(/id="atsFParentCorpWrap"/);
    expect(src).toMatch(/id="atsFParentCorp"/);
    expect(src).toMatch(/function fetchCorporationChoices/);
    // readForm reads it and savePractice diffs it like every other field.
    expect(src).toMatch(/parent_corporation_id:\s*val\('atsFParentCorp'\)/);
    expect(src).toMatch(/'org_type',\s*'parent_corporation_id'\]/);
    expect(src).toMatch(/parent_corporation_id:\s*p\.parent_corporation_id\s*\|\|\s*''/);
    // The org-type select hides the dropdown live (a corporation has no parent).
    expect(src).toMatch(/function onOverlayChange/);
    expect(src).toMatch(/onOverlayChange\)/);
  });

  it('member practices show "Part of <Corp>" on cards + detail header', () => {
    expect(src).toMatch(/function partOfLineHtml/);
    expect(src).toMatch(/partOfLineHtml\(p\)/);
    expect(src).toMatch(/parent_corporation_name/);
    // Detail chip opens the parent corporation via the shared delegation.
    expect(detail).toMatch(/partOfChip/);
    expect(src).toMatch(/data-ats="open-practice" data-id="' \+ ATS\.escAttr\(p\.parent_corporation_id\)/);
  });

  it('corporation detail renders the group rollup card with members + aggregates', () => {
    expect(src).toMatch(/function rollupCardHtml/);
    expect(src).toMatch(/org_type !== 'corporation'\) return ''/);
    expect(src).toMatch(/Group rollup/);
    expect(src).toMatch(/Member practices/);
    expect(src).toMatch(/Live jobs \(group\)/);
    // Wired into renderDetail and member rows open the member practice.
    expect(detail).toMatch(/rollupCardHtml\(d\)/);
    expect(src).toMatch(/data-ats="open-practice" data-id="' \+ ATS\.escAttr\(m\.id\)/);
  });
});
