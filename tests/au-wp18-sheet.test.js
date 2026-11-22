// WP-18: the owner's submission sheet (docs/au-gp/whatsapp-templates.md) is
// the code, word for word, and it is complete: every row of
// lib/au-whatsapp-templates.js is in exactly one section, every section entry
// is a row, and nothing in it would be rejected for a reason we already know.
//
//   WP18_WRITE_SHEET=1 npx vitest run tests/au-wp18-sheet.test.js   rewrites the sheet
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const wa = require('../lib/au-whatsapp-templates.js');
const sheet = require('../lib/au-whatsapp-submission.js');
const auLeadCopy = require('../lib/au-lead-copy.js');
const auMessages = require('../lib/au-messages.js');
const consultWhatsapp = require('../lib/consult-whatsapp.js');
const { bannedIn } = require('./helpers/au-banned-words.js');

const DOC = path.join(__dirname, '..', 'docs', 'au-gp', 'whatsapp-templates.md');
const ROWS = wa.AU_WHATSAPP_TEMPLATES;
const KEYS = Object.keys(ROWS);

if (process.env.WP18_WRITE_SHEET === '1') fs.writeFileSync(DOC, sheet.renderSheet() + '\n');

function sections(doc) {
  const out = {};
  let cur = 'top';
  doc.split('\n').forEach((line) => {
    const m = /^## (\d)\. /.exec(line);
    if (m) cur = 's' + m[1];
    (out[cur] = out[cur] || []).push(line);
  });
  return out;
}

describe('WP-18: the submission sheet', () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  const sec = sections(doc);

  it('is exactly what the code generates', () => {
    expect(doc).toBe(sheet.renderSheet() + '\n');
  });

  it('every row is in exactly one section, and every section entry is a row', () => {
    const firstCell = (lines) => lines.map((l) => /^\| `([a-z0-9_]+)` \|/.exec(l)).filter(Boolean).map((m) => m[1]);
    const s1 = firstCell(sec.s1);
    const s2 = sec.s2.map((l) => /add this key:\*\* `([a-z0-9_]+)`/.exec(l)).filter(Boolean).map((m) => m[1]);
    const s4 = sec.s4.map((l) => /\| `([a-z0-9_]+_existing)` \|/.exec(l)).filter(Boolean).map((m) => m[1]);
    const all = s1.concat(s2, s4);
    expect(all.slice().sort()).toEqual(KEYS.slice().sort());           // each row once, and nothing that is not a row
    expect(new Set(all).size).toBe(all.length);
    // Each section holds the rows of its own kind.
    s1.forEach((k) => expect(ROWS[k].source, k).toBe(wa.SOURCE.NEUTRAL));
    s2.forEach((k) => expect(ROWS[k].source, k).toBe(wa.SOURCE.NEW));
    s4.forEach((k) => expect(ROWS[k].source, k).toBe(wa.SOURCE.RSO_WORDING));
    // Section 2 names the template each key points at; sections 1 and 4 too.
    s2.forEach((k) => expect(sec.s2.join('\n'), k).toContain('#### `' + ROWS[k].templateName + '`'));
    s1.concat(s4).forEach((k) => expect(doc, k).toContain('`' + ROWS[k].templateName + '`'));
    // Section 3: the drafts that are not needed are not rows, and are not in section 2.
    const s3 = firstCell(sec.s3);
    expect(s3).toEqual(sheet.SUPERSEDED.map((x) => x.draft));
    const liveNames = KEYS.map((k) => ROWS[k].templateName);
    s3.forEach((n) => { expect(liveNames, n).not.toContain(n); expect(sec.s2.join('\n'), n).not.toContain('`' + n + '`'); });
    sheet.SUPERSEDED.forEach((x) => expect(wa.templateClass(x.by), x.by).toBe('neutral'));
  });

  it('the row model: reused rows point at a template confirmed neutral, with where and when it was read; new rows are gp_link_au_*; the owner\'s-choice rows are the five with the job title', () => {
    const m = sheet.sheetModel();
    expect(m.reused.sort()).toEqual(['account_released', 'lead_call_hour_before', 'lead_call_missed', 'lead_call_starting', 'lead_onboarding_incomplete', 'lead_post_call_onboard', 'match_invitation', 'practice_intro', 'practice_intro_cv']);
    m.reused.forEach((k) => {
      expect(ROWS[k], k).toMatchObject({ approved: true, source: 'existing-template-confirmed-neutral', confirmed: '2026-11-22', ref: 'docs/au-gp/whatsapp-live-templates.md section 3' });
      expect(wa.templateClass(ROWS[k].templateName), k).toBe('neutral');
    });
    m.submit.forEach((k) => { expect(ROWS[k].approved, k).toBe(false); expect(ROWS[k].templateName, k).toMatch(/^gp_link_au_/); });
    expect(m.ownerChoice.sort()).toEqual(['contract_ready_existing', 'interview_confirmed_existing', 'interview_confirmed_practice_existing', 'interview_times_ready_existing', 'match_accepted_existing']);
    m.ownerChoice.forEach((k) => {
      expect(ROWS[k].approved, k).toBe(false);
      expect(wa.templateClass(ROWS[k].templateName), k).toBe('rso_wording');
      expect(ROWS[k.replace(/_existing$/, '')], k).toBeTruthy();       // each has a neutral twin to submit
    });
    // The seven the review named (T4) are exactly these names.
    expect(['practice_intro', 'practice_intro_cv', 'lead_call_hour_before', 'lead_call_starting', 'lead_call_missed', 'lead_post_call_onboard', 'lead_onboarding_incomplete'].map((k) => ROWS[k].templateName)).toEqual([
      'gp_link_practice_candidate_intro', 'gp_link_practice_candidate_intro_cv', 'gp_link_consult_call_1h', 'gp_link_consult_call_starting_5m',
      'gp_link_consult_missed_call', 'gp_link_consult_post_call_onboard_v3', 'gp_link_consult_onboarding_nudge'
    ]);
    // A lead row that reuses a template reuses the one for the SAME touch (same variables, same order).
    Object.keys(ROWS).filter((k) => /^lead_/.test(k) && ROWS[k].source === wa.SOURCE.NEUTRAL).forEach((k) => {
      expect(ROWS[k].templateName, k).toBe(consultWhatsapp.CONSULT_WA_TEMPLATES[k.replace(/^lead_/, '')].templateName);
    });
  });

  it('nothing to be submitted would be rejected for a reason we know: no body starts or ends with a variable, variables run 1..n with a sample each, at most one button variable and it is last in a fixed address', () => {
    expect(sheet.SUBMIT.map((t) => t.key).sort()).toEqual(sheet.sheetModel().submit.sort());
    for (const t of sheet.SUBMIT) {
      expect(/^\s*\{\{\d+\}\}/.test(t.body), t.key + ' starts with a variable').toBe(false);
      expect(/\{\{\d+\}\}\s*$/.test(t.body), t.key + ' ends with a variable').toBe(false);
      const used = (t.body.match(/\{\{(\d+)\}\}/g) || []).filter((v, i, a) => a.indexOf(v) === i).map((v) => Number(v.replace(/\D/g, ''))).sort((a, b) => a - b);
      expect(used, t.key).toEqual(t.variables.map((_v, i) => i + 1));
      t.variables.forEach((v) => { expect(String(v[1]).trim().length, t.key + ' sample').toBeGreaterThan(0); });
      expect(['UTILITY', 'MARKETING']).toContain(t.category);
      const dynamic = t.buttons.filter((b) => /\{\{/.test(b.url));
      expect(dynamic.length, t.key).toBeLessThanOrEqual(1);
      t.buttons.forEach((b) => {
        expect(b.url, t.key).toMatch(/^https:\/\/app\.mygplink\.com\.au\/pages\/[a-z-]+(\?[a-zA-Z]+=\{\{1\}\})?$/);
        if (/\{\{/.test(b.url)) expect(b.sample, t.key).toBeTruthy(); else expect(b.sample, t.key).toBe('');
      });
      // The wording rules: no section 4 word, no job title, no money.
      expect(bannedIn(t.body), t.key).toEqual([]);
      expect(t.body, t.key).not.toMatch(/registration support officer|\$\d|\d\s?%|relocat|your move/i);
      // Samples are obviously fake.
      expect(JSON.stringify(t.variables), t.key).not.toMatch(/@(?!gplink-test)/);
    }
  });

  it('the bodies are the ones the code holds (the lead drafts and the lifecycle drafts), with the three known corrections applied', () => {
    const byKey = Object.fromEntries(sheet.SUBMIT.map((t) => [t.key, t]));
    Object.keys(auLeadCopy.PROPOSED_WHATSAPP_TEMPLATES).forEach((k) => {
      const p = auLeadCopy.PROPOSED_WHATSAPP_TEMPLATES[k];
      if (p.supersededBy) { expect(ROWS[k].templateName, k).toBe(p.supersededBy); expect(byKey[k], k).toBeUndefined(); }
      else expect(byKey[k].body, k).toBe(p.body);
      expect(/\{\{\d+\}\}\s*$/.test(p.body), k).toBe(false);
    });
    auMessages.LIFECYCLE_WHATSAPP_TEMPLATES.forEach((t) => { expect(byKey[t.key].body, t.key).toBe(t.body); expect(ROWS[t.key].templateName).toBe(t.templateName); });
    expect(auLeadCopy.PROPOSED_WHATSAPP_TEMPLATES.lead_hello_5m.body).toMatch(/\{\{2\}\}\n\nKhaleed, GP Link$/);
    expect(auLeadCopy.PROPOSED_WHATSAPP_TEMPLATES.lead_check_in_1h.body).toMatch(/\{\{2\}\}\n\nKhaleed, GP Link$/);
    expect(auLeadCopy.PROPOSED_WHATSAPP_TEMPLATES.lead_call_missed.body).toMatch(/\{\{2\}\}\n\nOr reply with a time that suits you and I will make it work\.$/);
    // The placement-secured button is a fixed page.
    expect(byKey.placement_secured.buttons).toEqual([{ type: 'URL', text: 'Open my checklist', url: 'https://app.mygplink.com.au/pages/prestart', sample: '' }]);
  });

  it('one table lists every Australian message with a WhatsApp leg: an approved template, or a named email that a test shows being sent', () => {
    const keysInTable = sheet.MESSAGE_TABLE.map((m) => m.key).filter(Boolean);
    // Every row that is a message (not an owner's-choice twin) is in the table.
    expect(keysInTable.slice().sort()).toEqual(KEYS.filter((k) => !/_existing$/.test(k)).sort());
    for (const m of sheet.MESSAGE_TABLE) {
      const status = sheet.statusOf(m.key, {});
      expect(doc, m.message).toContain('| ' + m.message + ' | ' + m.to + ' | ' + status + ' |');
      if (m.key && wa.auWhatsAppTemplate(m.key, {}).approved) { expect(status).toBe('reused'); continue; }
      // Not on: the email that carries it is named, and the proof is a real test.
      expect(String(m.email).length, m.message).toBeGreaterThan(10);
      const file = path.join(__dirname, '..', m.proof[0]);
      expect(fs.existsSync(file), m.proof[0]).toBe(true);
      if (m.proof[1]) expect(fs.readFileSync(file, 'utf8'), m.message + ': ' + m.proof[1]).toContain(m.proof[1].replace(/'/g, '\\\''));
    }
  });

  it('listing a key in AU_WHATSAPP_APPROVED_TEMPLATES turns that row on and nothing else; AU_WHATSAPP_DISABLED_TEMPLATES turns one off; an overseas-only template can never be reached', () => {
    const base = KEYS.filter((k) => wa.auWhatsAppTemplate(k, {}).approved).sort();
    for (const key of KEYS) {
      const on = KEYS.filter((k) => wa.auWhatsAppTemplate(k, { AU_WHATSAPP_APPROVED_TEMPLATES: key }).approved).sort();
      expect(on, key).toEqual(Array.from(new Set(base.concat([key]))).sort());
      const off = KEYS.filter((k) => wa.auWhatsAppTemplate(k, { AU_WHATSAPP_DISABLED_TEMPLATES: key }).approved).sort();
      expect(off, key).toEqual(base.filter((k) => k !== key));
      // Off wins over on.
      expect(wa.auWhatsAppTemplate(key, { AU_WHATSAPP_APPROVED_TEMPLATES: key, AU_WHATSAPP_DISABLED_TEMPLATES: key }).approved, key).toBe(false);
    }
    // The owner's choice: the existing template carries the message when its
    // key is listed; the neutral version wins once it is on.
    expect(wa.auDoctorWhatsAppPlan('interview_times_ready', {})).toEqual({ send: false, reason: 'au_template_not_approved', templateName: 'gp_link_au_interview_times_ready' });
    expect(wa.auDoctorWhatsAppPlan('interview_times_ready', { AU_WHATSAPP_APPROVED_TEMPLATES: 'interview_times_ready_existing' })).toMatchObject({ send: true, templateName: 'gp_link_interview_times_ready', key: 'interview_times_ready_existing' });
    expect(wa.auDoctorWhatsAppPlan('interview_times_ready', { AU_WHATSAPP_APPROVED_TEMPLATES: 'interview_times_ready_existing,interview_times_ready' })).toMatchObject({ send: true, templateName: 'gp_link_au_interview_times_ready' });
    // By template name works too, for either kind.
    expect(wa.auDoctorWhatsAppPlan('contract_ready', { AU_WHATSAPP_APPROVED_TEMPLATES: 'gp_link_contract_ready' })).toMatchObject({ send: true, templateName: 'gp_link_contract_ready' });
    // No row points at an overseas-only template, the staff welcome has no
    // "existing" twin, and naming one in the setting does nothing.
    KEYS.forEach((k) => expect(['neutral', 'rso_wording', 'au'], k).toContain(wa.templateClass(ROWS[k].templateName)));
    expect(ROWS.rso_welcome_existing).toBeUndefined();
    const overseas = Object.keys(wa.EXISTING_TEMPLATE_CLASS).filter((n) => wa.EXISTING_TEMPLATE_CLASS[n] === 'overseas_only');
    const env = { AU_WHATSAPP_APPROVED_TEMPLATES: overseas.join(',') + ',rso_welcome_existing,lead_call_booked_existing' };
    expect(KEYS.filter((k) => wa.auWhatsAppTemplate(k, env).approved).sort()).toEqual(base);
    expect(wa.auDoctorWhatsAppPlan('rso_welcome', env).send).toBe(false);
    expect(wa.auLeadWhatsAppPlan('call_booked', env).send).toBe(false);
  });

  it('reads as plain words: no dash used as punctuation, no leftover jargon the owner would trip on', () => {
    expect(doc).not.toMatch(/—|–/);
    expect(doc).not.toMatch(/\bTODO\b|WP-\d|PostgREST|payload/);
  });
});
