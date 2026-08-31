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
    expect(onbHtml).toContain('onboarding.js?v=20260831a');
    const miHtml = fs.readFileSync(path.join(__dirnameTest, '..', 'pages', 'myinthealth.html'), 'utf8');
    expect(miHtml).toContain('id="qualDocsGate"');
    expect(miHtml).toContain('/api/registration/qual-docs-status');
    expect(miHtml).toContain('/pages/onboarding?docs=1');
  });

  it('CEO drawer register row + verify endpoint wiring', () => {
    const ceoJs = fs.readFileSync(path.join(__dirnameTest, '..', 'js', 'ceo-ats-candidates.js'), 'utf8');
    expect(ceoJs).toContain('registerRowInner');
    expect(ceoJs).toContain('/api/ats/candidate/register-verification');
    const ceoHtml = fs.readFileSync(path.join(__dirnameTest, '..', 'pages', 'ceo-dashboard.html'), 'utf8');
    expect(ceoHtml).toContain('ceo-ats-candidates.js?v=20260831a');
  });
});
