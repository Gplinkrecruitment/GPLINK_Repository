// 2026-11-05 — AHPRA registration granted → the GP's app shows ONE page: the
// visa page, where the practice's migration agent requests documents and the
// GP uploads them. Static checks over the GP-facing pages:
//   - pages/visa.html: the document-request rows call the visa upload /
//     dependant endpoints with the exact body fields the server reads
//     (documentId fulfils the request row; dependant names a placeholder
//     family member), WhatsApp deep-links the support officer, and dynamic
//     values stay out of innerHTML;
//   - pages/index.html: a GP whose stage is "visa" is handed to /pages/visa
//     (pre-paint gate + navigation) unless the URL carries ?all=1, and the
//     hero "next action" now lands on Visa, not PBS, once AHPRA is done;
//   - pages/ahpra.html: the Registration Granted hero sends them to the visa page;
//   - pages/my-documents.html: the "From AHPRA" group lists ahpra_documents.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let visaHtml, indexHtml, ahpraHtml, docsHtml;

beforeAll(() => {
  visaHtml = fs.readFileSync(path.join(root, 'pages', 'visa.html'), 'utf8');
  indexHtml = fs.readFileSync(path.join(root, 'pages', 'index.html'), 'utf8');
  ahpraHtml = fs.readFileSync(path.join(root, 'pages', 'ahpra.html'), 'utf8');
  docsHtml = fs.readFileSync(path.join(root, 'pages', 'my-documents.html'), 'utf8');
});

// Everything between "function handleVisaUploadFile" and the next top-level
// section comment — the one place the upload body is built.
function uploadBlock() {
  const start = visaHtml.indexOf('function handleVisaUploadFile(');
  expect(start).toBeGreaterThan(-1);
  return visaHtml.slice(start, visaHtml.indexOf('// ── Add a family member', start));
}

describe('visa.html — document upload posts to /api/visa/documents', () => {
  it('reads the chosen file as a data URL, accepting images and PDFs only', () => {
    expect(visaHtml).toContain('input.accept = "image/*,application/pdf"');
    expect(visaHtml).toContain('reader.readAsDataURL(file)');
    // Same crop sheet as the AHPRA uploads when doc-crop.js is present, plain file otherwise.
    expect(visaHtml).toContain('/js/doc-crop.js');
    expect(visaHtml).toMatch(/if \(!window\.DocCrop\) \{ handleVisaUploadFile\(/);
    expect(visaHtml).toContain('window.DocCrop.prepare(file, { label: "document", origin: "file" })');
  });

  it('sends the exact body the server reads, including documentId to fulfil the request row', () => {
    const block = uploadBlock();
    expect(block).toContain('fetch("/api/visa/documents"');
    expect(block).toContain('method: "POST"');
    expect(block).toContain('credentials: "same-origin"');
    expect(block).toContain('visaApplicationId: app.id');
    expect(block).toContain('documentType: doc.document_type');
    expect(block).toContain('fileDataUrl: reader.result');
    expect(block).toMatch(/fileName: file\.name/);
    expect(block).toMatch(/mimeType: file\.type/);
    expect(block).toContain('documentId: doc.id');
  });

  it('names a placeholder family member ("Partner (name to be confirmed)", "Child 1") before their passport goes up', () => {
    expect(visaHtml).toContain('/name to be confirmed/i');
    expect(visaHtml).toMatch(/\/\^child\\s\*\\d\*\$\/i/);
    expect(visaHtml).toContain('function openDependantPrompt(');
    expect(uploadBlock()).toContain('payload.dependant = { fullName: dependantInfo.fullName, dateOfBirth: dependantInfo.dateOfBirth }');
    // The prompt insists on both fields.
    expect(visaHtml).toContain('"Please add their full name first."');
    expect(visaHtml).toContain('"Please add their date of birth."');
  });

  it('re-fetches /api/visa/status after a successful upload and caps files at 25 MB', () => {
    const block = uploadBlock();
    expect(block).toContain('25 * 1024 * 1024');
    expect(block).toMatch(/if \(!d \|\| !d\.ok\) \{ showToast\(\(d && d\.message\) \|\| "Upload failed\. Please try again\."\); return; \}/);
    expect(block).toMatch(/showToast\("Uploaded — we will check it and let you know\."\);\s*loadVisaStatus\(\);/);
  });
});

describe('visa.html — "Add a family member" posts to /api/visa/dependants', () => {
  it('has the inline form and sends caseId / fullName / relationship / dateOfBirth', () => {
    expect(visaHtml).toContain('id="addFamilyForm"');
    expect(visaHtml).toContain('id="famName"');
    expect(visaHtml).toContain('id="famRel"');
    expect(visaHtml).toContain('id="famDob"');
    expect(visaHtml).toContain('<option value="spouse">');
    expect(visaHtml).toContain('<option value="child">');
    expect(visaHtml).toContain('<option value="other">');
    const start = visaHtml.indexOf('addFamilyForm.addEventListener("submit"');
    expect(start).toBeGreaterThan(-1);
    const block = visaHtml.slice(start, visaHtml.indexOf('function renderVisaStatus', start));
    expect(block).toContain('fetch("/api/visa/dependants"');
    expect(block).toContain('method: "POST"');
    expect(block).toContain('caseId: currentApplication.id');
    expect(block).toContain('fullName: name');
    expect(block).toMatch(/relationship: famRel \? famRel\.value : "other"/);
    expect(block).toContain('if (dob) payload.dateOfBirth = dob;');
    expect(block).toMatch(/loadVisaStatus\(\);/);
  });

  it('is only offered once a visa case exists (card hidden with no application)', () => {
    expect(visaHtml).toMatch(/function renderDocuments\(data\)[\s\S]*?if \(!app\) \{ card\.hidden = true; return; \}/);
  });
});

describe('visa.html — status payload fields it reads', () => {
  it('reads stage_context (practice, agent, planned start, support officer) and dependants', () => {
    for (const field of ['migration_agent', 'planned_start', 'rso_first_name', 'rso_whatsapp', 'practice_name', 'who_moving', 'children_count']) {
      expect(visaHtml, field).toContain('ctx.' + field);
    }
    expect(visaHtml).toContain('data.dependants');
    expect(visaHtml).toContain('doc.dependant_id');
    expect(visaHtml).toContain('doc.requested_at');
    expect(visaHtml).toContain('doc.rejection_reason');
    expect(visaHtml).toContain('doc.request_note');
  });

  it('maps the application stage onto the 4-step track (agent → nomination → lodged → granted)', () => {
    expect(visaHtml).toMatch(/var trackIdx = stage === "nomination" \? \(agent \? 1 : 0\)\s*: stage === "lodgement" \? 2\s*: stage === "processing" \? 3\s*: stage === "granted" \? 4\s*: -1;/);
    expect(visaHtml).toContain('stage === "processing" ? "Processing" : "Granted"');
  });

  it('WhatsApp button deep-links wa.me with digits only, and is hidden without a number', () => {
    expect(visaHtml).toContain('wa.href = "https://wa.me/" + digits');
    expect(visaHtml).toMatch(/function digitsOnly\(value\) \{ return String\(value \|\| ""\)\.replace\(\/\\D\+\/g, ""\); \}/);
    expect(visaHtml).toMatch(/else \{ wa\.hidden = true; \}/);
  });

  it('keeps every server value out of innerHTML (textContent / createTextNode only)', () => {
    expect(visaHtml).not.toMatch(/innerHTML\s*=[^;]*\b(app|doc|dep|ctx|reg|data)\./);
  });
});

describe('index.html — visa stage hands Home over to /pages/visa unless ?all=1', () => {
  it('adds a pre-paint gate when the stored stage is "visa" and the URL has no all=1', () => {
    expect(indexHtml).toContain('document.documentElement.classList.add("gp-visa-gate")');
    expect(indexHtml).toContain('localStorage.getItem("gp_admin_stage_override")');
    expect(indexHtml).toMatch(/__gpStage === "visa" && !\/\[\?&\]all=1\(\?:&\|\$\)\/\.test\(window\.location\.search\)/);
    expect(indexHtml).toContain('html.gp-onboarding-gate body, html.gp-visa-gate body { visibility: hidden; }');
  });

  it('navigates inside the shell frame (no history entry) and falls back to a plain replace', () => {
    expect(indexHtml).toContain('function isVisaOnlyStage()');
    expect(indexHtml).toContain('new URLSearchParams(window.location.search).get("all") === "1") return false;');
    expect(indexHtml).toContain('return stage === "visa";');
    expect(indexHtml).toContain('function redirectToVisaIfCurrent()');
    expect(indexHtml).toContain('window.location.replace("/pages/visa?gp_shell=embedded&gp_shell_static=1")');
    expect(indexHtml).toContain('window.location.replace("/pages/visa")');
    // Deferred until the shell has activated this frame (its own route announcement).
    expect(indexHtml).toMatch(/if \(document\.readyState === "loading"\) document\.addEventListener\("DOMContentLoaded", go, \{ once: true \}\);/);
    // Never strands the doctor on the spinner.
    expect(indexHtml).toMatch(/setTimeout\(\(\) => \{ document\.documentElement\.classList\.remove\("gp-visa-gate"\); \}, 8000\);/);
  });

  it('runs the check at boot and again once state-sync hydrates the stage', () => {
    expect(indexHtml).toMatch(/redirectToVisaIfCurrent\(\);\s*\n\s*renderDashboard\(\);/);
    expect(indexHtml).toMatch(/window\.addEventListener\("gp-state-hydrated", function \(\) \{[\s\S]*?if \(redirectToVisaIfCurrent\(\)\) return;/);
  });

  it('with ?all=1 the gate is skipped and the hub renders (no gate class, no navigation)', () => {
    // Both guards read the same param: the pre-paint script and isVisaOnlyStage().
    expect(indexHtml.match(/all=1/g).length).toBeGreaterThanOrEqual(2);
    expect(indexHtml).toMatch(/if \(!isVisaOnlyStage\(\)\) \{\s*document\.documentElement\.classList\.remove\("gp-visa-gate"\);\s*return false;/);
  });

  it('next action lands on Visa (not PBS) once AHPRA is done and visa is not', () => {
    expect(indexHtml).toContain('else if (epicDone && amcDone && ahpraDone && !visaDone) { currentRoute = "visa"; currentTitle = "Visa Application";');
    expect(indexHtml).toContain('else if (epicDone && amcDone && ahpraDone && visaDone && !pbsDone) { currentRoute = "pbs";');
    expect(indexHtml).not.toContain('else if (epicDone && amcDone && ahpraDone && !pbsDone) { currentRoute = "pbs";');
    // The journey row's live subtitle agrees.
    expect(indexHtml).toContain('visa: snap.visaDone ? "Completed" : (snap.ahpraDone ? "Your employer-sponsored visa with your practice" : "Your pathway to permanent residency")');
  });
});

describe('ahpra.html — Registration Granted hero goes to the visa page', () => {
  it('labels the button "Go to your visa page" and routes via the shell to /pages/visa', () => {
    expect(ahpraHtml).toContain('cta: "Go to your visa page"');
    expect(ahpraHtml).toContain('ctaType: "visa"');
    expect(ahpraHtml).toMatch(/else if \(meta\.ctaType === "visa"\) \{\s*shellNavigate\("\/pages\/visa"\);/);
    expect(ahpraHtml).not.toContain('cta: "Go to Home Dashboard"');
  });
});

describe('my-documents.html — "From AHPRA" group', () => {
  it('stores ahpra_documents from /api/gplink-docs-status and re-renders when present', () => {
    expect(docsHtml).toContain('window._ahpraDocuments = Array.isArray(data.ahpra_documents) ? data.ahpra_documents : []');
    expect(docsHtml).toContain('|| window._ahpraDocuments.length > 0) {');
  });

  it('renders a download card per document inside the We Prepare panel, hidden when empty', () => {
    const start = docsHtml.indexOf('var _ahpraDocs = Array.isArray(window._ahpraDocuments)');
    expect(start).toBeGreaterThan(-1);
    const block = docsHtml.slice(start, start + 2200);
    expect(block).toContain('if (_ahpraDocs.length > 0) {');
    expect(block).toContain('<p>From AHPRA</p>');
    expect(block).toContain('data-ahpra-documents');
    expect(block).toContain('panel3.appendChild(ahpraSection)');
    expect(block).toContain('escapeHtml(doc.label || doc.document_key || "AHPRA document")');
    expect(block).toContain('href="\' + escapeHtml(doc.url) + \'" target="_blank" rel="noopener" download>Download</a>');
  });
});

describe('no invented endpoints — the GP-facing routes exist in server.js', () => {
  it('POST /api/visa/documents and POST /api/visa/dependants are routed', () => {
    const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    expect(serverJs).toContain("pathname === '/api/visa/documents' && req.method === 'POST'");
    expect(serverJs).toContain("pathname === '/api/visa/dependants' && req.method === 'POST'");
    expect(serverJs).toContain("pathname === '/api/visa/status' && req.method === 'GET'");
  });
});
