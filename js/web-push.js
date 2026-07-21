/* GP Link — standards-based Web Push (VAPID) client helper. Phase 6 J1.
   Exposes window.gpWebPush with:
     isSupported()  -> boolean (browser has SW + PushManager + Notification)
     getStatus()    -> Promise<{supported, permission, subscribed}>
     enable()       -> Promise<{ok, reason?}> — asks permission, subscribes,
                       POSTs the subscription to /api/push/subscribe
     disable()      -> Promise<{ok}> — unsubscribes + removes it server-side
   Reasons on failure: "unsupported" | "not-configured" | "denied" | "error".
   Call enable() from a user gesture (browsers block permission prompts
   otherwise). */
(function () {
  "use strict";

  function isSupported() {
    return typeof window !== "undefined"
      && "serviceWorker" in navigator
      && "PushManager" in window
      && "Notification" in window;
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  function getRegistration() {
    return navigator.serviceWorker.getRegistration("/").then(function (registration) {
      if (registration) return registration;
      return navigator.serviceWorker.register("/sw.js");
    }).then(function (registration) {
      // Wait until the SW is active so pushManager.subscribe can't race install.
      return navigator.serviceWorker.ready.then(function (ready) {
        return registration || ready;
      });
    });
  }

  function fetchVapidPublicKey() {
    return fetch("/api/push/vapid-public-key", { credentials: "same-origin" })
      .then(function (response) { return response.json(); })
      .catch(function () { return null; });
  }

  function getStatus() {
    if (!isSupported()) {
      return Promise.resolve({ supported: false, permission: "unsupported", subscribed: false });
    }
    return navigator.serviceWorker.getRegistration("/").then(function (registration) {
      if (!registration) return null;
      return registration.pushManager.getSubscription();
    }).then(function (subscription) {
      return { supported: true, permission: Notification.permission, subscribed: !!subscription };
    }).catch(function () {
      return { supported: true, permission: Notification.permission, subscribed: false };
    });
  }

  function enable() {
    if (!isSupported()) return Promise.resolve({ ok: false, reason: "unsupported" });
    return fetchVapidPublicKey().then(function (keyResponse) {
      if (!keyResponse || !keyResponse.ok || !keyResponse.publicKey) {
        return { ok: false, reason: "not-configured" };
      }
      return Promise.resolve(Notification.requestPermission()).then(function (permission) {
        if (permission !== "granted") return { ok: false, reason: "denied" };
        return getRegistration().then(function (registration) {
          return registration.pushManager.getSubscription().then(function (existing) {
            if (existing) return existing;
            return registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(keyResponse.publicKey)
            });
          });
        }).then(function (subscription) {
          var json = subscription.toJSON();
          return fetch("/api/push/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys })
          }).then(function (response) {
            return response.ok ? { ok: true } : { ok: false, reason: "error" };
          });
        });
      });
    }).catch(function () {
      return { ok: false, reason: "error" };
    });
  }

  function disable() {
    if (!isSupported()) return Promise.resolve({ ok: true });
    return navigator.serviceWorker.getRegistration("/").then(function (registration) {
      if (!registration) return null;
      return registration.pushManager.getSubscription();
    }).then(function (subscription) {
      if (!subscription) return { ok: true };
      var endpoint = subscription.endpoint;
      return Promise.resolve(subscription.unsubscribe()).catch(function () {}).then(function () {
        return fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ endpoint: endpoint })
        }).catch(function () {});
      }).then(function () {
        return { ok: true };
      });
    }).catch(function () {
      return { ok: true };
    });
  }

  window.gpWebPush = {
    isSupported: isSupported,
    getStatus: getStatus,
    enable: enable,
    disable: disable
  };
})();
