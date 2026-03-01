(function () {
  const STATE_KEYS = [
    'gp_epic_progress',
    'gp_amc_progress',
    'gp_documents_prep',
    'gp_prepared_docs',
    'gp_selected_country',
    'gp_link_updates',
    'gp_link_updates_read',
    'gpLinkSupportCases',
    'gpLinkMessageDB',
    'gp_account_profile'
  ];

  let hydrated = false;
  let hydratePromise = null;

  async function fetchState() {
    const response = await fetch('/api/state', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('State fetch failed');
    const data = await response.json();
    return data && data.state && typeof data.state === 'object' ? data.state : {};
  }

  async function pushState() {
    const payload = { state: {} };
    STATE_KEYS.forEach((key) => {
      const raw = localStorage.getItem(key);
      if (raw !== null) payload.state[key] = raw;
    });

    try {
      await fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      });
    } catch (err) {
      // Non-blocking best-effort sync.
    }
  }

  async function hydrateState() {
    if (hydratePromise) return hydratePromise;

    hydratePromise = (async () => {
      try {
        const serverState = await fetchState();
        STATE_KEYS.forEach((key) => {
          if (typeof serverState[key] === 'string') {
            localStorage.setItem(key, serverState[key]);
          }
        });
        hydrated = true;
        window.dispatchEvent(new Event('gp-state-hydrated'));
      } catch (err) {
        hydrated = false;
      }

      try {
        await pushState();
      } catch (err) {}
    })();

    return hydratePromise;
  }

  window.gpLinkStateSync = {
    hydrate: hydrateState,
    push: pushState,
    isHydrated: function () { return hydrated; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hydrateState);
  } else {
    hydrateState();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pushState();
  });
  window.addEventListener('beforeunload', pushState);
})();
