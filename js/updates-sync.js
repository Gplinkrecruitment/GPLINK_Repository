(function () {
  const UPDATES_KEY = "gp_link_updates";
  const READ_KEY = "gp_link_updates_read";
  const SUPPORT_CASES_KEY = "gpLinkSupportCases";
  const PANEL_ID = "gp-alert-center";
  const PANEL_STYLE_ID = "gp-alert-center-style";

  const DEFAULT_UPDATES = [];
  const DEFAULT_READ_STATE = {};
  const memoryStore = Object.create(null);

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
    return {
      type: normalizeType(item.type),
      title,
      detail,
      ts
    };
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
    const readState = parseReadState();
    readState[alertId] = true;
    saveReadState(readState);
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
        target: item.type === "action" ? "/pages/messages.html#tab-action" : "/pages/messages.html#tab-updates",
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
        target: c.id ? `/pages/messages.html#case-${c.id}` : "/pages/messages.html#tab-cases",
        caseId: c.id || "",
      });
    });

    out.sort((a, b) => {
      const aTs = new Date(a.ts).getTime() || 0;
      const bTs = new Date(b.ts).getTime() || 0;
      return bTs - aTs;
    });

    return out.slice(0, 30);
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
        justify-content: space-between;
        gap: 10px;
        padding: 14px 16px;
        border-bottom: 1px solid #e7eefc;
      }
      #${PANEL_ID} .head h4 {
        margin: 0;
        font-size: 15px;
        font-weight: 800;
        color: #0f172a;
      }
      #${PANEL_ID} .head button {
        border: 1px solid #dbe7fb;
        background: #fff;
        color: #334155;
        border-radius: 999px;
        width: 30px;
        height: 30px;
        font-size: 16px;
        font-weight: 700;
        cursor: pointer;
      }
      #${PANEL_ID} .list {
        padding: 10px;
        max-height: calc(82vh - 62px);
        overflow: auto;
        display: grid;
        gap: 8px;
      }
      #${PANEL_ID} .empty {
        border: 1px dashed #dbe7fb;
        border-radius: 14px;
        padding: 16px;
        font-size: 13px;
        color: #64748b;
        text-align: center;
      }
      #${PANEL_ID} .item {
        border: 1px solid #e7eefc;
        border-radius: 14px;
        background: #fff;
        padding: 10px 12px;
        display: grid;
        grid-template-columns: 8px 1fr auto;
        align-items: center;
        gap: 10px;
        cursor: pointer;
      }
      #${PANEL_ID} .item:hover { border-color: #cfe0fd; background: #f8fbff; }
      #${PANEL_ID} .item.read { opacity: .72; }
      #${PANEL_ID} .bar { width: 8px; height: 28px; border-radius: 999px; }
      #${PANEL_ID} .item.action .bar { background: #f59e0b; }
      #${PANEL_ID} .item.update .bar { background: #2563eb; }
      #${PANEL_ID} .item.support .bar { background: #10b981; }
      #${PANEL_ID} .title {
        font-size: 13px;
        font-weight: 700;
        color: #0f172a;
      }
      #${PANEL_ID} .tag {
        font-size: 10px;
        font-weight: 800;
        border-radius: 999px;
        padding: 4px 8px;
        letter-spacing: .02em;
        text-transform: uppercase;
      }
      #${PANEL_ID} .item.action .tag { color: #92400e; background: #ffedd5; border: 1px solid #fdba74; }
      #${PANEL_ID} .item.update .tag { color: #1d4ed8; background: #dbeafe; border: 1px solid #93c5fd; }
      #${PANEL_ID} .item.support .tag { color: #166534; background: #dcfce7; border: 1px solid #86efac; }
      @media (max-width: 767px) {
        #${PANEL_ID} {
          top: 8px;
          width: calc(100vw - 12px);
          max-height: 88vh;
          border-radius: 16px;
        }
        #${PANEL_ID} .list { max-height: calc(88vh - 62px); }
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
        <button type="button" data-alert-close aria-label="Close alerts">&times;</button>
      </div>
      <div class="list" id="${PANEL_ID}-list"></div>
    `;
    document.body.appendChild(root);
    return root;
  }

  function itemTag(kind) {
    if (kind === "action") return "ACT";
    if (kind === "support") return "RESP";
    return "UPD";
  }

  function renderPanel() {
    const root = ensurePanelRoot();
    const listEl = document.getElementById(`${PANEL_ID}-list`);
    const items = buildAlertItems();
    listEl.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No Updates Yet";
      listEl.appendChild(empty);
      refreshInboxBadges();
      return;
    }

    items.forEach((item) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `item ${item.kind}${item.unread ? "" : " read"}`;
      el.innerHTML = `
        <span class="bar" aria-hidden="true"></span>
        <span class="title">${item.title}</span>
        <span class="tag">${itemTag(item.kind)}</span>
      `;
      el.addEventListener("click", () => {
        markRead(item.id);
        if (item.kind === "support" && item.caseId) updateCaseUnread(item.caseId, false);
        refreshInboxBadges();
        closePanel();
        if (item.target) window.location.href = item.target;
      });
      listEl.appendChild(el);
    });
    refreshInboxBadges();
  }

  function openPanel(triggerEl) {
    const root = ensurePanelRoot();
    renderPanel();
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
    function isMessagesHref(value) {
      const href = typeof value === "string" ? value.trim() : "";
      if (!href) return false;
      const clean = href.split("#")[0];
      return clean.endsWith("messages.html") || clean.endsWith("/pages/messages.html");
    }

    function bindDirectTrigger(el) {
      if (!el || el.__gpAlertBound) return;
      el.__gpAlertBound = true;
      el.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        const root = ensurePanelRoot();
        if (root.classList.contains("show")) closePanel();
        else openPanel(el);
      }, true);
    }

    bindDirectTrigger(document.getElementById("mobileNotifBtn"));

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

      const trigger = targetEl ? targetEl.closest("#mobileNotifBtn") : null;
      if (trigger) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const root = ensurePanelRoot();
        if (root.classList.contains("show")) closePanel();
        else openPanel(trigger);
        return;
      }

      const root = document.getElementById(PANEL_ID);
      if (!root || !root.classList.contains("show")) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      closePanel();
    }, true);

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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      refreshInboxBadges();
      installAlertTriggers();
    });
  } else {
    refreshInboxBadges();
    installAlertTriggers();
  }

  window.addEventListener("storage", (event) => {
    if (event.key === UPDATES_KEY || event.key === SUPPORT_CASES_KEY || event.key === READ_KEY) {
      refreshInboxBadges();
      renderPanel();
    }
  });
})();
