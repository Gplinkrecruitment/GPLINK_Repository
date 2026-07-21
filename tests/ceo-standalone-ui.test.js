import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ceo = fs.readFileSync(path.join(root, 'pages/ceo-dashboard.html'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'pages/admin.html'), 'utf8');

describe('CEO standalone page UI', () => {
  it('relabels all user-facing VA to RSO', () => {
    // No user-facing "VA Workload" / "Reassign VA" / "Assigned VA" labels remain
    expect(ceo).not.toMatch(/VA Workload/);
    expect(ceo).not.toMatch(/Reassign VA/);
    expect(ceo).not.toMatch(/Assigned VA/);
    expect(ceo).not.toMatch(/'No VAs assigned/);
    expect(ceo).toMatch(/RSO Workload/);
  });

  it('has its own master-tab nav (standalone, not iframe-only)', () => {
    // The old standalone .ceo-topnav strip is retired; the master-tab bar is the nav.
    expect(ceo).toMatch(/id="masterTabs"/);
    expect(ceo).toMatch(/class="ats-master-tab[^"]*" data-mtab="registration"/);
  });

  it('unified menu: RSO + Technical are their own master tabs, Medical Centres is deleted, Guide stays; ops live under RSO', () => {
    // The CEO Command Centre is one workspace. RSO oversight and Technical are now
    // their own top-level master tabs (data-mtab) with dedicated panels, not
    // sub-tabs of a standalone top-nav. The redundant Medical Centres tab was
    // deleted because the Practices master tab already covers medical centres.
    expect(ceo).not.toMatch(/href="\/pages\/admin\?view=tools"/);   // Ops Queue removed
    // RSO + Technical are top-level master tabs with their own panels.
    expect(ceo).toMatch(/data-mtab="rso"/);
    expect(ceo).toMatch(/data-mtab="technical"/);
    expect(ceo).toMatch(/id="panel-rso"/);
    expect(ceo).toMatch(/id="panel-technical"/);
    // Medical Centres is fully removed (nav item, panel div, and loader all gone).
    expect(ceo).not.toMatch(/data-tab="medical"/);
    expect(ceo).not.toMatch(/id="mcContent"/);
    expect(ceo).not.toMatch(/loadMedicalCentres/);
    // The old pop-out Guide link is gone, the guide is now the Registration → Guides
    // sub-tab, mounted from the shared js/guide-panel.js component (CEO-editable).
    expect(ceo).not.toMatch(/href="\/pages\/admin\?view=guide"/);
    expect(ceo).toMatch(/data-regsub="guides"/);
    expect(ceo).toMatch(/id="ceoGuidePanel"/);
    // The operational areas no longer bounce out to the light admin page.
    expect(ceo).not.toMatch(/href="\/pages\/admin\?view=gps"/);
    expect(ceo).not.toMatch(/href="\/pages\/admin\?view=support"/);
    expect(ceo).not.toMatch(/href="\/pages\/admin\?view=scheduled_calls"/);
    // Ops now lives under RSO Oversight: the page wires a per-RSO ops fetch.
    expect(ceo).toMatch(/\/api\/ceo\/rso\/[^]*?\/ops/);
    // And the admin page surfaces the executive views back in the same menu.
    expect(admin).toMatch(/id="ceoOverviewTab"[^>]*href="\/pages\/ceo-dashboard"/);
    expect(admin).toMatch(/id="ceoRsoOversightTab"[^>]*href="\/pages\/ceo-dashboard\?tab=rsos"/);
    // The confusing self-referential "CEO Command Centre ->" nav item is gone.
    expect(admin).not.toMatch(/CEO Command Centre &#x2197;/);
  });

  it('master-tab order is Overview, RSO, Candidates, Matching, Jobs, Practices, Meetings, Technical', () => {
    // The first (and only) run of literal data-mtab="..." attributes is the nav bar;
    // assert their left-to-right order. The "registration" tab is labelled Overview.
    const order = ['registration', 'rso', 'candidates', 'matching', 'jobs', 'practices', 'meetings', 'technical'];
    for (let i = 0; i < order.length - 1; i++) {
      const a = ceo.indexOf('data-mtab="' + order[i] + '"');
      const b = ceo.indexOf('data-mtab="' + order[i + 1] + '"');
      expect(a, order[i] + ' tab present').toBeGreaterThan(-1);
      expect(b, order[i + 1] + ' tab present').toBeGreaterThan(-1);
      expect(a, order[i] + ' before ' + order[i + 1]).toBeLessThan(b);
    }
    // The Registration/Overview tab is now labelled "Overview".
    expect(ceo).toMatch(/data-mtab="registration">[\s\S]{0,600}?Overview/);
    // The RSO tab (data-mtab stays "rso") is now labelled "Registration".
    expect(ceo).toMatch(/data-mtab="rso">[\s\S]{0,600}?Registration/);
    // Registration has a two-item sub-nav: RSOs (default) + Guides.
    expect(ceo).toMatch(/data-regsub="rsos"/);
    expect(ceo).toMatch(/data-regsub="guides"/);
    // The shared master-tab switcher knows about the two new panels.
    const shared = fs.readFileSync(path.join(root, 'js/ceo-ats-shared.js'), 'utf8');
    const line = shared.split('\n').find((l) => l.includes('var MASTER_PANELS ='));
    expect(line).toMatch(/'rso'/);
    expect(line).toMatch(/'technical'/);
  });

  it('makes KPI tiles clickable via data-drilldown', () => {
    // kpiCard must emit a data-drilldown attribute for the wired tiles.
    // The attribute is built by concatenation from kpiDrillMap, so the
    // source-level evidence of the wiring is the map entry (the literal
    // data-drilldown="..." never appears in source because
    // drill.section/drill.param are interpolated at runtime).
    expect(ceo).toMatch(/data-drilldown="'\s*\+\s*drill\.section\s*\+\s*'"\s*data-param="'\s*\+\s*drill\.param/);
    expect(ceo).toMatch(/kpiDrillMap/);
  });

  it('Placed KPI drills into the period-independent "placed" section, rendered in the placements panel', () => {
    // The Placed KPI must reconcile with the unique-user Placed count, so it
    // hits the new "placed" drilldown section (not the per-application,
    // period-scoped "placements" section) and renders into the placements panel.
    expect(ceo).toMatch(/placed:\s*\{\s*section:\s*'placed',\s*param:\s*'',\s*panel:\s*'placements'\s*\}/);
    expect(ceo).not.toMatch(/placed:\s*\{\s*section:\s*'placements',\s*param:\s*'status=secured'\s*\}/);
  });

  it('Open Tasks KPI drills into all open task statuses (reconciles with the count)', () => {
    expect(ceo).toMatch(/open_tasks:\s*\{\s*section:\s*'tasks',\s*param:\s*'status=all_open'\s*\}/);
  });

  it('RSO Workload reads data.rso_workload and drills into the "rso" section', () => {
    expect(ceo).toMatch(/renderRsoWorkloadSection\(data\.rso_workload/);
    expect(ceo).toMatch(/data-drilldown="rso"/);
    expect(ceo).toMatch(/v\.rso_id/);
    expect(ceo).toMatch(/v\.rso_name/);
    expect(ceo).toMatch(/v\.rso_email/);
  });

  it('Reassign surfaces a warning when the email transfer fails', () => {
    expect(ceo).toMatch(/email_transferred\s*===\s*false\s*\|\|\s*d\.transfer_error/);
    expect(ceo).toMatch(/email transfer failed/);
  });

  it('reassign modal uses an RSO <select>, not a free-text user id box', () => {
    expect(ceo).not.toMatch(/id="mVaId"/);
    expect(ceo).toMatch(/id="mRsoSelect"/);
    expect(ceo).toMatch(/assigned_rso:/);
  });

  it('Set Blocker modal no longer offers an invalid "Blocked" option', () => {
    expect(ceo).not.toMatch(/<option value="blocked">Blocked<\/option>/);
  });

  it('Add Note posts to the task endpoint when a taskId is present', () => {
    expect(ceo).toMatch(/\/api\/admin\/task\/note/);
  });

  it('Task Health renders an In Progress cell', () => {
    expect(ceo).toMatch(/In Progress/);
  });

  it('RSO oversight panel + endpoints are wired', () => {
    expect(ceo).toMatch(/\/api\/ceo\/rsos/);
    expect(ceo).toMatch(/\/api\/ceo\/rso\//);
    expect(ceo).toMatch(/renderRsoOversight/);
  });

  it('admin.html no longer ships the CEO iframe or Home Dashboard tab', () => {
    expect(admin).not.toMatch(/ceoHomeIframe/);
    expect(admin).not.toMatch(/data-view="ceo-home"/);
    expect(admin).not.toMatch(/id="ceoHomePanel"/);
  });

  it('GP-detail sub-tab pane carries .gp-parity so task cards get their scoped styles', () => {
    // Every GP task-card style (.stage-task, .st-dropdown, etc.) is scoped under
    // .gp-parity AND relies on the scoped CSS vars (--line/--muted/--bg2) defined
    // only on .gp-parity. renderGpTasksTab() fills #gpDetailPane, so the pane element
    // itself must carry gp-parity, otherwise the cards render unstyled and the •••
    // dropdown items show permanently (the "task cards extremely badly put in" bug).
    expect(ceo).toMatch(/class="ceo-gp-detail-pane gp-parity" id="gpDetailPane"/);
    // The scoped vars must exist (the styles are useless without them).
    expect(ceo).toMatch(/\.gp-parity\s*\{[^}]*--line:/);
    // The dropdown must default to hidden and only open with .open.
    expect(ceo).toMatch(/\.gp-parity \.st-dropdown\.open\{display:block\}/);
  });
});
