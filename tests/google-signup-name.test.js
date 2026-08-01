import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/*
 * A doctor signed up with Google and every certificate they uploaded was
 * rejected with "your account does not have a full first and last name yet —
 * please update your account name and try again", which a Google sign-in gives
 * them no way to do.
 *
 * The cause, confirmed against the real account in production (auth user
 * 3a5c6135-…): Google hands Supabase a `full_name` and a `name`, and NO
 * `given_name` / `family_name`. Our three copies of the name expression only
 * ever read `firstName || given_name` and `lastName || family_name`, so every
 * Google signup landed in user_profiles with two empty strings.
 */

const ROOT = path.resolve(__dirname, '..');
const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

// The real function, lifted out of server.js and run.
const deriveSupabaseUserNames = (() => {
  const src = extractFunction(serverJs, 'deriveSupabaseUserNames');
  expect(src, 'deriveSupabaseUserNames not found in server.js').toBeTruthy();
  // eslint-disable-next-line no-new-func
  return new Function(src + '\nreturn deriveSupabaseUserNames;')();
})();

// Verbatim from the production auth user for khaleedmahmoudcoinspot1211@gmail.com.
const REAL_GOOGLE_METADATA = {
  avatar_url: 'https://lh3.googleusercontent.com/a/ACg8ocK4B03yoIF…',
  email: 'khaleedmahmoudcoinspot1211@gmail.com',
  email_verified: true,
  full_name: 'Khaleed Mahmoud',
  iss: 'https://accounts.google.com',
  name: 'Khaleed Mahmoud',
  phone_verified: false,
  picture: 'https://lh3.googleusercontent.com/a/ACg8ocK4B03yoIF…',
  provider_id: '110435248982086328507',
  sub: '110435248982086328507'
};

describe('a Google account has a name we can actually read', () => {
  it('reads the real Google metadata that used to come back blank', () => {
    expect(deriveSupabaseUserNames(REAL_GOOGLE_METADATA)).toEqual({
      firstName: 'Khaleed',
      lastName: 'Mahmoud'
    });
  });

  it('proves the old expression produced nothing for that same account', () => {
    // What the three call sites used to do, kept here so the regression is
    // visible rather than described.
    const meta = REAL_GOOGLE_METADATA;
    const oldFirst = String(meta.firstName || meta.given_name || '').trim();
    const oldLast = String(meta.lastName || meta.family_name || '').trim();
    expect(oldFirst).toBe('');
    expect(oldLast).toBe('');
  });

  it('still prefers our own signup fields and the given/family pair', () => {
    // Email+password signup writes firstName/lastName (this is why the bug only
    // ever showed up for social sign-ins).
    expect(deriveSupabaseUserNames({ firstName: 'Khaleed', lastName: 'Crypto', full_name: 'Someone Else' }))
      .toEqual({ firstName: 'Khaleed', lastName: 'Crypto' });
    expect(deriveSupabaseUserNames({ given_name: 'Ada', family_name: 'Lovelace' }))
      .toEqual({ firstName: 'Ada', lastName: 'Lovelace' });
  });

  it('handles the awkward shapes without inventing anything', () => {
    // Several surnames — everything after the first token is the surname.
    expect(deriveSupabaseUserNames({ full_name: 'Tarig El-Tag Saifeldin Mahmoud' }))
      .toEqual({ firstName: 'Tarig', lastName: 'El-Tag Saifeldin Mahmoud' });
    // Falls back to `name` when `full_name` is absent.
    expect(deriveSupabaseUserNames({ name: 'Mercy Obanimoh' }))
      .toEqual({ firstName: 'Mercy', lastName: 'Obanimoh' });
    // A single word gives no surname, and we must not fabricate one — the
    // "no usable full name" path stays honest.
    expect(deriveSupabaseUserNames({ full_name: 'Prince' }))
      .toEqual({ firstName: 'Prince', lastName: '' });
    // Only half of a pair present: the rest comes from the full name.
    expect(deriveSupabaseUserNames({ given_name: 'Ada', full_name: 'Ada Lovelace' }))
      .toEqual({ firstName: 'Ada', lastName: 'Lovelace' });
    expect(deriveSupabaseUserNames({})).toEqual({ firstName: '', lastName: '' });
    expect(deriveSupabaseUserNames(null)).toEqual({ firstName: '', lastName: '' });
    // Stray whitespace must not become an empty surname.
    expect(deriveSupabaseUserNames({ full_name: '  Khaleed   Mahmoud  ' }))
      .toEqual({ firstName: 'Khaleed', lastName: 'Mahmoud' });
  });

  it('is the ONLY copy of this expression left', () => {
    // Three drifted copies are how the Google gap survived: fixing one would
    // have left the other two blank.
    // Look everywhere EXCEPT inside the helper, which is where the expression
    // now legitimately lives.
    const helper = extractFunction(serverJs, 'deriveSupabaseUserNames');
    const elsewhere = serverJs.replace(helper, '');
    expect(elsewhere.match(/firstName \|\| \w*\.?given_name/g) || []).toHaveLength(0);
    expect(elsewhere.match(/lastName \|\| \w*\.?family_name/g) || []).toHaveLength(0);
    const uses = serverJs.match(/deriveSupabaseUserNames\(/g) || [];
    // definition + 3 call sites + the auth-identity fallback
    expect(uses.length).toBeGreaterThanOrEqual(4);
  });
});

describe('the scan can find a name we already hold', () => {
  it('falls back to the sign-in identity before giving up', () => {
    const fn = extractFunction(serverJs, 'resolveVerificationProfileName');
    expect(fn).toContain('getSupabaseAuthUserFullName(session)');
    // It must be the LAST resort, after the profile row and the session.
    expect(fn.indexOf('getSupabaseUserProfile')).toBeLessThan(fn.indexOf('getSupabaseAuthUserFullName'));
  });

  it('reads that identity through the same derivation', () => {
    // The session wrapper resolves a user id and hands off; the id variant does
    // the fetch, so the identity guards (which have no session) can use it too.
    const wrapper = extractFunction(serverJs, 'getSupabaseAuthUserFullName');
    expect(wrapper).toContain('getSupabaseAuthUserFullNameById(userId)');

    const fn = extractFunction(serverJs, 'getSupabaseAuthUserFullNameById');
    expect(fn).toContain('/auth/v1/admin/users/');
    expect(fn).toContain('deriveSupabaseUserNames(user && user.user_metadata)');
    // Best-effort: a failure here must never break a scan or a submission.
    expect(fn).toContain('return \'\';');
  });
});

describe('the wrong-owner CV guards are not switched off by a blank name', () => {
  // Both guards skip themselves when the account has no usable full name — and a
  // Google signup had exactly that, so the protection that exists because Sana
  // Ahsan's CV was emailed to a practice as Helen Wazalski's was doing nothing
  // for social sign-ins.
  it('falls back to the sign-in identity at upload time', () => {
    expect(serverJs).toContain('if (!hasUsableFullName(cvAccountName)) cvAccountName = await getSupabaseAuthUserFullNameById(userId);');
    // It has to be a `let` now, not a `const`.
    expect(serverJs).toMatch(/let cvAccountName = cvProf \?/);
  });

  it('falls back to the sign-in identity when attaching to a practice email', () => {
    expect(serverJs).toContain('if (!attAccountName) attAccountName = await getSupabaseAuthUserFullNameById(appRow.user_id);');
    // ...and the resolved name is what is actually compared and logged, not the
    // display string (which falls back to an email address).
    expect(serverJs).toContain('crossCheckDocumentName(attScan.nameFound, attAccountName, attKnown)');
    expect(serverJs).not.toContain('crossCheckDocumentName(attScan.nameFound, inAppGpName, attKnown)');
  });
});

describe('renaming an account writes to the table that exists', () => {
  it('no longer PATCHes the non-existent `profiles` table', () => {
    // PostgREST answers 404 for `profiles` in this project; every profile read
    // in the app uses `user_profiles`. The 404 was logged and swallowed.
    expect(serverJs).not.toContain('/rest/v1/profiles?email=eq.');
    expect(serverJs).toContain("const patch = await supabaseDbRequest('user_profiles', filter, {");
  });

  it('stops reporting success when the write did not land', () => {
    // The endpoint answered {ok:true} regardless, so the caller — the "adopt the
    // legal name off the documents" rescue in js/onboarding.js — believed a
    // rename had happened that never did.
    expect(serverJs).toContain('if (!supabaseUpdated) {');
    expect(serverJs).toContain("sendJson(res, 502, { ok: false, message: 'We could not update your account name just now. Please try again.' });");
  });
});
