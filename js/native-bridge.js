/**
 * native-bridge.js — Capacitor native API bridge with web fallbacks
 * Loaded on all pages. Provides safe wrappers for native features.
 */
(function () {
  "use strict";

  var isNative = typeof window.Capacitor !== "undefined" && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();

  /**
   * Open a URL externally (in system browser or native app).
   * On native: uses Capacitor Browser plugin.
   * On web: uses window.open.
   */
  window.gpOpenExternal = function (url) {
    if (!url) return;
    if (isNative && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
      window.Capacitor.Plugins.Browser.open({ url: url }).catch(function () {
        window.open(url, "_blank", "noopener");
      });
    } else {
      window.open(url, "_blank", "noopener");
    }
  };

  /**
   * Share content using native share sheet or Web Share API.
   */
  window.gpShare = function (data) {
    if (isNative && window.Capacitor.Plugins && window.Capacitor.Plugins.Share) {
      return window.Capacitor.Plugins.Share.share({
        title: data.title || "",
        text: data.text || "",
        url: data.url || ""
      }).catch(function () {
        return webShare(data);
      });
    }
    return webShare(data);
  };

  function webShare(data) {
    if (navigator.share) {
      return navigator.share(data).catch(function () {});
    }
    if (navigator.clipboard) {
      return navigator.clipboard.writeText(data.url || window.location.href).then(function () {
        if (window.showToast) window.showToast("Link copied to clipboard");
      }).catch(function () {});
    }
    return Promise.resolve();
  }

  /**
   * Get the current platform.
   * Returns: "ios", "android", or "web"
   */
  window.gpPlatform = function () {
    if (!isNative) return "web";
    return (window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || "web";
  };

  /**
   * Check if running in native shell.
   */
  window.gpIsNative = function () {
    return isNative;
  };

  // Apply platform class to document for CSS targeting
  document.documentElement.classList.add("platform-" + window.gpPlatform());

  /* ── Theme toggle ── */
  var THEME_KEY = "gp_theme";

  function applyTheme() {
    var stored = localStorage.getItem(THEME_KEY);
    var isDark = false;
    if (stored === "dark") {
      isDark = true;
    } else if (stored === "light") {
      isDark = false;
    } else {
      isDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    document.documentElement.classList.toggle("dark-mode", isDark);
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  }

  window.gpSetTheme = function (theme) {
    if (theme === "dark" || theme === "light") {
      localStorage.setItem(THEME_KEY, theme);
    } else {
      localStorage.removeItem(THEME_KEY);
    }
    applyTheme();
  };

  window.gpGetTheme = function () {
    return localStorage.getItem(THEME_KEY) || "system";
  };

  window.gpToggleTheme = function () {
    var current = localStorage.getItem(THEME_KEY);
    if (current === "dark") {
      window.gpSetTheme("light");
    } else if (current === "light") {
      window.gpSetTheme("system");
    } else {
      window.gpSetTheme("dark");
    }
    return window.gpGetTheme();
  };

  // Listen for system theme changes
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
      if (!localStorage.getItem(THEME_KEY)) applyTheme();
    });
  }

  // Apply on load
  applyTheme();

  /* ── Service worker registration ── */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () {});
    });
  }

  /* ── Online/offline detection ── */
  function updateOnlineStatus() {
    document.documentElement.classList.toggle("is-offline", !navigator.onLine);
  }
  window.addEventListener("online", updateOnlineStatus);
  window.addEventListener("offline", updateOnlineStatus);
  updateOnlineStatus();

  /* ── Push notifications ── */
  window.gpRegisterPush = function () {
    if (!isNative) return;
    if (!window.Capacitor || !window.Capacitor.Plugins || !window.Capacitor.Plugins.PushNotifications) return;

    var PushNotifications = window.Capacitor.Plugins.PushNotifications;

    PushNotifications.requestPermissions().then(function (result) {
      if (result.receive === "granted") {
        PushNotifications.register();
      }
    }).catch(function () {});

    PushNotifications.addListener("registration", function (token) {
      fetch("/api/push/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          token: token.value,
          platform: window.gpPlatform()
        })
      }).catch(function () {});
    });

    PushNotifications.addListener("pushNotificationReceived", function (notification) {
      // Notification received while app is in foreground — could show in-app toast
    });

    PushNotifications.addListener("pushNotificationActionPerformed", function (notification) {
      var data = notification.notification && notification.notification.data;
      if (data && data.url) {
        try {
          var targetUrl = new URL(data.url, window.location.origin);
          if (targetUrl.origin === window.location.origin) {
            window.location.href = targetUrl.href;
          }
        } catch (e) {}
      }
    });
  };

  // Auto-register on native platforms after a short delay
  if (isNative) {
    setTimeout(function () { window.gpRegisterPush(); }, 2000);
  }

  /* ── Deep linking ── */
  if (isNative && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.addListener("appUrlOpen", function (event) {
      if (event && event.url) {
        try {
          var url = new URL(event.url);
          if (url.pathname.startsWith("/pages/")) {
            window.location.href = url.pathname + url.search;
          }
        } catch (e) {}
      }
    });
  }
})();
