// Relocation Details on the account page must reflect what the GP entered at
// onboarding. Those answers live in user_state.gp_onboarding under the keys
// preferredCity / targetDate / whoMoving / childrenCount — NOT in the
// /api/profile record (which has no such columns). Before this fix the section
// rendered permanently blank. Contract pinned here:
//   - account.html reads gp_onboarding from /api/state on load and maps the
//     onboarding key names to its own field ids.
//   - It writes edits back to gp_onboarding via PUT /api/state (merge, not
//     clobber) so the account page round-trips.
//   - The who's-moving value mapping is exact and bidirectional, and every
//     city onboarding can store is a valid option in the account select.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT_PATH = path.join(__dirname, '..', 'pages', 'account.html');
const ONBOARDING_HTML_PATH = path.join(__dirname, '..', 'pages', 'onboarding.html');
const ONBOARDING_JS_PATH = path.join(__dirname, '..', 'js', 'onboarding.js');

let accountHtml;
let onboardingHtml;
let onboardingJs;

beforeAll(() => {
  accountHtml = fs.readFileSync(ACCOUNT_PATH, 'utf8');
  onboardingHtml = fs.readFileSync(ONBOARDING_HTML_PATH, 'utf8');
  onboardingJs = fs.readFileSync(ONBOARDING_JS_PATH, 'utf8');
});

describe('account.html — Relocation Details is backed by onboarding answers', () => {
  it('reads gp_onboarding from /api/state on load (both init and reset paths)', () => {
    expect(accountHtml).toContain('function loadRelocationFromOnboarding(');
    expect(accountHtml).toContain('stateObj.gp_onboarding');
    // Called after the profile is applied, in both the initial load and Cancel.
    const loadCalls = (accountHtml.match(/await loadRelocationFromOnboarding\(\)/g) || []).length;
    expect(loadCalls).toBeGreaterThanOrEqual(2);
  });

  it('writes edits back to gp_onboarding via PUT /api/state, merging the blob', () => {
    expect(accountHtml).toContain('function saveRelocationToOnboarding(');
    // Persists under the gp_onboarding key (not the profile record).
    expect(accountHtml).toMatch(/state:\s*\{\s*gp_onboarding:\s*merged\s*\}/);
    // Merge onto the freshest blob so other onboarding answers survive.
    expect(accountHtml).toContain('Object.assign({}, base)');
    // Only writes when the relocation fields actually changed.
    expect(accountHtml).toContain('if (relocChanged) await saveRelocationToOnboarding();');
  });

  it('maps onboarding key names to the account field names', () => {
    // The original bug: onboarding stored preferredCity/targetDate/whoMoving,
    // account read cityOfChoice/preferredStartDate/movingParty.
    expect(accountHtml).toContain('merged.preferredCity = fieldEls.cityOfChoice.value');
    expect(accountHtml).toContain('merged.targetDate = fieldEls.preferredStartDate.value');
    expect(accountHtml).toMatch(/ob\.preferredCity/);
    expect(accountHtml).toMatch(/ob\.targetDate/);
    expect(accountHtml).toMatch(/ob\.whoMoving/);
  });

  it('who-is-moving value mapping is exact and bidirectional', () => {
    // Evaluate the two mapping objects straight out of the file.
    const fwd = accountHtml.match(/WHO_MOVING_ONBOARDING_TO_ACCOUNT = (\{[\s\S]*?\});/);
    const rev = accountHtml.match(/WHO_MOVING_ACCOUNT_TO_ONBOARDING = (\{[\s\S]*?\});/);
    expect(fwd).not.toBeNull();
    expect(rev).not.toBeNull();
    // eslint-disable-next-line no-eval
    const forward = eval('(' + fwd[1] + ')');
    // eslint-disable-next-line no-eval
    const reverse = eval('(' + rev[1] + ')');

    const expectedForward = {
      just_me: 'Just me',
      me_partner: 'Me and partner',
      me_children: 'Me and children',
      me_partner_children: 'Me, partner and children'
    };
    expect(forward).toEqual(expectedForward);

    // Reverse must invert forward exactly (so a saved value round-trips).
    for (const [obKey, acctVal] of Object.entries(forward)) {
      expect(reverse[acctVal]).toBe(obKey);
    }

    // The two onboarding values that include children must map to account
    // labels containing "children" (drives the children-count field visibility).
    expect(forward.me_children).toContain('children');
    expect(forward.me_partner_children).toContain('children');
  });

  it('every who-moving value onboarding can store is handled', () => {
    // Onboarding option cards define data-value="..." for each choice.
    const values = [...onboardingHtml.matchAll(/data-value="(just_me|me_partner|me_children|me_partner_children)"/g)]
      .map((m) => m[1]);
    expect(new Set(values).size).toBe(4);
    for (const v of values) {
      expect(accountHtml).toContain(v + ':'); // present as a key in the forward map
    }
  });

  it('every city onboarding can store is a valid option in the account select', () => {
    // Bound each slice to its own <select> so a later dropdown's options
    // (e.g. onboarding's "How did you hear about us?") don't leak in.
    const sliceSelect = (html, id) => {
      const start = html.indexOf(`id="${id}"`);
      const end = html.indexOf('</select>', start);
      return html.slice(start, end === -1 ? undefined : end);
    };
    const obCities = [...sliceSelect(onboardingHtml, 'preferredCity').matchAll(/<option value="([A-Za-z]+)"/g)]
      .map((m) => m[1])
      .filter((c) => c); // drop the empty placeholder
    expect(obCities.length).toBeGreaterThanOrEqual(7);

    const acctCities = new Set(
      [...sliceSelect(accountHtml, 'cityOfChoice').matchAll(/<option value="([A-Za-z]+)"/g)].map((m) => m[1])
    );
    for (const city of obCities) {
      expect(acctCities.has(city), `account select missing onboarding city: ${city}`).toBe(true);
    }
  });

  it('onboarding really stores the keys this mapping depends on', () => {
    // Guards against a future onboarding rename silently re-breaking the link.
    expect(onboardingJs).toMatch(/preferredCity:/);
    expect(onboardingJs).toMatch(/targetDate:/);
    expect(onboardingJs).toMatch(/whoMoving:/);
    expect(onboardingJs).toMatch(/childrenCount:/);
  });
});
