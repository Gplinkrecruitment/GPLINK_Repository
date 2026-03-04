(function () {
  const UPDATES_KEY = "gp_link_updates";

  const DEFAULT_UPDATES = [];

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
    const raw = localStorage.getItem(UPDATES_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      const clean = sanitizeUpdates(parsed);
      return clean.length ? clean : null;
    } catch (err) {
      return null;
    }
  }

  function saveGpLinkUpdates(updates) {
    const clean = sanitizeUpdates(updates);
    const finalUpdates = clean.length ? clean : [];
    localStorage.setItem(UPDATES_KEY, JSON.stringify(finalUpdates));
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

  function refreshInboxBadges() {
    const hasAction = hasGpLinkActionRequired(getGpLinkUpdates());
    const badges = document.querySelectorAll("[data-inbox-alert]");
    badges.forEach((badge) => {
      badge.hidden = !hasAction;
      badge.setAttribute("aria-hidden", hasAction ? "false" : "true");
    });
  }

  window.getGpLinkUpdates = getGpLinkUpdates;
  window.saveGpLinkUpdates = saveGpLinkUpdates;
  window.hasGpLinkActionRequired = hasGpLinkActionRequired;
  window.refreshInboxBadges = refreshInboxBadges;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", refreshInboxBadges);
  } else {
    refreshInboxBadges();
  }

  window.addEventListener("storage", (event) => {
    if (event.key === UPDATES_KEY) refreshInboxBadges();
  });
})();
