'use strict';

/**
 * A small in-memory PostgREST (Supabase REST) emulator for Australian GP build
 * tests. Same idea as the one in tests/account-export.test.js, with three
 * additions the AU packages need:
 *
 *   1. It can pretend the WP-02 migration has NOT been applied: a request that
 *      names a missing column gets PostgREST's real answer (400, code 42703),
 *      and a missing table gets 404 / PGRST205. Use `missingColumns` and
 *      `missingTables`.
 *   2. It records every request (`emu.requests`), so a test can prove what the
 *      server did or did not ask the database.
 *   3. `forbid(fn)` makes any matching request FAIL with a 500 and records it in
 *      `emu.violations`. That is how "with the switch off, nothing names a new
 *      column" is proved.
 *
 * Usage:
 *   const { startAuSupabaseEmulator } = require('./helpers/au-supabase-emulator.js');
 *   const emu = await startAuSupabaseEmulator({ tables: buildAuFixtureDb(doctors) });
 *   process.env.SUPABASE_URL = emu.url;            // before importing server.js
 *   ...
 *   await emu.close();
 *
 * Supported: GET with select= projection, eq / neq / in / is / not.is filters,
 * limit; POST insert and upsert (on_conflict=col, merge-duplicates);
 * PATCH; DELETE; /auth/v1 and /storage/v1 answer 200 {}.
 */

const http = require('http');
const crypto = require('crypto');

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or', 'and', 'columns']);
const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'not', 'cs', 'cd', 'ov'];

function parseFilters(searchParams) {
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (RESERVED.has(key)) continue;
    const dot = raw.indexOf('.');
    const op = dot > 0 ? raw.slice(0, dot) : '';
    if (FILTER_OPS.indexOf(op) === -1) continue;
    filters.push({ col: key, op, val: raw.slice(dot + 1) });
  }
  return filters;
}

// A JSON path column (`state->>key`, `state->a->>b`), as PostgREST reads it:
// `->>` gives text, `->` gives the JSON value, a missing key gives null.
// Added by WP-05 for the "started the Australian branch" marker on user_state.
function isJsonPath(col) { return typeof col === 'string' && col.indexOf('->') !== -1; }
function jsonPathCell(row, col) {
  const asText = /->>[^>]*$/.test(col);
  const parts = col.split(/->>?/);
  let v = row ? row[parts[0]] : undefined;
  for (let i = 1; i < parts.length; i++) {
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = undefined; } }
    v = v && typeof v === 'object' ? v[parts[i]] : undefined;
  }
  if (v === undefined || v === null) return null;
  return asText && typeof v !== 'string' ? JSON.stringify(v) : v;
}

function matcher(filters) {
  return function (row) {
    return filters.every(function (f) {
      const cell = isJsonPath(f.col) ? jsonPathCell(row, f.col) : (row ? row[f.col] : undefined);
      if (f.op === 'eq') return String(cell) === f.val;
      if (f.op === 'neq') return String(cell) !== f.val;
      if (f.op === 'is') return f.val === 'null' ? (cell === null || cell === undefined) : String(cell) === f.val;
      if (f.op === 'not') {
        if (f.val === 'is.null') return !(cell === null || cell === undefined);
        return true;
      }
      if (f.op === 'in') {
        return f.val.replace(/^\(/, '').replace(/\)$/, '').split(',')
          .map(function (s) { return s.trim().replace(/^"/, '').replace(/"$/, ''); })
          .indexOf(String(cell)) !== -1;
      }
      return true;
    });
  };
}

function selectColumns(searchParams) {
  const raw = searchParams.get('select');
  if (!raw || raw === '*') return null;
  // Plain column lists only (no embedded resources): enough for these tests.
  return raw.split(',').map(function (s) { return s.trim().split(':').pop().split('::')[0]; }).filter(Boolean);
}

// alias -> JSON path, for select items like `marker:state->>marker` (or a bare
// `state->>marker`, which PostgREST names after the last key).
function selectJsonAliases(searchParams) {
  const raw = searchParams.get('select');
  const out = {};
  if (!raw || raw === '*') return out;
  raw.split(',').forEach(function (item) {
    const t = item.trim();
    const colon = t.indexOf(':');
    const expr = (colon !== -1 && t.slice(colon + 1).indexOf(':') !== 0 ? t.slice(colon + 1) : t).split('::')[0];
    if (!isJsonPath(expr)) return;
    const alias = colon !== -1 && t.slice(colon + 1).indexOf(':') !== 0 ? t.slice(0, colon) : expr.split(/->>?/).pop();
    out[expr] = alias;
  });
  return out;
}

function readBody(req) {
  return new Promise(function (resolve) {
    const chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve({ text, json: JSON.parse(text || 'null') }); } catch (e) { resolve({ text, json: null }); }
    });
  });
}

/**
 * @param {object} [options]
 * @param {object} [options.tables]          { tableName: [rows] } (copied)
 * @param {object} [options.missingColumns]  { tableName: ['col', ...] } treated as not existing
 * @param {string[]} [options.missingTables] tables treated as not existing
 * @param {object} [options.failTables]      { tableName: status } answer every request with that status
 * @param {object} [options.rpc]             { functionName: (body) => result } answers POST /rest/v1/rpc/<name>; default null
 * @param {object} [options.defaults]       { tableName: { column: value } } column defaults applied on insert (WP-11); default: none
 * @param {boolean} [options.auth]           emulate the Supabase Auth admin calls (WP-06); default: /auth/v1 answers 200 {}
 * @param {object} [options.unique]          { tableName: [ (row) => key | null, ... ] } unique indexes the real database has
 *                                           (WP-13). An insert whose key (non-null) equals an existing row's is refused the way
 *                                           PostgREST refuses it: 409 with code 23505, nothing written. Default: none. Ready-made
 *                                           rules: PRODUCTION_UNIQUE_RULES (exported).
 * @returns {Promise<object>} emulator handle
 */
function startAuSupabaseEmulator(options) {
  const o = options || {};
  const db = {};
  Object.keys(o.tables || {}).forEach(function (t) {
    db[t] = (o.tables[t] || []).map(function (r) { return JSON.parse(JSON.stringify(r)); });
  });
  const emu = {
    db,
    requests: [],
    violations: [],
    missingColumns: Object.assign({}, o.missingColumns || {}),
    missingTables: new Set(o.missingTables || []),
    failTables: Object.assign({}, o.failTables || {}),
    rpc: Object.assign({}, o.rpc || {}),
    defaults: Object.assign({}, o.defaults || {}),
    unique: Object.assign({}, o.unique || {}),
    jitterMs: Number(o.jitterMs) || 0,
    // WP-06, opt-in with `auth: true`: emulate the few Supabase Auth admin
    // calls the staff "Add candidate" flow makes (create / look up / delete a
    // user, generate a recovery link). `authUsers` is the account store,
    // `authRequests` records every auth call, `authFail` = { path: status }.
    auth: o.auth === true,
    authUsers: [],
    authRequests: [],
    authTokens: {},
    authFail: {},
    _forbid: null,
    url: '',
    port: 0,
    server: null,
    table: function (name) { if (!db[name]) db[name] = []; return db[name]; },
    /** Fail (500) and record any request for which fn(request) returns a string reason. */
    forbid: function (fn) { emu._forbid = typeof fn === 'function' ? fn : null; },
    reset: function () { emu.requests.length = 0; emu.violations.length = 0; },
    requestsTo: function (table) { return emu.requests.filter(function (r) { return r.table === table; }); },
    close: function () { return new Promise(function (resolve) { emu.server.close(function () { resolve(); }); }); }
  };

  emu.server = http.createServer(async function (req, res) {
    const u = new URL(req.url, 'http://sb.local');
    const send = function (status, payload) {
      const flush = function () {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      // WP-13, opt-in (`emu.jitterMs`): answer after a random short delay, so
      // two requests the server is running at once interleave differently
      // every time. The write itself has already happened, in arrival order,
      // exactly as in a real database: only the answer is late.
      if (emu.jitterMs > 0) setTimeout(flush, Math.random() * emu.jitterMs);
      else flush();
    };
    if (u.pathname.indexOf('/auth/v1/') === 0) {
      const authBody = await readBody(req);
      // Opt-in (WP-06): a small account store for the staff "Add candidate"
      // flow. Off by default, so every other test still gets `200 {}`.
      if (emu.auth) {
        const authPath = u.pathname.slice('/auth/v1/'.length);
        emu.authRequests.push({ method: req.method, path: authPath, body: authBody.json });
        if (emu.authFail && emu.authFail[authPath]) { send(emu.authFail[authPath], { message: 'forced failure' }); return; }
        if (authPath === 'admin/users' && req.method === 'POST') {
          const email = String((authBody.json && authBody.json.email) || '').toLowerCase();
          if (emu.authUsers.some(function (x) { return x.email === email; })) { send(422, { msg: 'A user with this email address has already been registered' }); return; }
          const user = {
            id: crypto.randomUUID(), email,
            user_metadata: (authBody.json && authBody.json.user_metadata) || {},
            app_metadata: (authBody.json && authBody.json.app_metadata) || {},
            has_password: !!(authBody.json && authBody.json.password)
          };
          emu.authUsers.push(user);
          send(200, user);
          return;
        }
        if (authPath === 'admin/users' && req.method === 'GET') {
          const want = String(u.searchParams.get('email') || '').toLowerCase();
          send(200, { users: emu.authUsers.filter(function (x) { return !want || x.email === want; }) });
          return;
        }
        const one = authPath.match(/^admin\/users\/([^/]+)$/);
        if (one) {
          const idx = emu.authUsers.findIndex(function (x) { return x.id === decodeURIComponent(one[1]); });
          if (idx === -1) { send(404, { msg: 'User not found' }); return; }
          if (req.method === 'DELETE') { emu.authUsers.splice(idx, 1); send(200, {}); return; }
          // FB-1: an admin PUT merges metadata the way GoTrue does (top-level
          // keys of app_metadata / user_metadata), so a test can see the
          // app-owned "email verified" stamp land.
          if (req.method === 'PUT' && authBody.json && typeof authBody.json === 'object') {
            const target = emu.authUsers[idx];
            if (authBody.json.app_metadata && typeof authBody.json.app_metadata === 'object') {
              target.app_metadata = Object.assign({}, target.app_metadata || {}, authBody.json.app_metadata);
            }
            if (authBody.json.user_metadata && typeof authBody.json.user_metadata === 'object') {
              target.user_metadata = Object.assign({}, target.user_metadata || {}, authBody.json.user_metadata);
            }
          }
          send(200, emu.authUsers[idx]);
          return;
        }
        // FB-1: the doctor's own "update my user" call (PUT /auth/v1/user with
        // a bearer access token), which is how a recovery link sets a
        // password. A test maps a token to an account with
        // `emu.authTokens[token] = userId`; the call then answers with that
        // account, as GoTrue does. An unknown token answers 401. With no
        // mapping at all the old answer (200 {}) is kept.
        if (authPath === 'user' && req.method === 'PUT' && emu.authTokens && Object.keys(emu.authTokens).length) {
          const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
          const tokenUser = emu.authUsers.find(function (x) { return x.id === emu.authTokens[bearer]; });
          if (!tokenUser) { send(401, { msg: 'invalid token' }); return; }
          if (authBody.json && authBody.json.password) tokenUser.has_password = true;
          send(200, tokenUser);
          return;
        }
        if (authPath === 'admin/generate_link' && req.method === 'POST') {
          send(200, { action_link: emu.url + '/auth/v1/verify?token=test-recovery-token&type=recovery' });
          return;
        }
      }
      send(200, {});
      return;
    }
    if (u.pathname.indexOf('/storage/v1/') === 0) { await readBody(req); send(200, { Key: 'ok' }); return; }
    const m = u.pathname.match(/^\/rest\/v1\/(rpc\/)?([^/]+)$/);
    if (!m) { await readBody(req); send(404, { message: 'not found' }); return; }
    const table = decodeURIComponent(m[2]);
    const body = await readBody(req);
    const cols = selectColumns(u.searchParams);
    const jsonAliases = selectJsonAliases(u.searchParams);
    const filters = parseFilters(u.searchParams);
    const bodyRows = Array.isArray(body.json) ? body.json : (body.json && typeof body.json === 'object' ? [body.json] : []);
    const bodyKeys = [];
    bodyRows.forEach(function (r) { Object.keys(r || {}).forEach(function (k) { if (bodyKeys.indexOf(k) === -1) bodyKeys.push(k); }); });
    const record = {
      method: req.method,
      table,
      rpc: !!m[1],
      query: decodeURIComponent(u.search || ''),
      select: cols,
      filterColumns: filters.map(function (f) { return f.col; }),
      bodyKeys,
      body: body.json,
      prefer: String(req.headers.prefer || '')
    };
    emu.requests.push(record);

    // WP-13, opt-in (`emu.hold = (record) => ms`): the request is still "in
    // flight" for that long before the database sees it (a slow network hop,
    // a paused server process). Unlike `jitterMs`, this delays the WRITE.
    if (typeof emu.hold === 'function') {
      const holdMs = Number(emu.hold(record)) || 0;
      if (holdMs > 0) await new Promise(function (resolve) { setTimeout(resolve, holdMs); });
    }

    if (emu._forbid) {
      const why = emu._forbid(record);
      if (why) {
        emu.violations.push({ why: String(why), method: record.method, table, query: record.query, bodyKeys });
        send(500, { message: 'forbidden by test: ' + why });
        return;
      }
    }
    if (m[1]) {
      // WP-07: `rpc: { name: fn }` answers a database function (for example
      // rate_limit_hit); without a handler it answers null, as before.
      const rpcFn = emu.rpc[table];
      send(200, typeof rpcFn === 'function' ? rpcFn(body.json) : null);
      return;
    }
    if (emu.failTables[table]) { send(emu.failTables[table], { message: 'forced failure' }); return; }
    if (emu.missingTables.has(table)) {
      send(404, { code: 'PGRST205', message: "Could not find the table 'public." + table + "' in the schema cache" });
      return;
    }
    const missing = emu.missingColumns[table] || [];
    const named = (cols || []).concat(record.filterColumns).concat(bodyKeys);
    const bad = named.filter(function (c) { return missing.indexOf(c) !== -1; })[0];
    if (bad) {
      send(400, { code: '42703', message: 'column ' + table + '.' + bad + ' does not exist' });
      return;
    }

    const rows = emu.table(table);
    const matches = matcher(filters);
    const project = function (row) {
      // select=* on a table with "missing" columns must not leak them.
      const base = {};
      Object.keys(row).forEach(function (k) { if (missing.indexOf(k) === -1) base[k] = row[k]; });
      if (!cols) return base;
      const out = {};
      cols.forEach(function (c) {
        if (Object.prototype.hasOwnProperty.call(jsonAliases, c)) { out[jsonAliases[c]] = jsonPathCell(base, c); return; }
        out[c] = base[c] === undefined ? null : base[c];
      });
      return out;
    };
    const wantsRows = /return=representation/.test(record.prefer);

    if (req.method === 'GET' || req.method === 'HEAD') {
      let out = rows.filter(matches);
      const limit = parseInt(u.searchParams.get('limit') || '', 10);
      if (Number.isFinite(limit)) out = out.slice(0, limit);
      send(200, out.map(project));
      return;
    }
    if (req.method === 'POST') {
      const conflict = u.searchParams.get('on_conflict');
      const merge = /resolution=merge-duplicates/.test(record.prefer);
      // WP-13, opt-in: the unique indexes the real database enforces. A
      // plain insert that collides is refused whole, as PostgREST does.
      const uniqueRules = (!merge && emu.unique[table]) || [];
      if (uniqueRules.length) {
        const clash = bodyRows.some(function (incoming, idx) {
          const candidate = Object.assign({}, emu.defaults[table] || {}, incoming);
          return uniqueRules.some(function (keyOf) {
            const key = keyOf(candidate);
            if (key === null || key === undefined) return false;
            return rows.some(function (r) { return keyOf(r) === key; })
              || bodyRows.slice(0, idx).some(function (b) { return keyOf(Object.assign({}, emu.defaults[table] || {}, b)) === key; });
          });
        });
        if (clash) {
          record.uniqueViolation = true;
          send(409, { code: '23505', details: null, hint: null, message: 'duplicate key value violates unique constraint' });
          return;
        }
      }
      const saved = bodyRows.map(function (incoming) {
        if (conflict && merge) {
          // on_conflict may name several columns (user_documents is unique on
          // user_id,document_key,country_code): every one of them must match.
          const conflictCols = conflict.split(',').map(function (c) { return c.trim(); }).filter(Boolean);
          const existing = rows.filter(function (r) {
            return conflictCols.every(function (c) { return String(r[c]) === String(incoming[c]); });
          })[0];
          if (existing) { Object.assign(existing, incoming); return existing; }
        }
        // WP-11, opt-in: column defaults the real database applies on insert
        // (for example registration_tasks.status = 'open'). Without them a row
        // inserted with no status never matches a `status=in.(open,...)` read.
        const row = Object.assign(table === 'gp_credentials' ? {} : { id: crypto.randomUUID() }, emu.defaults[table] || {}, incoming);
        rows.push(row);
        return row;
      });
      send(201, wantsRows || !/return=minimal/.test(record.prefer) ? saved.map(project) : '');
      return;
    }
    if (req.method === 'PATCH') {
      const matched = rows.filter(matches);
      matched.forEach(function (row) { Object.assign(row, bodyRows[0] || {}); });
      send(200, wantsRows || !/return=minimal/.test(record.prefer) ? matched.map(project) : '');
      return;
    }
    if (req.method === 'DELETE') {
      const keep = rows.filter(function (r) { return !matches(r); });
      rows.length = 0;
      keep.forEach(function (r) { rows.push(r); });
      send(200, []);
      return;
    }
    send(200, []);
  });

  return new Promise(function (resolve) {
    emu.server.listen(0, '127.0.0.1', function () {
      emu.port = emu.server.address().port;
      emu.url = 'http://127.0.0.1:' + emu.port;
      resolve(emu);
    });
  });
}

// The unique indexes of the live database that the Australian build leans on,
// as rules for the `unique` option:
//   gp_nudge_log_unique              (user_id, nudge_key, channel): the
//                                    once-ever ledger. This is what makes a
//                                    "claim" atomic in production.
//   uniq_au_lifecycle_task (WP-13)   one WP-13 task per case, placement, kind
//                                    and mark, not counting ones undone.
function metaOfRow(row) {
  let m = row && row.metadata;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch (e) { m = null; } }
  return m && typeof m === 'object' ? m : {};
}
const PRODUCTION_UNIQUE_RULES = Object.freeze({
  gp_nudge_log: Object.freeze([
    function (row) { return [row.user_id, row.nudge_key, row.channel].join('|'); }
  ]),
  registration_tasks: Object.freeze([
    function (row) {
      const m = metaOfRow(row);
      if (!m.lifecycle_kind || m.undone === true) return null;
      return [row.case_id, m.placement_key == null ? '' : m.placement_key, m.lifecycle_kind, m.mark == null ? '' : m.mark].join('|');
    }
  ]),
  // WP-14: uniq_visa_nomination_transfer (one transfer case per doctor and placement).
  visa_applications: Object.freeze([
    function (row) {
      if (row.case_type !== 'nomination_transfer') return null;
      return [row.user_id, row.transfer_placement_key == null ? '' : row.transfer_placement_key].join('|');
    }
  ])
});

/**
 * The `forbid` rule that proves the switch-off guarantee: returns a reason when
 * a request names anything WP-02 added, otherwise ''. Later packages extend the
 * lists in tests/helpers/au-fixtures.js as they add columns.
 */
function wp02NewNameViolation(request, names) {
  const n = names || {};
  const newColumns = n.columns || [];
  const newTables = n.tables || [];
  if (newTables.indexOf(request.table) !== -1) return 'table ' + request.table;
  const text = request.query + ' ' + JSON.stringify(request.body == null ? '' : request.body);
  // The pathway and credentials names are unique enough to search for anywhere.
  const anywhere = ['candidate_pathway', 'candidate_basis', 'pathway_set_by', 'pathway_set_at',
    'pathway_confirmed_at', 'pathway_confirmed_by', 'gp_credentials', 'moratorium_19ab'];
  for (let i = 0; i < anywhere.length; i++) {
    if (text.indexOf(anywhere[i]) !== -1) return 'mentions ' + anywhere[i];
  }
  const named = (request.select || []).concat(request.filterColumns).concat(request.bodyKeys);
  if (request.table === 'user_profiles') {
    const hit = named.filter(function (c) { return newColumns.indexOf(c) !== -1; })[0];
    if (hit) return 'user_profiles.' + hit;
  }
  if (request.table === 'registration_cases' && named.indexOf('pathway') !== -1) return 'registration_cases.pathway';
  return '';
}

module.exports = { startAuSupabaseEmulator, wp02NewNameViolation, PRODUCTION_UNIQUE_RULES };
