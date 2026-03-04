(function () {
  const pathname = window.location.pathname;
  const isSignInPage = pathname === "/pages/signin.html";
  const isPublicPage =
    isSignInPage ||
    pathname === "/pages/privacy.html" ||
    pathname === "/pages/terms.html";

  fetch("/api/auth/session", { credentials: "same-origin" })
    .then((response) => {
      if (response.ok) {
        if (isSignInPage) {
          window.location.replace("/pages/index.html");
        }
        return;
      }
      if (!isPublicPage) {
        window.location.replace("/pages/signin.html");
      }
    })
    .catch(() => {
      if (!isPublicPage) {
        window.location.replace("/pages/signin.html");
      }
    });
})();
