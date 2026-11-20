'use strict';
/*
 * A small stand-in for Supabase Auth (GoTrue), covering the endpoints the app
 * actually calls. Accounts live in the local database's auth.users table (same
 * columns as production), so foreign keys, cascades and the new-user trigger
 * behave as they do live. Passwords are bcrypt hashes made by pgcrypto, the
 * same scheme GoTrue uses.
 *
 * Endpoints (all under /auth/v1):
 *   POST   /signup
 *   POST   /token?grant_type=password | refresh_token
 *   POST   /recover
 *   POST   /logout
 *   GET    /user            PUT /user
 *   GET    /settings        GET /health
 *   GET    /verify          POST /verify      (one-time links: recovery, signup, magiclink, invite, email_change)
 *   GET    /authorize       (Google / Apple sign-in: NOT emulated, explains itself)
 *   POST   /admin/users     GET /admin/users
 *   GET    /admin/users/:id PUT /admin/users/:id   DELETE /admin/users/:id
 *   POST   /admin/generate_link
 */
const crypto = require('crypto');
const cfg = require('./config.js');

const ACCESS_TTL_S = 3600;

function createAuthEmulator(deps) {
  const { db, secrets, outbox } = deps;

  function err(status, errorCode, msg) {
    return { status, body: { code: status, error_code: errorCode, msg } };
  }
  function ok(body, status) { return { status: status || 200, body }; }

  function userJson(row) {
    if (!row) return null;
    const appMeta = Object.assign({ provider: 'email', providers: ['email'] }, row.raw_app_meta_data || {});
    const iso = (v) => (v ? new Date(v).toISOString() : undefined);
    const out = {
      id: row.id,
      aud: row.aud || 'authenticated',
      role: row.role || 'authenticated',
      email: row.email || '',
      phone: row.phone || '',
      app_metadata: appMeta,
      user_metadata: row.raw_user_meta_data || {},
      identities: [{
        identity_id: row.id, id: row.id, user_id: row.id, provider: 'email',
        identity_data: { email: row.email, email_verified: !!row.email_confirmed_at, phone_verified: false, sub: row.id },
        last_sign_in_at: iso(row.last_sign_in_at), created_at: iso(row.created_at), updated_at: iso(row.updated_at), email: row.email
      }],
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      is_anonymous: false
    };
    if (row.email_confirmed_at) { out.email_confirmed_at = iso(row.email_confirmed_at); out.confirmed_at = iso(row.email_confirmed_at); }
    if (row.last_sign_in_at) out.last_sign_in_at = iso(row.last_sign_in_at);
    if (row.recovery_sent_at) out.recovery_sent_at = iso(row.recovery_sent_at);
    if (row.banned_until) out.banned_until = iso(row.banned_until);
    if (row.email_change) out.new_email = row.email_change;
    return out;
  }

  async function findByEmail(email) {
    const r = await db.query('select * from auth.users where lower(email) = lower($1) limit 1', [String(email || '').trim()]);
    return r.rows[0] || null;
  }
  async function findById(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
    const r = await db.query('select * from auth.users where id = $1 limit 1', [id]);
    return r.rows[0] || null;
  }
  function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '')); }

  async function createUser(fields) {
    const id = fields.id || crypto.randomUUID();
    const r = await db.query(
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                               raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                               confirmation_token, recovery_token, email_change_token_new, email_change)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2,
               case when $3::text is null or $3::text = '' then '' else extensions.crypt($3::text, extensions.gen_salt('bf', 10)) end,
               case when $4::boolean then now() else null end,
               $5::jsonb, $6::jsonb, now(), now(), '', '', '', '')
       returning *`,
      [id, String(fields.email).trim().toLowerCase(), fields.password || null, !!fields.confirmed,
        JSON.stringify(Object.assign({ provider: 'email', providers: ['email'] }, fields.appMetadata || {})),
        JSON.stringify(fields.userMetadata || {})]
    );
    return r.rows[0];
  }

  function mergeMeta(existing, patch) {
    const out = Object.assign({}, existing || {});
    for (const k of Object.keys(patch || {})) {
      if (patch[k] === null) delete out[k]; else out[k] = patch[k];
    }
    return out;
  }

  async function issueSession(row) {
    const now = Math.floor(Date.now() / 1000);
    const upd = await db.query('update auth.users set last_sign_in_at = now(), updated_at = now() where id = $1 returning *', [row.id]);
    const user = upd.rows[0] || row;
    const payload = {
      iss: cfg.GATEWAY_URL + '/auth/v1', sub: user.id, aud: 'authenticated', exp: now + ACCESS_TTL_S, iat: now,
      email: user.email, phone: '', role: 'authenticated', aal: 'aal1',
      app_metadata: Object.assign({ provider: 'email', providers: ['email'] }, user.raw_app_meta_data || {}),
      user_metadata: user.raw_user_meta_data || {},
      session_id: crypto.randomUUID(), is_anonymous: false
    };
    const refresh = crypto.randomBytes(9).toString('base64url');
    await db.query('insert into aulocal.refresh_tokens (token, user_id) values ($1, $2)', [refresh, user.id]);
    return {
      access_token: cfg.signJwt(payload, secrets.jwtSecret),
      token_type: 'bearer',
      expires_in: ACCESS_TTL_S,
      expires_at: now + ACCESS_TTL_S,
      refresh_token: refresh,
      user: userJson(user)
    };
  }

  function bearer(req) {
    const h = String(req.headers.authorization || '');
    return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
  }
  function isServiceRole(req) {
    const claims = cfg.verifyJwt(bearer(req), secrets.jwtSecret);
    return !!(claims && claims.role === 'service_role');
  }
  async function userFromBearer(req) {
    const claims = cfg.verifyJwt(bearer(req), secrets.jwtSecret);
    if (!claims || !claims.sub || claims.role !== 'authenticated') return null;
    return findById(claims.sub);
  }

  function safeRedirect(target) {
    // GoTrue only redirects to allow-listed addresses. Locally: this Mac only.
    try {
      const u = new URL(String(target || ''));
      if (cfg.isLoopbackHost(u.hostname)) return u.toString();
    } catch (e) { /* fall through */ }
    return cfg.APP_URL + '/pages/signin';
  }

  async function makeLink(row, kind, redirectTo, newEmail) {
    const raw = crypto.randomBytes(24).toString('hex');
    const hashed = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 56);
    await db.query('insert into aulocal.one_time_tokens (token_hash, user_id, kind, redirect_to, new_email) values ($1, $2, $3, $4, $5)',
      [hashed, row.id, kind, redirectTo || null, newEmail || null]);
    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const redirect = safeRedirect(redirectTo);
    const actionLink = cfg.GATEWAY_URL + '/auth/v1/verify?token=' + hashed + '&type=' + encodeURIComponent(kind) + '&redirect_to=' + encodeURIComponent(redirect);
    return { action_link: actionLink, email_otp: otp, hashed_token: hashed, redirect_to: redirect, verification_type: kind };
  }

  async function consumeLink(tokenHash, kind) {
    const r = await db.query('select * from aulocal.one_time_tokens where token_hash = $1 limit 1', [String(tokenHash || '')]);
    const tok = r.rows[0];
    if (!tok || tok.used_at) return { error: 'Email link is invalid or has expired' };
    if (Date.now() - new Date(tok.created_at).getTime() > 3600 * 1000) return { error: 'Email link is invalid or has expired' };
    if (kind && tok.kind !== kind && !(kind === 'email' && ['signup', 'magiclink', 'invite'].includes(tok.kind))) {
      return { error: 'Email link is invalid or has expired' };
    }
    await db.query('update aulocal.one_time_tokens set used_at = now() where token_hash = $1', [tok.token_hash]);
    let user = await findById(tok.user_id);
    if (!user) return { error: 'User not found' };
    if (tok.kind === 'email_change' && tok.new_email) {
      await db.query("update auth.users set email = $2, email_change = '', updated_at = now() where id = $1", [user.id, tok.new_email]);
    }
    if (!user.email_confirmed_at) await db.query('update auth.users set email_confirmed_at = now(), updated_at = now() where id = $1', [user.id]);
    user = await findById(tok.user_id);
    return { user, tok };
  }

  async function handle(req, res, pathname, query, body) {
    const method = req.method.toUpperCase();
    const p = pathname.replace(/\/+$/, '') || '/';

    if (p === '/health' && method === 'GET') return ok({ version: 'aulocal-emulator', name: 'GoTrue (local emulator)', description: 'GP Link local test stack' });

    if (p === '/settings' && method === 'GET') {
      return ok({
        external: { email: true, phone: false, google: false, apple: false, anonymous_users: false },
        disable_signup: false, mailer_autoconfirm: false, phone_autoconfirm: false, sms_provider: '', saml_enabled: false
      });
    }

    if (p === '/signup' && method === 'POST') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!validEmail(email)) return err(400, 'validation_failed', 'Unable to validate email address: invalid format');
      if (password.length < 6) return err(422, 'weak_password', 'Password should be at least 6 characters.');
      const existing = await findByEmail(email);
      if (existing) {
        if (existing.email_confirmed_at) return err(422, 'user_already_exists', 'User already registered');
        return ok(userJson(existing));
      }
      // Email confirmation is ON in production, so a plain signup returns the
      // user with no session and Supabase sends its own confirmation email.
      const row = await createUser({ email, password, confirmed: false, userMetadata: body.data || {} });
      const link = await makeLink(row, 'signup', (body.options && body.options.emailRedirectTo) || query.redirect_to || '');
      await db.query('update auth.users set confirmation_sent_at = now() where id = $1', [row.id]);
      outbox.recordSystemEmail({
        to: email, subject: 'Confirm Your Signup',
        text: 'Follow this link to confirm your user:\n' + link.action_link,
        html: '<h2>Confirm your signup</h2><p>Follow this link to confirm your user:</p><p><a href="' + link.action_link + '">Confirm your mail</a></p>',
        note: 'Sent by Supabase Auth itself in production (its default "Confirm signup" template), not by the app.'
      });
      return ok(Object.assign(userJson(row), { confirmation_sent_at: new Date().toISOString() }));
    }

    if (p === '/token' && method === 'POST') {
      const grant = String(query.grant_type || body.grant_type || '');
      if (grant === 'password') {
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        if (!email || !password) return err(400, 'validation_failed', 'missing email or phone');
        const r = await db.query(
          "select * from auth.users where lower(email) = $1 and encrypted_password <> '' and encrypted_password = extensions.crypt($2, encrypted_password) limit 1",
          [email, password]);
        const row = r.rows[0];
        if (!row) return err(400, 'invalid_credentials', 'Invalid login credentials');
        if (!row.email_confirmed_at) return err(400, 'email_not_confirmed', 'Email not confirmed');
        if (row.banned_until && new Date(row.banned_until).getTime() > Date.now()) return err(400, 'user_banned', 'User is banned');
        return ok(await issueSession(row));
      }
      if (grant === 'refresh_token') {
        const token = String(body.refresh_token || '');
        const r = await db.query('select * from aulocal.refresh_tokens where token = $1 and not revoked limit 1', [token]);
        if (!r.rows[0]) return err(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
        await db.query('update aulocal.refresh_tokens set revoked = true where token = $1', [token]);
        const row = await findById(r.rows[0].user_id);
        if (!row) return err(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
        return ok(await issueSession(row));
      }
      return err(400, 'invalid_request', 'unsupported_grant_type');
    }

    if (p === '/logout' && method === 'POST') {
      const user = await userFromBearer(req);
      if (!user) return err(401, 'no_authorization', 'This endpoint requires a Bearer token');
      await db.query('update aulocal.refresh_tokens set revoked = true where user_id = $1', [user.id]);
      return { status: 204, body: null };
    }

    if (p === '/recover' && method === 'POST') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!validEmail(email)) return err(400, 'validation_failed', 'Unable to validate email address: invalid format');
      const row = await findByEmail(email);
      if (row) {
        const link = await makeLink(row, 'recovery', query.redirect_to || body.redirect_to || '');
        await db.query('update auth.users set recovery_sent_at = now() where id = $1', [row.id]);
        outbox.recordSystemEmail({
          to: email, subject: 'Reset Your Password',
          text: 'Follow this link to reset the password for your user:\n' + link.action_link,
          html: '<h2>Reset Password</h2><p>Follow this link to reset the password for your user:</p><p><a href="' + link.action_link + '">Reset Password</a></p>',
          note: 'Sent by Supabase Auth itself in production (its default "Reset password" template). The app only falls back to this when its own branded email could not be built.'
        });
      }
      return ok({}); // GoTrue answers 200 whether or not the address exists
    }

    if (p === '/user' && method === 'GET') {
      const user = await userFromBearer(req);
      if (!user) return err(403, 'bad_jwt', 'invalid JWT: unable to parse or verify signature, or the token has expired');
      return ok(userJson(user));
    }
    if (p === '/user' && method === 'PUT') {
      const user = await userFromBearer(req);
      if (!user) return err(403, 'bad_jwt', 'invalid JWT: unable to parse or verify signature, or the token has expired');
      if (body.password !== undefined) {
        if (String(body.password).length < 6) return err(422, 'weak_password', 'Password should be at least 6 characters.');
        await db.query("update auth.users set encrypted_password = extensions.crypt($2, extensions.gen_salt('bf', 10)), updated_at = now() where id = $1", [user.id, String(body.password)]);
      }
      if (body.data && typeof body.data === 'object') {
        await db.query('update auth.users set raw_user_meta_data = $2::jsonb, updated_at = now() where id = $1', [user.id, JSON.stringify(mergeMeta(user.raw_user_meta_data, body.data))]);
      }
      return ok(userJson(await findById(user.id)));
    }

    if (p === '/verify' && (method === 'GET' || method === 'POST')) {
      const token = method === 'GET' ? query.token : (body.token_hash || body.token);
      const kind = String((method === 'GET' ? query.type : body.type) || '');
      const result = await consumeLink(token, kind);
      if (method === 'GET') {
        const redirect = safeRedirect(query.redirect_to || (result.tok && result.tok.redirect_to));
        if (result.error) {
          return { status: 303, headers: { Location: redirect + '#error=access_denied&error_code=otp_expired&error_description=' + encodeURIComponent(result.error) }, body: null };
        }
        const s = await issueSession(result.user);
        const frag = 'access_token=' + s.access_token + '&expires_at=' + s.expires_at + '&expires_in=' + s.expires_in +
          '&refresh_token=' + s.refresh_token + '&token_type=bearer&type=' + encodeURIComponent(kind || result.tok.kind);
        return { status: 303, headers: { Location: redirect + '#' + frag }, body: null };
      }
      if (result.error) return err(403, 'otp_expired', result.error);
      return ok(await issueSession(result.user));
    }

    if (p === '/authorize' && method === 'GET') {
      return {
        status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' },
        raw: '<!doctype html><meta charset="utf-8"><title>Not available locally</title><body style="font:16px/1.5 system-ui;max-width:560px;margin:80px auto;padding:0 20px">' +
          '<h1>Google / Apple sign-in is not available in the local test stack</h1>' +
          '<p>Outside sign-in providers are not emulated. Go back and sign in with an email address and password.</p>' +
          '<p><a href="' + cfg.APP_URL + '/pages/signin">Back to sign in</a></p></body>'
      };
    }

    // ── admin API (service-role key only) ──
    if (p.startsWith('/admin/')) {
      if (!isServiceRole(req)) return err(403, 'not_admin', 'User not allowed');

      if (p === '/admin/users' && method === 'POST') {
        const email = String(body.email || '').trim().toLowerCase();
        if (!validEmail(email)) return err(400, 'validation_failed', 'Unable to validate email address: invalid format');
        if (await findByEmail(email)) return err(422, 'email_exists', 'A user with this email address has already been registered');
        if (body.password !== undefined && String(body.password).length < 6) return err(422, 'weak_password', 'Password should be at least 6 characters.');
        const row = await createUser({
          id: body.id, email, password: body.password, confirmed: !!body.email_confirm,
          userMetadata: body.user_metadata || {}, appMetadata: body.app_metadata || {}
        });
        return ok(userJson(row));
      }

      if (p === '/admin/users' && method === 'GET') {
        // As in GoTrue, an `email=` parameter is NOT a filter (only `filter=` is);
        // the first page of users is returned. The app knows this and only trusts
        // an exact client-side match.
        const page = Math.max(1, Number(query.page) || 1);
        const perPage = Math.min(1000, Math.max(1, Number(query.per_page) || 50));
        const filter = String(query.filter || '').trim().toLowerCase();
        const where = filter ? 'where lower(email) like $3' : '';
        const params = filter ? [perPage, (page - 1) * perPage, '%' + filter + '%'] : [perPage, (page - 1) * perPage];
        const r = await db.query('select * from auth.users ' + where + ' order by created_at desc limit $1 offset $2', params);
        const total = await db.query('select count(*)::int as n from auth.users');
        return { status: 200, headers: { 'x-total-count': String(total.rows[0].n) }, body: { users: r.rows.map(userJson), aud: 'authenticated' } };
      }

      const m = /^\/admin\/users\/([^/]+)$/.exec(p);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const row = await findById(id);
        if (!row) return err(404, 'user_not_found', 'User not found');
        if (method === 'GET') return ok(userJson(row));
        if (method === 'DELETE') {
          await db.query('delete from aulocal.refresh_tokens where user_id = $1', [id]);
          await db.query('delete from auth.users where id = $1', [id]); // cascades like production
          return ok({});
        }
        if (method === 'PUT') {
          if (body.email !== undefined) {
            const email = String(body.email || '').trim().toLowerCase();
            if (!validEmail(email)) return err(400, 'validation_failed', 'Unable to validate email address: invalid format');
            const clash = await findByEmail(email);
            if (clash && clash.id !== id) return err(422, 'email_exists', 'A user with this email address has already been registered');
            await db.query('update auth.users set email = $2, updated_at = now() where id = $1', [id, email]);
          }
          if (body.password !== undefined) {
            if (String(body.password).length < 6) return err(422, 'weak_password', 'Password should be at least 6 characters.');
            await db.query("update auth.users set encrypted_password = extensions.crypt($2, extensions.gen_salt('bf', 10)), updated_at = now() where id = $1", [id, String(body.password)]);
          }
          if (body.email_confirm === true) await db.query('update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now() where id = $1', [id]);
          if (body.user_metadata && typeof body.user_metadata === 'object') {
            await db.query('update auth.users set raw_user_meta_data = $2::jsonb, updated_at = now() where id = $1', [id, JSON.stringify(mergeMeta(row.raw_user_meta_data, body.user_metadata))]);
          }
          if (body.app_metadata && typeof body.app_metadata === 'object') {
            await db.query('update auth.users set raw_app_meta_data = $2::jsonb, updated_at = now() where id = $1', [id, JSON.stringify(mergeMeta(row.raw_app_meta_data, body.app_metadata))]);
          }
          if (body.ban_duration !== undefined) {
            const d = String(body.ban_duration);
            if (d === 'none') await db.query('update auth.users set banned_until = null where id = $1', [id]);
            else {
              const hours = /(\d+)h/.exec(d);
              await db.query("update auth.users set banned_until = now() + ($2 || ' hours')::interval where id = $1", [id, hours ? hours[1] : '876000']);
            }
          }
          return ok(userJson(await findById(id)));
        }
      }

      if (p === '/admin/generate_link' && method === 'POST') {
        const kind = String(body.type || '');
        const email = String(body.email || '').trim().toLowerCase();
        const redirectTo = (body.options && body.options.redirect_to) || body.redirect_to || '';
        if (!['signup', 'invite', 'magiclink', 'recovery', 'email_change_current', 'email_change_new'].includes(kind)) {
          return err(400, 'validation_failed', 'Invalid link type: ' + kind);
        }
        let row = await findByEmail(email);
        if (kind === 'signup' || kind === 'invite') {
          if (row && row.email_confirmed_at) return err(422, 'email_exists', 'A user with this email address has already been registered');
          if (!row) row = await createUser({ email, password: body.password, confirmed: false, userMetadata: body.data || {} });
        }
        if (!row) return err(404, 'user_not_found', 'User with this email not found');
        const isChange = kind.startsWith('email_change');
        const newEmail = isChange ? String(body.new_email || '').trim().toLowerCase() : '';
        const link = await makeLink(row, isChange ? 'email_change' : kind, redirectTo, newEmail);
        if (kind === 'recovery') await db.query('update auth.users set recovery_sent_at = now() where id = $1', [row.id]);
        return ok(Object.assign(userJson(await findById(row.id)), link));
      }
    }

    // Anything else is an auth endpoint the app was not known to use when this
    // emulator was written. Say so loudly instead of pretending.
    outbox.note('auth', 'UNEMULATED auth endpoint called: ' + method + ' /auth/v1' + p);
    return err(404, 'not_found', 'The local auth emulator does not implement ' + method + ' /auth/v1' + p);
  }

  return { handle, createUser, findByEmail, findById, userJson };
}

module.exports = { createAuthEmulator };
