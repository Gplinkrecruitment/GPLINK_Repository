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
})();
