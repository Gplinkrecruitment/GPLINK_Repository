(function () {
  const STATE_KEYS = [
    'gp_epic_progress',
    'gp_amc_progress',
    'gp_ahpra_progress',
    'gp_registration_intro_seen',
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
    'gp_account_profile',
    'gp_career_state',
    'gp_onboarding',
    'gp_onboarding_complete'
  ];
  const SAVE_BATCH_META_SUFFIX = '__save_batch_meta';
  const SESSION_OWNER_KEY = 'gp_state_owner';
  const SESSION_PROFILE_CACHE_KEY = 'gp_session_profile_cache';
  const PROFILE_CACHE_KEY = 'gp_profile_cache';
  const ACCOUNT_STATUS_CACHE_KEY = 'gp_account_status_cache';
  const AUTO_PUSH_DEBOUNCE_MS = 450;
  const PROGRESS_STATE_KEYS = ['gp_epic_progress', 'gp_amc_progress', 'gp_ahpra_progress'];

  let hydrated = false;
  let hydratePromise = null;
  let suppressLocalObserver = false;
  let pendingTrackedChange = false;
  let pushTimer = null;
  let shuttingDown = false;

  async function fetchState() {
    const response = await fetch('/api/state', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('State fetch failed');
    const data = await response.json();
    return data && data.state && typeof data.state === 'object' ? data.state : {};
  }

  async function pushState() {
    if (shuttingDown) return;
    flushTrackedBatches();
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
        localStorage.removeItem(key + SAVE_BATCH_META_SUFFIX);
      });
    });
  }

  function snapshotTrackedLocalState() {
    const snapshot = {};
    STATE_KEYS.forEach((key) => {
      const raw = localStorage.getItem(key);
      if (raw !== null) snapshot[key] = raw;
    });
    return snapshot;
  }

  function parseJsonSafe(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    try { return JSON.parse(raw); } catch (err) { return null; }
  }

  function getUpdatedAtMs(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
    const rawTs = typeof parsed.updatedAt === 'string'
      ? parsed.updatedAt
      : (typeof parsed.updated_at === 'string' ? parsed.updated_at : '');
    const ts = Date.parse(rawTs);
    return Number.isFinite(ts) ? ts : 0;
  }

  function getProgressCompletionScore(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return -1;
    const completed = parsed.completed && typeof parsed.completed === 'object' ? parsed.completed : null;
    if (!completed) return -1;
    return Object.keys(completed).reduce((count, key) => count + (completed[key] === true ? 1 : 0), 0);
  }

  function chooseTrackedStateValue(key, localRaw, serverRaw) {
    if (typeof localRaw !== 'string') return typeof serverRaw === 'string' ? serverRaw : null;
    if (typeof serverRaw !== 'string') return localRaw;
    if (localRaw === serverRaw) return localRaw;

    const localParsed = parseJsonSafe(localRaw);
    const serverParsed = parseJsonSafe(serverRaw);
    const localTs = getUpdatedAtMs(localParsed);
    const serverTs = getUpdatedAtMs(serverParsed);

    if (localTs && serverTs && localTs !== serverTs) {
      return localTs > serverTs ? localRaw : serverRaw;
    }
    if (localTs && !serverTs) return localRaw;
    if (serverTs && !localTs) return serverRaw;

    if (PROGRESS_STATE_KEYS.indexOf(key) !== -1) {
      const localScore = getProgressCompletionScore(localParsed);
      const serverScore = getProgressCompletionScore(serverParsed);
      if (localScore !== serverScore) {
        return localScore > serverScore ? localRaw : serverRaw;
      }
    }

    return serverRaw;
  }

  function mergeTrackedState(localState, serverState) {
    const merged = {};
    STATE_KEYS.forEach((key) => {
      const mergedValue = chooseTrackedStateValue(key, localState[key], serverState[key]);
      if (typeof mergedValue === 'string') merged[key] = mergedValue;
    });
    return merged;
  }

  function trackedStateDiffers(a, b) {
    return STATE_KEYS.some((key) => {
      const aValue = typeof a[key] === 'string' ? a[key] : null;
      const bValue = typeof b[key] === 'string' ? b[key] : null;
      return aValue !== bValue;
    });
  }

  // Detect if localStorage belongs to a different user and wipe it immediately.
  // This runs synchronously before any page rendering to prevent data leaks.
  function enforceOwnership(email) {
    if (!email) return;
    var currentOwner = '';
    try { currentOwner = localStorage.getItem(SESSION_OWNER_KEY) || ''; } catch (e) {}
    if (currentOwner && currentOwner !== email) {
      // Different user — clear all previous user's data immediately
      clearTrackedLocalState();
    }
    try { localStorage.setItem(SESSION_OWNER_KEY, email); } catch (e) {}
  }

  function flushBatchedStorageKey(storageKey) {
    var metaKey = storageKey + SAVE_BATCH_META_SUFFIX;
    var raw = localStorage.getItem(metaKey);
    if (!raw) return;

    var meta = null;
    try { meta = JSON.parse(raw); } catch (err) { meta = null; }
    if (!meta || typeof meta !== 'object') return;
    var pending = Number.isInteger(meta.pending) ? meta.pending : 0;
    var lastValue = typeof meta.lastValue === 'string' ? meta.lastValue : '';
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
    if (shuttingDown) return;
    pendingTrackedChange = true;
    if (pushTimer) window.clearTimeout(pushTimer);
    pushTimer = window.setTimeout(async () => {
      pushTimer = null;
      if (!pendingTrackedChange) return;
      if (!hydrated) return;
      if (shuttingDown) return;
      pendingTrackedChange = false;
      flushTrackedBatches();
      await pushState();
    }, AUTO_PUSH_DEBOUNCE_MS);
  }

  function isTrackedStateKey(key) {
    return STATE_KEYS.indexOf(String(key || '')) !== -1;
  }

  function installLocalStorageObserver() {
    var originalSetItem = localStorage.setItem.bind(localStorage);
    var originalRemoveItem = localStorage.removeItem.bind(localStorage);

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
      var stateOk = false;

      try {
        // Get current user email from session to enforce ownership
        var sessionEmail = '';
        try {
          var session = window.gpSessionPromise ? await window.gpSessionPromise : null;
          if (session && session.ok && session.profile && session.profile.email) {
            sessionEmail = session.profile.email;
          }
        } catch (e) {}

        // Immediately clear stale data if user changed (synchronous, before any rendering)
        if (sessionEmail) enforceOwnership(sessionEmail);

        flushTrackedBatches();
        var localState = snapshotTrackedLocalState();
        var serverState = await fetchState();
        var mergedState = mergeTrackedState(localState, serverState);
        var shouldPushMergedState = trackedStateDiffers(mergedState, serverState);
        clearTrackedLocalState();
        withSuppressedObserver(() => {
          STATE_KEYS.forEach((key) => {
            if (typeof mergedState[key] === 'string') {
              localStorage.setItem(key, mergedState[key]);
            }
          });
        });
        if (shouldPushMergedState) pendingTrackedChange = true;
        stateOk = true;
        hydrated = true;
        window.dispatchEvent(new Event('gp-state-hydrated'));
      } catch (err) {
        // Hydration failed — clear all user data so stale data is never shown
        hydrated = false;
        clearTrackedLocalState();
      } finally {
        window.dispatchEvent(new CustomEvent('gp-data-ready', { detail: { stateOk: stateOk } }));
      }

      if (stateOk && pendingTrackedChange && !shuttingDown) {
        pendingTrackedChange = false;
        flushTrackedBatches();
        pushState().catch(() => {});
      }
    })();

    return hydratePromise;
  }

  function beginShutdown() {
    shuttingDown = true;
    if (pushTimer) { window.clearTimeout(pushTimer); pushTimer = null; }
    pendingTrackedChange = false;
    hydrated = false;
    clearTrackedLocalState();
    try { localStorage.removeItem(SESSION_OWNER_KEY); } catch (e) {}
    try { localStorage.removeItem('gp_account_under_review'); } catch (e) {}
    try { sessionStorage.removeItem(SESSION_PROFILE_CACHE_KEY); } catch (e) {}
    try { sessionStorage.removeItem(PROFILE_CACHE_KEY); } catch (e) {}
    try { sessionStorage.removeItem(ACCOUNT_STATUS_CACHE_KEY); } catch (e) {}
  }

  window.gpLinkStateSync = {
    hydrate: hydrateState,
    push: pushState,
    isHydrated: function () { return hydrated; },
    shutdown: beginShutdown
  };

  function scheduleHydrate() {
    // Hydrate as soon as possible — don't defer with requestIdleCallback
    // to minimise the window where stale data could be visible.
    window.setTimeout(() => hydrateState(), 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleHydrate);
  } else {
    scheduleHydrate();
  }

  installLocalStorageObserver();

  document.addEventListener('visibilitychange', () => {
    if (!shuttingDown && document.visibilityState === 'hidden') {
      if (pushTimer) { window.clearTimeout(pushTimer); pushTimer = null; }
      pendingTrackedChange = false;
      pushState();
    }
  });
  window.addEventListener('beforeunload', () => {
    if (!shuttingDown) {
      if (pushTimer) { window.clearTimeout(pushTimer); pushTimer = null; }
      pendingTrackedChange = false;
      pushState();
    }
  });
})();
