// WP-17 acceptance: every new message N04 to N22 has a builder, a trigger that
// is really wired (the trigger function exists and is called from the places
// the registry names) and a test. This file is the completeness check: add a
// message to the registry without one of the three and it fails.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const auMessages = require('../lib/au-messages.js');
const auStaffTools = require('../lib/au-staff-tools.js');
const careerIntro = require('../lib/career-intro.js');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const EXPECTED = ['N04', 'N05', 'N06', 'N07', 'N08', 'N09', 'N10', 'N11', 'N12', 'N13', 'N14', 'N15', 'N16', 'N17', 'N18', 'N19', 'N20', 'N21', 'N22'];

// Who calls `fn`? For every call site in server.js: the top-level function it
// sits in, and the nearest route address written before it.
function callersOf(fn) {
  const names = new Set();
  const re = new RegExp('(?:^|[^A-Za-z0-9_$])(?:run: )?' + fn.replace(/[$]/g, '\\$') + '(?:\\(|\\b(?= *[},]))', 'g');
  let m;
  while ((m = re.exec(SERVER)) !== null) {
    const at = m.index;
    const before = SERVER.slice(0, at + 1);
    const lineStart = before.lastIndexOf('\n') + 1;
    const line = SERVER.slice(lineStart, SERVER.indexOf('\n', at));
    if (/^(async )?function /.test(line) && line.indexOf('function ' + fn + '(') !== -1) continue; // its own definition
    const fnMatches = before.match(/\n(?:async )?function ([A-Za-z0-9_$]+)\(/g) || [];
    if (fnMatches.length) names.add(fnMatches[fnMatches.length - 1].replace(/\n(?:async )?function /, '').replace('(', ''));
    const routes = SERVER.slice(Math.max(0, at - 6000), SERVER.indexOf('\n', at)).match(/'\/api\/[A-Za-z0-9_\-/]+'/g) || [];
    if (routes.length) names.add(routes[routes.length - 1].replace(/'/g, ''));
  }
  return names;
}

function defined(fn, file) {
  const src = file ? fs.readFileSync(path.join(ROOT, file), 'utf8') : SERVER;
  return new RegExp('(?:^|\\n)\\s*(?:async )?function ' + fn + '\\(').test(src);
}

describe('WP-17: the registry of Australian lifecycle messages', () => {
  it('lists exactly N04 to N22', () => {
    expect(auMessages.MESSAGE_IDS.slice()).toEqual(EXPECTED);
  });

  for (const id of EXPECTED) {
    describe(id, () => {
      const entry = auMessages.AU_MESSAGES[id];

      it('says when, to whom, on which channels, what each segment gets, quiet hours and the once-ever key', () => {
        expect(entry.id).toBe(id);
        for (const k of ['name', 'origin', 'to', 'when', 'quietHours', 'quietWhy', 'ledgerKey', 'once', 'builder']) {
          expect(typeof entry[k], id + '.' + k).toBe('string');
          expect(entry[k].length, id + '.' + k).toBeGreaterThan(2);
        }
        expect(Object.keys(entry.segments).sort()).toEqual(['A', 'B', 'C']);
        expect(typeof entry.channels).toBe('object');
      });

      it('has a builder that really exists', () => {
        const names = entry.builder.split(',').map((s) => s.trim().replace(/\s*\(.*\)$/, '')).filter(Boolean);
        expect(names.length).toBeGreaterThan(0);
        for (const raw of names) {
          const name = raw.replace(/^auStaffTools\.|^careerIntro\./, '');
          const found = typeof auMessages[name] === 'function' || typeof auStaffTools[name] === 'function'
            || typeof careerIntro[name] === 'function' || defined(name);
          expect(found, id + ' builder ' + raw).toBe(true);
        }
      });

      it('builds something (every sample has words)', () => {
        const samples = entry.samples();
        if (id === 'N07' || id === 'N09') { expect(samples).toEqual([]); return; }
        expect(samples.length).toBeGreaterThan(0);
        for (const s of samples) {
          expect(s.message, id + ' ' + s.label).toBeTruthy();
          expect(String(s.message.subject || '').length).toBeGreaterThan(3);
          expect(String(s.message.body || s.message.text || '').length).toBeGreaterThan(20);
          if (s.message.key) expect(auMessages.messageIdForLedgerKey(s.message.key), s.message.key).toBe(id);
        }
      });

      it('has a trigger that is wired: the function exists and each named caller calls it', () => {
        const t = entry.trigger;
        expect(defined(t.fn, t.file), id + ' trigger ' + t.fn + ' is defined').toBe(true);
        const actual = callersOf(t.fn);
        for (const caller of t.callers) {
          expect(actual.has(caller), id + ': ' + caller + ' calls ' + t.fn + ' (found: ' + Array.from(actual).join(', ') + ')').toBe(true);
        }
        // One hop further where the registry names it (the event that starts it).
        Object.keys(t.via || {}).forEach((mid) => {
          const up = callersOf(mid);
          for (const caller of t.via[mid]) {
            expect(up.has(caller), id + ': ' + caller + ' calls ' + mid + ' (found: ' + Array.from(up).join(', ') + ')').toBe(true);
          }
        });
      });

      it('has tests, and each names the message', () => {
        expect(entry.tests.length).toBeGreaterThan(0);
        // Every file must exist; the first two (this package's own tests, or the
        // earlier package's test that drives the trigger) must name the message.
        entry.tests.forEach((file, n) => {
          const full = path.join(ROOT, file);
          expect(fs.existsSync(full), file).toBe(true);
          if (n < 2) expect(fs.readFileSync(full, 'utf8').indexOf(id) !== -1, file + ' mentions ' + id).toBe(true);
        });
      });
    });
  }

  it('N07 is a staff task: the builder makes a segment_review task and sends nothing', () => {
    const task = auStaffTools.buildSegmentReviewTask({ pathway: 'au_restricted', reasons: ['segment_not_launched'] });
    expect(task.task_type).toBe('segment_review');
    expect(auMessages.AU_MESSAGES.N07.channels.task).toBe('segment_review');
  });

  it('every ledger key a WP-17 builder produces maps back to its message', () => {
    expect(auMessages.messageIdForLedgerKey('au_n16_cleared_to_start:APP1')).toBe('N16');
    expect(auMessages.messageIdForLedgerKey('au_task:start_date_tracking:APP1')).toBe('');
    expect(auMessages.messageIdForLedgerKey('myintealth_intro')).toBe('');
  });
});
