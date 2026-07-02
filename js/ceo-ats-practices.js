/* ============================================================================
 * ceo-ats-practices.js — Practices tab for the in-app ATS.
 * Classic <script> (NOT a module). Loaded by pages/ceo-dashboard.html after the
 * inline script and after /js/ceo-ats-shared.js (window.ATS).
 * Renders into #panel-practices. Modals/overlays go through ATS.setOverlay.
 * Exposes: window.loadPracticesTab().
 * Calls (at click-time) cross-module globals: window.atsOpenJobBoard(jobId),
 * window.atsOpenCandidate(userId), ATS.showMaster(name).
 * ========================================================================== */
(function () {
  'use strict';

  var ATS = window.ATS;

  // Pipeline stage -> pill colour class (matches the board mapping).
  var STAGE_PILL = {
    applied: 'blue',
    submitted: 'purple',
    reviewing: 'amber',
    interview: 'blue',
    offer: 'green',
    hired: 'green',
    not_proceeding: 'red'
  };
  var STAGE_LABEL = {
    applied: 'Applied',
    submitted: 'Submitted to Practice',
    reviewing: 'Practice Reviewing',
    interview: 'Interview',
    offer: 'Offer',
    hired: 'Hired',
    not_proceeding: 'Not Proceeding'
  };
  function stagePillClass(s) { return STAGE_PILL[s] || 'muted'; }
  function stageLabel(s) { return STAGE_LABEL[s] || s || '—'; }

  var currentQuery = '';     // active directory search term
  var currentPractice = null; // last-loaded practice detail (for the edit modal)
  var searchTimer = null;
  var bound = false;

  // -------------------- tiny DOM helpers --------------------
  function panelEl() { return document.getElementById('panel-practices'); }
  function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
  function hasKeys(o) { for (var k in o) { if (o.hasOwnProperty(k)) return true; } return false; }
  function updateCount(d) {
    var el = document.getElementById('masterPracCount');
    if (el && d && d.ok && d.total != null) el.textContent = d.total;
  }

  // -------------------- data --------------------
  function fetchPractices(q) {
    var path = '/api/ats/practices';
    if (q) path += '?q=' + encodeURIComponent(q);
    return ATS.api(path);
  }

  // ==================== DIRECTORY ====================
  function loadPracticesTab() {
    var panel = panelEl();
    if (!panel) return;
    ensureDelegation();
    currentQuery = '';
    panel.innerHTML = ATS.loadingHtml('Loading practices…');
    fetchPractices(currentQuery).then(function (d) {
      renderDirectory(panel, d || {});
    });
  }

  function practiceCardsHtml(list) {
    if (!list || !list.length) {
      return '<div class="ats-empty" style="padding:40px">No practices match your search.</div>';
    }
    return list.map(function (p) {
      var name = p.name || '—';
      return '<div class="ats-practice-card" data-ats="open-practice" data-id="' + ATS.escAttr(p.id) + '">' +
        '<div class="pc-top">' +
          '<div class="ats-practice-logo" style="background:' + ATS.avatarColor(name) + '">' + ATS.esc(ATS.initials(name)) + '</div>' +
          '<div><h3>' + ATS.esc(name) + '</h3><div class="pc-loc">📍 ' + ATS.esc(p.city || '—') + ', ' + ATS.esc(p.state || '') + '</div></div>' +
        '</div>' +
        '<div class="pc-loc" style="margin-bottom:4px">' + ATS.esc(p.type || '—') + '</div>' +
        '<div class="ats-pc-stats">' +
          '<div class="ats-pc-stat"><div class="s-val">' + (p.job_count != null ? p.job_count : 0) + '</div><div class="s-lbl">Jobs</div></div>' +
          '<div class="ats-pc-stat"><div class="s-val">' + (p.candidate_count != null ? p.candidate_count : 0) + '</div><div class="s-lbl">In pipeline</div></div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function renderDirectory(panel, d) {
    var practices = (d && d.practices) || [];
    panel.innerHTML =
      '<div class="ats-section-head">' +
        '<div><h2>Practices</h2><p>Clinics &amp; hospitals as real records — their jobs, contacts &amp; candidates in one place.</p></div>' +
        '<button class="ats-btn ats-btn-primary" data-ats="add-practice">＋ Add practice</button>' +
      '</div>' +
      '<div class="ats-toolbar">' +
        '<div class="ats-search">' +
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ats-dim)" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>' +
          '<input type="text" id="atsPracSearch" placeholder="Search practices…" value="' + ATS.escAttr(currentQuery) + '" />' +
        '</div>' +
      '</div>' +
      '<div class="ats-practice-list" id="atsPracticeList">' + practiceCardsHtml(practices) + '</div>' +
      '<div id="atsTeamSection" style="margin-top:26px"></div>';
    updateCount(d);
    loadTeamSection();
  }

  // ==================== TEAM ACCESS (super-admin only) ====================
  // Rendered below the practice directory. The server is the gate: GET
  // /api/ats/consultants is requireCeoSession, so a consultant's fetch comes
  // back !ok and the section simply never appears (client role check is only
  // a shortcut to avoid the doomed request).
  function loadTeamSection() {
    var host = document.getElementById('atsTeamSection');
    if (!host) return;
    if (ATS.isConsultant && ATS.isConsultant()) return;
    ATS.api('/api/ats/consultants').then(function (d) {
      var section = document.getElementById('atsTeamSection');
      if (!section) return; // panel re-rendered while fetching
      if (!d || !d.ok || !Array.isArray(d.consultants)) return; // 403 (not CEO) → stay hidden
      renderTeamSection(section, d.consultants);
    });
  }

  function teamRowHtml(c) {
    var display = c.name || c.email || '—';
    var sourceChip = c.source === 'env'
      ? '<span class="ats-pill muted" title="Set in the CONSULTANT_EMAILS environment variable — remove it there">Server config</span>'
      : '<span class="ats-pill blue">Invited</span>';
    var removeBtn = c.source === 'kv'
      ? '<button class="ats-btn ats-btn-ghost ats-btn-sm" data-ats="remove-consultant" data-email="' + ATS.escAttr(c.email) + '">Remove</button>'
      : '';
    return '<div class="ats-mini-job">' +
      '<div style="display:flex;align-items:center;gap:10px">' +
        '<div class="ats-avatar" style="background:' + ATS.avatarColor(display) + '">' + ATS.esc(ATS.initials(display)) + '</div>' +
        '<div><div class="mj-title">' + ATS.esc(display) + '</div>' +
        '<div class="mj-sub">' + ATS.esc(c.email || '') + '</div></div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px">' + sourceChip + removeBtn + '</div>' +
    '</div>';
  }

  function renderTeamSection(host, consultants) {
    var rows = (consultants && consultants.length)
      ? consultants.map(teamRowHtml).join('')
      : '<div class="ats-empty">No consultants yet — invite your first team member below.</div>';
    host.innerHTML =
      '<div class="ats-card">' +
        '<div class="ats-card-title"><span class="ats-dot" style="background:var(--ats-green)"></span> Team access</div>' +
        '<p style="font-size:12px;color:var(--ats-dim);margin:0 0 12px">Consultants can sign in to this dashboard and run the ATS — candidates, jobs, practices and meetings. They can\'t see the Registration side or manage the team.</p>' +
        rows +
        '<div class="ats-form-row" style="margin-top:14px">' +
          '<div><label>Name</label><input type="text" id="atsTeamName" placeholder="e.g. Sam Recruiter" /></div>' +
          '<div><label>Email</label><input type="text" id="atsTeamEmail" placeholder="sam@mygplink.com.au" /></div>' +
        '</div>' +
        '<div style="display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:10px">' +
          '<span id="atsTeamMsg" style="font-size:12px;color:var(--ats-dim)"></span>' +
          '<button class="ats-btn ats-btn-primary ats-btn-sm" data-ats="invite-consultant">Send invite</button>' +
        '</div>' +
      '</div>';
  }

  function teamMsg(text) {
    var el = document.getElementById('atsTeamMsg');
    if (el) el.textContent = text || '';
  }

  function inviteConsultant(btn) {
    var name = (document.getElementById('atsTeamName') || {}).value || '';
    var email = ((document.getElementById('atsTeamEmail') || {}).value || '').trim();
    if (!email) { teamMsg('Enter an email address.'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    teamMsg('');
    ATS.api('/api/ats/consultants', { method: 'POST', body: { name: name.trim(), email: email } }).then(function (d) {
      if (btn) { btn.disabled = false; btn.textContent = 'Send invite'; }
      if (!d || !d.ok) { teamMsg((d && d.message) || 'Could not add the consultant.'); return; }
      if (d.already) { ATS.toast('Already a consultant — nothing to do.'); }
      else if (d.invite_sent) { ATS.toast('Invite sent to ' + email); }
      else { ATS.toast('Consultant added. Invite email could not be sent — ask them to use "Forgot password" on the sign-in page.'); }
      loadTeamSection();
    });
  }

  function removeConsultant(email, btn) {
    if (!email) return;
    if (!window.confirm('Remove ' + email + ' from the ATS team? They\'ll lose access to this dashboard (their sign-in account is kept).')) return;
    if (btn) btn.disabled = true;
    ATS.api('/api/ats/consultants?email=' + encodeURIComponent(email), { method: 'DELETE' }).then(function (d) {
      if (!d || !d.ok) {
        if (btn) btn.disabled = false;
        teamMsg((d && d.message) || 'Could not remove the consultant.');
        return;
      }
      ATS.toast('Consultant removed');
      loadTeamSection();
    });
  }

  // Search re-fetches with ?q= and updates ONLY the list (keeps input focus).
  function onSearchInput(value) {
    currentQuery = value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      var q = currentQuery;
      fetchPractices(q).then(function (d) {
        if (q !== currentQuery) return; // a newer keystroke superseded this one
        var list = document.getElementById('atsPracticeList');
        if (list) list.innerHTML = practiceCardsHtml((d && d.practices) || []);
        updateCount(d || {});
      });
    }, 220);
  }

  // ==================== DETAIL ====================
  function openPractice(id) {
    var panel = panelEl();
    if (!panel) return;
    ensureDelegation();
    panel.innerHTML = ATS.loadingHtml('Loading practice…');
    ATS.api('/api/ats/practice?id=' + encodeURIComponent(id)).then(function (d) {
      if (!d || !d.ok || !d.practice) {
        panel.innerHTML =
          '<div class="ats-board-head"><button class="ats-back-btn" data-ats="back-list">‹ All practices</button></div>' +
          ATS.emptyHtml('Practice not found.');
        return;
      }
      currentPractice = d.practice;
      renderDetail(panel, d);
    });
  }

  function detailField(label, value) {
    return '<div class="ats-detail-field"><div class="df-lbl">' + ATS.esc(label) +
      '</div><div class="df-val">' + ATS.esc(value || '—') + '</div></div>';
  }

  function renderDetail(panel, d) {
    var p = d.practice || {};
    var jobs = d.jobs || [];
    var cands = d.candidates || [];
    var name = p.name || '—';

    var loc = '📍 ' + ATS.esc(p.location_city || '—') + ', ' + ATS.esc(p.location_state || '');
    if (p.practice_type) loc += ' · ' + ATS.esc(p.practice_type);

    var fields =
      detailField('Primary contact', p.contact_name) +
      detailField('Email', p.contact_email) +
      detailField('Phone', p.contact_phone) +
      detailField('Practice type', p.practice_type) +
      detailField('AHPRA / reg no.', p.ahpra_number);

    var jobsHtml = jobs.length ? jobs.map(function (j) {
      return '<div class="ats-mini-job" data-ats="open-job" data-id="' + ATS.escAttr(j.id) + '">' +
        '<div><div class="mj-title">' + ATS.esc(j.title || '—') + '</div>' +
        '<div class="mj-sub">' + ATS.esc(j.city || '—') + ', ' + ATS.esc(j.state || '') + ' · ' + ATS.esc(j.type || '') + '</div></div>' +
        '<span class="ats-cand-count"><b>' + (j.active_count != null ? j.active_count : 0) + '</b> in pipeline ›</span>' +
      '</div>';
    }).join('') : '<div class="ats-empty">No jobs yet.</div>';

    var candsHtml = cands.length ? cands.map(function (c) {
      var cn = c.name || '—';
      return '<div class="ats-mini-job" data-ats="open-cand" data-id="' + ATS.escAttr(c.user_id) + '">' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<div class="ats-avatar" style="background:' + ATS.avatarColor(cn) + '">' + ATS.esc(ATS.initials(cn)) + '</div>' +
          '<div><div class="mj-title">' + ATS.esc(cn) + '</div>' +
          '<div class="mj-sub">' + ATS.countryLabel(c.country) + ' · ' + ATS.esc(c.job_title || '—') + '</div></div>' +
        '</div>' +
        '<span class="ats-pill ' + stagePillClass(c.ats_stage) + '">' + ATS.esc(stageLabel(c.ats_stage)) + '</span>' +
      '</div>';
    }).join('') : '<div class="ats-empty">No candidates yet.</div>';

    panel.innerHTML =
      '<div class="ats-board-head"><button class="ats-back-btn" data-ats="back-list">‹ All practices</button></div>' +
      '<div class="ats-section-head" style="margin-bottom:16px">' +
        '<div style="display:flex;align-items:center;gap:14px">' +
          '<div class="ats-practice-logo" style="background:' + ATS.avatarColor(name) + '">' + ATS.esc(ATS.initials(name)) + '</div>' +
          '<div><h2>' + ATS.esc(name) + '</h2><p>' + loc + '</p></div>' +
        '</div>' +
        '<button class="ats-btn ats-btn-ghost ats-btn-sm" data-ats="edit-practice">✎ Edit</button>' +
      '</div>' +
      '<div class="ats-detail-grid">' +
        '<div class="ats-card">' + fields + '</div>' +
        '<div>' +
          '<div class="ats-card" style="margin-bottom:16px">' +
            '<div class="ats-card-title"><span class="ats-dot" style="background:var(--ats-blue)"></span> Jobs at this practice</div>' +
            jobsHtml +
          '</div>' +
          '<div class="ats-card">' +
            '<div class="ats-card-title"><span class="ats-dot" style="background:var(--ats-purple)"></span> Candidates in pipeline</div>' +
            candsHtml +
          '</div>' +
        '</div>' +
      '</div>';

    if (window.scrollTo) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ==================== MODALS (add / edit) ====================
  var AU_STATES = ['QLD', 'NSW', 'VIC', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
  function stateSelect(id, selected) {
    var sel = selected || 'QLD';
    return '<select id="' + id + '">' + AU_STATES.map(function (s) {
      return '<option' + (s === sel ? ' selected' : '') + '>' + s + '</option>';
    }).join('') + '</select>';
  }

  function ivAttr(x) { return x ? ' value="' + ATS.escAttr(x) + '"' : ''; }

  // opts: { title, btn, action ('create-practice'|'save-practice'), vals }
  function practiceModalHtml(opts) {
    var v = opts.vals || {};
    return '<div class="ats-modal-wrap open" data-ats="modal-backdrop">' +
      '<div class="ats-modal">' +
        '<div class="ats-modal-head"><h3>' + ATS.esc(opts.title) + '</h3><button class="ats-drawer-close" data-ats="close-modal">×</button></div>' +
        '<div class="ats-modal-body">' +
          '<label>Practice name</label>' +
          '<input type="text" id="atsFName" placeholder="e.g. Greenslopes Family Medical"' + ivAttr(v.name) + ' />' +
          '<div class="ats-form-row">' +
            '<div><label>City</label><input type="text" id="atsFCity" placeholder="Brisbane"' + ivAttr(v.city) + ' /></div>' +
            '<div><label>State</label>' + stateSelect('atsFState', v.state) + '</div>' +
          '</div>' +
          '<label>Type</label>' +
          '<input type="text" id="atsFType" placeholder="e.g. GP Clinic — Mixed billing"' + ivAttr(v.type) + ' />' +
          '<div class="ats-form-row">' +
            '<div><label>Contact name</label><input type="text" id="atsFContact" placeholder="Dr. Helen Carter"' + ivAttr(v.contact) + ' /></div>' +
            '<div><label>Contact email</label><input type="text" id="atsFEmail" placeholder="admin@practice.com.au"' + ivAttr(v.email) + ' /></div>' +
          '</div>' +
          '<div class="ats-form-row">' +
            '<div><label>Phone</label><input type="text" id="atsFPhone" placeholder="07 0000 0000"' + ivAttr(v.phone) + ' /></div>' +
            '<div><label>AHPRA / reg no.</label><input type="text" id="atsFAhpra" placeholder="PRA-QLD-00000"' + ivAttr(v.ahpra) + ' /></div>' +
          '</div>' +
        '</div>' +
        '<div class="ats-modal-foot">' +
          '<button class="ats-btn ats-btn-ghost" data-ats="close-modal">Cancel</button>' +
          '<button class="ats-btn ats-btn-primary" data-ats="' + opts.action + '">' + ATS.esc(opts.btn) + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function readForm() {
    return {
      name: val('atsFName').trim(),
      city: val('atsFCity').trim(),
      state: val('atsFState'),
      type: val('atsFType').trim(),
      contact: val('atsFContact').trim(),
      email: val('atsFEmail').trim(),
      phone: val('atsFPhone').trim(),
      ahpra: val('atsFAhpra').trim()
    };
  }

  function closeModal() { ATS.setOverlay(''); }

  function openAddModal() {
    ATS.setOverlay(practiceModalHtml({
      title: 'Add a practice', btn: 'Create practice', action: 'create-practice', vals: {}
    }));
  }

  function openEditModal() {
    var p = currentPractice;
    if (!p) return;
    ATS.setOverlay(practiceModalHtml({
      title: 'Edit practice', btn: 'Save changes', action: 'save-practice',
      vals: {
        name: p.name, city: p.location_city, state: p.location_state, type: p.practice_type,
        contact: p.contact_name, email: p.contact_email, phone: p.contact_phone, ahpra: p.ahpra_number
      }
    }));
  }

  function createPractice() {
    var body = readForm();
    if (!body.name) { ATS.toast('Enter a practice name'); return; }
    ATS.api('/api/ats/practices', { method: 'POST', body: body }).then(function (d) {
      if (!d || !d.ok) { ATS.toast((d && d.message) || 'Could not create practice'); return; }
      closeModal();
      ATS.toast('Practice created');
      loadPracticesTab();
    });
  }

  function savePractice() {
    var p = currentPractice;
    if (!p) { closeModal(); return; }
    var cur = readForm();
    if (!cur.name) { ATS.toast('Enter a practice name'); return; }
    var orig = {
      name: p.name, city: p.location_city, state: p.location_state, type: p.practice_type,
      contact: p.contact_name, email: p.contact_email, phone: p.contact_phone, ahpra: p.ahpra_number
    };
    var keys = ['name', 'city', 'state', 'type', 'contact', 'email', 'phone', 'ahpra'];
    var body = {};
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var o = orig[k] == null ? '' : String(orig[k]);
      if (cur[k] !== o) body[k] = cur[k];
    }
    if (!hasKeys(body)) { closeModal(); openPractice(p.id); return; }
    ATS.api('/api/ats/practice?id=' + encodeURIComponent(p.id), { method: 'PATCH', body: body }).then(function (d) {
      if (!d || !d.ok) { ATS.toast((d && d.message) || 'Could not update practice'); return; }
      closeModal();
      ATS.toast('Practice updated');
      openPractice(p.id);
    });
  }

  // ==================== event delegation ====================
  function onPanelClick(e) {
    var t = e.target.closest ? e.target.closest('[data-ats]') : null;
    if (!t) return;
    var action = t.getAttribute('data-ats');
    var id = t.getAttribute('data-id');
    if (action === 'open-practice') openPractice(id);
    else if (action === 'add-practice') openAddModal();
    else if (action === 'back-list') loadPracticesTab();
    else if (action === 'edit-practice') openEditModal();
    else if (action === 'invite-consultant') inviteConsultant(t);
    else if (action === 'remove-consultant') removeConsultant(t.getAttribute('data-email'), t);
    else if (action === 'open-job') {
      ATS.showMaster('jobs');
      if (typeof window.atsOpenJobBoard === 'function') window.atsOpenJobBoard(id);
    } else if (action === 'open-cand') {
      ATS.showMaster('candidates');
      if (typeof window.atsOpenCandidate === 'function') window.atsOpenCandidate(id);
    }
  }

  function onPanelInput(e) {
    if (e.target && e.target.id === 'atsPracSearch') onSearchInput(e.target.value);
  }

  function onOverlayClick(e) {
    var t = e.target;
    // Click directly on the dimmed backdrop closes the modal.
    if (t && t.getAttribute && t.getAttribute('data-ats') === 'modal-backdrop') { closeModal(); return; }
    var btn = t.closest ? t.closest('[data-ats]') : null;
    if (!btn) return;
    var action = btn.getAttribute('data-ats');
    if (action === 'close-modal') closeModal();
    else if (action === 'create-practice') createPractice();
    else if (action === 'save-practice') savePractice();
  }

  function ensureDelegation() {
    if (bound) return;
    var panel = panelEl();
    if (!panel) return; // bind later, once the panel exists
    bound = true;
    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('input', onPanelInput);
    var overlay = document.getElementById('atsOverlayRoot');
    if (overlay) overlay.addEventListener('click', onOverlayClick);
  }

  // -------------------- exports --------------------
  window.loadPracticesTab = loadPracticesTab;
  window.atsOpenPractice = openPractice;

  ensureDelegation();
})();
