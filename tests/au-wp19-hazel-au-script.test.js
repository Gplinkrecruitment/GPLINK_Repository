// WP-19 (Australian GP build): Hazel's Australian script is a DRAFT FILE ONLY.
// Owner decision 7: Hazel must not ring Australian-segment leads, so the file
// must exist, say it is a draft, contain none of the words an Australian doctor
// must never hear, quote no pay figures, and be read by nothing.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const AU_PROMPT = path.join(ROOT, 'config', 'retell', 'hazel-prompt-au.md');
const UK_PROMPT = path.join(ROOT, 'config', 'retell', 'hazel-prompt.md');
const NOTES = path.join(ROOT, 'docs', 'au-gp', 'hazel-au-script-notes.md');

const BANNER = 'DRAFT — NOT PUBLISHED. Do not load into Retell. Australian calls are disabled in code '
  + '(lib/au-lead.js `auHazelBlocked`) by owner decision 7 and stay disabled until the owner has legal '
  + 'advice on AI calls to +61 numbers (COM-34).';

// Whole words / phrases, case-insensitive. Each pattern is deliberately narrow:
// "your move" is banned but "move on" is not; "relocat" covers relocate,
// relocating and relocation; "epic" and "amc" only match as whole words.
const BANNED = [
  ['visa', /\bvisas?\b/i],
  ['482', /\b482\b/],
  ['four eight two', /\bfour[\s-]+eight[\s-]+two\b/i],
  ['relocate / relocation', /\brelocat\w*/i],
  ['your move', /\byour\s+move\b/i],
  ['the move', /\bthe\s+move\b/i],
  ['MyIntealth', /\bmy\s?intealth\b/i],
  ['AMC', /\bamc\b/i],
  ['EPIC', /\bepic\b/i],
  ['GMC', /\bgmc\b/i],
  ['MRCGP', /\bmrcgp\b/i],
  ['supervised six months', /\bsupervised\b[^.\n]{0,40}\bsix\s+months\b|\bsix\s+months\b[^.\n]{0,40}\bsupervis\w*/i],
  ['DPA', /\bdpa\b/i],
  ['Distribution Priority Area', /\bdistribution\s+priority\b/i],
  ['internationally trained', /\binternational(ly)?[\s-]+(trained|medical|gp|doctor)/i],
  ['overseas', /\boverseas\b/i],
  ['expedited specialist pathway', /\bexpedited\s+specialist\b/i],
  ['SPPA', /\bsppa\b/i],
  ['Section G', /\bsection\s+g\b/i],
  ['supervisor CV', /\bsupervisor\s+cv\b/i],
  ['Not yet eligible', /\bnot\s+yet\s+eligible\b/i],
  ['UK', /\bUK\b|\bunited\s+kingdom\b|\bbritish\b/i],
  ['migration agent', /\bmigration\s+agent\b/i],
  ['sponsorship', /\bsponsorship\b/i]
];

const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred';
const MONEY = [
  ['a dollar sign', /\$/],
  ['a percent sign', /%/],
  ['a figure followed by percent', new RegExp('(\\d|\\b(' + NUMBER_WORDS + ')\\b)[\\s-]*(per\\s?cent)\\b', 'i')],
  ['a figure followed by dollars', new RegExp('(\\d|\\b(' + NUMBER_WORDS + '|thousand|million)\\b)[\\s-]*(dollars?|k\\b|grand\\b)', 'i')],
  ['AUD amount', /\bAUD\s*\d/i]
];

function listFiles(dir, out) {
  const acc = out || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, acc);
    else if (entry.isFile()) acc.push(full);
  }
  return acc;
}

describe('WP-19: Hazel Australian script is a draft file only', () => {
  const text = fs.existsSync(AU_PROMPT) ? fs.readFileSync(AU_PROMPT, 'utf8') : '';

  it('exists and is a real script, not a stub', () => {
    expect(fs.existsSync(AU_PROMPT)).toBe(true);
    expect(text.length).toBeGreaterThan(4000);
    for (const heading of ['## Rules, in priority order', '## How you sound', '## Flow', '## Concerns', '## What you can say', '## Edge cases', '## Closing']) {
      expect(text).toContain(heading);
    }
  });

  it('carries the DRAFT banner at the very top', () => {
    expect(text).toContain(BANNER);
    expect(text.indexOf(BANNER)).toBeLessThan(20);
    expect(text.trimStart().startsWith('<!--')).toBe(true);
  });

  it.each(BANNED)('never says "%s"', (_label, pattern) => {
    const m = pattern.exec(text);
    expect(m ? m[0] + ' @' + m.index : null).toBeNull();
  });

  it.each(MONEY)('quotes no pay figure: %s', (_label, pattern) => {
    const m = pattern.exec(text);
    expect(m ? m[0] + ' @' + m.index : null).toBeNull();
  });

  it('the word lists do catch what they are meant to (and not ordinary words)', () => {
    const hit = (s) => BANNED.some(([, p]) => p.test(s)) || MONEY.some(([, p]) => p.test(s));
    for (const bad of ['the practice sponsors your visa', 'subclass 482', 'a relocation package', 'planning your move',
      'MyIntealth account', 'AMC portfolio', 'EPIC check', 'your GMC number', 'first role is in a DPA',
      'the first six months are supervised', 'internationally trained doctors', 'overseas GPs', 'UK GPs',
      'most keep seventy percent', 'around 70 per cent', '$300,000', 'two hundred thousand dollars', '65%']) {
      expect([bad, hit(bad)]).toEqual([bad, true]);
    }
    for (const fine of ['then move on', 'they moved the booking', 'it is moveable', 'an epicentre', 'bulk billing, mixed billing, private billing',
      'never say a dollar figure', 'a free half-hour', 'the 19AB moratorium', 'hard cap twenty-five words', 'advice on work rights']) {
      expect([fine, hit(fine)]).toEqual([fine, false]);
    }
  });

  it('covers the things the owner asked for', () => {
    const must = [
      /AI assistant/i, /recorded/i, /private moment/i, /voicemail/i, /don't call again|do not call again/i,
      /registered with Ahpra/, /FRACGP/, /FACRRM/, /conditions, undertakings or notations/i, /19AB moratorium/,
      /work rights/i, /notice period/i, /restraint/i, /bulk billing/i, /mixed billing/i, /private billing/i,
      /needs_consultant/, /never contact/i
    ];
    for (const re of must) expect([String(re), re.test(text)]).toEqual([String(re), true]);
    // The regulator is spelt "Ahpra" in Australian-facing copy, never "AHPRA".
    expect(/\bAHPRA\b/.test(text)).toBe(false);
  });

  it('uses only dynamic variables the dialler already builds', () => {
    const leadCalls = require('../lib/lead-calls.js');
    const built = Object.keys(leadCalls.buildLeadCallVariables({ row: { name: 'Dr Sam Taylor', metadata: { consult: { country: 'au' } } }, nowMs: Date.UTC(2026, 10, 20, 2, 0, 0) }));
    const used = Array.from(new Set((text.match(/{{\s*([a-z_]+)\s*}}/g) || []).map((m) => m.replace(/[{}\s]/g, ''))));
    expect(used.length).toBeGreaterThan(4);
    for (const v of used) expect(built).toContain(v);
    // ...and each has a default in the agent config, like the live script.
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'retell', 'agent.json'), 'utf8'));
    for (const v of used) expect(Object.keys(cfg.llm.default_dynamic_variables)).toContain(v);
  });

  it('is inert: nothing in scripts/, lib/ or server.js refers to it', () => {
    const files = listFiles(path.join(ROOT, 'scripts')).concat(listFiles(path.join(ROOT, 'lib')), [path.join(ROOT, 'server.js')]);
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((f) => /hazel-prompt-au/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('the setup script still loads only the existing prompt file', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'retell-setup.js'), 'utf8');
    const named = Array.from(new Set(src.match(/hazel-prompt[\w.-]*\.md/g) || []));
    expect(named).toEqual(['hazel-prompt.md']);
  });

  it('the block it relies on still exists and still refuses an Australian lead', () => {
    const auLead = require('../lib/au-lead.js');
    const leadCalls = require('../lib/lead-calls.js');
    const row = { id: 'x', kind: 'gp', phone: '+61400000000', metadata: { consult: { country: 'au' } } };
    expect(auLead.auHazelBlocked(row, { auPathwayEnabled: true })).toBe(true);
    expect(leadCalls.leadCallDecision({ row, nowMs: Date.UTC(2026, 10, 20, 2, 0, 0), auPathwayEnabled: true, ignoreHours: true }))
      .toEqual({ action: 'skip', reason: 'au_segment' });
  });

  it('the existing script is still the overseas one (this package did not touch it)', () => {
    const uk = fs.readFileSync(UK_PROMPT, 'utf8');
    expect(uk.startsWith('You are {{agent_name}} from GP Link, phoning {{full_name}}, a UK GP')).toBe(true);
    expect(uk).not.toContain('hazel-prompt-au');
  });

  it('the owner notes exist and say plainly that nothing is live', () => {
    const notes = fs.readFileSync(NOTES, 'utf8');
    expect(notes).toContain('NOT DONE. OWNER DECISION REQUIRED.');
    expect(notes).toContain('COM-34');
    expect(notes).toContain('auHazelBlocked');
    expect(notes).toContain('RETELL_FROM_NUMBER_AU');
  });
});
