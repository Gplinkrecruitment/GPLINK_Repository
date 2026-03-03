(function () {
  const STATE_KEYS = [
    'gp_epic_progress',
    'gp_amc_progress',
    'gp_ahpra_progress',
    'gp_documents_prep',
    'gp_prepared_docs',
    'gp_selected_country',
    'gp_link_updates',
    'gp_link_updates_read',
    'gpLinkSupportCases',
    'gpLinkMessageDB',
    'gp_account_profile'
  ];
  const SKELETON_TIMEOUT_MS = 12000;
  const SKELETON_STYLE_ID = 'gp-page-skeleton-style';
  const SKELETON_ROOT_ID = 'gp-page-skeleton';

  let hydrated = false;
  let hydratePromise = null;
  let skeletonShown = false;

  function injectSkeletonStyles() {
    if (document.getElementById(SKELETON_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = SKELETON_STYLE_ID;
    style.textContent = `
      #${SKELETON_ROOT_ID} {
        position: fixed;
        inset: 0;
        z-index: 9999;
        background: #eef3fb;
        display: flex;
        align-items: stretch;
        justify-content: center;
        padding: 18px 12px;
      }
      .gp-skeleton-shell {
        width: 100%;
        max-width: 1100px;
      }
      .gp-skeleton-topbar {
        height: 84px;
        border-radius: 16px;
        background: linear-gradient(90deg, #e4ebf6 25%, #f2f6fd 37%, #e4ebf6 63%);
        background-size: 400% 100%;
        animation: gpSkeletonShimmer 1.35s ease-in-out infinite;
        margin-bottom: 12px;
      }
      .gp-skeleton-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      .gp-skeleton-card {
        border-radius: 18px;
        min-height: 220px;
        background: linear-gradient(90deg, #e4ebf6 25%, #f2f6fd 37%, #e4ebf6 63%);
        background-size: 400% 100%;
        animation: gpSkeletonShimmer 1.35s ease-in-out infinite;
      }
      .gp-skeleton-card.tall {
        min-height: 290px;
      }
      @keyframes gpSkeletonShimmer {
        0% { background-position: 100% 50%; }
        100% { background-position: 0 50%; }
      }
      @media (max-width: 900px) {
        .gp-skeleton-grid { grid-template-columns: 1fr; }
      }
    `;
    document.head.appendChild(style);
  }

  function showSkeleton() {
    if (!document.body || skeletonShown) return;
    injectSkeletonStyles();
    const root = document.createElement('div');
    root.id = SKELETON_ROOT_ID;
    root.setAttribute('aria-live', 'polite');
    root.setAttribute('aria-busy', 'true');
    root.innerHTML = `
      <div class="gp-skeleton-shell">
        <div class="gp-skeleton-topbar"></div>
        <div class="gp-skeleton-grid">
          <div class="gp-skeleton-card"></div>
          <div class="gp-skeleton-card"></div>
          <div class="gp-skeleton-card tall"></div>
          <div class="gp-skeleton-card tall"></div>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    document.body.setAttribute('aria-busy', 'true');
    skeletonShown = true;
  }

  function hideSkeleton() {
    const root = document.getElementById(SKELETON_ROOT_ID);
    if (root && root.parentNode) root.parentNode.removeChild(root);
    document.body && document.body.removeAttribute('aria-busy');
    skeletonShown = false;
  }

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
      showSkeleton();
      let stateOk = false;
      const timeout = setTimeout(hideSkeleton, SKELETON_TIMEOUT_MS);

      try {
        const serverState = await fetchState();
        STATE_KEYS.forEach((key) => {
          if (typeof serverState[key] === 'string') {
            localStorage.setItem(key, serverState[key]);
          }
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
        window.dispatchEvent(new CustomEvent('gp-data-ready', { detail: { stateOk } }));
      } catch (err) {
        hydrated = false;
        window.dispatchEvent(new CustomEvent('gp-data-ready', { detail: { stateOk: false } }));
      } finally {
        clearTimeout(timeout);
        hideSkeleton();
      }

      try {
        if (stateOk) {
          await pushState();
        }
      } catch (err) {
        // Non-blocking best-effort sync.
      }
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
