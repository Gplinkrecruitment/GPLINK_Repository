/* ============================================================================
 * guide-panel.js — shared RSO Guide component.
 *
 * One source of truth for the folders/items how-to guide, mounted in two places:
 *   • pages/admin.html    — the RSO dashboard, READ-ONLY (canEdit:false)
 *   • pages/ceo-dashboard — Registration → Guides sub-tab, EDITABLE (canEdit:true)
 *
 * The server already enforces the real permission: reads (GET /api/admin/guide/
 * folders) are open to any admin so RSOs can watch the tutorials, but every write
 * (create/rename/delete/reorder a folder or item) is gated to the CEO/super-admin
 * (requireCeoSession). canEdit here only decides whether the edit controls render;
 * a non-CEO could never mutate the guide even if the controls were forced on.
 *
 * Self-contained: injects its own namespaced (.gpg-*) CSS once, keeps its own
 * state, and scopes all click/drag listeners to the mount container so multiple
 * mounts never cross-talk. Public API: window.GuidePanel.mount(el, { canEdit }).
 * ==========================================================================*/
(function () {
  'use strict';

  var STYLE_ID = 'gpg-styles';
  var CSS = [
    // Self-contained light card palette (fixed colours, NOT host theme vars): the
    // module mounts in BOTH the dark CEO dashboard and the light admin page, so it
    // must not inherit either page's --text/--bg (that made text white-on-light).
    '.gpg-wrap{display:flex;height:calc(100vh - 190px);min-height:460px;overflow:hidden;border:1px solid #e5e7eb;border-radius:10px;background:#f8fafc;color:#0f172a}',
    '.gpg-folders{flex:0 0 340px;overflow-y:auto;padding:16px;border-right:1px solid #e5e7eb;background:#fff;color:#0f172a}',
    '.gpg-detail{flex:1;display:flex;flex-direction:column;background:#f8fafc;color:#0f172a}',
    '.gpg-detail-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #e5e7eb;background:#fff;color:#0f172a}',
    '.gpg-detail-header h3{margin:0;font-size:14px;font-weight:700;color:#0f172a}',
    '.gpg-detail-body{flex:1;overflow:hidden;position:relative;background:#fff}',
    '.gpg-detail-body iframe{width:100%;height:calc(100% + 56px);border:none;margin-top:-56px}',
    '.gpg-folder{margin-bottom:8px;position:relative}',
    '.gpg-folder.dragging{opacity:.4}',
    '.gpg-folder.drag-over-above::before{content:\"\";position:absolute;top:-4px;left:0;right:0;height:3px;background:#2563eb;border-radius:2px;z-index:10}',
    '.gpg-folder.drag-over-below::after{content:\"\";position:absolute;bottom:-4px;left:0;right:0;height:3px;background:#2563eb;border-radius:2px;z-index:10}',
    '.gpg-folder-header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px;color:#0f172a;background:#f1f5f9;transition:background .15s}',
    '.gpg-folder-header:hover{background:#e2e8f0}',
    '.gpg-folder-header.active{background:#e8f0fe;color:#2563eb}',
    '.gpg-folder-count{background:#e2e8f0;color:#334155;padding:1px 6px;border-radius:10px;font-size:10px;margin-left:auto;font-weight:700}',
    '.gpg-folder-header.active .gpg-folder-count{background:#2563eb;color:#fff}',
    '.gpg-folder-items{padding:4px 0 4px 24px}',
    '.gpg-item{padding:8px 12px;font-size:12px;color:#0f172a;border-radius:6px;cursor:pointer;margin:2px 0;border:1px solid transparent;transition:all .15s;display:flex;align-items:center;gap:4px}',
    '.gpg-item:hover{background:#f1f5f9;border-color:#e5e7eb}',
    '.gpg-item.active{background:#2563eb;color:#fff;border-color:#2563eb}',
    '.gpg-empty{display:flex;align-items:center;justify-content:center;height:100%;color:#64748b;font-size:13px;text-align:center;padding:40px}',
    '.gpg-add-btn{display:inline-flex;align-items:center;gap:4px;padding:6px 12px;border-radius:6px;font-size:11px;font-weight:600;color:#2563eb;background:transparent;border:1px dashed #2563eb;cursor:pointer;margin-top:8px;transition:all .15s}',
    '.gpg-add-btn:hover{background:#e8f0fe}',
    '.gpg-mgmt-btn{opacity:0;padding:4px;border:none;background:transparent;cursor:pointer;font-size:12px;color:#64748b;transition:opacity .15s;flex-shrink:0}',
    '.gpg-folder-header:hover .gpg-mgmt-btn,.gpg-item:hover .gpg-mgmt-btn{opacity:1}',
    '.gpg-mgmt-btn:hover{color:#e53e3e}',
    '.gpg-item.active .gpg-mgmt-btn{color:rgba(255,255,255,0.7)}',
    '.gpg-item.active .gpg-mgmt-btn:hover{color:#fff}',
    '.gpg-drag-handle{cursor:grab;opacity:.35;font-size:11px;margin-right:2px}',
    '@media (max-width:900px){',
    '.gpg-wrap{flex-direction:column;height:auto;max-height:calc(100vh - 160px)}',
    '.gpg-folders{flex:0 0 auto;max-height:35vh;overflow-y:auto;padding:12px;border-right:none;border-bottom:1px solid #e5e7eb}',
    '.gpg-detail{flex:1;min-height:300px}',
    '.gpg-detail-body iframe{margin-top:-40px;height:calc(100% + 40px)}',
    '}'
  ].join('');

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  // Pull the src="…" out of a pasted Scribe embed snippet; otherwise use as-is.
  function parseScribeEmbed(input) {
    if (!input) return '';
    var m = String(input).match(/src=["']([^"']+)["']/);
    return m ? m[1] : String(input).trim();
  }
  // Only ever iframe an http(s) URL (matches admin.html's safeEmbedUrl guard).
  function safeEmbedUrl(u) {
    if (!u || typeof u !== 'string') return '';
    var raw = u.trim();
    if (!raw || /[\u0000-\u001F\u007F]/.test(raw)) return '';
    var pm = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
    var proto = pm ? pm[1].toLowerCase() : '';
    return (proto === 'https' || proto === 'http') ? raw : '';
  }

  function findItem(folders, itemId) {
    var found = null;
    (function walk(list) {
      list.forEach(function (f) {
        if (found) return;
        (f.items || []).forEach(function (i) { if (i.id === itemId) found = i; });
        walk(f.children || []);
      });
    })(folders || []);
    return found;
  }
  function flatFolders(folders) {
    var out = [];
    (function walk(list) { list.forEach(function (f) { out.push(f); walk(f.children || []); }); })(folders || []);
    return out;
  }

  function Instance(container, opts) {
    this.el = container;
    this.canEdit = !!(opts && opts.canEdit);
    this.api = (opts && opts.apiBase) || '/api/admin/guide';
    this.folders = null;
    this.expanded = {};
    this.selectedId = null;
    this.dragId = null;
  }

  Instance.prototype.load = function () {
    var self = this;
    return fetch(this.api + '/folders', { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok) self.folders = d.folders || []; else self.folders = self.folders || []; })
      .catch(function (e) { console.error('[Guide] load error', e); self.folders = self.folders || []; });
  };

  Instance.prototype.reload = function () {
    var self = this;
    return this.load().then(function () { self.render(); });
  };

  Instance.prototype.render = function () {
    var self = this;
    var el = this.el;
    if (!el) return;
    var folders = this.folders || [];
    var canEdit = this.canEdit;

    function countAll(folder) {
      var n = (folder.items || []).length;
      (folder.children || []).forEach(function (c) { n += countAll(c); });
      return n;
    }
    function renderList(list, depth) {
      return list.map(function (f) {
        var expanded = !!self.expanded[f.id];
        var items = f.items || [];
        var children = f.children || [];
        var itemsHtml = '';
        if (expanded) {
          itemsHtml = '<div class="gpg-folder-items">' +
            items.map(function (item) {
              var active = self.selectedId === item.id;
              return '<div class="gpg-item' + (active ? ' active' : '') + '" data-gpg-item="' + esc(item.id) + '">' +
                '<span style="flex:1">' + esc(item.title) + '</span>' +
                (canEdit ? '<button class="gpg-mgmt-btn" data-gpg-edit-item="' + esc(item.id) + '" title="Edit">&#9998;</button><button class="gpg-mgmt-btn" data-gpg-delete-item="' + esc(item.id) + '" title="Delete">&times;</button>' : '') +
                '</div>';
            }).join('') +
            (items.length === 0 && children.length === 0 ? '<div style="padding:8px 12px;font-size:11px;color:#64748b">No guides in this folder yet</div>' : '') +
            (children.length > 0 ? renderList(children, depth + 1) : '') +
            (canEdit ? '<button class="gpg-add-btn" data-gpg-add-item="' + esc(f.id) + '">+ Add Guide</button>' : '') +
            '</div>';
        }
        return '<div class="gpg-folder" style="margin-left:' + (depth * 16) + 'px"' + (canEdit ? ' draggable="true"' : '') + ' data-gpg-folder-drag="' + esc(f.id) + '">' +
          '<div class="gpg-folder-header' + (expanded ? ' active' : '') + '" data-gpg-folder="' + esc(f.id) + '">' +
            (canEdit ? '<span class="gpg-drag-handle" title="Drag to reorder">&#9776;</span>' : '') +
            '<span>' + (expanded ? '&#9660;' : '&#9654;') + '</span> &#128193; ' + esc(f.name) +
            '<span class="gpg-folder-count">' + countAll(f) + '</span>' +
            (canEdit ? '<button class="gpg-mgmt-btn" data-gpg-edit-folder="' + esc(f.id) + '" title="Rename">&#9998;</button><button class="gpg-mgmt-btn" data-gpg-delete-folder="' + esc(f.id) + '" title="Delete">&times;</button>' : '') +
          '</div>' + itemsHtml +
        '</div>';
      }).join('');
    }

    var folderListHtml = renderList(folders, 0);
    var selectedItem = this.selectedId ? findItem(folders, this.selectedId) : null;
    var detailHtml;
    if (selectedItem) {
      var src = safeEmbedUrl(selectedItem.scribe_url);
      detailHtml = '<div class="gpg-detail-header"><h3>' + esc(selectedItem.title) + '</h3><button data-gpg-close style="border:none;background:transparent;cursor:pointer;font-size:18px;color:#64748b">&times;</button></div>' +
        '<div class="gpg-detail-body">' + (src ? '<iframe src="' + esc(src) + '" allowfullscreen></iframe>' : '<div class="gpg-empty">This guide has no valid tutorial link.</div>') + '</div>';
    } else {
      detailHtml = '<div class="gpg-empty"><div><div style="font-size:40px;margin-bottom:8px">&#127891;</div>Select a guide to view the tutorial</div></div>';
    }

    el.innerHTML = '<div class="gpg-wrap">' +
      '<div class="gpg-folders">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px"><h3 style="margin:0;font-size:15px;font-weight:700">Guides</h3>' +
          (canEdit ? '<button class="gpg-add-btn" data-gpg-add-folder>+ Add Folder</button>' : '') +
        '</div>' +
        (folders.length === 0 ? '<div class="gpg-empty" style="height:auto;padding:20px"><div>No guides yet</div></div>' : folderListHtml) +
      '</div>' +
      '<div class="gpg-detail">' + detailHtml + '</div>' +
    '</div>';
  };

  Instance.prototype._req = function (path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'include' };
    if (opts.body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }
    return fetch(this.api + path, init).then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  };

  Instance.prototype.bindClicks = function () {
    var self = this;
    this.el.addEventListener('click', function (e) {
      // Toggle folder expand/collapse.
      var fh = e.target.closest('[data-gpg-folder]');
      if (fh && !e.target.closest('.gpg-mgmt-btn') && !e.target.closest('.gpg-drag-handle')) {
        var fid = fh.getAttribute('data-gpg-folder');
        if (self.expanded[fid]) delete self.expanded[fid]; else self.expanded[fid] = true;
        self.render(); return;
      }
      // Open an item tutorial.
      var gi = e.target.closest('[data-gpg-item]');
      if (gi && !e.target.closest('.gpg-mgmt-btn')) {
        self.selectedId = gi.getAttribute('data-gpg-item');
        self.render(); return;
      }
      // Close the detail pane.
      if (e.target.closest('[data-gpg-close]')) { self.selectedId = null; self.render(); return; }

      if (!self.canEdit) return; // read-only: nothing below runs

      if (e.target.closest('[data-gpg-add-folder]')) {
        var name = prompt('Folder name:');
        if (!name) return;
        self._req('/folders', { method: 'POST', body: { name: name } }).then(function (d) {
          if (d && d.ok) self.reload(); else alert((d && d.message) || 'Failed');
        });
        return;
      }
      var addItemBtn = e.target.closest('[data-gpg-add-item]');
      if (addItemBtn) {
        var folderId = addItemBtn.getAttribute('data-gpg-add-item');
        var title = prompt('Guide title:'); if (!title) return;
        var raw = prompt('Paste Scribe embed code:'); if (!raw) return;
        self._req('/items', { method: 'POST', body: { folder_id: folderId, title: title, scribe_url: parseScribeEmbed(raw) } }).then(function (d) {
          if (d && d.ok) self.reload(); else alert((d && d.message) || 'Failed');
        });
        return;
      }
      var editFolderBtn = e.target.closest('[data-gpg-edit-folder]');
      if (editFolderBtn) {
        var fid2 = editFolderBtn.getAttribute('data-gpg-edit-folder');
        var current = flatFolders(self.folders || []).find(function (f) { return f.id === fid2; });
        var newName = prompt('Rename folder:', current ? current.name : ''); if (!newName) return;
        self._req('/folders/' + encodeURIComponent(fid2), { method: 'PUT', body: { name: newName } }).then(function (d) {
          if (d && d.ok) self.reload(); else alert((d && d.message) || 'Failed');
        });
        return;
      }
      var delFolderBtn = e.target.closest('[data-gpg-delete-folder]');
      if (delFolderBtn) {
        var fid3 = delFolderBtn.getAttribute('data-gpg-delete-folder');
        if (!confirm('Delete this folder and all its guides?')) return;
        self._req('/folders/' + encodeURIComponent(fid3), { method: 'DELETE' }).then(function (d) {
          if (d && d.ok) { self.selectedId = null; self.reload(); } else alert((d && d.message) || 'Failed');
        });
        return;
      }
      var editItemBtn = e.target.closest('[data-gpg-edit-item]');
      if (editItemBtn) {
        var iid = editItemBtn.getAttribute('data-gpg-edit-item');
        var currentItem = findItem(self.folders || [], iid);
        var newTitle = prompt('Guide title:', currentItem ? currentItem.title : ''); if (!newTitle) return;
        var rawEmbed = prompt('Paste Scribe embed code:', currentItem ? currentItem.scribe_url : ''); if (!rawEmbed) return;
        self._req('/items/' + encodeURIComponent(iid), { method: 'PUT', body: { title: newTitle, scribe_url: parseScribeEmbed(rawEmbed) } }).then(function (d) {
          if (d && d.ok) self.reload(); else alert((d && d.message) || 'Failed');
        });
        return;
      }
      var delItemBtn = e.target.closest('[data-gpg-delete-item]');
      if (delItemBtn) {
        var iid2 = delItemBtn.getAttribute('data-gpg-delete-item');
        if (!confirm('Delete this guide?')) return;
        self._req('/items/' + encodeURIComponent(iid2), { method: 'DELETE' }).then(function (d) {
          if (d && d.ok) { if (self.selectedId === iid2) self.selectedId = null; self.reload(); } else alert((d && d.message) || 'Failed');
        });
        return;
      }
    });
  };

  // Drag-to-reorder — top-level folders only (mirrors admin.html behaviour).
  Instance.prototype.bindDrag = function () {
    var self = this;
    var el = this.el;
    el.addEventListener('dragstart', function (e) {
      if (!self.canEdit) return;
      var folder = e.target.closest('[data-gpg-folder-drag]');
      if (!folder) return;
      self.dragId = folder.getAttribute('data-gpg-folder-drag');
      folder.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', self.dragId); } catch (err) { /* ignore */ }
    });
    el.addEventListener('dragend', function (e) {
      var folder = e.target.closest('[data-gpg-folder-drag]');
      if (folder) folder.classList.remove('dragging');
      el.querySelectorAll('.gpg-folder').forEach(function (n) { n.classList.remove('drag-over-above', 'drag-over-below'); });
      self.dragId = null;
    });
    el.addEventListener('dragover', function (e) {
      if (!self.canEdit || !self.dragId) return;
      var folder = e.target.closest('[data-gpg-folder-drag]');
      if (!folder || folder.getAttribute('data-gpg-folder-drag') === self.dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      var rect = folder.getBoundingClientRect();
      var midY = rect.top + rect.height / 2;
      folder.classList.toggle('drag-over-above', e.clientY < midY);
      folder.classList.toggle('drag-over-below', e.clientY >= midY);
    });
    el.addEventListener('dragleave', function (e) {
      var folder = e.target.closest('[data-gpg-folder-drag]');
      if (folder) folder.classList.remove('drag-over-above', 'drag-over-below');
    });
    el.addEventListener('drop', function (e) {
      if (!self.canEdit || !self.dragId) return;
      var folder = e.target.closest('[data-gpg-folder-drag]');
      if (!folder) return;
      var targetId = folder.getAttribute('data-gpg-folder-drag');
      if (targetId === self.dragId) return;
      e.preventDefault();
      var rect = folder.getBoundingClientRect();
      var above = e.clientY < rect.top + rect.height / 2;
      var top = self.folders || [];
      var dragIdx = top.findIndex(function (f) { return f.id === self.dragId; });
      var targetIdx = top.findIndex(function (f) { return f.id === targetId; });
      if (dragIdx === -1 || targetIdx === -1) return; // only top-level folders reorder
      var moved = top.splice(dragIdx, 1)[0];
      var insertIdx = top.findIndex(function (f) { return f.id === targetId; });
      if (!above) insertIdx++;
      top.splice(insertIdx, 0, moved);
      self.folders = top;
      self.render();
      var order = top.map(function (f, i) { return { id: f.id, sort_order: i }; });
      self._req('/folders/reorder', { method: 'PUT', body: { order: order } }).then(function (d) {
        if (!d || !d.ok) alert('Failed to save order');
      });
      self.dragId = null;
    });
  };

  function mount(container, opts) {
    if (typeof container === 'string') {
      container = document.getElementById(container) || document.querySelector(container);
    }
    if (!container) { console.error('[GuidePanel] mount target not found'); return null; }
    injectStyles();
    var inst = new Instance(container, opts);
    inst.bindClicks();
    inst.bindDrag();
    container.innerHTML = '<div class="gpg-empty" style="padding:48px">Loading…</div>';
    inst.load().then(function () { inst.render(); });
    return inst;
  }

  window.GuidePanel = { mount: mount };
})();
