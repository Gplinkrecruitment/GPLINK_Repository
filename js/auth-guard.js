(function () {
  const pathname = window.location.pathname;
  const isSignInPage = pathname === "/pages/signin.html";
  const isPublicPage =
    isSignInPage ||
    pathname === "/pages/privacy.html" ||
    pathname === "/pages/terms.html";

  const sessionPromise = fetch("/api/auth/session", { credentials: "same-origin" })
    .then(async (response) => {
      if (!response.ok) {
        return { ok: false, authenticated: false, profile: null };
      }
      const data = await response.json().catch(() => ({}));
      const profile = data && data.profile && typeof data.profile === "object" ? data.profile : null;
      return { ok: true, authenticated: true, profile };
    })
    .catch(() => ({ ok: false, authenticated: false, profile: null }));

  // Expose one shared promise so pages can reuse session data without extra round-trips.
  window.gpSessionPromise = sessionPromise;

  const isOnboardingPage = pathname === "/pages/onboarding.html";

  sessionPromise.then((session) => {
    if (session && session.ok) {
      window.gpSessionProfile = session.profile || null;

      // Check if onboarding is complete; if not, redirect to onboarding
      // (skip this check if already on onboarding page to avoid redirect loops)
      if (!isOnboardingPage && !isSignInPage) {
        try {
          const obRaw = localStorage.getItem("gp_onboarding");
          const ob = obRaw ? JSON.parse(obRaw) : null;
          if (!ob || !ob.completedAt) {
            window.location.replace("/pages/onboarding.html");
            return;
          }
        } catch (e) { /* if parse fails, continue normally */ }
      }

      if (isSignInPage) {
        window.location.replace("/pages/index.html");
      }
      return;
    }
    if (!isPublicPage && !isOnboardingPage) {
      window.location.replace("/pages/signin.html");
    }
  });
})();
