(function () {
  const UPDATES_KEY = "gp_link_updates";
  const READ_KEY = "gp_link_updates_read";
  const SUPPORT_CASES_KEY = "gpLinkSupportCases";
  const NUDGES_SEEN_KEY = "gp_link_nudges_seen";
  const PANEL_ID = "gp-alert-center";
  const PANEL_STYLE_ID = "gp-alert-center-style";
  // Server merge layer for cross-device read-state (see /api/gp/alerts/read-state).
  const READ_SYNC_URL = "/api/gp/alerts/read-state";
  // How many alerts the bell panel shows; the rest are behind the "See all" link.
  const MAX_BELL_ITEMS = 12;

  const DEFAULT_UPDATES = [];
  const DEFAULT_READ_STATE = {};
  const memoryStore = Object.create(null);

  function escHtml(s) {
    if (typeof s !== "string") return "";
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function safeGetItem(key) {
    try {
      return localStorage.getItem(key);
    } catch (err) {
      return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null;
    }
  }

  function safeSetItem(key, value) {
    const str = String(value);
    try {
      localStorage.setItem(key, str);
    } catch (err) {
      memoryStore[key] = str;
    }
  }

  function normalizeType(rawType) {
    const type = typeof rawType === "string" ? rawType.toLowerCase() : "info";
    if (type === "success" || type === "info" || type === "action") return type;
    return "info";
  }

  function sanitizeUpdate(item) {
    if (!item || typeof item !== "object") return null;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title) return null;
    const detail = typeof item.detail === "string" ? item.detail.trim() : "";
    const ts = typeof item.ts === "string" ? item.ts : new Date().toISOString();
    const out = {
      type: normalizeType(item.type),
      title,
      detail,
      ts
    };
    // Server-provided deep link (e.g. a rejected doc's re-upload card), only
    // same-app /pages/ paths survive sanitization.
    if (typeof item.target === "string" && item.target.indexOf("/pages/") === 0) out.target = item.target;
    if (typeof item.nudgeId === "string" && item.nudgeId) out.nudgeId = item.nudgeId;
    if (typeof item.category === "string" && item.category) out.category = item.category;
    return out;
  }

  function sanitizeUpdates(list) {
    if (!Array.isArray(list)) return [];
    return list.map(sanitizeUpdate).filter(Boolean);
  }

  function parseStoredUpdates() {
    const raw = safeGetItem(UPDATES_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      const clean = sanitizeUpdates(parsed);
      return clean.length ? clean : null;
    } catch (err) {
      return null;
    }
  }

  function parseReadState() {
    const raw = safeGetItem(READ_KEY);
    if (!raw) return { ...DEFAULT_READ_STATE };
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return { ...DEFAULT_READ_STATE };
      return parsed;
    } catch (err) {
      return { ...DEFAULT_READ_STATE };
    }
  }

  function saveReadState(state) {
    const next = state && typeof state === "object" ? state : {};
    safeSetItem(READ_KEY, JSON.stringify(next));
    return next;
  }

  function markRead(alertId) {
    if (!alertId) return;
    // LOCAL-FIRST: the read flag is written to localStorage immediately so the
    // UI (and offline use) never waits on the network; the server push below is
    // best-effort and only exists so other devices see the alert as read too.
    const readState = parseReadState();
    readState[alertId] = true;
    saveReadState(readState);
    pushReadIdsToServer([alertId]);
  }

  // ── Cross-device alert read-state sync ──
  // The server keeps a union of read alert ids per GP (own data only). We pull
  // it and merge into the local read-state (read anywhere = read everywhere),
  // then push any locally-read ids the server doesn't know about yet. All
  // failures are swallowed, local behaviour is unchanged when offline.
  let readSyncInFlight = false;
  async function syncReadStateWithServer() {
    if (readSyncInFlight) return false;
    readSyncInFlight = true;
    try {
      const res = await fetch(READ_SYNC_URL, { credentials: "same-origin" });
      if (!res || !res.ok) return false;
      const data = await res.json().catch(() => null);
      if (!data || !data.ok || !data.read || typeof data.read !== "object") return false;
      const local = parseReadState();
      let changed = false;
      Object.keys(data.read).forEach((id) => {
        if (local[id] !== true) {
          local[id] = true;
          changed = true;
        }
      });
      if (changed) {
        saveReadState(local);
        refreshInboxBadges();
        const root = document.getElementById(PANEL_ID);
        if (root && root.classList.contains("show")) renderPanel();
      }
      const missing = Object.keys(local).filter((id) => local[id] === true && !Object.prototype.hasOwnProperty.call(data.read, id));
      if (missing.length) pushReadIdsToServer(missing);
      return true;
    } catch (err) {
      return false;
    } finally {
      readSyncInFlight = false;
    }
  }

  function pushReadIdsToServer(ids) {
    const clean = (Array.isArray(ids) ? ids : [])
      .filter((id) => typeof id === "string" && id)
      .slice(0, 200);
    if (!clean.length) return;
    try {
      fetch(READ_SYNC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ids: clean })
      }).catch(() => {});
    } catch (err) {
      /* fire-and-forget */
    }
  }

  function parseSupportCases() {
    const raw = safeGetItem(SUPPORT_CASES_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }

  function updateCaseUnread(caseId, unread) {
    if (!caseId) return;
    const cases = parseSupportCases();
    let changed = false;
    const next = cases.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      if (entry.id !== caseId) return entry;
      changed = true;
      return { ...entry, unread: !!unread };
    });
    if (changed) {
      safeSetItem(SUPPORT_CASES_KEY, JSON.stringify(next));
    }
  }

  function alertIdForUpdate(item) {
    const ts = typeof item.ts === "string" ? item.ts : "";
    const title = typeof item.title === "string" ? item.title : "";
    return `update:${ts}:${title}`;
  }

  function alertIdForSupport(caseId, ts) {
    return `support:${caseId}:${ts || ""}`;
  }

  function buildAlertItems() {
    const updates = getGpLinkUpdates();
    const readState = parseReadState();
    const out = [];

    updates.forEach((item) => {
      const id = alertIdForUpdate(item);
      out.push({
        id,
        ts: item.ts || new Date().toISOString(),
        title: item.title,
        kind: item.type === "action" ? "action" : "update",
        unread: readState[id] !== true,
        // A per-item deep link (e.g. the rejected doc's re-upload card) beats
        // the generic messages-tab fallbacks.
        target: (typeof item.target === "string" && item.target.indexOf("/pages/") === 0)
          ? item.target
          : item.type === "action" && item.nudgeId
          ? "/pages/messages#chat-" + encodeURIComponent(item.nudgeId)
          : item.type === "action" ? "/pages/messages#tab-action"
          : "/pages/messages#tab-updates",
      });
    });

    parseSupportCases().forEach((c) => {
      if (!c || typeof c !== "object") return;
      const thread = Array.isArray(c.thread) ? c.thread : [];
      const gpReplies = thread.filter((entry) => entry && entry.from === "gp");
      if (!gpReplies.length) return; // Open cases without GP response do not appear here.
      const latest = gpReplies[gpReplies.length - 1];
      const ts = typeof latest.ts === "string" ? latest.ts : (typeof c.updatedAt === "string" ? c.updatedAt : new Date().toISOString());
      const id = alertIdForSupport(c.id, ts);
      out.push({
        id,
        ts,
        title: typeof c.title === "string" && c.title ? c.title : "Support response",
        kind: "support",
        unread: readState[id] !== true,
        target: c.id ? `/pages/messages#ticket-${encodeURIComponent(c.id)}` : "/pages/messages#tab-cases",
        caseId: c.id || "",
      });
    });

    const kindPriority = { action: 0, support: 1, update: 2 };
    out.sort((a, b) => {
      const aPri = Object.prototype.hasOwnProperty.call(kindPriority, a.kind) ? kindPriority[a.kind] : 9;
      const bPri = Object.prototype.hasOwnProperty.call(kindPriority, b.kind) ? kindPriority[b.kind] : 9;
      if (aPri !== bPri) return aPri - bPri;
      const aTs = new Date(a.ts).getTime() || 0;
      const bTs = new Date(b.ts).getTime() || 0;
      return bTs - aTs;
    });

    return out.slice(0, MAX_BELL_ITEMS);
  }

  function saveGpLinkUpdates(updates) {
    const clean = sanitizeUpdates(updates);
    const finalUpdates = clean.length ? clean : [];
    safeSetItem(UPDATES_KEY, JSON.stringify(finalUpdates));
    window.gpLinkUpdates = finalUpdates.slice();
    return window.gpLinkUpdates;
  }

  function getGpLinkUpdates() {
    const stored = parseStoredUpdates();
    if (stored && stored.length) {
      window.gpLinkUpdates = stored.slice();
      return window.gpLinkUpdates;
    }

    const runtime = sanitizeUpdates(window.gpLinkUpdates);
    if (runtime.length) {
      return saveGpLinkUpdates(runtime);
    }

    return saveGpLinkUpdates([]);
  }

  function hasGpLinkActionRequired(updates) {
    const list = sanitizeUpdates(updates && updates.length ? updates : getGpLinkUpdates());
    return list.some((item) => item.type === "action");
  }

  function hasUnreadAlerts() {
    return buildAlertItems().some((item) => item.unread);
  }

  function refreshInboxBadges() {
    const shouldShow = hasUnreadAlerts();
    const badges = document.querySelectorAll("[data-inbox-alert]");
    badges.forEach((badge) => {
      badge.hidden = !shouldShow;
      badge.setAttribute("aria-hidden", shouldShow ? "false" : "true");
    });
  }

  // ── Redesigned panel (v9): pure/small rendering helpers ──
  // These read the same underlying storage buildAlertItems() already reads
  // (getGpLinkUpdates / parseSupportCases) to surface the `.detail` text that
  // buildAlertItems() itself does not pass through, buildAlertItems() and its
  // output shape are left untouched, this only adds a display-time lookup.
  let panelFilter = "all"; // "all" | "action" | "update" | "support"

  const KIND_ICON_SVG = {
    action: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    update: '<path d="M20 6 9 17l-5-5"/>',
    support: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m9 15 2 2 4-4"/>'
  };

  function kindLabel(kind) {
    if (kind === "action") return "Action";
    if (kind === "support") return "Reply";
    return "Update";
  }

  function timeAgo(ts) {
    if (typeof ts !== "string" || !ts) return "";
    const then = new Date(ts).getTime();
    if (!Number.isFinite(then)) return "";
    const diffMs = Date.now() - then;
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hrs ago`;
    const days = Math.floor(hours / 24);
    if (days <= 14) return `${days} days ago`;
    return new Date(then).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  }

  function alertItemUpdateDetail(id) {
    const match = getGpLinkUpdates().find((u) => alertIdForUpdate(u) === id);
    return match && typeof match.detail === "string" ? match.detail : "";
  }

  function alertItemSupportDetail(id) {
    const cases = parseSupportCases();
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      if (!c || typeof c !== "object") continue;
      const thread = Array.isArray(c.thread) ? c.thread : [];
      const gpReplies = thread.filter((entry) => entry && entry.from === "gp");
      if (!gpReplies.length) continue;
      const latest = gpReplies[gpReplies.length - 1];
      const ts = typeof latest.ts === "string" ? latest.ts : (typeof c.updatedAt === "string" ? c.updatedAt : new Date().toISOString());
      if (alertIdForSupport(c.id, ts) === id) {
        return typeof latest.text === "string" ? latest.text : "";
      }
    }
    return "";
  }

  function alertItemDetail(item) {
    if (!item || typeof item.id !== "string") return "";
    if (item.id.indexOf("update:") === 0) return alertItemUpdateDetail(item.id);
    if (item.id.indexOf("support:") === 0) return alertItemSupportDetail(item.id);
    return "";
  }

  // Marks every passed alert item read via the existing per-item markRead
  // mechanics (same as a single item click), used by "Mark all read".
  function markAllAlertsRead(items) {
    (items || []).forEach((item) => {
      markRead(item.id);
      if (item.kind === "support" && item.caseId) updateCaseUnread(item.caseId, false);
    });
  }

  function ensurePanelStyles() {
    if (document.getElementById(PANEL_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = PANEL_STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        left: 50%;
        top: 14px;
        transform: translate(-50%, -16px) scale(.98);
        width: min(980px, calc(100vw - 20px));
        max-height: 82vh;
        border-radius: 20px;
        border: 1px solid #dbe7fb;
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 26px 60px -26px rgba(15, 23, 42, 0.5);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        opacity: 0;
        pointer-events: none;
        z-index: 1200;
        transition: transform .28s cubic-bezier(.22,.9,.2,1), opacity .22s ease;
        overflow: hidden;
      }
      #${PANEL_ID}.show {
        opacity: 1;
        transform: translate(-50%, 0) scale(1);
        pointer-events: auto;
      }
      #${PANEL_ID} .head {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 16px 16px 12px;
      }
      #${PANEL_ID} .head h4 {
        margin: 0;
        font-family: "Source Serif 4", Georgia, serif;
        font-size: 18px;
        font-weight: 600;
        letter-spacing: -.01em;
        color: #0f172a;
      }
      #${PANEL_ID} .head .new-chip {
        font-size: 10px;
        font-weight: 800;
        color: #2563eb;
        background: rgba(37, 99, 235, .08);
        border: 1px solid rgba(37, 99, 235, .12);
        border-radius: 7px;
        padding: 2px 8px;
        text-transform: uppercase;
        letter-spacing: .04em;
      }
      #${PANEL_ID} .head .mark-all {
        margin-left: auto;
        font-size: 11.5px;
        font-weight: 700;
        color: #64748b;
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
      }
      #${PANEL_ID} .head .mark-all:hover { color: #2563eb; }
      #${PANEL_ID} .head button[data-alert-close] {
        border: 1px solid #dbe7fb;
        background: #fff;
        color: #334155;
        border-radius: 999px;
        width: 28px;
        height: 28px;
        font-size: 15px;
        font-weight: 700;
        cursor: pointer;
        display: grid;
        place-items: center;
        flex: none;
        margin-left: 0;
      }
      #${PANEL_ID} .filters {
        display: flex;
        gap: 6px;
        padding: 0 16px 12px;
        border-bottom: 1px solid #eef2f9;
      }
      #${PANEL_ID} .fchip {
        font-size: 11px;
        font-weight: 700;
        border-radius: 999px;
        padding: 5px 12px;
        border: 1px solid #e3e9f4;
        color: #64748b;
        background: #fff;
        cursor: pointer;
      }
      #${PANEL_ID} .fchip.on {
        background: #0f172a;
        border-color: #0f172a;
        color: #fff;
      }
      #${PANEL_ID} .grp {
        font-size: 10px;
        letter-spacing: .11em;
        text-transform: uppercase;
        font-weight: 800;
        color: #94a3b8;
        padding: 12px 12px 6px;
      }
      #${PANEL_ID} .list {
        padding: 4px 10px 6px;
        max-height: calc(82vh - 110px);
        overflow: auto;
        display: grid;
        gap: 6px;
      }
      #${PANEL_ID} .empty {
        border: 1px dashed #dbe7fb;
        border-radius: 14px;
        padding: 16px;
        margin: 6px 2px;
        font-size: 13px;
        color: #64748b;
        text-align: center;
      }
      #${PANEL_ID} .aitem {
        display: grid;
        grid-template-columns: 36px 1fr auto;
        gap: 11px;
        align-items: start;
        width: 100%;
        border: 1px solid transparent;
        border-radius: 14px;
        padding: 10px 10px 11px;
        background: transparent;
        text-align: left;
        cursor: pointer;
        font: inherit;
      }
      #${PANEL_ID} .aitem:hover { border-color: #cfe0fd; }
      #${PANEL_ID} .aitem.unread { background: #f8fbff; border-color: #e0ebfd; }
      #${PANEL_ID} .aitem.read { opacity: .78; }
      #${PANEL_ID} .aitem .ic {
        width: 36px;
        height: 36px;
        border-radius: 11px;
        display: grid;
        place-items: center;
        flex: none;
      }
      #${PANEL_ID} .aitem .ic svg {
        width: 17px;
        height: 17px;
        fill: none;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      #${PANEL_ID} .aitem.k-action .ic { background: #fdf3e1; border: 1px solid #f4ddb0; }
      #${PANEL_ID} .aitem.k-action .ic svg { stroke: #d97706; }
      #${PANEL_ID} .aitem.k-update .ic { background: #eff4ff; border: 1px solid #d6e2fb; }
      #${PANEL_ID} .aitem.k-update .ic svg { stroke: #2563eb; }
      #${PANEL_ID} .aitem.k-support .ic { background: #eafaf0; border: 1px solid #c5ecd4; }
      #${PANEL_ID} .aitem.k-support .ic svg { stroke: #16a34a; }
      #${PANEL_ID} .aitem .body { min-width: 0; }
      #${PANEL_ID} .aitem .ttl {
        font-size: 13px;
        font-weight: 700;
        color: #0f172a;
        line-height: 1.35;
      }
      #${PANEL_ID} .aitem .bd {
        font-size: 12px;
        color: #64748b;
        line-height: 1.5;
        margin-top: 2px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      #${PANEL_ID} .aitem .meta {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 6px;
        flex-wrap: wrap;
      }
      #${PANEL_ID} .aitem .kind {
        font-size: 10px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: .05em;
      }
      #${PANEL_ID} .aitem.k-action .kind { color: #92400e; }
      #${PANEL_ID} .aitem.k-update .kind { color: #1d4ed8; }
      #${PANEL_ID} .aitem.k-support .kind { color: #166534; }
      #${PANEL_ID} .aitem .time { font-size: 10.5px; color: #94a3b8; font-weight: 600; }
      #${PANEL_ID} .aitem .go {
        font-size: 11.5px;
        font-weight: 800;
        color: #2563eb;
        margin-top: 7px;
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      #${PANEL_ID} .aitem .go::after { content: '\\2192'; }
      #${PANEL_ID} .aitem .udot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #2563eb;
        margin-top: 5px;
        justify-self: end;
      }
      #${PANEL_ID} .see-all {
        display: block;
        text-align: center;
        padding: 12px;
        font-size: 12.5px;
        font-weight: 700;
        color: #2563eb;
        text-decoration: none;
        border-top: 1px solid #e8edf5;
      }
      @media (max-width: 767px) {
        #${PANEL_ID} {
          top: 8px;
          width: calc(100vw - 12px);
          max-height: 88vh;
          border-radius: 16px;
        }
        #${PANEL_ID} .list { max-height: calc(88vh - 110px); }
      }
    `;
    document.head.appendChild(style);
  }

  function ensurePanelRoot() {
    let root = document.getElementById(PANEL_ID);
    if (root) return root;
    ensurePanelStyles();
    root = document.createElement("section");
    root.id = PANEL_ID;
    root.setAttribute("aria-hidden", "true");
    root.innerHTML = `
      <div class="head">
        <h4>Team Alerts</h4>
        <span class="new-chip" id="${PANEL_ID}-newchip" hidden></span>
        <button type="button" class="mark-all" data-mark-all>Mark all read</button>
        <button type="button" data-alert-close aria-label="Close alerts">&times;</button>
      </div>
      <div class="filters">
        <button type="button" class="fchip on" data-filter="all">All</button>
        <button type="button" class="fchip" data-filter="action">Actions</button>
        <button type="button" class="fchip" data-filter="update">Updates</button>
        <button type="button" class="fchip" data-filter="support">Replies</button>
      </div>
      <div class="list" id="${PANEL_ID}-list"></div>
      <a href="/pages/messages" class="see-all">See all updates</a>
    `;

    root.querySelectorAll(".fchip").forEach((chip) => {
      chip.addEventListener("click", () => {
        panelFilter = chip.getAttribute("data-filter") || "all";
        renderPanel();
      });
    });

    const markAllBtn = root.querySelector("[data-mark-all]");
    if (markAllBtn) {
      markAllBtn.addEventListener("click", () => {
        markAllAlertsRead(buildAlertItems());
        renderPanel();
      });
    }

    var seeAllLink = root.querySelector(".see-all");
    if (seeAllLink) {
      seeAllLink.addEventListener("click", function (e) {
        e.preventDefault();
        closePanel();
        if (window.gpShellNavigate) window.gpShellNavigate("/pages/messages");
        else window.location.href = "/pages/messages";
      });
    }
    document.body.appendChild(root);
    return root;
  }

  function buildAlertItemEl(item) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `aitem k-${item.kind} ${item.unread ? "unread" : "read"}`;
    const detail = alertItemDetail(item);
    const time = timeAgo(item.ts);
    const showGo = typeof item.target === "string" && item.target.indexOf("/pages/") === 0;
    const icon = KIND_ICON_SVG[item.kind] || KIND_ICON_SVG.update;
    el.innerHTML = `
      <span class="ic" aria-hidden="true"><svg viewBox="0 0 24 24">${icon}</svg></span>
      <span class="body">
        <span class="ttl">${escHtml(item.title)}</span>
        ${detail ? `<span class="bd">${escHtml(detail)}</span>` : ""}
        <span class="meta">
          <span class="kind">${escHtml(kindLabel(item.kind))}</span>
          ${time ? `<span class="time">${escHtml(time)}</span>` : ""}
        </span>
        ${showGo ? `<span class="go">View</span>` : ""}
      </span>
      <span class="udot"${item.unread ? "" : ' style="visibility:hidden"'} aria-hidden="true"></span>
    `;
    el.addEventListener("click", () => {
      markRead(item.id);
      if (item.kind === "support" && item.caseId) updateCaseUnread(item.caseId, false);
      refreshInboxBadges();
      closePanel();
      if (item.target && item.target.startsWith("/pages/")) {
        if (window.gpShellNavigate) window.gpShellNavigate(item.target);
        else window.location.href = item.target;
      }
    });
    return el;
  }

  function renderPanel() {
    const root = ensurePanelRoot();
    const listEl = document.getElementById(`${PANEL_ID}-list`);
    const newChipEl = document.getElementById(`${PANEL_ID}-newchip`);
    const items = buildAlertItems();

    root.querySelectorAll(".fchip").forEach((chip) => {
      chip.classList.toggle("on", chip.getAttribute("data-filter") === panelFilter);
    });

    const unreadCount = items.filter((item) => item.unread).length;
    if (newChipEl) {
      newChipEl.hidden = unreadCount === 0;
      newChipEl.textContent = unreadCount + " new";
    }

    listEl.innerHTML = "";

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No Updates Yet";
      listEl.appendChild(empty);
      refreshInboxBadges();
      return;
    }

    const filtered = panelFilter === "all" ? items : items.filter((item) => item.kind === panelFilter);

    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Nothing here yet";
      listEl.appendChild(empty);
      refreshInboxBadges();
      return;
    }

    function renderGroup(label, groupItems) {
      if (!groupItems.length) return;
      const grp = document.createElement("div");
      grp.className = "grp";
      grp.textContent = label;
      listEl.appendChild(grp);
      groupItems.forEach((item) => listEl.appendChild(buildAlertItemEl(item)));
    }

    renderGroup("New", filtered.filter((item) => item.unread));
    renderGroup("Earlier", filtered.filter((item) => !item.unread));

    refreshInboxBadges();
  }

  // ── Server nudges (VA → user) ──
  // Fetches /api/user/nudges and merges any new nudges into the local
  // gp_link_updates list as "action" items so they surface in the bell panel.
  function loadSeenNudgeIds() {
    const raw = safeGetItem(NUDGES_SEEN_KEY);
    if (!raw) return {};
    try { const p = JSON.parse(raw); return (p && typeof p === "object") ? p : {}; } catch { return {}; }
  }
  function saveSeenNudgeIds(map) {
    try { safeSetItem(NUDGES_SEEN_KEY, JSON.stringify(map || {})); } catch {}
  }
  let nudgePullInFlight = false;
  async function pullServerNudges() {
    if (nudgePullInFlight) return false;
    nudgePullInFlight = true;
    try {
      const res = await fetch("/api/user/nudges", { credentials: "same-origin" });
      if (!res || !res.ok) return false;
      const data = await res.json().catch(() => null);
      if (!data || !data.ok || !Array.isArray(data.nudges)) return false;
      const waNumber = (data.whatsapp_number || "+61494391968").replace(/[^\d+]/g, "");
      const seen = loadSeenNudgeIds();
      const updates = sanitizeUpdates(getGpLinkUpdates());
      let changed = false;
      data.nudges.forEach((n) => {
        if (!n || !n.id || seen[n.id]) return;
        const title = typeof n.title === "string" && n.title.trim() ? n.title.trim() : "Check-in from Hazel";
        const msg = typeof n.message === "string" && n.message.trim() ? n.message.trim() : "Are you having trouble with your current step? Submit a ticket or message your dedicated support expert Hazel via WhatsApp.";
        const ts = typeof n.created_at === "string" ? n.created_at : new Date().toISOString();
        updates.unshift({ type: "action", title: title, detail: msg, ts: ts, nudgeId: n.id });
        seen[n.id] = ts;
        changed = true;
      });
      if (changed) {
        saveGpLinkUpdates(updates);
        saveSeenNudgeIds(seen);
        refreshInboxBadges();
        // If the panel is open, re-render to show new nudges
        const root = document.getElementById(PANEL_ID);
        if (root && root.classList.contains("show")) renderPanel();
      }
      // Fire-and-forget: mark each seen nudge as read so server stops returning it
      Object.keys(seen).forEach((id) => {
        try {
          fetch("/api/user/nudges/" + encodeURIComponent(id) + "/read", { method: "PUT", credentials: "same-origin" })
            .catch(() => {});
        } catch {}
      });
      return true;
    } catch {
      return false;
    } finally {
      nudgePullInFlight = false;
    }
  }

  function openPanel(triggerEl) {
    const root = ensurePanelRoot();
    renderPanel();
    // Fire nudge pull + read-state reconcile when the user opens the bell,
    // non-blocking, re-renders on new data
    pullServerNudges();
    syncReadStateWithServer();
    // Clear any stale inline styles so CSS classes control positioning
    root.style.transform = "";
    root.style.left = "";
    root.classList.remove("show");
    // Force reflow so the browser registers the hidden state before animating
    void root.offsetHeight;
    root.classList.add("show");
    root.setAttribute("aria-hidden", "false");
  }

  function closePanel() {
    const root = document.getElementById(PANEL_ID);
    if (!root) return;
    root.classList.remove("show");
    root.setAttribute("aria-hidden", "true");
    // Clear inline styles so next open starts from CSS defaults
    root.style.transform = "";
    root.style.left = "";
  }

  function installAlertTriggers() {
    let suppressClickUntil = 0;

    function toggleFromTrigger(event, triggerEl) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
      const root = ensurePanelRoot();
      if (root.classList.contains("show")) closePanel();
      else openPanel(triggerEl);
    }

    function bindTrigger(id) {
      const el = document.getElementById(id);
      if (!el) return;
      bindTriggerEl(el);
    }

    function bindTriggerEl(el) {
      if (!el || el.__gpAlertTriggerBound) return;
      if (el.hasAttribute("data-message-nav")) {
        el.__gpAlertTriggerBound = true;
        return;
      }
      el.__gpAlertTriggerBound = true;
      el.addEventListener("click", (event) => {
        if (Date.now() < suppressClickUntil) return;
        toggleFromTrigger(event, el);
      }, true);
      el.addEventListener("pointerup", (event) => {
        if (Date.now() < suppressClickUntil) return;
        toggleFromTrigger(event, el);
      }, true);
      el.addEventListener("touchend", (event) => {
        suppressClickUntil = Date.now() + 300;
        toggleFromTrigger(event, el);
      }, { capture: true, passive: false });
    }

    bindTrigger("mobileNotifBtn");
    bindTrigger("topSupportBtn");
    bindTrigger("mobileSupportBtn");
    bindTrigger("mobileHeaderChatBtn");

    document.querySelectorAll('[aria-label="Notifications"], [aria-label="Messages"], [data-alert-trigger]').forEach((el) => {
      bindTriggerEl(el);
    });

    document.addEventListener("click", (event) => {
      const targetEl = event.target instanceof Element
        ? event.target
        : (event.target && event.target.parentElement ? event.target.parentElement : null);

      const closeBtn = targetEl ? targetEl.closest("[data-alert-close]") : null;
      if (closeBtn) {
        event.preventDefault();
        closePanel();
        return;
      }

      const root = document.getElementById(PANEL_ID);
      if (!root || !root.classList.contains("show")) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      closePanel();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closePanel();
    });
  }

  window.getGpLinkUpdates = getGpLinkUpdates;
  window.saveGpLinkUpdates = saveGpLinkUpdates;
  window.hasGpLinkActionRequired = hasGpLinkActionRequired;
  window.refreshInboxBadges = refreshInboxBadges;
  window.openGpAlertPanel = openPanel;
  window.closeGpAlertPanel = closePanel;

  function bootstrapNudgePolling() {
    // Initial pull shortly after load, then every 3 minutes while the tab is visible
    setTimeout(() => { pullServerNudges(); syncReadStateWithServer(); }, 1500);
    setInterval(() => {
      if (document.visibilityState === "visible") { pullServerNudges(); syncReadStateWithServer(); }
    }, 180000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") { pullServerNudges(); syncReadStateWithServer(); }
    });
    // Re-reconcile once state-sync hydration lands, it can replace the local
    // read-state key with the server's copy of another device's snapshot.
    window.addEventListener("gp-state-hydrated", () => { syncReadStateWithServer(); }, { once: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      refreshInboxBadges();
      installAlertTriggers();
      bootstrapNudgePolling();
    });
  } else {
    refreshInboxBadges();
    installAlertTriggers();
    bootstrapNudgePolling();
  }

  window.gpLinkPullServerNudges = pullServerNudges;

  window.addEventListener("storage", (event) => {
    if (event.key === UPDATES_KEY || event.key === SUPPORT_CASES_KEY || event.key === READ_KEY) {
      refreshInboxBadges();
      renderPanel();
    }
  });
})();
