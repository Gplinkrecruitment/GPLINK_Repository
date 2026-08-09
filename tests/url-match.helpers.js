// Shared URL matching for the test-harness fetch stubs.
//
// The stubs route a fetch by looking at its URL. Doing that with
// `url.includes('api.resend.com')` is wrong twice over: it also matches
// `https://api.resend.com.attacker.test/x` (an arbitrary host AFTER the name)
// and `https://attacker.test/?u=api.resend.com` (an arbitrary host BEFORE it).
// That is CodeQL js/incomplete-url-substring-sanitization. These helpers parse
// the URL and compare the host / origin exactly instead.
//
// Anything that is not an absolute, parseable URL — a relative path such as
// `/api/foo`, or a Request object that stringified to `[object Request]` —
// returns false. That is exactly what the old substring checks did for those
// inputs, so a stub keeps falling through to the real fetch for them.

/** Parses `value` as an absolute URL. Returns null when it is not one. */
export function parseAbsoluteUrl(value) {
  if (value === null || value === undefined) return null;
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
}

/**
 * True when `value` is an absolute URL whose hostname is exactly `host`.
 * The port is not considered, and the comparison is case-insensitive.
 *
 *   urlHasHost('https://api.resend.com/emails', 'api.resend.com')       -> true
 *   urlHasHost('https://api.resend.com.evil.test/x', 'api.resend.com')  -> false
 *   urlHasHost('https://evil.test/?u=api.resend.com', 'api.resend.com') -> false
 *   urlHasHost('/api/local', 'api.resend.com')                          -> false
 */
export function urlHasHost(value, host) {
  const parsed = parseAbsoluteUrl(value);
  if (parsed === null) return false;
  return parsed.hostname.toLowerCase() === String(host).toLowerCase();
}

/**
 * True when `value` is an absolute URL on the same origin (scheme + host +
 * port) as `base`. Use this for stubs keyed on a base-URL constant such as
 * `https://zoho-sync.gplink-test.local`. Only the ORIGIN of `base` is used, so
 * a base that carries a path is not supported.
 */
export function urlHasOrigin(value, base) {
  const parsed = parseAbsoluteUrl(value);
  const baseParsed = parseAbsoluteUrl(base);
  if (parsed === null || baseParsed === null) return false;
  // Non-special schemes (e.g. `foo://bar`) all report the origin "null" —
  // never treat two of those as the same origin.
  if (parsed.origin === 'null' || baseParsed.origin === 'null') return false;
  return parsed.origin === baseParsed.origin;
}
