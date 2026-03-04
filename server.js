const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const AUTH_DISABLED = process.env.AUTH_DISABLED === 'true';
const OTP_TTL_MS = Number(process.env.OTP_TTL_MS || 5 * 60 * 1000);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 10 * 60 * 1000);
const RATE_MAX_SEND = Number(process.env.RATE_MAX_SEND || 5);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 12 * 60 * 60 * 1000);
const MAX_JSON_BODY_BYTES = Number(process.env.MAX_JSON_BODY_BYTES || 8 * 1024 * 1024);
const SECRET = process.env.AUTH_SECRET || 'replace-me-in-production';
const COOKIE_NAME = 'gp_session';
const ADMIN_COOKIE_NAME = process.env.ADMIN_COOKIE_NAME || 'gp_admin_session';
const ADMIN_SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_MS || 8 * 60 * 60 * 1000);
const ADMIN_ALLOWED_HOSTS = new Set(
  String(process.env.ADMIN_ALLOWED_HOSTS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);
const DEFAULT_DB_FILE_PATH = process.env.VERCEL
  ? path.join('/tmp', 'app-db.json')
  : path.join(process.cwd(), 'data', 'app-db.json');
const DB_FILE_PATH = process.env.DB_FILE_PATH || DEFAULT_DB_FILE_PATH;
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_PUBLISHABLE_KEY = String(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);

function validateRuntimeConfig() {
  if (NODE_ENV !== 'production') return;

  if (!SECRET || SECRET === 'replace-me-in-production') {
    throw new Error('AUTH_SECRET must be set to a strong value in production.');
  }

  if (!AUTH_DISABLED && (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY)) {
    throw new Error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set in production when auth is enabled.');
  }

  if (ADMIN_EMAILS.size === 0) {
    console.warn('[WARN] ADMIN_EMAILS is empty. Admin routes will be inaccessible in production.');
  }

  if (ADMIN_ALLOWED_HOSTS.size === 0) {
    console.warn('[WARN] ADMIN_ALLOWED_HOSTS is empty. Admin routes are blocked in production.');
  }
}

validateRuntimeConfig();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const USER_STATE_KEYS = [
  'gp_epic_progress',
  'gp_amc_progress',
  'gp_ahpra_progress',
  'gp_documents_prep',
  'gp_prepared_docs',
  'gp_selected_country',
  'gp_link_updates',
  'gp_link_updates_read',
  'gpLinkSupportCases',
  'gpLinkMessageDB',
  'gp_account_profile'
];

const EPIC_STAGE_META = [
  { key: 'create_account', label: 'Create account' },
  { key: 'account_establishment', label: 'Account establishment' },
  { key: 'upload_qualifications', label: 'Upload qualifications' },
  { key: 'waiting_verification', label: 'Waiting verification' },
  { key: 'verification_issued', label: 'Verification issued' }
];

const AMC_STAGE_META = [
  { key: 'create_portfolio', label: 'Create AMC account' },
  { key: 'upload_credentials', label: 'Upload credentials' },
  { key: 'qualifications_verified', label: 'Qualifications verified' }
];

const GP_DOCUMENT_META = [
  { key: 'primary_medical_degree', label: 'Primary medical degree', source: 'prepared_by_you' },
  { key: 'mrcgp_certified', label: 'MRCGP certificate', source: 'prepared_by_you' },
  { key: 'cct_certified', label: 'CCT certificate', source: 'prepared_by_you' },
  { key: 'cv_signed_dated', label: 'Signed CV', source: 'prepared_by_you' },
  { key: 'certificate_good_standing', label: 'Certificate of good standing', source: 'institution_docs' },
  { key: 'confirmation_training', label: 'Confirmation of training', source: 'institution_docs' },
  { key: 'criminal_history', label: 'Criminal history check', source: 'institution_docs' }
];

const GP_LINK_DOCUMENT_META = [
  { key: 'sppa_00', label: 'SPPA-00', source: 'gplink_pack' },
  { key: 'section_g', label: 'Section G', source: 'gplink_pack' },
  { key: 'position_description', label: 'Position description', source: 'gplink_pack' },
  { key: 'offer_contract', label: 'Offer/contract', source: 'gplink_pack' },
  { key: 'supervisor_cv', label: 'Supervisor CV', source: 'gplink_pack' }
];

function now() {
  return Date.now();
}

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function createEmptyState() {
  return {
    version: 1,
    otpChallenges: {},
    rateLimits: {},
    sessions: {},
    passwordResetTokens: {},
    users: {},
    userProfiles: {},
    userState: {}
  };
}

function loadDbState() {
  ensureDirSync(path.dirname(DB_FILE_PATH));
  if (!fs.existsSync(DB_FILE_PATH)) {
    const initial = createEmptyState();
    fs.writeFileSync(DB_FILE_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }

  try {
    const raw = fs.readFileSync(DB_FILE_PATH, 'utf8');
    const parsed = raw ? JSON.parse(raw) : createEmptyState();
    return {
      ...createEmptyState(),
      ...parsed,
      otpChallenges: parsed && parsed.otpChallenges && typeof parsed.otpChallenges === 'object' ? parsed.otpChallenges : {},
      rateLimits: parsed && parsed.rateLimits && typeof parsed.rateLimits === 'object' ? parsed.rateLimits : {},
      sessions: parsed && parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      passwordResetTokens: parsed && parsed.passwordResetTokens && typeof parsed.passwordResetTokens === 'object' ? parsed.passwordResetTokens : {},
      users: parsed && parsed.users && typeof parsed.users === 'object' ? parsed.users : {},
      userProfiles: parsed && parsed.userProfiles && typeof parsed.userProfiles === 'object' ? parsed.userProfiles : {},
      userState: parsed && parsed.userState && typeof parsed.userState === 'object' ? parsed.userState : {}
    };
  } catch (err) {
    console.error('[DB] Failed to parse DB file. Starting with empty state.', err);
    return createEmptyState();
  }
}

let dbState = loadDbState();

function saveDbState() {
  const tmpPath = `${DB_FILE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(dbState, null, 2));
  fs.renameSync(tmpPath, DB_FILE_PATH);
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function getCookies(req) {
  const raw = req.headers.cookie || '';
  return raw.split(';').reduce((acc, pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return acc;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) acc[key] = decodeURIComponent(val);
    return acc;
  }, {});
}

function getRequestHostname(req) {
  const host = String(req.headers.host || '').trim().toLowerCase();
  if (!host) return '';
  return host.split(':')[0];
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isAllowedAdminHost(req) {
  const hostname = getRequestHostname(req);
  if (!hostname) return false;
  if (ADMIN_ALLOWED_HOSTS.size > 0) return ADMIN_ALLOWED_HOSTS.has(hostname);
  return NODE_ENV !== 'production' && isLoopbackHostname(hostname);
}

function randomToken(size = 32) {
  return crypto.randomBytes(size).toString('hex');
}

function hashOtp(key, code) {
  return crypto.createHmac('sha256', SECRET).update(`${key}|${code}`).digest('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function base64UrlEncode(input) {
  return Buffer.from(String(input), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '==='.slice((normalized.length + 3) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function createSignedSessionToken(userProfile, expiresAt) {
  const payload = base64UrlEncode(JSON.stringify({ userProfile, expiresAt }));
  const signature = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function parseSignedSessionToken(token) {
  const raw = String(token || '');
  const dotIdx = raw.lastIndexOf('.');
  if (dotIdx <= 0) return null;
  const payload = raw.slice(0, dotIdx);
  const signature = raw.slice(dotIdx + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'))) return null;

  try {
    const parsed = JSON.parse(base64UrlDecode(payload));
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.userProfile || typeof parsed.userProfile !== 'object') return null;
    if (typeof parsed.expiresAt !== 'number') return null;
    if (parsed.expiresAt <= now()) return null;
    return { userProfile: parsed.userProfile, expiresAt: parsed.expiresAt };
  } catch (err) {
    return null;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, storedHash) {
  if (typeof storedHash !== 'string' || !storedHash.startsWith('scrypt$')) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3) return false;
  const salt = parts[1];
  const expectedHex = parts[2];
  const derivedHex = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const derivedBuf = Buffer.from(derivedHex, 'hex');
  if (expectedBuf.length !== derivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, derivedBuf);
}

function isStrongPassword(password) {
  const value = String(password || '');
  if (value.length < 12 || value.length > 128) return false;
  if (!/[a-z]/.test(value)) return false;
  if (!/[A-Z]/.test(value)) return false;
  if (!/[0-9]/.test(value)) return false;
  if (!/[^A-Za-z0-9]/.test(value)) return false;
  return true;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_JSON_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function normalizePhone(countryDial, phoneNumber) {
  const digits = String(phoneNumber || '').replace(/\D/g, '');
  return `${String(countryDial || '').trim()}${digits}`;
}

function maskEmail(email) {
  const [name = '', domain = ''] = String(email || '').split('@');
  if (!name || !domain) return 'your email';
  const prefix = name.slice(0, 2);
  return `${prefix}${'*'.repeat(Math.max(name.length - 2, 1))}@${domain}`;
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return 'your phone';
  const tail = digits.slice(-2);
  return `••••••${tail}`;
}

function keyForOtp(method, email, countryDial, phoneNumber) {
  if (method === 'sms') return `sms:${normalizePhone(countryDial, phoneNumber)}`;
  return `email:${String(email || '').trim().toLowerCase()}`;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function isValidPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 6 && digits.length <= 20;
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(rateKey) {
  const ts = now();
  const current = dbState.rateLimits[rateKey];
  if (!current || ts - current.windowStart > RATE_WINDOW_MS) {
    dbState.rateLimits[rateKey] = { windowStart: ts, count: 1 };
    saveDbState();
    return true;
  }
  if (current.count >= RATE_MAX_SEND) {
    return false;
  }
  current.count += 1;
  dbState.rateLimits[rateKey] = current;
  saveDbState();
  return true;
}

function setSession(res, userProfile) {
  const expiresAt = now() + SESSION_TTL_MS;
  const token = createSignedSessionToken(userProfile, expiresAt);

  const secureCookie = process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === 'true'
    : NODE_ENV === 'production';

  const cookie = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (secureCookie) cookie.push('Secure');

  res.setHeader('Set-Cookie', cookie.join('; '));
}

function setAdminSession(res, userProfile) {
  const expiresAt = now() + ADMIN_SESSION_TTL_MS;
  const token = createSignedSessionToken(userProfile, expiresAt);

  const secureCookie = process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === 'true'
    : NODE_ENV === 'production';

  const cookie = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`
  ];
  if (secureCookie) cookie.push('Secure');

  res.setHeader('Set-Cookie', cookie.join('; '));
}

function clearSession(res, req) {
  const cookies = getCookies(req);
  const token = cookies[COOKIE_NAME];
  if (token) {
    // Legacy local-session cleanup for pre-stateless cookie tokens.
    const tokenHash = hashToken(token);
    if (dbState.sessions[tokenHash]) {
      delete dbState.sessions[tokenHash];
      saveDbState();
    }
  }
  const secureCookie = process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === 'true'
    : NODE_ENV === 'production';
  const cookie = [`${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`];
  if (secureCookie) cookie.push('Secure');
  res.setHeader('Set-Cookie', cookie.join('; '));
}

function clearAdminSession(res) {
  const secureCookie = process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === 'true'
    : NODE_ENV === 'production';
  const cookie = [`${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`];
  if (secureCookie) cookie.push('Secure');
  res.setHeader('Set-Cookie', cookie.join('; '));
}

function getSession(req) {
  const cookies = getCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;

  const signedSession = parseSignedSessionToken(token);
  if (signedSession) return signedSession;

  // Backward compatibility: previously-issued server-side session tokens.
  const tokenHash = hashToken(token);
  const session = dbState.sessions[tokenHash];
  if (!session) return null;
  if (session.expiresAt <= now()) {
    delete dbState.sessions[tokenHash];
    saveDbState();
    return null;
  }
  return session;
}

function getAdminSession(req) {
  const cookies = getCookies(req);
  const token = cookies[ADMIN_COOKIE_NAME];
  if (!token) return null;
  const signedSession = parseSignedSessionToken(token);
  return signedSession || null;
}

function requireSession(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { ok: false, authenticated: false });
    return null;
  }
  return session;
}

function getSessionEmail(session) {
  const email = session && session.userProfile && typeof session.userProfile.email === 'string'
    ? session.userProfile.email.trim().toLowerCase()
    : '';
  return email || null;
}

function shouldProtectPath(pathname) {
  if (AUTH_DISABLED) return false;
  return (
    pathname === '/' ||
    pathname === '/pages/index.html' ||
    pathname === '/pages/myinthealth.html' ||
    pathname === '/pages/amc.html' ||
    pathname === '/pages/my-documents.html' ||
    pathname === '/pages/account.html' ||
    pathname === '/pages/support-cases.html'
  );
}

function sanitizeFilePath(pathname) {
  const decoded = decodeURIComponent(pathname.split('?')[0]);
  const target = decoded === '/' ? '/pages/index.html' : decoded;
  const normalized = path.posix.normalize(String(target).replace(/\\/g, '/'));
  const relative = normalized.replace(/^\/+/, '');
  if (!relative || relative.startsWith('..')) return null;
  return path.resolve(process.cwd(), relative);
}

function serveStatic(req, res, pathname) {
  const filePath = sanitizeFilePath(pathname);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!filePath.startsWith(process.cwd())) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const isMedia = pathname.startsWith('/media/');
    const isVideo = ext === '.mp4';
    const cacheControl = ext === '.html'
      ? 'no-cache'
      : (isMedia ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
    const range = req.headers.range;

    if (isVideo && typeof range === 'string') {
      const match = range.match(/bytes=(\d*)-(\d*)/);
      if (match) {
        const start = match[1] === '' ? 0 : Number(match[1]);
        const end = match[2] === '' ? stat.size - 1 : Number(match[2]);

        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end >= stat.size) {
          res.writeHead(416, {
            'Content-Range': `bytes */${stat.size}`
          });
          res.end();
          return;
        }

        res.writeHead(206, {
          'Content-Type': mime,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': cacheControl
        });
        const rangedStream = fs.createReadStream(filePath, { start, end });
        rangedStream.pipe(res);
        rangedStream.on('error', () => {
          res.writeHead(500);
          res.end('Server error');
        });
        return;
      }
    }

    const headers = {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': cacheControl
    };
    if (isVideo) headers['Accept-Ranges'] = 'bytes';
    res.writeHead(200, headers);

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', () => {
      res.writeHead(500);
      res.end('Server error');
    });
  });
}

function sanitizeProfileInput(body) {
  const profile = body && typeof body === 'object' ? body : {};
  const clean = {
    firstName: typeof profile.firstName === 'string' ? profile.firstName.trim().slice(0, 80) : '',
    lastName: typeof profile.lastName === 'string' ? profile.lastName.trim().slice(0, 80) : '',
    email: typeof profile.email === 'string' ? profile.email.trim().toLowerCase().slice(0, 120) : '',
    phone: typeof profile.phone === 'string' ? profile.phone.trim().slice(0, 40) : '',
    registrationNumber: typeof profile.registrationNumber === 'string' ? profile.registrationNumber.trim().slice(0, 40) : '',
    gmcNumber: typeof profile.gmcNumber === 'string' ? profile.gmcNumber.trim().slice(0, 30) : '',
    specialistCountry: typeof profile.specialistCountry === 'string' ? profile.specialistCountry.trim().slice(0, 30) : '',
    profilePhotoName: typeof profile.profilePhotoName === 'string' ? profile.profilePhotoName.trim().slice(0, 180) : '',
    profilePhotoDataUrl: typeof profile.profilePhotoDataUrl === 'string' ? profile.profilePhotoDataUrl.slice(0, 4 * 1024 * 1024) : '',
    idCopyName: typeof profile.idCopyName === 'string' ? profile.idCopyName.trim().slice(0, 180) : '',
    idCopyDataUrl: typeof profile.idCopyDataUrl === 'string' ? profile.idCopyDataUrl.slice(0, 4 * 1024 * 1024) : '',
    cvFileName: typeof profile.cvFileName === 'string' ? profile.cvFileName.trim().slice(0, 180) : '',
    updatedAt: new Date().toISOString()
  };

  if (clean.profilePhotoDataUrl && !clean.profilePhotoDataUrl.startsWith('data:image/')) {
    clean.profilePhotoDataUrl = '';
  }
  if (clean.idCopyDataUrl && !clean.idCopyDataUrl.startsWith('data:image/')) {
    clean.idCopyDataUrl = '';
  }

  return clean;
}

function sanitizeUserStateInput(body) {
  const incoming = body && typeof body === 'object' && body.state && typeof body.state === 'object'
    ? body.state
    : {};

  const out = {};
  for (const key of USER_STATE_KEYS) {
    if (!(key in incoming)) continue;
    const value = incoming[key];
    if (value === null || typeof value === 'undefined') {
      out[key] = null;
      continue;
    }

    if (typeof value === 'string') {
      out[key] = value.length > 4 * 1024 * 1024 ? value.slice(0, 4 * 1024 * 1024) : value;
      continue;
    }

    try {
      const serialized = JSON.stringify(value);
      out[key] = serialized.length > 4 * 1024 * 1024 ? serialized.slice(0, 4 * 1024 * 1024) : serialized;
    } catch (err) {
      continue;
    }
  }

  return out;
}

function parseJsonLike(value) {
  if (value === null || typeof value === 'undefined') return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

function isAdminEmail(email) {
  if (!email) return false;
  if (ADMIN_EMAILS.size === 0) return false;
  return ADMIN_EMAILS.has(String(email).trim().toLowerCase());
}

function requireAdminSession(req, res) {
  if (!isAllowedAdminHost(req)) {
    sendJson(res, 404, { ok: false, message: 'Not found' });
    return null;
  }
  const session = getAdminSession(req);
  if (!session) {
    sendJson(res, 401, { ok: false, authenticated: false });
    return null;
  }
  const email = getSessionEmail(session);
  if (!isAdminEmail(email)) {
    sendJson(res, 403, { ok: false, message: 'Admin access required.' });
    return null;
  }
  return { session, email };
}

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function getUserStateObject(email) {
  const source = dbState.userState[email];
  if (!source || typeof source !== 'object') return {};
  const out = {};
  for (const key of USER_STATE_KEYS) {
    if (hasOwn(source, key)) {
      out[key] = parseJsonLike(source[key]);
    }
  }
  out.updatedAt = source.updatedAt || null;
  return out;
}

function getProgressSummary(userStateObj) {
  const epic = userStateObj.gp_epic_progress && typeof userStateObj.gp_epic_progress === 'object'
    ? userStateObj.gp_epic_progress
    : {};
  const amc = userStateObj.gp_amc_progress && typeof userStateObj.gp_amc_progress === 'object'
    ? userStateObj.gp_amc_progress
    : {};
  const ahpra = userStateObj.gp_ahpra_progress && typeof userStateObj.gp_ahpra_progress === 'object'
    ? userStateObj.gp_ahpra_progress
    : {};
  const docs = userStateObj.gp_documents_prep && typeof userStateObj.gp_documents_prep === 'object'
    ? userStateObj.gp_documents_prep
    : {};

  const steps = [
    { id: 'profile_setup', label: 'Profile setup', done: false },
    { id: 'epic_verification', label: 'EPIC verification', done: false },
    { id: 'amc_portfolio', label: 'AMC portfolio', done: false },
    { id: 'documents', label: 'Documents prepared', done: false },
    { id: 'ahpra_setup', label: 'AHPRA account setup', done: false },
    { id: 'ahpra_submission', label: 'AHPRA submission', done: false },
    { id: 'ahpra_assessment', label: 'AHPRA assessment', done: false },
    { id: 'registration_outcome', label: 'Registration outcome', done: false }
  ];

  steps[0].done = !!(epic && epic.completed && epic.completed.create_account === true);
  steps[1].done = !!(epic && epic.completed && epic.completed.verification_issued === true);
  steps[2].done = !!(amc && amc.completed && amc.completed.qualifications_verified === true);

  const docEntries = docs && docs.docs && typeof docs.docs === 'object' ? Object.values(docs.docs) : [];
  const preparedByYou = docEntries.filter((item) => item && typeof item === 'object' && hasOwn(item, 'uploaded'));
  const uploadedPrepared = preparedByYou.filter((item) => item.uploaded === true);
  steps[3].done = preparedByYou.length > 0 && uploadedPrepared.length === preparedByYou.length;

  steps[4].done = !!(ahpra && ahpra.stage_1 && ahpra.stage_1.completedAt);
  steps[5].done = !!(ahpra && ahpra.stage_2 && ahpra.stage_2.completedAt);
  steps[6].done = !!(ahpra && ahpra.stage_3 && (ahpra.stage_3.completedAt || ahpra.stage_3.applicationOpenedAt));
  steps[7].done = !!(ahpra && ahpra.stage_4 && ahpra.stage_4.completedAt);

  const doneCount = steps.filter((step) => step.done).length;
  const currentIndex = steps.findIndex((step) => !step.done);
  const currentStepIndex = currentIndex === -1 ? steps.length : currentIndex + 1;
  const currentStepLabel = currentIndex === -1 ? 'Completed' : steps[currentIndex].label;
  const percent = Math.round((doneCount / steps.length) * 100);

  const assessmentStatus = ahpra && ahpra.stage_3 && typeof ahpra.stage_3.assessmentStatus === 'string'
    ? ahpra.stage_3.assessmentStatus
    : '';
  const pendingVerification = !steps[1].done || !steps[2].done || assessmentStatus === 'under_review' || assessmentStatus === 'further_info_requested';

  const actionRequired = !!(
    (ahpra && ahpra.adminFlags && ahpra.adminFlags.actionRequired === true) ||
    assessmentStatus === 'further_info_requested'
  );

  const documentsPending = docEntries.filter((item) => item && typeof item === 'object' && (item.status === 'under_review' || item.status === 'rejected')).length;

  return {
    steps,
    currentStepIndex,
    totalSteps: steps.length,
    currentStepLabel,
    percent,
    pendingVerification,
    actionRequired,
    documentsPending
  };
}

function toStatusLabel(value, uploaded) {
  const raw = typeof value === 'string' ? value : '';
  if (raw === 'accepted' || raw === 'approved') return 'accepted';
  if (raw === 'rejected') return 'rejected';
  if (raw === 'under_review') return 'under_review';
  if (raw === 'pending') return uploaded ? 'under_review' : 'pending';
  return uploaded ? 'under_review' : 'pending';
}

function getCandidateDocuments(userStateObj) {
  const docsState = userStateObj.gp_documents_prep && typeof userStateObj.gp_documents_prep === 'object'
    ? userStateObj.gp_documents_prep
    : {};
  const preparedDocsState = userStateObj.gp_prepared_docs && typeof userStateObj.gp_prepared_docs === 'object'
    ? userStateObj.gp_prepared_docs
    : {};
  const docs = docsState.docs && typeof docsState.docs === 'object' ? docsState.docs : {};
  const preparedDocs = preparedDocsState.docs && typeof preparedDocsState.docs === 'object' ? preparedDocsState.docs : {};

  const fromState = GP_DOCUMENT_META.map((meta) => {
    const source = docs[meta.key] && typeof docs[meta.key] === 'object' ? docs[meta.key] : {};
    const uploaded = source.uploaded === true;
    const status = toStatusLabel(source.status, uploaded);
    return {
      key: meta.key,
      label: meta.label,
      source: meta.source,
      uploaded,
      status,
      fileName: typeof source.fileName === 'string' ? source.fileName : ''
    };
  });

  const gpLinkPrepared = GP_LINK_DOCUMENT_META.map((meta) => {
    const source = preparedDocs[meta.key] && typeof preparedDocs[meta.key] === 'object' ? preparedDocs[meta.key] : {};
    const uploaded = source.ready === true || (typeof source.url === 'string' && source.url.trim().length > 0);
    const status = toStatusLabel(source.status, uploaded);
    return {
      key: meta.key,
      label: meta.label,
      source: meta.source,
      uploaded,
      status,
      fileName: typeof source.fileName === 'string' ? source.fileName : ''
    };
  });

  const items = [...fromState, ...gpLinkPrepared];
  const uploadedCount = items.filter((item) => item.uploaded).length;
  const pendingCount = items.filter((item) => !item.uploaded || item.status === 'under_review' || item.status === 'rejected' || item.status === 'pending').length;

  return {
    items,
    summary: {
      total: items.length,
      uploaded: uploadedCount,
      pending: pendingCount
    }
  };
}

function buildStepSubStatus(allKeys, completedMap, currentKey) {
  const doneSet = new Set(
    allKeys.filter((key) => completedMap && completedMap[key] === true)
  );
  return allKeys.map((key) => ({
    key,
    status: doneSet.has(key) ? 'done' : (key === currentKey ? 'current' : 'pending')
  }));
}

function buildCandidatePathway(userStateObj, documents) {
  const epic = userStateObj.gp_epic_progress && typeof userStateObj.gp_epic_progress === 'object'
    ? userStateObj.gp_epic_progress
    : {};
  const amc = userStateObj.gp_amc_progress && typeof userStateObj.gp_amc_progress === 'object'
    ? userStateObj.gp_amc_progress
    : {};
  const ahpra = userStateObj.gp_ahpra_progress && typeof userStateObj.gp_ahpra_progress === 'object'
    ? userStateObj.gp_ahpra_progress
    : {};

  const epicKeys = EPIC_STAGE_META.map((item) => item.key);
  const epicCurrent = epicKeys.includes(epic.stage)
    ? epic.stage
    : epicKeys.find((key) => !(epic.completed && epic.completed[key] === true)) || epicKeys[epicKeys.length - 1];
  const epicSubRaw = buildStepSubStatus(epicKeys, epic.completed || {}, epicCurrent);
  const epicDone = epicSubRaw.every((item) => item.status === 'done');

  const amcKeys = AMC_STAGE_META.map((item) => item.key);
  const amcCurrent = amcKeys.includes(amc.stage)
    ? amc.stage
    : amcKeys.find((key) => !(amc.completed && amc.completed[key] === true)) || amcKeys[amcKeys.length - 1];
  const amcSubRaw = buildStepSubStatus(amcKeys, amc.completed || {}, amcCurrent);
  const amcDone = amcSubRaw.every((item) => item.status === 'done');

  const ahpraSubRaw = [
    { key: 'stage_1', label: 'Stage 1: Account setup', done: !!(ahpra.stage_1 && ahpra.stage_1.completedAt) },
    { key: 'stage_2', label: 'Stage 2: Submission', done: !!(ahpra.stage_2 && ahpra.stage_2.completedAt) },
    { key: 'stage_3', label: 'Stage 3: Assessment', done: !!(ahpra.stage_3 && (ahpra.stage_3.completedAt || ahpra.stage_3.applicationOpenedAt)) },
    { key: 'stage_4', label: 'Stage 4: Outcome', done: !!(ahpra.stage_4 && ahpra.stage_4.completedAt) }
  ];
  const ahpraCurrentIdx = ahpraSubRaw.findIndex((item) => !item.done);
  const ahpraDone = ahpraCurrentIdx === -1;

  const preparedByYou = documents.items.filter((item) => item.source === 'prepared_by_you');
  const institutionDocs = documents.items.filter((item) => item.source === 'institution_docs');
  const gpLinkPack = documents.items.filter((item) => item.source === 'gplink_pack');
  const preparedDone = preparedByYou.length > 0 && preparedByYou.every((item) => item.uploaded);
  const institutionDone = institutionDocs.length > 0 && institutionDocs.every((item) => item.uploaded);
  const gpLinkDone = gpLinkPack.length > 0 && gpLinkPack.every((item) => item.uploaded);
  const docsDone = preparedDone && institutionDone && gpLinkDone;
  const docsCurrent = !preparedDone ? 'prepared_by_you' : (!institutionDone ? 'institution_docs' : (!gpLinkDone ? 'gplink_pack' : ''));

  return [
    {
      id: 'myintealth',
      label: 'MyIntealth Account',
      status: epicDone ? 'done' : 'current',
      substeps: epicSubRaw.map((item) => {
        const meta = EPIC_STAGE_META.find((entry) => entry.key === item.key);
        return { key: item.key, label: meta ? meta.label : item.key, status: item.status };
      })
    },
    {
      id: 'amc',
      label: 'AMC Portfolio',
      status: amcDone ? 'done' : (epicDone ? 'current' : 'pending'),
      substeps: amcSubRaw.map((item) => {
        const meta = AMC_STAGE_META.find((entry) => entry.key === item.key);
        const status = epicDone ? item.status : 'pending';
        return { key: item.key, label: meta ? meta.label : item.key, status };
      })
    },
    {
      id: 'documents',
      label: 'Documents',
      status: docsDone ? 'done' : (amcDone ? 'current' : 'pending'),
      substeps: [
        { key: 'prepared_by_you', label: 'Prepared by you', status: amcDone ? (preparedDone ? 'done' : (docsCurrent === 'prepared_by_you' ? 'current' : 'pending')) : 'pending' },
        { key: 'institution_docs', label: 'Institution documents', status: amcDone ? (institutionDone ? 'done' : (docsCurrent === 'institution_docs' ? 'current' : 'pending')) : 'pending' },
        { key: 'gplink_pack', label: 'GP Link prepared pack', status: amcDone ? (gpLinkDone ? 'done' : (docsCurrent === 'gplink_pack' ? 'current' : 'pending')) : 'pending' }
      ]
    },
    {
      id: 'ahpra',
      label: 'AHPRA Registration',
      status: ahpraDone ? 'done' : ((epicDone && amcDone) ? 'current' : 'pending'),
      substeps: ahpraSubRaw.map((item, idx) => ({
        key: item.key,
        label: item.label,
        status: (epicDone && amcDone)
          ? (item.done ? 'done' : (idx === ahpraCurrentIdx ? 'current' : 'pending'))
          : 'pending'
      }))
    }
  ];
}

function normalizeSupportCase(rawCase) {
  if (!rawCase || typeof rawCase !== 'object') return null;
  const createdAt = typeof rawCase.createdAt === 'string' ? rawCase.createdAt : new Date().toISOString();
  const updatedAt = typeof rawCase.updatedAt === 'string' ? rawCase.updatedAt : createdAt;
  const thread = Array.isArray(rawCase.thread) ? rawCase.thread : [];
  const latest = thread.length ? thread[thread.length - 1] : null;
  const lastMessage = latest && typeof latest.text === 'string' ? latest.text : '';
  const lastFrom = latest && (latest.from || latest.by) ? String(latest.from || latest.by) : '';
  const rawPriority = typeof rawCase.priority === 'string' ? rawCase.priority : 'normal';
  const priority = rawPriority === 'time_sensitive' ? 'urgent' : rawPriority === 'blocked' ? 'high' : 'normal';

  return {
    id: String(rawCase.id || `case_${Date.now()}`),
    title: typeof rawCase.title === 'string' && rawCase.title.trim() ? rawCase.title.trim() : 'Support request',
    category: typeof rawCase.category === 'string' ? rawCase.category : 'Other',
    status: rawCase.status === 'closed' ? 'closed' : 'open',
    priority,
    unread: !!rawCase.unread,
    createdAt,
    updatedAt,
    messagesCount: thread.length,
    lastMessage,
    lastFrom,
    thread
  };
}

function getSupportCasesFromState(userStateObj) {
  const directCases = Array.isArray(userStateObj.gpLinkSupportCases) ? userStateObj.gpLinkSupportCases : null;
  if (directCases && directCases.length) return directCases.map(normalizeSupportCase).filter(Boolean);

  const messageDb = userStateObj.gpLinkMessageDB && typeof userStateObj.gpLinkMessageDB === 'object'
    ? userStateObj.gpLinkMessageDB
    : null;
  const dbCases = messageDb && Array.isArray(messageDb.supportCases) ? messageDb.supportCases : [];
  return dbCases.map(normalizeSupportCase).filter(Boolean);
}

function getParsedUserState(rawState, updatedAt = null) {
  const source = rawState && typeof rawState === 'object' ? rawState : {};
  const out = {};
  for (const key of USER_STATE_KEYS) {
    if (hasOwn(source, key)) {
      out[key] = parseJsonLike(source[key]);
    }
  }
  out.updatedAt = updatedAt || source.updatedAt || null;
  return out;
}

async function collectAdminDashboardData() {
  if (isSupabaseDbConfigured()) {
    const [profilesResult, statesResult] = await Promise.all([
      supabaseDbRequest(
        'user_profiles',
        'select=user_id,email,first_name,last_name,phone,registration_country,created_at,updated_at'
      ),
      supabaseDbRequest(
        'user_state',
        'select=user_id,state,updated_at'
      )
    ]);

    if (profilesResult.ok && statesResult.ok && Array.isArray(profilesResult.data) && Array.isArray(statesResult.data)) {
      const profileByUserId = new Map();
      for (const row of profilesResult.data) {
        if (row && typeof row.user_id === 'string') {
          profileByUserId.set(row.user_id, row);
        }
      }

      const stateByUserId = new Map();
      for (const row of statesResult.data) {
        if (row && typeof row.user_id === 'string') {
          stateByUserId.set(row.user_id, row);
        }
      }

      const userIds = new Set([
        ...profileByUserId.keys(),
        ...stateByUserId.keys()
      ]);

      if (userIds.size > 0) {
        const candidates = [];
        const tickets = [];
        const staleThresholdMs = 5 * 24 * 60 * 60 * 1000;

        for (const userId of userIds) {
          const profile = profileByUserId.get(userId) || {};
          const stateRow = stateByUserId.get(userId) || {};
          const email = typeof profile.email === 'string' ? profile.email : '';
          const userState = getParsedUserState(stateRow.state, stateRow.updated_at || null);
          const progress = getProgressSummary(userState);
          const supportCases = getSupportCasesFromState(userState);
          const documents = getCandidateDocuments(userState);
          const pathwaySteps = buildCandidatePathway(userState, documents);

          const fullName = `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || email || userId;
          const phone = profile.phone || '';
          const country = profile.registration_country || userState.gp_selected_country || '';
          const lastActiveAt = userState.updatedAt || profile.updated_at || null;
          const registeredAt = profile.created_at || profile.updated_at || lastActiveAt;
          const isStalled = lastActiveAt ? (Date.now() - new Date(lastActiveAt).getTime()) > staleThresholdMs : true;

          const openCount = supportCases.filter((item) => item.status !== 'closed').length;
          const status = progress.percent === 100
            ? 'complete'
            : progress.actionRequired
              ? 'action_required'
              : isStalled
                ? 'stalled'
                : 'active';

          const candidate = {
            id: email || userId,
            userId,
            email,
            name: fullName,
            phone,
            country,
            registeredAt,
            lastActiveAt,
            progressPercent: progress.percent,
            currentStepLabel: progress.currentStepLabel,
            currentStepIndex: progress.currentStepIndex,
            totalSteps: progress.totalSteps,
            pendingVerification: progress.pendingVerification,
            actionRequired: progress.actionRequired,
            stalled: isStalled,
            status,
            openTickets: openCount,
            documentsPending: progress.documentsPending,
            documents,
            pathwaySteps
          };
          candidates.push(candidate);

          supportCases.forEach((item) => {
            tickets.push({
              ...item,
              candidateId: email || userId,
              candidateUserId: userId,
              candidateName: fullName,
              candidateEmail: email
            });
          });
        }

        candidates.sort((a, b) => {
          const at = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
          const bt = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
          return bt - at;
        });
        tickets.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

        const totalGps = candidates.length;
        const activeGps = candidates.filter((item) => item.status !== 'complete').length;
        const pendingVerifications = candidates.filter((item) => item.pendingVerification).length;
        const openSupportTickets = tickets.filter((item) => item.status !== 'closed').length;
        const averageProgress = totalGps
          ? Math.round(candidates.reduce((sum, item) => sum + item.progressPercent, 0) / totalGps)
          : 0;

        return {
          summary: {
            totalGps,
            activeGps,
            pendingVerifications,
            openSupportTickets,
            averageProgress
          },
          candidates,
          verificationQueue: candidates.filter((item) => item.pendingVerification || item.documentsPending > 0),
          tickets
        };
      }
    }
  }

  const emails = new Set([
    ...Object.keys(dbState.users || {}),
    ...Object.keys(dbState.userProfiles || {}),
    ...Object.keys(dbState.userState || {})
  ]);

  const candidates = [];
  const tickets = [];
  const staleThresholdMs = 5 * 24 * 60 * 60 * 1000;

  for (const email of emails) {
    const user = dbState.users[email] || {};
    const profile = dbState.userProfiles[email] || {};
    const userState = getUserStateObject(email);
    const progress = getProgressSummary(userState);
    const supportCases = getSupportCasesFromState(userState);
    const documents = getCandidateDocuments(userState);
    const pathwaySteps = buildCandidatePathway(userState, documents);

    const fullName = `${profile.firstName || user.firstName || ''} ${profile.lastName || user.lastName || ''}`.trim() || email;
    const phone = profile.phone || [user.countryDial || '', user.phoneNumber || ''].join(' ').trim();
    const country = user.registrationCountry || profile.specialistCountry || userState.gp_selected_country || '';
    const lastActiveAt = userState.updatedAt || profile.updatedAt || user.updatedAt || null;
    const registeredAt = user.createdAt || user.updatedAt || profile.updatedAt || lastActiveAt;
    const isStalled = lastActiveAt ? (Date.now() - new Date(lastActiveAt).getTime()) > staleThresholdMs : true;

    const openCount = supportCases.filter((item) => item.status !== 'closed').length;
    const status = progress.percent === 100
      ? 'complete'
      : progress.actionRequired
        ? 'action_required'
        : isStalled
          ? 'stalled'
          : 'active';

    const candidateId = email;
    const candidate = {
      id: candidateId,
      email,
      name: fullName,
      phone,
      country,
      registeredAt,
      lastActiveAt,
      progressPercent: progress.percent,
      currentStepLabel: progress.currentStepLabel,
      currentStepIndex: progress.currentStepIndex,
      totalSteps: progress.totalSteps,
      pendingVerification: progress.pendingVerification,
      actionRequired: progress.actionRequired,
      stalled: isStalled,
      status,
      openTickets: openCount,
      documentsPending: progress.documentsPending,
      documents,
      pathwaySteps
    };
    candidates.push(candidate);

    supportCases.forEach((item) => {
      tickets.push({
        ...item,
        candidateId,
        candidateName: fullName,
        candidateEmail: email
      });
    });
  }

  candidates.sort((a, b) => {
    const at = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
    const bt = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
    return bt - at;
  });
  tickets.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const totalGps = candidates.length;
  const activeGps = candidates.filter((item) => item.status !== 'complete').length;
  const pendingVerifications = candidates.filter((item) => item.pendingVerification).length;
  const openSupportTickets = tickets.filter((item) => item.status !== 'closed').length;
  const averageProgress = totalGps
    ? Math.round(candidates.reduce((sum, item) => sum + item.progressPercent, 0) / totalGps)
    : 0;

  return {
    summary: {
      totalGps,
      activeGps,
      pendingVerifications,
      openSupportTickets,
      averageProgress
    },
    candidates,
    verificationQueue: candidates.filter((item) => item.pendingVerification || item.documentsPending > 0),
    tickets
  };
}

async function ensureDashboardIncludesSessionUser(dashboard, session, email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return dashboard;

  const source = dashboard && typeof dashboard === 'object' ? dashboard : {};
  const candidates = Array.isArray(source.candidates) ? source.candidates.slice() : [];
  const tickets = Array.isArray(source.tickets) ? source.tickets.slice() : [];
  const sessionUserId = getSessionSupabaseUserId(session);

  const alreadyPresent = candidates.some((item) => {
    const itemEmail = item && typeof item.email === 'string' ? item.email.trim().toLowerCase() : '';
    const itemId = item && typeof item.id === 'string' ? item.id.trim().toLowerCase() : '';
    const itemUserId = item && typeof item.userId === 'string' ? item.userId : '';
    return itemEmail === normalizedEmail || itemId === normalizedEmail || (sessionUserId && itemUserId === sessionUserId);
  });
  if (alreadyPresent) return source;

  const user = dbState.users[normalizedEmail] || {};
  const profile = dbState.userProfiles[normalizedEmail] || {};

  let remoteProfile = null;
  let remoteState = null;
  if (isSupabaseDbConfigured()) {
    remoteProfile = await getSupabaseUserProfile(normalizedEmail, sessionUserId);
    remoteState = await getSupabaseUserStateByEmail(normalizedEmail);
  }

  const userState = remoteState && remoteState.state && typeof remoteState.state === 'object'
    ? getParsedUserState(remoteState.state, remoteState.updatedAt || null)
    : getUserStateObject(normalizedEmail);
  const progress = getProgressSummary(userState);
  const supportCases = getSupportCasesFromState(userState);
  const documents = getCandidateDocuments(userState);
  const pathwaySteps = buildCandidatePathway(userState, documents);

  const fullName = `${remoteProfile && remoteProfile.first_name ? remoteProfile.first_name : (profile.firstName || user.firstName || '')} ${remoteProfile && remoteProfile.last_name ? remoteProfile.last_name : (profile.lastName || user.lastName || '')}`
    .trim() || normalizedEmail;
  const phone = (remoteProfile && remoteProfile.phone)
    || profile.phone
    || [user.countryDial || '', user.phoneNumber || ''].join(' ').trim();
  const country = (remoteProfile && remoteProfile.registration_country)
    || user.registrationCountry
    || profile.specialistCountry
    || userState.gp_selected_country
    || '';
  const lastActiveAt = userState.updatedAt
    || (remoteProfile && remoteProfile.updated_at)
    || profile.updatedAt
    || user.updatedAt
    || null;
  const registeredAt = (remoteProfile && remoteProfile.created_at)
    || user.createdAt
    || (remoteProfile && remoteProfile.updated_at)
    || profile.updatedAt
    || user.updatedAt
    || lastActiveAt;
  const staleThresholdMs = 5 * 24 * 60 * 60 * 1000;
  const isStalled = lastActiveAt ? (Date.now() - new Date(lastActiveAt).getTime()) > staleThresholdMs : true;
  const openCount = supportCases.filter((item) => item.status !== 'closed').length;
  const status = progress.percent === 100
    ? 'complete'
    : progress.actionRequired
      ? 'action_required'
      : isStalled
        ? 'stalled'
        : 'active';

  const candidate = {
    id: normalizedEmail,
    userId: (remoteState && remoteState.userId) || sessionUserId || '',
    email: normalizedEmail,
    name: fullName,
    phone,
    country,
    registeredAt,
    lastActiveAt,
    progressPercent: progress.percent,
    currentStepLabel: progress.currentStepLabel,
    currentStepIndex: progress.currentStepIndex,
    totalSteps: progress.totalSteps,
    pendingVerification: progress.pendingVerification,
    actionRequired: progress.actionRequired,
    stalled: isStalled,
    status,
    openTickets: openCount,
    documentsPending: progress.documentsPending,
    documents,
    pathwaySteps
  };
  candidates.push(candidate);

  supportCases.forEach((item) => {
    tickets.push({
      ...item,
      candidateId: normalizedEmail,
      candidateUserId: candidate.userId || '',
      candidateName: fullName,
      candidateEmail: normalizedEmail
    });
  });

  candidates.sort((a, b) => {
    const at = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
    const bt = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
    return bt - at;
  });
  tickets.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const totalGps = candidates.length;
  const activeGps = candidates.filter((item) => item.status !== 'complete').length;
  const pendingVerifications = candidates.filter((item) => item.pendingVerification).length;
  const openSupportTickets = tickets.filter((item) => item.status !== 'closed').length;
  const averageProgress = totalGps
    ? Math.round(candidates.reduce((sum, item) => sum + item.progressPercent, 0) / totalGps)
    : 0;

  return {
    ...source,
    summary: {
      totalGps,
      activeGps,
      pendingVerifications,
      openSupportTickets,
      averageProgress
    },
    candidates,
    verificationQueue: candidates.filter((item) => item.pendingVerification || item.documentsPending > 0),
    tickets
  };
}

async function persistSupportCaseUpdate(ticketId, patch) {
  if (isSupabaseDbConfigured()) {
    const [profilesResult, statesResult] = await Promise.all([
      supabaseDbRequest('user_profiles', 'select=user_id,email'),
      supabaseDbRequest('user_state', 'select=user_id,state,updated_at')
    ]);

    if (profilesResult.ok && statesResult.ok && Array.isArray(profilesResult.data) && Array.isArray(statesResult.data)) {
      const emailByUserId = new Map();
      for (const row of profilesResult.data) {
        if (row && typeof row.user_id === 'string') {
          emailByUserId.set(row.user_id, typeof row.email === 'string' ? row.email : '');
        }
      }

      for (const row of statesResult.data) {
        if (!row || typeof row.user_id !== 'string') continue;
        const existingState = row.state && typeof row.state === 'object' ? row.state : {};
        const parsedDirectCases = parseJsonLike(existingState.gpLinkSupportCases);
        const directCases = Array.isArray(parsedDirectCases) ? parsedDirectCases : [];
        const messageDb = parseJsonLike(existingState.gpLinkMessageDB);
        const dbCases = messageDb && Array.isArray(messageDb.supportCases) ? messageDb.supportCases : [];

        let updated = false;
        const applyPatch = (list) => list.map((item) => {
          if (!item || String(item.id || '') !== ticketId) return item;
          updated = true;
          return patch(item);
        });

        const nextDirectCases = applyPatch(directCases);
        const nextDbCases = applyPatch(dbCases);
        if (!updated) continue;
        const syncedDirectCases = nextDirectCases.length ? nextDirectCases : nextDbCases;

        const nextState = {
          ...existingState,
          gpLinkSupportCases: JSON.stringify(syncedDirectCases),
          gpLinkMessageDB: JSON.stringify({
            ...(messageDb && typeof messageDb === 'object' ? messageDb : {}),
            supportCases: nextDbCases,
            updatedAt: new Date().toISOString()
          }),
          updatedAt: new Date().toISOString()
        };

        const saved = await upsertSupabaseUserState(row.user_id, nextState, nextState.updatedAt);
        if (!saved) return null;

        const finalCase = syncedDirectCases.find((item) => item && String(item.id || '') === ticketId) || nextDbCases.find((item) => item && String(item.id || '') === ticketId);
        const normalized = normalizeSupportCase(finalCase);
        return normalized ? { ...normalized, candidateEmail: emailByUserId.get(row.user_id) || '' } : null;
      }
    }

    return null;
  }

  const allEmails = Object.keys(dbState.userState || {});
  for (const candidateEmail of allEmails) {
    const stateRecord = dbState.userState[candidateEmail] && typeof dbState.userState[candidateEmail] === 'object'
      ? { ...dbState.userState[candidateEmail] }
      : {};

    const parsedDirectCases = parseJsonLike(stateRecord.gpLinkSupportCases);
    const directCases = Array.isArray(parsedDirectCases) ? parsedDirectCases : [];
    const messageDb = parseJsonLike(stateRecord.gpLinkMessageDB);
    const dbCases = messageDb && Array.isArray(messageDb.supportCases) ? messageDb.supportCases : [];

    let updated = false;
    const applyPatch = (list) => list.map((item) => {
      if (!item || String(item.id || '') !== ticketId) return item;
      updated = true;
      return patch(item);
    });

    const nextDirectCases = applyPatch(directCases);
    const nextDbCases = applyPatch(dbCases);
    if (!updated) continue;
    const syncedDirectCases = nextDirectCases.length ? nextDirectCases : nextDbCases;

    stateRecord.gpLinkSupportCases = JSON.stringify(syncedDirectCases);
    stateRecord.gpLinkMessageDB = JSON.stringify({
      ...(messageDb && typeof messageDb === 'object' ? messageDb : {}),
      supportCases: nextDbCases,
      updatedAt: new Date().toISOString()
    });
    stateRecord.updatedAt = new Date().toISOString();

    dbState.userState[candidateEmail] = stateRecord;
    saveDbState();

    const finalCase = syncedDirectCases.find((item) => item && String(item.id || '') === ticketId) || nextDbCases.find((item) => item && String(item.id || '') === ticketId);
    const normalized = normalizeSupportCase(finalCase);
    return normalized ? { ...normalized, candidateEmail } : null;
  }

  return null;
}

function isSupabaseConfigured() {
  return !!(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
}

function isSupabaseDbConfigured() {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

async function supabaseDbRequest(pathname, query = '', options = {}) {
  if (!isSupabaseDbConfigured()) {
    return { ok: false, status: 503, data: { message: 'Supabase database is not configured.' } };
  }

  const queryPart = query ? `?${query}` : '';
  const url = `${SUPABASE_URL}/rest/v1/${pathname}${queryPart}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...((options && options.headers) || {})
  };
  if (options && options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options && options.body !== undefined ? JSON.stringify(options.body) : undefined
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (err) {
        data = text;
      }
    }
    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    return { ok: false, status: 502, data: { message: 'Failed to reach Supabase database service.' } };
  }
}

async function getSupabaseUserIdByEmail(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;

  const result = await supabaseDbRequest(
    'user_profiles',
    `select=user_id&email=eq.${encodeURIComponent(normalizedEmail)}&limit=1`
  );
  if (!result.ok) return null;
  if (!Array.isArray(result.data) || result.data.length === 0) return null;
  const userId = result.data[0] && typeof result.data[0].user_id === 'string'
    ? result.data[0].user_id
    : null;
  return userId;
}

async function getSupabaseUserStateByEmail(email) {
  const userId = await getSupabaseUserIdByEmail(email);
  if (!userId) return null;

  const result = await supabaseDbRequest(
    'user_state',
    `select=state,updated_at&user_id=eq.${encodeURIComponent(userId)}&limit=1`
  );
  if (!result.ok) return null;

  const row = Array.isArray(result.data) && result.data.length > 0 ? result.data[0] : null;
  if (!row || typeof row !== 'object') {
    return { userId, state: {}, updatedAt: null };
  }

  return {
    userId,
    state: row.state && typeof row.state === 'object' ? row.state : {},
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null
  };
}

async function upsertSupabaseUserState(userId, state, updatedAt) {
  if (!userId) return false;

  const result = await supabaseDbRequest(
    'user_state',
    'on_conflict=user_id',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: [{
        user_id: userId,
        state: state && typeof state === 'object' ? state : {},
        updated_at: updatedAt || new Date().toISOString()
      }]
    }
  );
  return result.ok;
}

function mapSupabaseProfileRowToApiProfile(row, email) {
  const phone = row.phone || [row.country_dial || '', row.phone_number || ''].filter(Boolean).join(' ').trim();
  const localUser = dbState.users[email] || {};
  return {
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    email: row.email || email,
    phone,
    registrationNumber: row.registration_number || '',
    gmcNumber: row.gmc_number || '',
    specialistCountry: row.registration_country || '',
    hasPassword: !!localUser.passwordHash,
    profilePhotoName: row.profile_photo_name || '',
    profilePhotoDataUrl: row.profile_photo_data_url || '',
    idCopyName: row.id_copy_name || '',
    idCopyDataUrl: row.id_copy_data_url || '',
    cvFileName: row.cv_file_name || '',
    updatedAt: row.updated_at || null
  };
}

function splitPhoneForProfile(phoneValue) {
  const value = String(phoneValue || '').trim();
  if (!value) return { countryDial: '', phoneNumber: '' };
  const match = value.match(/^(\+\d{1,4})\s*(.*)$/);
  if (!match) return { countryDial: '', phoneNumber: value };
  return {
    countryDial: match[1] || '',
    phoneNumber: String(match[2] || '').trim()
  };
}

async function getSupabaseUserProfile(email, sessionUserId = null) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;

  const byEmail = await supabaseDbRequest(
    'user_profiles',
    `select=*&email=eq.${encodeURIComponent(normalizedEmail)}&limit=1`
  );
  if (byEmail.ok && Array.isArray(byEmail.data) && byEmail.data.length > 0) {
    return byEmail.data[0];
  }

  if (!sessionUserId) return null;
  const byId = await supabaseDbRequest(
    'user_profiles',
    `select=*&user_id=eq.${encodeURIComponent(sessionUserId)}&limit=1`
  );
  if (!byId.ok || !Array.isArray(byId.data) || byId.data.length === 0) return null;
  return byId.data[0];
}

async function upsertSupabaseUserProfile(userId, email, clean, existingRow = null) {
  if (!userId) return null;
  const current = existingRow && typeof existingRow === 'object' ? existingRow : {};
  const split = splitPhoneForProfile(clean.phone);
  const countryDial = split.countryDial || current.country_dial || '';
  const phoneNumber = split.phoneNumber || current.phone_number || '';
  const phone = clean.phone || [countryDial, phoneNumber].filter(Boolean).join(' ').trim();

  const payload = {
    user_id: userId,
    email,
    first_name: clean.firstName || current.first_name || '',
    last_name: clean.lastName || current.last_name || '',
    country_dial: countryDial,
    phone_number: phoneNumber,
    registration_country: clean.specialistCountry || current.registration_country || '',
    phone,
    registration_number: clean.registrationNumber || current.registration_number || '',
    gmc_number: clean.gmcNumber || current.gmc_number || '',
    profile_photo_name: clean.profilePhotoName || current.profile_photo_name || '',
    profile_photo_data_url: clean.profilePhotoDataUrl || current.profile_photo_data_url || '',
    id_copy_name: clean.idCopyName || current.id_copy_name || '',
    id_copy_data_url: clean.idCopyDataUrl || current.id_copy_data_url || '',
    cv_file_name: clean.cvFileName || current.cv_file_name || '',
    updated_at: new Date().toISOString()
  };

  const write = await supabaseDbRequest(
    'user_profiles',
    'on_conflict=user_id',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: [payload]
    }
  );
  if (!write.ok || !Array.isArray(write.data) || write.data.length === 0) return null;
  return write.data[0];
}

async function supabaseAuthRequest(endpoint, payload) {
  if (!isSupabaseConfigured()) {
    return { ok: false, status: 503, data: { message: 'Supabase is not configured.' } };
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/${endpoint}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload || {})
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    return { ok: false, status: 502, data: { message: 'Failed to reach Supabase auth service.' } };
  }
}

async function supabaseAuthAdminRequest(pathname, options = {}) {
  if (!isSupabaseDbConfigured()) {
    return { ok: false, status: 503, data: { message: 'Supabase admin auth is not configured.' } };
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/${pathname}`, {
      method: options.method || 'GET',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...((options && options.headers) || {})
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    return { ok: false, status: 502, data: { message: 'Failed to reach Supabase admin auth service.' } };
  }
}

function getSessionProfileFromUser(email) {
  const key = String(email || '').trim().toLowerCase();
  const user = dbState.users[key] || {};
  const profile = dbState.userProfiles[key] || {};

  return {
    firstName: user.firstName || profile.firstName || '',
    lastName: user.lastName || profile.lastName || '',
    email: key,
    supabaseUserId: user.supabaseUserId || '',
    countryDial: user.countryDial || '',
    phoneNumber: user.phoneNumber || '',
    registrationCountry: user.registrationCountry || profile.specialistCountry || ''
  };
}

function upsertLocalUserFromSupabaseUser(supaUser) {
  const email = String(supaUser && supaUser.email ? supaUser.email : '').trim().toLowerCase();
  if (!email) return null;
  const supabaseUserId = String(supaUser && supaUser.id ? supaUser.id : '').trim();

  const meta = supaUser && typeof supaUser.user_metadata === 'object' && supaUser.user_metadata
    ? supaUser.user_metadata
    : {};
  const firstName = String(meta.firstName || meta.given_name || '').trim();
  const lastName = String(meta.lastName || meta.family_name || '').trim();
  const countryDial = String(meta.countryDial || '').trim();
  const phoneNumber = String(meta.phoneNumber || '').trim();
  const registrationCountry = String(meta.registrationCountry || '').trim();
  const updatedAt = new Date().toISOString();

  dbState.users[email] = {
    ...(dbState.users[email] || {}),
    email,
    supabaseUserId: supabaseUserId || (dbState.users[email] && dbState.users[email].supabaseUserId) || '',
    firstName: firstName || (dbState.users[email] && dbState.users[email].firstName) || '',
    lastName: lastName || (dbState.users[email] && dbState.users[email].lastName) || '',
    countryDial: countryDial || (dbState.users[email] && dbState.users[email].countryDial) || '',
    phoneNumber: phoneNumber || (dbState.users[email] && dbState.users[email].phoneNumber) || '',
    registrationCountry: registrationCountry || (dbState.users[email] && dbState.users[email].registrationCountry) || '',
    updatedAt
  };

  if (!dbState.userProfiles[email]) {
    dbState.userProfiles[email] = {
      firstName: dbState.users[email].firstName || '',
      lastName: dbState.users[email].lastName || '',
      email,
      phone: `${dbState.users[email].countryDial || ''} ${dbState.users[email].phoneNumber || ''}`.trim(),
      specialistCountry: dbState.users[email].registrationCountry || '',
      registrationNumber: '',
      gmcNumber: '',
      profilePhotoName: '',
      profilePhotoDataUrl: '',
      idCopyName: '',
      idCopyDataUrl: '',
      cvFileName: '',
      updatedAt
    };
  }

  saveDbState();
  return email;
}

function getSessionSupabaseUserId(session) {
  const value = session && session.userProfile && typeof session.userProfile.supabaseUserId === 'string'
    ? session.userProfile.supabaseUserId.trim()
    : '';
  return value || null;
}

function cleanup() {
  const ts = now();
  let dirty = false;

  for (const [k, v] of Object.entries(dbState.otpChallenges)) {
    if (!v || v.expiresAt <= ts) {
      delete dbState.otpChallenges[k];
      dirty = true;
    }
  }

  for (const [k, v] of Object.entries(dbState.rateLimits)) {
    if (!v || v.windowStart + RATE_WINDOW_MS <= ts) {
      delete dbState.rateLimits[k];
      dirty = true;
    }
  }

  for (const [k, v] of Object.entries(dbState.sessions)) {
    if (!v || v.expiresAt <= ts) {
      delete dbState.sessions[k];
      dirty = true;
    }
  }

  const resetRetentionMs = 24 * 60 * 60 * 1000;
  for (const [k, v] of Object.entries(dbState.passwordResetTokens)) {
    if (!v || v.expiresAt <= ts || (v.used && (ts - (v.usedAt || ts)) > resetRetentionMs)) {
      delete dbState.passwordResetTokens[k];
      dirty = true;
    }
  }

  if (dirty) saveDbState();
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      status: 'healthy',
      environment: NODE_ENV,
      authDisabled: AUTH_DISABLED,
      serverTime: new Date().toISOString()
    });
    return;
  }

  if (pathname === '/api/auth/config' && req.method === 'GET') {
    const configured = isSupabaseConfigured();
    sendJson(res, 200, {
      ok: true,
      supabaseUrl: configured ? SUPABASE_URL : '',
      supabasePublishableKey: configured ? SUPABASE_PUBLISHABLE_KEY : '',
      supabaseConfigured: configured,
      supabaseDbConfigured: isSupabaseDbConfigured()
    });
    return;
  }

  if (pathname.startsWith('/api/admin/') && !isAllowedAdminHost(req)) {
    sendJson(res, 404, { ok: false, message: 'Not found' });
    return;
  }

  if (pathname === '/api/auth/send-code' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const firstName = String(body.firstName || '').trim();
    const lastName = String(body.lastName || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const countryDial = String(body.countryDial || '').trim();
    const phoneNumber = String(body.phoneNumber || '').trim();
    const registrationCountry = String(body.registrationCountry || '').trim();
    const method = body.codeMethod === 'sms' ? 'sms' : 'email';

    if (!firstName || !lastName || !isValidEmail(email) || !isValidPhone(phoneNumber)) {
      sendJson(res, 400, { ok: false, message: 'Please provide valid identity and contact details.' });
      return;
    }

    if (!['UK', 'NZ', 'Ireland'].includes(registrationCountry)) {
      sendJson(res, 400, { ok: false, message: 'Invalid registration country.' });
      return;
    }

    const otpKey = keyForOtp(method, email, countryDial, phoneNumber);
    const rateKey = `${getClientIp(req)}|${otpKey}`;
    if (!checkRateLimit(rateKey)) {
      sendJson(res, 429, { ok: false, message: 'Too many requests. Please wait and try again.' });
      return;
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    dbState.otpChallenges[otpKey] = {
      codeHash: hashOtp(otpKey, code),
      expiresAt: now() + OTP_TTL_MS,
      attempts: 0,
      profile: { firstName, lastName, email, countryDial, phoneNumber, registrationCountry }
    };
    saveDbState();

    const destination = method === 'sms' ? `${countryDial} ${maskPhone(phoneNumber)}` : maskEmail(email);
    if (NODE_ENV !== 'production') {
      console.log(`[AUTH] OTP (${method}) for ${otpKey}: ${code}`);
    }

    sendJson(res, 200, {
      ok: true,
      message: `If the details are valid, a code has been sent to ${destination}.`,
      expiresInSeconds: Math.floor(OTP_TTL_MS / 1000)
    });
    return;
  }

  if (pathname === '/api/auth/signup' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!isValidEmail(email)) {
      sendJson(res, 400, { ok: false, message: 'Please provide a valid email address.' });
      return;
    }
    if (!isStrongPassword(password)) {
      sendJson(res, 400, { ok: false, message: 'Password must be at least 12 characters and include upper, lower, number, and symbol.' });
      return;
    }

    const signupResult = await supabaseAuthRequest('signup', {
      email,
      password
    });
    if (!signupResult.ok) {
      const msg = signupResult.data && signupResult.data.msg
        ? signupResult.data.msg
        : signupResult.data && signupResult.data.message
          ? signupResult.data.message
          : 'Unable to create account right now.';
      sendJson(res, signupResult.status || 400, { ok: false, message: msg });
      return;
    }

    upsertLocalUserFromSupabaseUser(signupResult.data && signupResult.data.user ? signupResult.data.user : { email });

    const loginResult = await supabaseAuthRequest('token?grant_type=password', { email, password });
    if (!loginResult.ok) {
      sendJson(res, 200, {
        ok: true,
        requiresConfirmation: true,
        message: 'Account created. If email confirmation is enabled, verify your inbox before signing in.'
      });
      return;
    }

    setSession(res, getSessionProfileFromUser(email));
    sendJson(res, 200, { ok: true, message: 'Account created.', redirectTo: '/pages/index.html' });
    return;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!isValidEmail(email) || !password) {
      sendJson(res, 400, { ok: false, message: 'Please provide a valid email and password.' });
      return;
    }

    const loginResult = await supabaseAuthRequest('token?grant_type=password', { email, password });
    if (!loginResult.ok) {
      const msg = loginResult.data && loginResult.data.msg
        ? loginResult.data.msg
        : loginResult.data && loginResult.data.message
          ? loginResult.data.message
          : 'Invalid email or password.';
      sendJson(res, loginResult.status === 400 || loginResult.status === 401 ? 401 : loginResult.status, { ok: false, message: msg });
      return;
    }

    upsertLocalUserFromSupabaseUser(loginResult.data && loginResult.data.user ? loginResult.data.user : { email });

    setSession(res, getSessionProfileFromUser(email));
    sendJson(res, 200, { ok: true, message: 'Authenticated', redirectTo: '/pages/index.html' });
    return;
  }

  if (pathname === '/api/auth/supabase-session-login' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const accessToken = String(body.accessToken || '').trim();
    if (!accessToken) {
      sendJson(res, 400, { ok: false, message: 'Missing access token.' });
      return;
    }
    if (!isSupabaseConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Supabase is not configured.' });
      return;
    }

    let userData = null;
    try {
      const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${accessToken}`
        }
      });
      userData = await response.json().catch(() => ({}));
      if (!response.ok) {
        const msg = userData && userData.msg
          ? userData.msg
          : userData && userData.message
            ? userData.message
            : 'Invalid Supabase session.';
        sendJson(res, response.status === 400 || response.status === 401 ? 401 : response.status, { ok: false, message: msg });
        return;
      }
    } catch (err) {
      sendJson(res, 502, { ok: false, message: 'Failed to reach Supabase auth service.' });
      return;
    }

    const email = upsertLocalUserFromSupabaseUser(userData);
    if (!email) {
      sendJson(res, 400, { ok: false, message: 'Supabase user has no email address.' });
      return;
    }

    setSession(res, getSessionProfileFromUser(email));
    sendJson(res, 200, { ok: true, message: 'Authenticated', redirectTo: '/pages/index.html' });
    return;
  }

  if (pathname === '/api/auth/verify-code' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const email = String(body.email || '').trim().toLowerCase();
    const countryDial = String(body.countryDial || '').trim();
    const phoneNumber = String(body.phoneNumber || '').trim();
    const method = body.codeMethod === 'sms' ? 'sms' : 'email';
    const code = String(body.code || '').trim();

    if (!/^\d{6}$/.test(code)) {
      sendJson(res, 400, { ok: false, message: 'Verification code must be 6 digits.' });
      return;
    }

    const otpKey = keyForOtp(method, email, countryDial, phoneNumber);
    const record = dbState.otpChallenges[otpKey];

    if (!record || record.expiresAt <= now()) {
      delete dbState.otpChallenges[otpKey];
      saveDbState();
      sendJson(res, 401, { ok: false, message: 'Code expired or invalid. Request a new code.' });
      return;
    }

    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      delete dbState.otpChallenges[otpKey];
      saveDbState();
      sendJson(res, 429, { ok: false, message: 'Too many failed attempts. Request a new code.' });
      return;
    }

    const incomingHash = hashOtp(otpKey, code);
    if (!crypto.timingSafeEqual(Buffer.from(record.codeHash), Buffer.from(incomingHash))) {
      record.attempts += 1;
      dbState.otpChallenges[otpKey] = record;
      saveDbState();
      sendJson(res, 401, { ok: false, message: 'Invalid code.' });
      return;
    }

    delete dbState.otpChallenges[otpKey];

    const userProfile = {
      firstName: record.profile.firstName,
      lastName: record.profile.lastName,
      email: record.profile.email,
      countryDial: record.profile.countryDial,
      phoneNumber: record.profile.phoneNumber,
      registrationCountry: record.profile.registrationCountry
    };

    dbState.users[userProfile.email] = {
      ...dbState.users[userProfile.email],
      ...userProfile,
      updatedAt: new Date().toISOString()
    };

    if (!dbState.userProfiles[userProfile.email]) {
      dbState.userProfiles[userProfile.email] = {
        firstName: userProfile.firstName,
        lastName: userProfile.lastName,
        email: userProfile.email,
        phone: `${userProfile.countryDial || ''} ${userProfile.phoneNumber || ''}`.trim(),
        specialistCountry: userProfile.registrationCountry,
        gmcNumber: '',
        profilePhotoName: '',
        profilePhotoDataUrl: '',
        idCopyName: '',
        idCopyDataUrl: '',
        cvFileName: '',
        updatedAt: new Date().toISOString()
      };
    }

    saveDbState();
    setSession(res, userProfile);

    sendJson(res, 200, { ok: true, message: 'Authenticated', redirectTo: '/pages/index.html' });
    return;
  }

  if (pathname === '/api/auth/session' && req.method === 'GET') {
    const session = getSession(req);
    if (!session) {
      sendJson(res, 401, { ok: false, authenticated: false });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      authenticated: true,
      profile: session.userProfile
    });
    return;
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    clearSession(res, req);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/auth/set-password' && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const email = getSessionEmail(session);
    if (!email) {
      sendJson(res, 400, { ok: false, message: 'Session missing email.' });
      return;
    }

    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    if (!isStrongPassword(newPassword)) {
      sendJson(res, 400, { ok: false, message: 'Password must be at least 12 characters and include upper, lower, number, and symbol.' });
      return;
    }

    if (isSupabaseDbConfigured()) {
      const sessionUserId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
      if (!sessionUserId) {
        sendJson(res, 409, { ok: false, message: 'Cannot resolve database user id for password update.' });
        return;
      }

      if (currentPassword) {
        const checkCurrent = await supabaseAuthRequest('token?grant_type=password', { email, password: currentPassword });
        if (!checkCurrent.ok) {
          sendJson(res, 401, { ok: false, message: 'Current password is incorrect.' });
          return;
        }
      }

      const updateResult = await supabaseAuthAdminRequest(`admin/users/${encodeURIComponent(sessionUserId)}`, {
        method: 'PUT',
        body: { password: newPassword }
      });
      if (!updateResult.ok) {
        const msg = updateResult.data && (updateResult.data.msg || updateResult.data.message)
          ? (updateResult.data.msg || updateResult.data.message)
          : 'Unable to update password right now.';
        sendJson(res, updateResult.status || 502, { ok: false, message: msg });
        return;
      }

      const local = dbState.users[email] || {};
      dbState.users[email] = {
        ...local,
        email,
        passwordUpdatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      saveDbState();
      sendJson(res, 200, { ok: true, message: 'Password updated.' });
      return;
    }

    const user = dbState.users[email] || {};
    if (user.passwordHash && !verifyPassword(currentPassword, user.passwordHash)) {
      sendJson(res, 401, { ok: false, message: 'Current password is incorrect.' });
      return;
    }

    dbState.users[email] = {
      ...user,
      email,
      passwordHash: hashPassword(newPassword),
      passwordUpdatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    saveDbState();
    sendJson(res, 200, { ok: true, message: 'Password updated.' });
    return;
  }

  if (pathname === '/api/auth/request-password-reset' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const email = String(body.email || '').trim().toLowerCase();
    if (isValidEmail(email) && isSupabaseConfigured()) {
      await supabaseAuthRequest('recover', { email });
    } else if (isValidEmail(email) && dbState.users[email]) {
      const rawToken = randomToken(32);
      const tokenHash = hashToken(rawToken);
      dbState.passwordResetTokens[tokenHash] = {
        email,
        createdAt: now(),
        expiresAt: now() + 20 * 60 * 1000,
        used: false
      };
      saveDbState();
      if (NODE_ENV !== 'production') {
        console.log(`[AUTH] Password reset token for ${email}: ${rawToken}`);
      }
    }

    sendJson(res, 200, {
      ok: true,
      message: 'If an account exists, a password reset link will be sent.'
    });
    return;
  }

  if (pathname === '/api/auth/reset-password' && req.method === 'POST') {
    if (isSupabaseConfigured()) {
      sendJson(res, 410, {
        ok: false,
        message: 'Password reset is handled by Supabase email recovery links. Use the link sent to your email.'
      });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const token = String(body.token || '').trim();
    const newPassword = String(body.newPassword || '');
    if (!token) {
      sendJson(res, 400, { ok: false, message: 'Invalid reset token.' });
      return;
    }
    if (!isStrongPassword(newPassword)) {
      sendJson(res, 400, { ok: false, message: 'Password must be at least 12 characters and include upper, lower, number, and symbol.' });
      return;
    }

    const tokenHash = hashToken(token);
    const resetRecord = dbState.passwordResetTokens[tokenHash];
    if (!resetRecord || resetRecord.used || resetRecord.expiresAt <= now()) {
      sendJson(res, 400, { ok: false, message: 'Reset link is invalid or expired.' });
      return;
    }

    const email = resetRecord.email;
    const user = dbState.users[email] || { email };
    dbState.users[email] = {
      ...user,
      email,
      passwordHash: hashPassword(newPassword),
      passwordUpdatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    dbState.passwordResetTokens[tokenHash] = {
      ...resetRecord,
      used: true,
      usedAt: now()
    };
    saveDbState();
    sendJson(res, 200, { ok: true, message: 'Password reset successful.' });
    return;
  }

  if (pathname === '/api/admin/auth/session' && req.method === 'GET') {
    const session = getAdminSession(req);
    if (!session) {
      sendJson(res, 401, { ok: false, authenticated: false });
      return;
    }
    const email = getSessionEmail(session);
    if (!isAdminEmail(email)) {
      sendJson(res, 403, { ok: false, message: 'Admin access required.' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      authenticated: true,
      profile: session.userProfile
    });
    return;
  }

  if (pathname === '/api/admin/auth/login' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!isValidEmail(email) || !password) {
      sendJson(res, 400, { ok: false, message: 'Please provide a valid email and password.' });
      return;
    }
    if (!isAdminEmail(email)) {
      sendJson(res, 403, { ok: false, message: 'Admin access required.' });
      return;
    }

    const loginResult = await supabaseAuthRequest('token?grant_type=password', { email, password });
    if (!loginResult.ok) {
      const msg = loginResult.data && loginResult.data.msg
        ? loginResult.data.msg
        : loginResult.data && loginResult.data.message
          ? loginResult.data.message
          : 'Invalid email or password.';
      sendJson(res, loginResult.status === 400 || loginResult.status === 401 ? 401 : loginResult.status, { ok: false, message: msg });
      return;
    }

    upsertLocalUserFromSupabaseUser(loginResult.data && loginResult.data.user ? loginResult.data.user : { email });
    setAdminSession(res, getSessionProfileFromUser(email));
    sendJson(res, 200, { ok: true, message: 'Authenticated', redirectTo: '/pages/admin.html' });
    return;
  }

  if (pathname === '/api/admin/auth/logout' && req.method === 'POST') {
    clearAdminSession(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/profile' && req.method === 'GET') {
    const session = requireSession(req, res);
    if (!session) return;

    const email = getSessionEmail(session);
    if (!email) {
      sendJson(res, 400, { ok: false, message: 'Session missing email.' });
      return;
    }

    if (isSupabaseDbConfigured()) {
      const sessionUserId = getSessionSupabaseUserId(session);
      const remoteProfile = await getSupabaseUserProfile(email, sessionUserId);
      if (remoteProfile) {
        const mapped = mapSupabaseProfileRowToApiProfile(remoteProfile, email);
        dbState.userProfiles[email] = {
          ...(dbState.userProfiles[email] || {}),
          firstName: mapped.firstName,
          lastName: mapped.lastName,
          email: mapped.email,
          phone: mapped.phone,
          registrationNumber: mapped.registrationNumber,
          gmcNumber: mapped.gmcNumber,
          specialistCountry: mapped.specialistCountry,
          profilePhotoName: mapped.profilePhotoName,
          profilePhotoDataUrl: mapped.profilePhotoDataUrl,
          idCopyName: mapped.idCopyName,
          idCopyDataUrl: mapped.idCopyDataUrl,
          cvFileName: mapped.cvFileName,
          updatedAt: mapped.updatedAt
        };
        dbState.users[email] = {
          ...(dbState.users[email] || {}),
          email,
          supabaseUserId: remoteProfile.user_id || sessionUserId || '',
          firstName: mapped.firstName,
          lastName: mapped.lastName,
          registrationCountry: mapped.specialistCountry || '',
          updatedAt: new Date().toISOString()
        };
        saveDbState();
        sendJson(res, 200, { ok: true, profile: mapped });
        return;
      }

      sendJson(res, 404, { ok: false, message: 'Profile not found in database for this user.' });
      return;
    }

    const stored = dbState.userProfiles[email] || {};
    const user = dbState.users[email] || {};
    sendJson(res, 200, {
      ok: true,
      profile: {
        firstName: stored.firstName || user.firstName || '',
        lastName: stored.lastName || user.lastName || '',
        email: stored.email || user.email || email,
        phone: stored.phone || [user.countryDial, user.phoneNumber].filter(Boolean).join(' ').trim(),
        registrationNumber: stored.registrationNumber || '',
        gmcNumber: stored.gmcNumber || '',
        specialistCountry: user.registrationCountry || stored.specialistCountry || '',
        hasPassword: !!user.passwordHash,
        profilePhotoName: stored.profilePhotoName || '',
        profilePhotoDataUrl: stored.profilePhotoDataUrl || '',
        idCopyName: stored.idCopyName || '',
        idCopyDataUrl: stored.idCopyDataUrl || '',
        cvFileName: stored.cvFileName || '',
        updatedAt: stored.updatedAt || null
      }
    });
    return;
  }

  if (pathname === '/api/profile' && req.method === 'PUT') {
    const session = requireSession(req, res);
    if (!session) return;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const email = getSessionEmail(session);
    if (!email) {
      sendJson(res, 400, { ok: false, message: 'Session missing email.' });
      return;
    }

    const clean = sanitizeProfileInput(body.profile || body);
    if (clean.email && clean.email !== email) {
      sendJson(res, 400, { ok: false, message: 'Email cannot be changed from this endpoint.' });
      return;
    }
    clean.email = email;

    if (isSupabaseDbConfigured()) {
      const sessionUserId = getSessionSupabaseUserId(session);
      const existing = await getSupabaseUserProfile(email, sessionUserId);
      const userId = (existing && existing.user_id) || sessionUserId;

      if (userId) {
        const upserted = await upsertSupabaseUserProfile(userId, email, clean, existing);
        if (upserted) {
          const mapped = mapSupabaseProfileRowToApiProfile(upserted, email);
          dbState.userProfiles[email] = {
            ...(dbState.userProfiles[email] || {}),
            firstName: mapped.firstName,
            lastName: mapped.lastName,
            email: mapped.email,
            phone: mapped.phone,
            registrationNumber: mapped.registrationNumber,
            gmcNumber: mapped.gmcNumber,
            specialistCountry: mapped.specialistCountry,
            profilePhotoName: mapped.profilePhotoName,
            profilePhotoDataUrl: mapped.profilePhotoDataUrl,
            idCopyName: mapped.idCopyName,
            idCopyDataUrl: mapped.idCopyDataUrl,
            cvFileName: mapped.cvFileName,
            updatedAt: mapped.updatedAt
          };
          dbState.users[email] = {
            ...(dbState.users[email] || {}),
            email,
            supabaseUserId: upserted.user_id || sessionUserId || '',
            firstName: mapped.firstName,
            lastName: mapped.lastName,
            registrationCountry: mapped.specialistCountry || '',
            updatedAt: new Date().toISOString()
          };
          saveDbState();
          sendJson(res, 200, { ok: true, profile: mapped });
          return;
        }
        sendJson(res, 502, { ok: false, message: 'Failed to persist profile to database.' });
        return;
      }

      sendJson(res, 409, { ok: false, message: 'Cannot resolve database user id for profile update.' });
      return;
    }

    const userRegistrationCountry = (dbState.users[email] && dbState.users[email].registrationCountry)
      ? dbState.users[email].registrationCountry
      : clean.specialistCountry;
    clean.specialistCountry = userRegistrationCountry || '';

    dbState.userProfiles[email] = {
      ...(dbState.userProfiles[email] || {}),
      ...clean
    };
    dbState.users[email] = {
      ...(dbState.users[email] || {}),
      firstName: clean.firstName || (dbState.users[email] && dbState.users[email].firstName) || '',
      lastName: clean.lastName || (dbState.users[email] && dbState.users[email].lastName) || '',
      email,
      registrationCountry: (dbState.users[email] && dbState.users[email].registrationCountry) || clean.specialistCountry || '',
      updatedAt: new Date().toISOString()
    };

    saveDbState();
    sendJson(res, 200, { ok: true, profile: dbState.userProfiles[email] });
    return;
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    const session = requireSession(req, res);
    if (!session) return;

    const email = getSessionEmail(session);
    if (!email) {
      sendJson(res, 400, { ok: false, message: 'Session missing email.' });
      return;
    }

    if (isSupabaseDbConfigured()) {
      const remoteState = await getSupabaseUserStateByEmail(email);
      if (remoteState) {
        const filtered = {};
        for (const key of USER_STATE_KEYS) {
          if (Object.prototype.hasOwnProperty.call(remoteState.state, key)) {
            filtered[key] = remoteState.state[key];
          }
        }
        sendJson(res, 200, {
          ok: true,
          state: filtered,
          updatedAt: remoteState.updatedAt
        });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        state: {},
        updatedAt: null
      });
      return;
    }

    const state = dbState.userState[email] || {};
    const filtered = {};
    for (const key of USER_STATE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(state, key)) {
        filtered[key] = state[key];
      }
    }

    sendJson(res, 200, {
      ok: true,
      state: filtered,
      updatedAt: state.updatedAt || null
    });
    return;
  }

  if (pathname === '/api/state' && req.method === 'PUT') {
    const session = requireSession(req, res);
    if (!session) return;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const email = getSessionEmail(session);
    if (!email) {
      sendJson(res, 400, { ok: false, message: 'Session missing email.' });
      return;
    }

    const incoming = sanitizeUserStateInput(body);
    const currentLocal = dbState.userState[email] && typeof dbState.userState[email] === 'object'
      ? dbState.userState[email]
      : {};
    const currentRemote = isSupabaseDbConfigured()
      ? await getSupabaseUserStateByEmail(email)
      : null;
    if (isSupabaseDbConfigured() && (!currentRemote || !currentRemote.userId)) {
      sendJson(res, 409, { ok: false, message: 'Cannot resolve database user id for state update.' });
      return;
    }
    const current = currentRemote && currentRemote.state && typeof currentRemote.state === 'object'
      ? currentRemote.state
      : currentLocal;

    const next = { ...current };
    for (const [key, value] of Object.entries(incoming)) {
      if (value === null) {
        delete next[key];
      } else {
        next[key] = value;
      }
    }
    next.updatedAt = new Date().toISOString();

    const updatedAt = next.updatedAt;

    if (currentRemote && currentRemote.userId) {
      const saved = await upsertSupabaseUserState(currentRemote.userId, next, updatedAt);
      if (!saved) {
        sendJson(res, 502, { ok: false, message: 'Failed to persist user state to database.' });
        return;
      }
    } else {
      dbState.userState[email] = next;
      saveDbState();
    }

    sendJson(res, 200, { ok: true, updatedAt });
    return;
  }

  if (pathname === '/api/admin/dashboard' && req.method === 'GET') {
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;

    const baseDashboard = await collectAdminDashboardData();
    const dashboard = await ensureDashboardIncludesSessionUser(baseDashboard, adminCtx.session, adminCtx.email);
    sendJson(res, 200, {
      ok: true,
      refreshedAt: new Date().toISOString(),
      ...dashboard
    });
    return;
  }

  const adminTicketMatch = pathname.match(/^\/api\/admin\/tickets\/([^/]+)$/);
  if (adminTicketMatch && req.method === 'PUT') {
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const ticketId = decodeURIComponent(adminTicketMatch[1] || '').trim();
    if (!ticketId) {
      sendJson(res, 400, { ok: false, message: 'Invalid ticket id.' });
      return;
    }

    const nextStatus = body && typeof body.status === 'string' && ['open', 'closed'].includes(body.status)
      ? body.status
      : null;
    const adminReply = body && typeof body.adminReply === 'string' ? body.adminReply.trim().slice(0, 2000) : '';

    const updatedTicket = await persistSupportCaseUpdate(ticketId, (item) => {
      const updated = {
        ...item,
        status: nextStatus || (item.status === 'closed' ? 'closed' : 'open'),
        updatedAt: new Date().toISOString()
      };
      const thread = Array.isArray(item.thread) ? item.thread.slice() : [];
      if (adminReply) {
        thread.push({
          from: 'gp',
          text: adminReply,
          ts: new Date().toISOString()
        });
        updated.unread = true;
      }
      updated.thread = thread;
      return updated;
    });

    if (!updatedTicket) {
      sendJson(res, 404, { ok: false, message: 'Ticket not found.' });
      return;
    }

    sendJson(res, 200, { ok: true, ticket: updatedTicket });
    return;
  }

  sendJson(res, 404, { ok: false, message: 'Not found' });
}

async function handleRequest(req, res) {
  cleanup();

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/') {
    res.writeHead(302, { Location: '/pages/index.html' });
    res.end();
    return;
  }

  if (pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, pathname);
    } catch (err) {
      console.error('[API ERROR]', err);
      sendJson(res, 500, { ok: false, message: 'Internal server error.' });
    }
    return;
  }

  if (pathname === '/logout') {
    clearSession(res, req);
    res.writeHead(302, { Location: '/pages/signin.html' });
    res.end();
    return;
  }

  if ((pathname === '/pages/admin.html' || pathname === '/pages/admin-signin.html') && !isAllowedAdminHost(req)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const session = getSession(req);
  const adminSession = getAdminSession(req);
  const isPublic =
    pathname === '/pages/signin.html' ||
    pathname === '/pages/admin-signin.html' ||
    pathname === '/media/images/gp-link-logo.svg' ||
    pathname.startsWith('/media/videos/myintealth-tutorial-') ||
    pathname.startsWith('/media/videos/amc-tutorial-') ||
    pathname === '/favicon.ico';

  if (shouldProtectPath(pathname) && !session) {
    res.writeHead(302, { Location: '/pages/signin.html' });
    res.end();
    return;
  }

  if (pathname === '/pages/signin.html' && session) {
    res.writeHead(302, { Location: '/pages/index.html' });
    res.end();
    return;
  }

  if (AUTH_DISABLED && pathname === '/pages/signin.html') {
    res.writeHead(302, { Location: '/pages/index.html' });
    res.end();
    return;
  }

  if (pathname === '/pages/admin-signin.html' && adminSession) {
    res.writeHead(302, { Location: '/pages/admin.html' });
    res.end();
    return;
  }

  if (pathname === '/pages/admin.html') {
    if (!adminSession) {
      res.writeHead(302, { Location: '/pages/admin-signin.html' });
      res.end();
      return;
    }
    const email = getSessionEmail(adminSession);
    if (!isAdminEmail(email)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Admin access required');
      return;
    }
  }

  if (pathname !== '/pages/admin.html' && !isPublic && !session && (pathname.endsWith('.html') || pathname === '/')) {
    if (AUTH_DISABLED) {
      serveStatic(req, res, pathname);
      return;
    }
    res.writeHead(302, { Location: '/pages/signin.html' });
    res.end();
    return;
  }

  serveStatic(req, res, pathname);
}

if (process.env.VERCEL) {
  module.exports = async (req, res) => {
    await handleRequest(req, res);
  };
} else {
  const server = http.createServer(async (req, res) => {
    await handleRequest(req, res);
  });

  server.listen(PORT, HOST, () => {
    console.log(`GP Link server running on http://${HOST}:${PORT}`);
    console.log(`[ENV] NODE_ENV=${NODE_ENV} AUTH_DISABLED=${AUTH_DISABLED} DB_FILE_PATH=${DB_FILE_PATH}`);
    if (SECRET === 'replace-me-in-production') {
      console.warn('[WARN] AUTH_SECRET is using the default placeholder. Set AUTH_SECRET before going live.');
    }
  });
}
