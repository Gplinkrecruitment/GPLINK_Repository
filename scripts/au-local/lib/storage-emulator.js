'use strict';
/*
 * A file-backed stand-in for Supabase Storage, covering the calls the app makes.
 * File bytes live under ~/gplink-tools/au-local/storage/; one row per file is
 * kept in the local database's storage.objects table (as in production).
 *
 * Endpoints (all under /storage/v1):
 *   POST|PUT /object/<bucket>/<path>                 upload (x-upsert honoured; 409 if it exists otherwise)
 *   GET      /object/<bucket>/<path>                 download (needs the service key)
 *   GET      /object/authenticated/<bucket>/<path>   download (needs the service key)
 *   GET      /object/public/<bucket>/<path>          download, no key (public buckets only)
 *   HEAD     /object/...                             as GET, headers only
 *   DELETE   /object/<bucket>/<path>                 delete one file
 *   DELETE   /object/<bucket>   {prefixes:[...]}     delete several files
 *   POST     /object/sign/<bucket>/<path>            make a time-limited download link
 *   GET      /object/sign/<bucket>/<path>?token=     download through that link
 *   POST     /object/upload/sign/<bucket>/<path>     make a one-time upload link
 *   PUT      /object/upload/sign/<bucket>/<path>?token=   upload through that link (browser)
 *   POST     /object/list/<bucket>                   list files under a prefix
 *   GET      /bucket          GET /bucket/<id>       POST /bucket
 *
 * Differences from the real service: buckets are created on first use rather
 * than rejected as unknown; image transformation, resumable (TUS) uploads and
 * S3 access are not provided.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config.js');

// Buckets the app builds PUBLIC links for (see buildSupabaseStoragePublicUrl
// callers in server.js). Everything else is private, as in production.
const PUBLIC_BUCKETS = new Set(String(process.env.AU_LOCAL_PUBLIC_BUCKETS ||
  'practice-intro-videos,career-hero-images,practice-images,practice-media,career-role-images,social-creatives,public-assets')
  .split(',').map((s) => s.trim()).filter(Boolean));

function createStorageEmulator(deps) {
  const { db, secrets, outbox } = deps;

  function fileFor(bucket, name) {
    const h = crypto.createHash('sha256').update(bucket + '\n' + name).digest('hex');
    return path.join(cfg.PATHS.storage, bucket.replace(/[^A-Za-z0-9._-]/g, '_'), h.slice(0, 2), h);
  }
  function err(status, error, message) {
    return { status, body: { statusCode: String(status === 400 && error === 'not_found' ? 404 : status), error, message } };
  }
  function isService(req) {
    const h = String(req.headers.authorization || '');
    const token = h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
    const claims = cfg.verifyJwt(token, secrets.jwtSecret);
    return !!(claims && claims.role === 'service_role');
  }
  function splitTarget(rest) {
    // rest = "<bucket>/<path...>" (still URL-encoded)
    const parts = rest.split('/').filter((x) => x.length);
    const bucket = decodeURIComponent(parts.shift() || '');
    const name = parts.map((seg) => { try { return decodeURIComponent(seg); } catch (e) { return seg; } }).join('/');
    return { bucket, name };
  }
  async function ensureBucket(bucket) {
    await db.query('insert into storage.buckets (id, name, public) values ($1, $1, $2) on conflict (id) do nothing', [bucket, PUBLIC_BUCKETS.has(bucket)]);
  }
  async function getObject(bucket, name) {
    const r = await db.query('select * from storage.objects where bucket_id = $1 and name = $2 limit 1', [bucket, name]);
    return r.rows[0] || null;
  }

  async function putObject(bucket, name, buffer, mimeType, upsert) {
    if (!bucket || !name) return err(400, 'InvalidKey', 'Invalid key');
    await ensureBucket(bucket);
    const existing = await getObject(bucket, name);
    if (existing && !upsert) return err(400, 'Duplicate', 'The resource already exists');
    const file = fileFor(bucket, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);
    const meta = {
      size: buffer.length, mimetype: mimeType || 'application/octet-stream',
      eTag: '"' + crypto.createHash('md5').update(buffer).digest('hex') + '"',
      cacheControl: 'max-age=3600', contentLength: buffer.length, lastModified: new Date().toISOString(), httpStatusCode: 200
    };
    const r = await db.query(
      `insert into storage.objects (bucket_id, name, metadata) values ($1, $2, $3::jsonb)
       on conflict (bucket_id, name) do update set metadata = excluded.metadata, updated_at = now()
       returning id`, [bucket, name, JSON.stringify(meta)]);
    return { status: 200, body: { Key: bucket + '/' + name, Id: r.rows[0].id } };
  }

  async function sendObject(bucket, name, query, headOnly) {
    const row = await getObject(bucket, name);
    const file = fileFor(bucket, name);
    if (!row || !fs.existsSync(file)) return err(400, 'not_found', 'Object not found');
    const meta = row.metadata || {};
    const headers = {
      'Content-Type': meta.mimetype || 'application/octet-stream',
      'Content-Length': String(fs.statSync(file).size),
      'Cache-Control': meta.cacheControl || 'max-age=3600',
      ETag: meta.eTag || '',
      'Last-Modified': new Date(row.updated_at).toUTCString()
    };
    if (query.download !== undefined) {
      const fname = String(query.download || '') || name.split('/').pop();
      headers['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(fname);
    }
    return { status: 200, headers, rawBuffer: headOnly ? Buffer.alloc(0) : fs.readFileSync(file), keepLength: headOnly };
  }

  async function handle(req, res, pathname, query, rawBody) {
    const method = req.method.toUpperCase();
    const p = pathname;
    const jsonBody = () => { try { return JSON.parse(rawBody.toString('utf8') || '{}'); } catch (e) { return {}; } };
    const upsert = String(req.headers['x-upsert'] || '').toLowerCase() === 'true';
    const contentType = String(req.headers['content-type'] || 'application/octet-stream');

    function uploadPayload() {
      // The app sends raw bytes. supabase-js sends multipart/form-data; unwrap the first file part.
      if (!/^multipart\/form-data/i.test(contentType)) return { buffer: rawBody, mime: contentType.split(';')[0].trim() };
      const b = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
      if (!b) return { buffer: rawBody, mime: 'application/octet-stream' };
      const boundary = Buffer.from('--' + (b[1] || b[2]));
      let start = rawBody.indexOf(boundary);
      while (start !== -1) {
        const headEnd = rawBody.indexOf('\r\n\r\n', start);
        const next = rawBody.indexOf(boundary, start + boundary.length);
        if (headEnd === -1 || next === -1) break;
        const head = rawBody.slice(start, headEnd).toString('utf8');
        if (/filename=/i.test(head) || /name="?(file|)"?/i.test(head)) {
          const mime = (/content-type:\s*([^\r\n;]+)/i.exec(head) || [])[1] || 'application/octet-stream';
          return { buffer: rawBody.slice(headEnd + 4, next - 2), mime: mime.trim() };
        }
        start = next;
      }
      return { buffer: rawBody, mime: 'application/octet-stream' };
    }

    // ── signed upload ──
    let m = /^\/object\/upload\/sign\/(.+)$/.exec(p);
    if (m) {
      const { bucket, name } = splitTarget(m[1]);
      if (method === 'POST') {
        if (!isService(req)) return err(400, 'Unauthorized', 'new row violates row-level security policy');
        await ensureBucket(bucket);
        if (!upsert && await getObject(bucket, name)) return err(400, 'Duplicate', 'The resource already exists');
        const token = cfg.signJwt({ url: bucket + '/' + name, upsert, owner: null, exp: Math.floor(Date.now() / 1000) + 2 * 3600 }, secrets.jwtSecret);
        const encoded = encodeURIComponent(bucket) + '/' + name.split('/').map(encodeURIComponent).join('/');
        return { status: 200, body: { url: '/object/upload/sign/' + encoded + '?token=' + token, token } };
      }
      if (method === 'PUT') {
        const claims = cfg.verifyJwt(String(query.token || ''), secrets.jwtSecret);
        if (!claims || claims.url !== bucket + '/' + name) return err(400, 'InvalidSignature', 'signature verification failed');
        const up = uploadPayload();
        return putObject(bucket, name, up.buffer, up.mime, !!claims.upsert || upsert);
      }
    }

    // ── signed download ──
    m = /^\/object\/sign\/(.+)$/.exec(p);
    if (m) {
      const { bucket, name } = splitTarget(m[1]);
      if (method === 'POST') {
        if (!isService(req)) return err(400, 'Unauthorized', 'new row violates row-level security policy');
        const body = jsonBody();
        if (!(await getObject(bucket, name))) return err(400, 'not_found', 'Object not found');
        const expiresIn = Math.max(1, Number(body.expiresIn) || 3600);
        const token = cfg.signJwt({ url: bucket + '/' + name, exp: Math.floor(Date.now() / 1000) + expiresIn }, secrets.jwtSecret);
        const encoded = encodeURIComponent(bucket) + '/' + name.split('/').map(encodeURIComponent).join('/');
        let signed = '/object/sign/' + encoded + '?token=' + token;
        if (body.download) signed += '&download=' + encodeURIComponent(body.download === true ? '' : String(body.download));
        return { status: 200, body: { signedURL: signed } };
      }
      if (method === 'GET' || method === 'HEAD') {
        const claims = cfg.verifyJwt(String(query.token || ''), secrets.jwtSecret);
        if (!claims || claims.url !== bucket + '/' + name) return err(400, 'InvalidJWT', 'signature verification failed');
        return sendObject(bucket, name, query, method === 'HEAD');
      }
    }

    // ── list ──
    m = /^\/object\/list\/([^/]+)$/.exec(p);
    if (m && method === 'POST') {
      if (!isService(req)) return { status: 200, body: [] };
      const body = jsonBody();
      const bucket = decodeURIComponent(m[1]);
      const prefix = String(body.prefix || '').replace(/^\/+/, '');
      const r = await db.query('select * from storage.objects where bucket_id = $1 and name like $2 order by name limit $3',
        [bucket, prefix.replace(/[%_]/g, '\\$&') + '%', Math.min(1000, Number(body.limit) || 100)]);
      return { status: 200, body: r.rows.map((o) => ({ name: o.name.slice(prefix.length).replace(/^\//, ''), id: o.id, updated_at: o.updated_at, created_at: o.created_at, last_accessed_at: o.last_accessed_at, metadata: o.metadata })) };
    }

    // ── public download ──
    m = /^\/object\/public\/(.+)$/.exec(p);
    if (m && (method === 'GET' || method === 'HEAD')) {
      const { bucket, name } = splitTarget(m[1]);
      const b = await db.query('select public from storage.buckets where id = $1', [bucket]);
      if (!b.rows[0] || !b.rows[0].public) return err(400, 'Bucket not found', 'Bucket not found');
      return sendObject(bucket, name, query, method === 'HEAD');
    }

    // ── buckets ──
    if (p === '/bucket' && method === 'GET') {
      if (!isService(req)) return { status: 200, body: [] };
      const r = await db.query('select * from storage.buckets order by id');
      return { status: 200, body: r.rows };
    }
    if (p === '/bucket' && method === 'POST') {
      if (!isService(req)) return err(400, 'Unauthorized', 'new row violates row-level security policy');
      const body = jsonBody();
      const id = String(body.id || body.name || '');
      await db.query('insert into storage.buckets (id, name, public) values ($1, $2, $3) on conflict (id) do update set public = excluded.public', [id, body.name || id, !!body.public]);
      return { status: 200, body: { name: id } };
    }
    m = /^\/bucket\/([^/]+)$/.exec(p);
    if (m && method === 'GET') {
      const r = await db.query('select * from storage.buckets where id = $1', [decodeURIComponent(m[1])]);
      return r.rows[0] ? { status: 200, body: r.rows[0] } : err(400, 'Bucket not found', 'Bucket not found');
    }

    // ── plain object access (service key) ──
    m = /^\/object\/(?:authenticated\/)?(.+)$/.exec(p);
    if (m) {
      if (!isService(req)) return err(400, 'Unauthorized', 'new row violates row-level security policy');
      const { bucket, name } = splitTarget(m[1]);
      if (method === 'POST' || method === 'PUT') {
        const up = uploadPayload();
        return putObject(bucket, name, up.buffer, up.mime, upsert || method === 'PUT');
      }
      if (method === 'GET' || method === 'HEAD') return sendObject(bucket, name, query, method === 'HEAD');
      if (method === 'DELETE') {
        if (!name) {
          const body = jsonBody();
          const prefixes = Array.isArray(body.prefixes) ? body.prefixes.map(String) : [];
          const gone = [];
          for (const n of prefixes) {
            const row = await getObject(bucket, n);
            if (!row) continue;
            await db.query('delete from storage.objects where id = $1', [row.id]);
            fs.rmSync(fileFor(bucket, n), { force: true });
            gone.push({ name: n, bucket_id: bucket, id: row.id });
          }
          return { status: 200, body: gone };
        }
        const row = await getObject(bucket, name);
        if (!row) return err(400, 'not_found', 'Object not found');
        await db.query('delete from storage.objects where id = $1', [row.id]);
        fs.rmSync(fileFor(bucket, name), { force: true });
        return { status: 200, body: { message: 'Successfully deleted' } };
      }
    }

    outbox.note('storage', 'UNEMULATED storage endpoint called: ' + method + ' /storage/v1' + p);
    return err(404, 'not_found', 'The local storage emulator does not implement ' + method + ' /storage/v1' + p);
  }

  return { handle, putObject };
}

module.exports = { createStorageEmulator };
