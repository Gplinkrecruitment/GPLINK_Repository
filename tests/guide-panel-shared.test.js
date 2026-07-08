import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const guide = fs.readFileSync(path.join(root, 'js/guide-panel.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'pages/admin.html'), 'utf8');
const ceo = fs.readFileSync(path.join(root, 'pages/ceo-dashboard.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

describe('Shared RSO Guide component (guide-panel.js)', () => {
  it('exposes GuidePanel.mount(container, { canEdit })', () => {
    expect(guide).toMatch(/window\.GuidePanel\s*=\s*\{\s*mount:\s*mount\s*\}/);
    expect(guide).toMatch(/function mount\(container, opts\)/);
  });

  it('read-only mode renders no edit controls', () => {
    // Every mutation control (add folder/item, rename, delete) is behind canEdit.
    expect(guide).toMatch(/canEdit \? '<button class="gpg-add-btn" data-gpg-add-folder/);
    expect(guide).toMatch(/canEdit \? '<button class="gpg-mgmt-btn" data-gpg-edit-item/);
    expect(guide).toMatch(/canEdit \? '<button class="gpg-add-btn" data-gpg-add-item/);
    // The click handler bails before any write action when not editable.
    expect(guide).toMatch(/if \(!self\.canEdit\) return;/);
    // Drag-to-reorder is also gated on canEdit.
    expect(guide).toMatch(/draggable="true"/);
    expect(guide).toMatch(/if \(!self\.canEdit\) return;[\s\S]{0,120}dragstart|dragstart[\s\S]{0,200}if \(!self\.canEdit\) return;/);
  });
});

describe('RSO dashboard (admin.html) mounts the guide READ-ONLY', () => {
  it('mounts the shared module with canEdit:false', () => {
    expect(admin).toMatch(/src="\/js\/guide-panel\.js/);
    expect(admin).toMatch(/GuidePanel\.mount\('guidePanel',\s*\{\s*canEdit:\s*false\s*\}\)/);
    expect(admin).toMatch(/mountGuidePanelRO/);
  });

  it('no longer ships the old inline guide editor', () => {
    expect(admin).not.toMatch(/renderGuidePanel/);
    expect(admin).not.toMatch(/loadGuideData/);
    expect(admin).not.toMatch(/data-add-folder/);
    expect(admin).not.toMatch(/data-guide-folder/);
  });
});

describe('CEO dashboard (Registration → Guides) mounts the guide EDITABLE', () => {
  it('mounts the shared module with canEdit:true in the Guides sub-tab', () => {
    expect(ceo).toMatch(/src="\/js\/guide-panel\.js/);
    expect(ceo).toMatch(/GuidePanel\.mount\('ceoGuidePanel',\s*\{\s*canEdit:\s*true\s*\}\)/);
    expect(ceo).toMatch(/id="regSubnav"/);
    expect(ceo).toMatch(/data-regsub="rsos"/);
    expect(ceo).toMatch(/data-regsub="guides"/);
  });
});

describe('Guide permissions are enforced server-side (only CEO can edit)', () => {
  function windowAfter(sig, n = 220) {
    const i = server.indexOf(sig);
    expect(i, 'route present: ' + sig).toBeGreaterThan(-1);
    return server.slice(i, i + n);
  }

  it('reading the guide is open to any admin (RSOs can watch tutorials)', () => {
    expect(windowAfter("req.method === 'GET' && pathname === '/api/admin/guide/folders'")).toContain('requireAdminSession');
  });

  it('every write is gated to the CEO (requireCeoSession)', () => {
    // Create / reorder / rename / delete folders + items.
    expect(windowAfter("req.method === 'POST' && pathname === '/api/admin/guide/folders'")).toContain('requireCeoSession');
    expect(windowAfter("req.method === 'POST' && pathname === '/api/admin/guide/folders'")).not.toContain('requireAdminSession');
    expect(windowAfter("pathname === '/api/admin/guide/folders/reorder'")).toContain('requireCeoSession');
    expect(windowAfter("req.method === 'POST' && pathname === '/api/admin/guide/items'")).toContain('requireCeoSession');
    expect(windowAfter("req.method === 'DELETE' && pathname.match(/^\\/api\\/admin\\/guide\\/items")).toContain('requireCeoSession');
    expect(windowAfter("req.method === 'DELETE' && pathname.match(/^\\/api\\/admin\\/guide\\/folders")).toContain('requireCeoSession');
  });
});
