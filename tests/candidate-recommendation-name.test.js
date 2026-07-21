// The practice-facing "Why we recommend Dr X" AI summary must summarise the GP
// from their CV and refer to them by their GP LINK ACCOUNT name, it must never
// balk because the name printed on the CV differs from the account name (GPs
// change names: marriage, a new professional name, etc.).
//
// Owner report 2026-07-09: submitting Helen Wazalski emailed the practice an AI
// *refusal*, "I'm sorry, but the CV provided is for Dr Sana Ahsan, not Dr
// Helen Wazalski … I cannot invent or attribute facts from one person's CV to
// another.", in place of a recommendation. Two-part fix: (1) the prompt tells
// the model the CV name may differ and must be ignored, always using the
// account name; (2) a belt-and-braces refusal detector drops any stray refusal
// so the email omits the block instead of showing one to a practice.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const serverSrc = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');

describe('candidate recommendation, ignores CV name, uses account name', () => {
  it('prompt instructs the AI that the CV name may differ and must not be flagged', () => {
    expect(serverSrc).toMatch(/name printed on the CV[\s\S]{0,80}may be different/i);
    expect(serverSrc).toMatch(/MUST NOT mention, question, compare, or flag/i);
    expect(serverSrc).toContain('Never refuse.');
    // referred to throughout by the account name (recName derives from gpName)
    expect(serverSrc).toMatch(/var recName = String\(gpName \|\| ''\)\.trim\(\);/);
    expect(serverSrc).toMatch(/referring to the doctor throughout as Dr ' \+ recName/);
  });

  it('drops any refusal so the practice email omits the block', () => {
    expect(serverSrc).toMatch(/if \(looksLikeAiRefusal\(out\)\) return '';/);
  });
});

describe('looksLikeAiRefusal, refusals dropped, real recommendations kept', () => {
  let looksLikeAiRefusal;
  beforeAll(async () => {
    const mod = await import(path.join(process.cwd(), 'server.js'));
    const tu = mod.__testUtils || (mod.default && mod.default.__testUtils);
    looksLikeAiRefusal = tu && tu.looksLikeAiRefusal;
  });

  it('is exported for testing', () => {
    expect(typeof looksLikeAiRefusal).toBe('function');
  });

  it('flags the exact refusal the practice received (name mismatch)', () => {
    const refusal =
      "I'm sorry, but the CV provided is for Dr Sana Ahsan, not Dr Helen Wazalski. " +
      "I cannot write a summary for Dr Helen Wazalski as there is no CV or information " +
      "available for that individual, and I cannot invent or attribute facts from one " +
      "person's CV to another.";
    expect(looksLikeAiRefusal(refusal)).toBe(true);
  });

  it('flags common refusal / meta shapes', () => {
    expect(looksLikeAiRefusal('As an AI language model, I do not have enough information.')).toBe(true);
    expect(looksLikeAiRefusal('I cannot provide a summary without a CV.')).toBe(true);
    expect(looksLikeAiRefusal('I apologize, but no information was provided.')).toBe(true);
    expect(looksLikeAiRefusal('Unfortunately I am unable to write a recommendation.')).toBe(true);
  });

  it('keeps genuine third-person recommendations', () => {
    const legit =
      'Dr Helen Wazalski is a UK-trained General Practitioner with over eight years of ' +
      'experience holding the MRCGP. She has shown strong clinical leadership in busy NHS ' +
      'practices with a focus on chronic disease management. GP Link is confident she would ' +
      'be an outstanding addition to your team.';
    const legit2 =
      'Dr Helen Wazalski brings more than a decade of primary-care experience across the NHS. ' +
      "Her CV shows particular strength in women's health and minor surgery. We recommend her " +
      'without reservation.';
    expect(looksLikeAiRefusal(legit)).toBe(false);
    expect(looksLikeAiRefusal(legit2)).toBe(false);
    expect(looksLikeAiRefusal('')).toBe(false);
  });
});
