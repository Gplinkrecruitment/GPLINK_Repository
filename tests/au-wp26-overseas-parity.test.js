// WP-26 (Australian GP build): the two staff dashboards draw an OVERSEAS doctor
// exactly as they did before the package.
//
// tests/fixtures/au-wp26-overseas-parity.snapshot.json was written from
// tests/helpers/au-wp26-parity.js BEFORE any page or script changed (commit
// a7278be0). It holds the markup of every view WP-26 touched, for an overseas
// doctor: the RSO page's list card, profile bar, journey rail, tasks pane,
// documents pane, case form, Ops Queue rows and cards, the add-task form and
// the assistance-call dialog's source; the CEO dashboard's candidate row, list
// header, whole profile, the Leads row and drawer, the Meetings rows and the
// matching board's block labels. Never regenerate it to make this pass.
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const parity = require('./helpers/au-wp26-parity.js');

const want = JSON.parse(fs.readFileSync(parity.SNAPSHOT_PATH, 'utf8'));

describe('WP-26: overseas markup on both dashboards is byte for byte what it was', () => {
  const got = parity.buildOverseasSnapshot();

  // The assistance-call dialog is the one function whose SOURCE was pinned
  // (it cannot be run without a DOM). WP-26 added an Australian branch to it,
  // so its overseas behaviour is proved by running it instead: see
  // tests/au-wp26-admin-ui.test.js ("the assistance-call dialog").
  const SOURCE_ONLY = ['admin.src.zoomModal'];

  Object.keys(want).filter((k) => SOURCE_ONLY.indexOf(k) === -1).forEach((key) => {
    it(key, () => {
      expect(got[key]).toBe(want[key]);
    });
  });

  it('covers every view in the snapshot and nothing threw', () => {
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    Object.keys(got).forEach((k) => expect(String(got[k]).indexOf('THROWS:'), k).toBe(-1));
  });

  it('an overseas render makes no request at all', () => {
    expect(got['admin.fetchCalls']).toBe('[]');
    expect(got['ceo.cand.requests']).toBe('{"api":[],"swr":[],"fetch":[]}');
  });

  it('the overseas views still say what they always said (the snapshot is a real overseas render)', () => {
    expect(want['admin.detail']).toContain('GB');
    expect(want['admin.detail']).toContain('2/5 docs');
    expect(want['admin.journeyRail']).toContain('MyIntealth');
    expect(want['admin.tasksPane.empty']).toContain('Log AHPRA letter');
    expect(want['ceo.cand.onboardingCard']).toContain('Target arrival');
    expect(want['ceo.leads.actions']).toContain('Call now with Hazel');
  });
});
