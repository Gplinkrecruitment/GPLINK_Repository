// FR-7 (item 147 / M6-05): the two staff dashboards do not offer a protected
// Australian task the status buttons the server refuses for it.
//
// The screen's rule (js/au-staff-labels.js taskProtection) is a mirror of the
// server's (lib/au-task-guard.js requestDecision). This file pins that they
// agree for every kind of task, so the buttons can never drift from what the
// server accepts; and that an ordinary task's menu is what it always was.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const L = require('../js/au-staff-labels.js');
const guard = require('../lib/au-task-guard.js');
const auLifecycle = require('../lib/au-lifecycle.js');
const auPrestart = require('../lib/au-prestart.js');
const auSegmentB = require('../lib/au-segment-b.js');

const ROOT = path.resolve(__dirname, '..');
const admin = fs.readFileSync(path.join(ROOT, 'pages/admin.html'), 'utf8');
const ceo = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');

const au = (type, meta) => ({ id: 't1', task_type: type, status: 'open', metadata: Object.assign({ au: true, what_to_do: 'x' }, meta || {}) });
const SAMPLES = [];
// every prestart / lifecycle / segment B type and kind, with and without its fact
Object.values(auPrestart.TASK_TYPE).forEach((type) => {
  SAMPLES.push(au(type));
  SAMPLES.push(au(type, { provider_number: '123456AB' }));
  SAMPLES.push(au(type, { confirmed_start_date: '2027-01-11' }));
  SAMPLES.push(au(type, { restraint_outcome: 'no_restraint' }));
  SAMPLES.push(au(type, { restraint_outcome: 'made up' }));
});
Object.values(auLifecycle.KIND).forEach((kind) => {
  ['manual', 'invoice_due', 'guarantee_checkin'].forEach((type) => {
    SAMPLES.push(au(type, { lifecycle_kind: kind }));
    SAMPLES.push(au(type, { lifecycle_kind: kind, credit_known: true }));
    SAMPLES.push(au(type, { lifecycle_kind: kind, undone: true }));
  });
});
Object.values(auSegmentB.KIND).forEach((kind) => {
  [undefined, 'tracking', 'grant_notice', 'other'].forEach((mark) => {
    SAMPLES.push(au('manual', { lifecycle_kind: kind, needs_its_action: true, mark }));
    SAMPLES.push(au('manual', { lifecycle_kind: kind, mark }));
  });
});
// ordinary tasks, Australian and overseas
SAMPLES.push(au('manual'));
SAMPLES.push(au('ahpra_register_check'));
SAMPLES.push({ id: 'o1', task_type: 'manual', status: 'open', metadata: {} });
SAMPLES.push({ id: 'o2', task_type: 'practice_pack_child', related_document_key: 'sppa_00', status: 'open', metadata: null });
SAMPLES.push({ id: 'o3', task_type: 'start_date_tracking', status: 'open', metadata: { au: false } });
SAMPLES.push({ id: 'o4', task_type: 'invoice_due', status: 'open', metadata: '{"lifecycle_kind":"invoice_due"}' });

const OFFERED = ['in_progress', 'waiting_on_external', 'escalated'];
const label = (t) => t.task_type + ' ' + JSON.stringify(t.metadata);

describe('the screen and the server agree, for every kind of task', () => {
  for (const isCeo of [true, false]) {
    it((isCeo ? 'the CEO' : 'an RSO or consultant') + ': a button is offered exactly when the server would accept it', () => {
      expect(SAMPLES.length).toBeGreaterThan(80);
      let protectedSeen = 0;
      let ordinarySeen = 0;
      for (const task of SAMPLES) {
        const p = L.taskProtection(task, { isCeo });
        for (const status of OFFERED) {
          const fields = status === 'escalated' ? ['escalated_to', 'escalated_reason'] : [];
          const verdict = guard.requestDecision(task, { status, isCeo, fields });
          expect(!!verdict.refuse, label(task) + ' -> ' + status).toBe(!!p);
        }
        const complete = guard.requestDecision(task, { status: 'completed', isCeo, fields: [] });
        expect(!complete.refuse, label(task) + ' -> completed').toBe(p ? p.canComplete : true);
        if (p) { protectedSeen += 1; expect(p.reason.length).toBeGreaterThan(20); } else ordinarySeen += 1;
      }
      expect(protectedSeen).toBeGreaterThan(10);
      expect(ordinarySeen).toBeGreaterThan(10);
    });
  }

  it('a commercial task whose words are hidden from this viewer is the CEO\'s: nothing is offered', () => {
    const hidden = auLifecycle.redactCommercialTasks([au('invoice_due', { lifecycle_kind: 'invoice_due' })], false)[0];
    expect(L.taskProtection(hidden, { isCeo: false })).toMatchObject({ canComplete: false });
    expect(L.taskProtection(hidden, { isCeo: false }).reason).toMatch(/Only the CEO/);
  });

  it('an overseas task, a task with no metadata, and nothing at all are never protected', () => {
    for (const t of [null, undefined, {}, { task_type: 'manual' }, { task_type: 'start_date_tracking', metadata: {} },
      { task_type: 'practice_pack_child', related_document_key: 'sppa_00', metadata: { sppa_state: 'draft' } }, { task_type: 'manual', metadata: 'not json' }]) {
      expect(L.taskProtection(t, { isCeo: true })).toBe(null);
      expect(L.taskProtection(t, { isCeo: false })).toBe(null);
    }
    expect(L.taskProtectionNote(null)).toBe('');
  });

  it('the note is escaped text', () => {
    const html = L.taskProtectionNote({ reason: 'a <b>bold</b> & reason' });
    expect(html).toContain('a &lt;b&gt;bold&lt;/b&gt; &amp; reason');
    expect(html).toContain('data-au-task-protected="1"');
  });
});

describe('the two dashboards use it, and an ordinary task\'s menu is unchanged', () => {
  // The menu's lines are run as they are written in the page, against a fake
  // task, so this checks the real markup rather than a copy of it.
  function menuFrom(page, startMarker, endMarker, prelude) {
    const a = page.indexOf(startMarker);
    const b = page.indexOf(endMarker, a);
    expect(a, startMarker).toBeGreaterThan(0);
    expect(b, endMarker).toBeGreaterThan(a);
    const body = page.slice(a, b + endMarker.length);
    // eslint-disable-next-line no-new-func
    return new Function('t', 'window', 'isSA', 'esc', 'taskHasOwnFinish', 'GPAuStaff', prelude + '\nvar html = "";\n' + body + '\nreturn html;');
  }
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const ownFinish = (t) => !!(t && t.task_type === 'practice_pack_child' && t.related_document_key === 'sppa_00');
  const adminMenu = (t, isCeo) => menuFrom(admin, '// FR-7 (item 147): a protected Australian task is not offered the\n          // status buttons',
    "data-waiting=\"waiting_on_external\">\\u23F3 Waiting on External</button>';", '')(t, { GPAuStaff: L }, () => isCeo, esc, ownFinish, L);
  const ceoMenu = (t, isCeo) => menuFrom(ceo, '// FR-7 (item 147): a protected Australian task is not offered the\n            // status buttons',
    "data-waiting=\"waiting_on_external\">⏳ Waiting on External</button>';", '')(t, { GPAuStaff: L, __gpAdminRole: isCeo ? 'super_admin' : 'consultant' }, null, esc, ownFinish, L);

  const ordinary = { id: 'o1', task_type: 'manual', status: 'open', metadata: {} };
  const startDate = au('start_date_tracking');
  const startDateDone = au('start_date_tracking', { confirmed_start_date: '2027-01-11' });

  for (const [name, menu] of [['admin', adminMenu], ['CEO dashboard', ceoMenu]]) {
    it(name + ': an ordinary (overseas) task still gets Mark Complete, Start and Waiting, and no note', () => {
      const html = menu(ordinary, false);
      expect(html).toContain('data-complete-task="o1"');
      expect(html).toContain('data-start-task="o1"');
      expect(html).toContain('data-set-waiting="o1"');
      expect(html).not.toContain('data-au-task-protected');
    });
    it(name + ': a protected task with no fact on file: none of the three, and the reason is shown', () => {
      const html = menu(startDate, true);
      expect(html).not.toContain('data-complete-task');
      expect(html).not.toContain('data-start-task');
      expect(html).not.toContain('data-set-waiting');
      expect(html).toContain('data-au-task-protected="1"');
      expect(html).toContain('Its status changes through its own button');
    });
    it(name + ': once the fact is on file, Mark Complete is offered again (the server accepts it); Start and Waiting still are not', () => {
      const html = menu(startDateDone, true);
      expect(html).toContain('data-complete-task="t1"');
      expect(html).not.toContain('data-start-task');
      expect(html).not.toContain('data-set-waiting');
    });
  }

  it('Escalate to CEO is left out for a protected task in both menus, and the plain tick in both ops lists', () => {
    expect(admin).toContain("if(!auProt)html+='<button class=\"st-dropdown-item st-escalate-ceo\" data-escalate-ceo=");
    expect(ceo).toContain("if (!auProt) html += '<button class=\"st-dropdown-item st-escalate-ceo\" data-escalate-ceo=");
    expect(admin).toContain("if(!_isFlaggedDoc&&!_auFact&&!_auNoTick&&task.status!=='completed'&&task.status!=='cancelled')h+='<button class=\"ops-btn-green\" data-ops-complete-task=");
    expect(ceo).toContain("if (opsAuProt && !opsAuProt.canComplete) html += '<span class=\"ceo-ops-row-sub\" data-au-task-protected=\"1\"");
  });
});
