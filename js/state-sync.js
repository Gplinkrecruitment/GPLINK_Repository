(function () {
  const STATE_KEYS = [
    'gp_epic_progress',
    'gp_amc_progress',
    'gp_ahpra_progress',
    'gp_epic_tutorial_seen',
    'gp_amc_tutorial_seen',
    'gp_ahpra_tutorial_seen',
    'gp_documents_prep',
    'gp_prepared_docs',
    'gp_selected_country',
    'gp_link_updates',
    'gp_link_updates_read',
    'gpLinkSupportCases',
    'gpLinkMessageDB',
    'gpLinkSupportDraft',
    'gp_account_profile'
  ];
  const SAVE_BATCH_META_SUFFIX = '__save_batch_meta';
  const AUTO_PUSH_DEBOUNCE_MS = 450;

  let hydrated = false;
  let hydratePromise = null;
  let suppressLocalObserver = false;
  let pendingTrackedChange = false;
  let pushTimer = null;
  let earlyReadyDispatched = false;

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

  function withSuppressedObserver(fn) {
    suppressLocalObserver = true;
    try {
      return fn();
    } finally {
      suppressLocalObserver = false;
    }
  }

  function clearTrackedLocalState() {
    withSuppressedObserver(() => {
      STATE_KEYS.forEach((key) => {
        localStorage.removeItem(key);
        localStorage.removeItem(`${key}${SAVE_BATCH_META_SUFFIX}`);
      });
    });
  }

  function flushBatchedStorageKey(storageKey) {
    const metaKey = `${storageKey}${SAVE_BATCH_META_SUFFIX}`;
    const raw = localStorage.getItem(metaKey);
    if (!raw) return;

    let meta = null;
    try { meta = JSON.parse(raw); } catch (err) { meta = null; }
    if (!meta || typeof meta !== 'object') return;
    const pending = Number.isInteger(meta.pending) ? meta.pending : 0;
    const lastValue = typeof meta.lastValue === 'string' ? meta.lastValue : '';
    if (pending > 0 && lastValue) {
      localStorage.setItem(storageKey, lastValue);
      meta.pending = 0;
      localStorage.setItem(metaKey, JSON.stringify(meta));
    }
  }

  function flushTrackedBatches() {
    withSuppressedObserver(() => {
      STATE_KEYS.forEach(flushBatchedStorageKey);
    });
  }

  function scheduleAutoPush() {
    pendingTrackedChange = true;
    if (pushTimer) window.clearTimeout(pushTimer);
    pushTimer = window.setTimeout(async () => {
      pushTimer = null;
      if (!pendingTrackedChange) return;
      if (!hydrated) return;
      pendingTrackedChange = false;
      flushTrackedBatches();
      await pushState();
    }, AUTO_PUSH_DEBOUNCE_MS);
  }

  function isTrackedStateKey(key) {
    return STATE_KEYS.indexOf(String(key || '')) !== -1;
  }

  function installLocalStorageObserver() {
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const originalRemoveItem = localStorage.removeItem.bind(localStorage);

    localStorage.setItem = function patchedSetItem(key, value) {
      originalSetItem(key, value);
      if (suppressLocalObserver) return;
      if (isTrackedStateKey(key)) scheduleAutoPush();
      if (typeof key === 'string' && key.endsWith(SAVE_BATCH_META_SUFFIX)) scheduleAutoPush();
    };

    localStorage.removeItem = function patchedRemoveItem(key) {
      originalRemoveItem(key);
      if (suppressLocalObserver) return;
      if (isTrackedStateKey(key)) scheduleAutoPush();
      if (typeof key === 'string' && key.endsWith(SAVE_BATCH_META_SUFFIX)) scheduleAutoPush();
    };
  }

  async function hydrateState() {
    if (hydratePromise) return hydratePromise;

    hydratePromise = (async () => {
      // Unblock page rendering immediately; hydrate state in the background.
      if (!earlyReadyDispatched) {
        earlyReadyDispatched = true;
        window.dispatchEvent(new CustomEvent('gp-data-ready', { detail: { stateOk: true, fastPath: true } }));
      }
      let stateOk = false;

      try {
        const serverState = await fetchState();
        clearTrackedLocalState();
        withSuppressedObserver(() => {
          STATE_KEYS.forEach((key) => {
            if (typeof serverState[key] === 'string') {
              localStorage.setItem(key, serverState[key]);
            }
          });
        });
        stateOk = true;

        try {
          const cachedProfile = localStorage.getItem('gp_account_profile');
          if (cachedProfile && typeof cachedProfile === 'string') {
            // Keep existing profile cache available to pages that read from localStorage.
            localStorage.setItem('gp_account_profile', cachedProfile);
          }
        } catch (err) {
        }

        hydrated = stateOk;
        if (stateOk) {
          window.dispatchEvent(new Event('gp-state-hydrated'));
        }
      } catch (err) {
        hydrated = false;
      } finally {
        // Keep legacy pages compatible if they wait for this event more than once.
        window.dispatchEvent(new CustomEvent('gp-data-ready', { detail: { stateOk } }));
      }

      // Do not immediately push full state on page load.
      // This causes large payload uploads and slows navigation.
      if (stateOk && pendingTrackedChange) {
        pendingTrackedChange = false;
        flushTrackedBatches();
        pushState().catch(() => {});
      }
    })();

    return hydratePromise;
  }

  window.gpLinkStateSync = {
    hydrate: hydrateState,
    push: pushState,
    isHydrated: function () { return hydrated; }
  };

  function scheduleHydrate() {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => hydrateState(), { timeout: 2200 });
      return;
    }
    window.setTimeout(() => hydrateState(), 180);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleHydrate);
  } else {
    scheduleHydrate();
  }

  installLocalStorageObserver();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pushState();
  });
  window.addEventListener('beforeunload', pushState);
})();
