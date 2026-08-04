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

  // Practice-lifecycle stage (distinct from the candidate pipeline stage above).
  var PRACTICE_STAGES = ['prospective', 'active', 'declined', 'archived'];
  function practiceStageLabel(s) { return s ? (s.charAt(0).toUpperCase() + s.slice(1)) : '—'; }
  function agreementPillClass(s) { return s === 'signed' ? 'green' : s === 'sent' ? 'amber' : 'muted'; }
  function agreementLabel(s) {
    return s === 'signed' ? 'Agreement signed' : s === 'sent' ? 'Agreement sent' : 'Agreement unsigned';
  }
  // Small "Corporation" chip shown wherever an org is a corporation (cards +
  // detail header). Regular practices get no chip at all.
  function corpBadge(p, style) {
    if (!p || p.org_type !== 'corporation') return '';
    return '<span class="ats-pill purple"' + (style ? ' style="' + ATS.escAttr(style) + '"' : '') + '>Corporation</span>';
  }

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
    // SWR: paint the cached directory instantly, then repaint from the network.
    ATS.swr('/api/ats/practices', function (d) {
      renderDirectory(panel, d || {});
    });
  }

  // "Part of <Corporation>" line on a member practice's card. Plain text (no
  // data-ats) so clicking it still opens the practice card it sits on.
  function partOfLineHtml(p) {
    if (!p || !p.parent_corporation_name) return '';
    return '<div class="pc-loc" style="margin-bottom:4px">🏢 Part of ' + ATS.esc(p.parent_corporation_name) + '</div>';
  }

  function practiceCardHtml(p) {
    var name = p.name || '—';
    return '<div class="ats-practice-card" data-ats="open-practice" data-id="' + ATS.escAttr(p.id) + '">' +
      '<div class="pc-top">' +
        '<div class="ats-practice-logo" style="background:' + ATS.avatarColor(name) + '">' + ATS.esc(ATS.initials(name)) + '</div>' +
        '<div><h3>' + ATS.esc(name) + corpBadge(p, 'margin-left:6px;vertical-align:middle') + '</h3><div class="pc-loc">📍 ' + ATS.esc(p.city || '—') + ', ' + ATS.esc(p.state || '') + '</div></div>' +
      '</div>' +
      '<div class="pc-loc" style="margin-bottom:4px">' + ATS.esc(p.type || '—') + '</div>' +
      partOfLineHtml(p) +
      '<div class="ats-pc-stats">' +
        '<div class="ats-pc-stat"><div class="s-val">' + (p.job_count != null ? p.job_count : 0) + '</div><div class="s-lbl">Jobs</div></div>' +
        '<div class="ats-pc-stat"><div class="s-val">' + (p.candidate_count != null ? p.candidate_count : 0) + '</div><div class="s-lbl">In pipeline</div></div>' +
      '</div>' +
    '</div>';
  }

  function practiceCardsHtml(list) {
    if (!list || !list.length) {
      return '<div class="ats-empty" style="padding:40px">No practices match your search.</div>';
    }
    return list.map(practiceCardHtml).join('');
  }

  // Potential-client (prospective) cards surface intake/agreement progress and
  // two quick actions (Call the contact, resend the intake email) instead of
  // the job/candidate stats a mainstream practice card shows.
  function prospectiveCardHtml(p) {
    var name = p.name || '—';
    var phone = p.phone || '';
    var callBtn = phone
      ? '<a class="ats-btn ats-btn-ghost ats-btn-sm" data-ats="call-tel" href="tel:' + ATS.escAttr(phone.replace(/[^\d+]/g, '')) + '">📞 Call</a>'
      : '<span class="ats-btn ats-btn-ghost ats-btn-sm" data-ats="call-noop" style="opacity:.45;cursor:default" title="No phone number on file">📞 Call</span>';
    var sourceChip = p.source === 'facebook_lead' ? '<span class="ats-pill blue">Facebook lead</span>' : '';
    var contactBits = [p.contact, p.email, p.phone].filter(Boolean).map(function (s) { return ATS.esc(s); });
    return '<div class="ats-practice-card" data-ats="open-practice" data-id="' + ATS.escAttr(p.id) + '">' +
      '<div class="pc-top">' +
        '<div class="ats-practice-logo" style="background:' + ATS.avatarColor(name) + '">' + ATS.esc(ATS.initials(name)) + '</div>' +
        '<div><h3>' + ATS.esc(name) + '</h3><div class="pc-loc">📍 ' + ATS.esc(p.city || '—') + ', ' + ATS.esc(p.state || '') + '</div></div>' +
      '</div>' +
      '<div class="pc-loc" style="margin-bottom:8px">' + (contactBits.length ? contactBits.join(' · ') : '—') + '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">' +
        corpBadge(p) + sourceChip + '<span class="ats-pill ' + agreementPillClass(p.agreement_status) + '">' + agreementLabel(p.agreement_status) + '</span>' +
      '</div>' +
      '<div style="display:flex;gap:8px;padding-top:13px;border-top:1px solid var(--ats-border)">' +
        callBtn +
        '<button class="ats-btn ats-btn-primary ats-btn-sm" data-ats="resend-intake" data-id="' + ATS.escAttr(p.id) + '">Resend intake email</button>' +
      '</div>' +
    '</div>';
  }

  // Splits the full practice list into the three directory sections. Used both
  // for the initial load and for live search re-renders (both target the same
  // #atsPracticeList container so a single helper keeps them in sync).
  function practiceSectionsHtml(list) {
    list = list || [];
    var prospective = list.filter(function (p) { return p.stage === 'prospective'; });
    var archived = list.filter(function (p) { return p.stage === 'declined' || p.stage === 'archived'; });
    var mainstream = list.filter(function (p) { return p.stage !== 'prospective' && p.stage !== 'declined' && p.stage !== 'archived'; });

    var html = '';
    if (prospective.length) {
      html +=
        '<div class="ats-section-head" style="margin-bottom:14px">' +
          '<div><h2>Potential Clients <span class="ats-pill blue" style="margin-left:6px">' + prospective.length + '</span></h2>' +
          '<p>Leads mid-pipeline — intake, agreement &amp; onboarding.</p></div>' +
        '</div>' +
        '<div class="ats-practice-list" style="margin-bottom:28px">' + prospective.map(prospectiveCardHtml).join('') + '</div>';
    }
    html +=
      '<div class="ats-section-head" style="margin-bottom:14px">' +
        '<div><h2>Mainstream Practices</h2><p>Active client practices — their jobs, contacts &amp; candidates.</p></div>' +
      '</div>' +
      '<div class="ats-practice-list">' + practiceCardsHtml(mainstream) + '</div>';
    if (archived.length) {
      html +=
        '<details style="margin-top:24px">' +
          '<summary style="cursor:pointer;color:var(--ats-dim);font-size:13px;font-weight:500">Archived &amp; declined (' + archived.length + ')</summary>' +
          '<div class="ats-practice-list" style="margin-top:14px">' + practiceCardsHtml(archived) + '</div>' +
        '</details>';
    }
    return html;
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
      '<div id="atsPracticeList">' + practiceSectionsHtml(practices) + '</div>' +
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
        if (list) list.innerHTML = practiceSectionsHtml((d && d.practices) || []);
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

  // Same as detailField but the value is trusted HTML (a <select>, a link) —
  // callers are responsible for escaping any dynamic text inside it.
  function detailFieldHtml(label, html) {
    return '<div class="ats-detail-field"><div class="df-lbl">' + ATS.esc(label) +
      '</div><div class="df-val">' + html + '</div></div>';
  }

  // -------------------- secondary contacts --------------------
  // Extra people at the practice who are CC'd on ONE email: the introduction
  // sent when a candidate is first presented/matched to them. The primary
  // contact is the "To" and gets every practice email; secondary contacts are
  // copied on that first introduction and nothing after it. The explainer line
  // is deliberately shown next to the list, not buried in a tooltip — it is
  // the whole reason the field behaves differently from the primary contact.
  var SECONDARY_CC_NOTE = 'CC’d on the first introduction when a candidate is presented or matched — not on later emails.';

  function normalizeSecondaryList(list) {
    return (Array.isArray(list) ? list : []).map(function (c) {
      return {
        name: String((c && c.name) || '').trim(),
        email: String((c && c.email) || '').trim()
      };
    }).filter(function (c) { return c.email; });
  }

  function secondaryContactsFieldHtml(p) {
    var list = normalizeSecondaryList(p && p.secondary_contacts);
    var body = list.length
      ? list.map(function (c) {
        return '<div style="margin-bottom:4px">' + ATS.esc(c.email) +
          (c.name ? ' <span style="color:var(--ats-dim)">· ' + ATS.esc(c.name) + '</span>' : '') +
        '</div>';
      }).join('')
      : '<div style="color:var(--ats-dim)">—</div>';
    return '<div class="ats-detail-field">' +
      '<div class="df-lbl">Secondary contacts' + (list.length ? ' (' + list.length + ')' : '') + '</div>' +
      '<div class="df-val">' + body +
        '<div style="font-size:11.5px;color:var(--ats-dim);margin-top:6px;font-weight:400">' + ATS.esc(SECONDARY_CC_NOTE) + '</div>' +
      '</div>' +
    '</div>';
  }

  function resendIntake(id, btn) {
    if (!id) return;
    var origLabel = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    ATS.api('/api/ats/practice/resend-intake?id=' + encodeURIComponent(id), { method: 'POST' }).then(function (d) {
      if (btn) { btn.disabled = false; btn.textContent = origLabel; }
      if (!d || !d.ok) { ATS.toast((d && d.message) || 'Could not resend the intake email'); return; }
      ATS.toast('Intake email sent');
    });
  }

  function onStageChange(stage) {
    var p = currentPractice;
    if (!p) return;
    ATS.api('/api/ats/practice?id=' + encodeURIComponent(p.id), { method: 'PATCH', body: { stage: stage } }).then(function (d) {
      if (!d || !d.ok) { ATS.toast((d && d.message) || 'Could not update the stage'); return; }
      ATS.toast('Stage updated');
      openPractice(p.id);
    });
  }

  // -------------------- agreement / contract card --------------------
  // Always shown in the detail (practices AND corporations). Lists the
  // e-signed PDF and/or a manually uploaded one (e-signed first when both
  // exist), plus an always-available "Upload signed PDF" affordance.
  var UPLOAD_CONTRACT_LABEL = '⬆ Upload signed PDF';

  function contractCardHtml(p) {
    var rows = '';
    if (p.agreement_signed_pdf_url) {
      rows +=
        '<div class="ats-mini-job">' +
          '<div><div class="mj-title">Signed agreement (e-signed)</div>' +
          '<div class="mj-sub">Completed through the in-app e-sign flow</div></div>' +
          '<a class="ats-btn ats-btn-ghost ats-btn-sm" href="' + ATS.escAttr(p.agreement_signed_pdf_url) + '" target="_blank" rel="noopener noreferrer">View PDF</a>' +
        '</div>';
    }
    if (p.agreement_manual_pdf_url) {
      var meta = [];
      if (p.agreement_manual_uploaded_at) {
        var dt = new Date(p.agreement_manual_uploaded_at);
        meta.push('Uploaded ' + (isNaN(dt.getTime()) ? p.agreement_manual_uploaded_at : dt.toLocaleDateString()));
      }
      if (p.agreement_manual_uploaded_by) meta.push('by ' + p.agreement_manual_uploaded_by);
      rows +=
        '<div class="ats-mini-job">' +
          '<div><div class="mj-title">Signed agreement (uploaded)</div>' +
          '<div class="mj-sub">' + ATS.esc(meta.length ? meta.join(' ') : 'Manually uploaded PDF') + '</div></div>' +
          '<a class="ats-btn ats-btn-ghost ats-btn-sm" href="' + ATS.escAttr(p.agreement_manual_pdf_url) + '" target="_blank" rel="noopener noreferrer">View PDF</a>' +
        '</div>';
    }
    if (!rows) rows = '<div class="ats-empty">No signed contract on file yet.</div>';
    return '<div class="ats-card" style="margin-top:16px">' +
      '<div class="ats-card-title" style="display:flex;align-items:center;gap:8px"><span class="ats-dot" style="background:var(--ats-green)"></span> Agreement &amp; contract' +
        '<span class="ats-pill ' + agreementPillClass(p.agreement_status) + '" style="margin-left:auto">' + ATS.esc(agreementLabel(p.agreement_status)) + '</span></div>' +
      rows +
      '<div style="display:flex;align-items:center;gap:10px;margin-top:12px;padding-top:12px;border-top:1px solid var(--ats-border)">' +
        '<input type="file" id="atsContractFile" accept="application/pdf" style="display:none" />' +
        '<button class="ats-btn ats-btn-ghost ats-btn-sm" data-ats="upload-contract">' + UPLOAD_CONTRACT_LABEL + '</button>' +
        '<span style="font-size:12px;color:var(--ats-dim)">PDF only · 10 MB max</span>' +
      '</div>' +
    '</div>';
  }

  function triggerContractUpload() {
    var input = document.getElementById('atsContractFile');
    if (input) input.click();
  }

  function uploadContract(input) {
    var p = currentPractice;
    var file = input && input.files && input.files[0];
    if (!p || !file) return;
    var isPdf = /pdf$/i.test(file.type || '') || /\.pdf$/i.test(file.name || '');
    if (!isPdf) { ATS.toast('The contract must be a PDF.'); input.value = ''; return; }
    if (file.size > 10 * 1024 * 1024) { ATS.toast('That PDF is too large (10 MB max).'); input.value = ''; return; }
    var panel = panelEl();
    var btn = panel ? panel.querySelector('[data-ats="upload-contract"]') : null;
    function setBusy(busy) {
      if (!btn) return;
      btn.disabled = busy;
      btn.textContent = busy ? 'Uploading…' : UPLOAD_CONTRACT_LABEL;
    }
    setBusy(true);
    var reader = new FileReader();
    reader.onerror = function () {
      setBusy(false);
      ATS.toast('Could not read that file — please try attaching it again.');
    };
    reader.onload = function () {
      ATS.api('/api/ats/practice/contract', {
        method: 'POST',
        body: { id: p.id, file_data: String(reader.result || ''), file_name: file.name || '' }
      }).then(function (d) {
        if (!d || !d.ok) {
          setBusy(false);
          if (input) input.value = '';
          ATS.toast((d && d.message) || 'Could not upload the contract — please try again.');
          return;
        }
        ATS.toast('Contract uploaded');
        openPractice(p.id); // re-fetch so the new row, timestamp + status pill render
      });
    };
    reader.readAsDataURL(file);
  }

  // Corporation-only rollup card: member practices under this group (each row
  // opens that practice) + the group aggregate. Data comes with the detail
  // payload (d.members / d.rollup) — no extra fetches.
  function rollupCardHtml(d) {
    var p = (d && d.practice) || {};
    if (p.org_type !== 'corporation') return '';
    var members = (d && d.members) || [];
    var roll = (d && d.rollup) || { member_count: members.length, total_jobs: 0 };
    var rows = members.length ? members.map(function (m) {
      return '<div class="ats-mini-job" data-ats="open-practice" data-id="' + ATS.escAttr(m.id) + '">' +
        '<div><div class="mj-title">' + ATS.esc(m.name || '—') + '</div>' +
        '<div class="mj-sub">' + ATS.esc(m.city || '—') + ', ' + ATS.esc(m.state || '') + ' · ' + ATS.esc(practiceStageLabel(m.stage)) + '</div></div>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<span class="ats-pill ' + agreementPillClass(m.agreement_status) + '">' + ATS.esc(agreementLabel(m.agreement_status)) + '</span>' +
          '<span class="ats-cand-count"><b>' + (m.job_count != null ? m.job_count : 0) + '</b> jobs ›</span>' +
        '</div>' +
      '</div>';
    }).join('') : '<div class="ats-empty">No member practices linked yet — edit a practice and set "Part of corporation".</div>';
    return '<div class="ats-card" style="margin-bottom:16px">' +
      '<div class="ats-card-title"><span class="ats-dot" style="background:var(--ats-purple)"></span> Group rollup</div>' +
      '<div class="ats-pc-stats" style="margin-bottom:12px">' +
        '<div class="ats-pc-stat"><div class="s-val">' + (roll.member_count != null ? roll.member_count : members.length) + '</div><div class="s-lbl">Member practices</div></div>' +
        '<div class="ats-pc-stat"><div class="s-val">' + (roll.total_jobs != null ? roll.total_jobs : 0) + '</div><div class="s-lbl">Live jobs (group)</div></div>' +
      '</div>' +
      rows +
    '</div>';
  }

  function renderDetail(panel, d) {
    var p = d.practice || {};
    var jobs = d.jobs || [];
    var cands = d.candidates || [];
    var name = p.name || '—';

    var loc = '📍 ' + ATS.esc(p.location_city || '—') + ', ' + ATS.esc(p.location_state || '');
    if (p.practice_type) loc += ' · ' + ATS.esc(p.practice_type);

    // "Part of <Corp>" chip next to the name — clicking it opens the parent
    // corporation (same open-practice delegation as the cards).
    var partOfChip = (p.parent_corporation_id && p.parent_corporation_name)
      ? '<span class="ats-pill muted" data-ats="open-practice" data-id="' + ATS.escAttr(p.parent_corporation_id) + '" style="margin-left:10px;vertical-align:middle;cursor:pointer">🏢 Part of ' + ATS.esc(p.parent_corporation_name) + '</span>'
      : '';

    var stageHtml = '<select id="atsStageSelect">' + PRACTICE_STAGES.map(function (s) {
      return '<option value="' + s + '"' + (s === (p.stage || 'active') ? ' selected' : '') + '>' + practiceStageLabel(s) + '</option>';
    }).join('') + '</select>';

    // Slim by design: everything operational (billing, DPA, address, role
    // details, intro media) lives on the JOB listings under this org — the
    // org record itself holds only contact + stage + the agreement/contract.
    var fields =
      detailField('Primary contact', p.contact_name) +
      detailField('Email', p.contact_email) +
      detailField('Phone', p.contact_phone) +
      secondaryContactsFieldHtml(p) +
      detailFieldHtml('Stage', stageHtml);

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
          '<div><h2>' + ATS.esc(name) + corpBadge(p, 'margin-left:10px;vertical-align:middle') + partOfChip + '</h2><p>' + loc + '</p></div>' +
        '</div>' +
        '<button class="ats-btn ats-btn-ghost ats-btn-sm" data-ats="edit-practice">✎ Edit</button>' +
      '</div>' +
      '<div class="ats-detail-grid">' +
        '<div><div class="ats-card">' + fields + '</div>' + contractCardHtml(p) + '</div>' +
        '<div>' +
          rollupCardHtml(d) +
          '<div class="ats-card" style="margin-bottom:16px">' +
            '<div class="ats-card-title"><span class="ats-dot" style="background:var(--ats-blue)"></span> Jobs at this practice</div>' +
            '<p style="font-size:12px;color:var(--ats-dim);margin:0 0 10px">Billing, DPA, address and role details live on each job.</p>' +
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
    // Default to a blank "— Select —" (NOT QLD) so a practice with no state on
    // file shows blank. Defaulting to QLD made the save-diff treat it as a user
    // edit and silently stamped QLD onto any stateless practice (e.g. an FB
    // lead) whenever the CEO edited any other field — silent geo corruption on
    // a masked jobs board where state matters.
    var sel = selected || '';
    return '<select id="' + id + '">' +
      '<option value=""' + (sel === '' ? ' selected' : '') + '>— Select —</option>' +
      AU_STATES.map(function (s) {
        return '<option' + (s === sel ? ' selected' : '') + '>' + s + '</option>';
      }).join('') + '</select>';
  }

  function ivAttr(x) { return x ? ' value="' + ATS.escAttr(x) + '"' : ''; }

  // Corporations available as a parent (for the modal dropdown) — fetched at
  // modal-open time from the same practices list the directory uses.
  function fetchCorporationChoices(excludeId) {
    return fetchPractices('').then(function (d) {
      var list = (d && d.practices) || [];
      return list.filter(function (p) {
        return p.org_type === 'corporation' && String(p.id) !== String(excludeId || '');
      }).map(function (p) { return { id: p.id, name: p.name }; });
    });
  }

  // Hidden while "Organisation type" is Corporation (a corporation has no
  // parent) — toggled live by onOverlayChange.
  function parentCorpSelectHtml(corps, v) {
    var opts = '<option value="">— None —</option>' + (corps || []).map(function (c) {
      return '<option value="' + ATS.escAttr(c.id) + '"' + (String(c.id) === String(v.parent_corporation_id || '') ? ' selected' : '') + '>' + ATS.esc(c.name || '—') + '</option>';
    }).join('');
    return '<div id="atsFParentCorpWrap"' + (v.org_type === 'corporation' ? ' style="display:none"' : '') + '>' +
      '<label>Part of corporation (optional)</label>' +
      '<select id="atsFParentCorp">' + opts + '</select>' +
    '</div>';
  }

  // One editable secondary-contact row. Values are read back by position via
  // data-sec-email/data-sec-name (NOT ids) — rows are added and removed
  // freely, so a fixed id per row would collide the moment one is deleted.
  function secondaryRowHtml(c) {
    var v = c || {};
    return '<div class="ats-sec-row" style="display:flex;gap:8px;align-items:center;margin-bottom:8px">' +
      // min-width:0 matters: a text input's intrinsic min-content width is ~20
      // characters, and two of them plus the remove button would otherwise
      // overflow the 480px modal instead of shrinking.
      '<input type="text" data-sec-email placeholder="name@practice.com.au"' + ivAttr(v.email) + ' style="flex:1.4;min-width:0;margin:0" />' +
      '<input type="text" data-sec-name placeholder="Name (optional)"' + ivAttr(v.name) + ' style="flex:1;min-width:0;margin:0" />' +
      '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" data-ats="remove-secondary" title="Remove this contact" style="flex:none">✕</button>' +
    '</div>';
  }

  function secondaryFieldsetHtml(list) {
    var rows = normalizeSecondaryList(list).map(secondaryRowHtml).join('');
    return '<div style="margin-top:6px">' +
      '<label>Secondary contacts (optional)</label>' +
      '<p style="font-size:11.5px;color:var(--ats-dim);margin:0 0 8px">' + ATS.esc(SECONDARY_CC_NOTE) + ' The primary contact above still receives every email.</p>' +
      '<div id="atsFSecondaryList">' + rows + '</div>' +
      '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" data-ats="add-secondary">＋ Add contact</button>' +
    '</div>';
  }

  // Reads the rows back in DOM order, dropping blanks. The server normalizes
  // again (lowercase, dedupe, drop the primary, cap) — this is only here so an
  // empty row the user added and left alone isn't sent as a contact.
  function readSecondaryContacts() {
    var host = document.getElementById('atsFSecondaryList');
    if (!host) return [];
    var out = [];
    var rows = host.querySelectorAll('.ats-sec-row');
    for (var i = 0; i < rows.length; i++) {
      var emailEl = rows[i].querySelector('[data-sec-email]');
      var nameEl = rows[i].querySelector('[data-sec-name]');
      var email = emailEl ? String(emailEl.value || '').trim() : '';
      if (!email) continue;
      out.push({ name: nameEl ? String(nameEl.value || '').trim() : '', email: email });
    }
    return out;
  }

  // Stable comparison key for the save-diff — order and letter-case are not
  // meaningful edits, so re-opening the modal and saving nothing sends nothing.
  function secondaryKey(list) {
    return normalizeSecondaryList(list).map(function (c) {
      return c.email.toLowerCase() + ' ' + c.name;
    }).sort().join('');
  }

  // opts: { title, btn, action ('create-practice'|'save-practice'), vals, corps }
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
          '<div class="ats-form-row">' +
            '<div><label>Type</label><input type="text" id="atsFType" placeholder="e.g. GP Clinic — Mixed billing"' + ivAttr(v.type) + ' /></div>' +
            '<div><label>Organisation type</label>' +
              '<select id="atsFOrgType">' +
                '<option value="practice"' + (v.org_type === 'corporation' ? '' : ' selected') + '>Practice</option>' +
                '<option value="corporation"' + (v.org_type === 'corporation' ? ' selected' : '') + '>Corporation</option>' +
              '</select>' +
            '</div>' +
          '</div>' +
          parentCorpSelectHtml(opts.corps, v) +
          '<div class="ats-form-row">' +
            '<div><label>Primary contact name</label><input type="text" id="atsFContact" placeholder="Dr. Helen Carter"' + ivAttr(v.contact) + ' /></div>' +
            '<div><label>Primary contact email</label><input type="text" id="atsFEmail" placeholder="admin@practice.com.au"' + ivAttr(v.email) + ' /></div>' +
          '</div>' +
          '<div class="ats-form-row">' +
            '<div><label>Phone</label><input type="text" id="atsFPhone" placeholder="07 0000 0000"' + ivAttr(v.phone) + ' /></div>' +
            '<div><label>AHPRA / reg no.</label><input type="text" id="atsFAhpra" placeholder="PRA-QLD-00000"' + ivAttr(v.ahpra) + ' /></div>' +
          '</div>' +
          secondaryFieldsetHtml(v.secondary_contacts) +
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
      ahpra: val('atsFAhpra').trim(),
      org_type: val('atsFOrgType') || 'practice',
      parent_corporation_id: val('atsFParentCorp'),
      secondary_contacts: readSecondaryContacts()
    };
  }

  function closeModal() { ATS.setOverlay(''); }

  function openAddModal() {
    fetchCorporationChoices('').then(function (corps) {
      ATS.setOverlay(practiceModalHtml({
        title: 'Add a practice', btn: 'Create practice', action: 'create-practice', vals: {}, corps: corps
      }));
    });
  }

  function openEditModal() {
    var p = currentPractice;
    if (!p) return;
    fetchCorporationChoices(p.id).then(function (corps) {
      ATS.setOverlay(practiceModalHtml({
        title: 'Edit practice', btn: 'Save changes', action: 'save-practice',
        vals: {
          name: p.name, city: p.location_city, state: p.location_state, type: p.practice_type,
          contact: p.contact_name, email: p.contact_email, phone: p.contact_phone, ahpra: p.ahpra_number,
          org_type: p.org_type, parent_corporation_id: p.parent_corporation_id || '',
          secondary_contacts: p.secondary_contacts || []
        },
        corps: corps
      }));
    });
  }

  function createPractice() {
    var body = readForm();
    if (!body.name) { ATS.toast('Enter a practice name'); return; }
    // Only send a parent link when one is actually chosen (and never for a
    // corporation — the dropdown is hidden but may still hold a stale value).
    if (body.org_type === 'corporation' || !body.parent_corporation_id) delete body.parent_corporation_id;
    // Same reasoning for secondary contacts: omit the key entirely when none
    // were entered, so a create still works against a DB that hasn't had the
    // secondary_contacts migration applied.
    if (!body.secondary_contacts.length) delete body.secondary_contacts;
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
    // A corporation carries no parent — ignore any stale hidden-dropdown value
    // (the server also force-clears the link on an org_type flip).
    if (cur.org_type === 'corporation') cur.parent_corporation_id = '';
    var orig = {
      name: p.name, city: p.location_city, state: p.location_state, type: p.practice_type,
      contact: p.contact_name, email: p.contact_email, phone: p.contact_phone, ahpra: p.ahpra_number,
      org_type: p.org_type || 'practice',
      parent_corporation_id: p.parent_corporation_id || ''
    };
    var keys = ['name', 'city', 'state', 'type', 'contact', 'email', 'phone', 'ahpra', 'org_type', 'parent_corporation_id'];
    var body = {};
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var o = orig[k] == null ? '' : String(orig[k]);
      if (cur[k] !== o) body[k] = cur[k];
    }
    // Secondary contacts diff separately — they're a list, not a string, so
    // the String() comparison above can't see them. Sent whenever the set
    // changed, INCLUDING when it emptied: an explicit [] is how the server is
    // told to clear the list (removing the last contact must actually remove it).
    if (secondaryKey(cur.secondary_contacts) !== secondaryKey(p.secondary_contacts)) {
      body.secondary_contacts = cur.secondary_contacts;
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
    else if (action === 'resend-intake') resendIntake(id, t);
    else if (action === 'upload-contract') triggerContractUpload();
    // 'call-tel' / 'call-noop': intercepted here purely so the click doesn't
    // bubble to the enclosing card's 'open-practice' — the tel: link (when
    // present) still navigates via its own default browser action.
    else if (action === 'call-tel' || action === 'call-noop') { /* no-op */ }
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

  function onPanelChange(e) {
    if (!e.target) return;
    if (e.target.id === 'atsStageSelect') onStageChange(e.target.value);
    else if (e.target.id === 'atsContractFile') uploadContract(e.target);
  }

  // Modal-level change events: hide the parent-corporation dropdown while the
  // org type is Corporation (a corporation has no parent).
  function onOverlayChange(e) {
    if (e.target && e.target.id === 'atsFOrgType') {
      var wrap = document.getElementById('atsFParentCorpWrap');
      if (wrap) wrap.style.display = e.target.value === 'corporation' ? 'none' : '';
    }
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
    else if (action === 'add-secondary') addSecondaryRow();
    else if (action === 'remove-secondary') removeSecondaryRow(btn);
  }

  // Appends a blank row and focuses its email input — the field the user is
  // there to fill. Rebuilding the whole list would wipe what they've typed
  // into the other rows, so this appends rather than re-renders.
  function addSecondaryRow() {
    var host = document.getElementById('atsFSecondaryList');
    if (!host) return;
    host.insertAdjacentHTML('beforeend', secondaryRowHtml({}));
    var rows = host.querySelectorAll('.ats-sec-row');
    var last = rows[rows.length - 1];
    var input = last ? last.querySelector('[data-sec-email]') : null;
    if (input && input.focus) input.focus();
  }

  function removeSecondaryRow(btn) {
    var row = btn.closest ? btn.closest('.ats-sec-row') : null;
    if (row && row.parentNode) row.parentNode.removeChild(row);
  }

  function ensureDelegation() {
    if (bound) return;
    var panel = panelEl();
    if (!panel) return; // bind later, once the panel exists
    bound = true;
    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('input', onPanelInput);
    panel.addEventListener('change', onPanelChange);
    var overlay = document.getElementById('atsOverlayRoot');
    if (overlay) {
      overlay.addEventListener('click', onOverlayClick);
      overlay.addEventListener('change', onOverlayChange);
    }
  }

  // -------------------- exports --------------------
  window.loadPracticesTab = loadPracticesTab;
  window.atsOpenPractice = openPractice;

  ensureDelegation();
})();
