// The onboarding wizard's client-side register rules and deferred-document
// keys MUST stay in lockstep with lib/register-verification.js — the wizard
// validates what the server later persists, and the MyIntealth gateway asks
// for exactly the documents the wizard's docs-only mode uploads. These are
// static source pins (the page JS cannot be imported), same style as the
// other onboarding UI pins.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const requireCjs = createRequire(import.meta.url);
const reg = requireCjs('../lib/register-verification.js');
const __dirnameTest = path.dirname(fileURLToPath(import.meta.url));
const onboardingSrc = fs.readFileSync(path.join(__dirnameTest, '..', 'js', 'onboarding.js'), 'utf8');

describe('wizard ↔ lib register rules stay in sync', () => {
  it('the wizard validates the same number formats the server accepts', () => {
    // Client patterns as written in js/onboarding.js REGISTER_BODIES_CLIENT.
    expect(onboardingSrc).toContain('GB: { label: "GMC", pattern: /^\\d{7}$/');
    expect(onboardingSrc).toContain('IE: { label: "IMC", pattern: /^\\d{4,6}$/');
    expect(onboardingSrc).toContain('NZ: { label: "MCNZ", pattern: /^\\d{4,6}$/');
    // Server patterns.
    expect(String(reg.REGISTER_BODIES.gmc.numberPattern)).toBe('/^\\d{7}$/');
    expect(String(reg.REGISTER_BODIES.imc.numberPattern)).toBe('/^\\d{4,6}$/');
    expect(String(reg.REGISTER_BODIES.mcnz.numberPattern)).toBe('/^\\d{4,6}$/');
  });

  // Australian GP build, WP-05 (finding APP-02). Added deliberately: the wizard
  // now has a fourth register, Ahpra, on the Australian branch. It is NOT added
  // to REGISTER_BODIES_CLIENT (that map, its digits-only clean-up and its numeric
  // keyboard stay exactly as they are for GMC / IMC / MCNZ, asserted above): the
  // Ahpra number keeps its letters, so it has its own rule in
  // js/onboarding-au.js, and that rule must match the server's too.
  it('the Ahpra rule on the Australian branch matches the server, and the three existing rules are untouched', () => {
    const auClient = requireCjs('../js/onboarding-au.js');
    expect(String(auClient.AHPRA_NUMBER_PATTERN)).toBe('/^MED\\d{10}$/');
    expect(String(reg.REGISTER_BODIES.ahpra.numberPattern)).toBe('/^MED\\d{10}$/i');
    ['MED0001234567', 'med0001234567', 'MED 0001 234567', 'MED-0001234567'].forEach((n) => {
      const c = auClient.validateAhpraNumber(n);
      const srv = reg.validateRegisterDetails('ahpra', n);
      expect(c.ok, n).toBe(true);
      expect(srv.ok, n).toBe(true);
      expect(c.number).toBe(srv.number);
    });
    ['0001234567', 'MED000123456', 'MED00012345678', 'GMC0001234567', '7654321', ''].forEach((n) => {
      expect(auClient.validateAhpraNumber(n).ok, n).toBe(false);
      expect(reg.validateRegisterDetails('ahpra', n).ok, n).toBe(false);
    });
    // The existing client map still has exactly the three registers.
    const map = onboardingSrc.slice(onboardingSrc.indexOf('var REGISTER_BODIES_CLIENT = {'), onboardingSrc.indexOf('function validateRegisterNumberClient'));
    expect((map.match(/label: "/g) || []).length).toBe(3);
    expect(map).not.toMatch(/ahpra/i);
    expect(onboardingSrc).toContain('var n = String(value == null ? "" : value).replace(/[\\s-]+/g, "").replace(/[^0-9]/g, "");');
  });

  it('the deferred-document keys are the CANONICAL storage keys the wizard uploads write', () => {
    const serverSrc = fs.readFileSync(path.join(__dirnameTest, '..', 'server.js'), 'utf8');
    // Every deferred key must be in server.js's ONBOARDING_DOCUMENT_KEYS set —
    // otherwise the gateway would wait forever for a document the wizard's
    // upload endpoint refuses to store under that key.
    const allKeys = new Set();
    for (const docs of Object.values(reg.DEFERRED_QUAL_DOCS)) {
      for (const doc of docs) allKeys.add(doc.key);
    }
    for (const key of allKeys) {
      expect(serverSrc, key).toContain("'" + key + "'");
      expect(key.startsWith('onboarding_')).toBe(true);
    }
    // …and each country's DEFERRED list must be the same LENGTH as the
    // wizard's COUNTRY_DOCS list for that country (GB uploads 3, IE/NZ 2).
    expect(reg.DEFERRED_QUAL_DOCS.GB.length).toBe(3);
    expect(reg.DEFERRED_QUAL_DOCS.IE.length).toBe(2);
    expect(reg.DEFERRED_QUAL_DOCS.NZ.length).toBe(2);
    expect(Object.keys(reg.DEFERRED_QUAL_DOCS).sort()).toEqual(['GB', 'IE', 'NZ']);
  });

  it('normal onboarding no longer demands documents, docs-only mode still does', () => {
    // The register branch replaces the doc gate in validateStep case 2…
    expect(onboardingSrc).toContain('if (!DOCS_ONLY_MODE) {');
    expect(onboardingSrc).toContain('validateRegisterNumberClient(state.country, state.registerNumber)');
    // …and the docs machinery + allow-list survive for the gateway's docs mode.
    expect(onboardingSrc).toContain('function allDocsComplete()');
    expect(onboardingSrc).toContain('renderRegisterField');
    expect(onboardingSrc).toContain('window.location.href = "/pages/myinthealth"');
  });

  it('the wizard state carries registerNumber and the submit posts the whole state', () => {
    expect(onboardingSrc).toContain('registerNumber: ""');
    expect(onboardingSrc).toContain('body: JSON.stringify(state)');
  });
});

describe('page pins', () => {
  it('onboarding.html buster + myinthealth gateway wiring', () => {
    const onbHtml = fs.readFileSync(path.join(__dirnameTest, '..', 'pages', 'onboarding.html'), 'utf8');
    expect(onbHtml).toContain('onboarding.js?v=20261121d');
    const miHtml = fs.readFileSync(path.join(__dirnameTest, '..', 'pages', 'myinthealth.html'), 'utf8');
    expect(miHtml).toContain('id="qualDocsGate"');
    expect(miHtml).toContain('/api/registration/qual-docs-status');
    expect(miHtml).toContain('/pages/onboarding?docs=1');
  });

  it('job page certificate modal wiring (owner 2026-09-01: cert asked at apply time)', () => {
    const jobHtml = fs.readFileSync(path.join(__dirnameTest, '..', 'pages', 'job.html'), 'utf8');
    expect(jobHtml).toContain('id="certModal"');
    expect(jobHtml).toContain('requiresSpecialistCert');
    expect(jobHtml).toContain('"onboarding_specialist_qualification"');
    // The upload goes through the SAME endpoint the onboarding wizard uses.
    expect(jobHtml).toContain('"/api/onboarding-documents"');
    // …and the careers page has the inline modal for match-accepts.
    const careerHtml = fs.readFileSync(path.join(__dirnameTest, '..', 'pages', 'career.html'), 'utf8');
    expect(careerHtml).toContain('openCareerCertModal');
    expect(careerHtml).toContain('requiresSpecialistCert');
    expect(careerHtml).toContain('"onboarding_specialist_qualification"');
  });

  it('CEO drawer register row + verify endpoint wiring', () => {
    const ceoJs = fs.readFileSync(path.join(__dirnameTest, '..', 'js', 'ceo-ats-candidates.js'), 'utf8');
    expect(ceoJs).toContain('registerRowInner');
    expect(ceoJs).toContain('/api/ats/candidate/register-verification');
    const ceoHtml = fs.readFileSync(path.join(__dirnameTest, '..', 'pages', 'ceo-dashboard.html'), 'utf8');
    expect(ceoHtml).toContain('ceo-ats-candidates.js?v=20261123a');
  });
});
