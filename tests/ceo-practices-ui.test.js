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
    expect(ceo).toMatch(/\/js\/ceo-ats-practices\.js\?v=20260809a/);
  });
});

// Secondary practice contacts (owner spec 2026-08-05) — multiple extra people
// per practice, CC'd on the candidate introduction only.
describe('CEO Practices tab — secondary contacts', () => {
  it('detail view lists secondary contacts with the CC-scope explainer', () => {
    expect(detail).toMatch(/secondaryContactsFieldHtml\(p\)/);
    expect(src).toMatch(/function secondaryContactsFieldHtml/);
    expect(src).toMatch(/Secondary contacts/);
    // The rule is stated in the UI, not just in code comments.
    expect(src).toMatch(/presented or matched/);
    expect(src).toMatch(/not on later emails/);
  });

  it('modal renders repeatable rows with add + remove wired through delegation', () => {
    expect(src).toMatch(/function secondaryRowHtml/);
    expect(src).toMatch(/id="atsFSecondaryList"/);
    expect(src).toMatch(/data-sec-email/);
    expect(src).toMatch(/data-sec-name/);
    expect(src).toMatch(/data-ats="add-secondary"/);
    expect(src).toMatch(/data-ats="remove-secondary"/);
    expect(src).toMatch(/action === 'add-secondary'\) addSecondaryRowTo\('atsFSecondaryList'\)/);
    expect(src).toMatch(/action === 'remove-secondary'\) removeSecondaryRow\(btn\)/);
    // Rows are appended, never re-rendered — a rebuild would wipe typed values.
    expect(src).toMatch(/insertAdjacentHTML\('beforeend', secondaryRowHtml/);
    // ONE row builder feeds both the modal and the detail panel, so the two
    // editors cannot drift apart.
    expect((src.match(/secondaryRowHtml/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  it('readForm collects the rows and savePractice diffs them (including a clear)', () => {
    expect(src).toMatch(/secondary_contacts:\s*readSecondaryContacts\(\)/);
    expect(src).toMatch(/function readSecondaryContacts/);
    expect(src).toMatch(/function secondaryKey/);
    expect(src).toMatch(/secondaryKey\(cur\.secondary_contacts\) !== secondaryKey\(p\.secondary_contacts\)/);
    // Edit modal seeds from the loaded practice.
    expect(src).toMatch(/secondary_contacts:\s*p\.secondary_contacts\s*\|\|\s*\[\]/);
    // Create omits the key entirely when empty (pre-migration safety).
    expect(src).toMatch(/if \(!body\.secondary_contacts\.length\) delete body\.secondary_contacts/);
  });

  it('primary contact labels say "primary" so the two fields cannot be confused', () => {
    expect(src).toMatch(/Primary contact name/);
    expect(src).toMatch(/Primary contact email/);
  });

  it('the detail list is editable in place, with its own add + save', () => {
    expect(src).toMatch(/id="atsDetailSecondaryList"/);
    expect(src).toMatch(/data-ats="add-secondary-detail"/);
    expect(src).toMatch(/function saveSecondaryFromDetail/);
    expect(src).toMatch(/action === 'add-secondary-detail'\) addSecondaryRowTo\('atsDetailSecondaryList'\)/);
    // Removing a row on the panel saves immediately (the modal waits for Save).
    expect(src).toMatch(/removeSecondaryRow\(t\);\s*\n\s*saveSecondaryFromDetail\(\)/);
    // A change inside the detail list triggers the save.
    expect(src).toMatch(/closest\('#atsDetailSecondaryList'\)\) saveSecondaryFromDetail\(\)/);
  });

  it('mirrors the server validation so a dropped row can never look saved', () => {
    expect(src).toMatch(/function collectSecondaryRows/);
    expect(src).toMatch(/function looksLikeEmail/);
    expect(src).toMatch(/already the primary contact/);
    expect(src).toMatch(/already in the list/);
    // A bad row aborts the whole save rather than being silently skipped.
    expect(src).toMatch(/if \(problem\) \{ showSecondaryError\(problem\); return null; \}/);
    expect(src).toMatch(/if \(next === null\) return/);
  });
});

// Owner request 2026-08-05: edit the contact details straight from the detail
// panel instead of going through the Edit modal for every small correction.
describe('CEO Practices tab — inline field editing', () => {
  it('renders contact/email/phone as inline inputs bound to PATCH body keys', () => {
    expect(src).toMatch(/function inlineFieldHtml/);
    expect(detail).toMatch(/inlineFieldHtml\('Primary contact', 'contact'/);
    expect(detail).toMatch(/inlineFieldHtml\('Email', 'email'/);
    expect(detail).toMatch(/inlineFieldHtml\('Phone', 'phone'/);
    expect(src).toMatch(/data-inline-field=/);
    expect(src).toMatch(/class="ats-inline-input"/);
  });

  it('saves on change, skips no-op blurs, and restores the old value on failure', () => {
    expect(src).toMatch(/function saveInlineField/);
    expect(src).toMatch(/data-inline-field'\)\) \{ saveInlineField\(t\); return; \}/);
    // A blur with no edit must not PATCH.
    expect(src).toMatch(/if \(next === prev\) return/);
    // A failed save puts the stored value back rather than leaving a lie on screen.
    expect(src).toMatch(/if \(!ok\) \{ input\.value = prev; return; \}/);
    expect(src).toMatch(/function patchPractice/);
    expect(src).toMatch(/function mergeSavedPractice/);
  });

  it('Enter commits and Escape abandons the edit', () => {
    expect(src).toMatch(/function onPanelKeydown/);
    expect(src).toMatch(/panel\.addEventListener\('keydown', onPanelKeydown\)/);
    expect(src).toMatch(/e\.key === 'Enter'\) \{ e\.preventDefault\(\); t\.blur\(\)/);
    expect(src).toMatch(/e\.key !== 'Escape'\) return/);
  });

  it('changing the primary email re-renders the CC list it filters', () => {
    expect(src).toMatch(/if \(key === 'email'\) renderSecondaryRows\(\)/);
    expect(src).toMatch(/function renderSecondaryRows/);
  });

  it('ships the inline styles behind a bumped stylesheet key', () => {
    const css = fs.readFileSync(path.join(root, 'css/ceo-ats.css'), 'utf8');
    expect(css).toMatch(/\.ats-inline-input/);
    expect(css).toMatch(/\.ats-sec-row/);
    expect(css).toMatch(/\.ats-sec-remove/);
    expect(ceo).toContain('/css/ceo-ats.css?v=20260805h');
    expect(ceo).not.toContain('/css/ceo-ats.css?v=20260805d');
    expect(ceo).not.toContain('/css/ceo-ats.css?v=20260805c');
    expect(ceo).not.toContain('/css/ceo-ats.css?v=20260805b');
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
