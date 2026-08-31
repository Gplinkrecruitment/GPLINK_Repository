/* GP Link service worker: conservative static cache + offline fallback. */
(function () {
  "use strict";

  // 20260728b: the CSP img-src fix (dcd3249) that unblocked the Supabase
  // storage hero images ships in a RESPONSE HEADER, and PAGE_CACHE stores whole
  // responses — headers included. 20260728a was already live when that fix
  // deployed, so app pages kept being served from cache with the OLD CSP and
  // the career page still showed broken practice photos while the marketing
  // site (never precached) looked fixed. Bumping purges + re-precaches.
  // 20260729a: career.html gained the hired practice's website link on the
  // placement hero. The career page is precached in PAGE_CACHE, so without a
  // bump an already-placed GP would keep being served the old markup.
  // 20260731a: career.html + job.html + account.html changed together — the
  // rebuilt application card, the in-card interview picker, and the first-visit
  // careers explainer. career.html and account.html are both precached in
  // PAGE_CACHE, so without a bump a doctor keeps being served the old markup
  // for a navigation (and the explainer would not appear at all on the visit
  // that matters — their first).
  // 20260803b: follow-up — `el.hidden = true` did NOTHING for the Join / Add-to-Calendar
  // buttons because their own CSS sets display:flex, which beats the browser's [hidden]
  // rule; and "Next step" still said "Confirm your interview time" after the interview.
  // 20260803a: index.html + career.html + application-detail.html changed together —
  // the onboarding gateway now fails open when /api/state does not actually answer
  // (a 401 straight after sign-in was marching fully-onboarded doctors back through
  // onboarding), and the interview cards now end the interview instead of showing
  // "Interview confirmed" plus a live Join forever. index and career are both
  // precached in PAGE_CACHE, so without a bump a doctor keeps the old markup for a
  // navigation — which for the gateway means being bounced to onboarding one more time.
  // 20260811a: amc.html's "Open AMC" button opened AMC with window.location, which
  // inside the app shell's iframe meant framing account.amc.org.au — refused by its
  // X-Frame-Options and by our own CSP frame-src, silently, so the button did nothing.
  // /pages/amc is precached in PAGE_CACHE, so without a bump a doctor sitting on the
  // AMC step keeps the dead button for a navigation.
  // 20260811b: the rest of the same class, found by sweeping all 18 shell-embedded
  // pages — "Open AHPRA" (both AHPRA steps) had the identical window.location bug, the
  // two GMC sign-in links in the Certificate-of-Good-Standing help had no target so
  // they navigated the frame, and the MyIntealth / WhatsApp popup-blocked fallbacks
  // pointed at the frame too. ahpra, myinthealth and messages are all precached.
  // 20260813a: document auto-crop. The upload pages (onboarding, Documents,
  // AHPRA) gained a script tag, and pages are served stale-while-revalidate from
  // VERSION-keyed caches, so without this bump the new HTML lands a navigation
  // late and the crop looks like it never shipped.
  // 20260814a: career.html declared `currentChecklistItems` twice, which is a
  // parse-time SyntaxError — the whole script block died, so My Practice showed
  // a permanent spinner and the crash toast. The fixed HTML only reaches a
  // doctor who already has the broken page cached if VERSION moves.
  // 20260814b: index.html's journey list stopped rebuilding itself on every
  // cross-tab gp_career_state event, which was destroying the "Continue" anchor
  // between finger-down and click — the AHPRA step's button did nothing for a
  // doctor with several tabs open. 20260814a had already shipped, so a doctor
  // who cached that generation needs a further bump to be served the fix.
  // 20260814c: ahpra.html now tells a doctor who has finished her own documents that the
  // only thing left is the pack WE prepare with the practice, and lists those items (the
  // "GP Link Prepares" group was dead code before, so that screen showed her a
  // "Complete Now" button for work she could not do). /pages/ahpra is precached.
  // 20260818a: a completed journey step can be revisited. index.html's done row now
  // links into the step instead of showing an inert "Completed" chip, and
  // myinthealth/amc/ahpra open READ-ONLY rather than bouncing the doctor on to their
  // next unfinished stage. index.html also stopped claiming "Placement secured" for
  // any doctor whose case stage had merely moved off 'placement'. All five of those
  // pages are precached and served stale-while-revalidate, so without this bump the
  // fixes land a navigation late and read as never shipped.
  // 20260822a: Meta pixel added to every site-*.html head. Marketing pages are
  // not precached, but a doctor who has used the app gets marketing navigations
  // served stale-while-revalidate from PAGE_CACHE, so without this bump the
  // pixel lands a navigation late for exactly the returning visitors it should
  // be measuring.
  var VERSION = "20260831a";
  var STATIC_CACHE = "gp-link-static-" + VERSION;
  var PAGE_CACHE = "gp-link-pages-" + VERSION;
  var RUNTIME_CACHE = "gp-link-runtime-" + VERSION;
  var IMAGE_CACHE = "gp-link-images-" + VERSION;
  var CACHE_NAMES = [STATIC_CACHE, PAGE_CACHE, RUNTIME_CACHE, IMAGE_CACHE];
  // Offline/error path only: how long to give the network before a cached
  // page may answer a request that had no cache entry to serve instantly.
  var PAGE_TIMEOUT_MS = 4000;

  // Precache manifest. Page entries MUST be the extensionless embedded
  // variants the app shell actually requests ("/pages/career?gp_shell=…"):
  // the server 302-redirects "/pages/career.html" to the clean URL, redirected
  // responses are never cached (shouldCacheResponse), and an entry keyed under
  // the .html URL would not match the shell's requests anyway — the old .html
  // manifest precached NOTHING, so every page open paid a full network fetch.
  // JS busters must track what the pages currently ship with
  // (alerts-panel.test.js pins updates-sync structurally).
  var CORE_URLS = [
    "/pages/app-shell",
    "/pages/index?gp_shell=embedded&gp_shell_static=1",
    "/pages/myinthealth?gp_shell=embedded&gp_shell_static=1",
    "/pages/amc?gp_shell=embedded&gp_shell_static=1",
    "/pages/ahpra?gp_shell=embedded&gp_shell_static=1",
    "/pages/career?gp_shell=embedded&gp_shell_static=1",
    "/pages/visa?gp_shell=embedded&gp_shell_static=1",
    "/pages/pbs?gp_shell=embedded&gp_shell_static=1",
    "/pages/messages?gp_shell=embedded&gp_shell_static=1",
    "/pages/account?gp_shell=embedded&gp_shell_static=1",
    "/pages/my-documents?gp_shell=embedded&gp_shell_static=1",
    "/pages/registration-intro?gp_shell=embedded&gp_shell_static=1",
    "/pages/signin",
    "/js/app-shell.js?v=20260818a",
    "/js/nav-shell-bridge.js?v=20260709a",
    "/js/api-dedupe.js?v=20260729a",
    "/js/auth-guard.js?v=20260810a",
    "/js/state-sync.js?v=20260711a",
    "/js/bypass-config.js?v=20260724c",
    "/js/updates-sync.js?v=20260730a",
    "/js/qualification-scan.js?v=20260715a",
    "/js/qualification-camera.js?v=20260614a",
    "/js/account-dropdown.js?v=20260527a",
    "/js/onboarding.js?v=20260722b",
    "/js/error-reporter.js?v=20260720a",
    "/js/web-push.js?v=20260707a",
    "/js/gp-cache.js?v=20260707a",
    "/js/perf-cache.js?v=20260628b",
    "/js/journey-stages.js?v=20260722c",
    "/js/native-bridge.js?v=20260707a",
    "/js/match-popup.js?v=20260707b",
    "/js/gp-coach.js?v=20260724a",
    "/js/gp-walkthrough-state.js?v=20260722c",
    "/js/gp-walkthrough.js?v=20260722d",
    "/js/gp-walkthrough-shell.js?v=20260724a",
    "/js/document-prep.js?v=20260614a",
    "/js/career-home-card.js?v=20260709a"
  ];

  function toUrl(value) {
    try {
      return new URL(value, self.location.origin);
    } catch (err) {
      return null;
    }
  }

  function isSameOrigin(url) {
    return !!url && url.origin === self.location.origin;
  }

  function extensionOf(pathname) {
    var match = String(pathname || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? "." + match[1] : "";
  }

  function hasVersionParam(url) {
    return !!(url && url.searchParams && url.searchParams.has("v"));
  }

  function isPageDocument(request, url) {
    return request.mode === "navigate"
      || request.destination === "document"
      || (/^\/pages\/.+\.html$/i.test(url.pathname));
  }

  // Staff consoles (RSO command centre, CEO dashboard, admin sign-in) are NEVER
  // cached. Page documents are served stale-while-revalidate, which means a
  // deploy that changes a page's HTML without bumping VERSION shows staff the
  // OLD console until their next navigation. That is fine for a GP-facing page
  // and actively harmful here: on 2026-07-27 the "upload into Prepared by
  // Candidate" controls shipped, and the owner still saw a console with no
  // upload buttons a day later because their browser held the pre-deploy HTML.
  // These pages are behind an admin session, are useless offline (every panel is
  // API-driven) and change most days, so correctness beats the cached paint.
  // Covers the clean URLs and the .html variants, plus admin-signin/-visa/-pbs.
  function isStaffConsolePage(url) {
    return !!url && /^\/pages\/(admin|ceo-dashboard)/i.test(url.pathname);
  }

  function isImmutableAsset(url) {
    if (!url) return false;
    var ext = extensionOf(url.pathname);
    if (url.pathname.indexOf("/media/") === 0 || url.pathname.indexOf("/documents/") === 0) return true;
    if (hasVersionParam(url) && [".js", ".css", ".json", ".svg"].indexOf(ext) !== -1) return true;
    return [".png", ".jpg", ".jpeg", ".webp", ".avif", ".svg", ".ico", ".woff", ".woff2", ".pdf"].indexOf(ext) !== -1;
  }

  function isRuntimeStatic(url) {
    if (!url) return false;
    var ext = extensionOf(url.pathname);
    return [".js", ".css", ".json", ".svg"].indexOf(ext) !== -1;
  }

  function isSafeRuntimeApi(url) {
    if (!url) return false;
    return url.pathname === "/api/media-config";
  }

  function shouldCacheResponse(response) {
    if (!response || response.status !== 200) return false;
    if (response.redirected) return false;
    var cacheControl = response.headers.get("Cache-Control") || "";
    return !/\bno-store\b/i.test(cacheControl);
  }

  function putIfCacheable(cacheName, request, response) {
    if (!shouldCacheResponse(response)) return Promise.resolve(response);
    return caches.open(cacheName).then(function (cache) {
      return cache.put(request, response.clone()).then(function () {
        return response;
      });
    }).catch(function () {
      return response;
    });
  }

  function cacheFirst(request, cacheName) {
    return caches.match(request).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        return putIfCacheable(cacheName, request, response);
      });
    });
  }

  function networkFirst(request, cacheName, timeoutMs) {
    var timeoutId = 0;
    var timedFallback = new Promise(function (resolve) {
      timeoutId = setTimeout(function () {
        caches.match(request).then(function (cached) {
          if (cached) resolve(cached);
        });
      }, timeoutMs || PAGE_TIMEOUT_MS);
    });

    var network = fetch(request).then(function (response) {
      clearTimeout(timeoutId);
      return putIfCacheable(cacheName, request, response);
    }).catch(function () {
      clearTimeout(timeoutId);
      return caches.match(request).then(function (cached) {
        if (cached) return cached;
        throw new Error("network-and-cache-miss");
      });
    });

    return Promise.race([network, timedFallback]).then(function (response) {
      return response || network;
    });
  }

  function staleWhileRevalidate(request, cacheName) {
    var fetchPromise = fetch(request).then(function (response) {
      return putIfCacheable(cacheName, request, response);
    }).catch(function () {
      return null;
    });

    return caches.match(request).then(function (cached) {
      return cached || fetchPromise;
    }).then(function (response) {
      if (response) return response;
      return fetch(request);
    });
  }

  function warmUrls(urls) {
    if (!Array.isArray(urls) || !urls.length) return Promise.resolve();
    return caches.open(RUNTIME_CACHE).then(function (cache) {
      return Promise.all(urls.map(function (value) {
        var url = toUrl(value);
        if (!isSameOrigin(url)) return Promise.resolve();
        var request = new Request(url.toString(), {
          method: "GET",
          credentials: "same-origin",
          cache: "reload"
        });
        return fetch(request).then(function (response) {
          if (shouldCacheResponse(response)) return cache.put(request, response.clone());
          return null;
        }).catch(function () {});
      }));
    });
  }

  self.addEventListener("install", function (event) {
    event.waitUntil(
      caches.open(STATIC_CACHE).then(function (cache) {
        return Promise.all(CORE_URLS.map(function (url) {
          var request = new Request(url, { credentials: "same-origin" });
          return fetch(request).then(function (response) {
            if (shouldCacheResponse(response)) return cache.put(request, response.clone());
            return null;
          }).catch(function () {});
        }));
      }).then(function () {
        return self.skipWaiting();
      })
    );
  });

  self.addEventListener("activate", function (event) {
    event.waitUntil(
      caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (key) {
          return CACHE_NAMES.indexOf(key) === -1 ? caches.delete(key) : Promise.resolve();
        }));
      }).then(function () {
        return self.clients.claim();
      })
    );
  });

  self.addEventListener("message", function (event) {
    var data = event && event.data ? event.data : {};
    if (data.type === "GP_SKIP_WAITING") {
      self.skipWaiting();
      return;
    }
    if (data.type === "GP_CACHE_URLS") {
      event.waitUntil(warmUrls(data.urls || []));
    }
  });

  /* ── Web Push (VAPID) — Phase 6 J1 ── */
  var NOTIFICATION_ICON = "/media/icons/gp-link-icon-192.png";
  var DEFAULT_NOTIFICATION_URL = "/pages/app-shell.html";

  self.addEventListener("push", function (event) {
    var payload = {};
    try {
      payload = event.data ? event.data.json() : {};
    } catch (err) {
      payload = { body: event.data ? String(event.data.text() || "") : "" };
    }
    if (!payload || typeof payload !== "object") payload = {};
    var title = payload.title || "GP Link";
    var options = {
      body: payload.body || "",
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_ICON,
      data: { url: payload.url || DEFAULT_NOTIFICATION_URL }
    };
    event.waitUntil(self.registration.showNotification(title, options));
  });

  self.addEventListener("notificationclick", function (event) {
    event.notification.close();
    var rawUrl = event.notification && event.notification.data && event.notification.data.url
      ? event.notification.data.url
      : DEFAULT_NOTIFICATION_URL;
    var target = toUrl(rawUrl);
    if (!isSameOrigin(target)) target = toUrl(DEFAULT_NOTIFICATION_URL);

    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windowClients) {
        for (var i = 0; i < windowClients.length; i++) {
          var client = windowClients[i];
          if (!isSameOrigin(toUrl(client.url))) continue;
          var focused = "focus" in client ? client.focus() : Promise.resolve(client);
          if ("navigate" in client && client.url !== target.href) {
            return Promise.resolve(focused).then(function (c) {
              var live = c || client;
              return live.navigate(target.href).catch(function () { return live; });
            });
          }
          return focused;
        }
        if (self.clients.openWindow) return self.clients.openWindow(target.href);
        return null;
      }).catch(function () {})
    );
  });

  self.addEventListener("fetch", function (event) {
    var request = event.request;
    var url = toUrl(request && request.url);

    // Practice hero images live on the Supabase storage origin — cache-first,
    // else every Roles/Saved/Offers tab switch re-downloads every thumbnail.
    if (request.method === "GET" && url && url.pathname.indexOf("/storage/v1/object/public/career-hero-images/") !== -1) {
      event.respondWith(
        caches.match(request).then(function (cached) {
          if (cached) return cached;
          return fetch(request).then(function (response) {
            if (!response || (response.status !== 200 && response.type !== "opaque")) return response;
            var copy = response.clone();
            caches.open(IMAGE_CACHE).then(function (cache) { cache.put(request, copy); }).catch(function () {});
            return response;
          });
        }).catch(function () { return fetch(request); })
      );
      return;
    }

    if (!request || request.method !== "GET" || !isSameOrigin(url)) return;
    if (url.pathname === "/sw.js") return;

    // Staff consoles bypass the worker entirely — no respondWith, so the browser
    // does its own network fetch under the page's `private, no-cache` header and
    // staff always get the deployed HTML. Nothing is written to a cache here, so
    // a missed VERSION bump can never pin a stale console again.
    if (isStaffConsolePage(url)) return;

    if (isPageDocument(request, url)) {
      // Stale-while-revalidate: serve the cached page instantly (caches are
      // VERSION-keyed, purged+re-precached on every deploy that bumps
      // VERSION — the mandatory convention when a page's HTML changes) and
      // refresh the cache in the background so even a missed bump self-heals
      // one navigation later. network-first with a 4s window made every page
      // switch pay a full network round trip and was the main reason
      // navigation felt slow; cache misses still fall back to networkFirst
      // (offline gets the timed cached fallback).
      event.respondWith(
        caches.match(request).then(function (cached) {
          if (cached) {
            fetch(request).then(function (response) {
              if (!shouldCacheResponse(response)) return response;
              // Refresh BOTH caches: STATIC_CACHE (install precache) is
              // created first, so caches.match always prefers its entry —
              // updating only PAGE_CACHE would pin precached pages at
              // install-time HTML forever, killing the self-heal this
              // branch exists to provide.
              var forStatic = response.clone();
              var forRuntime = response.clone();
              return putIfCacheable(PAGE_CACHE, request, response).then(function (result) {
                return caches.open(STATIC_CACHE).then(function (cache) {
                  return cache.match(request).then(function (existing) {
                    if (existing) return cache.put(request, forStatic);
                    return null;
                  });
                }).then(function () {
                  // RUNTIME_CACHE can also hold page documents (idle-prefetch
                  // warmUrls stores non-precached pages there) and may have
                  // been created before PAGE_CACHE — refresh its entry too or
                  // those pages stay pinned at warm-time HTML.
                  return caches.open(RUNTIME_CACHE);
                }).then(function (cache) {
                  return cache.match(request).then(function (existing) {
                    if (existing) return cache.put(request, forRuntime);
                    return null;
                  });
                }).then(function () { return result; });
              });
            }).catch(function () {});
            return cached;
          }
          return networkFirst(request, PAGE_CACHE, PAGE_TIMEOUT_MS);
        })
      );
      return;
    }

    if (isImmutableAsset(url)) {
      event.respondWith(cacheFirst(request, STATIC_CACHE));
      return;
    }

    if (isRuntimeStatic(url) || isSafeRuntimeApi(url)) {
      event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
    }
  });
})();
