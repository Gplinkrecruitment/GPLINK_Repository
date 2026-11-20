#!/usr/bin/env node
'use strict';
/*
 * Quick self-test of the gateway (database API, auth emulator, storage
 * emulator, outbound trap). Uses throwaway rows and removes them again.
 *   node scripts/au-local/lib/selftest.js
 * Needs the stack running (start.sh). Talks to this Mac only.
 */
const cfg = require('./config.js');
const s = cfg.loadSecrets();
const G = 'http://127.0.0.1:' + cfg.PORTS.gateway;
const svc = { apikey: s.serviceRoleKey, Authorization: 'Bearer ' + s.serviceRoleKey };
const anon = { apikey: s.anonKey, Authorization: 'Bearer ' + s.anonKey };
let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? '  ok    ' : '  FAIL  ') + label + (detail ? '   ' + detail : ''));
}
async function j(url, init) {
  const r = await fetch(url, init);
  const t = await r.text();
  let d = null;
  try { d = t ? JSON.parse(t) : null; } catch (e) { d = t; }
  return { status: r.status, data: d, headers: r.headers };
}

(async () => {
  console.log('Database API (PostgREST behind the gateway)');
  let r = await j(G + '/rest/v1/user_profiles?select=user_id,email&limit=1', { headers: svc });
  check('service key can read user_profiles', r.status === 200 && Array.isArray(r.data), 'HTTP ' + r.status);
  r = await j(G + '/rest/v1/user_profiles?select=user_id,this_column_does_not_exist&limit=1', { headers: svc });
  check('selecting a column that does not exist is a 400 (as in production)', r.status === 400 && r.data && r.data.code === '42703', 'HTTP ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 140));
  r = await j(G + '/rest/v1/registration_cases?select=id&limit=1', { headers: anon });
  check('anonymous key cannot read registration_cases rows', (r.status === 200 && Array.isArray(r.data) && r.data.length === 0) || r.status === 401 || r.status === 403, 'HTTP ' + r.status);
  r = await j(G + '/rest/v1/user_profiles?select=user_id&limit=1', {});
  check('no key at all is refused', r.status === 401, 'HTTP ' + r.status);
  r = await j(G + '/rest/v1/rpc/rate_limit_hit', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, svc), body: JSON.stringify({ p_key: 'aulocal-selftest', p_max: 5, p_window_ms: 60000 }) });
  check('rpc/rate_limit_hit works', r.status === 200 && r.data && r.data.allowed === true, JSON.stringify(r.data));
  await j(G + '/rest/v1/runtime_kv?key=eq.aulocal-selftest', { method: 'DELETE', headers: svc });
  r = await j(G + '/rest/v1/user_profiles?select=user_id', { headers: Object.assign({ Prefer: 'count=exact', Range: '0-0' }, svc) });
  check('Prefer: count=exact returns Content-Range', /\/\d+$/.test(String(r.headers.get('content-range') || '')), String(r.headers.get('content-range')));

  console.log('Auth emulator');
  const email = 'selftest.' + Date.now() + '@' + cfg.TEST_EMAIL_DOMAIN;
  const jsonSvc = Object.assign({ 'Content-Type': 'application/json' }, svc);
  const jsonAnon = Object.assign({ 'Content-Type': 'application/json' }, anon);
  r = await j(G + '/auth/v1/admin/users', { method: 'POST', headers: jsonSvc, body: JSON.stringify({ email, password: cfg.TEST_PASSWORD, email_confirm: true, user_metadata: { firstName: 'Self', lastName: 'Test (FAKE)' } }) });
  const uid = r.data && r.data.id;
  check('admin create user', r.status === 200 && !!uid, 'HTTP ' + r.status);
  r = await j(G + '/auth/v1/admin/users', { method: 'POST', headers: jsonSvc, body: JSON.stringify({ email, password: cfg.TEST_PASSWORD }) });
  check('creating the same email again is a 422', r.status === 422, 'HTTP ' + r.status + ' ' + (r.data && r.data.msg));
  r = await j(G + '/rest/v1/user_profiles?select=first_name,last_name,email&user_id=eq.' + uid, { headers: svc });
  check('the live "new auth user" trigger created the profile row', r.status === 200 && r.data.length === 1 && r.data[0].first_name === 'Self', JSON.stringify(r.data));
  r = await j(G + '/auth/v1/token?grant_type=password', { method: 'POST', headers: jsonAnon, body: JSON.stringify({ email, password: 'wrong-password' }) });
  check('wrong password is refused (400 invalid_credentials)', r.status === 400 && r.data.error_code === 'invalid_credentials', 'HTTP ' + r.status);
  r = await j(G + '/auth/v1/token?grant_type=password', { method: 'POST', headers: jsonAnon, body: JSON.stringify({ email, password: cfg.TEST_PASSWORD }) });
  const access = r.data && r.data.access_token;
  check('password sign-in returns a session', r.status === 200 && !!access && r.data.user.id === uid, 'HTTP ' + r.status);
  r = await j(G + '/auth/v1/user', { headers: { apikey: s.anonKey, Authorization: 'Bearer ' + access } });
  check('GET /user with the session token', r.status === 200 && r.data.email === email, 'HTTP ' + r.status);
  r = await j(G + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: jsonAnon, body: JSON.stringify({ refresh_token: 'nope' }) });
  check('bad refresh token is refused', r.status === 400, 'HTTP ' + r.status);
  r = await j(G + '/auth/v1/admin/users/' + uid, { method: 'PUT', headers: jsonSvc, body: JSON.stringify({ app_metadata: { email_verified_at: new Date().toISOString() } }) });
  check('admin update user (app_metadata merge)', r.status === 200 && r.data.app_metadata.email_verified_at && r.data.app_metadata.provider === 'email', 'HTTP ' + r.status);
  r = await j(G + '/auth/v1/admin/generate_link', { method: 'POST', headers: jsonSvc, body: JSON.stringify({ type: 'recovery', email, options: { redirect_to: cfg.APP_URL + '/pages/signin?reset=true' } }) });
  check('admin generate_link (recovery) returns action_link', r.status === 200 && /\/auth\/v1\/verify\?token=/.test(String(r.data.action_link)), 'HTTP ' + r.status);
  const v = await fetch(String(r.data.action_link), { redirect: 'manual' });
  const loc = String(v.headers.get('location') || '');
  check('following the recovery link redirects back with a session', v.status === 303 && loc.startsWith(cfg.APP_URL + '/pages/signin') && /access_token=/.test(loc) && /type=recovery/.test(loc), 'HTTP ' + v.status);
  const recToken = (/access_token=([^&]+)/.exec(loc) || [])[1];
  r = await j(G + '/auth/v1/user', { method: 'PUT', headers: { apikey: s.anonKey, Authorization: 'Bearer ' + recToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: cfg.TEST_PASSWORD + 'x' }) });
  check('PUT /user sets a new password', r.status === 200, 'HTTP ' + r.status);
  r = await j(G + '/auth/v1/admin/users?page=1&per_page=50', { headers: svc });
  check('admin list users', r.status === 200 && Array.isArray(r.data.users) && r.data.users.some((u) => u.id === uid), 'HTTP ' + r.status);
  r = await j(G + '/auth/v1/admin/users', { headers: anon });
  check('admin API refuses the anonymous key', r.status === 403, 'HTTP ' + r.status);

  console.log('Storage emulator');
  const obj = '/storage/v1/object/aulocal-selftest/users/' + uid + '/hello%20file.txt';
  let b = await fetch(G + obj, { method: 'POST', headers: Object.assign({ 'Content-Type': 'text/plain', 'x-upsert': 'true' }, svc), body: Buffer.from('hello from the local stack') });
  check('upload', b.status === 200, 'HTTP ' + b.status);
  b = await fetch(G + obj, { method: 'POST', headers: Object.assign({ 'Content-Type': 'text/plain' }, svc), body: Buffer.from('again') });
  check('uploading over an existing file without x-upsert is refused', b.status === 400, 'HTTP ' + b.status);
  b = await fetch(G + obj, { headers: svc });
  check('download', b.status === 200 && (await b.text()) === 'hello from the local stack', 'HTTP ' + b.status);
  b = await fetch(G + obj, {});
  check('download without a key is refused', b.status === 400 || b.status === 401, 'HTTP ' + b.status);
  r = await j(G + obj.replace('/object/', '/object/sign/'), { method: 'POST', headers: jsonSvc, body: JSON.stringify({ expiresIn: 3600, download: 'renamed.txt' }) });
  check('create signed download link', r.status === 200 && typeof r.data.signedURL === 'string', 'HTTP ' + r.status);
  b = await fetch(G + '/storage/v1' + r.data.signedURL);
  check('signed link works without a key and sets the download name', b.status === 200 && /renamed\.txt/.test(String(b.headers.get('content-disposition'))), 'HTTP ' + b.status);
  const obj2 = obj.replace('hello%20file.txt', 'browser-upload.bin');
  r = await j(G + obj2.replace('/object/', '/object/upload/sign/'), { method: 'POST', headers: Object.assign({ 'x-upsert': 'true' }, svc) });
  check('create signed upload link', r.status === 200 && /\/object\/upload\/sign\//.test(String(r.data.url)), 'HTTP ' + r.status);
  b = await fetch(G + '/storage/v1' + r.data.url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from([1, 2, 3, 4]) });
  check('browser-style PUT to the signed upload link', b.status === 200, 'HTTP ' + b.status);
  b = await fetch(G + obj, { method: 'DELETE', headers: svc });
  check('delete', b.status === 200, 'HTTP ' + b.status);
  await fetch(G + obj2, { method: 'DELETE', headers: svc });
  b = await fetch(G + obj, { headers: svc });
  check('deleted file is gone', b.status === 400, 'HTTP ' + b.status);

  console.log('Cleaning up');
  r = await j(G + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: svc });
  check('admin delete user', r.status === 200, 'HTTP ' + r.status);
  r = await j(G + '/rest/v1/user_profiles?select=user_id&user_id=eq.' + uid, { headers: svc });
  check('deleting the account removed its profile (cascade, as in production)', r.status === 200 && r.data.length === 0, JSON.stringify(r.data));

  console.log(failed ? '\n' + failed + ' check(s) FAILED.' : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('selftest crashed:', e.message); process.exit(1); });
