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
    expect(ceo).toMatch(/href="\/pages\/admin"/); // back-to-admin link
  });

  it('makes KPI tiles clickable via data-drilldown', () => {
    // kpiCard must emit a data-drilldown attribute for the 4 wired tiles
    expect(ceo).toMatch(/data-drilldown="placements"[^>]*data-param="status=secured"/);
    expect(ceo).toMatch(/kpiDrillMap/);
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
