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

  it('has its own standalone top nav (not iframe-only)', () => {
    expect(ceo).toMatch(/class="ceo-topnav"/);
  });

  it('unified menu: Medical Centres + Technical are in-page tabs; ops areas live under RSO Oversight; Guide opens in a new tab', () => {
    // The CEO Command Centre is one workspace. Medical Centres and Technical are
    // now in-page dark tabs (not bouncing links into the light admin page), and
    // the operational work-lists (GPs, Support, Calls) live under RSO Oversight,
    // so their standalone bouncing links are removed.
    expect(ceo).not.toMatch(/href="\/pages\/admin\?view=tools"/);   // Ops Queue removed
    // Medical Centres + Technical are in-page tabs now.
    expect(ceo).toMatch(/data-tab="medical"/);
    expect(ceo).toMatch(/data-tab="technical"/);
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
});
