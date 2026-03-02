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
const DEFAULT_DB_FILE_PATH = process.env.VERCEL
  ? path.join('/tmp', 'app-db.json')
  : path.join(process.cwd(), 'data', 'app-db.json');
const DB_FILE_PATH = process.env.DB_FILE_PATH || DEFAULT_DB_FILE_PATH;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rqrqcfxalkvzwbedvsjs.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_azrMKjmESGzVhabzQjybSg_9BwLy9C0';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
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
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });

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
  if (ADMIN_EMAILS.size === 0) return true;
  return ADMIN_EMAILS.has(String(email).trim().toLowerCase());
}

function requireAdminSession(req, res) {
  const session = requireSession(req, res);
  if (!session) return null;
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

function collectAdminDashboardData() {
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
      documentsPending: progress.documentsPending
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

function persistSupportCaseUpdate(candidateEmail, ticketId, patch) {
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
  if (!updated) return null;
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
  return normalizeSupportCase(finalCase);
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

function getSessionProfileFromUser(email) {
  const key = String(email || '').trim().toLowerCase();
  const user = dbState.users[key] || {};
  const profile = dbState.userProfiles[key] || {};

  return {
    firstName: user.firstName || profile.firstName || '',
    lastName: user.lastName || profile.lastName || '',
    email: key,
    countryDial: user.countryDial || '',
    phoneNumber: user.phoneNumber || '',
    registrationCountry: user.registrationCountry || profile.specialistCountry || ''
  };
}

function upsertLocalUserFromSupabaseUser(supaUser) {
  const email = String(supaUser && supaUser.email ? supaUser.email : '').trim().toLowerCase();
  if (!email) return null;

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
    console.log(`[AUTH] OTP (${method}) for ${otpKey}: ${code}`);

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
    if (isValidEmail(email) && dbState.users[email]) {
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

  if (pathname === '/api/profile' && req.method === 'GET') {
    const session = requireSession(req, res);
    if (!session) return;

    const email = getSessionEmail(session);
    if (!email) {
      sendJson(res, 400, { ok: false, message: 'Session missing email.' });
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

    const dashboard = collectAdminDashboardData();
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

    let updatedTicket = null;
    const allEmails = Object.keys(dbState.userState || {});
    for (const candidateEmail of allEmails) {
      const next = persistSupportCaseUpdate(candidateEmail, ticketId, (item) => {
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
      if (next) {
        updatedTicket = { ...next, candidateEmail };
        break;
      }
    }

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

  const session = getSession(req);
  const isPublic =
    pathname === '/pages/signin.html' ||
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

  if (pathname === '/pages/admin.html') {
    if (!session) {
      res.writeHead(302, { Location: '/pages/signin.html' });
      res.end();
      return;
    }
    const email = getSessionEmail(session);
    if (!isAdminEmail(email)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Admin access required');
      return;
    }
  }

  if (!isPublic && !session && (pathname.endsWith('.html') || pathname === '/')) {
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
