const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const hybridAgents = require('./scripts/agents.js');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const AUTH_DISABLED = process.env.AUTH_DISABLED === 'true';
const OTP_TTL_MS = Number(process.env.OTP_TTL_MS || 5 * 60 * 1000);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 10 * 60 * 1000);
const RATE_MAX_SEND = Number(process.env.RATE_MAX_SEND || 5);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 12 * 60 * 60 * 1000);
const MAX_JSON_BODY_BYTES = Number(process.env.MAX_JSON_BODY_BYTES || 12 * 1024 * 1024);
const ADMIN_DASHBOARD_CACHE_TTL_MS = Number(process.env.ADMIN_DASHBOARD_CACHE_TTL_MS || 8000);
const AUTH_RATE_WINDOW_MS = Number(process.env.AUTH_RATE_WINDOW_MS || 10 * 60 * 1000);
const AUTH_RATE_MAX_ATTEMPTS = Number(process.env.AUTH_RATE_MAX_ATTEMPTS || 12);
const AUTH_PREWARM_RATE_MAX = Number(process.env.AUTH_PREWARM_RATE_MAX || 40);
const AUTH_BOOTSTRAP_CACHE_TTL_MS = Number(process.env.AUTH_BOOTSTRAP_CACHE_TTL_MS || 2 * 60 * 1000);
const SECRET = process.env.AUTH_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-only-secret-not-for-production');
const COOKIE_NAME = 'gp_session';
const ADMIN_COOKIE_NAME = process.env.ADMIN_COOKIE_NAME || 'gp_admin_session';
const ADMIN_SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_MS || 8 * 60 * 60 * 1000);
const OAUTH_ACCESS_TTL_MS = Number(process.env.OAUTH_ACCESS_TTL_MS || 15 * 60 * 1000);  // 15 min
const OAUTH_REFRESH_TTL_MS = Number(process.env.OAUTH_REFRESH_TTL_MS || 7 * 24 * 60 * 60 * 1000); // 7 days
const ENFORCE_SAME_ORIGIN = process.env.ENFORCE_SAME_ORIGIN
  ? process.env.ENFORCE_SAME_ORIGIN === 'true'
  : NODE_ENV === 'production';
const REQUIRE_SUPABASE_DB = process.env.REQUIRE_SUPABASE_DB
  ? process.env.REQUIRE_SUPABASE_DB === 'true'
  : NODE_ENV === 'production';
const ADMIN_ALLOWED_HOSTS = new Set(
  String(process.env.ADMIN_ALLOWED_HOSTS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);
const SUPER_ADMIN_ALLOWED_HOSTS = new Set(
  String(process.env.SUPER_ADMIN_ALLOWED_HOSTS || '')
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
const SUPABASE_DOCUMENT_BUCKET = String(process.env.SUPABASE_DOCUMENT_BUCKET || 'gp-link-documents').trim() || 'gp-link-documents';
const SUPABASE_SCAN_NORMALIZER_FUNCTION = String(process.env.SUPABASE_SCAN_NORMALIZER_FUNCTION || 'normalize-scan-image').trim() || 'normalize-scan-image';
const ZOHO_RECRUIT_CLIENT_ID = String(process.env.ZOHO_RECRUIT_CLIENT_ID || '').trim();
const ZOHO_RECRUIT_CLIENT_SECRET = String(process.env.ZOHO_RECRUIT_CLIENT_SECRET || '').trim();
const ZOHO_RECRUIT_ACCOUNTS_SERVER = String(process.env.ZOHO_RECRUIT_ACCOUNTS_SERVER || 'https://accounts.zoho.com').trim() || 'https://accounts.zoho.com';
const ZOHO_RECRUIT_REDIRECT_URI = String(process.env.ZOHO_RECRUIT_REDIRECT_URI || '').trim();
const REQUIRED_ZOHO_RECRUIT_SCOPES = Object.freeze([
  'ZohoRecruit.modules.READ'
]);
const OPTIONAL_ZOHO_RECRUIT_SCOPES = Object.freeze([
  'ZohoRecruit.search.READ'
]);
const ZOHO_RECRUIT_SCOPES = String(process.env.ZOHO_RECRUIT_SCOPES || '').trim();
const ZOHO_RECRUIT_SYNC_PAGE_SIZE = Number(process.env.ZOHO_RECRUIT_SYNC_PAGE_SIZE || 200);
const ZOHO_RECRUIT_SYNC_MAX_PAGES = Number(process.env.ZOHO_RECRUIT_SYNC_MAX_PAGES || 25);
const ZOHO_RECRUIT_SYNC_CRON_SECRET = String(process.env.ZOHO_RECRUIT_SYNC_CRON_SECRET || process.env.CRON_SECRET || '').trim();
let _zohoRolesCache = null; // { roles: [], ts: 0 } — 5 min in-memory cache for live Zoho roles
let _zohoRolesFetchPromise = null; // promise coalescing for concurrent requests
const _authBootstrapWarmCache = new Map(); // email -> { expiresAt, value }
const _authBootstrapInFlight = new Map(); // email -> Promise
const _careerHeroLookupCache = new Map(); // normalized location key -> { ts, value }
let _careerHeroCityLibraryCache = { ts: 0, value: null };
let _homelyBuildIdCache = { value: '', expiresAt: 0 };
const _applyRateLimitStore = new Map(); // userId → [timestamps] for rate limiting apply endpoint
const APPLY_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const APPLY_RATE_MAX = 10; // max 10 applications per hour
const GOOGLE_PLACES_API_KEY = String(process.env.GOOGLE_PLACES_API_KEY || '').trim();
const _schoolsSearchCache = new Map(); // cacheKey -> { ts, value }
const SCHOOLS_SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const API_RATE_WINDOW_MS = 60 * 1000; // 1 minute window for general API rate limiting
const API_RATE_MAX_REQUESTS = 30; // max 30 requests per minute per user
const _apiRateLimitStore = new Map(); // userId -> [timestamps]
const VISA_STAGES = ['nomination', 'lodgement', 'processing', 'granted', 'refused'];
const PBS_APPLICATION_TYPES = ['medicare_provider', 'pbs_prescriber'];
const PBS_STATUSES = ['not_started', 'in_progress', 'submitted', 'approved', 'rejected', 'waiting_on_gp', 'under_review', 'complete', 'blocked'];
const OPENAI_CAREER_MODEL = String(process.env.OPENAI_CAREER_MODEL || 'gpt-4.1-mini').trim() || 'gpt-4.1-mini';
const CAREER_AI_PROFILE_VERSION = 2;
// DoubleTick WhatsApp integration
const DOUBLETICK_API_KEY = String(process.env.DOUBLETICK_API_KEY || '').trim();
const DOUBLETICK_BASE_URL = String(process.env.DOUBLETICK_BASE_URL || 'https://public.doubletick.io').trim() || 'https://public.doubletick.io';
const DOUBLETICK_WEBHOOK_SECRET = String(process.env.DOUBLETICK_WEBHOOK_SECRET || '').trim();
const DOUBLETICK_WEBHOOK_RATE_MAX = 60; // max 60 deliveries per minute per source IP
const DOUBLETICK_WEBHOOK_RATE_WINDOW_MS = 60 * 1000;
const DOUBLETICK_CONVERSATION_URL_PREFIX = 'https://app.doubletick.io/';
const DOUBLETICK_MESSAGE_BODY_MAX_LEN = 4096;
// Stage → DoubleTick approved WhatsApp template name mapping.
// These template names must match exactly what is configured in the DoubleTick dashboard.
const DOUBLETICK_USE_DIRECT_TEXT = false; // templates are approved
const DOUBLETICK_STAGE_TEMPLATES = {
  myintealth: { templateName: 'gp_link_app_myintealth_introductiory_message_', language: 'en' },
  amc: { templateName: 'gp_link_app_amc_introductiory_message_', language: 'en' },
  ahpra: { templateName: 'gp_link_app_ahpra_introductiory_message', language: 'en' }
  // career and visa templates not yet created in DoubleTick
};
// Direct text messages used while templates are pending approval
const DOUBLETICK_STAGE_MESSAGES = {
  myintealth: 'Hi {{name}}, welcome to GP Link! 🎉 Your first step is creating your MyIntealth account. If you need any help at any point, just reply to this message and we\'ll get a team member to assist you right away.',
  amc: 'Hi {{name}}, you\'ve moved on to the AMC step! 🎉 You\'ll need to create your AMC portfolio and upload your credentials. If you need any help at any point, just reply to this message and we\'ll get a team member to assist you right away.',
  career: 'Hi {{name}}, your AMC step is complete — now it\'s time for the Career & Documents stage! 🎉 We\'ll help you find and secure a placement. If you need any help, just reply to this message.',
  ahpra: 'Hi {{name}}, great progress — you\'ve unlocked the AHPRA step! 🎉 This involves registering with the Australian Health Practitioner Regulation Agency. If you need any help, just reply to this message.',
  visa: 'Hi {{name}}, you\'re onto the Visa stage! 🎉 We\'ll guide you through the visa application process. If you need any help, just reply to this message.'
};
const CAREER_HERO_IMAGE_VERSION = 3;
const CAREER_HERO_LOOKUP_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CAREER_HERO_CITY_LIBRARY_CACHE_TTL_MS = 60 * 60 * 1000;
const CAREER_HERO_IMAGE_BUCKET = String(process.env.CAREER_HERO_IMAGE_BUCKET || 'career-hero-images').trim() || 'career-hero-images';
const HERO_DESKTOP_MP4_URL = String(process.env.HERO_DESKTOP_MP4_URL || '').trim();
const HERO_DESKTOP_WEBM_URL = String(process.env.HERO_DESKTOP_WEBM_URL || '').trim();
const HERO_MOBILE_MP4_URL = String(process.env.HERO_MOBILE_MP4_URL || '').trim();
const HERO_MOBILE_WEBM_URL = String(process.env.HERO_MOBILE_WEBM_URL || '').trim();
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const OPENAI_SCAN_MODEL = String(process.env.OPENAI_SCAN_MODEL || 'gpt-4.1-mini').trim();
const ANTHROPIC_API_KEY = String(process.env.ANTHROPIC_API_KEY || '').trim();
const ANTHROPIC_MODEL = String(process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6').trim() || 'claude-sonnet-4-6';
const ANTHROPIC_DAILY_LIMIT_USD = Number(process.env.ANTHROPIC_DAILY_LIMIT_USD || 100);
const DEFAULT_GOOGLE_MAPS_BROWSER_API_KEY = '';
const DEFAULT_GOOGLE_MAPS_MAP_ID = '';
const GOOGLE_MAPS_BROWSER_API_KEY = String(
  process.env.GOOGLE_MAPS_BROWSER_API_KEY
  || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  || DEFAULT_GOOGLE_MAPS_BROWSER_API_KEY
  || ''
).trim();
const GOOGLE_MAPS_SERVER_API_KEY = String(
  process.env.GOOGLE_MAPS_SERVER_API_KEY
  || GOOGLE_MAPS_BROWSER_API_KEY
  || ''
).trim();
const GOOGLE_MAPS_MAP_ID = String(process.env.GOOGLE_MAPS_MAP_ID || DEFAULT_GOOGLE_MAPS_MAP_ID || '').trim();
const DOMAIN_API_BASE = normalizeUrlBase(process.env.DOMAIN_API_BASE, 'https://api.domain.com.au');
const DOMAIN_API_KEY = String(process.env.DOMAIN_API_KEY || '').trim();
const DOMAIN_API_ACCESS_TOKEN = String(process.env.DOMAIN_API_ACCESS_TOKEN || '').trim();
const DOMAIN_API_CLIENT_ID = String(process.env.DOMAIN_API_CLIENT_ID || '').trim();
const DOMAIN_API_CLIENT_SECRET = String(process.env.DOMAIN_API_CLIENT_SECRET || '').trim();
const DOMAIN_API_SCOPE = String(process.env.DOMAIN_API_SCOPE || 'api_listings_read').trim() || 'api_listings_read';
const DOMAIN_AUTH_TOKEN_URL = String(process.env.DOMAIN_AUTH_TOKEN_URL || 'https://auth.domain.com.au/v1/connect/token').trim() || 'https://auth.domain.com.au/v1/connect/token';
const ALLOW_DOMAIN_LIFESTYLE_FALLBACK = String(process.env.ALLOW_DOMAIN_LIFESTYLE_FALLBACK || 'false').trim().toLowerCase() === 'true';
const CAREER_LIFESTYLE_EXPERIENCE_VERSION = 14;
const CAREER_LIFESTYLE_CACHE_TTL_MS = Number(process.env.CAREER_LIFESTYLE_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const DOMAIN_LIFESTYLE_RESULT_LIMIT = Number(process.env.DOMAIN_LIFESTYLE_RESULT_LIMIT || 18);
const DOMAIN_LIFESTYLE_SEARCH_PAGE_SIZE = Math.max(10, Number(process.env.DOMAIN_LIFESTYLE_SEARCH_PAGE_SIZE || 40) || 40);
const DOMAIN_LIFESTYLE_MAX_RADIUS_KM = 25;
const DOMAIN_AGENCIES_READ_SCOPE = 'api_agencies_read';
const DOMAIN_LIFESTYLE_AGENCY_BRANDS = Array.from(new Set(
  String(process.env.DOMAIN_LIFESTYLE_AGENCY_BRANDS || 'Ray White,LJ Hooker,Harcourts,Raine & Horne')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
)).slice(0, 8);
const HOMELY_BASE_URL = 'https://www.homely.com.au';
const HOMELY_LOCATION_SEARCH_URL = 'https://api.homely.com.au/search/locations';
const HOMELY_LIFESTYLE_MAX_PAGES = Math.max(1, Math.min(5, Number(process.env.HOMELY_LIFESTYLE_MAX_PAGES || 4) || 4));
const HOMELY_LIFESTYLE_USER_AGENT = 'Mozilla/5.0 (compatible; GP Link Live Listings/1.0; +https://app.mygplink.com.au)';
const NSW_SCHOOL_FINDER_SQL_ENDPOINT = 'https://cesensw.carto.com/api/v2/sql';
const SCHOOL_FINDER_TABLE_SCHOOLS = 'dec_schools_2020';
const SCHOOL_FINDER_TABLE_CATCHMENTS = 'catchments_2020';
const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);
const SUPER_ADMIN_EMAILS = new Set(
  String(process.env.SUPER_ADMIN_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);
let _domainApiAccessTokenCache = new Map();

function validateRuntimeConfig() {
  if (NODE_ENV !== 'production') return;

  if (!SECRET || SECRET === 'replace-me-in-production') {
    throw new Error('AUTH_SECRET must be set to a strong value in production.');
  }

  if (!AUTH_DISABLED && (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY)) {
    throw new Error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set in production when auth is enabled.');
  }
  if (REQUIRE_SUPABASE_DB && !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY must be set in production (REQUIRE_SUPABASE_DB=true).');
  }

  if (ADMIN_EMAILS.size === 0 && SUPER_ADMIN_EMAILS.size === 0) {
    console.warn('[WARN] ADMIN_EMAILS and SUPER_ADMIN_EMAILS are empty. Admin sign-in requires roles in public.user_roles or env bootstrap allowlists.');
  }

  if (ADMIN_ALLOWED_HOSTS.size === 0 && SUPER_ADMIN_ALLOWED_HOSTS.size === 0) {
    console.warn('[WARN] ADMIN_ALLOWED_HOSTS and SUPER_ADMIN_ALLOWED_HOSTS are empty. Admin routes are blocked in production.');
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

function isCompressibleType(ext) {
  return ext === '.html' || ext === '.css' || ext === '.js' || ext === '.json' || ext === '.svg';
}

const APP_SHELL_EMBED_PARAM = 'gp_shell';
const APP_SHELL_EMBED_VALUE = 'embedded';
const APP_SHELL_SUPPORTED_PATHS = new Set([
  '/pages/index.html',
  '/pages/myinthealth.html',
  '/pages/amc.html',
  '/pages/ahpra.html',
  '/pages/my-documents.html',
  '/pages/career.html',
  '/pages/messages.html',
  '/pages/account.html',
  '/pages/registration-intro.html'
]);

const USER_STATE_KEYS = [
  'gp_epic_progress',
  'gp_amc_progress',
  'gp_ahpra_progress',
  'gp_registration_intro_seen',
  'gp_epic_tutorial_seen',
  'gp_amc_tutorial_seen',
  'gp_ahpra_tutorial_seen',
  'gp_documents_prep',
  'gp_prepared_docs',
  'gp_selected_country',
  'gp_link_updates',
  'gp_link_updates_read',
  'gpLinkSupportCases',
  'gpLinkMessageDB',
  'gpLinkSupportDraft',
  'gp_account_profile',
  'gp_career_state',
  'gp_onboarding_complete',
  'gp_onboarding'
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

const GP_DOCUMENT_META = {
  shared: [
    { key: 'primary_medical_degree', label: 'Primary medical degree', source: 'prepared_by_you' },
    { key: 'cv_signed_dated', label: 'Signed CV', source: 'prepared_by_you' },
    { key: 'certificate_good_standing', label: 'Certificate of good standing', source: 'institution_docs' },
    { key: 'criminal_history', label: 'Criminal history check', source: 'institution_docs' }
  ],
  uk: [
    { key: 'mrcgp_certified', label: 'MRCGP certificate', source: 'prepared_by_you' },
    { key: 'cct_certified', label: 'CCT certificate', source: 'prepared_by_you' },
    { key: 'confirmation_training', label: 'Confirmation of training', source: 'institution_docs' }
  ],
  ie: [
    { key: 'micgp_certified', label: 'MICGP certificate', source: 'prepared_by_you' },
    { key: 'cscst_certified', label: 'CSCST certificate', source: 'prepared_by_you' },
    { key: 'icgp_confirmation_letter', label: 'ICGP confirmation letter', source: 'prepared_by_you' }
  ],
  nz: [
    { key: 'frnzcgp_certified', label: 'FRNZCGP certificate', source: 'prepared_by_you' },
    { key: 'rnzcgp_confirmation_letter', label: 'RNZCGP confirmation letter', source: 'prepared_by_you' }
  ]
};

const GP_LINK_DOCUMENT_META = [
  { key: 'sppa_00', label: 'SPPA-00', source: 'gplink_pack' },
  { key: 'section_g', label: 'Section G', source: 'gplink_pack' },
  { key: 'position_description', label: 'Position description', source: 'gplink_pack' },
  { key: 'offer_contract', label: 'Offer/contract', source: 'gplink_pack' },
  { key: 'supervisor_cv', label: 'Supervisor CV', source: 'gplink_pack' }
];

const PREPARED_DOCUMENT_MAX_DATA_URL_LENGTH = 8 * 1024 * 1024;
const PREPARED_DOCUMENT_KEYS = new Set(
  Object.values(GP_DOCUMENT_META)
    .flatMap((items) => Array.isArray(items) ? items : [])
    .filter((item) => item && item.source === 'prepared_by_you')
    .map((item) => item.key)
);
const ONBOARDING_DOCUMENT_KEYS = new Set([
  'onboarding_specialist_qualification',
  'onboarding_primary_med_degree'
]);

function normalizeDocumentCountry(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'uk' || raw === 'gb' || raw === 'united kingdom') return 'uk';
  if (raw === 'ie' || raw === 'ireland') return 'ie';
  if (raw === 'nz' || raw === 'new zealand') return 'nz';
  return '';
}

function sanitizeStoredDocumentPayload(body, allowedKeys) {
  const input = body && typeof body === 'object' ? body : {};
  const country = normalizeDocumentCountry(input.country);
  const key = sanitizeUserString(input.key, 120);
  const fileName = sanitizeUserString(input.fileName, 240);
  const mimeType = sanitizeUserString(input.mimeType, 160);
  const fileSize = Math.max(0, Math.min(Number(input.fileSize || 0), 25 * 1024 * 1024));
  const fileDataUrl = typeof input.fileDataUrl === 'string' ? input.fileDataUrl.trim() : '';
  if (!country || !key || !(allowedKeys instanceof Set) || !allowedKeys.has(key)) return null;
  if (!fileName || !mimeType || !fileDataUrl) return null;
  if (!fileDataUrl.startsWith('data:') || !/;base64,/i.test(fileDataUrl)) return null;
  if (fileDataUrl.length > PREPARED_DOCUMENT_MAX_DATA_URL_LENGTH) return null;
  return {
    country,
    key,
    fileName,
    mimeType,
    fileSize,
    fileDataUrl,
    updatedAt: new Date().toISOString()
  };
}

function sanitizePreparedDocumentPayload(body) {
  return sanitizeStoredDocumentPayload(body, PREPARED_DOCUMENT_KEYS);
}

function sanitizeOnboardingDocumentPayload(body) {
  return sanitizeStoredDocumentPayload(body, ONBOARDING_DOCUMENT_KEYS);
}

function sanitizeStoragePathSegment(value, maxLen = 120) {
  return String(value || '')
    .trim()
    .slice(0, maxLen)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'file';
}

function encodeSupabaseObjectPath(objectPath) {
  return String(objectPath || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function parseDataUrlPayload(dataUrl) {
  const raw = String(dataUrl || '').trim();
  const match = raw.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  try {
    return {
      mimeType: match[1] || 'application/octet-stream',
      buffer: Buffer.from(match[2], 'base64')
    };
  } catch (err) {
    return null;
  }
}

function buildPreparedDocumentStoragePath(userId, country, key) {
  return [
    'users',
    sanitizeStoragePathSegment(userId, 80),
    'prepared-documents',
    sanitizeStoragePathSegment(country, 20),
    sanitizeStoragePathSegment(key, 120),
    'current'
  ].join('/');
}

function buildOnboardingDocumentStoragePath(userId, country, key) {
  return [
    'users',
    sanitizeStoragePathSegment(userId, 80),
    'onboarding-documents',
    sanitizeStoragePathSegment(country, 20),
    sanitizeStoragePathSegment(key, 120),
    'current'
  ].join('/');
}

async function supabaseStorageUploadObject(bucket, objectPath, dataUrl, mimeType) {
  if (!isSupabaseDbConfigured()) return false;
  const parsed = parseDataUrlPayload(dataUrl);
  if (!parsed) return false;

  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeSupabaseObjectPath(objectPath)}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': mimeType || parsed.mimeType || 'application/octet-stream',
      'x-upsert': 'true'
    },
    body: parsed.buffer
  }).catch(() => null);

  return !!(response && response.ok);
}

async function supabaseStorageDeleteObject(bucket, objectPath) {
  if (!isSupabaseDbConfigured()) return false;
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeSupabaseObjectPath(objectPath)}`, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    }
  }).catch(() => null);
  return !!(response && response.ok);
}

async function supabaseStorageCreateSignedUrl(bucket, objectPath, fileName) {
  if (!isSupabaseDbConfigured()) return '';
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodeSupabaseObjectPath(objectPath)}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      expiresIn: 60 * 60,
      download: fileName || undefined
    })
  }).catch(() => null);
  if (!response || !response.ok) return '';
  const payload = await response.json().catch(() => null);
  const signedPath = payload && typeof payload.signedURL === 'string'
    ? payload.signedURL
    : (payload && typeof payload.signedUrl === 'string' ? payload.signedUrl : '');
  if (!signedPath) return '';
  return signedPath.startsWith('http') ? signedPath : `${SUPABASE_URL}/storage/v1${signedPath}`;
}

function buildSupabaseStoragePublicUrl(bucket, objectPath) {
  const bucketName = String(bucket || '').trim();
  const pathName = String(objectPath || '').trim();
  if (!SUPABASE_URL || !bucketName || !pathName) return '';
  return `${SUPABASE_URL}/storage/v1/object/public/${encodeURIComponent(bucketName)}/${encodeSupabaseObjectPath(pathName)}`;
}

function mapPreparedDocumentRow(row, signedUrl = '') {
  if (!row || typeof row !== 'object') return null;
  return {
    fileName: typeof row.file_name === 'string' ? row.file_name : '',
    mimeType: typeof row.mime_type === 'string' ? row.mime_type : '',
    fileSize: Math.max(0, Number(row.file_size || 0)),
    storageBucket: typeof row.storage_bucket === 'string' ? row.storage_bucket : SUPABASE_DOCUMENT_BUCKET,
    storagePath: typeof row.storage_path === 'string' && row.storage_path
      ? row.storage_path
      : (typeof row.file_url === 'string' ? row.file_url : ''),
    downloadUrl: signedUrl,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null
  };
}

function buildPreparedDocumentDownloadUrl(country, key) {
  return `/api/prepared-documents/download?country=${encodeURIComponent(country)}&key=${encodeURIComponent(key)}`;
}

function buildOnboardingDocumentDownloadUrl(country, key) {
  return `/api/onboarding-documents/download?country=${encodeURIComponent(country)}&key=${encodeURIComponent(key)}`;
}

async function listPreparedDocumentRows(userId, country) {
  const normalizedCountry = normalizeDocumentCountry(country);
  if (!normalizedCountry || !userId || !isSupabaseDbConfigured()) return [];
  const result = await supabaseDbRequest(
    'user_documents',
    `select=*&user_id=eq.${encodeURIComponent(userId)}&country_code=eq.${encodeURIComponent(normalizedCountry)}`
  );
  if (!result.ok || !Array.isArray(result.data)) return [];
  return result.data.filter((row) => row && PREPARED_DOCUMENT_KEYS.has(String(row.document_key || '')));
}

async function getPreparedDocumentRow(userId, country, key) {
  const normalizedCountry = normalizeDocumentCountry(country);
  const normalizedKey = sanitizeUserString(key, 120);
  if (!normalizedCountry || !normalizedKey || !userId || !isSupabaseDbConfigured()) return null;
  const result = await supabaseDbRequest(
    'user_documents',
    `select=*&user_id=eq.${encodeURIComponent(userId)}&country_code=eq.${encodeURIComponent(normalizedCountry)}&document_key=eq.${encodeURIComponent(normalizedKey)}&limit=1`
  );
  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return null;
  return result.data[0];
}

async function getPreparedDocumentsForUser(userId, _email, country) {
  const normalizedCountry = normalizeDocumentCountry(country);
  if (!normalizedCountry || !isSupabaseDbConfigured()) return { country: normalizedCountry, docs: {}, updatedAt: null };
  const rows = await listPreparedDocumentRows(userId, normalizedCountry);
  const docs = {};
  let updatedAt = null;
  for (const row of rows) {
    docs[row.document_key] = mapPreparedDocumentRow(row, buildPreparedDocumentDownloadUrl(normalizedCountry, row.document_key));
    if (row.updated_at && (!updatedAt || row.updated_at > updatedAt)) updatedAt = row.updated_at;
  }
  return {
    country: normalizedCountry,
    docs,
    updatedAt
  };
}

async function savePreparedDocumentForUser(userId, _email, payload) {
  if (!payload || !userId || !isSupabaseDbConfigured()) return null;
  const storagePath = buildPreparedDocumentStoragePath(userId, payload.country, payload.key);
  const uploaded = await supabaseStorageUploadObject(SUPABASE_DOCUMENT_BUCKET, storagePath, payload.fileDataUrl, payload.mimeType);
  if (!uploaded) return null;

  const result = await supabaseDbRequest(
    'user_documents',
    'on_conflict=user_id,document_key,country_code',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: [{
        user_id: userId,
        country_code: payload.country,
        document_key: payload.key,
        status: 'uploaded',
        file_name: payload.fileName,
        file_url: storagePath,
        updated_at: payload.updatedAt
      }]
    }
  );
  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return null;
  const row = result.data[0];
  return mapPreparedDocumentRow(row, buildPreparedDocumentDownloadUrl(payload.country, payload.key));
}

async function deletePreparedDocumentForUser(userId, _email, country, key) {
  const normalizedCountry = normalizeDocumentCountry(country);
  const normalizedKey = sanitizeUserString(key, 120);
  if (!normalizedCountry || !PREPARED_DOCUMENT_KEYS.has(normalizedKey) || !userId || !isSupabaseDbConfigured()) return false;
  const existing = await getPreparedDocumentRow(userId, normalizedCountry, normalizedKey);
  if (!existing) return true;
  const mapped = mapPreparedDocumentRow(existing);
  const deletedObject = mapped && mapped.storagePath
    ? await supabaseStorageDeleteObject(mapped.storageBucket || SUPABASE_DOCUMENT_BUCKET, mapped.storagePath)
    : true;
  const deletedRow = await supabaseDbRequest(
    'user_documents',
    `user_id=eq.${encodeURIComponent(userId)}&country_code=eq.${encodeURIComponent(normalizedCountry)}&document_key=eq.${encodeURIComponent(normalizedKey)}`,
    { method: 'DELETE' }
  );
  return deletedObject && deletedRow.ok;
}

async function listOnboardingDocumentRows(userId, country) {
  const normalizedCountry = normalizeDocumentCountry(country);
  if (!normalizedCountry || !userId || !isSupabaseDbConfigured()) return [];
  const result = await supabaseDbRequest(
    'user_documents',
    `select=*&user_id=eq.${encodeURIComponent(userId)}&country_code=eq.${encodeURIComponent(normalizedCountry)}`
  );
  if (!result.ok || !Array.isArray(result.data)) return [];
  return result.data.filter((row) => row && ONBOARDING_DOCUMENT_KEYS.has(String(row.document_key || '')));
}

async function getOnboardingDocumentRow(userId, country, key) {
  const normalizedCountry = normalizeDocumentCountry(country);
  const normalizedKey = sanitizeUserString(key, 120);
  if (!normalizedCountry || !normalizedKey || !userId || !isSupabaseDbConfigured()) return null;
  const result = await supabaseDbRequest(
    'user_documents',
    `select=*&user_id=eq.${encodeURIComponent(userId)}&country_code=eq.${encodeURIComponent(normalizedCountry)}&document_key=eq.${encodeURIComponent(normalizedKey)}&limit=1`
  );
  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return null;
  return result.data[0];
}

async function getOnboardingDocumentsForUser(userId, _email, country) {
  const normalizedCountry = normalizeDocumentCountry(country);
  if (!normalizedCountry || !isSupabaseDbConfigured()) return { country: normalizedCountry, docs: {}, updatedAt: null };
  const rows = await listOnboardingDocumentRows(userId, normalizedCountry);
  const docs = {};
  let updatedAt = null;
  for (const row of rows) {
    docs[row.document_key] = mapPreparedDocumentRow(row, buildOnboardingDocumentDownloadUrl(normalizedCountry, row.document_key));
    if (row.updated_at && (!updatedAt || row.updated_at > updatedAt)) updatedAt = row.updated_at;
  }
  return {
    country: normalizedCountry,
    docs,
    updatedAt
  };
}

async function saveOnboardingDocumentForUser(userId, _email, payload) {
  if (!payload || !userId || !isSupabaseDbConfigured()) return null;
  const storagePath = buildOnboardingDocumentStoragePath(userId, payload.country, payload.key);
  const uploaded = await supabaseStorageUploadObject(SUPABASE_DOCUMENT_BUCKET, storagePath, payload.fileDataUrl, payload.mimeType);
  if (!uploaded) return null;

  const result = await supabaseDbRequest(
    'user_documents',
    'on_conflict=user_id,document_key,country_code',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: [{
        user_id: userId,
        country_code: payload.country,
        document_key: payload.key,
        status: 'uploaded',
        file_name: payload.fileName,
        file_url: storagePath,
        updated_at: payload.updatedAt
      }]
    }
  );
  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return null;
  const row = result.data[0];
  return mapPreparedDocumentRow(row, buildOnboardingDocumentDownloadUrl(payload.country, payload.key));
}

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
    refreshTokens: {},
    users: {},
    userProfiles: {},
    userState: {},
    hybridAgentBridgeStore: null
  };
}

function loadDbState() {
  if (REQUIRE_SUPABASE_DB && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    return createEmptyState();
  }

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
      refreshTokens: parsed && parsed.refreshTokens && typeof parsed.refreshTokens === 'object' ? parsed.refreshTokens : {},
      users: parsed && parsed.users && typeof parsed.users === 'object' ? parsed.users : {},
      userProfiles: parsed && parsed.userProfiles && typeof parsed.userProfiles === 'object' ? parsed.userProfiles : {},
      userState: parsed && parsed.userState && typeof parsed.userState === 'object' ? parsed.userState : {},
      hybridAgentBridgeStore: parsed && parsed.hybridAgentBridgeStore && typeof parsed.hybridAgentBridgeStore === 'object'
        ? parsed.hybridAgentBridgeStore
        : null
    };
  } catch (err) {
    console.error('[DB] Failed to parse DB file. Starting with empty state.', err);
    return createEmptyState();
  }
}

let dbState = loadDbState();
let adminDashboardCache = {
  expiresAt: 0,
  data: null,
  inFlight: null
};
const AGENT_OUTPUT_ROOT = path.join(process.cwd(), 'agents-output');
const HYBRID_AGENT_RUNTIME_KV_KEY = 'hybrid_agent_bridge_store_v1';
const HYBRID_AGENT_BRIDGE_STALE_MS = Number(process.env.HYBRID_AGENT_BRIDGE_STALE_MS || 45 * 1000);
let hybridAgentControlState = {
  activeRunId: '',
  runs: {},
  providerStatusCache: {
    expiresAt: 0,
    refreshedAt: '',
    data: null,
    inFlight: null
  },
  bridgeStoreCache: {
    loadedAt: 0,
    data: null,
    inFlight: null
  },
};

function saveDbState() {
  if (REQUIRE_SUPABASE_DB && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    return;
  }
  const tmpPath = `${DB_FILE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(dbState, null, 2));
  fs.renameSync(tmpPath, DB_FILE_PATH);
}

// WARNING: In-memory only — resets on serverless cold start (Vercel).
// For production hardening, persist daily spend to Supabase (e.g. ai_spend_tracking table).
let anthropicDailySpend = { date: '', totalCostUsd: 0, callCount: 0 };

function checkAnthropicBudget() {
  const today = new Date().toISOString().slice(0, 10);
  if (anthropicDailySpend.date !== today) {
    anthropicDailySpend = { date: today, totalCostUsd: 0, callCount: 0 };
  }
  return anthropicDailySpend.totalCostUsd < ANTHROPIC_DAILY_LIMIT_USD;
}

function recordAnthropicSpend(inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
  const today = new Date().toISOString().slice(0, 10);
  if (anthropicDailySpend.date !== today) {
    anthropicDailySpend = { date: today, totalCostUsd: 0, callCount: 0 };
  }
  // Claude Sonnet pricing: $3/M input, $15/M output; cached input $0.30/M; images ~$0.01 each (compressed)
  const cost = (inputTokens / 1000000) * 3 + (outputTokens / 1000000) * 15 + (cacheReadTokens / 1000000) * 0.30 + (cacheWriteTokens / 1000000) * 3.75 + 0.01;
  anthropicDailySpend.totalCostUsd += cost;
  anthropicDailySpend.callCount++;
}

// Per-user rate limiting for AI verification: max 10 calls per user per day
// WARNING: In-memory only — resets on serverless cold start.
const aiVerifyUserCalls = new Map(); // email -> { date, count }
const AI_VERIFY_MAX_PER_USER = 10;
const AI_VERIFY_UNLIMITED_EMAILS = new Set(
  String(process.env.AI_VERIFY_UNLIMITED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
);

function checkUserAiLimit(email) {
  if (AI_VERIFY_UNLIMITED_EMAILS.has((email || '').toLowerCase())) return true;
  const today = new Date().toISOString().slice(0, 10);
  const entry = aiVerifyUserCalls.get(email);
  if (!entry || entry.date !== today) {
    aiVerifyUserCalls.set(email, { date: today, count: 0 });
    return true;
  }
  return entry.count < AI_VERIFY_MAX_PER_USER;
}

function recordUserAiCall(email) {
  const today = new Date().toISOString().slice(0, 10);
  const entry = aiVerifyUserCalls.get(email);
  if (!entry || entry.date !== today) {
    aiVerifyUserCalls.set(email, { date: today, count: 1 });
  } else {
    entry.count++;
  }
}

/** Detect actual MIME type from base64 magic bytes (browser file.type can be wrong) */
function detectMimeFromBase64(base64, fallback) {
  if (typeof base64 !== 'string' || base64.length < 8) return fallback || 'image/jpeg';
  const h = base64.slice(0, 16).toUpperCase();
  if (h.startsWith('/9J/') || h.startsWith('/9J')) return 'image/jpeg';
  if (h.startsWith('IVBOR')) return 'image/png';
  if (h.startsWith('UESDB')) return 'image/webp'; // RIFF header
  if (h.startsWith('R0LGOD')) return 'image/gif';
  if (h.startsWith('UKLGR')) return 'image/webp';
  return fallback || 'image/jpeg';
}

function stripBase64DataUrlPrefix(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:[^;]+;base64,(.+)$/);
  return match ? match[1] : raw;
}

function normalizeImageMimeType(value) {
  return String(value || '').trim().toLowerCase().replace(/^image\/jpg$/, 'image/jpeg');
}

function isClaudeSafeImageMimeType(value) {
  const mimeType = normalizeImageMimeType(value);
  return mimeType === 'image/jpeg' || mimeType === 'image/png' || mimeType === 'image/webp' || mimeType === 'image/gif';
}

async function invokeSupabaseEdgeFunction(functionName, payload) {
  if (!isSupabaseDbConfigured()) {
    return { ok: false, message: 'Supabase configuration is required for image normalization.' };
  }

  const response = await fetch(`${SUPABASE_URL}/functions/v1/${encodeURIComponent(functionName)}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload || {})
  }).catch((err) => {
    console.error('[Supabase Function] Request failed:', err && err.message ? err.message : err);
    return null;
  });

  if (!response) {
    return { ok: false, message: 'Failed to reach Supabase image normalization service.' };
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: data && typeof data.message === 'string'
        ? data.message
        : `Supabase image normalization failed with status ${response.status}.`
    };
  }

  return { ok: true, data };
}

async function normalizeImageForAi(base64, mimeType) {
  const rawBase64 = stripBase64DataUrlPrefix(base64);
  if (!rawBase64) {
    return { ok: false, message: 'Missing image data.' };
  }

  const fallbackMimeType = normalizeImageMimeType(mimeType || 'image/jpeg');
  const detectedMimeType = normalizeImageMimeType(detectMimeFromBase64(rawBase64, fallbackMimeType));
  if (isClaudeSafeImageMimeType(detectedMimeType)) {
    // Compress large images to reduce token cost (>500KB base64 ≈ >375KB file)
    const estimatedBytes = rawBase64.length * 0.75;
    if (estimatedBytes > 400000) {
      const compressed = await invokeSupabaseEdgeFunction(SUPABASE_SCAN_NORMALIZER_FUNCTION, {
        imageBase64: rawBase64,
        mimeType: detectedMimeType,
        quality: 72,
        maxDimension: 1200
      });
      if (compressed.ok && compressed.data && typeof compressed.data.normalizedBase64 === 'string') {
        const compBase64 = stripBase64DataUrlPrefix(compressed.data.normalizedBase64);
        const compMime = normalizeImageMimeType(detectMimeFromBase64(compBase64, detectedMimeType));
        if (isClaudeSafeImageMimeType(compMime)) {
          return { ok: true, base64: compBase64, mediaType: compMime, normalized: true };
        }
      }
      // Compression failed — fall through with original (still Claude-safe)
    }
    return {
      ok: true,
      base64: rawBase64,
      mediaType: detectedMimeType,
      normalized: false
    };
  }

  if (!fallbackMimeType.startsWith('image/')) {
    return { ok: false, message: 'Unsupported image type.' };
  }

  const result = await invokeSupabaseEdgeFunction(SUPABASE_SCAN_NORMALIZER_FUNCTION, {
    imageBase64: rawBase64,
    mimeType: fallbackMimeType,
    quality: 82
  });
  if (!result.ok || !result.data || typeof result.data.normalizedBase64 !== 'string') {
    return {
      ok: false,
      message: result.message || 'Failed to normalize image for AI scan.'
    };
  }

  const normalizedBase64 = stripBase64DataUrlPrefix(result.data.normalizedBase64);
  const normalizedMimeType = normalizeImageMimeType(
    detectMimeFromBase64(normalizedBase64, result.data.mimeType || 'image/jpeg')
  );
  if (!isClaudeSafeImageMimeType(normalizedMimeType)) {
    return { ok: false, message: 'Image normalization produced an unsupported format.' };
  }

  return {
    ok: true,
    base64: normalizedBase64,
    mediaType: normalizedMimeType,
    normalized: true
  };
}

/** Strip SQL injection patterns and dangerous characters from user-provided strings */
function sanitizeUserString(str, maxLen) {
  if (typeof str !== 'string') return '';
  let s = str.trim();
  if (maxLen) s = s.slice(0, maxLen);
  // Remove null bytes
  s = s.replace(/\0/g, '');
  // Strip SQL keywords/patterns that should never appear in filenames or user text
  s = s.replace(/(\b(DROP|DELETE|INSERT|UPDATE|ALTER|EXEC|EXECUTE|UNION|SELECT)\b\s+(TABLE|FROM|INTO|SET|ALL|DATABASE))/gi, '');
  s = s.replace(/;\s*--/g, '');
  s = s.replace(/--/g, '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  s = s.replace(/[';]/g, '');
  return s;
}

const NAME_NOISE_PARTS = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'mx', 'sir', 'prof', 'professor', 'md', 'mbbs', 'mbchb', 'phd']);

function normalizeNameParts(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/['’]/g, '')
    .replace(/-/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((part) => !NAME_NOISE_PARTS.has(part));
}

function getFullNameFromProfileLike(source) {
  const profile = source && typeof source === 'object' ? source : {};
  if (typeof profile.full_name === 'string' && profile.full_name.trim()) return profile.full_name.trim();
  if (typeof profile.name === 'string' && profile.name.trim()) return profile.name.trim();
  const first = String(profile.firstName || profile.first_name || '').trim();
  const last = String(profile.lastName || profile.last_name || '').trim();
  return `${first} ${last}`.trim();
}

function hasUsableFullName(name) {
  return normalizeNameParts(name).length >= 2;
}

function middleNamesCompatible(partsA, partsB) {
  if (!partsA.length || !partsB.length) return true;
  const shorter = partsA.length <= partsB.length ? partsA : partsB;
  const longer = partsA.length <= partsB.length ? partsB : partsA;
  let longIdx = 0;
  for (const part of shorter) {
    let matched = false;
    while (longIdx < longer.length) {
      const candidate = longer[longIdx++];
      if (!candidate) continue;
      if (part === candidate || part.charAt(0) === candidate.charAt(0)) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

function matchNames(docName, profileName) {
  const docParts = normalizeNameParts(docName);
  const profileParts = normalizeNameParts(profileName);
  if (docParts.length < 2 || profileParts.length < 2) return 'unknown';
  if (docParts.join(' ') === profileParts.join(' ')) return 'exact';
  const docFirst = docParts[0];
  const docLast = docParts[docParts.length - 1];
  const profFirst = profileParts[0];
  const profLast = profileParts[profileParts.length - 1];
  if (docFirst !== profFirst || docLast !== profLast) return 'mismatch';
  const docMiddle = docParts.slice(1, -1);
  const profileMiddle = profileParts.slice(1, -1);
  return middleNamesCompatible(docMiddle, profileMiddle) ? 'fuzzy' : 'mismatch';
}

function isConfirmedNameMatch(match) {
  return match === 'exact' || match === 'fuzzy';
}

function pushVerificationIssue(verification, message) {
  const clean = sanitizeUserString(message, 400);
  if (!clean) return;
  verification.issues = Array.isArray(verification.issues) ? verification.issues : [];
  if (!verification.issues.includes(clean)) verification.issues.push(clean);
}

async function resolveVerificationProfileName(session, suppliedProfileName) {
  const directName = sanitizeUserString(suppliedProfileName, 200);
  if (hasUsableFullName(directName)) return directName;

  const sessionName = sanitizeUserString(getFullNameFromProfileLike(session && session.userProfile), 200);
  if (hasUsableFullName(sessionName)) return sessionName;

  const email = getSessionEmail(session);
  if (!email) return '';

  if (isSupabaseDbConfigured()) {
    try {
      const remoteProfile = await getSupabaseUserProfile(email, getSessionSupabaseUserId(session));
      const remoteName = sanitizeUserString(getFullNameFromProfileLike(remoteProfile), 200);
      if (hasUsableFullName(remoteName)) return remoteName;
    } catch (err) {
      /* non-critical — fall through to local fallback */
    }
  }

  const fallbackProfile = buildFallbackApiProfile(email, session && session.userProfile);
  const fallbackName = sanitizeUserString(getFullNameFromProfileLike(fallbackProfile), 200);
  return hasUsableFullName(fallbackName) ? fallbackName : '';
}

function applyQualificationNameMatchPolicy(verification, profileName, verifiedNames) {
  const normalizedProfileName = hasUsableFullName(profileName) ? profileName : '';
  const normalizedVerifiedNames = Array.isArray(verifiedNames)
    ? verifiedNames.filter((name) => hasUsableFullName(name))
    : [];

  const nameCheck = crossCheckDocumentName(
    verification && verification.nameFound,
    normalizedProfileName,
    normalizedVerifiedNames
  );

  verification.nameMatch = nameCheck.match;
  verification.nameMatchedAgainst = nameCheck.matchedAgainst;

  if (!normalizedProfileName && verification && verification.verified) {
    verification.verified = false;
    pushVerificationIssue(
      verification,
      'We could not compare the name on this document because your account does not have a full first and last name yet. Please update your account name and try again.'
    );
    return;
  }

  if (nameCheck.match === 'mismatch') {
    verification.verified = false;
    pushVerificationIssue(
      verification,
      'The name on this document does not match your account name. Please upload a document with the name matching your profile.'
    );
    return;
  }

  if (normalizedProfileName && !isConfirmedNameMatch(nameCheck.match)) {
    verification.verified = false;
    pushVerificationIssue(
      verification,
      'We could not confidently match the full name on this document to your account. Please upload a clearer document showing the full name.'
    );
  }
}

/**
 * Extract names from previously verified documents in a user's onboarding state.
 * Returns an array of non-empty name strings found on verified/verified_name_pending docs.
 */
function getVerifiedDocumentNames(onboardingState) {
  if (!onboardingState || typeof onboardingState !== 'object') return [];
  const qualDocs = onboardingState.qualDocs;
  if (!qualDocs || typeof qualDocs !== 'object') return [];
  const names = [];
  for (const key of Object.keys(qualDocs)) {
    const doc = qualDocs[key];
    if (!doc || typeof doc !== 'object') continue;
    const status = doc.status;
    if (status !== 'verified' && status !== 'verified_name_pending') continue;
    const name = doc.scanResult && doc.scanResult.nameFound;
    if (typeof name === 'string' && name.trim().length > 0) {
      names.push(name.trim());
    }
  }
  return names;
}

/**
 * Check a document name against profile name AND previously verified document names.
 * Returns { match: 'exact'|'fuzzy'|'mismatch'|'unknown', matchedAgainst: string|null }
 */
function crossCheckDocumentName(docName, profileName, verifiedNames) {
  if (!docName) return { match: 'unknown', matchedAgainst: null };

  // Check against profile name first
  if (profileName) {
    const profileMatch = matchNames(docName, profileName);
    if (profileMatch === 'mismatch') return { match: 'mismatch', matchedAgainst: 'profile' };
    if (profileMatch !== 'unknown') return { match: profileMatch, matchedAgainst: 'profile' };
  }

  // Check against previously verified document names
  for (const prevName of (verifiedNames || [])) {
    const docMatch = matchNames(docName, prevName);
    if (docMatch !== 'mismatch') {
      return { match: docMatch, matchedAgainst: 'previous_document' };
    }
  }

  // Nothing matched
  if (!profileName && (!verifiedNames || verifiedNames.length === 0)) {
    return { match: 'unknown', matchedAgainst: null };
  }
  return { match: 'mismatch', matchedAgainst: null };
}

const CSP_SUPABASE_ORIGIN = SUPABASE_URL ? new URL(SUPABASE_URL).origin : '';
const GOOGLE_MAPS_CSP_SCRIPT_SOURCES = " https://*.googleapis.com https://*.gstatic.com *.google.com https://*.ggpht.com *.googleusercontent.com blob: 'unsafe-eval'";
const GOOGLE_MAPS_CSP_CONNECT_SOURCES = " https://*.googleapis.com *.google.com https://*.gstatic.com data: blob:";
const GOOGLE_MAPS_CSP_IMAGE_SOURCES = ' https://*.googleapis.com https://*.gstatic.com *.google.com *.googleusercontent.com data:';
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net${CSP_SUPABASE_ORIGIN ? ' ' + CSP_SUPABASE_ORIGIN : ''}${GOOGLE_MAPS_CSP_SCRIPT_SOURCES}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    `img-src 'self' data: blob:${CSP_SUPABASE_ORIGIN ? ' ' + CSP_SUPABASE_ORIGIN : ''}${GOOGLE_MAPS_CSP_IMAGE_SOURCES} https://upload.wikimedia.org https://commons.wikimedia.org https://*.wikimedia.org`,
    `connect-src 'self'${CSP_SUPABASE_ORIGIN ? ' ' + CSP_SUPABASE_ORIGIN : ''}${GOOGLE_MAPS_CSP_CONNECT_SOURCES}`,
    "media-src 'self' blob:",
    "frame-src 'self' *.google.com",
    "worker-src blob:",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; '),
  'X-Permitted-Cross-Domain-Policies': 'none'
};

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...(NODE_ENV === 'production' ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload' } : {}),
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
    if (key) {
      try {
        acc[key] = decodeURIComponent(val);
      } catch (err) {
        // Skip malformed cookie values
      }
    }
    return acc;
  }, {});
}

function getRequestHostname(req) {
  const host = String(req.headers.host || '').trim().toLowerCase();
  if (!host) return '';
  return host.split(':')[0];
}

function getHostFromHeaderValue(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value);
    return parsed.hostname.trim().toLowerCase();
  } catch (err) {
    return '';
  }
}

function isTrustedSameOriginRequest(req) {
  const requestHost = getRequestHostname(req);
  if (!requestHost) return false;

  const originHost = getHostFromHeaderValue(req.headers.origin);
  if (originHost) return originHost === requestHost;

  const refererHost = getHostFromHeaderValue(req.headers.referer);
  if (refererHost) return refererHost === requestHost;

  return NODE_ENV !== 'production';
}

function isMutationMethod(method) {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function enforceMutationOrigin(req, res) {
  if (!ENFORCE_SAME_ORIGIN || !isMutationMethod(req.method)) return true;
  if (isTrustedSameOriginRequest(req)) return true;
  sendJson(res, 403, { ok: false, message: 'Blocked by same-origin policy.' });
  return false;
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function normalizeAdminRole(value) {
  const role = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  if (role === 'staff' || role === 'admin' || role === 'super_admin') return role;
  return '';
}

function hasAdminPortalAccess(role) {
  return normalizeAdminRole(role) !== '';
}

function isSuperAdminRole(role) {
  return normalizeAdminRole(role) === 'super_admin';
}

function getAdminRoleLabel(role) {
  const normalized = normalizeAdminRole(role);
  if (normalized === 'super_admin') return 'Super Admin';
  if (normalized === 'staff') return 'Staff Admin';
  if (normalized === 'admin') return 'Admin';
  return 'Admin';
}

function getConfiguredAdminRoleForEmail(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return '';
  if (SUPER_ADMIN_EMAILS.has(normalizedEmail)) return 'super_admin';
  if (ADMIN_EMAILS.has(normalizedEmail)) return 'admin';
  return '';
}

function getAdminHostScope(req) {
  const hostname = getRequestHostname(req);
  if (!hostname) return '';
  if (SUPER_ADMIN_ALLOWED_HOSTS.has(hostname)) return 'super_admin';
  if (ADMIN_ALLOWED_HOSTS.has(hostname)) return 'admin';
  if (NODE_ENV !== 'production' && isLoopbackHostname(hostname)) return 'local';
  return '';
}

function getAdminHostLabel(scope) {
  if (scope === 'super_admin') return 'CEO / Super Admin';
  if (scope === 'admin') return 'Employee Admin';
  if (scope === 'local') return 'Local Admin';
  return 'Admin';
}

function doesAdminRoleMatchHost(role, hostScope) {
  const normalizedRole = normalizeAdminRole(role);
  if (!normalizedRole) return false;
  if (hostScope === 'super_admin') return normalizedRole === 'super_admin';
  return hostScope === 'admin' || hostScope === 'local';
}

function getAdminRoleFromSession(session) {
  const storedRole = normalizeAdminRole(session && session.userProfile && session.userProfile.adminRole);
  if (storedRole) return storedRole;
  return getConfiguredAdminRoleForEmail(getSessionEmail(session));
}

function isAllowedAdminHost(req) {
  return !!getAdminHostScope(req);
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

// ---------------------------------------------------------------------------
// OAuth 2.0 access & refresh token helpers
// ---------------------------------------------------------------------------
function createOAuthAccessToken(userProfile) {
  const expiresAt = now() + OAUTH_ACCESS_TTL_MS;
  const payload = base64UrlEncode(JSON.stringify({ sub: userProfile.email, profile: userProfile, expiresAt, type: 'access' }));
  const signature = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return { token: `${payload}.${signature}`, expiresAt, expiresIn: Math.floor(OAUTH_ACCESS_TTL_MS / 1000) };
}

function parseOAuthAccessToken(token) {
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
    if (parsed.type !== 'access') return null;
    if (typeof parsed.expiresAt !== 'number') return null;
    if (parsed.expiresAt <= now()) return { expired: true, profile: parsed.profile };
    return { expired: false, profile: parsed.profile };
  } catch {
    return null;
  }
}

function createOAuthRefreshToken(email) {
  const tokenValue = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(tokenValue).digest('hex');
  dbState.refreshTokens[tokenHash] = {
    email: String(email).trim().toLowerCase(),
    createdAt: now(),
    expiresAt: now() + OAUTH_REFRESH_TTL_MS,
  };
  saveDbState();
  return tokenValue;
}

function consumeOAuthRefreshToken(tokenValue) {
  const tokenHash = crypto.createHash('sha256').update(String(tokenValue || '')).digest('hex');
  const entry = dbState.refreshTokens[tokenHash];
  if (!entry) return null;
  // Always delete the token (single-use rotation)
  delete dbState.refreshTokens[tokenHash];
  saveDbState();
  if (entry.expiresAt <= now()) return null;
  return entry;
}

function revokeOAuthRefreshToken(tokenValue) {
  const tokenHash = crypto.createHash('sha256').update(String(tokenValue || '')).digest('hex');
  delete dbState.refreshTokens[tokenHash];
  saveDbState();
}

function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
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

/**
 * Read raw body bytes — preserves bytes for HMAC-SHA256 webhook verification.
 * Unlike readJsonBody, this does NOT parse; caller must parse manually.
 */
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const limit = maxBytes || MAX_JSON_BODY_BYTES;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Normalise a phone number to E.164 format (best-effort).
 * Assumes Australian (+61) local numbers if no country code prefix is present.
 */
function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  // Australian local format: 04xxxxxxxx → +614xxxxxxxx
  if (digits.startsWith('0') && digits.length === 10) return '+61' + digits.slice(1);
  if (digits.length >= 10 && digits.length <= 15) return '+' + digits;
  return digits;
}

/**
 * Verify a DoubleTick HMAC-SHA256 webhook signature using timing-safe comparison.
 * Returns false (not an exception) so callers can log + reject with 401.
 */
function validateDoubleTickSignature(rawBody, signatureHeader) {
  if (!DOUBLETICK_WEBHOOK_SECRET) return false;
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  try {
    const expected = crypto
      .createHmac('sha256', DOUBLETICK_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');
    // Header may arrive as "sha256=<hex>" or bare hex
    const incoming = signatureHeader.replace(/^sha256=/, '');
    const incomingBuf = Buffer.from(incoming, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    // Lengths must match before timingSafeEqual to avoid a TypeError
    if (incomingBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(incomingBuf, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Validate and sanitize fields from a DoubleTick webhook payload.
 * Returns a sanitized object or null if required fields are missing/invalid.
 *
 * Security controls applied here:
 *   - message_body capped at DOUBLETICK_MESSAGE_BODY_MAX_LEN (4096)
 *   - from_phone stripped of non-numeric characters
 *   - conversation_url allow-listed to https://app.doubletick.io/ origin
 *   - message_id restricted to alphanumeric + dash/underscore (idempotency key)
 */
function sanitizeDoubleTickPayload(body) {
  if (!body || typeof body !== 'object') return null;
  const messageBody = typeof body.message_body === 'string'
    ? body.message_body.slice(0, DOUBLETICK_MESSAGE_BODY_MAX_LEN)
    : null;
  const fromPhone = typeof body.from_phone === 'string'
    ? body.from_phone.replace(/[^\d+\-() ]/g, '').slice(0, 30)
    : null;
  // Allow-list: conversation URL must start with the DoubleTick app origin
  const rawUrl = typeof body.conversation_url === 'string' ? body.conversation_url.trim() : '';
  const conversationUrl = rawUrl.startsWith(DOUBLETICK_CONVERSATION_URL_PREFIX) ? rawUrl : null;
  // Idempotency key: alphanumeric, dash, underscore only
  const messageId = typeof body.message_id === 'string'
    ? body.message_id.replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 128)
    : null;

  if (!fromPhone || !messageBody) return null;
  return { messageBody, fromPhone, conversationUrl, messageId };
}

/**
 * POST /api/webhooks/doubletick
 * Handles inbound DoubleTick WhatsApp message webhooks.
 *
 * IMPORTANT: Register this handler in the main request router BEFORE
 * same-origin enforcement (ENFORCE_SAME_ORIGIN) because DoubleTick delivers
 * from an external origin. Example registration (place before same-origin block):
 *
 *   if (method === 'POST' && pathname === '/api/webhooks/doubletick') {
 *     return handleDoubleTickWebhook(req, res);
 *   }
 *
 * Disabled (returns 503) when DOUBLETICK_WEBHOOK_SECRET is not configured.
 *
 * Auth: DoubleTick does not provide HMAC signing. Instead, append the secret
 * as a query parameter in the webhook URL registered in DoubleTick:
 *   https://app.mygplink.com.au/api/webhooks/doubletick?secret=YOUR_SECRET
 */
async function handleDoubleTickWebhook(req, res) {
  if (!DOUBLETICK_WEBHOOK_SECRET) {
    console.warn('[doubletick-webhook] DOUBLETICK_WEBHOOK_SECRET not set — webhook disabled');
    sendJson(res, 503, { ok: false, message: 'Webhook not configured' });
    return;
  }

  // Verify shared secret from URL query parameter (timing-safe comparison)
  const reqUrl = new URL(req.url, 'http://localhost');
  const providedSecret = reqUrl.searchParams.get('secret') || '';
  const secretBuf = Buffer.from(DOUBLETICK_WEBHOOK_SECRET);
  const providedBuf = Buffer.from(providedSecret);
  if (secretBuf.length !== providedBuf.length || !crypto.timingSafeEqual(secretBuf, providedBuf)) {
    console.warn('[doubletick-webhook] Invalid secret from IP:', getClientIp(req));
    sendJson(res, 401, { ok: false, message: 'Unauthorized' });
    return;
  }

  // Rate-limit by source IP (60 req/min) — prevents flood from a compromised account
  const ip = getClientIp(req);
  const allowed = await checkRateLimitWindow(
    `doubletick_webhook:${ip}`,
    DOUBLETICK_WEBHOOK_RATE_MAX,
    DOUBLETICK_WEBHOOK_RATE_WINDOW_MS
  );
  if (!allowed) {
    sendJson(res, 429, { ok: false, message: 'Too many requests' });
    return;
  }

  // Parse JSON body
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { ok: false, message: 'Invalid JSON' });
    return;
  }

  // Validate and sanitize all fields; reject on missing required fields
  const payload = sanitizeDoubleTickPayload(body);
  if (!payload) {
    sendJson(res, 400, { ok: false, message: 'Missing required fields: from_phone, message_body' });
    return;
  }

  const { messageBody, fromPhone, conversationUrl, messageId } = payload;

  // Only act on inbound help-request messages; ack and skip everything else
  const HELP_PATTERNS = [/\bhelp\b/i, /\bneed help\b/i, /\bassist\b/i, /\bsupport\b/i, /\bstuck\b/i, /\bproblem\b/i];
  if (!HELP_PATTERNS.some((p) => p.test(messageBody))) {
    sendJson(res, 200, { ok: true, action: 'ignored' });
    return;
  }

  try {
    // Idempotency: skip if we've already handled this exact message
    if (messageId && isSupabaseDbConfigured()) {
      const existing = await supabaseDbRequest(
        'registration_tasks',
        'select=id&doubletick_message_id=eq.' + encodeURIComponent(messageId) + '&limit=1'
      );
      if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
        sendJson(res, 200, { ok: true, action: 'duplicate_ignored' });
        return;
      }
    }

    // Resolve GP by phone (try E.164 normalised and raw formats)
    const normalizedPhone = normalizePhone(fromPhone);
    let gpProfile = null;
    if (isSupabaseDbConfigured()) {
      for (const pv of [...new Set([normalizedPhone, fromPhone].filter(Boolean))]) {
        for (const col of ['phone_number', 'phone']) {
          const r = await supabaseDbRequest(
            'user_profiles',
            'select=user_id,first_name,last_name,email,phone_number,phone&' + col + '=eq.' + encodeURIComponent(pv) + '&limit=1'
          );
          if (r.ok && Array.isArray(r.data) && r.data.length > 0) { gpProfile = r.data[0]; break; }
        }
        if (gpProfile) break;
      }
    }

    // Find the most recent active registration case for this GP
    let activeCase = null;
    if (gpProfile && isSupabaseDbConfigured()) {
      const cr = await supabaseDbRequest(
        'registration_cases',
        'select=id,stage,substage,user_id&user_id=eq.' + encodeURIComponent(gpProfile.user_id) + '&status=not.eq.closed&order=created_at.desc&limit=1'
      );
      if (cr.ok && Array.isArray(cr.data) && cr.data.length > 0) activeCase = cr.data[0];
    }

    if (!activeCase) {
      console.warn('[doubletick-webhook] No active case for phone:', fromPhone);
      sendJson(res, 200, { ok: true, action: 'no_active_case' });
      return;
    }

    const gpName = gpProfile
      ? [(gpProfile.first_name || ''), (gpProfile.last_name || '')].join(' ').trim()
      : '';

    // Stage label map for human-readable VA task titles (DoubleTick webhook help tasks)
    const _dtStageLabel = ({ myintealth: 'MyIntealth', amc: 'AMC', career: 'Career', ahpra: 'AHPRA', visa: 'Visa', pbs: 'PBS', commencement: 'Commencement' })[activeCase.stage] || (activeCase.stage || 'Registration');
    const taskPayload = {
      case_id: activeCase.id,
      task_type: 'whatsapp_help',
      title: 'GP requested WhatsApp help — ' + _dtStageLabel,
      description: messageBody.slice(0, 500),
      priority: 'high',
      status: 'open',
      source_trigger: 'doubletick_webhook',
      related_stage: activeCase.stage || '',
      doubletick_conversation_url: conversationUrl || null,
      doubletick_message_id: messageId || null
    };

    if (isSupabaseDbConfigured()) {
      const tRes = await supabaseDbRequest(
        'registration_tasks',
        '',
        { method: 'POST', headers: { Prefer: 'return=representation' }, body: [taskPayload] }
      );
      if (!tRes.ok) {
        // Internal error — do not expose details to webhook caller
        console.error('[doubletick-webhook] Failed to create task');
        sendJson(res, 500, { ok: false, message: 'Internal error' });
        return;
      }
    }

    sendJson(res, 200, { ok: true, action: 'task_created' });
  } catch (err) {
    // Never expose stack traces or internal details to the webhook caller
    console.error('[doubletick-webhook] Unexpected error:', err && err.message);
    sendJson(res, 500, { ok: false, message: 'Internal error' });
  }
}

const QUAL_SCAN_OPTIONS = [
  { key: 'primary_medical_degree', label: 'Primary medical degree', patterns: [/primary medical degree/i, /\bmbbs\b/i, /\bmbchb\b/i, /\bmb bch bao\b/i, /\bmd\b/i, /\bbmed\b/i, /medical degree/i] },
  { key: 'mrcgp_certified', label: 'MRCGP certificate', patterns: [/\bmrcgp\b/i, /member of the royal college of general practitioners/i] },
  { key: 'cct_certified', label: 'CCT certificate', patterns: [/\bcct\b/i, /certificate of completion of training/i, /\bpmetb\b/i] },
  { key: 'micgp_certified', label: 'MICGP certificate', patterns: [/\bmicgp\b/i, /member.*irish college of general practitioners/i] },
  { key: 'cscst_certified', label: 'CSCST certificate', patterns: [/\bcscst\b/i, /certificate of satisfactory completion of specialist training/i] },
  { key: 'icgp_confirmation_letter', label: 'ICGP Confirmation Letter', patterns: [/\bicgp\b.*confirm/i, /irish college.*confirm/i] },
  { key: 'frnzcgp_certified', label: 'FRNZCGP certificate', patterns: [/\bfrnzcgp\b/i, /fellow.*royal new zealand college/i] },
  { key: 'rnzcgp_confirmation_letter', label: 'RNZCGP Confirmation Letter', patterns: [/\brnzcgp\b.*confirm/i, /new zealand college.*confirm/i] },
  { key: 'cv_signed_dated', label: 'Signed CV', patterns: [/\bcurriculum vitae\b/i, /\bcv\b/i, /resume/i, /signed and dated/i] },
  { key: 'certificate_good_standing', label: 'Certificate of good standing', patterns: [/good standing/i, /certificate of standing/i, /registration status/i] },
  { key: 'confirmation_training', label: 'Confirmation of training', patterns: [/confirmation of training/i, /training completion/i, /specialist training/i] },
  { key: 'criminal_history', label: 'Criminal history check', patterns: [/criminal history/i, /police clearance/i, /background check/i, /dbs check/i, /fit2work/i] }
];

function heuristicQualificationClassification(fileName, snippet) {
  const text = `${String(fileName || '')}\n${String(snippet || '')}`.slice(0, 16000);
  let best = null;
  for (const option of QUAL_SCAN_OPTIONS) {
    let score = 0;
    option.patterns.forEach((pattern) => {
      if (pattern.test(text)) score += 1;
    });
    if (!best || score > best.score) {
      best = { option, score };
    }
  }

  if (!best || best.score <= 0) {
    return {
      key: 'primary_medical_degree',
      label: 'Primary medical degree',
      confidence: 0.35,
      reason: 'No exact qualification keywords found. Defaulting to Primary medical degree.'
    };
  }

  const confidence = Math.min(0.96, 0.45 + (best.score * 0.16));
  return {
    key: best.option.key,
    label: best.option.label,
    confidence,
    reason: 'Matched qualification keywords in file name/content.'
  };
}

async function classifyQualificationWithAI(fileName, textSnippet) {
  const prompt = [
    'Classify this doctor qualification document into exactly one key.',
    'Valid keys: primary_medical_degree, mrcgp_certified, cct_certified, micgp_certified, cscst_certified, icgp_confirmation_letter, frnzcgp_certified, rnzcgp_confirmation_letter, cv_signed_dated, certificate_good_standing, confirmation_training, criminal_history.',
    'Return strict JSON with: key, confidence (0..1), reason.',
    `file_name: ${String(fileName || '').slice(0, 260)}`,
    `text_snippet: ${String(textSnippet || '').slice(0, 7000)}`
  ].join('\n');

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_SCAN_MODEL,
      input: prompt,
      max_output_tokens: 180,
      temperature: 0
    })
  });

  if (!response.ok) {
    throw new Error('AI model request failed');
  }
  const payload = await response.json();
  const text = payload && typeof payload.output_text === 'string'
    ? payload.output_text
    : '';
  if (!text) throw new Error('AI model returned empty output');

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) parsed = JSON.parse(objMatch[0]);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('AI response JSON invalid');

  const selectedKey = String(parsed.key || '').trim();
  const valid = QUAL_SCAN_OPTIONS.find((item) => item.key === selectedKey);
  if (!valid) throw new Error('AI selected unsupported key');

  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence || 0.7)));
  const reason = String(parsed.reason || 'Classified by AI model').slice(0, 220);
  return { key: valid.key, label: valid.label, confidence, reason };
}

async function classifyQualificationDocument(fileName, textSnippet) {
  if (OPENAI_API_KEY) {
    try {
      return await classifyQualificationWithAI(fileName, textSnippet);
    } catch (err) {
      // Fall back to deterministic keyword classifier.
    }
  }
  return heuristicQualificationClassification(fileName, textSnippet);
}

function joinDialPhone(countryDial, phoneNumber) {
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
  if (method === 'sms') return `sms:${joinDialPhone(countryDial, phoneNumber)}`;
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

async function checkRateLimit(rateKey) {
  const ts = now();
  if (isSupabaseDbConfigured()) {
    const runtimeKey = `ratelimit:${rateKey}`;
    const existing = await getRuntimeKv(runtimeKey);
    const current = existing && existing.value && typeof existing.value === 'object'
      ? existing.value
      : null;
    if (!current || ts - Number(current.windowStart || 0) > RATE_WINDOW_MS) {
      await setRuntimeKv(runtimeKey, { windowStart: ts, count: 1 }, ts + RATE_WINDOW_MS + 60 * 1000);
      return true;
    }
    if (Number(current.count || 0) >= RATE_MAX_SEND) return false;
    await setRuntimeKv(runtimeKey, { windowStart: Number(current.windowStart || ts), count: Number(current.count || 0) + 1 }, Number(current.windowStart || ts) + RATE_WINDOW_MS + 60 * 1000);
    return true;
  }

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

async function checkRateLimitWindow(rateKey, maxCount, windowMs) {
  const ts = now();
  if (isSupabaseDbConfigured()) {
    const runtimeKey = `authratelimit:${rateKey}`;
    const existing = await getRuntimeKv(runtimeKey);
    const current = existing && existing.value && typeof existing.value === 'object'
      ? existing.value
      : null;
    if (!current || ts - Number(current.windowStart || 0) > windowMs) {
      await setRuntimeKv(runtimeKey, { windowStart: ts, count: 1 }, ts + windowMs + 60 * 1000);
      return true;
    }
    if (Number(current.count || 0) >= maxCount) return false;
    await setRuntimeKv(runtimeKey, { windowStart: Number(current.windowStart || ts), count: Number(current.count || 0) + 1 }, Number(current.windowStart || ts) + windowMs + 60 * 1000);
    return true;
  }

  const current = dbState.rateLimits[rateKey];
  if (!current || ts - current.windowStart > windowMs) {
    dbState.rateLimits[rateKey] = { windowStart: ts, count: 1 };
    saveDbState();
    return true;
  }
  if (current.count >= maxCount) return false;
  current.count += 1;
  dbState.rateLimits[rateKey] = current;
  saveDbState();
  return true;
}

async function enforceAuthRateLimit(req, res, scope) {
  const key = `auth:${scope}:${getClientIp(req)}`;
  const allowed = await checkRateLimitWindow(key, AUTH_RATE_MAX_ATTEMPTS, AUTH_RATE_WINDOW_MS);
  if (allowed) return true;
  sendJson(res, 429, { ok: false, message: 'Too many authentication attempts. Please try again later.' });
  return false;
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
    pathname === '/pages/support-cases.html' ||
    pathname.startsWith('/registration/')
  );
}

function mapRegistrationPath(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  if (parts.length < 3 || parts[0] !== 'registration') return null;

  const step = parts[1].toLowerCase();
  if (step === 'myintealth' || step === 'myinthealth') return '/pages/myinthealth.html';
  if (step === 'amc') return '/pages/amc.html';
  if (step === 'ahpra' || step === 'specialist-registration') return '/pages/ahpra.html';
  return null;
}

function isAppShellSupportedPath(pathname) {
  return APP_SHELL_SUPPORTED_PATHS.has(String(pathname || ''));
}

function shouldServeAppShell(requestUrl, pathname) {
  if (!isAppShellSupportedPath(pathname)) return false;
  if (pathname === '/pages/app-shell.html') return false;
  return requestUrl.searchParams.get(APP_SHELL_EMBED_PARAM) !== APP_SHELL_EMBED_VALUE;
}

function buildStaticEtag(stat) {
  return `W/"${Number(stat.size || 0).toString(16)}-${Math.floor(Number(stat.mtimeMs || 0)).toString(16)}"`;
}

function hasMatchingEtag(headerValue, etag) {
  if (typeof headerValue !== 'string' || !headerValue || !etag) return false;
  if (headerValue.trim() === '*') return true;
  return headerValue
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === etag);
}

function isNotModified(req, etag, stat) {
  if (hasMatchingEtag(req.headers['if-none-match'], etag)) {
    return true;
  }

  const ifModifiedSince = req.headers['if-modified-since'];
  if (typeof ifModifiedSince !== 'string' || !ifModifiedSince) {
    return false;
  }

  const sinceMs = Date.parse(ifModifiedSince);
  if (!Number.isFinite(sinceMs)) {
    return false;
  }

  return Math.floor(Number(stat.mtimeMs || 0) / 1000) * 1000 <= sinceMs;
}

function getStaticCacheControl(req, pathname, ext) {
  if (ext === '.html') return 'private, no-cache';
  if (pathname === '/sw.js') return 'no-cache';
  if (pathname.startsWith('/media/')) return 'public, max-age=31536000, immutable';

  const requestUrl = String(req.url || '');
  if ((ext === '.js' || ext === '.css' || ext === '.json' || ext === '.svg') && /[?&]v=[^&]+/i.test(requestUrl)) {
    return 'public, max-age=31536000, immutable';
  }

  if (ext === '.js' || ext === '.css' || ext === '.json' || ext === '.svg') {
    return 'public, max-age=3600, must-revalidate';
  }

  return 'public, max-age=3600';
}

function sanitizeFilePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname.split('?')[0]);
  } catch (err) {
    return null; // Malformed URI encoding
  }
  // Reject null bytes (path traversal vector)
  if (decoded.indexOf('\0') !== -1) return null;
  const target = decoded === '/' ? '/pages/index.html' : decoded;
  const normalized = path.posix.normalize(String(target).replace(/\\/g, '/'));
  const relative = normalized.replace(/^\/+/, '');
  if (!relative || relative.startsWith('..')) return null;
  const resolved = path.resolve(process.cwd(), relative);
  // Ensure resolved path is within cwd (defense-in-depth)
  if (!resolved.startsWith(process.cwd() + path.sep) && resolved !== process.cwd()) return null;
  return resolved;
}

function serveStatic(req, res, pathname) {
  const filePath = sanitizeFilePath(pathname);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!filePath.startsWith(process.cwd() + path.sep) && filePath !== process.cwd()) {
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
    const isVideo = ext === '.mp4';
    const cacheControl = getStaticCacheControl(req, pathname, ext);
    const etag = buildStaticEtag(stat);
    const lastModified = stat.mtime.toUTCString();
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
          'Cache-Control': cacheControl,
          ETag: etag,
          'Last-Modified': lastModified,
          ...SECURITY_HEADERS,
          ...(NODE_ENV === 'production' ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload' } : {})
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
      'Cache-Control': cacheControl,
      ETag: etag,
      'Last-Modified': lastModified,
      ...SECURITY_HEADERS
    };
    if (NODE_ENV === 'production') headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains; preload';
    if (isVideo) headers['Accept-Ranges'] = 'bytes';
    if (!pathname.startsWith('/media/') && isCompressibleType(ext)) headers['Vary'] = 'Accept-Encoding';

    if (!range && isNotModified(req, etag, stat)) {
      delete headers['Content-Length'];
      res.writeHead(304, headers);
      res.end();
      return;
    }

    const acceptsGzip = typeof req.headers['accept-encoding'] === 'string' && req.headers['accept-encoding'].includes('gzip');
    const shouldGzip = !pathname.startsWith('/media/') && !range && acceptsGzip && isCompressibleType(ext) && stat.size > 1024;

    if (shouldGzip) {
      delete headers['Content-Length'];
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);

      const stream = fs.createReadStream(filePath);
      const gzip = zlib.createGzip({ level: 6 });
      stream.pipe(gzip).pipe(res);
      stream.on('error', () => {
        res.writeHead(500);
        res.end('Server error');
      });
      return;
    }

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
    firstName: sanitizeUserString(profile.firstName, 80),
    lastName: sanitizeUserString(profile.lastName, 80),
    email: typeof profile.email === 'string' ? profile.email.trim().toLowerCase().slice(0, 120) : '',
    phone: sanitizeUserString(profile.phone, 40),
    registrationNumber: sanitizeUserString(profile.registrationNumber, 40),
    gmcNumber: sanitizeUserString(profile.gmcNumber, 30),
    specialistCountry: sanitizeUserString(profile.specialistCountry, 30),
    profilePhotoName: sanitizeUserString(profile.profilePhotoName, 180),
    profilePhotoDataUrl: typeof profile.profilePhotoDataUrl === 'string' ? profile.profilePhotoDataUrl.slice(0, 4 * 1024 * 1024) : '',
    idCopyName: sanitizeUserString(profile.idCopyName, 180),
    idCopyDataUrl: typeof profile.idCopyDataUrl === 'string' ? profile.idCopyDataUrl.slice(0, 4 * 1024 * 1024) : '',
    cvFileName: sanitizeUserString(profile.cvFileName, 180),
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

async function getAdminRoleFromSupabaseUserId(userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId || !isSupabaseDbConfigured()) return '';
  const result = await supabaseDbRequest(
    'user_roles',
    `select=role&user_id=eq.${encodeURIComponent(normalizedUserId)}&limit=1`
  );
  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return '';
  return normalizeAdminRole(result.data[0] && result.data[0].role);
}

async function resolveAdminRoleForSupabaseUser(supaUser, fallbackEmail = '') {
  const userId = String(supaUser && supaUser.id ? supaUser.id : '').trim();
  const email = String((supaUser && supaUser.email) || fallbackEmail || '').trim().toLowerCase();
  const dbRole = await getAdminRoleFromSupabaseUserId(userId);
  if (dbRole) return dbRole;
  return getConfiguredAdminRoleForEmail(email);
}

function buildAdminSessionProfile(userProfile, adminRole) {
  return {
    ...(userProfile && typeof userProfile === 'object' ? userProfile : {}),
    adminRole: normalizeAdminRole(adminRole)
  };
}

function isAdminEmail(email) {
  return hasAdminPortalAccess(getConfiguredAdminRoleForEmail(email));
}

function requireAdminSession(req, res) {
  const hostScope = getAdminHostScope(req);
  if (!hostScope) {
    sendJson(res, 404, { ok: false, message: 'Not found' });
    return null;
  }
  const session = getAdminSession(req);
  if (!session) {
    sendJson(res, 401, { ok: false, authenticated: false });
    return null;
  }
  const email = getSessionEmail(session);
  const role = getAdminRoleFromSession(session);
  if (!doesAdminRoleMatchHost(role, hostScope)) {
    sendJson(res, 403, {
      ok: false,
      message: hostScope === 'super_admin'
        ? 'Super admin access required on this host.'
        : 'Admin access required.'
    });
    return null;
  }
  return {
    session,
    email,
    role,
    roleLabel: getAdminRoleLabel(role),
    hostScope,
    hostLabel: getAdminHostLabel(hostScope)
  };
}

function requireIntegrationAdminSession(req, res) {
  const session = requireSession(req, res);
  if (!session) return null;
  const email = getSessionEmail(session);
  const role = getConfiguredAdminRoleForEmail(email);
  if (!hasAdminPortalAccess(role)) {
    sendJson(res, 403, { ok: false, message: 'Admin access required.' });
    return null;
  }
  return { session, email, role, roleLabel: getAdminRoleLabel(role) };
}

function requireSuperAdminSession(req, res) {
  const adminCtx = requireAdminSession(req, res);
  if (!adminCtx) return null;
  if (!isSuperAdminRole(adminCtx.role)) {
    sendJson(res, 403, { ok: false, message: 'Super admin access required.' });
    return null;
  }
  return adminCtx;
}

function ensureAgentOutputRoot() {
  ensureDirSync(AGENT_OUTPUT_ROOT);
}

function readJsonFileSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJsonFileSafe(filePath, value) {
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function tailFile(filePath, maxBytes = 12000) {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function sanitizeAgentRunId(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function getHybridAgentRunDir(runId) {
  return path.join(AGENT_OUTPUT_ROOT, sanitizeAgentRunId(runId));
}

function getHybridAgentRunSummary(runId) {
  const safeRunId = sanitizeAgentRunId(runId);
  if (!safeRunId) return null;
  const runDir = getHybridAgentRunDir(safeRunId);
  const runState = readJsonFileSafe(path.join(runDir, 'run-state.json')) || {};
  const registry = hybridAgentControlState.runs[safeRunId] || {};
  const launch = readJsonFileSafe(path.join(runDir, 'launch.json')) || {};
  const reportPath = path.join(runDir, 'REPORT.md');
  const stdoutLogPath = path.join(runDir, 'orchestrator.stdout.log');
  const stderrLogPath = path.join(runDir, 'orchestrator.stderr.log');

  return {
    runId: safeRunId,
    task: runState.task || registry.task || '',
    status: runState.status || registry.status || 'unknown',
    phase: runState.phase || registry.phase || '',
    profile: runState.profile || registry.profile || '',
    collaborationMode: runState.collaborationMode || registry.collaborationMode || '',
    complexityMode: runState.complexityMode || registry.complexityMode || 'auto',
    taskComplexity: runState.taskComplexity || registry.taskComplexity || 'standard',
    startedAt: runState.startedAt || registry.startedAt || '',
    finishedAt: runState.finishedAt || registry.finishedAt || '',
    requestedBy: runState.requestedBy || registry.requestedBy || launch.requestedBy || '',
    currentSubtask: runState.currentSubtask || registry.currentSubtask || null,
    completedSubtasks: Array.isArray(runState.completedSubtasks) ? runState.completedSubtasks : [],
    planSummary: runState.planSummary || '',
    outputDir: path.relative(process.cwd(), runDir),
    reportExists: fs.existsSync(reportPath),
    reportPath: fs.existsSync(reportPath) ? path.relative(process.cwd(), reportPath) : '',
    reportPreview: fs.existsSync(reportPath) ? tailFile(reportPath, 10000) : '',
    stdoutTail: tailFile(stdoutLogPath, 8000),
    stderrTail: tailFile(stderrLogPath, 4000),
  };
}

function listHybridAgentRuns(limit = 12) {
  ensureAgentOutputRoot();
  let dirEntries = [];
  try {
    dirEntries = fs.readdirSync(AGENT_OUTPUT_ROOT, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
      .reverse();
  } catch {
    dirEntries = [];
  }

  const runs = [];
  for (const runId of dirEntries) {
    const summary = getHybridAgentRunSummary(runId);
    if (summary) runs.push(summary);
    if (runs.length >= limit) break;
  }

  const activeRunId = hybridAgentControlState.activeRunId;
  if (activeRunId && !runs.find(run => run.runId === activeRunId)) {
    const live = getHybridAgentRunSummary(activeRunId);
    if (live) runs.unshift(live);
  }

  return runs.slice(0, limit);
}

function hasActiveHybridAgentRun() {
  const activeRunId = hybridAgentControlState.activeRunId;
  if (!activeRunId) return false;
  const record = hybridAgentControlState.runs[activeRunId];
  return !!(record && record.status === 'running');
}

function updateHybridAgentRegistry(runId, patch) {
  const safeRunId = sanitizeAgentRunId(runId);
  if (!safeRunId) return null;
  hybridAgentControlState.runs[safeRunId] = {
    ...(hybridAgentControlState.runs[safeRunId] || {}),
    ...patch,
    runId: safeRunId
  };
  return hybridAgentControlState.runs[safeRunId];
}

function getHybridAgentBridgeRequestToken(req) {
  const bearer = getBearerToken(req);
  if (bearer) return bearer;
  return String(req && req.headers && req.headers['x-agent-bridge-token'] ? req.headers['x-agent-bridge-token'] : '').trim();
}

function createHybridAgentWorkerRegistration(store, email, options) {
  const nextStore = normalizeHybridAgentBridgeStore(store);
  const tokenValue = crypto.randomBytes(24).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(tokenValue).digest('hex');
  const workerCount = Object.keys(nextStore.workers).length + 1;
  const workerId = sanitizeHybridAgentWorkerId(options && options.workerId)
    || sanitizeHybridAgentWorkerId(`worker-${Date.now().toString(36)}-${workerCount}`);
  const workerName = sanitizeHybridAgentWorkerName(options && options.name) || `Agent Host ${workerCount}`;
  const currentIso = new Date().toISOString();

  nextStore.workers[workerId] = normalizeHybridAgentWorkerRecord(workerId, {
    id: workerId,
    name: workerName,
    tokenHash,
    createdAt: currentIso,
    updatedAt: currentIso,
    createdBy: String(email || '').trim().toLowerCase(),
    enabled: true,
    lastSeenAt: '',
    providers: null,
    providerStatusRefreshedAt: '',
    runs: [],
    activeRunId: '',
    bridgeInfo: null,
    relayOrigin: '',
    lastCommandResultAt: '',
    meta: {}
  });
  if (!nextStore.primaryWorkerId) nextStore.primaryWorkerId = workerId;

  return {
    store: nextStore,
    workerId,
    workerName,
    token: tokenValue
  };
}

function getSelectedHybridAgentWorker(store) {
  const source = normalizeHybridAgentBridgeStore(store);
  if (source.primaryWorkerId && source.workers[source.primaryWorkerId] && source.workers[source.primaryWorkerId].enabled !== false) {
    return source.workers[source.primaryWorkerId];
  }
  return Object.values(source.workers).find(function (worker) { return worker && worker.enabled !== false; }) || null;
}

function isHybridAgentWorkerConnected(worker) {
  if (!worker || !worker.lastSeenAt) return false;
  const seenAtMs = Date.parse(worker.lastSeenAt);
  if (!Number.isFinite(seenAtMs)) return false;
  return (now() - seenAtMs) <= HYBRID_AGENT_BRIDGE_STALE_MS;
}

function getActiveHybridAgentRelay(store) {
  const worker = getSelectedHybridAgentWorker(store);
  if (!worker || !isHybridAgentWorkerConnected(worker)) return null;
  return {
    workerId: worker.id,
    workerName: worker.name,
    lastSeenAt: worker.lastSeenAt,
    providers: worker.providers,
    providerStatusRefreshedAt: worker.providerStatusRefreshedAt || '',
    runs: Array.isArray(worker.runs) ? worker.runs : [],
    activeRunId: worker.activeRunId || '',
    bridgeInfo: worker.bridgeInfo || null,
    relayOrigin: worker.relayOrigin || '',
    lastCommandResultAt: worker.lastCommandResultAt || '',
    meta: worker.meta || {},
    connected: true,
    mode: 'relay'
  };
}

function getTargetHybridAgentWorkerId(store) {
  const worker = getSelectedHybridAgentWorker(store);
  return worker ? worker.id : '';
}

function listHybridAgentWorkers(store) {
  const source = normalizeHybridAgentBridgeStore(store);
  return Object.values(source.workers)
    .map(function (worker) {
      const connected = isHybridAgentWorkerConnected(worker);
      const providers = worker.providers && typeof worker.providers === 'object' ? worker.providers : null;
      const availableProviderCount = providers ? Object.values(providers).filter(function (entry) { return entry && entry.available; }).length : 0;
      return {
        id: worker.id,
        name: worker.name || worker.id,
        primary: source.primaryWorkerId === worker.id,
        enabled: worker.enabled !== false,
        connected,
        createdAt: worker.createdAt || '',
        updatedAt: worker.updatedAt || '',
        lastSeenAt: worker.lastSeenAt || '',
        relayOrigin: worker.relayOrigin || '',
        bridgeInfo: worker.bridgeInfo || null,
        activeRunId: worker.activeRunId || '',
        providerStatusRefreshedAt: worker.providerStatusRefreshedAt || '',
        availableProviderCount,
        meta: worker.meta || {}
      };
    })
    .sort(function (a, b) {
      if (a.primary && !b.primary) return -1;
      if (!a.primary && b.primary) return 1;
      if (a.connected && !b.connected) return -1;
      if (!a.connected && b.connected) return 1;
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
}

function findHybridAgentWorkerByCredentials(store, workerId, tokenValue) {
  const source = normalizeHybridAgentBridgeStore(store);
  const safeWorkerId = sanitizeHybridAgentWorkerId(workerId || '');
  const worker = safeWorkerId ? source.workers[safeWorkerId] : null;
  if (!worker || worker.enabled === false || !worker.tokenHash) return null;
  const tokenHash = crypto.createHash('sha256').update(String(tokenValue || '')).digest('hex');
  if (tokenHash !== worker.tokenHash) return null;
  return worker;
}

function buildHybridAgentBridgeStatus(req, store) {
  const source = normalizeHybridAgentBridgeStore(store);
  const relay = getActiveHybridAgentRelay(source);
  const workers = listHybridAgentWorkers(source);
  const selectedWorker = getSelectedHybridAgentWorker(source);
  if (!relay) {
    return {
      connected: false,
      mode: 'remote',
      relayUrl: getRequestOrigin(req),
      lastSeenAt: selectedWorker && selectedWorker.lastSeenAt ? selectedWorker.lastSeenAt : '',
      workerId: selectedWorker ? selectedWorker.id : '',
      workerName: selectedWorker ? selectedWorker.name : '',
      workerCount: workers.length
    };
  }
  return {
    connected: true,
    mode: 'relay',
    relayUrl: getRequestOrigin(req),
    lastSeenAt: relay.lastSeenAt,
    providerStatusRefreshedAt: relay.providerStatusRefreshedAt || '',
    baseUrl: relay.bridgeInfo && relay.bridgeInfo.baseUrl ? relay.bridgeInfo.baseUrl : '',
    host: relay.bridgeInfo && relay.bridgeInfo.host ? relay.bridgeInfo.host : '',
    port: relay.bridgeInfo && relay.bridgeInfo.port ? relay.bridgeInfo.port : '',
    workerId: relay.workerId,
    workerName: relay.workerName || relay.workerId,
    workerCount: workers.length,
    meta: relay.meta || {}
  };
}

function queueHybridAgentBridgeCommand(store, workerId, type, payload, requestedBy) {
  const nextStore = normalizeHybridAgentBridgeStore(store);
  const safeWorkerId = sanitizeHybridAgentWorkerId(workerId || '');
  if (!safeWorkerId || !nextStore.workers[safeWorkerId]) return { store: nextStore, command: null };
  nextStore.commandSeq += 1;
  const command = {
    id: `bridge-${Date.now()}-${nextStore.commandSeq}`,
    workerId: safeWorkerId,
    type: String(type || '').trim(),
    payload: payload && typeof payload === 'object' ? payload : {},
    requestedBy: String(requestedBy || '').trim(),
    createdAt: new Date().toISOString(),
    status: 'queued',
    sentAt: '',
    completedAt: '',
    deliveryCount: 0,
    result: null,
    message: ''
  };
  nextStore.commands.push(command);
  if (nextStore.commands.length > 200) nextStore.commands = nextStore.commands.slice(-200);
  return { store: nextStore, command };
}

function takePendingHybridAgentBridgeCommands(store, workerId, limit = 8) {
  const nextStore = normalizeHybridAgentBridgeStore(store);
  const safeWorkerId = sanitizeHybridAgentWorkerId(workerId || '');
  const currentIso = new Date().toISOString();
  const resendBeforeMs = now() - 30 * 1000;
  const commands = nextStore.commands
    .filter(function (command) {
      if (!command || command.workerId !== safeWorkerId) return false;
      if (command.status === 'queued') return true;
      if (command.status !== 'sent') return false;
      const sentAtMs = Date.parse(command.sentAt || '');
      return !Number.isFinite(sentAtMs) || sentAtMs < resendBeforeMs;
    })
    .slice(0, limit)
    .map(function (command) {
      command.status = 'sent';
      command.sentAt = currentIso;
      command.deliveryCount = (command.deliveryCount || 0) + 1;
      return {
        id: command.id,
        workerId: command.workerId,
        type: command.type,
        payload: command.payload,
        createdAt: command.createdAt
      };
    });

  return { store: nextStore, commands };
}

function applyHybridAgentBridgeCommandUpdates(store, workerId, updates) {
  const nextStore = normalizeHybridAgentBridgeStore(store);
  const safeWorkerId = sanitizeHybridAgentWorkerId(workerId || '');
  if (!Array.isArray(updates) || !updates.length || !safeWorkerId) return nextStore;
  const currentIso = new Date().toISOString();
  updates.forEach(function (update) {
    if (!update || typeof update !== 'object' || !update.id) return;
    const command = nextStore.commands.find(function (candidate) {
      return candidate.id === update.id && candidate.workerId === safeWorkerId;
    });
    if (!command) return;
    command.status = String(update.status || 'completed').trim() || 'completed';
    command.completedAt = currentIso;
    command.message = typeof update.message === 'string' ? update.message : command.message;
    command.result = update.result && typeof update.result === 'object' ? update.result : command.result;
  });
  const worker = nextStore.workers[safeWorkerId];
  if (worker) worker.lastCommandResultAt = currentIso;
  return nextStore;
}

function updateHybridAgentBridgeSnapshot(store, workerId, payload, req) {
  const nextStore = normalizeHybridAgentBridgeStore(store);
  const safeWorkerId = sanitizeHybridAgentWorkerId(workerId || '');
  const worker = nextStore.workers[safeWorkerId];
  if (!worker) return nextStore;

  const currentIso = new Date().toISOString();
  const bridgeInfo = payload && payload.bridge && typeof payload.bridge === 'object' ? payload.bridge : null;
  const runs = Array.isArray(payload && payload.runs)
    ? payload.runs.filter(function (run) { return run && typeof run === 'object' && run.runId; }).slice(0, 20)
    : [];
  const activeRun = typeof payload.activeRunId === 'string' && payload.activeRunId
    ? payload.activeRunId
    : ((runs.find(function (run) { return run.status === 'running' || run.status === 'starting' || run.status === 'launching'; }) || {}).runId || '');
  const workerMeta = payload && payload.worker && typeof payload.worker === 'object' ? payload.worker : {};
  const derivedName = sanitizeHybridAgentWorkerName(workerMeta.name || workerMeta.hostname || worker.name || worker.id) || worker.name || worker.id;

  nextStore.workers[safeWorkerId] = normalizeHybridAgentWorkerRecord(safeWorkerId, {
    ...worker,
    name: derivedName,
    updatedAt: currentIso,
    lastSeenAt: currentIso,
    providers: payload && payload.providers && typeof payload.providers === 'object' ? payload.providers : null,
    providerStatusRefreshedAt: typeof (payload && payload.providerStatusRefreshedAt) === 'string' ? payload.providerStatusRefreshedAt : currentIso,
    runs,
    activeRunId: activeRun,
    bridgeInfo,
    relayOrigin: getRequestOrigin(req),
    lastCommandResultAt: worker.lastCommandResultAt || '',
    meta: {
      hostname: typeof workerMeta.hostname === 'string' ? workerMeta.hostname : '',
      platform: typeof workerMeta.platform === 'string' ? workerMeta.platform : '',
      user: typeof workerMeta.user === 'string' ? workerMeta.user : '',
      pid: workerMeta.pid || ''
    }
  });

  if (!nextStore.primaryWorkerId || !nextStore.workers[nextStore.primaryWorkerId]) {
    nextStore.primaryWorkerId = safeWorkerId;
  }

  return nextStore;
}

async function getCachedHybridAgentProviderStatus(force = false) {
  const nowMs = Date.now();
  if (!force && hybridAgentControlState.providerStatusCache.data && hybridAgentControlState.providerStatusCache.expiresAt > nowMs) {
    return hybridAgentControlState.providerStatusCache.data;
  }
  if (!force && hybridAgentControlState.providerStatusCache.inFlight) {
    return hybridAgentControlState.providerStatusCache.inFlight;
  }

  const promise = hybridAgents.inspectProviders()
    .then(function (data) {
      hybridAgentControlState.providerStatusCache.data = data;
      hybridAgentControlState.providerStatusCache.expiresAt = Date.now() + 10000;
      hybridAgentControlState.providerStatusCache.refreshedAt = new Date().toISOString();
      hybridAgentControlState.providerStatusCache.inFlight = null;
      return data;
    })
    .catch(function (error) {
      hybridAgentControlState.providerStatusCache.inFlight = null;
      throw error;
    });

  hybridAgentControlState.providerStatusCache.inFlight = promise;
  return promise;
}

function buildHybridAgentChildEnv() {
  const env = {};
  const allowList = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'TERM',
    'COLORTERM',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'NODE_ENV',
    'CODEX_CLI_PATH',
    'CLAUDE_CLI_PATH',
    'AGENT_PROFILE',
    'AGENT_COLLABORATION_MODE',
    'AGENT_COMPLEXITY_MODE',
    'AGENT_ENABLE_CLAUDE_BROWSER_USE_MCP',
    'AGENT_MAX_FILE_CONTEXT_CHARS',
    'AGENT_MAX_PLANNER_FILES',
    'AGENT_MAX_SUBTASKS',
    'AGENT_MAX_DEPENDENCY_CONTEXT_CHARS',
    'AGENT_MAX_SHARED_MEMORY_ITEMS',
    'CLAUDE_BROWSER_MCP_NAME',
    'OPENAI_AGENT_MODEL',
    'OPENAI_REVIEW_MODEL',
    'OPENAI_COMPLEX_MODEL',
    'OPENAI_STANDARD_MODEL',
    'OPENAI_SIMPLE_MODEL',
    'OPENAI_COMPLEX_REVIEW_MODEL',
    'OPENAI_STANDARD_REVIEW_MODEL',
    'ANTHROPIC_AGENT_MODEL',
    'ANTHROPIC_RESEARCH_MODEL',
    'ANTHROPIC_COMPLEX_MODEL',
    'ANTHROPIC_STANDARD_MODEL',
    'ANTHROPIC_SIMPLE_MODEL'
  ];

  allowList.forEach(function (key) {
    if (typeof process.env[key] === 'string' && process.env[key]) {
      env[key] = process.env[key];
    }
  });

  env.PATH = process.env.PATH || env.PATH || '';
  env.HOME = process.env.HOME || env.HOME || '';
  env.NODE_ENV = NODE_ENV;
  env.AGENT_SKIP_DOTENV = 'true';
  return env;
}

function buildHybridAgentDashboardState(taskText, options) {
  const task = String(taskText || '').trim();
  const profile = options && options.profile ? options.profile : 'balanced';
  const collaborationMode = options && options.collaborationMode ? options.collaborationMode : 'paired';
  const complexityMode = options && options.complexityMode ? options.complexityMode : 'auto';
  const bridgeStore = options && options.bridgeStore ? options.bridgeStore : createEmptyHybridAgentBridgeStore();
  const relay = options && options.bridgeState ? options.bridgeState : getActiveHybridAgentRelay(bridgeStore);
  const providerStates = options && options.providerStates
    ? options.providerStates
    : (relay && relay.providers ? relay.providers : hybridAgentControlState.providerStatusCache.data);
  const providerEntries = providerStates ? Object.values(providerStates) : [];
  const availableProviders = providerEntries.filter(function (state) { return state && state.available; });
  const warnings = [];

  if (!availableProviders.length) {
    warnings.push('Neither Codex nor Claude is currently connected. Use the connect help buttons before starting a run.');
  } else if (collaborationMode === 'paired' && availableProviders.length < 2) {
    warnings.push('Only one provider is connected right now, so paired mode will automatically fall back to routed execution.');
  }
  if (
    task &&
    hybridAgents.inferBrowserUseNeed &&
    hybridAgents.inferBrowserUseNeed(task) &&
    !(providerStates && providerStates.anthropic && providerStates.anthropic.browserUse && providerStates.anthropic.browserUse.available)
  ) {
    warnings.push('This task looks like a browser/computer walkthrough, but Claude browser-use MCP is not currently connected.');
  }
  if (task && task.length < 12) {
    warnings.push('Short prompts produce weaker plans. Give the agent a concrete, repo-specific task.');
  }

  return {
    policy: hybridAgents.getModelPolicy(task, complexityMode, profile, collaborationMode),
    activeRunId: relay && relay.activeRunId ? relay.activeRunId : (hybridAgentControlState.activeRunId || ''),
    runs: relay && Array.isArray(relay.runs) ? relay.runs.slice(0, 12) : listHybridAgentRuns(12),
    workers: listHybridAgentWorkers(bridgeStore),
    primaryWorkerId: bridgeStore && bridgeStore.primaryWorkerId ? bridgeStore.primaryWorkerId : '',
    providerStatusRefreshedAt: relay && relay.providerStatusRefreshedAt
      ? relay.providerStatusRefreshedAt
      : (hybridAgentControlState.providerStatusCache.refreshedAt || ''),
    warnings,
    security: {
      superAdminOnly: true,
      sameOriginRequired: ENFORCE_SAME_ORIGIN,
      singleActiveRun: true,
      subscriptionCliOnly: true,
      secretsPassedToChild: false,
      bridgeRelayAvailable: true,
    }
  };
}

function startHybridAgentRun(options) {
  const task = String(options && options.task ? options.task : '').trim();
  if (!task) throw new Error('Task is required.');
  if (hasActiveHybridAgentRun()) throw new Error('An agent run is already in progress.');

  const profile = ['balanced', 'codex-heavy', 'claude-heavy'].includes(options.profile) ? options.profile : 'balanced';
  const collaboration = ['single', 'routed', 'paired'].includes(options.collaborationMode) ? options.collaborationMode : 'paired';
  const complexity = ['auto', 'simple', 'standard', 'complex'].includes(options.complexity) ? options.complexity : 'auto';
  const runId = sanitizeAgentRunId(options.runId || `agent-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  const requestedBy = typeof options.requestedBy === 'string' ? options.requestedBy.trim() : '';
  const runDir = getHybridAgentRunDir(runId);
  ensureDirSync(runDir);

  const stdoutLogPath = path.join(runDir, 'orchestrator.stdout.log');
  const stderrLogPath = path.join(runDir, 'orchestrator.stderr.log');
  const stdoutStream = fs.createWriteStream(stdoutLogPath, { flags: 'a' });
  const stderrStream = fs.createWriteStream(stderrLogPath, { flags: 'a' });
  const args = [
    'scripts/agents.js',
    '--task', task,
    '--profile', profile,
    '--collaboration', collaboration,
    '--complexity', complexity,
    '--run-id', runId
  ];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: buildHybridAgentChildEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  hybridAgentControlState.activeRunId = runId;
  updateHybridAgentRegistry(runId, {
    status: 'running',
    phase: 'launching',
    startedAt: new Date().toISOString(),
    task,
    profile,
    collaborationMode: collaboration,
    complexityMode: complexity,
    taskComplexity: hybridAgents.resolveTaskComplexity(task, complexity),
    requestedBy,
    pid: child.pid,
    stdoutLogPath,
    stderrLogPath
  });

  writeJsonFileSafe(path.join(runDir, 'launch.json'), {
    runId,
    task,
    profile,
    collaborationMode: collaboration,
    complexityMode: complexity,
    requestedBy,
    pid: child.pid,
    startedAt: new Date().toISOString()
  });

  child.stdout.on('data', function (chunk) {
    stdoutStream.write(chunk);
  });
  child.stderr.on('data', function (chunk) {
    stderrStream.write(chunk);
  });
  child.on('close', function (code, signal) {
    stdoutStream.end();
    stderrStream.end();
    const existingState = readJsonFileSafe(path.join(runDir, 'run-state.json')) || {};
    updateHybridAgentRegistry(runId, {
      status: code === 0 ? 'completed' : (signal ? 'cancelled' : 'failed'),
      phase: code === 0 ? 'completed' : (signal ? 'cancelled' : 'error'),
      finishedAt: new Date().toISOString(),
      exitCode: code,
      signal: signal || '',
      currentSubtask: null
    });
    if (!existingState || !existingState.status || existingState.status === 'running' || existingState.status === 'starting') {
      writeJsonFileSafe(path.join(runDir, 'run-state.json'), {
        ...existingState,
        runId,
        task,
        profile,
        collaborationMode: collaboration,
        complexityMode: complexity,
        taskComplexity: hybridAgents.resolveTaskComplexity(task, complexity),
        requestedBy: existingState.requestedBy || requestedBy,
        status: code === 0 ? 'completed' : (signal ? 'cancelled' : 'failed'),
        phase: code === 0 ? 'completed' : (signal ? 'cancelled' : 'error'),
        startedAt: existingState.startedAt || new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        outputDir: path.relative(process.cwd(), runDir),
        error: code === 0 ? '' : `Process exited with code ${code}${signal ? ` (signal ${signal})` : ''}`
      });
    }
    if (hybridAgentControlState.activeRunId === runId) {
      hybridAgentControlState.activeRunId = '';
    }
  });
  child.on('error', function (error) {
    stdoutStream.end();
    stderrStream.end();
    updateHybridAgentRegistry(runId, {
      status: 'failed',
      phase: 'error',
      finishedAt: new Date().toISOString(),
      error: error && error.message ? error.message : 'Failed to launch agent run.'
    });
    writeJsonFileSafe(path.join(runDir, 'run-state.json'), {
      runId,
      task,
      profile,
      collaborationMode: collaboration,
      complexityMode: complexity,
      taskComplexity: hybridAgents.resolveTaskComplexity(task, complexity),
      requestedBy,
      status: 'failed',
      phase: 'error',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outputDir: path.relative(process.cwd(), runDir),
      error: error && error.message ? error.message : 'Failed to launch agent run.'
    });
    if (hybridAgentControlState.activeRunId === runId) {
      hybridAgentControlState.activeRunId = '';
    }
  });

  return { runId, task, profile, collaborationMode: collaboration, complexityMode: complexity, pid: child.pid };
}

function cancelHybridAgentRun(runId) {
  const safeRunId = sanitizeAgentRunId(runId);
  const record = hybridAgentControlState.runs[safeRunId];
  if (!record || !record.pid || record.status !== 'running') return false;
  try {
    process.kill(record.pid, 'SIGTERM');
    updateHybridAgentRegistry(safeRunId, { status: 'cancelling', phase: 'cancelling' });
    return true;
  } catch {
    return false;
  }
}

function timingSafeEqualStrings(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch (err) {
    return false;
  }
}

function getBearerToken(req) {
  const header = String(req.headers.authorization || '').trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function requireZohoRecruitCronAuth(req, res) {
  if (!ZOHO_RECRUIT_SYNC_CRON_SECRET) {
    sendJson(res, 503, { ok: false, message: 'Zoho Recruit cron secret is not configured.' });
    return false;
  }
  const token = getBearerToken(req);
  if (!token || !timingSafeEqualStrings(token, ZOHO_RECRUIT_SYNC_CRON_SECRET)) {
    sendJson(res, 401, { ok: false, message: 'Invalid cron authorization.' });
    return false;
  }
  return true;
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

function getDocMetaForCountry(countryCode) {
  const code = (typeof countryCode === 'string' ? countryCode : 'uk').toLowerCase();
  const shared = GP_DOCUMENT_META.shared || [];
  const countrySpecific = GP_DOCUMENT_META[code] || GP_DOCUMENT_META.uk || [];
  return [...shared, ...countrySpecific];
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

  const docCountry = docsState.country || 'uk';
  const docMeta = getDocMetaForCountry(docCountry);

  const fromState = docMeta.map((meta) => {
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

function invalidateAdminDashboardCache() {
  adminDashboardCache.expiresAt = 0;
  adminDashboardCache.data = null;
}

// ══════ Registration Case & Task Automation ══════

function _parseStateVal(v) {
  if (!v) return {};
  if (typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
  return {};
}

function _deriveStageFromState(state) {
  const epic = _parseStateVal(state.gp_epic_progress);
  const amc = _parseStateVal(state.gp_amc_progress);
  const ahpra = _parseStateVal(state.gp_ahpra_progress);
  const career = _parseStateVal(state.gp_career_state);
  const ec = epic && epic.completed ? epic.completed : {};
  const ac = amc && amc.completed ? amc.completed : {};
  const hc = ahpra && ahpra.completed ? ahpra.completed : {};
  if (ec.verification_issued !== true) return 'myintealth';
  if (ac.qualifications_verified !== true) return 'amc';
  let careerSecured = career.career_secured === true || career.secured === true;
  if (!careerSecured && Array.isArray(career.applications)) {
    for (const a of career.applications) { if (a && a.isPlacementSecured === true) { careerSecured = true; break; } }
  }
  if (!careerSecured) return 'career';
  if (hc.verification_issued !== true) return 'ahpra';
  return 'visa';
}

async function _ensureRegCase(userId) {
  if (!isSupabaseDbConfigured()) return null;
  const q = await supabaseDbRequest('registration_cases', 'select=*&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
  if (q.ok && Array.isArray(q.data) && q.data.length > 0) return q.data[0];
  const ins = await supabaseDbRequest('registration_cases', '', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: [{ user_id: userId, stage: 'myintealth', status: 'active' }]
  });
  return ins.ok && Array.isArray(ins.data) && ins.data.length > 0 ? ins.data[0] : null;
}

async function _createRegTask(caseId, data) {
  if (!isSupabaseDbConfigured()) return null;
  const actor = data._actor || 'system';
  const payload = { case_id: caseId };
  for (const [k, v] of Object.entries(data)) { if (k !== '_actor') payload[k] = v; }
  const r = await supabaseDbRequest('registration_tasks', '', {
    method: 'POST', headers: { Prefer: 'return=representation' }, body: [payload]
  });
  const task = r.ok && Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : null;
  if (task) {
    await supabaseDbRequest('task_timeline', '', {
      method: 'POST', body: [{ task_id: task.id, case_id: caseId, event_type: 'created', title: 'Task created', detail: task.title, actor: actor }]
    });
  }
  return task;
}

async function _completeRegTask(taskId, caseId, actor) {
  if (!isSupabaseDbConfigured()) return;
  await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(taskId), {
    method: 'PATCH', body: { status: 'completed', completed_at: new Date().toISOString(), completed_by: actor || 'system' }
  });
  await supabaseDbRequest('task_timeline', '', {
    method: 'POST', body: [{ task_id: taskId, case_id: caseId, event_type: 'completed', title: 'Task completed', actor: actor || 'system' }]
  });
}

async function _logCaseEvent(caseId, taskId, eventType, title, detail, actor) {
  if (!isSupabaseDbConfigured()) return;
  await supabaseDbRequest('task_timeline', '', {
    method: 'POST', body: [{ case_id: caseId, task_id: taskId || null, event_type: eventType, title: title, detail: detail || null, actor: actor || 'system' }]
  });
}

async function _hasOpenTask(caseId, stage, type) {
  if (!isSupabaseDbConfigured()) return false;
  const q = await supabaseDbRequest('registration_tasks',
    'select=id&case_id=eq.' + encodeURIComponent(caseId) + '&related_stage=eq.' + encodeURIComponent(stage) + '&task_type=eq.' + encodeURIComponent(type) + '&status=in.(open,in_progress,waiting)&limit=1');
  return q.ok && Array.isArray(q.data) && q.data.length > 0;
}

async function _hasOpenTaskForDoc(caseId, docKey) {
  if (!isSupabaseDbConfigured()) return false;
  const q = await supabaseDbRequest('registration_tasks',
    'select=id&case_id=eq.' + encodeURIComponent(caseId) + '&related_document_key=eq.' + encodeURIComponent(docKey) + '&status=in.(open,in_progress,waiting)&limit=1');
  return q.ok && Array.isArray(q.data) && q.data.length > 0;
}

// ══════════════════════════════════════════════
// VA Dashboard helpers — WhatsApp, nudges, ticket mirror, qualification lookup
// ══════════════════════════════════════════════

const HAZEL_WHATSAPP_NUMBER = String(process.env.HAZEL_WHATSAPP_NUMBER || '+61494391968')
  .replace(/[^\d+]/g, '') || '+61494391968';

// Stage/substage → nudge copy the GP sees in-app.
// Keyed as `${stage}` or `${stage}:${substage}`; first match wins.
const NUDGE_TEMPLATES = {
  'myintealth:create_account': {
    title: 'Need a hand creating your MyIntealth account?',
    body: 'Are you having trouble creating your MyIntealth account? Submit a ticket or message your dedicated support expert Hazel via WhatsApp.'
  },
  'myintealth:account_establishment': {
    title: 'Trouble establishing your MyIntealth account?',
    body: 'Are you having trouble establishing your MyIntealth account? Submit a ticket or message your dedicated support expert Hazel via WhatsApp.'
  },
  'myintealth:upload_qualifications': {
    title: 'Stuck uploading your qualifications?',
    body: 'Are you having trouble uploading your qualification documents? Submit a ticket or message your dedicated support expert Hazel via WhatsApp.'
  },
  'myintealth:verification_issued': {
    title: 'Waiting on EPIC verification?',
    body: 'Still waiting on EPIC verification? Submit a ticket or message your dedicated support expert Hazel via WhatsApp.'
  },
  'myintealth': {
    title: 'Need help with MyIntealth?',
    body: 'Are you having trouble with your MyIntealth step? Submit a ticket or message your dedicated support expert Hazel via WhatsApp.'
  },
  'amc:create_portfolio': {
    title: 'Need help creating your AMC portfolio?',
    body: 'Are you having trouble creating your AMC portfolio? Submit a ticket or message your dedicated support expert Hazel via WhatsApp.'
  },
  'amc:upload_credentials': {
    title: 'Stuck uploading AMC credentials?',
    body: 'Are you having trouble uploading your AMC credentials? Submit a ticket or message your dedicated support expert Hazel via WhatsApp.'
  },
  'amc:waiting_verification': {
    title: 'Waiting on AMC verification?',
    body: 'Still waiting on AMC to verify your credentials? We can help chase this up — submit a ticket or message Hazel via WhatsApp.'
  },
  'amc': {
    title: 'Need help with AMC?',
    body: 'Are you having trouble with your AMC step? Submit a ticket or message your dedicated support expert Hazel via WhatsApp.'
  },
  '_default': {
    title: 'Need a hand with your current step?',
    body: 'Are you having trouble with your current step? Submit a ticket or message your dedicated support expert Hazel via WhatsApp.'
  }
};

function resolveNudgeTemplate(stage, substage) {
  const key = stage && substage ? (stage + ':' + substage) : null;
  if (key && NUDGE_TEMPLATES[key]) return NUDGE_TEMPLATES[key];
  if (stage && NUDGE_TEMPLATES[stage]) return NUDGE_TEMPLATES[stage];
  return NUDGE_TEMPLATES._default;
}

function buildWhatsAppLink(stageLabel, gpFirstName) {
  const nameBit = gpFirstName ? (', I\'m ' + gpFirstName) : '';
  const stageBit = stageLabel ? (' on the ' + stageLabel + ' step') : '';
  const msg = 'Hi Hazel' + nameBit + '.' + stageBit + ' I need some help with my GP Link application.';
  const digits = HAZEL_WHATSAPP_NUMBER.replace(/[^\d]/g, '');
  return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(msg);
}

/**
 * Send a WhatsApp template message via DoubleTick API.
 * Non-blocking: logs failures but does not throw, so caller workflows are not interrupted.
 *
 * @param {string} toPhone - GP phone number (will be normalised to E.164)
 * @param {string} stage - Registration stage key (e.g. 'amc', 'visa')
 * @param {string} gpFirstName - GP first name for template personalisation
 * @returns {Promise<{ok:boolean, messageId?:string}>}
 */
async function sendDoubleTickTemplate(toPhone, stage, gpFirstName) {
  if (!DOUBLETICK_API_KEY) {
    console.warn('[doubletick] DOUBLETICK_API_KEY not set — skipping send');
    return { ok: false };
  }
  const normalised = normalizePhone(toPhone);
  if (!normalised) {
    console.warn('[doubletick] Cannot normalise phone:', toPhone);
    return { ok: false };
  }

  let apiPath, reqBody;

  const fromNumber = HAZEL_WHATSAPP_NUMBER.replace(/[^\d]/g, '');

  if (DOUBLETICK_USE_DIRECT_TEXT) {
    // Direct text message — no template approval needed (testing mode)
    const msgTpl = DOUBLETICK_STAGE_MESSAGES[stage];
    if (!msgTpl) {
      console.warn('[doubletick] No direct message configured for stage:', stage);
      return { ok: false };
    }
    const text = msgTpl.replace(/\{\{name\}\}/g, gpFirstName || 'there');
    apiPath = '/whatsapp/message/text';
    reqBody = JSON.stringify({
      messages: [{
        to: normalised,
        from: fromNumber,
        content: { text: text }
      }]
    });
  } else {
    // Approved template message (production mode)
    const tpl = DOUBLETICK_STAGE_TEMPLATES[stage];
    if (!tpl) {
      console.warn('[doubletick] No template configured for stage:', stage);
      return { ok: false };
    }
    apiPath = '/whatsapp/message/template';
    reqBody = JSON.stringify({
      messages: [{
        to: normalised,
        from: fromNumber,
        templateName: tpl.templateName,
        language: tpl.language || 'en',
        templateData: {
          body: {
            placeholders: [gpFirstName || 'there']
          }
        }
      }]
    });
  }

  try {
    const resp = await fetch(DOUBLETICK_BASE_URL + apiPath, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(DOUBLETICK_API_KEY).toString('base64'),
        'Content-Type': 'application/json'
      },
      body: reqBody
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error('[doubletick] Send failed:', resp.status, JSON.stringify(data).slice(0, 500));
      return { ok: false };
    }
    const messageId = data && data.messages && data.messages[0] && data.messages[0].id;
    console.log('[doubletick]', DOUBLETICK_USE_DIRECT_TEXT ? 'Text' : 'Template', 'sent to', normalised, 'stage:', stage, 'msgId:', messageId || 'n/a');
    return { ok: true, messageId: messageId || null };
  } catch (err) {
    console.error('[doubletick] Send error:', err && err.message);
    return { ok: false };
  }
}

// Dual-write a ticket into the new support_tickets table from the legacy
// gpLinkSupportCases JSON shape. Idempotent on (user_id, source_ticket_id).
async function upsertSupportTicketFromLegacy(userId, caseId, legacyTicket, stage, substage) {
  if (!isSupabaseDbConfigured() || !userId || !legacyTicket || !legacyTicket.id) return null;
  const body = [{
    user_id: userId,
    case_id: caseId || null,
    source_ticket_id: String(legacyTicket.id),
    case_code: legacyTicket.caseCode || null,
    title: String(legacyTicket.title || 'Support request').slice(0, 200),
    body: Array.isArray(legacyTicket.thread) && legacyTicket.thread[0] && legacyTicket.thread[0].text
      ? String(legacyTicket.thread[0].text).slice(0, 5000) : null,
    category: ['EPIC','AMC','Documents','AHPRA','Provider','Contract','Qualification','Other'].includes(legacyTicket.category) ? legacyTicket.category : 'Other',
    stage: stage || null,
    substage: substage || null,
    priority: ['urgent','high','normal','low','blocked','time_sensitive'].includes(legacyTicket.priority) ? legacyTicket.priority : 'normal',
    status: legacyTicket.status === 'closed' ? 'closed' : 'open',
    thread_json: Array.isArray(legacyTicket.thread) ? legacyTicket.thread : [],
    created_at: legacyTicket.createdAt || new Date().toISOString(),
    updated_at: legacyTicket.updatedAt || new Date().toISOString()
  }];
  const r = await supabaseDbRequest('support_tickets', 'on_conflict=user_id,source_ticket_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: body
  });
  return r.ok && Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : null;
}

// Required qualifications per country → used by the VA dashboard to show
// "Approved by AI" vs "VA needs to submit" for a given GP.
const VA_REQUIRED_QUALS_BY_COUNTRY = {
  GB: [
    { key: 'primary_medical_degree', label: 'Primary Medical Degree' },
    { key: 'mrcgp_certified', label: 'MRCGP Certificate' },
    { key: 'cct_certified', label: 'CCT Certificate' }
  ],
  IE: [
    { key: 'primary_medical_degree', label: 'Primary Medical Degree' },
    { key: 'micgp_certified', label: 'MICGP Certificate' },
    { key: 'cscst_certified', label: 'CSCST Certificate' }
  ],
  NZ: [
    { key: 'primary_medical_degree', label: 'Primary Medical Degree' },
    { key: 'frnzcgp_certified', label: 'FRNZCGP Certificate' }
  ]
};

async function getUserQualificationSnapshot(userId, country) {
  if (!isSupabaseDbConfigured() || !userId) return { country: country || null, required: [], approved: [], uploaded_unverified: [], missing: [] };
  const countryCode = (country || 'GB').toUpperCase();
  const required = VA_REQUIRED_QUALS_BY_COUNTRY[countryCode] || VA_REQUIRED_QUALS_BY_COUNTRY.GB;
  const docsRes = await supabaseDbRequest(
    'user_documents',
    'select=document_key,status,file_name,updated_at,storage_path&user_id=eq.' + encodeURIComponent(userId) + '&country_code=eq.' + encodeURIComponent(countryCode)
  );
  const docs = docsRes.ok && Array.isArray(docsRes.data) ? docsRes.data : [];
  const docByKey = {};
  docs.forEach(function (d) { if (d && d.document_key) docByKey[d.document_key] = d; });
  const approved = [];
  const uploaded_unverified = [];
  const missing = [];
  for (const r of required) {
    const d = docByKey[r.key];
    if (!d) { missing.push(r); continue; }
    if (d.status === 'verified' || d.status === 'approved') {
      approved.push(Object.assign({}, r, {
        file_name: d.file_name,
        updated_at: d.updated_at,
        download_url: '/api/onboarding-documents/download?country=' + encodeURIComponent(countryCode) + '&key=' + encodeURIComponent(r.key)
      }));
    } else {
      uploaded_unverified.push(Object.assign({}, r, { file_name: d.file_name, status: d.status, updated_at: d.updated_at }));
    }
  }
  return { country: countryCode, required: required, approved: approved, uploaded_unverified: uploaded_unverified, missing: missing };
}

async function processRegistrationTaskAutomation(userId, email, prevState, nextState) {
  if (!isSupabaseDbConfigured()) return;
  try {
    const regCase = await _ensureRegCase(userId);
    if (!regCase) return;
    const caseId = regCase.id;

    // Fetch GP profile for DoubleTick WhatsApp template sends on stage advance
    let _gpProfile = null;
    const _gpRes = await supabaseDbRequest('user_profiles', 'select=first_name,phone,phone_number&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
    if (_gpRes.ok && Array.isArray(_gpRes.data) && _gpRes.data[0]) _gpProfile = _gpRes.data[0];
    const _gpPhone = _gpProfile ? (_gpProfile.phone || _gpProfile.phone_number || '') : '';
    const _gpFirstName = _gpProfile ? (_gpProfile.first_name || '') : '';

    const prev = {
      epic: _parseStateVal(prevState.gp_epic_progress),
      amc: _parseStateVal(prevState.gp_amc_progress),
      ahpra: _parseStateVal(prevState.gp_ahpra_progress),
      career: _parseStateVal(prevState.gp_career_state),
      docs: _parseStateVal(prevState.gp_documents_prep),
      tickets: (function () { const v = prevState.gpLinkSupportCases; if (Array.isArray(v)) return v; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } } return []; })()
    };
    const nxt = {
      epic: _parseStateVal(nextState.gp_epic_progress),
      amc: _parseStateVal(nextState.gp_amc_progress),
      ahpra: _parseStateVal(nextState.gp_ahpra_progress),
      career: _parseStateVal(nextState.gp_career_state),
      docs: _parseStateVal(nextState.gp_documents_prep),
      tickets: (function () { const v = nextState.gpLinkSupportCases; if (Array.isArray(v)) return v; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } } return []; })()
    };

    const pc = prev.epic.completed || {};
    const nc = nxt.epic.completed || {};

    // ── MyIntealth welcome — send when GP first starts (epic progress appears for the first time) ──
    const prevHasEpic = prev.epic && prev.epic.stage;
    const nextHasEpic = nxt.epic && nxt.epic.stage;
    if (!prevHasEpic && nextHasEpic && _gpPhone) {
      await sendDoubleTickTemplate(_gpPhone, 'myintealth', _gpFirstName);
      await _logCaseEvent(caseId, null, 'system', 'MyIntealth started — WhatsApp template sent', null, 'system');
    }

    // ── MyIntealth substep transitions ──
    const epicLabels = { create_account: 'Confirm MyIntealth account created', account_establishment: 'Verify account establishment documents', upload_qualifications: 'Review uploaded qualification documents', verification_issued: 'Confirm EPIC verification issued' };
    for (const key of ['create_account', 'account_establishment', 'upload_qualifications', 'verification_issued']) {
      if (!pc[key] && nc[key] === true) {
        if (!(await _hasOpenTask(caseId, 'myintealth', 'verify'))) {
          await _createRegTask(caseId, { task_type: 'verify', title: epicLabels[key], priority: key === 'upload_qualifications' ? 'high' : 'normal', source_trigger: 'gp_state_change', related_stage: 'myintealth', related_substage: key, _actor: 'system' });
        }
        if (key === 'verification_issued') {
          const ot = await supabaseDbRequest('registration_tasks', 'select=id&case_id=eq.' + encodeURIComponent(caseId) + '&related_stage=eq.myintealth&status=in.(open,in_progress,waiting)');
          if (ot.ok && Array.isArray(ot.data)) { for (const t of ot.data) await _completeRegTask(t.id, caseId, 'system'); }
          // Send WhatsApp template via DoubleTick instead of creating a kickoff task
          if (_gpPhone) await sendDoubleTickTemplate(_gpPhone, 'amc', _gpFirstName);
          await _logCaseEvent(caseId, null, 'system', 'AMC stage started — WhatsApp template sent', null, 'system');
        }
      }
    }

    // ── AMC transitions ──
    const pac = prev.amc.completed || {};
    const nac = nxt.amc.completed || {};
    const amcLabels = { create_portfolio: 'Confirm AMC portfolio created', upload_credentials: 'Review AMC credentials uploaded', waiting_verification: 'Monitor AMC verification progress', qualifications_verified: 'Confirm AMC qualifications verified' };
    for (const key of ['create_portfolio', 'upload_credentials', 'waiting_verification', 'qualifications_verified']) {
      if (!pac[key] && nac[key] === true) {
        if (!(await _hasOpenTask(caseId, 'amc', 'verify'))) {
          await _createRegTask(caseId, { task_type: 'verify', title: amcLabels[key], priority: key === 'upload_credentials' ? 'high' : 'normal', source_trigger: 'gp_state_change', related_stage: 'amc', related_substage: key, _actor: 'system' });
        }
        if (key === 'qualifications_verified') {
          const ot = await supabaseDbRequest('registration_tasks', 'select=id&case_id=eq.' + encodeURIComponent(caseId) + '&related_stage=eq.amc&status=in.(open,in_progress,waiting)');
          if (ot.ok && Array.isArray(ot.data)) { for (const t of ot.data) await _completeRegTask(t.id, caseId, 'system'); }
          // Send WhatsApp template via DoubleTick instead of creating a kickoff task
          if (_gpPhone) await sendDoubleTickTemplate(_gpPhone, 'career', _gpFirstName);
          await _logCaseEvent(caseId, null, 'system', 'Career stage started — WhatsApp template sent', null, 'system');
        }
      }
    }

    // ── Career secured ──
    let prevSecured = prev.career.career_secured === true || prev.career.secured === true;
    if (!prevSecured && Array.isArray(prev.career.applications)) { prevSecured = prev.career.applications.some(function (a) { return a && a.isPlacementSecured === true; }); }
    let nextSecured = nxt.career.career_secured === true || nxt.career.secured === true;
    if (!nextSecured && Array.isArray(nxt.career.applications)) { nextSecured = nxt.career.applications.some(function (a) { return a && a.isPlacementSecured === true; }); }
    if (!prevSecured && nextSecured) {
      const ot = await supabaseDbRequest('registration_tasks', 'select=id&case_id=eq.' + encodeURIComponent(caseId) + '&related_stage=eq.career&status=in.(open,in_progress,waiting)');
      if (ot.ok && Array.isArray(ot.data)) { for (const t of ot.data) await _completeRegTask(t.id, caseId, 'system'); }
      await _createRegTask(caseId, { task_type: 'verify', title: 'Verify secured placement with practice', priority: 'high', source_trigger: 'career_secured', related_stage: 'career', _actor: 'system' });
      if (!(await _hasOpenTask(caseId, 'career', 'practice_pack'))) {
        const parent = await _createRegTask(caseId, { task_type: 'practice_pack', title: 'Complete practice pack', source_trigger: 'career_secured', related_stage: 'career', _actor: 'system' });
        if (parent) {
          const packLabels = { sppa_00: 'SPPA-00', section_g: 'Section G', position_description: 'Position Description', offer_contract: 'Offer / Contract', supervisor_cv: 'Supervisor CV' };
          for (const dk of Object.keys(packLabels)) {
            await _createRegTask(caseId, { task_type: 'practice_pack_child', title: packLabels[dk], parent_task_id: parent.id, source_trigger: 'career_secured', related_stage: 'career', related_document_key: dk, _actor: 'system' });
          }
        }
      }
      // Send WhatsApp template via DoubleTick instead of creating a kickoff task
      if (_gpPhone) await sendDoubleTickTemplate(_gpPhone, 'ahpra', _gpFirstName);
      await _logCaseEvent(caseId, null, 'system', 'AHPRA stage unlocked — WhatsApp template sent', null, 'system');
    }

    // ── Document uploads ──
    const prevDocs = prev.docs.docs || {};
    const nextDocs = nxt.docs.docs || {};
    for (const key of Object.keys(nextDocs)) {
      const pv = prevDocs[key] || {};
      const nv = nextDocs[key] || {};
      if (nv.uploaded === true && !pv.uploaded) {
        if (!(await _hasOpenTaskForDoc(caseId, key))) {
          await _createRegTask(caseId, { task_type: 'review', title: 'Review uploaded: ' + key.replace(/_/g, ' '), source_trigger: 'doc_upload', related_stage: 'ahpra', related_document_key: key, _actor: 'system' });
        }
      }
    }

    // ── AHPRA transitions ──
    const phc = prev.ahpra.completed || {};
    const nhc = nxt.ahpra.completed || {};
    const ahpraLabels = { create_account: 'Confirm AHPRA account created', account_establishment: 'Verify AHPRA profile details', upload_qualifications: 'Confirm all AHPRA supporting docs ready', waiting_verification: 'Monitor AHPRA assessment', verification_issued: 'Verify AHPRA registration outcome' };
    for (const key of ['create_account', 'account_establishment', 'upload_qualifications', 'waiting_verification', 'verification_issued']) {
      if (!phc[key] && nhc[key] === true) {
        if (!(await _hasOpenTask(caseId, 'ahpra', 'verify'))) {
          await _createRegTask(caseId, { task_type: 'verify', title: ahpraLabels[key], priority: key === 'upload_qualifications' ? 'high' : 'normal', source_trigger: 'gp_state_change', related_stage: 'ahpra', related_substage: key, _actor: 'system' });
        }
        if (key === 'verification_issued') {
          const ot = await supabaseDbRequest('registration_tasks', 'select=id&case_id=eq.' + encodeURIComponent(caseId) + '&related_stage=eq.ahpra&status=in.(open,in_progress,waiting)');
          if (ot.ok && Array.isArray(ot.data)) { for (const t of ot.data) await _completeRegTask(t.id, caseId, 'system'); }
          // Send WhatsApp template via DoubleTick instead of creating a kickoff task
          if (_gpPhone) await sendDoubleTickTemplate(_gpPhone, 'visa', _gpFirstName);
          await _logCaseEvent(caseId, null, 'system', 'Visa stage started — WhatsApp template sent', null, 'system');
        }
      }
    }

    // ── New support tickets ──
    const prevTids = new Set(Array.isArray(prev.tickets) ? prev.tickets.map(function (t) { return t && t.id; }).filter(Boolean) : []);
    if (Array.isArray(nxt.tickets)) {
      const derivedStage = _deriveStageFromState(nextState);
      for (const ticket of nxt.tickets) {
        if (ticket && ticket.id && !prevTids.has(ticket.id) && ticket.status !== 'closed') {
          await _createRegTask(caseId, { task_type: 'blocker', title: 'Support ticket: ' + (ticket.title || 'New request'), priority: ticket.priority === 'urgent' ? 'urgent' : 'high', source_trigger: 'ticket_created', related_stage: derivedStage, related_ticket_id: ticket.id, _actor: 'system' });
        }
        // Dual-write (idempotent) into support_tickets so VA dashboard + closed tab work against a real table
        if (ticket && ticket.id) {
          try { await upsertSupportTicketFromLegacy(userId, caseId, ticket, derivedStage, null); }
          catch (e) { console.error('[SupportTickets] dual-write error:', e && e.message); }
        }
      }
    }

    // ── Update case stage ──
    const newStage = _deriveStageFromState(nextState);
    const caseUpdate = { last_gp_activity_at: new Date().toISOString() };
    if (newStage !== regCase.stage) { caseUpdate.stage = newStage; }
    await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(caseId), { method: 'PATCH', body: caseUpdate });
    if (newStage !== regCase.stage) {
      await _logCaseEvent(caseId, null, 'stage_change', 'Stage advanced to ' + newStage, null, 'system');
    }
  } catch (err) {
    // Non-blocking: do not fail the state update
  }
}

// ══════════════════════════════════════════════════════════════════
// VA Unified Operations Helpers
// ══════════════════════════════════════════════════════════════════

const VA_TASK_DOMAINS = ['registration', 'visa', 'questionnaire', 'sponsor', 'document', 'system'];
const VA_TASK_TYPES_EXTENDED = [
  'kickoff','verify','review','followup','blocker','escalation',
  'practice_pack','practice_pack_child','manual','system',
  'visa_stage','visa_doc','questionnaire','sponsor','migration_agent',
  'sla_overdue','chase','document_ops','whatsapp_help'
];
const VA_TASK_STATUSES_EXTENDED = [
  'open','in_progress','waiting','completed','cancelled',
  'waiting_on_gp','waiting_on_practice','waiting_on_external','blocked'
];
const QUESTIONNAIRE_STATUSES = ['draft','submitted','returned_for_changes','va_reviewed','ready_to_send','sent'];
const QUESTIONNAIRE_ROUTES = ['gplink_migration_agent','practice_agent','practice_direct'];
const PRACTICE_DOC_KEYS = ['sppa_00','section_g','position_description','offer_contract','supervisor_cv'];
const PRACTICE_DOC_OPS_STATUSES = ['not_requested','requested','awaiting_practice','received','under_review','needs_correction','ready_for_gp','completed'];
const SLA_DEFAULT_DAYS = {
  gp_inactivity: 5,
  practice_response: 5,
  sponsor_response: 5,
  task_overdue: 7,
  questionnaire_completion: 7
};

async function _createVaTask(caseId, data) {
  if (!isSupabaseDbConfigured()) return null;
  const actor = data._actor || 'system';
  const domain = data.domain || 'visa';
  const payload = { case_id: caseId, domain: domain };
  for (const [k, v] of Object.entries(data)) { if (k !== '_actor') payload[k] = v; }
  if (!payload.task_type) payload.task_type = 'manual';
  if (!payload.status) payload.status = 'open';
  if (!payload.priority) payload.priority = 'normal';
  const r = await supabaseDbRequest('registration_tasks', '', {
    method: 'POST', headers: { Prefer: 'return=representation' }, body: [payload]
  });
  const task = r.ok && Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : null;
  if (task) {
    await supabaseDbRequest('task_timeline', '', {
      method: 'POST', body: [{ task_id: task.id, case_id: caseId, domain: domain, visa_case_id: data.visa_case_id || null, event_type: 'created', title: 'Task created', detail: task.title, actor: actor }]
    });
  }
  return task;
}

async function _linkVisaCaseToRegCase(userId, visaCaseId) {
  if (!isSupabaseDbConfigured()) return;
  const regCase = await _ensureRegCase(userId);
  if (!regCase) return;
  if (regCase.visa_case_id === visaCaseId) return;
  await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(regCase.id), {
    method: 'PATCH', body: { visa_case_id: visaCaseId }
  });
}

async function _getRegCaseForUser(userId) {
  if (!isSupabaseDbConfigured()) return null;
  const q = await supabaseDbRequest('registration_cases', 'select=*&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
  return q.ok && Array.isArray(q.data) && q.data.length > 0 ? q.data[0] : null;
}

async function _hasOpenTaskByDomain(caseId, domain, taskType) {
  if (!isSupabaseDbConfigured()) return false;
  let query = 'select=id&case_id=eq.' + encodeURIComponent(caseId) + '&domain=eq.' + encodeURIComponent(domain) + '&status=in.(open,in_progress,waiting,waiting_on_gp,waiting_on_practice,waiting_on_external)&limit=1';
  if (taskType) query += '&task_type=eq.' + encodeURIComponent(taskType);
  const q = await supabaseDbRequest('registration_tasks', query);
  return q.ok && Array.isArray(q.data) && q.data.length > 0;
}

async function processVisaTaskAutomation(visaCaseId, userId, changes, actor) {
  if (!isSupabaseDbConfigured()) return;
  try {
    const regCase = await _ensureRegCase(userId);
    if (!regCase) return;
    const caseId = regCase.id;

    // Link visa case to reg case
    await _linkVisaCaseToRegCase(userId, visaCaseId);

    // Stage change
    if (changes.stage) {
      const stageLabels = { nomination: 'Nomination', lodgement: 'Lodgement', processing: 'Processing', granted: 'Granted', refused: 'Refused' };
      const label = stageLabels[changes.stage] || changes.stage;

      // Complete prior visa_stage tasks
      const priorTasks = await supabaseDbRequest('registration_tasks',
        'select=id&case_id=eq.' + encodeURIComponent(caseId) + '&domain=eq.visa&task_type=eq.visa_stage&status=in.(open,in_progress,waiting,waiting_on_gp,waiting_on_practice,waiting_on_external)');
      if (priorTasks.ok && Array.isArray(priorTasks.data)) {
        for (const t of priorTasks.data) await _completeRegTask(t.id, caseId, actor || 'system');
      }

      // Create new stage task
      await _createVaTask(caseId, {
        task_type: 'visa_stage', title: 'Verify ' + label + ' milestone',
        domain: 'visa', visa_case_id: visaCaseId,
        priority: changes.stage === 'granted' ? 'high' : 'normal',
        source_trigger: 'visa_stage_change', related_stage: 'visa',
        related_substage: changes.stage, _actor: actor || 'system'
      });

      // Log timeline
      await _logCaseEvent(caseId, null, 'visa_stage_change', 'Visa stage: ' + label, null, actor || 'system');
    }

    // Sponsor changes
    if (changes.sponsorName || changes.sponsorContact) {
      if (!(await _hasOpenTaskByDomain(caseId, 'sponsor', 'sponsor'))) {
        await _createVaTask(caseId, {
          task_type: 'sponsor', title: 'Confirm sponsor details',
          domain: 'sponsor', visa_case_id: visaCaseId,
          source_trigger: 'sponsor_update', related_stage: 'visa', _actor: actor || 'system'
        });
      }
    }
  } catch (err) {
    // Non-blocking
  }
}

async function processQuestionnaireTaskAutomation(caseId, visaCaseId, status, actor) {
  if (!isSupabaseDbConfigured()) return;
  try {
    const statusLabels = {
      submitted: 'Review visa intake questionnaire',
      returned_for_changes: 'Chase questionnaire completion',
      va_reviewed: 'Generate questionnaire PDF',
      ready_to_send: 'Send questionnaire',
      sent: null
    };
    const title = statusLabels[status];
    if (!title) return;

    // Complete prior questionnaire tasks
    const priorTasks = await supabaseDbRequest('registration_tasks',
      'select=id&case_id=eq.' + encodeURIComponent(caseId) + '&domain=eq.questionnaire&status=in.(open,in_progress,waiting,waiting_on_gp,waiting_on_practice,waiting_on_external)');
    if (priorTasks.ok && Array.isArray(priorTasks.data)) {
      for (const t of priorTasks.data) await _completeRegTask(t.id, caseId, actor || 'system');
    }

    // Create new task
    const priority = status === 'submitted' ? 'high' : 'normal';
    await _createVaTask(caseId, {
      task_type: 'questionnaire', title: title,
      domain: 'questionnaire', visa_case_id: visaCaseId,
      priority: priority, source_trigger: 'questionnaire_' + status,
      related_stage: 'visa', _actor: actor || 'system'
    });
  } catch (err) {
    // Non-blocking
  }
}

async function runSlaCheck(actor) {
  if (!isSupabaseDbConfigured()) return { checked: 0, created: 0 };
  const now = new Date();
  let created = 0;

  // Find cases with no GP activity in SLA_DEFAULT_DAYS.gp_inactivity business days
  const staleDays = SLA_DEFAULT_DAYS.gp_inactivity;
  const staleDate = new Date(now.getTime() - staleDays * 24 * 60 * 60 * 1000);
  const staleCases = await supabaseDbRequest('registration_cases',
    'select=id,user_id,stage,last_gp_activity_at&status=eq.active&last_gp_activity_at=lt.' + staleDate.toISOString());
  if (staleCases.ok && Array.isArray(staleCases.data)) {
    for (const c of staleCases.data) {
      if (!(await _hasOpenTaskByDomain(c.id, 'system', 'sla_overdue'))) {
        await _createVaTask(c.id, {
          task_type: 'sla_overdue', title: 'Follow up: no GP activity for ' + staleDays + ' days',
          domain: 'system', priority: 'high',
          source_trigger: 'sla_check', related_stage: c.stage,
          sla_due_date: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
          _actor: actor || 'system'
        });
        created++;
      }
    }
  }

  // Find tasks past due date
  const overdueTasks = await supabaseDbRequest('registration_tasks',
    'select=id,case_id&status=in.(open,in_progress,waiting,waiting_on_gp,waiting_on_practice,waiting_on_external)&due_date=lt.' + now.toISOString().slice(0, 10) + '&limit=100');
  const checked = (staleCases.ok ? (staleCases.data || []).length : 0) + (overdueTasks.ok ? (overdueTasks.data || []).length : 0);

  return { checked, created };
}

function generateQuestionnairePdf(questionnaire, gpProfile, visaCase) {
  let PDFDocument;
  try { PDFDocument = require('pdfkit'); } catch (e) { return null; }

  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  const chunks = [];
  doc.on('data', function (chunk) { chunks.push(chunk); });

  const data = questionnaire.data || {};
  const primary = data.primary || {};
  const partner = data.partner || {};
  const children = Array.isArray(data.children) ? data.children : [];

  // Header
  doc.fontSize(20).font('Helvetica-Bold').text('GP Link', { align: 'center' });
  doc.fontSize(10).font('Helvetica').text('Visa Intake Questionnaire', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(8).fillColor('#666666')
    .text('Generated: ' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC | Version: ' + (questionnaire.version || 1), { align: 'center' });
  doc.fillColor('#000000');
  doc.moveDown(0.3);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#cccccc');
  doc.moveDown(0.5);

  // Case info
  const gpName = gpProfile ? [(gpProfile.first_name || ''), (gpProfile.last_name || '')].join(' ').trim() : 'Unknown';
  doc.fontSize(9).font('Helvetica-Bold').text('GP: ', { continued: true }).font('Helvetica').text(gpName);
  if (visaCase) {
    if (visaCase.sponsor_name) doc.font('Helvetica-Bold').text('Sponsor: ', { continued: true }).font('Helvetica').text(visaCase.sponsor_name);
    if (visaCase.visa_subclass) doc.font('Helvetica-Bold').text('Visa Subclass: ', { continued: true }).font('Helvetica').text(visaCase.visa_subclass);
    if (visaCase.reference_number) doc.font('Helvetica-Bold').text('Reference: ', { continued: true }).font('Helvetica').text(visaCase.reference_number);
  }
  doc.moveDown(0.8);

  function addSection(title) {
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a365d').text(title);
    doc.fillColor('#000000');
    doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).stroke('#2b6cb0');
    doc.moveDown(0.5);
  }

  function addField(label, value) {
    if (value === undefined || value === null || value === '') return;
    const displayVal = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
    doc.fontSize(9).font('Helvetica-Bold').text(label + ': ', { continued: true }).font('Helvetica').text(displayVal);
  }

  function addCountryList(label, countries) {
    if (!Array.isArray(countries) || countries.length === 0) return;
    const list = countries.map(function (c) {
      return (c.country || 'Unknown') + (c.from ? ' (' + c.from + ' – ' + (c.to || 'present') + ')' : '');
    }).join('; ');
    addField(label, list);
  }

  // Primary applicant
  addSection('Primary Applicant');
  addField('First Name', primary.firstName);
  addField('Middle Names', primary.middleNames);
  addField('Last Name', primary.lastName);
  addField('Date of Birth', primary.dateOfBirth);
  addField('Sex', primary.sex);
  addField('Place of Birth', primary.placeOfBirth);
  addField('Passport Number', primary.passportNumber);
  addField('Passport Issue Date', primary.passportIssueDate);
  addField('Passport Expiry Date', primary.passportExpiryDate);
  addField('Passport Issuing Authority', primary.passportIssuingAuthority);
  addField('Mobile Phone', primary.mobilePhone);
  addField('Residential Address', primary.residentialAddress);
  addField('Usual Occupation', primary.usualOccupation);
  addCountryList('Countries Lived In (12+ months, last 10 years)', primary.countriesLivedIn);
  addField('Previously Married/Divorced', primary.previouslyMarried);
  addField('Serious Medical Conditions', primary.seriousMedicalConditions);
  addField('Criminal Record', primary.criminalRecord);
  addField('Military Service', primary.militaryService);
  addField('English Test in Last 3 Years', primary.englishTestRecent);
  doc.moveDown(0.8);

  // Partner
  if (partner && (partner.firstName || partner.lastName)) {
    addSection('Secondary Applicant / Partner');
    addField('First Name', partner.firstName);
    addField('Middle Names', partner.middleNames);
    addField('Last Name', partner.lastName);
    addField('Passport Number', partner.passportNumber);
    addField('Passport Issue Date', partner.passportIssueDate);
    addField('Passport Expiry Date', partner.passportExpiryDate);
    addField('Passport Issuing Authority', partner.passportIssuingAuthority);
    addField('Date of Birth', partner.dateOfBirth);
    addField('Sex', partner.sex);
    addField('Place of Birth', partner.placeOfBirth);
    addField('Mobile Phone', partner.mobilePhone);
    addField('Usual Occupation', partner.usualOccupation);
    addCountryList('Countries Lived In', partner.countriesLivedIn);
    addField('Previously Married/Divorced', partner.previouslyMarried);
    addField('Serious Medical Conditions', partner.seriousMedicalConditions);
    addField('Criminal Record', partner.criminalRecord);
    addField('Military Service', partner.militaryService);
    addField('In Australia: Attending/Teaching Classes', partner.auAttendingClasses);
    addField('In Australia: Working in Healthcare', partner.auWorkingHealthcare);
    addField('In Australia: Working in Childcare', partner.auWorkingChildcare);
    doc.moveDown(0.8);
  }

  // Children
  if (children.length > 0) {
    addSection('Children');
    children.forEach(function (child, i) {
      doc.fontSize(10).font('Helvetica-Bold').text('Child ' + (i + 1));
      addField('First Name', child.firstName);
      addField('Middle Names', child.middleNames);
      addField('Last Name', child.lastName);
      addField('Passport Number', child.passportNumber);
      addField('Passport Issue Date', child.passportIssueDate);
      addField('Passport Expiry Date', child.passportExpiryDate);
      addField('Passport Issuing Authority', child.passportIssuingAuthority);
      addField('Date of Birth', child.dateOfBirth);
      addField('Sex', child.sex);
      addField('Place of Birth', child.placeOfBirth);
      addField('Serious Medical Conditions', child.seriousMedicalConditions);
      addField('Criminal Record', child.criminalRecord);
      addField('Migrating With You', child.migratingWithYou);
      addField('In Australia: Attending Classes', child.auAttendingClasses);
      addField('In Australia: Attending Childcare', child.auAttendingChildcare);
      doc.moveDown(0.4);
    });
  }

  // Footer on each page
  const pageCount = doc.bufferedPageRange().count;
  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(i);
    doc.fontSize(7).fillColor('#999999')
      .text('GP Link Visa Intake Questionnaire — Page ' + (i + 1) + ' of ' + pageCount, 50, 780, { align: 'center' });
  }
  doc.fillColor('#000000');

  doc.end();
  return new Promise(function (resolve) {
    doc.on('end', function () { resolve(Buffer.concat(chunks)); });
  });
}

// Ensure practice_doc_ops records exist for a case
async function _ensurePracticeDocOps(caseId) {
  if (!isSupabaseDbConfigured()) return [];
  const existing = await supabaseDbRequest('practice_doc_ops', 'select=*&case_id=eq.' + encodeURIComponent(caseId));
  const existingKeys = new Set((existing.ok && Array.isArray(existing.data) ? existing.data : []).map(function (d) { return d.document_key; }));
  const toInsert = [];
  for (const key of PRACTICE_DOC_KEYS) {
    if (!existingKeys.has(key)) toInsert.push({ case_id: caseId, document_key: key, ops_status: 'not_requested' });
  }
  if (toInsert.length > 0) {
    await supabaseDbRequest('practice_doc_ops', '', { method: 'POST', body: toInsert });
  }
  const all = await supabaseDbRequest('practice_doc_ops', 'select=*&case_id=eq.' + encodeURIComponent(caseId) + '&order=created_at.asc');
  return all.ok && Array.isArray(all.data) ? all.data : [];
}

function getTimestampMs(value) {
  if (!value) return 0;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function getAdminExecutiveStage(candidate) {
  const progress = Number(candidate && candidate.progressPercent);
  const percent = Number.isFinite(progress) ? progress : 0;
  const label = String(candidate && candidate.currentStepLabel ? candidate.currentStepLabel : '').trim().toLowerCase();

  if (percent >= 100 || label.includes('complete')) return 'complete';
  if (label.includes('ahpra') || percent >= 75) return 'ahpra';
  if (label.includes('document') || percent >= 55) return 'documents';
  if (label.includes('amc') || percent >= 34) return 'amc';
  if (label.includes('epic') || percent >= 13) return 'epic';
  return 'registered';
}

function buildSortedBreakdown(map, limit = 5) {
  return Array.from(map.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.label.localeCompare(b.label);
    })
    .slice(0, limit);
}

function buildAdminExecutiveData(candidates = [], tickets = [], roles = [], applications = []) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const recent30Threshold = nowMs - (30 * DAY_MS);
  const recent7Threshold = nowMs - (7 * DAY_MS);
  const stale7Threshold = nowMs - (7 * DAY_MS);
  const stale14Threshold = nowMs - (14 * DAY_MS);

  const stageDefs = [
    { id: 'registered', label: 'Registered' },
    { id: 'epic', label: 'EPIC' },
    { id: 'amc', label: 'AMC' },
    { id: 'documents', label: 'Documents' },
    { id: 'ahpra', label: 'AHPRA' },
    { id: 'complete', label: 'Completed' }
  ];
  const stageCounts = new Map(stageDefs.map((item) => [item.id, 0]));
  const countryCounts = new Map();
  const actionRequired = [];
  const stale7 = [];
  const stale14 = [];
  const openTicketList = Array.isArray(tickets) ? tickets.filter((item) => item && item.status !== 'closed') : [];
  const urgentTickets = openTicketList.filter((item) => item.priority === 'urgent' || item.priority === 'high');
  const activeCandidates = [];

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || typeof candidate !== 'object') continue;

    const stage = getAdminExecutiveStage(candidate);
    stageCounts.set(stage, (stageCounts.get(stage) || 0) + 1);

    const country = String(candidate.country || '').trim();
    if (country) countryCounts.set(country, (countryCounts.get(country) || 0) + 1);

    if (candidate.status !== 'complete') activeCandidates.push(candidate);
    if (candidate.status === 'action_required') actionRequired.push(candidate);

    const lastActiveMs = getTimestampMs(candidate.lastActiveAt);
    if (candidate.status !== 'complete' && lastActiveMs && lastActiveMs < stale7Threshold) stale7.push(candidate);
    if (candidate.status !== 'complete' && lastActiveMs && lastActiveMs < stale14Threshold) stale14.push(candidate);
  }

  const registrations30d = activeCandidates.filter((candidate) => getTimestampMs(candidate.registeredAt) >= recent30Threshold).length;
  const documentsBacklog = activeCandidates.filter((candidate) => Number(candidate.documentsPending || 0) > 0).length;
  const verificationBacklog = activeCandidates.filter((candidate) => candidate.pendingVerification).length;
  const completedCandidates = Array.isArray(candidates) ? candidates.filter((candidate) => candidate && candidate.status === 'complete').length : 0;

  const activeRoles = Array.isArray(roles) ? roles.filter((item) => item && item.is_active !== false) : [];
  const liveRoles = activeRoles.length;
  const regionalRoles = activeRoles.filter((item) => item.regional).length;
  const metroRoles = activeRoles.filter((item) => item.metro).length;
  const practiceCounts = new Map();
  activeRoles.forEach((role) => {
    const label = String(role.practice_name || role.location_state || role.location_city || 'Unassigned').trim();
    practiceCounts.set(label, (practiceCounts.get(label) || 0) + 1);
  });

  const applicationList = Array.isArray(applications) ? applications : [];
  const applicationsRecent7d = applicationList.filter((item) => getTimestampMs(item.applied_at) >= recent7Threshold).length;
  const applicationsRecent30d = applicationList.filter((item) => getTimestampMs(item.applied_at) >= recent30Threshold).length;
  const applicationStatusCounts = new Map();
  applicationList.forEach((item) => {
    const status = String(item && item.status ? item.status : 'applied').trim() || 'applied';
    applicationStatusCounts.set(status, (applicationStatusCounts.get(status) || 0) + 1);
  });

  const funnel = stageDefs.map((stage) => {
    const count = stageCounts.get(stage.id) || 0;
    const share = candidates.length ? Math.round((count / candidates.length) * 100) : 0;
    return { ...stage, count, share };
  });

  return {
    overview: {
      activePipeline: activeCandidates.length,
      registrations30d,
      liveRoles,
      applications30d: applicationsRecent30d,
      stalled7d: stale7.length,
      stalled14d: stale14.length,
      actionRequired: actionRequired.length,
      urgentTickets: urgentTickets.length,
      activeCountries: countryCounts.size,
      completedCandidates,
      verificationBacklog,
      documentsBacklog
    },
    funnel,
    risk: [
      {
        id: 'stalled_14',
        tone: stale14.length ? 'error' : 'connected',
        label: 'No activity in 14 days',
        value: stale14.length,
        detail: stale14.length ? 'Candidates needing executive intervention or reassignment.' : 'No long-stalled GP files right now.'
      },
      {
        id: 'action_required',
        tone: actionRequired.length ? 'pending' : 'connected',
        label: 'Action required',
        value: actionRequired.length,
        detail: actionRequired.length ? 'Candidates blocked by missing steps or team action.' : 'No candidate is waiting on a manual unblock.'
      },
      {
        id: 'verification_backlog',
        tone: verificationBacklog ? 'pending' : 'connected',
        label: 'Verification backlog',
        value: verificationBacklog,
        detail: verificationBacklog ? 'Files awaiting certificate or qualification review.' : 'Verification queue is under control.'
      },
      {
        id: 'urgent_tickets',
        tone: urgentTickets.length ? 'error' : 'connected',
        label: 'Urgent support tickets',
        value: urgentTickets.length,
        detail: urgentTickets.length ? 'Open high-priority GP issues still in the queue.' : 'No urgent support tickets are open.'
      }
    ],
    countries: buildSortedBreakdown(countryCounts, 5),
    practices: buildSortedBreakdown(practiceCounts, 5),
    roles: {
      live: liveRoles,
      regional: regionalRoles,
      metro: metroRoles
    },
    applications: {
      total: applicationList.length,
      recent7d: applicationsRecent7d,
      recent30d: applicationsRecent30d,
      byStatus: buildSortedBreakdown(applicationStatusCounts, 5)
    }
  };
}

async function getCachedAdminDashboardData() {
  if (ADMIN_DASHBOARD_CACHE_TTL_MS <= 0) {
    return collectAdminDashboardData();
  }

  const nowMs = Date.now();
  if (adminDashboardCache.data && adminDashboardCache.expiresAt > nowMs) {
    return adminDashboardCache.data;
  }

  if (adminDashboardCache.inFlight) {
    return adminDashboardCache.inFlight;
  }

  adminDashboardCache.inFlight = collectAdminDashboardData()
    .then((dashboard) => {
      adminDashboardCache.inFlight = null;
      if (dashboard) {
        adminDashboardCache.data = dashboard;
        adminDashboardCache.expiresAt = Date.now() + ADMIN_DASHBOARD_CACHE_TTL_MS;
      } else {
        invalidateAdminDashboardCache();
      }
      return dashboard;
    })
    .catch((err) => {
      adminDashboardCache.inFlight = null;
      invalidateAdminDashboardCache();
      throw err;
    });

  return adminDashboardCache.inFlight;
}

async function collectAdminDashboardData() {
  if (isSupabaseDbConfigured()) {
    const [profilesResult, statesResult, rolesResult, applicationsResult] = await Promise.all([
      supabaseDbRequest(
        'user_profiles',
        'select=user_id,email,first_name,last_name,phone,registration_country,created_at,updated_at'
      ),
      supabaseDbRequest(
        'user_state',
        'select=user_id,state,updated_at'
      ),
      supabaseDbRequest(
        'career_roles',
        'select=id,practice_name,location_city,location_state,metro,regional,is_active,updated_at'
      ),
      supabaseDbRequest(
        'gp_applications',
        'select=status,applied_at,updated_at,career_role_id'
      )
    ]);

    if (profilesResult.ok && statesResult.ok && Array.isArray(profilesResult.data) && Array.isArray(statesResult.data)) {
      const roles = rolesResult.ok && Array.isArray(rolesResult.data) ? rolesResult.data : [];
      const applications = applicationsResult.ok && Array.isArray(applicationsResult.data) ? applicationsResult.data : [];
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
          executive: buildAdminExecutiveData(candidates, tickets, roles, applications),
          candidates,
          verificationQueue: candidates.filter((item) => item.pendingVerification || item.documentsPending > 0),
          tickets
        };
      }

      return {
        summary: {
          totalGps: 0,
          activeGps: 0,
          pendingVerifications: 0,
          openSupportTickets: 0,
          averageProgress: 0
        },
        executive: buildAdminExecutiveData([], [], rolesResult.ok && Array.isArray(rolesResult.data) ? rolesResult.data : [], applicationsResult.ok && Array.isArray(applicationsResult.data) ? applicationsResult.data : []),
        candidates: [],
        verificationQueue: [],
        tickets: []
      };
    }

    if (REQUIRE_SUPABASE_DB) return null;
  }

  if (REQUIRE_SUPABASE_DB) return null;

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
    executive: buildAdminExecutiveData(candidates, tickets, [], []),
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

async function persistSupportCaseUpdate(ticketId, patch, scope = {}) {
  const scopedEmail = typeof scope.candidateEmail === 'string' ? scope.candidateEmail.trim().toLowerCase() : '';
  const scopedUserId = typeof scope.candidateUserId === 'string' ? scope.candidateUserId.trim() : '';

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
        const rowEmail = String(emailByUserId.get(row.user_id) || '').trim().toLowerCase();
        if (scopedUserId && row.user_id !== scopedUserId) continue;
        if (scopedEmail && rowEmail !== scopedEmail) continue;
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
        invalidateAdminDashboardCache();
        return normalized ? { ...normalized, candidateEmail: emailByUserId.get(row.user_id) || '' } : null;
      }
    }

    return null;
  }

  const allEmails = Object.keys(dbState.userState || {});
  for (const candidateEmail of allEmails) {
    if (scopedEmail && String(candidateEmail || '').trim().toLowerCase() !== scopedEmail) continue;
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
    invalidateAdminDashboardCache();
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

function normalizeUrlBase(value, fallback = '') {
  const input = String(value || '').trim();
  if (!input) return fallback;
  try {
    const parsed = new URL(input);
    return parsed.origin + parsed.pathname.replace(/\/+$/, '');
  } catch (err) {
    return fallback;
  }
}

function sanitizeZohoText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    return value.map(sanitizeZohoText).filter(Boolean).join(', ');
  }
  if (value && typeof value === 'object') {
    if (typeof value.display_value === 'string') return value.display_value.trim();
    if (typeof value.name === 'string') return value.name.trim();
    if (typeof value.value === 'string') return value.value.trim();
    if (typeof value.actual_value === 'string') return value.actual_value.trim();
  }
  return '';
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeZohoSummary(value) {
  return stripHtml(sanitizeZohoText(value)).slice(0, 420);
}

function getZohoField(record, candidates) {
  if (!record || typeof record !== 'object') return '';
  for (const candidate of candidates) {
    const key = String(candidate || '').trim();
    if (!key) continue;
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = sanitizeZohoText(record[key]);
    if (value) return value;
  }
  return '';
}

function getZohoLookupId(record, candidates) {
  if (!record || typeof record !== 'object') return '';
  for (const candidate of candidates) {
    const key = String(candidate || '').trim();
    if (!key || !Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (value && typeof value === 'object') {
      if (typeof value.id === 'string' && value.id.trim()) return value.id.trim();
      if (typeof value.value === 'string' && /^\d{6,}$/.test(value.value.trim())) return value.value.trim();
      if (typeof value.actual_value === 'string' && /^\d{6,}$/.test(value.actual_value.trim())) return value.actual_value.trim();
    }
    if (typeof value === 'string' && /^\d{6,}$/.test(value.trim())) return value.trim();
  }
  return '';
}

function normalizeCareerApplicationStatusKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const SECURED_CAREER_APPLICATION_STATUS_KEYS = new Set([
  'hired',
  'secured',
  'placed',
  'placement_secured',
  'offer_accepted',
  'contract_signed'
]);

function isCareerPlacementSecuredStatus(value) {
  return SECURED_CAREER_APPLICATION_STATUS_KEYS.has(normalizeCareerApplicationStatusKey(value));
}

function normalizePlacementStartDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

function buildInitials(value) {
  const parts = String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  if (parts.length === 0) return 'MC';
  return parts.map((part) => part.charAt(0).toUpperCase()).join('');
}

function buildZohoDisplayName(record) {
  const direct = getZohoField(record, ['Full_Name', 'Contact_Name', 'Name']);
  if (direct) return direct;
  const combined = [getZohoField(record, ['First_Name']), getZohoField(record, ['Last_Name'])].filter(Boolean).join(' ').trim();
  return combined;
}

function choosePreferredZohoPhone(record) {
  return getZohoField(record, ['Mobile', 'Phone', 'Work_Phone', 'WorkPhone', 'Office_Phone']);
}

function buildCareerContractCacheKey(applicationId) {
  return `career_contract_extract:${String(applicationId || '').trim()}`;
}

function parseBooleanish(value) {
  const normalized = sanitizeZohoText(value).toLowerCase();
  if (!normalized) return false;
  return ['true', 'yes', 'y', '1', 'active', 'aligned', 'available'].includes(normalized);
}

function buildLocationLabel(parts) {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .filter((part, index, all) => all.indexOf(part) === index)
    .join(', ');
}

function makeCareerRoleId(provider, providerRoleId) {
  return `${String(provider || 'zoho_recruit').trim()}:${String(providerRoleId || '').trim()}`;
}

function mergeCareerRoleClientLists(...lists) {
  const merged = new Map();
  lists.forEach((list) => {
    (Array.isArray(list) ? list : []).forEach((role) => {
      if (!role || typeof role !== 'object') return;
      const id = String(role.id || '').trim();
      if (!id || merged.has(id)) return;
      merged.set(id, role);
    });
  });
  return Array.from(merged.values());
}

function splitDelimitedText(value) {
  return stripHtml(String(value || ''))
    .split(/\n|;|\||•|·/g)
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function sanitizeCareerBenefit(value) {
  const text = stripHtml(String(value || '')).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= 110) return text;
  return `${text.slice(0, 107).trim()}...`;
}

function normalizeCareerBillingLabel(value) {
  const raw = stripHtml(String(value || '')).replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (/bulk/i.test(raw)) return 'Bulk Billing';
  if (/mixed/i.test(raw)) return 'Mixed Billing';
  if (/private/i.test(raw)) return 'Private Billing';
  return raw;
}

function sanitizeHttpUrl(value) {
  const raw = sanitizeZohoText(value);
  if (!raw) return '';
  const prefixed = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(prefixed);
    if (!/^https?:$/i.test(parsed.protocol)) return '';
    return parsed.toString();
  } catch (err) {
    return '';
  }
}

/** Validate a URL allowing only https: and the zoomus: deep-link scheme for interview join links */
function safeZoomOrHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' || parsed.protocol === 'zoomus:') return raw;
    return '';
  } catch {
    return '';
  }
}

function extractCareerWebsiteUrl(record) {
  return sanitizeHttpUrl(getZohoField(record, [
    'Practice_Website',
    'Practice_Website_URL',
    'Company_Website',
    'Website',
    'Practice_URL',
    'Client_Website',
    'Clinic_Website'
  ]));
}

function deriveCareerSuburb(record, areaLabel, city) {
  const direct = getZohoField(record, [
    'Suburb',
    'Practice_Suburb',
    'Location_Suburb',
    'Clinic_Suburb',
    'Town'
  ]);
  if (direct) return direct;
  const area = String(areaLabel || '').trim();
  if (area.includes(',')) {
    return area.split(',')[0].trim();
  }
  return city || '';
}

function sanitizeIdentifierValue(value) {
  return String(value || '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.[a-z]{2,}$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactCareerIdentifiers(text, identifiers = []) {
  let output = String(text || '');
  identifiers
    .map(sanitizeIdentifierValue)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .forEach((identifier) => {
      if (identifier.length < 3) return;
      output = output.replace(new RegExp(escapeRegex(identifier), 'ig'), 'this practice');
    });
  return output
    .replace(/\s+/g, ' ')
    .replace(/\bthis practice(?:\s+this practice)+/gi, 'this practice')
    .trim();
}

function normalizeCareerTypeLabel(value) {
  const raw = stripHtml(String(value || ''))
    .replace(/\bmedical centre\b/ig, 'clinic')
    .replace(/\bmedical center\b/ig, 'clinic')
    .replace(/\bgeneral practice\b/ig, 'GP practice')
    .replace(/\bclinic group\b/ig, 'clinic network')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return 'GP practice';
  return raw.length <= 48 ? raw : `${raw.slice(0, 45).trim()}...`;
}

function buildAnonymousCareerHeadline(context = {}) {
  const geo = context.regional ? 'Regional' : (context.metro ? 'Metro' : 'Australian');
  const billingLabel = normalizeCareerBillingLabel(context.billingLabel || '');
  const billing = billingLabel
    ? billingLabel.toLowerCase()
    : (context.privateBilling
      ? 'private billing'
      : (context.mixedBilling ? 'mixed billing' : 'GP'));
  const typeLabel = normalizeCareerTypeLabel(context.practiceType);
  const phrase = `${geo} ${billing} ${typeLabel}`
    .replace(/\bGP GP\b/ig, 'GP')
    .replace(/\s+/g, ' ')
    .trim();
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

function buildCareerLocationSummary(context = {}) {
  if (context.regional) return 'Regional community setting';
  if (context.metro) return 'Metro catchment with established demand';
  return 'Australian community setting';
}

function buildCareerPublicLocationLine(row, suburb = '') {
  const suburbText = String(suburb || '').trim();
  const stateText = String(row && row.location_state ? row.location_state : '').trim();
  const cityText = String(row && row.location_city ? row.location_city : '').trim();
  return buildLocationLabel([
    suburbText,
    stateText
  ]) || buildLocationLabel([
    cityText,
    stateText
  ]) || 'Australia';
}

function buildCareerPublicProximityNote(row, suburb = '') {
  const suburbText = String(suburb || '').trim().toLowerCase();
  const cityText = String(row && row.location_city ? row.location_city : '').trim();
  if (!cityText) return '';
  if (suburbText && cityText.toLowerCase() === suburbText) return '';
  return `Near ${cityText}`;
}

function sanitizeCareerLocationDisplay(value, fallback = '') {
  const text = stripHtml(String(value || '')).replace(/\s+/g, ' ').trim();
  if (!text) return String(fallback || '').trim();
  return text.length <= 72 ? text : `${text.slice(0, 69).trim()}...`;
}

function sanitizeCareerProximityNote(value, fallback = '') {
  const text = stripHtml(String(value || '')).replace(/\s+/g, ' ').trim();
  if (!text) return String(fallback || '').trim();
  return text.length <= 88 ? text : `${text.slice(0, 85).trim()}...`;
}

function extractCareerBenefits(record, context = {}) {
  const benefits = [];
  const directKeys = [
    'Benefit_1',
    'Benefit_2',
    'Benefit_3',
    'Benefit1',
    'Benefit2',
    'Benefit3',
    'Benefits',
    'Key_Benefits',
    'Role_Benefits',
    'Candidate_Benefits',
    'Sign_On_Bonus',
    'Sign_On_Bonus_Offered',
    'Relocation_Support',
    'Visa_Support',
    'Visa_PR_Sponsorship',
    'Flexible_Roster',
    'Family_Support'
  ];

  directKeys.forEach((key) => {
    splitDelimitedText(getZohoField(record, [key])).forEach((item) => {
      const normalized = sanitizeCareerBenefit(item);
      if (normalized) benefits.push(normalized);
    });
  });

  if (context.earningsText && /\$|k|bonus/i.test(context.earningsText)) {
    benefits.push('Strong earning profile');
  }
  if (normalizeCareerBillingLabel(context.billingLabel) === 'Bulk Billing') benefits.push('Bulk billing patient base');
  if (context.privateBilling) benefits.push('Private billing opportunity');
  if (context.mixedBilling) benefits.push('Mixed billing patient base');
  if (context.dpa) benefits.push('DPA-aligned pathway');
  if (context.mmmText) benefits.push(`MMM access: ${String(context.mmmText).replace(/^MMM\s*/i, '').trim() || context.mmmText}`);
  if (context.visaPathwayAligned) benefits.push('Visa and PR pathway support');
  if (context.familyFriendly) benefits.push('Family-friendly practice support');
  if (context.supportText) benefits.push(sanitizeCareerBenefit(context.supportText));

  return benefits
    .map(sanitizeCareerBenefit)
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 6);
}

function buildCareerPublicSupport(context = {}) {
  if (context.supportText) {
    return sanitizeCareerBenefit(context.supportText);
  }
  if (context.visaPathwayAligned && context.familyFriendly) {
    return 'Relocation, visa and family-settlement support can be discussed with GP Link.';
  }
  if (context.visaPathwayAligned) {
    return 'Visa pathway support can be coordinated with GP Link.';
  }
  return 'GP Link will coordinate further practice details once mutual fit is confirmed.';
}

function buildCareerFallbackIntro(context = {}) {
  const headline = buildAnonymousCareerHeadline(context).toLowerCase();
  const benefits = Array.isArray(context.sourceBenefits) ? context.sourceBenefits.slice(0, 2) : [];
  const benefitText = benefits.length
    ? benefits.join(' and ').replace(/\.$/, '')
    : (context.earningsText ? 'a strong earning profile and structured onboarding' : 'structured onboarding and a stable patient base');
  return `This confidential ${headline} offers ${benefitText}. GP Link will share full practice identity after there is mutual interest.`;
}

function getCareerRoleSourcePayload(row) {
  return row && row.source_payload && typeof row.source_payload === 'object'
    ? row.source_payload
    : {};
}

function getCareerRoleRawPayload(row) {
  const payload = getCareerRoleSourcePayload(row);
  if (payload.zoho && typeof payload.zoho === 'object') return payload.zoho;
  return payload;
}

function buildCareerRoleGpLinkMetaFromRow(row) {
  const record = getCareerRoleRawPayload(row);
  const websiteUrl = extractCareerWebsiteUrl(record);
  const suburb = deriveCareerSuburb(record, row && row.location_label, row && row.location_city);
  const billingLabel = normalizeCareerBillingLabel(row && row.billing_model);
  const identifierValues = [
    row && row.practice_name,
    row && row.location_label,
    row && row.location_city,
    row && row.location_state,
    suburb,
    websiteUrl
  ];
  const sourceBenefits = extractCareerBenefits(record, {
    billingLabel,
    earningsText: row && row.earnings_text,
    privateBilling: !!(row && row.private_billing),
    mixedBilling: !!(row && row.mixed_billing),
    dpa: !!(row && row.dpa),
    mmmText: row && row.mmm,
    visaPathwayAligned: !!(row && row.visa_pathway_aligned),
    familyFriendly: !!(row && row.family_friendly),
    supportText: row && row.support_summary
  }).map((item) => redactCareerIdentifiers(item, identifierValues));
  const headline = buildAnonymousCareerHeadline({
    billingLabel,
    regional: !!(row && row.regional),
    metro: !!(row && row.metro),
    privateBilling: !!(row && row.private_billing),
    mixedBilling: !!(row && row.mixed_billing),
    practiceType: row && row.practice_type
  });
  const locationSummary = buildCareerLocationSummary({
    regional: !!(row && row.regional),
    metro: !!(row && row.metro)
  });
  const publicLocationLine = buildCareerPublicLocationLine(row, suburb);
  const publicLocationProximity = buildCareerPublicProximityNote(row, suburb);
  return {
    websiteUrl,
    suburb,
    sourceBenefits,
    publicHeadline: headline,
    publicIntro: buildCareerFallbackIntro({
      billingLabel,
      regional: !!(row && row.regional),
      metro: !!(row && row.metro),
      privateBilling: !!(row && row.private_billing),
      mixedBilling: !!(row && row.mixed_billing),
      practiceType: row && row.practice_type,
      sourceBenefits,
      earningsText: row && row.earnings_text
    }),
    publicBenefits: sourceBenefits.slice(0, 4),
    publicSupport: redactCareerIdentifiers(row && row.support_summary ? String(row.support_summary) : buildCareerPublicSupport({
      supportText: row && row.support_summary,
      visaPathwayAligned: !!(row && row.visa_pathway_aligned),
      familyFriendly: !!(row && row.family_friendly)
    }), identifierValues),
    locationSummary,
    publicLocationLine,
    publicLocationProximity,
    mapQuery: buildLocationLabel([suburb, row && row.location_state, row && row.location_country]),
    heroImageUrl: '',
    heroImageSourceUrl: '',
    heroImageCredit: '',
    heroImageStatus: suburb ? 'pending' : 'unavailable',
    heroImageCheckedAt: null,
    heroImageVersion: 0,
    aiStatus: websiteUrl && OPENAI_API_KEY ? 'pending' : 'fallback',
    aiProfileVersion: 0,
    aiError: '',
    aiEnrichedAt: null,
    websiteBillingLabel: billingLabel,
    websiteBillingCheckedAt: null,
    websiteBillingStatus: billingLabel ? 'provided' : (websiteUrl && OPENAI_API_KEY ? 'pending' : 'unavailable')
  };
}

function getCareerRoleGpLinkMeta(row) {
  const payload = getCareerRoleSourcePayload(row);
  const stored = payload.gpLink && typeof payload.gpLink === 'object' ? payload.gpLink : {};
  const derived = buildCareerRoleGpLinkMetaFromRow(row);
  return {
    ...derived,
    ...stored,
    sourceBenefits: Array.isArray(stored.sourceBenefits) && stored.sourceBenefits.length ? stored.sourceBenefits : derived.sourceBenefits,
    publicBenefits: Array.isArray(stored.publicBenefits) && stored.publicBenefits.length ? stored.publicBenefits : derived.publicBenefits
  };
}

function buildCareerRoleSourceBundle(record, gpLinkMeta) {
  return {
    zoho: record && typeof record === 'object' ? record : {},
    gpLink: gpLinkMeta && typeof gpLinkMeta === 'object' ? gpLinkMeta : {}
  };
}

function extractWebsiteText(html) {
  const source = String(html || '');
  if (!source) return '';
  const withoutNoise = source
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const chunks = [];
  const titleMatch = withoutNoise.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch && titleMatch[1]) chunks.push(stripHtml(titleMatch[1]));
  const descriptionMatch = withoutNoise.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  if (descriptionMatch && descriptionMatch[1]) chunks.push(stripHtml(descriptionMatch[1]));
  const tagRegex = /<(h1|h2|h3|p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = tagRegex.exec(withoutNoise))) {
    const text = stripHtml(match[2]);
    if (text && text.length > 20) chunks.push(text);
    if (chunks.length >= 80) break;
  }
  return chunks
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index)
    .join('\n')
    .slice(0, 9000);
}

async function fetchCareerWebsiteProfile(websiteUrl) {
  const target = sanitizeHttpUrl(websiteUrl);
  if (!target) {
    return { ok: false, message: 'Practice website unavailable.', text: '' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(target, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GP Link Career Enrichment/1.0; +https://app.mygplink.com.au)',
        Accept: 'text/html,application/xhtml+xml'
      }
    });
    const html = await response.text();
    const text = extractWebsiteText(html);
    if (!response.ok || !text) {
      return { ok: false, message: 'Practice website content could not be read.', text: '' };
    }
    return { ok: true, text };
  } catch (err) {
    return { ok: false, message: 'Practice website could not be fetched.', text: '' };
  } finally {
    clearTimeout(timeout);
  }
}

function stripCareerCommonsMeta(value) {
  return stripHtml(String(value || '')).replace(/\s+/g, ' ').trim();
}

function buildCareerHeroImageQueries(context = {}) {
  const suburb = String(context.suburb || '').trim();
  const state = String(context.state || '').trim();
  const city = String(context.city || '').trim();
  const country = String(context.country || 'Australia').trim() || 'Australia';
  const place = [suburb || city, state, country].filter(Boolean).join(' ').trim();
  const queries = [
    [place, 'landscape'].filter(Boolean).join(' ').trim(),
    [place, 'panorama'].filter(Boolean).join(' ').trim(),
    [place, 'aerial view'].filter(Boolean).join(' ').trim(),
    [place, 'skyline'].filter(Boolean).join(' ').trim(),
    [place, 'streetscape'].filter(Boolean).join(' ').trim(),
    [place, 'suburb view'].filter(Boolean).join(' ').trim()
  ];
  return queries.filter(Boolean).filter((value, index, all) => all.indexOf(value) === index);
}

function scoreCareerHeroImageCandidate(candidate, context = {}) {
  const suburb = String(context.suburb || '').trim().toLowerCase();
  const state = String(context.state || '').trim().toLowerCase();
  const city = String(context.city || '').trim().toLowerCase();
  const combined = [
    candidate.title,
    candidate.description,
    candidate.categories,
    candidate.objectName
  ].join(' ').toLowerCase();

  const negativePattern = /\b(station|railway|train|tram|locomotive|platform|post office|townhouse|townhouses|house|church|school|bird|cockatoo|power station|workshop|workshops|factory|memorial|portrait|person|people|car|cars|bus|truck|vehicle|vehicles|traffic|racetrack|raceway|speedway|circuit|motorsport|motor racing|grand prix|pit lane|stadium|arena|event|festival|logo|diagram|map|illustration|document|pdf|djvu)\b/;
  if (negativePattern.test(combined)) return -1000;

  let score = 0;
  const width = Number(candidate.width || 0);
  const height = Number(candidate.height || 0);
  const ratio = width > 0 && height > 0 ? width / height : 0;

  if (width >= 1400) score += 4;
  if (width >= 2200) score += 4;
  if (ratio >= 1.35) score += 3;
  if (ratio >= 1.7) score += 3;

  if (suburb && combined.includes(suburb)) score += 8;
  if (state && combined.includes(state)) score += 3;
  if (city && combined.includes(city)) score += 2;

  const positiveMatches = combined.match(/\b(view|skyline|cityscape|landscape|panorama|aerial|coast|coastline|bay|harbour|harbor|river|seascape|suburb|foreshore|streetscape|neighbourhood|neighborhood)\b/g);
  if (positiveMatches) score += Math.min(positiveMatches.length, 4) * 2;

  if (/melbourne city from|view towards|skyline of/i.test(combined)) score += 4;

  return score;
}

async function fetchCareerHeroImageCandidates(context = {}) {
  const queries = buildCareerHeroImageQueries(context);
  if (!queries.length) return [];

  const seen = new Set();
  const candidates = [];

  for (const query of queries) {
    try {
      const url = new URL('https://commons.wikimedia.org/w/api.php');
      url.searchParams.set('action', 'query');
      url.searchParams.set('generator', 'search');
      url.searchParams.set('gsrsearch', query);
      url.searchParams.set('gsrnamespace', '6');
      url.searchParams.set('gsrlimit', '8');
      url.searchParams.set('prop', 'imageinfo');
      url.searchParams.set('iiprop', 'url|size|extmetadata');
      url.searchParams.set('iiurlwidth', '1600');
      url.searchParams.set('format', 'json');

      const response = await fetch(url.toString(), {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GP Link Career Hero/1.0; +https://app.mygplink.com.au)' }
      });
      if (!response.ok) continue;

      const payload = await response.json().catch(() => null);
      const pages = payload && payload.query && payload.query.pages && typeof payload.query.pages === 'object'
        ? Object.values(payload.query.pages)
        : [];

      for (const page of pages) {
        const info = Array.isArray(page && page.imageinfo) ? page.imageinfo[0] : null;
        if (!info) continue;
        const title = String(page && page.title ? page.title : '').trim();
        const lowerTitle = title.toLowerCase();
        if (!title || seen.has(lowerTitle)) continue;
        if (!/\.(jpg|jpeg|png|webp|tif|tiff)$/i.test(title)) continue;

        const width = Number(info.width || 0);
        const height = Number(info.height || 0);
        if (!width || !height || width <= height || width < 1280) continue;

        const meta = info.extmetadata && typeof info.extmetadata === 'object' ? info.extmetadata : {};
        const description = stripCareerCommonsMeta(meta.ImageDescription && meta.ImageDescription.value);
        const categories = stripCareerCommonsMeta(meta.Categories && meta.Categories.value);
        const objectName = stripCareerCommonsMeta(meta.ObjectName && meta.ObjectName.value);
        const artist = stripCareerCommonsMeta(meta.Artist && meta.Artist.value);
        const license = stripCareerCommonsMeta(meta.LicenseShortName && meta.LicenseShortName.value);
        const imageUrl = String(info.thumburl || info.url || '').trim();
        const sourceUrl = String(info.descriptionurl || info.descriptionshorturl || '').trim();
        if (!imageUrl) continue;

        const candidate = {
          id: title,
          title,
          description,
          categories,
          objectName,
          width,
          height,
          imageUrl,
          sourceUrl,
          artist,
          license
        };
        candidate.score = scoreCareerHeroImageCandidate(candidate, context);
        if (candidate.score < 0) continue;
        seen.add(lowerTitle);
        candidates.push(candidate);
      }
    } catch (err) {
      continue;
    }
  }

  return candidates
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, 8);
}

async function chooseCareerHeroImageCandidate(context = {}, candidates = []) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (!OPENAI_API_KEY) return candidates[0];

  const shortlisted = candidates.slice(0, 6);
  const content = [
    {
      type: 'input_text',
      text: [
        'Choose the best public hero image candidate for a confidential GP job listing.',
        'This is a strict visual review task.',
        'STRICT RULES:',
        '- Select only a genuine wide landscape image of the suburb or its broader surrounding area.',
        '- Good examples: skyline, aerial, coast, foreshore, river, neighbourhood, or broad streetscape views.',
        '- The image must feel like a location hero banner, not an event photo or close-up subject.',
        '- Reject any image dominated by cars, traffic, racetracks, sports venues, events, people, single buildings, houses, stations, trains, logos, maps, or documents.',
        '- If none clearly qualify, return an empty selected_id.',
        `suburb: ${String(context.suburb || '').trim()}`,
        `state: ${String(context.state || '').trim()}`,
        `nearest_city: ${String(context.city || '').trim()}`,
        'Return strict JSON only: {"selected_id":"candidate id or empty string","reason":"short reason"}'
      ].join('\n')
    }
  ];

  shortlisted.forEach((candidate, index) => {
    content.push({
      type: 'input_text',
      text: [
        `Candidate ${index + 1}`,
        `id: ${candidate.id}`,
        `title: ${candidate.title}`,
        `description: ${candidate.description}`,
        `categories: ${candidate.categories}`,
        `width: ${candidate.width}`,
        `height: ${candidate.height}`,
        `score: ${candidate.score}`
      ].join('\n')
    });
    if (candidate.imageUrl) {
      content.push({
        type: 'input_image',
        image_url: candidate.imageUrl
      });
    }
  });

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_CAREER_MODEL,
        input: [{ role: 'user', content }],
        max_output_tokens: 160,
        temperature: 0.1
      })
    });

    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const text = payload && typeof payload.output_text === 'string' ? payload.output_text : '';
    if (!text) return null;

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    }

    const selectedId = parsed && typeof parsed.selected_id === 'string' ? parsed.selected_id.trim() : '';
    const selected = candidates.find((candidate) => candidate.id === selectedId);
    if (selected) {
      selected.reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
      return selected;
    }
  } catch (err) {}

  return null;
}

function shouldRefreshCareerHeroImage(row, meta) {
  if (!meta || typeof meta !== 'object') return false;
  const hasLocation = !!String(meta.suburb || row && row.location_city || row && row.location_label || '').trim();
  if (!hasLocation) return false;
  if (Number(meta.heroImageVersion || 0) !== CAREER_HERO_IMAGE_VERSION) return true;
  if (meta.heroImageStatus === 'success' && meta.heroImageUrl && meta.heroImageCheckedAt) {
    const checkedAt = Date.parse(meta.heroImageCheckedAt);
    if (Number.isFinite(checkedAt) && (Date.now() - checkedAt) < (30 * 24 * 60 * 60 * 1000)) return false;
  }
  if (!meta.heroImageCheckedAt) return true;
  const checkedAt = Date.parse(meta.heroImageCheckedAt);
  if (!Number.isFinite(checkedAt)) return true;
  return (Date.now() - checkedAt) > (14 * 24 * 60 * 60 * 1000);
}

function normalizeCareerHeroLookupContext(context = {}) {
  const normalized = {
    suburb: String(context.suburb || context.mapLabel || '').trim(),
    state: String(context.state || '').trim().toUpperCase(),
    city: String(context.city || '').trim(),
    country: String(context.country || '').trim() || 'Australia'
  };

  const locationText = [
    context.locationLine,
    context.location,
    context.mapQuery
  ].map((value) => String(value || '').trim()).find(Boolean) || '';

  if (!normalized.state && locationText) {
    const stateMatch = locationText.match(/\b(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/i);
    if (stateMatch) normalized.state = stateMatch[1].toUpperCase();
  }

  if ((!normalized.suburb || !normalized.city) && locationText) {
    const baseLocation = locationText.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    const parts = baseLocation.split(',').map((part) => part.trim()).filter(Boolean);
    if (!normalized.suburb && parts[0]) normalized.suburb = parts[0];
    if (!normalized.city && parts[1]) {
      normalized.city = parts[1].replace(/\b(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/gi, '').replace(/\s+/g, ' ').trim();
    }
    if (!normalized.city && parts[0] && normalized.suburb && parts[0].toLowerCase() !== normalized.suburb.toLowerCase()) {
      normalized.city = parts[0];
    }
  }

  if (!normalized.suburb && normalized.city) normalized.suburb = normalized.city;
  return normalized;
}

function buildCareerHeroLookupCacheKey(context = {}) {
  return [
    String(context.roleSeed || '').trim().toLowerCase(),
    String(context.suburb || '').trim().toLowerCase(),
    String(context.state || '').trim().toLowerCase(),
    String(context.city || '').trim().toLowerCase(),
    String(context.country || '').trim().toLowerCase()
  ].join('|');
}

function createCareerHeroUnavailable(checkedAt = new Date().toISOString()) {
  return {
    heroImageUrl: '',
    heroImageSourceUrl: '',
    heroImageCredit: '',
    heroImageStatus: 'unavailable',
    heroImageCheckedAt: checkedAt,
    heroImageVersion: CAREER_HERO_IMAGE_VERSION
  };
}

function normalizeCareerHeroCityKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function parseCareerCoordinate(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function isAustralianCoordinate(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -44.5 && latitude <= -9.0
    && longitude >= 112.0 && longitude <= 154.5;
}

function buildCareerHeroRoleSeed(context = {}) {
  return String(context.roleSeed || '').trim()
    || [
      context.suburb,
      context.state,
      context.city,
      context.country
    ].map((value) => String(value || '').trim()).filter(Boolean).join('|');
}

function hashCareerHeroSeed(seed) {
  const text = String(seed || '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function pickStableCareerHeroImage(images = [], seed = '') {
  if (!Array.isArray(images) || images.length === 0) return null;
  const index = hashCareerHeroSeed(seed) % images.length;
  return images[index] || images[0] || null;
}

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const toRadians = (value) => value * (Math.PI / 180);
  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

async function loadCareerHeroCityLibrary() {
  const cached = _careerHeroCityLibraryCache;
  if (cached.value && (Date.now() - cached.ts) < CAREER_HERO_CITY_LIBRARY_CACHE_TTL_MS) {
    return cached.value;
  }

  const emptyLibrary = { cities: [], imagesByCityId: new Map() };
  if (!isSupabaseDbConfigured()) return emptyLibrary;

  const [citiesResult, imagesResult] = await Promise.all([
    supabaseDbRequest(
      'career_hero_cities',
      'select=id,slug,city_name,state_code,country,latitude,longitude,is_active&is_active=is.true&order=city_name.asc'
    ),
    supabaseDbRequest(
      'career_hero_city_images',
      'select=id,city_id,slot_no,bucket_id,object_path,alt_text,credit,is_active&is_active=is.true&order=city_id.asc,slot_no.asc'
    )
  ]);

  if (!citiesResult.ok || !imagesResult.ok || !Array.isArray(citiesResult.data) || !Array.isArray(imagesResult.data)) {
    return emptyLibrary;
  }

  const cities = citiesResult.data
    .map((row) => ({
      id: Number(row.id || 0),
      slug: String(row.slug || '').trim(),
      cityName: String(row.city_name || '').trim(),
      stateCode: String(row.state_code || '').trim().toUpperCase(),
      country: String(row.country || 'Australia').trim() || 'Australia',
      latitude: parseCareerCoordinate(row.latitude),
      longitude: parseCareerCoordinate(row.longitude)
    }))
    .filter((row) => row.id > 0 && row.slug && isAustralianCoordinate(row.latitude, row.longitude));

  const imagesByCityId = new Map();
  imagesResult.data.forEach((row) => {
    const cityId = Number(row.city_id || 0);
    if (!cityId) return;
    const bucketId = String(row.bucket_id || CAREER_HERO_IMAGE_BUCKET).trim() || CAREER_HERO_IMAGE_BUCKET;
    const objectPath = String(row.object_path || '').trim();
    if (!objectPath) return;
    const publicUrl = buildSupabaseStoragePublicUrl(bucketId, objectPath);
    if (!publicUrl) return;
    const entry = {
      id: Number(row.id || 0),
      slotNo: Number(row.slot_no || 0),
      bucketId,
      objectPath,
      publicUrl,
      altText: String(row.alt_text || '').trim(),
      credit: String(row.credit || '').trim()
    };
    if (!imagesByCityId.has(cityId)) imagesByCityId.set(cityId, []);
    imagesByCityId.get(cityId).push(entry);
  });

  const library = { cities, imagesByCityId };
  _careerHeroCityLibraryCache = { ts: Date.now(), value: library };
  return library;
}

async function readCareerSuburbGeoCache(context = {}) {
  const suburb = String(context.suburb || '').trim();
  const state = String(context.state || '').trim().toUpperCase();
  const country = String(context.country || 'Australia').trim() || 'Australia';
  if (!suburb || !isSupabaseDbConfigured()) return null;

  const result = await supabaseDbRequest(
    'career_suburb_geo_cache',
    [
      'select=suburb,state_code,country,latitude,longitude,geocode_source,geocode_status,last_error,geocoded_at',
      `suburb=ilike.${encodeURIComponent(suburb)}`,
      `state_code=eq.${encodeURIComponent(state)}`,
      `country=eq.${encodeURIComponent(country)}`,
      'limit=1'
    ].join('&')
  );

  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return null;
  return result.data[0];
}

async function writeCareerSuburbGeoCache(context = {}, patch = {}) {
  const suburb = String(context.suburb || '').trim();
  const state = String(context.state || '').trim().toUpperCase();
  const country = String(context.country || 'Australia').trim() || 'Australia';
  if (!suburb || !isSupabaseDbConfigured()) return null;

  const payload = {
    suburb,
    state_code: state,
    country,
    latitude: patch.latitude === null || patch.latitude === undefined ? null : Number(patch.latitude),
    longitude: patch.longitude === null || patch.longitude === undefined ? null : Number(patch.longitude),
    geocode_source: String(patch.geocodeSource || '').trim(),
    geocode_status: String(patch.geocodeStatus || 'pending').trim() || 'pending',
    last_error: String(patch.lastError || '').trim(),
    geocoded_at: patch.geocodedAt || new Date().toISOString()
  };

  const result = await supabaseDbRequest(
    'career_suburb_geo_cache',
    'on_conflict=suburb,state_code,country',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: [payload]
    }
  );

  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return null;
  return result.data[0];
}

function buildCareerGeocodeQuery(context = {}) {
  return [
    String(context.suburb || '').trim(),
    String(context.state || '').trim().toUpperCase(),
    String(context.country || 'Australia').trim() || 'Australia'
  ].filter(Boolean).join(', ');
}

async function fetchCareerSuburbCoordinates(context = {}) {
  const query = buildCareerGeocodeQuery(context);
  if (!query) return null;

  try {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '5');
    url.searchParams.set('countrycodes', 'au');
    url.searchParams.set('addressdetails', '1');

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GP Link Career Hero Geocoder/1.0; +https://app.mygplink.com.au)',
        Accept: 'application/json'
      }
    });
    if (!response.ok) return null;

    const payload = await response.json().catch(() => null);
    const matches = Array.isArray(payload) ? payload : [];
    for (const match of matches) {
      const latitude = parseCareerCoordinate(match && match.lat);
      const longitude = parseCareerCoordinate(match && match.lon);
      if (!isAustralianCoordinate(latitude, longitude)) continue;
      return {
        latitude,
        longitude,
        geocodeSource: 'nominatim'
      };
    }
  } catch (err) {}

  return null;
}

async function fetchCareerSuburbPostcode(context = {}) {
  const query = buildCareerGeocodeQuery(context);
  if (!query) return '';

  try {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '5');
    url.searchParams.set('countrycodes', 'au');
    url.searchParams.set('addressdetails', '1');

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': HOMELY_LIFESTYLE_USER_AGENT,
        Accept: 'application/json'
      }
    });
    if (!response.ok) return '';

    const payload = await response.json().catch(() => null);
    const matches = Array.isArray(payload) ? payload : [];
    for (const match of matches) {
      const postcode = extractAustralianPostcode(
        match && match.address && match.address.postcode
          ? match.address.postcode
          : (match && match.display_name)
      );
      if (postcode) return postcode;
    }
  } catch (err) {}

  return '';
}

async function reverseGeocodeCareerLocationContext(coords = {}) {
  const latitude = parseCareerCoordinate(coords && coords.lat);
  const longitude = parseCareerCoordinate(coords && coords.lng);
  if (!isAustralianCoordinate(latitude, longitude)) return null;

  try {
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('lat', String(latitude));
    url.searchParams.set('lon', String(longitude));
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('zoom', '14');
    url.searchParams.set('addressdetails', '1');

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': HOMELY_LIFESTYLE_USER_AGENT,
        Accept: 'application/json'
      }
    });
    if (!response.ok) return null;

    const payload = await response.json().catch(() => null);
    const address = payload && payload.address && typeof payload.address === 'object'
      ? payload.address
      : {};
    const suburb = String(
      address.suburb
      || address.city_district
      || address.town
      || address.city
      || address.village
      || address.hamlet
      || ''
    ).trim();
    const state = normalizeAustralianStateAbbreviation(address.state || address.region || address.territory || '');
    const postcode = extractAustralianPostcode(address.postcode || (payload && payload.display_name) || '');
    const country = String(address.country || 'Australia').trim() || 'Australia';
    const label = buildLocationLabel([
      suburb,
      buildLocationLabel([state, postcode]),
      country
    ]) || String(payload && payload.display_name || '').trim();
    if (!suburb && !state && !postcode && !label) return null;
    return {
      suburb,
      state,
      postcode,
      country,
      label
    };
  } catch (err) {
    return null;
  }
}

async function resolveCareerSuburbCoordinates(context = {}) {
  const checkedAt = Date.now();
  const cached = await readCareerSuburbGeoCache(context);
  if (cached) {
    const latitude = parseCareerCoordinate(cached.latitude);
    const longitude = parseCareerCoordinate(cached.longitude);
    if (String(cached.geocode_status || '').trim() === 'success' && isAustralianCoordinate(latitude, longitude)) {
      return {
        latitude,
        longitude,
        geocodeSource: String(cached.geocode_source || 'cache').trim() || 'cache'
      };
    }
    const geocodedAt = Date.parse(cached.geocoded_at || '');
    if (Number.isFinite(geocodedAt) && (checkedAt - geocodedAt) < CAREER_HERO_LOOKUP_CACHE_TTL_MS) {
      return null;
    }
  }

  const fresh = await fetchCareerSuburbCoordinates(context);
  if (fresh) {
    await writeCareerSuburbGeoCache(context, {
      latitude: fresh.latitude,
      longitude: fresh.longitude,
      geocodeSource: fresh.geocodeSource,
      geocodeStatus: 'success',
      lastError: ''
    });
    return fresh;
  }

  await writeCareerSuburbGeoCache(context, {
    latitude: null,
    longitude: null,
    geocodeSource: '',
    geocodeStatus: 'not_found',
    lastError: 'No matching Australian suburb coordinates found.'
  });
  return null;
}

function findCareerHeroCityExactMatch(cities = [], context = {}) {
  const state = String(context.state || '').trim().toUpperCase();
  const candidateKeys = [
    normalizeCareerHeroCityKey(context.suburb),
    normalizeCareerHeroCityKey(context.city)
  ].filter(Boolean);

  for (const key of candidateKeys) {
    const exact = cities.find((city) => city.slug === key && (!state || city.stateCode === state));
    if (exact) return exact;
  }

  return null;
}

function selectNearestCareerHeroCity(cities = [], coordinates = null) {
  if (!coordinates || !isAustralianCoordinate(coordinates.latitude, coordinates.longitude)) return null;
  let chosen = null;
  let minDistanceKm = Number.POSITIVE_INFINITY;

  cities.forEach((city) => {
    if (!isAustralianCoordinate(city.latitude, city.longitude)) return;
    const distanceKm = haversineDistanceKm(
      coordinates.latitude,
      coordinates.longitude,
      city.latitude,
      city.longitude
    );
    if (distanceKm < minDistanceKm) {
      minDistanceKm = distanceKm;
      chosen = city;
    }
  });

  return chosen;
}

async function resolveCareerHeroImageFromContext(context = {}) {
  const normalized = normalizeCareerHeroLookupContext(context);
  const hasLocation = !!String(normalized.suburb || normalized.city || '').trim();
  const checkedAt = new Date().toISOString();

  if (!hasLocation) {
    return createCareerHeroUnavailable(checkedAt);
  }

  const cacheKey = buildCareerHeroLookupCacheKey({
    ...normalized,
    roleSeed: buildCareerHeroRoleSeed(context)
  });
  const cached = _careerHeroLookupCache.get(cacheKey);
  if (cached && cached.value && (Date.now() - cached.ts) < CAREER_HERO_LOOKUP_CACHE_TTL_MS) {
    return { ...cached.value };
  }

  const library = await loadCareerHeroCityLibrary();
  if (!library.cities.length) {
    const unavailable = createCareerHeroUnavailable(checkedAt);
    _careerHeroLookupCache.set(cacheKey, { ts: Date.now(), value: unavailable });
    return { ...unavailable };
  }

  const suburbCoordinates = await resolveCareerSuburbCoordinates(normalized);
  const chosenCity = selectNearestCareerHeroCity(library.cities, suburbCoordinates)
    || findCareerHeroCityExactMatch(library.cities, normalized);

  if (!chosenCity) {
    const unavailable = createCareerHeroUnavailable(checkedAt);
    _careerHeroLookupCache.set(cacheKey, { ts: Date.now(), value: unavailable });
    return { ...unavailable };
  }

  const images = library.imagesByCityId.get(chosenCity.id) || [];
  const selectedImage = pickStableCareerHeroImage(images, buildCareerHeroRoleSeed(context));
  if (!selectedImage) {
    const unavailable = createCareerHeroUnavailable(checkedAt);
    _careerHeroLookupCache.set(cacheKey, { ts: Date.now(), value: unavailable });
    return { ...unavailable };
  }

  const creditParts = [
    [chosenCity.cityName, chosenCity.stateCode].filter(Boolean).join(', '),
    selectedImage.credit
  ].filter(Boolean);

  const resolved = {
    heroImageUrl: selectedImage.publicUrl,
    heroImageSourceUrl: selectedImage.publicUrl,
    heroImageCredit: creditParts.join(' · '),
    heroImageStatus: 'success',
    heroImageCheckedAt: checkedAt,
    heroImageVersion: CAREER_HERO_IMAGE_VERSION
  };
  _careerHeroLookupCache.set(cacheKey, { ts: Date.now(), value: resolved });
  return { ...resolved };
}

async function ensureCareerRoleHeroImage(row) {
  if (!row) return null;
  const currentMeta = getCareerRoleGpLinkMeta(row);
  if (!shouldRefreshCareerHeroImage(row, currentMeta)) return row;

  const resolved = await resolveCareerHeroImageFromContext({
    roleSeed: [row && row.provider, row && row.provider_role_id].filter(Boolean).join(':'),
    suburb: currentMeta.suburb,
    mapLabel: currentMeta.suburb,
    state: row && row.location_state,
    city: row && row.location_city,
    country: row && row.location_country,
    location: row && row.location_label,
    mapQuery: currentMeta.mapQuery
  });

  return updateCareerRoleRow(row, {
    ...currentMeta,
    heroImageUrl: resolved.heroImageUrl,
    heroImageSourceUrl: resolved.heroImageSourceUrl,
    heroImageCredit: resolved.heroImageCredit,
    heroImageStatus: resolved.heroImageStatus,
    heroImageCheckedAt: resolved.heroImageCheckedAt,
    heroImageVersion: resolved.heroImageVersion
  });
}

async function createCareerRoleAiProfile(row, gpLinkMeta, websiteText) {
  if (!OPENAI_API_KEY) throw new Error('Career AI service not configured.');

  const rawRecord = getCareerRoleRawPayload(row);
  const practiceName = row && row.practice_name ? String(row.practice_name) : '';
  const locationDisplayFallback = buildCareerPublicLocationLine(row, gpLinkMeta && gpLinkMeta.suburb);
  const proximityFallback = buildCareerPublicProximityNote(row, gpLinkMeta && gpLinkMeta.suburb);

  const prompt = [
    'You are writing a premium candidate-facing practice profile for overseas General Practitioners relocating to Australia.',
    'CRITICAL PRIVACY RULES:',
    '- Never reveal the practice name, website URL, street address, phone number, clinician names, or any identifying details.',
    '- Refer to the employer only as "this practice" or with a generic descriptor.',
    '- Do not use the raw practice name anywhere.',
    '- Do not mention the website or source material.',
    '- You may mention the suburb and state, and you may mention the nearest major city as a travel reference.',
    'Return strict JSON with keys:',
    'headline: short anonymous title, 4-8 words',
    'intro: 2 short sentences, max 280 chars total, concise and high-trust, describing the practice without naming it and without repeating the location line',
    'benefits: array of 3 to 4 short one-line benefit strings, max 80 chars each',
    'support: one short sentence about onboarding/support',
    'location_summary: one short generic sentence about the setting without naming the suburb/city/state',
    'location_display: formatted like "Erina, NSW"',
    'proximity_note: short travel-style note like "10 min drive from Sydney CBD" or "" if unclear',
    'billing_model: exactly one of "Bulk Billing", "Private Billing", "Mixed Billing", or "" if unclear',
    `role_title: ${sanitizeZohoText(row && row.title)}`,
    `billing_model: ${sanitizeZohoText(row && row.billing_model)}`,
    `employment_type: ${sanitizeZohoText(row && row.employment_type)}`,
    `practice_type: ${sanitizeZohoText(row && row.practice_type)}`,
    `geography: ${row && row.regional ? 'regional' : (row && row.metro ? 'metro' : 'australia')}`,
    `earnings_text: ${sanitizeZohoText(row && row.earnings_text)}`,
    `source_benefits: ${JSON.stringify((gpLinkMeta && gpLinkMeta.sourceBenefits) || [])}`,
    `support_summary: ${sanitizeZohoText(row && row.support_summary)}`,
    `raw_suburb: ${sanitizeZohoText(gpLinkMeta && gpLinkMeta.suburb)}`,
    `raw_state: ${sanitizeZohoText(row && row.location_state)}`,
    `raw_city_reference: ${sanitizeZohoText(row && row.location_city)}`,
    `fallback_location_display: ${locationDisplayFallback}`,
    `fallback_proximity_note: ${proximityFallback}`,
    `website_excerpt: ${String(websiteText || '').slice(0, 8000)}`,
    `raw_practice_name_for_redaction_only: ${practiceName}`,
    `raw_website_for_redaction_only: ${sanitizeZohoText(gpLinkMeta && gpLinkMeta.websiteUrl)}`,
    'Return JSON only.'
  ].join('\n');

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_CAREER_MODEL,
      input: prompt,
      max_output_tokens: 500,
      temperature: 0.4
    })
  });

  if (!response.ok) {
    throw new Error('Career AI request failed');
  }

  const payload = await response.json();
  const text = payload && typeof payload.output_text === 'string' ? payload.output_text : '';
  if (!text) throw new Error('Career AI returned empty output');

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) parsed = JSON.parse(objectMatch[0]);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Career AI returned invalid JSON');
  }

  const identifierValues = [
    practiceName,
    gpLinkMeta && gpLinkMeta.websiteUrl,
    rawRecord && rawRecord.Practice_Website
  ];

  const headline = redactCareerIdentifiers(String(parsed.headline || '').trim(), identifierValues);
  const intro = redactCareerIdentifiers(String(parsed.intro || '').trim(), identifierValues);
  const support = redactCareerIdentifiers(String(parsed.support || '').trim(), identifierValues);
  const locationSummary = redactCareerIdentifiers(String(parsed.location_summary || '').trim(), identifierValues);
  const billingModel = normalizeCareerBillingLabel(String(parsed.billing_model || '').trim());
  const locationDisplay = sanitizeCareerLocationDisplay(parsed.location_display, locationDisplayFallback);
  const proximityNote = sanitizeCareerProximityNote(parsed.proximity_note, proximityFallback);
  const benefits = Array.isArray(parsed.benefits)
    ? parsed.benefits.map((item) => redactCareerIdentifiers(sanitizeCareerBenefit(item), identifierValues)).filter(Boolean)
    : [];

  return {
    publicHeadline: headline || gpLinkMeta.publicHeadline,
    publicIntro: intro || gpLinkMeta.publicIntro,
    publicBenefits: benefits.slice(0, 4).length ? benefits.slice(0, 4) : gpLinkMeta.publicBenefits,
    publicSupport: support || gpLinkMeta.publicSupport,
    locationSummary: locationSummary || gpLinkMeta.locationSummary,
    publicLocationLine: locationDisplay || gpLinkMeta.publicLocationLine || locationDisplayFallback,
    publicLocationProximity: proximityNote || gpLinkMeta.publicLocationProximity || proximityFallback,
    aiProfileVersion: CAREER_AI_PROFILE_VERSION,
    websiteBillingLabel: billingModel || gpLinkMeta.websiteBillingLabel || '',
    websiteBillingCheckedAt: new Date().toISOString(),
    websiteBillingStatus: billingModel ? 'success' : 'unclear'
  };
}

function isZohoRecruitConfigured() {
  return !!(
    isSupabaseDbConfigured() &&
    ZOHO_RECRUIT_CLIENT_ID &&
    ZOHO_RECRUIT_CLIENT_SECRET &&
    ZOHO_RECRUIT_REDIRECT_URI
  );
}

function getZohoRecruitAccountsServer() {
  return normalizeUrlBase(ZOHO_RECRUIT_ACCOUNTS_SERVER, 'https://accounts.zoho.com');
}

function getZohoRecruitLegacyAppRedirectUri() {
  const configured = String(ZOHO_RECRUIT_REDIRECT_URI || '').trim();
  if (!configured) return '';
  try {
    const url = new URL(configured);
    if (/^(?:ceo\.)?admin\.mygplink\.com\.au$/i.test(url.hostname)) {
      url.hostname = 'app.mygplink.com.au';
      url.pathname = '/api/integrations/zoho-recruit/callback';
      url.search = '';
      url.hash = '';
      return url.toString();
    }
  } catch (err) {}
  return '';
}

function getZohoRecruitOauthRedirectUri() {
  const legacyAppRedirect = getZohoRecruitLegacyAppRedirectUri();
  if (legacyAppRedirect) return legacyAppRedirect;
  return String(ZOHO_RECRUIT_REDIRECT_URI || '').trim();
}

function normalizeZohoRecruitScope(scope) {
  const value = String(scope || '').trim();
  if (!value) return '';
  const compact = value.replace(/\s+/g, '').replace(/^ZohoRECRUIT/i, 'ZohoRecruit');
  const canonicalKey = compact.toLowerCase().replace(/^zohorecruit\./, 'zohorecruit.');

  if (canonicalKey === 'zohorecruit.modules.read') return 'ZohoRecruit.modules.READ';
  if (canonicalKey === 'zohorecruit.modules.all') return 'ZohoRecruit.modules.READ';
  if (canonicalKey === 'zohorecruit.search.read') return 'ZohoRecruit.search.READ';
  if (canonicalKey.startsWith('zohorecruit.modules.') && canonicalKey !== 'zohorecruit.modules.all') {
    // Collapse stale or broader module scopes into the documented read-only group
    // scope so the integration cannot request write/delete access.
    return 'ZohoRecruit.modules.READ';
  }

  return '';
}

function parseZohoRecruitScopes(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  const scopes = [];
  const seen = new Set();
  for (const item of items) {
    const normalized = normalizeZohoRecruitScope(item);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    scopes.push(normalized);
  }
  return scopes;
}

function mergeZohoRecruitScopes(...values) {
  const merged = [];
  const seen = new Set();
  for (const value of values) {
    for (const scope of parseZohoRecruitScopes(value)) {
      const key = scope.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(scope);
    }
  }
  return merged;
}

function getConfiguredZohoRecruitScopes() {
  const allowed = new Set(
    [...REQUIRED_ZOHO_RECRUIT_SCOPES, ...OPTIONAL_ZOHO_RECRUIT_SCOPES]
      .map((scope) => String(scope).toLowerCase())
  );
  return parseZohoRecruitScopes(ZOHO_RECRUIT_SCOPES).filter((scope) => allowed.has(String(scope).toLowerCase()));
}

function doesZohoRecruitScopeGrant(requiredScope, grantedScopes) {
  const normalizedRequired = normalizeZohoRecruitScope(requiredScope);
  if (!normalizedRequired) return false;
  const grantedKeys = new Set(parseZohoRecruitScopes(grantedScopes).map((item) => item.toLowerCase()));
  const requiredKey = normalizedRequired.toLowerCase();
  if (grantedKeys.has(requiredKey)) return true;
  if (requiredKey.startsWith('zohorecruit.modules.')) {
    if (grantedKeys.has('zohorecruit.modules.all')) return true;
  }
  if (requiredKey.endsWith('.read')) {
    const elevated = `${requiredKey.slice(0, -5)}.all`;
    if (grantedKeys.has(elevated)) return true;
  }
  return false;
}

function isZohoRecruitWriteScope(scope) {
  const value = String(scope || '').trim().toLowerCase();
  if (!value) return false;
  if (value === 'zohorecruit.modules.all') return true;
  if (/^zohorecruit\.modules\.[a-z_]+\.(all|create|update|delete)$/.test(value)) return true;
  if (value === 'zohorecruit.modules.create' || value === 'zohorecruit.modules.update' || value === 'zohorecruit.modules.delete') return true;
  return false;
}

function getZohoRecruitScopeStatus(connection) {
  const requestedScopes = getZohoRecruitScopes();
  const grantedScopes = parseZohoRecruitScopes(connection && connection.scopes);
  const missingScopes = requestedScopes.filter((scope) => !doesZohoRecruitScopeGrant(scope, grantedScopes));
  const missingRequiredScopes = REQUIRED_ZOHO_RECRUIT_SCOPES.filter((scope) => !doesZohoRecruitScopeGrant(scope, grantedScopes));
  const overbroadGrantedScopes = grantedScopes.filter((scope) => isZohoRecruitWriteScope(scope));
  return {
    requestedScopes,
    grantedScopes,
    missingScopes,
    missingRequiredScopes,
    overbroadGrantedScopes,
    needsReconnect: !!(connection && connection.refreshToken && (missingRequiredScopes.length > 0 || overbroadGrantedScopes.length > 0))
  };
}

function getZohoRecruitScopes() {
  return mergeZohoRecruitScopes(REQUIRED_ZOHO_RECRUIT_SCOPES, getConfiguredZohoRecruitScopes());
}

function getZohoRecruitCandidateBases(connection, apiDomain = '') {
  const candidates = [];
  const apiBase = normalizeUrlBase(apiDomain, '');
  const accountsBase = normalizeUrlBase(connection && connection.accountsServer, '');
  if (accountsBase) {
    try {
      const host = new URL(accountsBase).hostname;
      if (host.startsWith('accounts.')) {
        candidates.push(`https://${host.replace(/^accounts\./, 'recruit.')}`);
      }
    } catch (err) {}
  }

  if (apiBase) {
    try {
      const host = new URL(apiBase).hostname;
      if (host.startsWith('www.zohoapis.')) {
        candidates.push(`https://recruit.${host.replace(/^www\.zohoapis\./, 'zoho.')}`);
      }
    } catch (err) {}
  }

  if (apiBase) candidates.push(apiBase);

  return candidates.filter(Boolean).filter((value, index, all) => all.indexOf(value) === index);
}

function getZohoOauthStateKey(state) {
  return `zoho_recruit_oauth:${String(state || '').trim()}`;
}

function getRequestOrigin(req) {
  const forwardedProto = String(req && req.headers && req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : '').split(',')[0].trim();
  const forwardedHost = String(req && req.headers && req.headers['x-forwarded-host'] ? req.headers['x-forwarded-host'] : '').split(',')[0].trim();
  const host = forwardedHost || String(req && req.headers && req.headers.host ? req.headers.host : 'localhost').split(',')[0].trim() || 'localhost';
  const proto = forwardedProto || (NODE_ENV === 'production' ? 'https' : 'http');
  return `${proto}://${host}`;
}

function buildAbsoluteReturnUrl(req, returnPath = '/') {
  const value = String(returnPath || '/').trim() || '/';
  try {
    return new URL(value).toString();
  } catch (err) {}
  return new URL(value.startsWith('/') ? value : `/${value}`, `${getRequestOrigin(req)}/`).toString();
}

async function createZohoOauthState(adminEmail, options = {}) {
  const state = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + (10 * 60 * 1000);
  await setRuntimeKv(getZohoOauthStateKey(state), {
    email: String(adminEmail || '').trim().toLowerCase(),
    redirectUri: String(options.redirectUri || '').trim(),
    returnUrl: String(options.returnUrl || '').trim(),
    returnPath: String(options.returnPath || '').trim(),
    createdAt: new Date().toISOString()
  }, expiresAt);
  return state;
}

async function consumeZohoOauthState(state) {
  const key = getZohoOauthStateKey(state);
  const existing = await getRuntimeKv(key);
  if (!existing || !existing.value || typeof existing.value !== 'object') return null;
  await deleteRuntimeKv(key);
  return existing.value;
}

async function zohoFormRequest(accountsServer, params) {
  const base = normalizeUrlBase(accountsServer, getZohoRecruitAccountsServer());
  const body = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    body.set(key, String(value));
  });

  try {
    const response = await fetch(`${base}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const text = await response.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch (err) { data = { raw: text }; }
    }
    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    return { ok: false, status: 502, data: { error: 'network_error', message: 'Failed to reach Zoho OAuth service.' } };
  }
}

function getZohoErrorMessage(payload, fallback) {
  if (!payload || typeof payload !== 'object') return fallback;
  const message = String(
    payload.error_description ||
    payload.error ||
    payload.code ||
    payload.message ||
    fallback
  ).trim();
  if (message && message !== fallback) return message;
  if (typeof payload.details === 'string' && payload.details.trim()) return payload.details.trim();
  if (payload.details && typeof payload.details === 'object') {
    try {
      const serialized = JSON.stringify(payload.details);
      if (serialized && serialized !== '{}') return serialized;
    } catch (err) {}
  }
  if (typeof payload.raw === 'string' && payload.raw.trim()) return payload.raw.trim().slice(0, 400);
  return fallback;
}

function mapZohoConnectionRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    provider: typeof row.provider === 'string' ? row.provider : 'zoho_recruit',
    status: typeof row.status === 'string' ? row.status : 'disconnected',
    accountsServer: typeof row.accounts_server === 'string' ? row.accounts_server : getZohoRecruitAccountsServer(),
    apiDomain: typeof row.api_domain === 'string' ? row.api_domain : '',
    refreshToken: typeof row.refresh_token === 'string' ? row.refresh_token : '',
    scopes: parseZohoRecruitScopes(Array.isArray(row.scopes) ? row.scopes : []),
    connectedByUserId: typeof row.connected_by_user_id === 'string' ? row.connected_by_user_id : '',
    connectedEmail: typeof row.connected_email === 'string' ? row.connected_email : '',
    tokenLastRefreshedAt: typeof row.token_last_refreshed_at === 'string' ? row.token_last_refreshed_at : null,
    lastSyncAt: typeof row.last_sync_at === 'string' ? row.last_sync_at : null,
    lastSyncStatus: typeof row.last_sync_status === 'string' ? row.last_sync_status : 'idle',
    lastSyncError: typeof row.last_sync_error === 'string' ? row.last_sync_error : '',
    connectedAt: typeof row.connected_at === 'string' ? row.connected_at : null,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null
  };
}

async function getZohoRecruitConnection() {
  const result = await supabaseDbRequest(
    'integration_connections',
    'select=*&provider=eq.zoho_recruit&limit=1'
  );
  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return null;
  return mapZohoConnectionRow(result.data[0]);
}

async function upsertZohoRecruitConnection(patch = {}) {
  const existing = await getZohoRecruitConnection();
  const payload = {
    provider: 'zoho_recruit',
    status: typeof patch.status === 'string' ? patch.status : (existing && existing.status) || 'connected',
    accounts_server: normalizeUrlBase(
      patch.accountsServer !== undefined ? patch.accountsServer : (existing && existing.accountsServer),
      getZohoRecruitAccountsServer()
    ),
    api_domain: normalizeUrlBase(
      patch.apiDomain !== undefined ? patch.apiDomain : (existing && existing.apiDomain),
      ''
    ),
    refresh_token: patch.refreshToken !== undefined ? String(patch.refreshToken || '') : ((existing && existing.refreshToken) || ''),
    scopes: parseZohoRecruitScopes(Array.isArray(patch.scopes) ? patch.scopes : ((existing && existing.scopes) || getZohoRecruitScopes())),
    connected_by_user_id: patch.connectedByUserId !== undefined ? String(patch.connectedByUserId || '') : ((existing && existing.connectedByUserId) || ''),
    connected_email: patch.connectedEmail !== undefined ? String(patch.connectedEmail || '').trim().toLowerCase() : ((existing && existing.connectedEmail) || ''),
    token_last_refreshed_at: patch.tokenLastRefreshedAt !== undefined ? patch.tokenLastRefreshedAt : ((existing && existing.tokenLastRefreshedAt) || null),
    last_sync_at: patch.lastSyncAt !== undefined ? patch.lastSyncAt : ((existing && existing.lastSyncAt) || null),
    last_sync_status: patch.lastSyncStatus !== undefined ? String(patch.lastSyncStatus || '') : ((existing && existing.lastSyncStatus) || 'idle'),
    last_sync_error: patch.lastSyncError !== undefined ? String(patch.lastSyncError || '') : ((existing && existing.lastSyncError) || ''),
    connected_at: patch.connectedAt !== undefined ? patch.connectedAt : ((existing && existing.connectedAt) || new Date().toISOString()),
    metadata: patch.metadata && typeof patch.metadata === 'object'
      ? patch.metadata
      : ((existing && existing.metadata) || {}),
    updated_at: new Date().toISOString()
  };

  const result = await supabaseDbRequest(
    'integration_connections',
    'on_conflict=provider',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: [payload]
    }
  );
  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return null;
  return mapZohoConnectionRow(result.data[0]);
}

async function exchangeZohoRecruitAuthorizationCode(code, accountsServer, redirectUri = '') {
  return zohoFormRequest(accountsServer, {
    grant_type: 'authorization_code',
    client_id: ZOHO_RECRUIT_CLIENT_ID,
    client_secret: ZOHO_RECRUIT_CLIENT_SECRET,
    redirect_uri: String(redirectUri || getZohoRecruitOauthRedirectUri()).trim(),
    code: String(code || '').trim()
  });
}

async function refreshZohoRecruitAccessToken(connection) {
  const refreshToken = connection && connection.refreshToken ? String(connection.refreshToken).trim() : '';
  if (!refreshToken) {
    return { ok: false, status: 400, data: { message: 'Zoho Recruit is not connected.' } };
  }
  const accountsServer = normalizeUrlBase(
    (connection && connection.accountsServer) || getZohoRecruitAccountsServer(),
    getZohoRecruitAccountsServer()
  );
  const refreshed = await zohoFormRequest(accountsServer, {
    grant_type: 'refresh_token',
    client_id: ZOHO_RECRUIT_CLIENT_ID,
    client_secret: ZOHO_RECRUIT_CLIENT_SECRET,
    refresh_token: refreshToken
  });
  if (!refreshed.ok) return refreshed;
  await upsertZohoRecruitConnection({
    accountsServer,
    apiDomain: normalizeUrlBase(refreshed.data && refreshed.data.api_domain, ''),
    tokenLastRefreshedAt: new Date().toISOString(),
    status: 'connected',
    lastSyncError: ''
  });
  return refreshed;
}

async function zohoRecruitApiGet(apiDomain, resourcePath, accessToken, queryParams = {}) {
  const base = normalizeUrlBase(apiDomain, '');
  if (!base) {
    return { ok: false, status: 400, data: { message: 'Zoho Recruit API domain is missing.' } };
  }
  const url = new URL(`${base}/recruit/v2/${String(resourcePath || '').replace(/^\/+/, '')}`);
  Object.entries(queryParams || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Zoho-oauthtoken ${String(accessToken || '').trim()}`
        }
      });
      if (response.status === 429 && attempt < maxRetries) {
        const retryAfter = Math.min(Number(response.headers.get('Retry-After') || 2) * 1000, 10000);
        await new Promise((resolve) => setTimeout(resolve, retryAfter));
        continue;
      }
      const text = await response.text();
      let data = {};
      if (text) {
        try { data = JSON.parse(text); } catch (err) { data = { raw: text }; }
      }
      return { ok: response.ok, status: response.status, data };
    } catch (err) {
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      return { ok: false, status: 502, data: { message: 'Failed to reach Zoho Recruit API.' } };
    }
  }
  return { ok: false, status: 502, data: { message: 'Failed to reach Zoho Recruit API after retries.' } };
}

async function zohoRecruitApiPost(apiDomain, resourcePath, accessToken, bodyData) {
  const base = normalizeUrlBase(apiDomain, '');
  if (!base) {
    return { ok: false, status: 400, data: { message: 'Zoho Recruit API domain is missing.' } };
  }
  const url = `${base}/recruit/v2/${String(resourcePath || '').replace(/^\/+/, '')}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${String(accessToken || '').trim()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(bodyData)
    });
    const text = await response.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch (err) { data = { raw: text }; }
    }
    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    return { ok: false, status: 502, data: { message: 'Failed to reach Zoho Recruit API.' } };
  }
}

async function zohoRecruitApiUploadAttachment(apiDomain, moduleName, recordId, accessToken, fileName, fileBuffer, mimeType) {
  const base = normalizeUrlBase(apiDomain, '');
  if (!base) {
    return { ok: false, status: 400, data: { message: 'Zoho Recruit API domain is missing.' } };
  }
  const url = `${base}/recruit/v2/${moduleName}/${recordId}/Attachments`;
  const boundary = '----ZohoFormBoundary' + Date.now().toString(36);
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(header), fileBuffer, Buffer.from(footer)]);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${String(accessToken || '').trim()}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body
    });
    const text = await response.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch (err) { data = { raw: text }; }
    }
    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    return { ok: false, status: 502, data: { message: 'Failed to upload attachment to Zoho Recruit.' } };
  }
}

async function fetchZohoRecruitJobOpenings(connection, accessToken, apiDomain, queryParams = {}) {
  const bases = getZohoRecruitCandidateBases(connection, apiDomain);
  const resourcePaths = ['JobOpenings', 'jobopenings', 'Job_Openings'];
  let lastFailure = { ok: false, status: 502, data: { message: 'Failed to fetch Zoho Recruit job openings.' } };

  for (const base of bases) {
    for (const resourcePath of resourcePaths) {
      const result = await zohoRecruitApiGet(base, resourcePath, accessToken, queryParams);
      if (result.ok) return result;
      lastFailure = result;
      const errorText = getZohoErrorMessage(result.data, '').toLowerCase();
      const rawText = String(result && result.data && result.data.raw ? result.data.raw : '').toLowerCase();
      const missingModule = errorText.includes('invalid module') || errorText.includes('module') || errorText.includes('not supported');
      const htmlFallback = rawText.includes('<html') || rawText.includes('<!doctype html') || rawText.includes('crm_error') || rawText.includes('zoho crm');
      const shouldTryNextVariant = missingModule || htmlFallback || result.status === 401 || result.status === 403 || result.status === 404;
      if (!shouldTryNextVariant) {
        return result;
      }
    }
  }

  return lastFailure;
}

function buildCareerRoleRecordFromZoho(record, syncedAt) {
  if (!record || typeof record !== 'object') return null;
  const providerRoleId = sanitizeZohoText(record.id);
  if (!providerRoleId) return null;

  const title = getZohoField(record, ['Posting_Title', 'Job_Opening_Name', 'Role_Title', 'Job_Title', 'Title']) || 'General Practitioner';
  const practiceName = getZohoField(record, ['Client_Name', 'Account_Name', 'Practice_Name', 'Organisation_Name', 'Company', 'Job_Opening_Name']) || title;
  const city = getZohoField(record, ['City', 'Work_City', 'Location_City', 'Job_City']);
  const state = getZohoField(record, ['State', 'Region', 'Province', 'Work_State', 'Location_State']);
  const country = getZohoField(record, ['Country', 'Work_Country', 'Location_Country']) || 'Australia';
  const areaLabel = getZohoField(record, ['Location', 'Job_Location', 'Work_Location', 'Suburb']);
  const locationLabel = areaLabel || buildLocationLabel([city, state].filter(Boolean));
  const billingModel = getZohoField(record, ['Billing_Model', 'Billing_Type', 'Remuneration_Model', 'Fee_Model', 'Billing']);
  const dpaText = getZohoField(record, ['DPA', 'DPA_Status', 'Distribution_Priority_Area']);
  const mmmText = getZohoField(record, ['MMM', 'MMM_Rating', 'MMM_Status', 'MMM_Category']);
  const earningsText = getZohoField(record, ['Salary_Range', 'Salary', 'Annual_Salary', 'Package', 'Estimated_Earnings', 'Compensation']);
  const summary = sanitizeZohoSummary(
    getZohoField(record, ['Job_Description', 'Description', 'Job_Summary', 'Summary', 'About_the_Role', 'Notes'])
  ) || `${title} opportunity in ${locationLabel || country}.`;
  const employmentType = getZohoField(record, ['Employment_Type', 'Role_Type', 'Job_Type', 'Type']);
  const practiceType = getZohoField(record, ['Practice_Type', 'Organisation_Type', 'Clinic_Type', 'Client_Type']);
  const supportText = getZohoField(record, ['Support', 'Supervision', 'Relocation_Support', 'Onboarding_Support']);
  const statusText = getZohoField(record, ['Job_Opening_Status', 'Status', 'Open_Closed']);
  const visaText = getZohoField(record, ['Visa_Pathway_Aligned', 'Visa_Support', 'Visa_Pathway']);
  const familyText = getZohoField(record, ['Family_Friendly', 'Family_Support']);
  const geographyText = getZohoField(record, ['Metro_or_Regional', 'Region_Type', 'Location_Type']);

  const privateBilling = /private/i.test(billingModel);
  const mixedBilling = /mixed/i.test(billingModel);
  const dpa = parseBooleanish(dpaText) || /dpa/i.test(dpaText);
  const familyFriendly = parseBooleanish(familyText) || /family/i.test(familyText);
  const visaPathwayAligned = parseBooleanish(visaText) || /visa/i.test(visaText);
  const metro = /metro|city|suburban/i.test(geographyText);
  const regional = /regional|rural/i.test(geographyText) || (!metro && (/mmm/i.test(mmmText) || dpa));
  const tags = [
    billingModel,
    dpa ? 'DPA' : '',
    mmmText ? `MMM ${mmmText.replace(/^MMM\s*/i, '').trim()}` : '',
    visaPathwayAligned ? 'Visa pathway aligned' : '',
    familyFriendly ? 'Family friendly' : '',
    regional ? 'Regional' : (metro ? 'Metro' : ''),
    supportText
  ].map((value) => String(value || '').trim()).filter(Boolean).filter((value, index, all) => all.indexOf(value) === index);

  const isActive = !/closed|filled|inactive|archived|cancelled|hold/i.test(statusText);
  const publishedAt = getZohoField(record, ['Date_Opened', 'Created_Time', 'Modified_Time']) || null;
  const baseRow = {
    provider: 'zoho_recruit',
    provider_role_id: providerRoleId,
    title,
    practice_name: practiceName,
    location_city: city,
    location_state: state,
    location_country: country,
    location_label: locationLabel || buildLocationLabel([city, state, country]),
    billing_model: billingModel,
    dpa,
    mmm: mmmText,
    earnings_text: earningsText,
    summary,
    employment_type: employmentType,
    practice_type: practiceType,
    support_summary: supportText,
    tags,
    visa_pathway_aligned: visaPathwayAligned,
    family_friendly: familyFriendly,
    private_billing: privateBilling,
    mixed_billing: mixedBilling,
    metro,
    regional,
    is_active: isActive,
    published_at: publishedAt || null,
    synced_at: syncedAt,
    updated_at: syncedAt
  };
  const gpLinkMeta = buildCareerRoleGpLinkMetaFromRow(baseRow);

  return {
    ...baseRow,
    summary: gpLinkMeta.publicIntro || summary,
    support_summary: gpLinkMeta.publicSupport || supportText,
    source_payload: buildCareerRoleSourceBundle(record, gpLinkMeta)
  };
}

function buildPostgrestTextList(values) {
  return `(${values.map((value) => `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')})`;
}

async function upsertCareerRoleBatch(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return true;
  const result = await supabaseDbRequest(
    'career_roles',
    'on_conflict=provider,provider_role_id',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: rows
    }
  );
  return result.ok;
}

async function markCareerRolesInactive(provider, inactiveIds) {
  const ids = Array.isArray(inactiveIds) ? inactiveIds.filter(Boolean) : [];
  if (ids.length === 0) return true;
  for (let index = 0; index < ids.length; index += 50) {
    const chunk = ids.slice(index, index + 50);
    const result = await supabaseDbRequest(
      'career_roles',
      `provider=eq.${encodeURIComponent(provider)}&provider_role_id=in.${buildPostgrestTextList(chunk)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: {
          is_active: false,
          updated_at: new Date().toISOString()
        }
      }
    );
    if (!result.ok) return false;
  }
  return true;
}

async function listCareerRoleRows(activeOnly = true, provider = '') {
  const filters = ['select=*'];
  if (provider) filters.push(`provider=eq.${encodeURIComponent(provider)}`);
  if (activeOnly) filters.push('is_active=eq.true');
  filters.push('order=updated_at.desc');
  const result = await supabaseDbRequest('career_roles', filters.join('&'));
  if (!result.ok || !Array.isArray(result.data)) return [];
  return result.data;
}

async function getCareerRoleRowById(roleId) {
  const value = String(roleId || '').trim();
  if (!value) return null;
  const result = await supabaseDbRequest(
    'career_roles',
    `select=*&id=eq.${encodeURIComponent(value)}&limit=1`
  );
  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return null;
  return result.data[0];
}

async function getCareerRoleRow(provider, providerRoleId) {
  const result = await supabaseDbRequest(
    'career_roles',
    `select=*&provider=eq.${encodeURIComponent(provider)}&provider_role_id=eq.${encodeURIComponent(providerRoleId)}&limit=1`
  );
  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return null;
  return result.data[0];
}

async function updateCareerRoleRow(row, gpLinkMetaPatch = {}, rowPatch = {}) {
  if (!row || !row.provider || !row.provider_role_id) return row;
  const nextMeta = {
    ...getCareerRoleGpLinkMeta(row),
    ...gpLinkMetaPatch
  };
  const body = {
    ...rowPatch,
    summary: nextMeta.publicIntro || row.summary,
    support_summary: nextMeta.publicSupport || row.support_summary,
    source_payload: buildCareerRoleSourceBundle(getCareerRoleRawPayload(row), nextMeta)
  };
  const result = await supabaseDbRequest(
    'career_roles',
    `provider=eq.${encodeURIComponent(row.provider)}&provider_role_id=eq.${encodeURIComponent(row.provider_role_id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body
    }
  );
  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return row;
  return result.data[0];
}

function shouldRefreshCareerAiProfile(row, meta) {
  if (!meta || typeof meta !== 'object') return false;
  if (!meta.websiteUrl || !OPENAI_API_KEY) return false;
  if (Number(meta.aiProfileVersion || 0) !== CAREER_AI_PROFILE_VERSION) return true;
  if (!normalizeCareerBillingLabel(row && row.billing_model) && meta.websiteBillingStatus !== 'success') return true;
  if (meta.aiStatus !== 'success' || !meta.aiEnrichedAt) return true;
  const enrichedAt = Date.parse(meta.aiEnrichedAt);
  if (!Number.isFinite(enrichedAt)) return true;
  return (Date.now() - enrichedAt) > (14 * 24 * 60 * 60 * 1000);
}

function shouldRefreshCareerWebsiteBilling(row, meta) {
  if (!meta || typeof meta !== 'object') return false;
  if (!meta.websiteUrl || !OPENAI_API_KEY) return false;
  if (normalizeCareerBillingLabel(row && row.billing_model)) return false;
  if (!meta.websiteBillingCheckedAt) return true;
  const checkedAt = Date.parse(meta.websiteBillingCheckedAt);
  if (!Number.isFinite(checkedAt)) return true;
  return (Date.now() - checkedAt) > (14 * 24 * 60 * 60 * 1000);
}

async function ensureCareerRoleWebsiteBilling(row) {
  if (!row) return null;
  const currentMeta = getCareerRoleGpLinkMeta(row);
  if (!shouldRefreshCareerWebsiteBilling(row, currentMeta)) return row;

  const website = await fetchCareerWebsiteProfile(currentMeta.websiteUrl);
  const checkedAt = new Date().toISOString();
  if (!website.ok || !website.text) {
    return updateCareerRoleRow(row, {
      ...currentMeta,
      websiteBillingCheckedAt: checkedAt,
      websiteBillingStatus: 'error',
      websiteBillingLabel: currentMeta.websiteBillingLabel || '',
      aiError: currentMeta.aiError || website.message || ''
    });
  }

  try {
    const aiProfile = await createCareerRoleAiProfile(row, currentMeta, website.text);
    const normalizedBilling = normalizeCareerBillingLabel(aiProfile && aiProfile.websiteBillingLabel);
    return updateCareerRoleRow(
      row,
      {
        ...currentMeta,
        ...aiProfile,
        websiteBillingCheckedAt: checkedAt,
        websiteBillingStatus: normalizedBilling ? 'success' : 'unclear',
        websiteBillingLabel: normalizedBilling || ''
      },
      normalizedBilling ? {
        billing_model: normalizedBilling,
        private_billing: normalizedBilling === 'Private Billing',
        mixed_billing: normalizedBilling === 'Mixed Billing'
      } : {}
    );
  } catch (err) {
    return updateCareerRoleRow(row, {
      ...currentMeta,
      websiteBillingCheckedAt: checkedAt,
      websiteBillingStatus: 'error',
      websiteBillingLabel: currentMeta.websiteBillingLabel || '',
      aiError: String(err && err.message ? err.message : 'Career billing enrichment failed.').slice(0, 240)
    });
  }
}

async function ensureCareerRoleAiProfile(row) {
  if (!row) return null;
  const currentMeta = getCareerRoleGpLinkMeta(row);
  if (!shouldRefreshCareerAiProfile(row, currentMeta)) return row;

  const website = await fetchCareerWebsiteProfile(currentMeta.websiteUrl);
  if (!website.ok || !website.text) {
    return updateCareerRoleRow(row, {
      ...currentMeta,
      aiStatus: 'fallback',
      aiError: website.message || '',
      aiEnrichedAt: currentMeta.aiEnrichedAt || null
    });
  }

  try {
    const aiProfile = await createCareerRoleAiProfile(row, currentMeta, website.text);
    return updateCareerRoleRow(row, {
      ...currentMeta,
      ...aiProfile,
      aiStatus: 'success',
      aiError: '',
      aiEnrichedAt: new Date().toISOString()
    });
  } catch (err) {
    return updateCareerRoleRow(row, {
      ...currentMeta,
      aiStatus: 'error',
      aiError: String(err && err.message ? err.message : 'Career AI enrichment failed.').slice(0, 240)
    });
  }
}

const AUSTRALIAN_MAJOR_CITIES = {
  'NSW': 'Sydney',
  'VIC': 'Melbourne',
  'QLD': 'Brisbane',
  'WA': 'Perth',
  'SA': 'Adelaide',
  'TAS': 'Hobart',
  'ACT': 'Canberra',
  'NT': 'Darwin'
};

function mapToMajorCity(locationCity, locationState) {
  const state = String(locationState || '').trim().toUpperCase();
  const city = AUSTRALIAN_MAJOR_CITIES[state] || '';
  if (!city && !state) return 'Australia';
  return city ? (city + ', ' + state) : state;
}

function mapCareerRoleRowToClient(row) {
  const gpLinkMeta = getCareerRoleGpLinkMeta(row);
  const location = buildLocationLabel([
    row && row.location_label,
    !row || row.location_label ? '' : buildLocationLabel([row.location_city, row.location_state]),
    !row || row.location_label ? '' : row.location_country
  ]);
  const rawBilling = row && row.billing_model ? String(row.billing_model).trim() : '';
  const billingLabel = normalizeCareerBillingLabel(rawBilling)
    || (row && row.private_billing ? 'Private Billing' : '')
    || (row && row.mixed_billing ? 'Mixed Billing' : '')
    || (gpLinkMeta && normalizeCareerBillingLabel(gpLinkMeta.websiteBillingLabel))
    || 'Billing to be confirmed';
  const tags = Array.isArray(row && row.tags) ? row.tags.filter((item) => typeof item === 'string' && item.trim()) : [];
  const filterTokens = [
    row && row.location_city,
    row && row.location_state,
    billingLabel,
    row && row.private_billing ? 'Private Billing' : '',
    row && row.mixed_billing ? 'Mixed Billing' : '',
    /bulk/i.test(rawBilling) ? 'Bulk Billing' : '',
    row && row.dpa ? 'DPA' : '',
    row && row.metro ? 'Metro' : '',
    row && row.regional ? 'Regional' : '',
    row && row.family_friendly ? 'Family Friendly' : '',
    row && row.earnings_text && /\$|k/i.test(row.earnings_text) ? 'High Earning' : ''
  ].map((value) => String(value || '').trim()).filter(Boolean).filter((value, index, all) => all.indexOf(value) === index);

  return {
    id: makeCareerRoleId(row && row.provider, row && row.provider_role_id),
    sourceId: row && row.provider_role_id ? String(row.provider_role_id) : '',
    match: 'Live opening',
    practiceName: gpLinkMeta.publicHeadline || 'Confidential GP practice',
    location: location || 'Australia',
    locationLine: gpLinkMeta.publicLocationLine || buildCareerPublicLocationLine(row, gpLinkMeta.suburb),
    proximityNote: gpLinkMeta.publicLocationProximity || buildCareerPublicProximityNote(row, gpLinkMeta.suburb),
    summary: gpLinkMeta.publicIntro || (row && row.summary ? String(row.summary) : 'Live role available through GP Link.'),
    billing: billingLabel,
    geography: row && row.regional ? 'Regional' : (row && row.metro ? 'Metro' : 'Australia'),
    earnings: row && row.earnings_text ? String(row.earnings_text) : 'Package on request',
    tags: tags.slice(0, 4),
    benefits: Array.isArray(gpLinkMeta.publicBenefits) ? gpLinkMeta.publicBenefits.slice(0, 4) : [],
    filterTokens,
    support: gpLinkMeta.publicSupport || (row && row.support_summary ? String(row.support_summary) : 'GP Link will coordinate further role details.'),
    practiceType: row && row.practice_type ? String(row.practice_type) : 'Medical practice',
    roleType: row && row.title ? String(row.title) : 'General Practitioner',
    earningNote: row && row.earnings_text ? String(row.earnings_text) : 'Compensation details provided on request.',
    footnote: row && row.employment_type ? String(row.employment_type) : 'Live opening via Zoho Recruit',
    locationSummary: gpLinkMeta.locationSummary || '',
    heroImageUrl: gpLinkMeta.heroImageUrl || '',
    heroImageSourceUrl: gpLinkMeta.heroImageSourceUrl || '',
    heroImageCredit: gpLinkMeta.heroImageCredit || '',
    mapQuery: gpLinkMeta.mapQuery || '',
    mapLabel: gpLinkMeta.suburb || row.location_city || row.location_label || '',
    majorCity: mapToMajorCity(row && row.location_city, row && row.location_state),
    qualifyHint: (row && row.visa_pathway_aligned) ? 'Visa pathway' : (row && row.dpa) ? 'DPA eligible' : '',
    aiStatus: gpLinkMeta.aiStatus || 'fallback'
  };
}

function mapCareerRoleDetailToClient(row) {
  const base = mapCareerRoleRowToClient(row);
  return {
    ...base,
    sourceWebsiteAvailable: !!(getCareerRoleGpLinkMeta(row).websiteUrl),
    mapAvailable: !!(getCareerRoleGpLinkMeta(row).mapQuery),
    detailCards: [
      { label: 'Role', value: base.roleType },
      { label: 'Practice profile', value: base.practiceType },
      { label: 'Support', value: base.support },
      { label: 'Location profile', value: base.locationSummary || 'Australian community setting' },
      { label: 'Earnings note', value: base.earningNote },
      { label: 'Employment type', value: base.footnote }
    ]
  };
}

function parseCareerRolePublicId(publicId) {
  const value = String(publicId || '').trim();
  if (!value) return null;
  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0) return null;
  const provider = value.slice(0, separatorIndex).trim();
  const providerRoleId = value.slice(separatorIndex + 1).trim();
  if (!provider || !providerRoleId) return null;
  return { provider, providerRoleId };
}

async function syncZohoRecruitRoles() {
  if (!isZohoRecruitConfigured()) {
    return { ok: false, status: 503, message: 'Zoho Recruit integration is not configured.' };
  }
  const connection = await getZohoRecruitConnection();
  if (!connection || !connection.refreshToken) {
    return { ok: false, status: 400, message: 'Zoho Recruit is not connected.' };
  }

  const refreshed = await refreshZohoRecruitAccessToken(connection);
  if (!refreshed.ok) {
    const errorMessage = getZohoErrorMessage(refreshed.data, 'Failed to refresh Zoho Recruit access token.');
    await upsertZohoRecruitConnection({
      status: 'error',
      lastSyncStatus: 'error',
      lastSyncError: errorMessage
    });
    return { ok: false, status: refreshed.status || 502, message: errorMessage };
  }

  const accessToken = String(refreshed.data && refreshed.data.access_token ? refreshed.data.access_token : '').trim();
  const apiDomain = normalizeUrlBase(
    refreshed.data && refreshed.data.api_domain,
    (await getZohoRecruitConnection() || {}).apiDomain || ''
  );
  if (!accessToken || !apiDomain) {
    return { ok: false, status: 502, message: 'Zoho Recruit token refresh response was incomplete.' };
  }

  const syncedAt = new Date().toISOString();
  const rows = [];
  const seenIds = new Set();

  for (let page = 1; page <= ZOHO_RECRUIT_SYNC_MAX_PAGES; page += 1) {
    const result = await fetchZohoRecruitJobOpenings(connection, accessToken, apiDomain, {
      page,
      per_page: ZOHO_RECRUIT_SYNC_PAGE_SIZE
    });
    if (!result.ok) {
      const errorMessage = getZohoErrorMessage(result.data, `Failed to fetch Zoho Recruit job openings (HTTP ${result.status || 0}).`);
      await upsertZohoRecruitConnection({
        apiDomain,
        status: 'error',
        lastSyncStatus: 'error',
        lastSyncError: errorMessage
      });
      return { ok: false, status: result.status || 502, message: errorMessage };
    }

    const records = Array.isArray(result.data && result.data.data) ? result.data.data : [];
    records.forEach((record) => {
      const mapped = buildCareerRoleRecordFromZoho(record, syncedAt);
      if (!mapped) return;
      // Mark jobs with "Test" in the title as inactive (filtered from user view)
      if (/test/i.test(mapped.title || '')) {
        mapped.is_active = false;
      }
      rows.push(mapped);
      seenIds.add(mapped.provider_role_id);
    });

    const moreRecords = !!(result.data && result.data.info && result.data.info.more_records);
    if (!moreRecords || records.length === 0) break;
  }

  for (let index = 0; index < rows.length; index += 100) {
    const chunk = rows.slice(index, index + 100);
    const ok = await upsertCareerRoleBatch(chunk);
    if (!ok) {
      await upsertZohoRecruitConnection({
        apiDomain,
        status: 'error',
        lastSyncStatus: 'error',
        lastSyncError: 'Failed to store synced Zoho Recruit roles in Supabase.'
      });
      return { ok: false, status: 502, message: 'Failed to store synced Zoho Recruit roles.' };
    }
  }

  const missingBillingRows = rows
    .filter((row) => !normalizeCareerBillingLabel(row && row.billing_model))
    .slice(0, 8);
  for (const row of missingBillingRows) {
    try {
      await ensureCareerRoleWebsiteBilling(row);
    } catch (err) {
      // Billing enrichment is best-effort and should not fail the core sync.
    }
  }

  const existing = await listCareerRoleRows(false, 'zoho_recruit');
  const inactiveIds = existing
    .map((row) => row && typeof row.provider_role_id === 'string' ? row.provider_role_id : '')
    .filter((id) => id && !seenIds.has(id));
  if (!(await markCareerRolesInactive('zoho_recruit', inactiveIds))) {
    return { ok: false, status: 502, message: 'Failed to retire inactive Zoho Recruit roles.' };
  }

  const connected = await upsertZohoRecruitConnection({
    apiDomain,
    status: 'connected',
    lastSyncAt: syncedAt,
    lastSyncStatus: 'success',
    lastSyncError: '',
    metadata: {
      syncedRoleCount: rows.length,
      lastSyncAt: syncedAt
    }
  });

  // Invalidate in-memory cache so next request fetches fresh data
  _zohoRolesCache = null;
  _zohoRolesFetchPromise = null;

  return {
    ok: true,
    status: 200,
    connected,
    syncedAt,
    syncedRoleCount: rows.length
  };
}

async function runZohoRecruitScheduledSync() {
  const connection = await getZohoRecruitConnection();
  const recentSyncAt = connection && connection.lastSyncAt ? Date.parse(connection.lastSyncAt) : NaN;
  if (Number.isFinite(recentSyncAt) && (Date.now() - recentSyncAt) < 45000) {
    return {
      ok: true,
      skipped: true,
      reason: 'recent_sync',
      syncedAt: connection.lastSyncAt,
      syncedRoleCount: connection && connection.metadata && Number(connection.metadata.syncedRoleCount || 0) || 0,
      connected: connection
    };
  }

  const lockKey = 'zoho_recruit_sync_lock';
  const existingLock = await getRuntimeKv(lockKey);
  if (existingLock && existingLock.value && existingLock.value.startedAt) {
    return {
      ok: true,
      skipped: true,
      reason: 'sync_in_progress',
      syncedAt: connection && connection.lastSyncAt ? connection.lastSyncAt : null,
      syncedRoleCount: connection && connection.metadata && Number(connection.metadata.syncedRoleCount || 0) || 0,
      connected: connection
    };
  }

  await setRuntimeKv(lockKey, { startedAt: new Date().toISOString() }, Date.now() + 55 * 1000);
  try {
    return await syncZohoRecruitRoles();
  } finally {
    await deleteRuntimeKv(lockKey);
  }
}

async function supabaseStorageDownloadObject(bucket, objectPath) {
  if (!isSupabaseDbConfigured()) return null;
  try {
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeSupabaseObjectPath(objectPath)}`, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    if (!response || !response.ok) return null;
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await response.arrayBuffer());
    return { buffer, mimeType: contentType };
  } catch (err) {
    return null;
  }
}

async function getZohoRecruitAccessTokenAndDomain() {
  if (!isZohoRecruitConfigured()) return null;
  const connection = await getZohoRecruitConnection();
  if (!connection || !connection.refreshToken) return null;
  const refreshed = await refreshZohoRecruitAccessToken(connection);
  if (!refreshed.ok) return null;
  const accessToken = String(refreshed.data && refreshed.data.access_token ? refreshed.data.access_token : '').trim();
  const apiDomain = normalizeUrlBase(
    refreshed.data && refreshed.data.api_domain,
    (connection || {}).apiDomain || ''
  );
  if (!accessToken || !apiDomain) return null;
  return { accessToken, apiDomain, connection };
}

async function createZohoRecruitCandidate(userId, email, userProfile, onboardingState) {
  const zoho = await getZohoRecruitAccessTokenAndDomain();
  if (!zoho) return { ok: false, message: 'Zoho Recruit is not connected.' };

  const firstName = String(userProfile.first_name || '').trim();
  const lastName = String(userProfile.last_name || '').trim();
  const phone = String(userProfile.phone_number || '').trim();
  const countryDial = String(userProfile.country_dial || '').trim();
  const fullPhone = countryDial && phone ? `${countryDial}${phone}` : phone;
  const qualCountry = String(userProfile.qualification_country || onboardingState.country || '').trim();
  const preferredCity = String(userProfile.preferred_city || onboardingState.preferredCity || '').trim();
  const targetDate = String(userProfile.target_arrival_date || onboardingState.targetDate || '').trim();
  const whoMoving = String(userProfile.who_moving || onboardingState.whoMoving || '').trim();
  const childrenCount = userProfile.children_count || onboardingState.childrenCount || 0;

  // Build relocation details text
  const relocationParts = [];
  if (whoMoving) relocationParts.push(`Moving: ${whoMoving}`);
  if (childrenCount > 0) relocationParts.push(`Children: ${childrenCount}`);
  if (qualCountry) relocationParts.push(`From: ${qualCountry}`);
  const relocationDetails = relocationParts.join(', ');

  const candidateData = {
    data: [{
      First_Name: firstName,
      Last_Name: lastName || email.split('@')[0],
      Email: email,
      Phone: fullPhone || undefined,
      Country: qualCountry || undefined,
      Current_Job_Title: 'General Practitioner',
      Source: 'GP Link App',
      // Custom GP Link App fields
      App_Email: email,
      Target_Arrival_Date: targetDate || undefined,
      Preferred_City: preferredCity || undefined,
      Relocation_Details: relocationDetails || undefined
    }]
  };

  // Try multiple module path variants for Candidates
  const candidatePaths = ['Candidates', 'candidates'];
  let lastError = null;
  for (const path of candidatePaths) {
    const result = await zohoRecruitApiPost(zoho.apiDomain, path, zoho.accessToken, candidateData);
    if (result.ok && result.data && result.data.data && result.data.data[0]) {
      const created = result.data.data[0];
      const zohoId = created.details && created.details.id ? String(created.details.id) : '';
      if (zohoId) {
        // Store Zoho Candidate ID in user_profiles
        await supabaseDbRequest('user_profiles', `user_id=eq.${encodeURIComponent(userId)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: { zoho_candidate_id: zohoId, updated_at: new Date().toISOString() }
        });
        return { ok: true, zohoId };
      }
    }
    lastError = result;
  }
  return { ok: false, message: 'Failed to create Zoho Recruit candidate.', detail: lastError };
}

async function uploadDocumentsToZohoCandidate(userId, zohoCanidateId) {
  const zoho = await getZohoRecruitAccessTokenAndDomain();
  if (!zoho || !zohoCanidateId) return;

  // Get all user documents from DB
  const docsResult = await supabaseDbRequest(
    'user_documents',
    `select=document_key,country_code,file_name,file_url&user_id=eq.${encodeURIComponent(userId)}&status=eq.uploaded`
  );
  if (!docsResult.ok || !Array.isArray(docsResult.data)) return;

  for (const doc of docsResult.data) {
    const storagePath = doc.file_url;
    if (!storagePath) continue;
    const downloaded = await supabaseStorageDownloadObject(SUPABASE_DOCUMENT_BUCKET, storagePath);
    if (!downloaded) continue;
    const fileName = doc.file_name || `${doc.document_key || 'document'}.pdf`;
    await zohoRecruitApiUploadAttachment(
      zoho.apiDomain, 'Candidates', zohoCanidateId, zoho.accessToken,
      fileName, downloaded.buffer, downloaded.mimeType
    );
  }
}

async function createZohoRecruitApplication(zohoCandidateId, zohoJobId) {
  const zoho = await getZohoRecruitAccessTokenAndDomain();
  if (!zoho) return { ok: false, message: 'Zoho Recruit is not connected.' };

  // Look up the provider_role_id to get the actual Zoho Job Opening ID
  const applicationData = {
    data: [{
      Candidate_Id: zohoCandidateId,
      Job_Opening: zohoJobId,
      Application_Status: 'New',
      Source: 'GP Link App'
    }]
  };

  const appPaths = ['Applications', 'applications'];
  let lastError = null;
  for (const path of appPaths) {
    const result = await zohoRecruitApiPost(zoho.apiDomain, path, zoho.accessToken, applicationData);
    if (result.ok) return { ok: true, data: result.data };
    lastError = result;
  }
  return { ok: false, message: 'Failed to create Zoho Recruit application.', detail: lastError };
}

async function getRuntimeKv(key) {
  if (!isSupabaseDbConfigured()) return null;
  const result = await supabaseDbRequest(
    'runtime_kv',
    `select=key,value,expires_at&key=eq.${encodeURIComponent(String(key || ''))}&limit=1`
  );
  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) return null;
  const row = result.data[0];
  const expiresAt = row && typeof row.expires_at === 'string' ? row.expires_at : null;
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
    await deleteRuntimeKv(key);
    return null;
  }
  return {
    key: row && typeof row.key === 'string' ? row.key : String(key || ''),
    value: row && row.value && typeof row.value === 'object' ? row.value : {}
  };
}

async function setRuntimeKv(key, value, expiresAtMs = null) {
  if (!isSupabaseDbConfigured()) return false;
  const payload = [{
    key: String(key || ''),
    value: value && typeof value === 'object' ? value : {},
    expires_at: typeof expiresAtMs === 'number' ? new Date(expiresAtMs).toISOString() : null,
    updated_at: new Date().toISOString()
  }];
  const result = await supabaseDbRequest(
    'runtime_kv',
    'on_conflict=key',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: payload
    }
  );
  return result.ok;
}

async function deleteRuntimeKv(key) {
  if (!isSupabaseDbConfigured()) return false;
  const result = await supabaseDbRequest(
    'runtime_kv',
    `key=eq.${encodeURIComponent(String(key || ''))}`,
    { method: 'DELETE' }
  );
  return result.ok;
}

function createEmptyHybridAgentBridgeStore() {
  return {
    version: 1,
    primaryWorkerId: '',
    workers: {},
    commands: [],
    commandSeq: 0
  };
}

function sanitizeHybridAgentWorkerId(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function sanitizeHybridAgentWorkerName(value) {
  const raw = String(value || '').trim().replace(/\s+/g, ' ');
  return raw.slice(0, 80);
}

function normalizeHybridAgentWorkerRecord(workerId, value) {
  const source = value && typeof value === 'object' ? value : {};
  const safeId = sanitizeHybridAgentWorkerId(workerId || source.id || '');
  if (!safeId) return null;
  return {
    id: safeId,
    name: sanitizeHybridAgentWorkerName(source.name || '') || safeId,
    tokenHash: typeof source.tokenHash === 'string' ? source.tokenHash : '',
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : '',
    createdBy: typeof source.createdBy === 'string' ? source.createdBy : '',
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
    enabled: source.enabled !== false,
    revokedAt: typeof source.revokedAt === 'string' ? source.revokedAt : '',
    lastSeenAt: typeof source.lastSeenAt === 'string' ? source.lastSeenAt : '',
    providers: source.providers && typeof source.providers === 'object' ? source.providers : null,
    providerStatusRefreshedAt: typeof source.providerStatusRefreshedAt === 'string' ? source.providerStatusRefreshedAt : '',
    runs: Array.isArray(source.runs) ? source.runs.filter(function (run) { return run && typeof run === 'object' && run.runId; }).slice(0, 20) : [],
    activeRunId: typeof source.activeRunId === 'string' ? source.activeRunId : '',
    bridgeInfo: source.bridgeInfo && typeof source.bridgeInfo === 'object' ? source.bridgeInfo : null,
    relayOrigin: typeof source.relayOrigin === 'string' ? source.relayOrigin : '',
    lastCommandResultAt: typeof source.lastCommandResultAt === 'string' ? source.lastCommandResultAt : '',
    meta: source.meta && typeof source.meta === 'object' ? source.meta : {}
  };
}

function normalizeHybridAgentBridgeStore(value) {
  const source = value && typeof value === 'object' ? value : {};
  const workersInput = source.workers && typeof source.workers === 'object' ? source.workers : {};
  const workers = {};
  Object.keys(workersInput).forEach(function (workerId) {
    const normalized = normalizeHybridAgentWorkerRecord(workerId, workersInput[workerId]);
    if (normalized) workers[normalized.id] = normalized;
  });

  const commands = Array.isArray(source.commands) ? source.commands : [];
  const normalizedCommands = commands
    .filter(function (command) { return command && typeof command === 'object' && command.id; })
    .map(function (command) {
      return {
        id: String(command.id),
        workerId: sanitizeHybridAgentWorkerId(command.workerId || ''),
        type: String(command.type || ''),
        payload: command.payload && typeof command.payload === 'object' ? command.payload : {},
        requestedBy: typeof command.requestedBy === 'string' ? command.requestedBy : '',
        createdAt: typeof command.createdAt === 'string' ? command.createdAt : '',
        status: typeof command.status === 'string' ? command.status : 'queued',
        sentAt: typeof command.sentAt === 'string' ? command.sentAt : '',
        completedAt: typeof command.completedAt === 'string' ? command.completedAt : '',
        deliveryCount: Number(command.deliveryCount || 0) || 0,
        result: command.result && typeof command.result === 'object' ? command.result : null,
        message: typeof command.message === 'string' ? command.message : ''
      };
    })
    .filter(function (command) { return command.workerId; })
    .slice(-200);

  const primaryWorkerId = sanitizeHybridAgentWorkerId(source.primaryWorkerId || '');
  return {
    version: 1,
    primaryWorkerId: primaryWorkerId && workers[primaryWorkerId] ? primaryWorkerId : (Object.keys(workers)[0] || ''),
    workers,
    commands: normalizedCommands,
    commandSeq: Math.max(0, Number(source.commandSeq || 0) || 0)
  };
}

async function getPersistentHybridAgentBridgeStore(force = false) {
  const cache = hybridAgentControlState.bridgeStoreCache;
  if (!force && cache.data) return cache.data;
  if (!force && cache.inFlight) return cache.inFlight;

  const loadPromise = (async function () {
    let value = null;
    if (isSupabaseDbConfigured()) {
      const runtime = await getRuntimeKv(HYBRID_AGENT_RUNTIME_KV_KEY);
      value = runtime && runtime.value ? runtime.value : null;
    } else {
      value = dbState.hybridAgentBridgeStore || null;
    }
    const normalized = normalizeHybridAgentBridgeStore(value);
    hybridAgentControlState.bridgeStoreCache.data = normalized;
    hybridAgentControlState.bridgeStoreCache.loadedAt = now();
    hybridAgentControlState.bridgeStoreCache.inFlight = null;
    return normalized;
  })().catch(function (error) {
    hybridAgentControlState.bridgeStoreCache.inFlight = null;
    throw error;
  });

  hybridAgentControlState.bridgeStoreCache.inFlight = loadPromise;
  return loadPromise;
}

async function savePersistentHybridAgentBridgeStore(store) {
  const normalized = normalizeHybridAgentBridgeStore(store);
  hybridAgentControlState.bridgeStoreCache.data = normalized;
  hybridAgentControlState.bridgeStoreCache.loadedAt = now();
  hybridAgentControlState.bridgeStoreCache.inFlight = null;

  if (isSupabaseDbConfigured()) {
    const saved = await setRuntimeKv(HYBRID_AGENT_RUNTIME_KV_KEY, normalized, null);
    return !!saved;
  }

  dbState.hybridAgentBridgeStore = normalized;
  saveDbState();
  return true;
}

function shouldTryNextZohoRecruitVariant(result) {
  const errorText = getZohoErrorMessage(result && result.data, '').toLowerCase();
  const rawText = String(result && result.data && result.data.raw ? result.data.raw : '').toLowerCase();
  const missingModule = errorText.includes('invalid module')
    || errorText.includes('not supported')
    || errorText.includes('relation name')
    || errorText.includes('invalid relation')
    || errorText.includes('invalid field');
  const htmlFallback = rawText.includes('<html')
    || rawText.includes('<!doctype html')
    || rawText.includes('crm_error')
    || rawText.includes('zoho crm');
  return missingModule || htmlFallback || result.status === 401 || result.status === 403 || result.status === 404;
}

async function fetchZohoRecruitRecordsWithVariants(connection, accessToken, apiDomain, resourcePaths, queryParams = {}) {
  const paths = Array.isArray(resourcePaths) ? resourcePaths.filter(Boolean) : [];
  if (paths.length === 0) {
    return { ok: false, status: 400, data: { message: 'Zoho Recruit resource path missing.' }, records: [] };
  }

  const bases = getZohoRecruitCandidateBases(connection, apiDomain);
  let lastFailure = { ok: false, status: 502, data: { message: 'Failed to fetch Zoho Recruit records.' }, records: [] };

  for (const base of bases) {
    for (const resourcePath of paths) {
      const result = await zohoRecruitApiGet(base, resourcePath, accessToken, queryParams);
      if (result.ok) {
        return {
          ...result,
          records: Array.isArray(result.data && result.data.data) ? result.data.data : []
        };
      }
      lastFailure = { ...result, records: [] };
      if (!shouldTryNextZohoRecruitVariant(result)) {
        return lastFailure;
      }
    }
  }

  return lastFailure;
}

async function downloadZohoRecruitBinaryWithVariants(connection, accessToken, apiDomain, resourcePaths) {
  const paths = Array.isArray(resourcePaths) ? resourcePaths.filter(Boolean) : [];
  if (paths.length === 0) return null;

  const bases = getZohoRecruitCandidateBases(connection, apiDomain);
  for (const base of bases) {
    for (const resourcePath of paths) {
      const url = `${normalizeUrlBase(base, '')}/recruit/v2/${String(resourcePath || '').replace(/^\/+/, '')}`;
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Zoho-oauthtoken ${String(accessToken || '').trim()}`
          }
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const data = text ? (() => { try { return JSON.parse(text); } catch (err) { return { raw: text }; } })() : {};
          const failed = { ok: false, status: response.status, data };
          if (shouldTryNextZohoRecruitVariant(failed)) continue;
          return null;
        }
        const mimeType = response.headers.get('content-type') || 'application/octet-stream';
        if (/application\/json/i.test(mimeType)) {
          continue;
        }
        const disposition = response.headers.get('content-disposition') || '';
        const match = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
        const fileName = match ? decodeURIComponent(match[1]) : '';
        const buffer = Buffer.from(await response.arrayBuffer());
        return {
          buffer,
          mimeType,
          fileName
        };
      } catch (err) {}
    }
  }

  return null;
}

async function fetchZohoRecruitApplicationRecord(zoho, applicationId) {
  const value = String(applicationId || '').trim();
  if (!zoho || !value) return null;
  const result = await fetchZohoRecruitRecordsWithVariants(
    zoho.connection,
    zoho.accessToken,
    zoho.apiDomain,
    [`Applications/${value}`, `applications/${value}`]
  );
  return Array.isArray(result.records) && result.records[0] ? result.records[0] : null;
}

async function searchZohoRecruitApplicationsByEmail(zoho, email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!zoho || !normalized) return [];
  const result = await fetchZohoRecruitRecordsWithVariants(
    zoho.connection,
    zoho.accessToken,
    zoho.apiDomain,
    ['Applications/search', 'applications/search'],
    {
      email: normalized,
      page: 1,
      per_page: 50
    }
  );
  return Array.isArray(result.records) ? result.records : [];
}

async function searchZohoRecruitApplicationsByCandidateId(zoho, candidateId) {
  const value = String(candidateId || '').trim();
  if (!zoho || !value) return [];
  const criteriaCandidates = [
    `(Candidate_Id:equals:${value})`,
    `(Candidate:equals:${value})`,
    `(Candidate_Name:equals:${value})`
  ];
  for (const criteria of criteriaCandidates) {
    const result = await fetchZohoRecruitRecordsWithVariants(
      zoho.connection,
      zoho.accessToken,
      zoho.apiDomain,
      ['Applications/search', 'applications/search'],
      {
        criteria,
        page: 1,
        per_page: 50
      }
    );
    if (Array.isArray(result.records) && result.records.length > 0) return result.records;
    if (result.status && !shouldTryNextZohoRecruitVariant(result)) break;
  }
  return [];
}

async function fetchZohoRecruitJobOpeningRecord(zoho, jobOpeningId) {
  const value = String(jobOpeningId || '').trim();
  if (!zoho || !value) return null;
  const result = await fetchZohoRecruitRecordsWithVariants(
    zoho.connection,
    zoho.accessToken,
    zoho.apiDomain,
    [`JobOpenings/${value}`, `jobopenings/${value}`, `Job_Openings/${value}`]
  );
  return Array.isArray(result.records) && result.records[0] ? result.records[0] : null;
}

async function fetchZohoRecruitClientContacts(zoho, clientId) {
  const value = String(clientId || '').trim();
  if (!zoho || !value) return [];
  const result = await fetchZohoRecruitRecordsWithVariants(
    zoho.connection,
    zoho.accessToken,
    zoho.apiDomain,
    [
      `Clients/${value}/Contacts`,
      `Clients/${value}/contacts`,
      `clients/${value}/Contacts`,
      `clients/${value}/contacts`
    ],
    {
      page: 1,
      per_page: 50
    }
  );
  return Array.isArray(result.records) ? result.records : [];
}

async function listZohoRecruitApplicationAttachments(zoho, applicationId) {
  const value = String(applicationId || '').trim();
  if (!zoho || !value) return [];
  const result = await fetchZohoRecruitRecordsWithVariants(
    zoho.connection,
    zoho.accessToken,
    zoho.apiDomain,
    [
      `Applications/${value}/Attachments`,
      `Applications/${value}/attachments`,
      `applications/${value}/Attachments`,
      `applications/${value}/attachments`
    ],
    {
      page: 1,
      per_page: 50
    }
  );
  return Array.isArray(result.records) ? result.records : [];
}

async function downloadZohoRecruitApplicationAttachment(zoho, applicationId, attachmentId) {
  const appId = String(applicationId || '').trim();
  const fileId = String(attachmentId || '').trim();
  if (!zoho || !appId || !fileId) return null;
  return downloadZohoRecruitBinaryWithVariants(
    zoho.connection,
    zoho.accessToken,
    zoho.apiDomain,
    [
      `Applications/${appId}/Attachments/${fileId}`,
      `Applications/${appId}/attachments/${fileId}`,
      `applications/${appId}/Attachments/${fileId}`,
      `applications/${appId}/attachments/${fileId}`
    ]
  );
}

function sortZohoRecordsByRecent(left, right) {
  const leftTs = Date.parse(getZohoField(left, ['Modified_Time', 'Updated_On', 'Created_Time']) || '') || 0;
  const rightTs = Date.parse(getZohoField(right, ['Modified_Time', 'Updated_On', 'Created_Time']) || '') || 0;
  return rightTs - leftTs;
}

function getZohoAttachmentId(record) {
  return sanitizeZohoText(record && record.id);
}

function getZohoAttachmentFileName(record) {
  return getZohoField(record, ['File_Name', 'Name', 'file_name']);
}

function getZohoAttachmentCategory(record) {
  return getZohoField(record, ['Attachment_Category', 'Category', 'category']);
}

function getZohoAttachmentUpdatedAt(record) {
  return getZohoField(record, ['Modified_Time', 'Updated_On', 'Created_Time']);
}

function buildZohoAttachmentSignature(record) {
  if (!record || typeof record !== 'object') return '';
  const attachmentId = getZohoAttachmentId(record);
  const fileName = getZohoAttachmentFileName(record);
  const updatedAt = getZohoAttachmentUpdatedAt(record);
  const category = getZohoAttachmentCategory(record);
  return [attachmentId, fileName, updatedAt, category]
    .map((value) => String(value || '').trim())
    .join('|');
}

function scoreZohoContractAttachment(record) {
  const fileName = getZohoAttachmentFileName(record).toLowerCase();
  const category = getZohoAttachmentCategory(record).toLowerCase();
  const value = `${fileName} ${category}`.trim();
  let total = 0;
  if (/contract|contracts/.test(category)) total += 8;
  if (/contract|agreement|employment|offer/.test(value)) total += 5;
  if (/signed|executed|final|version/.test(value)) total += 2;
  if (/\.(pdf|docx|doc|rtf|txt)\b/.test(fileName) || /(pdf|word|document)/.test(value)) total += 2;
  return total;
}

function selectZohoContractAttachmentCandidates(records, maxCandidates = 4) {
  const list = Array.isArray(records) ? records.slice() : [];
  list.sort((left, right) => {
    const diff = scoreZohoContractAttachment(right) - scoreZohoContractAttachment(left);
    if (diff !== 0) return diff;
    return sortZohoRecordsByRecent(left, right);
  });
  return list.filter((record) => scoreZohoContractAttachment(record) > 0).slice(0, Math.max(1, maxCandidates));
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#xA;/gi, '\n')
    .replace(/&#x9;/gi, '\t');
}

function extractDocxXmlText(xmlValue) {
  const xml = String(xmlValue || '');
  if (!xml) return '';
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/gi, '\t')
      .replace(/<w:(?:br|cr)\b[^>]*\/>/gi, '\n')
      .replace(/<\/w:p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  ).replace(/\n{3,}/g, '\n\n').trim();
}

function unzipBufferEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return [];
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const localSignature = 0x04034b50;
  const searchStart = Math.max(0, buffer.length - 65557);
  let eocdOffset = -1;

  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) return [];

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let pointer = centralDirectoryOffset;

  for (let index = 0; index < totalEntries && pointer + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(pointer) !== centralSignature) break;
    const compressionMethod = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const fileNameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localHeaderOffset = buffer.readUInt32LE(pointer + 42);
    const fileName = buffer.slice(pointer + 46, pointer + 46 + fileNameLength).toString('utf8');
    pointer += 46 + fileNameLength + extraLength + commentLength;

    if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== localSignature) continue;
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressedBuffer = buffer.slice(dataStart, dataStart + compressedSize);

    try {
      let content = null;
      if (compressionMethod === 0) content = compressedBuffer;
      if (compressionMethod === 8) content = zlib.inflateRawSync(compressedBuffer);
      if (content) entries.push({ fileName, content });
    } catch (err) {}
  }

  return entries;
}

function extractDocxText(buffer) {
  const entries = unzipBufferEntries(buffer);
  if (!entries.length) return '';
  const xmlChunks = entries
    .filter((entry) => /^word\/(?:document|header\d+|footer\d+)\.xml$/i.test(entry.fileName))
    .sort((left, right) => left.fileName.localeCompare(right.fileName))
    .map((entry) => extractDocxXmlText(entry.content.toString('utf8')))
    .filter(Boolean);
  return xmlChunks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractRtfText(value) {
  return String(value || '')
    .replace(/\\par[d]?/gi, '\n')
    .replace(/\\tab/gi, '\t')
    .replace(/\\'[0-9a-f]{2}/gi, ' ')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractStructuredContractText(fileName, fileBuffer, mimeType) {
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) return '';
  const lowerName = String(fileName || '').trim().toLowerCase();
  const lowerMime = String(mimeType || '').trim().toLowerCase();
  if (/\.docx$/i.test(lowerName) || lowerMime.includes('wordprocessingml')) {
    return extractDocxText(fileBuffer);
  }
  if (/\.rtf$/i.test(lowerName) || lowerMime.includes('rtf')) {
    return extractRtfText(fileBuffer.toString('utf8'));
  }
  if (/\.txt$/i.test(lowerName) || lowerMime.startsWith('text/')) {
    return fileBuffer.toString('utf8').trim();
  }
  if (/\.html?$/i.test(lowerName) || lowerMime.includes('html') || lowerMime.includes('xml')) {
    return stripHtml(fileBuffer.toString('utf8')).trim();
  }
  return '';
}

function normalizeContractSplitDisplay(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  const slashMatch = source.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (slashMatch) return `${slashMatch[1]}/${slashMatch[2]}`;
  const percentMatch = source.match(/(\d{1,2}(?:\.\d+)?)\s*(?:%|percent|per cent)/i);
  if (percentMatch) return `${percentMatch[1]}%`;
  return source.replace(/\s+/g, ' ').trim();
}

function normalizeContractCurrencyDisplay(value) {
  const source = String(value || '').replace(/\s+/g, ' ').trim();
  if (!source) return '';
  const match = source.match(/^\$\s*([\d,\s]+(?:\.\d{2})?)(.*)$/);
  if (!match) return source;
  const amount = match[1].replace(/\s+/g, '');
  const suffix = match[2].replace(/\s+/g, ' ').trim();
  return `$${amount}${suffix ? ` ${suffix}` : ''}`.trim();
}

function normalizeContractLengthDisplay(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function scoreContractSplitDisplay(value) {
  const normalized = normalizeContractSplitDisplay(value);
  if (!normalized) return 0;
  if (/^\d{1,2}\/\d{1,2}$/.test(normalized)) return 4;
  if (/^\d{1,2}(?:\.\d+)?%$/.test(normalized)) return 3;
  return 1;
}

function parseContractCurrencyAmount(value) {
  const normalized = normalizeContractCurrencyDisplay(value);
  const match = normalized.match(/(\d[\d,]*)(?:\.\d{2})?/);
  if (!match) return 0;
  const numeric = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatContractPercentValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  const rounded = Math.round(numeric * 100) / 100;
  const normalized = Number.isInteger(rounded)
    ? String(rounded)
    : String(rounded).replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '');
  return `${normalized}%`;
}

function formatContractCurrencyAmount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  const rounded = Math.round(numeric * 100) / 100;
  const hasCents = Math.abs(rounded - Math.round(rounded)) > 0.0001;
  return `$${rounded.toLocaleString('en-AU', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2
  })}`;
}

function scoreContractRelocationDisplay(value) {
  const normalized = normalizeContractCurrencyDisplay(value);
  if (!normalized) return 0;
  const amount = parseContractCurrencyAmount(normalized);
  let score = amount > 0 ? 1 : 0;
  if (amount >= 100) score += 1;
  if (amount >= 1000) score += 2;
  if (/\b(?:aud|australian dollars?)\b/i.test(normalized)) score += 1;
  if (/\d,\d{3}\b/.test(normalized)) score += 1;
  return score;
}

function scoreContractLengthDisplay(value) {
  const normalized = normalizeContractLengthDisplay(value);
  if (!normalized) return 0;
  if (/\d+\s*(?:year|month|week)s?\b/i.test(normalized)) return 3;
  return 1;
}

function pickBetterContractTermValue(leftValue, rightValue, scoreFn, normalizeFn) {
  const leftScore = scoreFn(leftValue);
  const rightScore = scoreFn(rightValue);
  if (rightScore > leftScore) return normalizeFn(rightValue);
  if (leftScore > 0) return normalizeFn(leftValue);
  return normalizeFn(rightValue || leftValue || '');
}

function extractDoctorShareFromSource(sourceText) {
  const text = stripHtml(String(sourceText || '')).replace(/\s+/g, ' ').trim();
  if (!text) return '';

  const directPatterns = [
    /(?:doctor|gp|practitioner)[^.%]{0,80}?(?:receive|receives|retain|retains|keep|keeps|paid|entitled to)[^.%]{0,40}?(\d{1,2}(?:\.\d+)?)\s*(?:%|percent|per cent)/i,
    /(\d{1,2}(?:\.\d+)?)\s*(?:%|percent|per cent)[^.%]{0,40}?(?:to the doctor|to doctor|to the gp|to practitioner)/i
  ];
  for (const pattern of directPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) return formatContractPercentValue(match[1]);
  }

  const practiceFeeMatch = text.match(/(?:service fee|management fee|practice retains?|retained by practice|fee charged to the doctor|charged to the doctor|practice keeps?)[^.%]{0,60}?(\d{1,2}(?:\.\d+)?)\s*(?:%|percent|per cent)/i);
  if (practiceFeeMatch && practiceFeeMatch[1]) {
    const feePercent = Number(practiceFeeMatch[1]);
    if (Number.isFinite(feePercent) && feePercent > 0 && feePercent < 100) {
      return formatContractPercentValue(100 - feePercent);
    }
  }

  return '';
}

function extractRelocationPackageFromSource(sourceText) {
  const text = stripHtml(String(sourceText || '')).replace(/\s+/g, ' ').trim();
  if (!text) return '';

  const relocationWindow = text.match(/(?:relocation(?: package| allowance| support)?|sign[-\s]?on)[\s\S]{0,320}/i);
  if (!relocationWindow || !relocationWindow[0]) return '';

  const amountMatches = [...relocationWindow[0].matchAll(/\$\s*\d[\d,\s]*(?:\.\d{2})?/g)];
  if (!amountMatches.length) return '';

  const amounts = amountMatches
    .map((match) => parseContractCurrencyAmount(match[0]))
    .filter((value) => value > 0);
  if (!amounts.length) return '';
  if (amounts.length === 1) return formatContractCurrencyAmount(amounts[0]);

  const total = amounts.reduce((sum, value) => sum + value, 0);
  const largest = Math.max(...amounts);
  const remainder = total - largest;
  if (amounts.length >= 3 && Math.abs(largest - remainder) < 0.01) {
    return formatContractCurrencyAmount(largest);
  }
  return formatContractCurrencyAmount(total);
}

function mergeCareerContractTerms(heuristicTerms, aiTerms) {
  const heuristic = heuristicTerms && typeof heuristicTerms === 'object' ? heuristicTerms : {};
  const ai = aiTerms && typeof aiTerms === 'object' ? aiTerms : {};
  return {
    splitDisplay: pickBetterContractTermValue(
      heuristic.splitDisplay,
      ai.splitDisplay,
      scoreContractSplitDisplay,
      normalizeContractSplitDisplay
    ),
    relocationPackageDisplay: pickBetterContractTermValue(
      heuristic.relocationPackageDisplay,
      ai.relocationPackageDisplay,
      scoreContractRelocationDisplay,
      normalizeContractCurrencyDisplay
    ),
    contractLengthDisplay: pickBetterContractTermValue(
      heuristic.contractLengthDisplay,
      ai.contractLengthDisplay,
      scoreContractLengthDisplay,
      normalizeContractLengthDisplay
    ),
    notes: String(ai.notes || heuristic.notes || '').trim()
  };
}

function finalizeCareerContractTerms(rawTerms, extractedText) {
  const terms = rawTerms && typeof rawTerms === 'object' ? rawTerms : {};
  const derivedDoctorShare = extractDoctorShareFromSource(extractedText) || extractDoctorShareFromSource(terms.notes);
  const derivedRelocationPackage = extractRelocationPackageFromSource(extractedText) || extractRelocationPackageFromSource(terms.notes);
  return {
    splitDisplay: derivedDoctorShare || normalizeContractSplitDisplay(terms.splitDisplay),
    relocationPackageDisplay: derivedRelocationPackage || normalizeContractCurrencyDisplay(terms.relocationPackageDisplay),
    contractLengthDisplay: normalizeContractLengthDisplay(terms.contractLengthDisplay),
    notes: String(terms.notes || '').trim()
  };
}

function shouldAttemptAiContractExtraction(fileName, mimeType, extractedText, heuristicTerms) {
  const resolvedMime = String(mimeType || '').trim().toLowerCase();
  const isPdf = resolvedMime.includes('pdf') || /\.pdf$/i.test(String(fileName || ''));
  const hasTextPayload = isPdf || !!String(extractedText || '').trim();
  if (!hasTextPayload) return false;
  const heuristic = heuristicTerms && typeof heuristicTerms === 'object' ? heuristicTerms : null;
  if (!heuristic) return true;
  if (scoreContractSplitDisplay(heuristic.splitDisplay) === 0) return true;
  if (scoreContractLengthDisplay(heuristic.contractLengthDisplay) === 0) return true;
  const relocationScore = scoreContractRelocationDisplay(heuristic.relocationPackageDisplay);
  if (heuristic.relocationPackageDisplay && relocationScore > 0 && relocationScore < 3) return true;
  if (!heuristic.relocationPackageDisplay) return true;
  return false;
}

function isSuspiciousCachedCareerContractTerms(value) {
  if (!value || typeof value !== 'object') return false;
  const splitScore = scoreContractSplitDisplay(value.splitDisplay);
  const relocationScore = scoreContractRelocationDisplay(value.relocationPackageDisplay);
  const doctorShareFromNotes = extractDoctorShareFromSource(value.notes);
  if (doctorShareFromNotes && doctorShareFromNotes !== normalizeContractSplitDisplay(value.splitDisplay)) return true;
  return (splitScore === 0 && relocationScore > 0 && relocationScore < 3)
    || relocationScore === 1;
}

function heuristicExtractCareerContractTerms(textValue) {
  const text = stripHtml(String(textValue || '')).replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const splitMatch = text.match(/(?:billing|billings|percentage|collections?|gross billings?|remuneration|split|entitled to|receive|receives)[^.%$]{0,120}?(\d{1,2}\s*\/\s*\d{1,2}|\d{1,2}(?:\.\d+)?\s*(?:%|percent|per cent))/i);
  const relocationMatch = text.match(/(?:relocation|relocation package|relocation allowance|relocation support|sign[-\s]?on)[^$]{0,120}?(\$ ?\d[\d,\s]*(?:\.\d{2})?\s*(?:aud|australian dollars?)?)/i);
  const contractLengthMatch = text.match(/(?:contract(?: length)?|term|initial term|period)[^.\n]{0,80}?(\d+\s*(?:year|month)s?)/i);

  return {
    splitDisplay: splitMatch ? normalizeContractSplitDisplay(splitMatch[1]) : '',
    relocationPackageDisplay: relocationMatch ? normalizeContractCurrencyDisplay(relocationMatch[1]) : '',
    contractLengthDisplay: contractLengthMatch ? normalizeContractLengthDisplay(contractLengthMatch[1]) : ''
  };
}

async function extractCareerContractTermsWithAi(fileName, fileBuffer, mimeType, extractedText = '') {
  if (!ANTHROPIC_API_KEY || !checkAnthropicBudget()) return null;
  if (!fileBuffer || !Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) return null;

  const resolvedMime = String(mimeType || '').trim().toLowerCase();
  const isPdf = resolvedMime.includes('pdf') || /\.pdf$/i.test(String(fileName || ''));
  const textContent = !isPdf
    ? String(extractedText || '').slice(0, 30000)
    : '';

  const contractSystemPrompt = `You are extracting relocation and remuneration terms from an employment contract for a GP placement.

Return ONLY valid JSON with these exact keys:
{"splitDisplay":"","relocationPackageDisplay":"","contractLengthDisplay":"","notes":""}

Rules:
- splitDisplay: the GP/doctor/practitioner share only. If the contract says the practice retains 35% or charges a 35% service fee, output "65%".
- relocationPackageDisplay: the total relocation package payable to the GP across all instalments. If there are two payments of $5,000 each, output "$10,000".
- contractLengthDisplay: the contract length exactly as written, such as "2 years".
- notes: a short note only if the contract wording is ambiguous or if you had to derive the GP share or total relocation by reasoning over the contract wording.
- If a value is missing, use an empty string.
- Do not invent values.`;

  const content = [{ type: 'text', text: 'Extract the contract terms from this document.' }];
  if (isPdf) {
    content.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: fileBuffer.toString('base64')
      }
    });
  } else {
    content.push({
      type: 'text',
      text: `file_name: ${String(fileName || '').slice(0, 200)}\ncontract_text:\n${textContent}`
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 300,
        temperature: 0,
        system: [{ type: 'text', text: contractSystemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content }]
      })
    });

    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const inputTokens = Number(payload && payload.usage && payload.usage.input_tokens || 0);
    const outputTokens = Number(payload && payload.usage && payload.usage.output_tokens || 0);
    const contractCacheRead = (payload && payload.usage && payload.usage.cache_read_input_tokens) || 0;
    const contractCacheWrite = (payload && payload.usage && payload.usage.cache_creation_input_tokens) || 0;
    if (inputTokens || outputTokens) recordAnthropicSpend(inputTokens, outputTokens, contractCacheRead, contractCacheWrite);

    const text = payload && Array.isArray(payload.content) && payload.content[0] && typeof payload.content[0].text === 'string'
      ? payload.content[0].text
      : '';
    if (!text) return null;

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    }
    if (!parsed || typeof parsed !== 'object') return null;

    return {
      splitDisplay: stripHtml(String(parsed.splitDisplay || '')).slice(0, 80),
      relocationPackageDisplay: stripHtml(String(parsed.relocationPackageDisplay || '')).slice(0, 80),
      contractLengthDisplay: stripHtml(String(parsed.contractLengthDisplay || '')).slice(0, 80),
      notes: stripHtml(String(parsed.notes || '')).slice(0, 180)
    };
  } catch (err) {
    return null;
  }
}

async function resolveCareerContractTerms(zoho, applicationId) {
  const appId = String(applicationId || '').trim();
  if (!zoho || !appId) return null;
  const contractCacheTtlMs = 30 * 24 * 60 * 60 * 1000;

  const cacheKey = buildCareerContractCacheKey(appId);
  const cached = await getRuntimeKv(cacheKey);
  const cachedValue = cached && cached.value && typeof cached.value === 'object' ? cached.value : null;

  const attachments = await listZohoRecruitApplicationAttachments(zoho, appId);
  const candidates = selectZohoContractAttachmentCandidates(attachments);
  if (candidates.length === 0) {
    if (!cachedValue || cachedValue.status !== 'unavailable') {
      await setRuntimeKv(cacheKey, {
        status: 'unavailable',
        reason: 'no_contract_attachment'
      }, Date.now() + contractCacheTtlMs);
    }
    return null;
  }

  const selectedCandidate = candidates[0] || null;
  const selectedAttachmentId = getZohoAttachmentId(selectedCandidate);
  const selectedAttachmentSignature = buildZohoAttachmentSignature(selectedCandidate);
  const cachedAttachmentId = sanitizeZohoText(cachedValue && cachedValue.attachmentId);
  const cachedAttachmentSignature = String(cachedValue && cachedValue.attachmentSignature || '').trim();
  const cacheMatchesSelectedAttachment = selectedAttachmentSignature
    ? cachedAttachmentSignature === selectedAttachmentSignature
    : (!!selectedAttachmentId && cachedAttachmentId === selectedAttachmentId);

  const candidateIds = candidates.map((record) => getZohoAttachmentId(record)).filter(Boolean);
  if (
    cachedValue &&
    cachedValue.status === 'ready' &&
    cacheMatchesSelectedAttachment
  ) {
    return cachedValue;
  }
  if (cachedValue && cachedValue.status === 'unavailable' && cacheMatchesSelectedAttachment) {
    return null;
  }

  let lastAttempt = null;
  for (const candidate of candidates) {
    const attachmentId = getZohoAttachmentId(candidate);
    if (!attachmentId) continue;
    const downloaded = await downloadZohoRecruitApplicationAttachment(zoho, appId, attachmentId);
    if (!downloaded || !downloaded.buffer || downloaded.buffer.length === 0) {
      lastAttempt = {
        attachmentId,
        fileName: getZohoAttachmentFileName(candidate),
        reason: 'download_failed'
      };
      continue;
    }

    const fileName = getZohoAttachmentFileName(candidate) || downloaded.fileName || 'contract.pdf';
    const extractedText = extractStructuredContractText(fileName, downloaded.buffer, downloaded.mimeType);
    const heuristic = extractedText ? heuristicExtractCareerContractTerms(extractedText) : null;
    const aiExtracted = shouldAttemptAiContractExtraction(fileName, downloaded.mimeType, extractedText, heuristic)
      ? await extractCareerContractTermsWithAi(
        fileName,
        downloaded.buffer,
        downloaded.mimeType,
        extractedText
      )
      : null;
    const extracted = finalizeCareerContractTerms(
      mergeCareerContractTerms(heuristic, aiExtracted),
      extractedText
    );

    if (!extracted || (!extracted.splitDisplay && !extracted.relocationPackageDisplay && !extracted.contractLengthDisplay)) {
      lastAttempt = {
        attachmentId,
        fileName,
        reason: extractedText ? 'extract_failed' : 'unsupported_document_format'
      };
      continue;
    }

    const value = {
      status: 'ready',
      attachmentId,
      attachmentSignature: buildZohoAttachmentSignature(candidate),
      fileName,
      splitDisplay: extracted.splitDisplay || '',
      relocationPackageDisplay: extracted.relocationPackageDisplay || '',
      contractLengthDisplay: extracted.contractLengthDisplay || '',
      notes: extracted.notes || '',
      extractedAt: new Date().toISOString()
    };
    await setRuntimeKv(cacheKey, value, Date.now() + contractCacheTtlMs);
    return value;
  }

  await setRuntimeKv(cacheKey, {
    status: 'unavailable',
    attachmentId: selectedAttachmentId || (lastAttempt && lastAttempt.attachmentId ? lastAttempt.attachmentId : candidateIds[0] || ''),
    attachmentSignature: selectedAttachmentSignature || '',
    fileName: lastAttempt && lastAttempt.fileName ? lastAttempt.fileName : '',
    attemptedAttachmentIds: candidateIds,
    reason: lastAttempt && lastAttempt.reason ? lastAttempt.reason : 'extract_failed'
  }, Date.now() + contractCacheTtlMs);
  return cachedValue && cachedValue.status === 'ready' ? cachedValue : null;
}

function getZohoApplicationStatus(record) {
  return getZohoField(record, [
    'Application_Status',
    'Candidate_Status',
    'Hiring_Stage',
    'Stage',
    'Status'
  ]);
}

function getZohoApplicationJobOpeningId(record) {
  return getZohoLookupId(record, ['Job_Opening', 'Job_Opening_Name', 'Posting_Title']);
}

function getZohoApplicationClientId(record) {
  return getZohoLookupId(record, ['Client_Name', 'Client', 'Account_Name']);
}

function getZohoApplicationPracticeName(record) {
  return getZohoField(record, ['Posting_Title', 'Job_Opening_Name', 'Job_Opening', 'Title']);
}

function getZohoPlacementLocation(jobOpeningRecord, roleRow) {
  const gpLinkMeta = getCareerRoleGpLinkMeta(roleRow);
  const rowLocation = buildLocationLabel([
    roleRow && roleRow.location_label,
    !roleRow || roleRow.location_label ? '' : buildLocationLabel([roleRow.location_city, roleRow.location_state]),
    !roleRow || roleRow.location_label ? '' : roleRow.location_country
  ]);
  const liveLocation = buildLocationLabel([
    getZohoField(jobOpeningRecord, ['Location', 'Job_Location', 'Work_Location', 'Suburb']),
    buildLocationLabel([
      getZohoField(jobOpeningRecord, ['City', 'Work_City', 'Location_City', 'Job_City']),
      getZohoField(jobOpeningRecord, ['State', 'Region', 'Province', 'Work_State', 'Location_State'])
    ]),
    getZohoField(jobOpeningRecord, ['Country', 'Work_Country', 'Location_Country'])
  ]);
  return liveLocation || rowLocation || buildCareerPublicLocationLine(roleRow, gpLinkMeta && gpLinkMeta.suburb) || 'Australia';
}

function getPlacementStartDate(startDateIso, applicationRecord, jobOpeningRecord, roleRow) {
  return normalizePlacementStartDate(startDateIso)
    || normalizePlacementStartDate(getZohoField(applicationRecord, ['Expected_Date_of_Joining', 'Expected_Joining_Date', 'Start_Date']))
    || normalizePlacementStartDate(getZohoField(jobOpeningRecord, ['Target_Date', 'Expected_Start_Date', 'Start_Date', 'Date_Opened']))
    || normalizePlacementStartDate(getZohoField(getCareerRoleRawPayload(roleRow), ['Target_Date', 'Expected_Start_Date', 'Start_Date']))
    || '';
}

function derivePlacementRoleTitle(roleRow, jobOpeningRecord, practiceName) {
  const liveTitle = getZohoField(jobOpeningRecord, ['Role_Title', 'Job_Title', 'Title']);
  const rowTitle = roleRow && roleRow.title ? String(roleRow.title).trim() : '';
  const normalizedPractice = String(practiceName || '').trim().toLowerCase();
  const selected = liveTitle || rowTitle;
  if (!selected) return 'General Practitioner';
  if (selected.trim().toLowerCase() === normalizedPractice) return 'General Practitioner';
  return selected;
}

function extractPlacementTermsFromJobOpening(jobOpeningRecord, roleRow) {
  const roleRaw = getCareerRoleRawPayload(roleRow);
  const sourceText = [
    getZohoField(jobOpeningRecord, ['Benefit_1', 'Benefit_2', 'Benefit_3', 'Short_Intro', 'Additional_Information', 'Job_Description', 'Description']),
    getZohoField(roleRaw, ['Benefit_1', 'Benefit_2', 'Benefit_3', 'Short_Intro', 'Additional_Information', 'Job_Description', 'Description'])
  ].filter(Boolean).join(' ');
  return heuristicExtractCareerContractTerms(sourceText) || {
    splitDisplay: '',
    relocationPackageDisplay: '',
    contractLengthDisplay: ''
  };
}

function isDomainLifestyleConfigured() {
  return !!(
    DOMAIN_API_BASE
    && (
      DOMAIN_API_KEY
      || DOMAIN_API_ACCESS_TOKEN
      || (DOMAIN_API_CLIENT_ID && DOMAIN_API_CLIENT_SECRET)
    )
  );
}

function isDomainLifestyleFallbackEnabled() {
  return !!ALLOW_DOMAIN_LIFESTYLE_FALLBACK;
}

function clampDomainLifestyleRadiusKm(value, fallback = DOMAIN_LIFESTYLE_MAX_RADIUS_KM) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(DOMAIN_LIFESTYLE_MAX_RADIUS_KM, Math.max(2, Math.round(numeric)));
}

function sanitizeDomainLifestyleSearchQuery(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function buildDomainLifestyleKeywords(value) {
  const query = sanitizeDomainLifestyleSearchQuery(value).toLowerCase();
  if (!query) return [];
  return Array.from(new Set(
    query
      .split(/\s+/)
      .map((item) => item.replace(/[^a-z0-9-]+/g, '').trim())
      .filter((item) => item.length > 1)
  )).slice(0, 8);
}

function logDomainApiWarning(message, detail = '') {
  if (NODE_ENV === 'test') return;
  const suffix = String(detail || '').trim();
  console.warn(`[DOMAIN] ${message}${suffix ? ` ${suffix}` : ''}`);
}

async function getDomainClientCredentialsAccessToken(scopeOverride = '') {
  if (!DOMAIN_API_CLIENT_ID || !DOMAIN_API_CLIENT_SECRET) return '';
  const requestedScope = String(scopeOverride || DOMAIN_API_SCOPE || '').trim() || DOMAIN_API_SCOPE;
  const cacheKey = requestedScope || '__default__';
  const cachedToken = _domainApiAccessTokenCache.get(cacheKey);
  if (cachedToken && cachedToken.token && cachedToken.expiresAt > (Date.now() + 60 * 1000)) {
    return cachedToken.token;
  }

  const authHeader = Buffer.from(`${DOMAIN_API_CLIENT_ID}:${DOMAIN_API_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: requestedScope
  });

  try {
    const response = await fetch(DOMAIN_AUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });
    if (!response.ok) {
      const failureText = await response.text().catch(() => '');
      logDomainApiWarning(
        `OAuth token request failed with status ${response.status}.`,
        failureText ? failureText.slice(0, 240) : ''
      );
      return '';
    }
    const payload = await response.json().catch(() => null);
    const accessToken = String(payload && payload.access_token || '').trim();
    const expiresInSeconds = Math.max(60, Number(payload && payload.expires_in || 0) || 0);
    if (!accessToken) {
      logDomainApiWarning('OAuth token response did not include an access token.');
      return '';
    }
    const cacheEntry = {
      token: accessToken,
      expiresAt: Date.now() + Math.max(60, expiresInSeconds - 60) * 1000
    };
    _domainApiAccessTokenCache.set(cacheKey, cacheEntry);
    return accessToken;
  } catch (err) {
    logDomainApiWarning('OAuth token request threw an error.', err && err.message ? String(err.message) : '');
    return '';
  }
}

async function buildDomainApiHeaders(method = 'GET', scopeOverride = '') {
  const headers = {
    Accept: 'application/json'
  };
  if (method !== 'GET') headers['Content-Type'] = 'application/json';

  if (DOMAIN_API_KEY) {
    headers['X-API-Key'] = DOMAIN_API_KEY;
    return headers;
  }

  const staticAccessToken = String(DOMAIN_API_ACCESS_TOKEN || '').trim();
  if (staticAccessToken) {
    headers.Authorization = `Bearer ${staticAccessToken}`;
    return headers;
  }

  const clientCredentialsToken = await getDomainClientCredentialsAccessToken(scopeOverride);
  if (!clientCredentialsToken) return null;
  headers.Authorization = `Bearer ${clientCredentialsToken}`;
  return headers;
}

function getCareerLifestyleGoogleMapsPayload() {
  return {
    enabled: !!GOOGLE_MAPS_BROWSER_API_KEY,
    apiKey: GOOGLE_MAPS_BROWSER_API_KEY || '',
    mapId: GOOGLE_MAPS_MAP_ID || ''
  };
}

function hydrateCareerLifestylePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const map = payload.map && typeof payload.map === 'object' ? payload.map : {};
  const googleMaps = map.googleMaps && typeof map.googleMaps === 'object' ? map.googleMaps : {};
  return {
    ...payload,
    map: {
      ...map,
      googleMaps: {
        ...googleMaps,
        ...getCareerLifestyleGoogleMapsPayload()
      }
    }
  };
}

function normalizeAustralianStateAbbreviation(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const key = raw.toLowerCase().replace(/[^a-z]/g, '');
  const direct = raw.toUpperCase();
  if (['NSW', 'QLD', 'VIC', 'SA', 'WA', 'TAS', 'NT', 'ACT'].includes(direct)) return direct;
  const aliases = {
    nsw: 'NSW',
    qld: 'QLD',
    vic: 'VIC',
    sa: 'SA',
    wa: 'WA',
    tas: 'TAS',
    nt: 'NT',
    act: 'ACT',
    newsouthwales: 'NSW',
    queensland: 'QLD',
    victoria: 'VIC',
    southaustralia: 'SA',
    westernaustralia: 'WA',
    tasmania: 'TAS',
    northerterritory: 'NT',
    australiancapitalterritory: 'ACT'
  };
  return aliases[key] || '';
}

function getAustralianStateName(value) {
  const stateCode = normalizeAustralianStateAbbreviation(value);
  const labels = {
    NSW: 'New South Wales',
    QLD: 'Queensland',
    VIC: 'Victoria',
    SA: 'South Australia',
    WA: 'Western Australia',
    TAS: 'Tasmania',
    NT: 'Northern Territory',
    ACT: 'Australian Capital Territory'
  };
  return labels[stateCode] || '';
}

function extractAustralianPostcode(value) {
  const match = String(value || '').match(/\b(\d{4})\b/);
  return match ? match[1] : '';
}

function getCareerLocationPrimaryLabel(value) {
  return String(value || '')
    .trim()
    .replace(/,\s*Australia\s*$/i, '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)[0] || '';
}

function isBroadCareerLocationLabel(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  return /\b(region|shire|district|council|municipality|tablelands|hinterland|peninsula|ranges|riverina|coast|suburbs|surrounds|corridor)\b/.test(normalized)
    || /\b(central coast|fraser coast|sunshine coast|gold coast|greater [a-z]+|inner west|north shore|south west|south east|north west|north east)\b/.test(normalized);
}

function extractCareerRoleLifestyleSuburb(roleRow) {
  const raw = getCareerRoleRawPayload(roleRow);
  return String(getZohoField(raw, [
    'Suburb',
    'Practice_Suburb',
    'Location_Suburb',
    'Clinic_Suburb',
    'Town'
  ]) || '').trim();
}

function extractCareerRoleLifestylePostcode(roleRow) {
  const explicit = extractAustralianPostcode(roleRow && (roleRow.location_postcode || roleRow.location_zip));
  if (explicit) return explicit;
  const raw = getCareerRoleRawPayload(roleRow);
  return extractAustralianPostcode(getZohoField(raw, [
    'Zip_Code',
    'Postcode',
    'Postal_Code',
    'ZipCode',
    'Work_Postcode',
    'Location_Postcode'
  ]));
}

function resolveCareerLifestyleSuburb({ roleMeta, roleRow, parsed }) {
  const directSuburb = extractCareerRoleLifestyleSuburb(roleRow);
  const roleMetaSuburb = String(roleMeta && roleMeta.suburb || '').trim();
  const labelPrimary = getCareerLocationPrimaryLabel(roleRow && roleRow.location_label ? roleRow.location_label : parsed && parsed.label);
  const parsedSuburb = String(parsed && parsed.suburb || '').trim();
  const city = String(roleRow && roleRow.location_city || '').trim();
  const candidates = [
    directSuburb,
    roleMetaSuburb,
    labelPrimary,
    parsedSuburb,
    city
  ].filter(Boolean);
  const specific = candidates.find((candidate) => !isBroadCareerLocationLabel(candidate));
  if (specific) return specific;
  return city || candidates[0] || '';
}

function parsePlacementLocationContext(locationValue) {
  const value = String(locationValue || '').trim().replace(/,\s*Australia\s*$/i, '');
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  const second = parts[1] || '';
  const secondState = normalizeAustralianStateAbbreviation(second);
  const inlineStateMatch = value.match(/\b(NSW|QLD|VIC|SA|WA|TAS|NT|ACT|New South Wales|Queensland|Victoria|South Australia|Western Australia|Tasmania|Northern Territory|Australian Capital Territory)\b/i);
  const inlineState = normalizeAustralianStateAbbreviation(inlineStateMatch ? inlineStateMatch[1] : '');
  const inlineSuburb = inlineState
    ? value.replace(inlineStateMatch[0], '').replace(/\b\d{4}\b/g, '').replace(/,\s*$/,'').trim()
    : '';
  const suburb = secondState && parts[2]
    ? parts[2]
    : ((parts.length === 1 && inlineSuburb) ? inlineSuburb : (parts[0] || inlineSuburb));
  const state = normalizeAustralianStateAbbreviation(second || parts.find((part) => normalizeAustralianStateAbbreviation(part)) || inlineState || '');
  return {
    suburb,
    state,
    postcode: extractAustralianPostcode(value),
    country: 'Australia',
    label: value
  };
}

function buildLifestyleLocationContext(locationValue, roleMeta, roleRow) {
  const parsed = parsePlacementLocationContext(locationValue);
  const rawRole = getCareerRoleRawPayload(roleRow);
  const suburb = resolveCareerLifestyleSuburb({ roleMeta, roleRow, parsed });
  const state = normalizeAustralianStateAbbreviation(
    roleRow && roleRow.location_state
    || getZohoField(rawRole, ['State', 'Region', 'Province', 'Work_State', 'Location_State'])
    || parsed.state
    || ''
  );
  const postcode = String(extractCareerRoleLifestylePostcode(roleRow) || parsed.postcode || '').trim();
  return {
    ...parsed,
    suburb,
    state,
    postcode,
    label: buildLocationLabel([
      suburb || parsed.suburb,
      buildLocationLabel([state, postcode]),
      'Australia'
    ]) || parsed.label || String(locationValue || '').trim()
  };
}

function normalizeLifestyleSearchLocationContext(value) {
  const source = value && typeof value === 'object' ? value : {};
  const parsedLabelContext = String(source.label || '').trim()
    ? parsePlacementLocationContext(source.label)
    : {};
  const suburb = String(source.suburb || parsedLabelContext.suburb || '').trim();
  const state = normalizeAustralianStateAbbreviation(source.state || parsedLabelContext.state || '');
  const postcode = String(
    source.postcode
    || source.postCode
    || parsedLabelContext.postcode
    || extractAustralianPostcode(source.label)
    || ''
  ).trim();
  const country = String(source.country || parsedLabelContext.country || 'Australia').trim() || 'Australia';
  const label = String(source.label || '').trim() || buildLocationLabel([
    suburb,
    buildLocationLabel([state, postcode]),
    country
  ]) || String(parsedLabelContext.label || '').trim();
  return {
    suburb,
    state,
    postcode,
    country,
    label
  };
}

async function enrichLifestyleLocationContextForHomely(value, practiceCoords = null) {
  let locationContext = normalizeLifestyleSearchLocationContext(value);
  const reverseContext = await reverseGeocodeCareerLocationContext(practiceCoords);
  if (reverseContext) {
    const mergedSuburb = resolveCareerLifestyleSuburb({
      roleMeta: { suburb: locationContext.suburb },
      roleRow: {
        location_city: reverseContext.suburb,
        location_label: locationContext.label || reverseContext.label
      },
      parsed: reverseContext
    });
    locationContext = {
      ...reverseContext,
      ...locationContext,
      suburb: String(mergedSuburb || reverseContext.suburb || locationContext.suburb || '').trim(),
      state: normalizeAustralianStateAbbreviation(locationContext.state || reverseContext.state || ''),
      postcode: String(locationContext.postcode || reverseContext.postcode || '').trim(),
      country: String(locationContext.country || reverseContext.country || 'Australia').trim() || 'Australia',
      label: String(locationContext.label || reverseContext.label || '').trim()
    };
  }
  if (locationContext.postcode) return locationContext;
  const postcode = await fetchCareerSuburbPostcode(locationContext);
  if (!postcode) return locationContext;
  return {
    ...locationContext,
    postcode,
    label: locationContext.label || buildLocationLabel([
      locationContext.suburb,
      buildLocationLabel([locationContext.state, postcode]),
      locationContext.country || 'Australia'
    ])
  };
}

function normalizeLifestyleSearchHousehold(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    recommendedBedrooms: Math.max(1, parseWholeNumber(source.recommendedBedrooms, 1)),
    partySummary: String(source.partySummary || '').trim()
  };
}

function parseWholeNumber(value, fallback = 0) {
  const numeric = Number(String(value ?? '').replace(/[^\d.-]+/g, ''));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.round(numeric));
}

function deriveCareerLifestyleHousehold(profile) {
  const whoMovingRaw = String(profile && profile.who_moving || '').trim();
  const key = whoMovingRaw.toLowerCase().replace(/[^a-z]+/g, '_');
  const childrenCount = parseWholeNumber(profile && profile.children_count, 0);
  let adultCount = 1;
  if (['me_partner', 'me_and_partner', 'me_partner_children', 'family'].includes(key) || /partner/.test(key)) {
    adultCount = 2;
  }
  const sharedAdultRooms = Math.max(1, Math.ceil(adultCount / 2));
  const recommendedBedrooms = Math.max(1, sharedAdultRooms + childrenCount);
  const partySummary = [
    adultCount === 1 ? '1 adult' : `${adultCount} adults`,
    childrenCount ? `${childrenCount} child${childrenCount === 1 ? '' : 'ren'}` : ''
  ].filter(Boolean).join(' + ');
  return {
    whoMoving: whoMovingRaw || 'Just me',
    adultCount,
    childrenCount,
    recommendedBedrooms,
    partySummary
  };
}

function toRadians(value) {
  return (Number(value) || 0) * (Math.PI / 180);
}

function calculateDistanceKm(from, to) {
  const fromLat = parseCareerCoordinate(from && from.lat);
  const fromLng = parseCareerCoordinate(from && from.lng);
  const toLat = parseCareerCoordinate(to && to.lat);
  const toLng = parseCareerCoordinate(to && to.lng);
  if (!Number.isFinite(fromLat) || !Number.isFinite(fromLng) || !Number.isFinite(toLat) || !Number.isFinite(toLng)) return null;
  const earthRadiusKm = 6371;
  const dLat = toRadians(toLat - fromLat);
  const dLng = toRadians(toLng - fromLng);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat)) * Math.sin(dLng / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistanceKm(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  return `${numeric.toFixed(1).replace(/\.0$/, '')} km`;
}

function formatLifestyleDriveTime(distanceKm) {
  const numeric = Number(distanceKm);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  const minutes = Math.max(4, Math.round((numeric * 1.55) + 2));
  return `${minutes} min drive`;
}

function buildCareerLifestyleCacheKey(applicationId, practiceName, location, household) {
  const signature = crypto.createHash('sha1')
    .update(JSON.stringify({
      version: CAREER_LIFESTYLE_EXPERIENCE_VERSION,
      applicationId: String(applicationId || '').trim(),
      practiceName: String(practiceName || '').trim().toLowerCase(),
      location: String(location || '').trim().toLowerCase(),
      bedrooms: household && household.recommendedBedrooms ? household.recommendedBedrooms : 1,
      whoMoving: household && household.whoMoving ? household.whoMoving : '',
      childrenCount: household && Number.isFinite(household.childrenCount) ? household.childrenCount : 0,
      domainConfigured: isDomainLifestyleConfigured(),
      housingFallbackEnabled: isDomainLifestyleFallbackEnabled()
    }))
    .digest('hex')
    .slice(0, 20);
  return `career_lifestyle:${signature}`;
}

function buildLifestyleCoordinate(lat, lng) {
  const latitude = parseCareerCoordinate(lat);
  const longitude = parseCareerCoordinate(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { lat: latitude, lng: longitude };
}

function offsetCoordinate(base, deltaLat, deltaLng) {
  const latitude = parseCareerCoordinate(base && base.lat);
  const longitude = parseCareerCoordinate(base && base.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    lat: Number((latitude + deltaLat).toFixed(6)),
    lng: Number((longitude + deltaLng).toFixed(6))
  };
}

function buildLifestyleImage(index = 0) {
  const images = [
    'https://images.unsplash.com/photo-1564013799919-ab600027ffc6?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1600585154526-990dced4db0d?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1570129477492-45c003edd2be?auto=format&fit=crop&w=1200&q=80',
    'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=1200&q=80'
  ];
  return images[index % images.length];
}

function parseBedroomsCount(value) {
  const numeric = parseWholeNumber(value, 0);
  return numeric > 0 ? numeric : 0;
}

function formatBedroomsLabel(value) {
  const numeric = parseBedroomsCount(value);
  return `${Math.max(1, numeric)} bed`;
}

function parseLifestylePriceValue(rawValue, market = 'rent') {
  const source = String(rawValue || '').trim().toLowerCase();
  if (!source) return 0;
  const normalized = source.replace(/,/g, '').replace(/\s+/g, ' ');
  const millionMatch = normalized.match(/\$?\s*(\d+(?:\.\d+)?)\s*m\b/);
  if (millionMatch) {
    return Math.round(Number(millionMatch[1]) * 1000000);
  }
  const thousandMatch = normalized.match(/\$?\s*(\d+(?:\.\d+)?)\s*k\b/);
  if (thousandMatch) {
    return Math.round(Number(thousandMatch[1]) * 1000);
  }
  const rangeMatches = [...normalized.matchAll(/\$?\s*(\d+(?:\.\d+)?)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!rangeMatches.length) return 0;
  const candidate = Math.max(...rangeMatches);
  if (market === 'rent' && candidate < 10000) return Math.round(candidate);
  return Math.round(candidate);
}

function normalizeDomainSourceUrl(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  if (/^https?:\/\//i.test(source)) return source;
  if (source.startsWith('/')) return `https://www.domain.com.au${source}`;
  return `https://www.domain.com.au/${source.replace(/^\/+/, '')}`;
}

function resizeDomainImageUrl(value, width = 720, height = 540) {
  const source = String(value || '').trim();
  if (!source || !/^https:\/\/bucket-api\.domain\.com\.au\/v1\//i.test(source)) return source;
  if (/\/\d+x\d+\/?$/i.test(source)) return source;
  if (/\bw\d+-h\d+\b/i.test(source) || /-w\d+-h\d+$/i.test(source)) return source;
  return source;
}

function buildHomelyLifestyleLocationSlug(locationContext) {
  const explicitSlug = String(locationContext && locationContext.slug || '').trim();
  if (explicitSlug) return explicitSlug;
  const suburb = normalizeCareerHeroCityKey(locationContext && locationContext.suburb);
  const state = String(locationContext && locationContext.state || '').trim().toLowerCase();
  const postcode = extractAustralianPostcode(locationContext && locationContext.postcode);
  if (!suburb || !state || !postcode) return '';
  return `${suburb}-${state}-${postcode}`;
}

function buildHomelyLifestyleSearchQueries(locationContext) {
  const suburb = String(locationContext && locationContext.suburb || '').trim();
  const stateCode = normalizeAustralianStateAbbreviation(locationContext && locationContext.state || '');
  const stateName = getAustralianStateName(stateCode);
  const label = String(locationContext && locationContext.label || '').trim()
    .replace(/,\s*Australia\s*$/i, '')
    .replace(/\b\d{4}\b/g, ' ')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(new Set([
    suburb && stateName ? `${suburb} ${stateName}` : '',
    suburb && stateCode ? `${suburb} ${stateCode}` : '',
    suburb,
    label
  ].map((item) => String(item || '').replace(/\s+/g, ' ').trim()).filter(Boolean)));
}

function scoreHomelyLocationCandidate(candidate, locationContext) {
  if (!candidate || typeof candidate !== 'object') return Number.NEGATIVE_INFINITY;
  const candidateName = normalizeCareerHeroCityKey(candidate && candidate.name);
  const candidateState = normalizeAustralianStateAbbreviation(candidate && candidate.state && candidate.state.name);
  const candidatePostcode = extractAustralianPostcode(candidate && candidate.zipCode && candidate.zipCode.name);
  const candidateType = Number(candidate && candidate.type || 0);
  const suburbKey = normalizeCareerHeroCityKey(locationContext && locationContext.suburb);
  const broadSuburb = isBroadCareerLocationLabel(locationContext && locationContext.suburb);
  const stateCode = normalizeAustralianStateAbbreviation(locationContext && locationContext.state || '');
  const postcode = extractAustralianPostcode(locationContext && locationContext.postcode);
  let score = 0;
  if (suburbKey && !broadSuburb && candidateName === suburbKey) score += 100;
  else if (suburbKey && !broadSuburb && candidateName.includes(suburbKey)) score += 40;
  else if (suburbKey && !broadSuburb) score -= 35;
  if (stateCode && candidateState === stateCode) score += 35;
  if (postcode && candidatePostcode === postcode) score += 35;
  if (candidateType === 2) score += 15;
  return score;
}

async function fetchHomelyLocationMatches(query) {
  const searchQuery = String(query || '').replace(/\s+/g, ' ').trim();
  if (!searchQuery) return [];
  try {
    const url = new URL(HOMELY_LOCATION_SEARCH_URL);
    url.searchParams.set('q', searchQuery);
    const response = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': HOMELY_LIFESTYLE_USER_AGENT
      }
    });
    if (!response.ok) return [];
    const payload = await response.json().catch(() => null);
    return Array.isArray(payload && payload.locations) ? payload.locations : [];
  } catch (err) {
    return [];
  }
}

async function resolveHomelyLifestyleLocation(locationContext) {
  const explicitSlug = String(locationContext && locationContext.slug || '').trim();
  if (explicitSlug) {
    return {
      suburb: String(locationContext && locationContext.suburb || '').trim(),
      state: normalizeAustralianStateAbbreviation(locationContext && locationContext.state || ''),
      postcode: extractAustralianPostcode(locationContext && locationContext.postcode),
      country: String(locationContext && locationContext.country || 'Australia').trim() || 'Australia',
      label: String(locationContext && locationContext.label || '').trim(),
      slug: explicitSlug,
      uri: String(locationContext && locationContext.uri || '').trim()
    };
  }
  const searchQueries = buildHomelyLifestyleSearchQueries(locationContext);
  const candidatesBySlug = new Map();
  for (const query of searchQueries) {
    const matches = await fetchHomelyLocationMatches(query);
    matches.forEach((candidate) => {
      const slug = String(candidate && candidate.slug || '').trim();
      if (!slug || candidatesBySlug.has(slug)) return;
      candidatesBySlug.set(slug, candidate);
    });
  }
  const candidates = Array.from(candidatesBySlug.values());
  if (!candidates.length) return null;
  const suburbKey = normalizeCareerHeroCityKey(locationContext && locationContext.suburb);
  const broadSuburb = isBroadCareerLocationLabel(locationContext && locationContext.suburb);
  const postcode = extractAustralianPostcode(locationContext && locationContext.postcode);
  const best = candidates
    .map((candidate) => ({ candidate, score: scoreHomelyLocationCandidate(candidate, locationContext) }))
    .sort((left, right) => right.score - left.score)[0];
  if (!best || !best.candidate || !Number.isFinite(best.score) || best.score < 40) return null;
  const candidateName = normalizeCareerHeroCityKey(best.candidate && best.candidate.name);
  const candidatePostcode = extractAustralianPostcode(best.candidate && best.candidate.zipCode && best.candidate.zipCode.name);
  const suburbMatched = suburbKey && !broadSuburb && (candidateName === suburbKey || candidateName.includes(suburbKey));
  const postcodeMatched = postcode && candidatePostcode === postcode;
  if (!suburbMatched && !postcodeMatched) return null;
  return {
    suburb: String(best.candidate.name || locationContext && locationContext.suburb || '').trim(),
    state: normalizeAustralianStateAbbreviation(best.candidate && best.candidate.state && best.candidate.state.name),
    postcode: extractAustralianPostcode(best.candidate && best.candidate.zipCode && best.candidate.zipCode.name),
    country: String(locationContext && locationContext.country || 'Australia').trim() || 'Australia',
    label: buildLocationLabel([
      String(best.candidate.name || '').trim(),
      buildLocationLabel([
        normalizeAustralianStateAbbreviation(best.candidate && best.candidate.state && best.candidate.state.name),
        extractAustralianPostcode(best.candidate && best.candidate.zipCode && best.candidate.zipCode.name)
      ]),
      'Australia'
    ]),
    slug: String(best.candidate.slug || '').trim(),
    uri: String(best.candidate.uri || '').trim()
  };
}

function buildHomelyLifestyleSearchUrl(locationContext, market = 'rent', pageNumber = 1) {
  const slug = buildHomelyLifestyleLocationSlug(locationContext);
  if (!slug) return '';
  const mode = market === 'buy' ? 'for-sale' : 'for-rent';
  const page = Math.max(1, parseWholeNumber(pageNumber, 1));
  const baseUrl = `${HOMELY_BASE_URL}/${mode}/${slug}/real-estate`;
  return page > 1 ? `${baseUrl}/page-${page}` : baseUrl;
}

function buildHomelyListingUrl(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  if (/^https?:\/\//i.test(source)) return source;
  if (source.startsWith('/')) return `${HOMELY_BASE_URL}${source}`;
  return `${HOMELY_BASE_URL}/${source.replace(/^\/+/, '')}`;
}

function buildHomelyLifestyleSearchDataUrl(locationContext, market = 'rent', pageNumber = 1, buildId = '') {
  const slug = buildHomelyLifestyleLocationSlug(locationContext);
  const resolvedBuildId = String(buildId || '').trim();
  if (!slug || !resolvedBuildId) return '';
  const mode = market === 'buy' ? 'for-sale' : 'for-rent';
  const page = Math.max(1, parseWholeNumber(pageNumber, 1));
  const pathParts = [mode, slug, 'real-estate'];
  if (page > 1) pathParts.push(`page-${page}`);
  const url = new URL(`${HOMELY_BASE_URL}/_next/data/${resolvedBuildId}/${pathParts.join('/')}.json`);
  url.searchParams.set('mode', mode);
  url.searchParams.set('location', slug);
  url.searchParams.set('facets', 'real-estate');
  if (page > 1) url.searchParams.set('page', String(page));
  return url.toString();
}

function normalizeHomelyPriceLabel(value, market = 'rent') {
  const source = String(value || '').trim();
  if (!source) return market === 'buy' ? 'Price on request' : 'Rent on request';
  if (market !== 'rent') return source;
  const compact = source.replace(/\s+/g, '');
  const match = compact.match(/^(\$[\d,.]+)(?:pw|p\/w|\/wk|\/week)$/i);
  if (match) return `${match[1]}/wk`;
  return source;
}

function buildHomelyListingSummary(record) {
  const bits = [
    pickFirstDefined(
      record && record.statusLabels && record.statusLabels.daysOnMarket,
      ''
    ),
    pickFirstDefined(
      record && record.statusLabels && record.statusLabels.nextInspection,
      ''
    ),
    (() => {
      const officeName = String(record && record.contactDetails && record.contactDetails.office && record.contactDetails.office.name || '').trim();
      return officeName ? `via ${officeName}` : '';
    })()
  ].filter(Boolean);
  return bits.join(' · ');
}

function normalizeHomelyListing(record, practiceCoords, market) {
  if (!record || typeof record !== 'object') return null;
  if (String(record.statusType || '').trim().toLowerCase() !== 'available') return null;
  const coords = buildLifestyleCoordinate(
    record && record.location && record.location.latLong && record.location.latLong.latitude,
    record && record.location && record.location.latLong && record.location.latLong.longitude
  );
  if (!coords) return null;
  const distanceKm = practiceCoords ? calculateDistanceKm(practiceCoords, coords) : null;
  const features = record && record.features && typeof record.features === 'object' ? record.features : {};
  const landFeatures = record && record.landFeatures && typeof record.landFeatures === 'object' ? record.landFeatures : {};
  const priceLabel = normalizeHomelyPriceLabel(
    pickFirstDefined(
      record && record.priceDetails && record.priceDetails.shortDescription,
      record && record.priceDetails && record.priceDetails.longDescription,
      market === 'buy' && record && record.saleDetails && record.saleDetails.soldDetails && record.saleDetails.soldDetails.displayPrice
        ? pickFirstDefined(
            record.saleDetails.soldDetails.displayPrice.shortDescription,
            record.saleDetails.soldDetails.displayPrice.longDescription
          )
        : ''
    ),
    market
  );
  const priceValue = parseLifestylePriceValue(priceLabel, market)
    || parseLifestylePriceValue(
      record && record.priceDetails && pickFirstDefined(
        record.priceDetails.longDescription,
        record.priceDetails.shortDescription
      ),
      market
    )
    || (market === 'buy'
      ? parseWholeNumber(record && record.saleDetails && record.saleDetails.loanPrice, 0)
      : 0);
  const propertyTypeLabel = String(
    record && record.statusLabels && record.statusLabels.propertyTypeDescription
      || ''
  ).trim();
  const propertyType = propertyTypeLabel.replace(/\s+for\s+(rent|sale)\s*$/i, '').trim()
    || (market === 'buy' ? 'Property' : 'Rental');
  const photos = Array.isArray(record && record.media && record.media.photos) ? record.media.photos : [];
  const image = photos.find((photo) => photo && (photo.webHeroURI || photo.webDefaultURI)) || null;
  const address = String(
    pickFirstDefined(
      record && record.address && record.address.longAddress,
      record && record.location && record.location.address
    ) || ''
  ).trim();
  return {
    id: `homely-${String(record && record.id || '').trim() || crypto.randomUUID()}`,
    price: priceLabel,
    priceValue,
    bedrooms: parseWholeNumber(features && features.bedrooms, 0),
    bathrooms: parseWholeNumber(features && features.bathrooms, 0),
    carSpaces: parseWholeNumber(features && features.cars, 0),
    areaSqm: parseWholeNumber(landFeatures && landFeatures.areaSqm, 0),
    beds: formatBedroomsLabel(features && features.bedrooms),
    distanceKm: distanceKm ? Number(distanceKm.toFixed(1)) : 0,
    driveTime: formatLifestyleDriveTime(distanceKm || 0),
    imageUrl: String(
      pickFirstDefined(
        image && image.webHeroURI,
        image && image.webDefaultURI
      ) || ''
    ).trim(),
    imagePosition: 'center',
    address,
    title: String(record && record.title || address || propertyType).trim(),
    suburb: String(address.split(',')[1] || '').replace(/\bNSW\b|\bQLD\b|\bVIC\b|\bSA\b|\bWA\b|\bTAS\b|\bNT\b|\bACT\b|\b\d{4}\b/g, '').trim() || '',
    propertyType,
    summary: buildHomelyListingSummary(record),
    sourceLabel: 'Homely',
    sourceUrl: buildHomelyListingUrl(
      pickFirstDefined(
        record && record.canonicalUri,
        record && record.uri
      )
    ),
    lat: coords.lat,
    lng: coords.lng,
    market
  };
}

async function fetchHomelyLifestyleSearchPage(url) {
  const requestUrl = String(url || '').trim();
  if (!requestUrl) return { ok: false, listings: [], totalPages: 0 };
  try {
    const response = await fetch(requestUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': HOMELY_LIFESTYLE_USER_AGENT
      }
    });
    if (!response.ok) return { ok: false, listings: [], totalPages: 0 };
    const html = await response.text().catch(() => '');
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
    if (!nextDataMatch || !nextDataMatch[1]) return { ok: false, listings: [], totalPages: 0 };
    const payload = JSON.parse(nextDataMatch[1]);
    const pageProps = payload && payload.props && payload.props.pageProps && typeof payload.props.pageProps === 'object'
      ? payload.props.pageProps
      : {};
    const ssrData = pageProps && pageProps.ssrData && typeof pageProps.ssrData === 'object'
      ? pageProps.ssrData
      : {};
    const paging = ssrData && ssrData.paging && typeof ssrData.paging === 'object'
      ? ssrData.paging
      : {};
    return {
      ok: true,
      listings: Array.isArray(ssrData.listings) ? ssrData.listings : [],
      totalPages: Math.max(1, parseWholeNumber(paging.totalPages, 1))
    };
  } catch (err) {
    return { ok: false, listings: [], totalPages: 0 };
  }
}

function extractHomelyNextDataPayload(html) {
  const source = String(html || '');
  if (!source) return null;
  const nextDataMatch = source.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!nextDataMatch || !nextDataMatch[1]) return null;
  try {
    return JSON.parse(nextDataMatch[1]);
  } catch (err) {
    return null;
  }
}

function extractHomelyListingsPayload(payload) {
  const pageProps = payload && payload.props && payload.props.pageProps && typeof payload.props.pageProps === 'object'
    ? payload.props.pageProps
    : (payload && payload.pageProps && typeof payload.pageProps === 'object' ? payload.pageProps : {});
  const ssrData = pageProps && pageProps.ssrData && typeof pageProps.ssrData === 'object'
    ? pageProps.ssrData
    : {};
  const paging = ssrData && ssrData.paging && typeof ssrData.paging === 'object'
    ? ssrData.paging
    : {};
  return {
    listings: Array.isArray(ssrData.listings) ? ssrData.listings : [],
    totalPages: Math.max(1, parseWholeNumber(paging.totalPages, 1)),
    buildId: String(payload && payload.buildId || '').trim()
  };
}

async function fetchHomelyBuildId(locationContext, market = 'rent') {
  if (String(_homelyBuildIdCache.value || '').trim() && Number(_homelyBuildIdCache.expiresAt || 0) > Date.now()) {
    return _homelyBuildIdCache.value;
  }
  const pageUrl = buildHomelyLifestyleSearchUrl(locationContext, market, 1);
  if (!pageUrl) return '';
  try {
    const response = await fetch(pageUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': HOMELY_LIFESTYLE_USER_AGENT
      }
    });
    if (!response.ok) return '';
    const html = await response.text().catch(() => '');
    const nextDataPayload = extractHomelyNextDataPayload(html);
    const buildId = String(
      nextDataPayload && nextDataPayload.buildId
      || (html.match(/\/_next\/static\/([^/]+)\/_buildManifest\.js/i) || [])[1]
      || (html.match(/"buildId":"([^"]+)"/i) || [])[1]
      || ''
    ).trim();
    if (!buildId) return '';
    _homelyBuildIdCache = {
      value: buildId,
      expiresAt: Date.now() + (30 * 60 * 1000)
    };
    return buildId;
  } catch (err) {
    return '';
  }
}

async function fetchHomelyLifestyleSearchJsonPage(locationContext, market, pageNumber, buildId) {
  const requestUrl = buildHomelyLifestyleSearchDataUrl(locationContext, market, pageNumber, buildId);
  if (!requestUrl) return { ok: false, listings: [], totalPages: 0 };
  try {
    const response = await fetch(requestUrl, {
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': HOMELY_LIFESTYLE_USER_AGENT
      }
    });
    if (!response.ok) {
      if (response.status === 404 && String(_homelyBuildIdCache.value || '').trim() === String(buildId || '').trim()) {
        _homelyBuildIdCache = { value: '', expiresAt: 0 };
      }
      return {
        ok: false,
        listings: [],
        totalPages: 0
      };
    }
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== 'object') return { ok: false, listings: [], totalPages: 0 };
    const extracted = extractHomelyListingsPayload(payload);
    return {
      ok: true,
      listings: extracted.listings,
      totalPages: extracted.totalPages
    };
  } catch (err) {
    return { ok: false, listings: [], totalPages: 0 };
  }
}

function buildHomelyLifestyleLocationSignature(locationContext) {
  if (!locationContext || typeof locationContext !== 'object') return '';
  const explicitSlug = String(locationContext.slug || '').trim();
  if (explicitSlug) return `slug:${explicitSlug}`;
  return [
    normalizeCareerHeroCityKey(locationContext.suburb),
    normalizeAustralianStateAbbreviation(locationContext.state),
    extractAustralianPostcode(locationContext.postcode),
    String(locationContext.label || '').trim().toLowerCase()
  ].filter(Boolean).join('|');
}

async function buildHomelyLifestyleSearchContexts(locationContext, practiceCoords = null) {
  const contexts = [];
  const seen = new Set();
  const pushContext = (value) => {
    const normalized = normalizeLifestyleSearchLocationContext(value);
    const signature = buildHomelyLifestyleLocationSignature({
      ...normalized,
      slug: value && value.slug ? value.slug : '',
      uri: value && value.uri ? value.uri : ''
    });
    if (!signature || seen.has(signature)) return;
    seen.add(signature);
    contexts.push({
      ...normalized,
      slug: String(value && value.slug || '').trim(),
      uri: String(value && value.uri || '').trim()
    });
  };

  const normalized = normalizeLifestyleSearchLocationContext(locationContext);
  const resolved = await resolveHomelyLifestyleLocation(locationContext);
  if (resolved) pushContext(resolved);
  pushContext(normalized);

  const reverseContext = await reverseGeocodeCareerLocationContext(practiceCoords);
  if (reverseContext) {
    const enrichedReverse = await enrichLifestyleLocationContextForHomely(reverseContext, practiceCoords);
    const resolvedReverse = await resolveHomelyLifestyleLocation(enrichedReverse);
    if (resolvedReverse) pushContext(resolvedReverse);
    pushContext(enrichedReverse);
  }

  return contexts;
}

async function fetchHomelyLifestyleListingsForLocation(locationContext, practiceCoords, market, household, options = {}) {
  const searchUrl = buildHomelyLifestyleSearchUrl(locationContext, market, 1);
  if (!searchUrl) return [];
  const buildId = await fetchHomelyBuildId(locationContext, market);
  const deduped = new Map();
  let totalPages = 1;
  const maxPages = Math.max(1, HOMELY_LIFESTYLE_MAX_PAGES);

  for (let page = 1; page <= Math.min(totalPages, maxPages); page += 1) {
    const pageUrl = buildHomelyLifestyleSearchUrl(locationContext, market, page);
    let payload = buildId
      ? await fetchHomelyLifestyleSearchJsonPage(locationContext, market, page, buildId)
      : await fetchHomelyLifestyleSearchPage(pageUrl);
    if (!payload.ok) {
      payload = await fetchHomelyLifestyleSearchPage(pageUrl);
    } else if (buildId && page === 1 && (!Array.isArray(payload.listings) || payload.listings.length === 0)) {
      const htmlPayload = await fetchHomelyLifestyleSearchPage(pageUrl);
      if (htmlPayload.ok && Array.isArray(htmlPayload.listings) && htmlPayload.listings.length > 0) {
        payload = htmlPayload;
      }
    }
    totalPages = Math.max(totalPages, payload.totalPages || 1);
    (Array.isArray(payload.listings) ? payload.listings : []).forEach((record) => {
      const normalized = normalizeHomelyListing(record, practiceCoords, market);
      if (!normalized || !normalized.sourceUrl || !normalized.imageUrl) return;
      deduped.set(normalized.id, normalized);
    });

    const rows = Array.from(deduped.values());
    const bedroomFiltered = rows.filter((item) => (
      Number(item && item.bedrooms || 0) >= (household && household.recommendedBedrooms ? household.recommendedBedrooms : 1)
    ));
    const candidateRows = bedroomFiltered.length ? bedroomFiltered : rows;
    const filteredRows = applyLifestyleHousingFilters(candidateRows, options, market)
      .slice(0, DOMAIN_LIFESTYLE_RESULT_LIMIT);
    if (filteredRows.length >= DOMAIN_LIFESTYLE_RESULT_LIMIT) return filteredRows;
  }

  const rows = Array.from(deduped.values());
  const bedroomFiltered = rows.filter((item) => (
    Number(item && item.bedrooms || 0) >= (household && household.recommendedBedrooms ? household.recommendedBedrooms : 1)
  ));
  const candidateRows = bedroomFiltered.length ? bedroomFiltered : rows;
  return applyLifestyleHousingFilters(candidateRows, options, market)
    .slice(0, DOMAIN_LIFESTYLE_RESULT_LIMIT);
}

async function fetchHomelyLifestyleListings(locationContext, practiceCoords, market, household, options = {}) {
  const searchContexts = await buildHomelyLifestyleSearchContexts(locationContext, practiceCoords);
  const dedupedListings = new Map();

  for (const candidateLocation of searchContexts) {
    const rows = await fetchHomelyLifestyleListingsForLocation(candidateLocation, practiceCoords, market, household, options);
    rows.forEach((item) => {
      if (!item || !item.id) return;
      dedupedListings.set(item.id, item);
    });
    if (dedupedListings.size >= DOMAIN_LIFESTYLE_RESULT_LIMIT) break;
  }

  const mergedRows = Array.from(dedupedListings.values());
  return applyLifestyleHousingFilters(mergedRows, options, market)
    .slice(0, DOMAIN_LIFESTYLE_RESULT_LIMIT);
}

function buildTweedLifestyleHousingSeeds(practiceCoords) {
  return {
    rent: [
      {
        id: 'tweed-rent-1',
        title: 'Single-Level Holden Street Home',
        price: '$870/wk',
        bedrooms: 3,
        bathrooms: 2,
        carSpaces: 2,
        areaSqm: 613,
        imageUrl: buildLifestyleImage(0),
        coords: buildLifestyleCoordinate(-28.1917, 153.5296) || offsetCoordinate(practiceCoords, -0.0034, -0.0079),
        address: '18 Holden Street, Tweed Heads South',
        suburb: 'Tweed Heads South',
        propertyType: 'House',
        summary: 'Single-level family home close to the river, Tweed City and local schools.',
        sourceUrl: 'https://www.homely.com.au/homes/18-holden-street-tweed-heads-south-nsw-2486/12994171',
        sourceLabel: 'Homely'
      },
      {
        id: 'tweed-rent-2',
        title: 'William Street Townhouse',
        price: '$780/wk',
        bedrooms: 3,
        bathrooms: 2,
        carSpaces: 2,
        imageUrl: buildLifestyleImage(1),
        coords: buildLifestyleCoordinate(-28.1838, 153.5453) || offsetCoordinate(practiceCoords, 0.0045, 0.0078),
        address: '7/16 William Street, Tweed Heads South',
        suburb: 'Tweed Heads South',
        propertyType: 'Townhouse',
        summary: 'Freshly painted townhome with dual patios and a short run to Tweed River and the beaches.',
        sourceUrl: 'https://www.realestate.com.au/property-townhouse-nsw-tweed%2Bheads%2Bsouth-442864268',
        sourceLabel: 'realestate.com.au'
      },
      {
        id: 'tweed-rent-3',
        title: 'Lorikeet Drive Townhome',
        price: '$750/wk',
        bedrooms: 3,
        bathrooms: 2,
        carSpaces: 1,
        imageUrl: buildLifestyleImage(2),
        coords: buildLifestyleCoordinate(-28.1989, 153.5228) || offsetCoordinate(practiceCoords, -0.0106, -0.0147),
        address: '39/14 Lorikeet Drive, Tweed Heads South',
        suburb: 'Tweed Heads South',
        propertyType: 'Townhouse',
        summary: 'Architect-designed townhome with ducted air, coastal access and quality school links.',
        sourceUrl: 'https://www.realestate.com.au/property-townhouse-nsw-tweed%2Bheads%2Bsouth-442910916',
        sourceLabel: 'realestate.com.au'
      },
      {
        id: 'tweed-rent-4',
        title: 'Vintage Lakes Villa',
        price: '$750/wk',
        bedrooms: 3,
        bathrooms: 1,
        carSpaces: 2,
        areaSqm: 310,
        imageUrl: buildLifestyleImage(3),
        coords: buildLifestyleCoordinate(-28.2059, 153.5272) || offsetCoordinate(practiceCoords, -0.0176, -0.0103),
        address: '6/6 Merlot Court, Tweed Heads South',
        suburb: 'Tweed Heads South',
        propertyType: 'Villa',
        summary: 'Low-maintenance Vintage Lakes villa with courtyard living and nearby shopping.',
        sourceUrl: 'https://www.realestate.com.au/property-house-nsw-tweed%2Bheads%2Bsouth-443281020',
        sourceLabel: 'realestate.com.au'
      }
    ],
    buy: [
      {
        id: 'tweed-buy-1',
        title: 'Merlot Court Villa',
        price: 'Guide $930,000',
        bedrooms: 3,
        bathrooms: 1,
        carSpaces: 2,
        areaSqm: 343,
        imageUrl: buildLifestyleImage(4),
        coords: buildLifestyleCoordinate(-28.2058, 153.5267) || offsetCoordinate(practiceCoords, -0.0175, -0.0108),
        address: '5/6 Merlot Court, Tweed Heads South',
        suburb: 'Tweed Heads South',
        propertyType: 'Villa',
        summary: 'Boutique cul-de-sac villa with private yard, modern comfort and strong local amenity access.',
        sourceUrl: 'https://www.realestate.com.au/property-house-nsw-tweed%2Bheads%2Bsouth-149842556',
        sourceLabel: 'realestate.com.au'
      },
      {
        id: 'tweed-buy-2',
        title: 'Blundell Boulevard Duplex',
        price: '$939,000',
        bedrooms: 3,
        bathrooms: 1,
        carSpaces: 1,
        areaSqm: 107,
        imageUrl: buildLifestyleImage(0),
        coords: buildLifestyleCoordinate(-28.1848, 153.5403) || offsetCoordinate(practiceCoords, 0.0035, 0.0028),
        address: '2/46 Blundell Boulevard, Tweed Heads South',
        suburb: 'Tweed Heads South',
        propertyType: 'Duplex',
        summary: 'Renovated duplex with flexible third bedroom, new kitchen and an oversized courtyard.',
        sourceUrl: 'https://view.com.au/property/nsw/tweed-heads-south-2486/2-46-blundell-boulevard-17634537/',
        sourceLabel: 'view.com.au'
      },
      {
        id: 'tweed-buy-3',
        title: 'Easy-Care Kirkwood Villa',
        price: '$780,000 - $810,000',
        bedrooms: 2,
        bathrooms: 1,
        carSpaces: 1,
        areaSqm: 232,
        imageUrl: buildLifestyleImage(1),
        coords: buildLifestyleCoordinate(-28.1806, 153.5372) || offsetCoordinate(practiceCoords, 0.0077, -0.0003),
        address: '22/22B Kirkwood Road, Tweed Heads South',
        suburb: 'Tweed Heads South',
        propertyType: 'Villa',
        summary: 'Renovated single-level villa with solar, ducted air and walk-through access to Tweed City.',
        sourceUrl: 'https://www.realestate.com.au/property-villa-nsw-tweed%2Bheads%2Bsouth-150316232',
        sourceLabel: 'realestate.com.au'
      },
      {
        id: 'tweed-buy-4',
        title: 'Cox Drive Family Home',
        price: '$1,200,000',
        bedrooms: 3,
        bathrooms: 1,
        carSpaces: 5,
        areaSqm: 740,
        imageUrl: buildLifestyleImage(2),
        coords: buildLifestyleCoordinate(-28.1769, 153.5462) || offsetCoordinate(practiceCoords, 0.0114, 0.0087),
        address: '16 Cox Drive, Tweed Heads South',
        suburb: 'Tweed Heads South',
        propertyType: 'House',
        summary: 'Flat river-adjacent block with polished timber floors and future upside for a family move.',
        sourceUrl: 'https://realsearch.com.au/house-16-cox-drive-tweed-heads-south-nsw-2486',
        sourceLabel: 'Real Search'
      }
    ]
  };
}

function buildGenericLifestyleHousingSeeds(practiceCoords, locationContext) {
  const suburb = locationContext && locationContext.suburb ? locationContext.suburb : 'the practice';
  const build = (market) => {
    const base = market === 'buy'
      ? [
          { id: 'buy-1', price: '$1.08m', bedrooms: 4, delta: [0.0102, -0.0096] },
          { id: 'buy-2', price: '$1.26m', bedrooms: 5, delta: [-0.0186, 0.0208] },
          { id: 'buy-3', price: '$945k', bedrooms: 3, delta: [-0.0114, -0.0074] }
        ]
      : [
          { id: 'rent-1', price: '$650/wk', bedrooms: 3, delta: [0.0096, -0.0101] },
          { id: 'rent-2', price: '$790/wk', bedrooms: 4, delta: [-0.0172, 0.0162] },
          { id: 'rent-3', price: '$720/wk', bedrooms: 3, delta: [-0.0121, -0.0062] }
        ];
    return base.map((item, index) => ({
      id: `${normalizeCareerHeroCityKey(suburb) || 'practice'}-${item.id}`,
      price: item.price,
      bedrooms: item.bedrooms,
      imageUrl: buildLifestyleImage(index),
      imagePosition: 'center',
      coords: offsetCoordinate(practiceCoords, item.delta[0], item.delta[1]),
      address: `${suburb} home option ${index + 1}`,
      sourceUrl: '',
      sourceLabel: 'GP Link'
    }));
  };
  return { rent: build('rent'), buy: build('buy') };
}

function normalizeLifestyleListing(seed, practiceCoords, market, locationContext) {
  const coords = buildLifestyleCoordinate(seed && seed.coords && seed.coords.lat, seed && seed.coords && seed.coords.lng);
  const distanceKm = coords && practiceCoords ? calculateDistanceKm(practiceCoords, coords) : null;
  const bedrooms = parseBedroomsCount(seed && seed.bedrooms);
  return {
    id: String(seed && seed.id || crypto.randomUUID()),
    price: String(seed && seed.price || (market === 'buy' ? '$1.10m' : '$700/wk')),
    priceValue: parseLifestylePriceValue(seed && seed.price, market),
    bedrooms,
    bathrooms: parseWholeNumber(seed && seed.bathrooms, 2),
    carSpaces: parseWholeNumber(seed && seed.carSpaces, 1),
    beds: formatBedroomsLabel(bedrooms),
    distanceKm: distanceKm ? Number(distanceKm.toFixed(1)) : 0,
    driveTime: formatLifestyleDriveTime(distanceKm || 0),
    imageUrl: resizeDomainImageUrl(String(seed && seed.imageUrl || buildLifestyleImage(0))),
    imagePosition: String(seed && seed.imagePosition || 'center'),
    address: String(seed && seed.address || `${locationContext && locationContext.suburb ? locationContext.suburb : 'Practice'} property option`),
    title: String(seed && seed.title || seed && seed.address || `${locationContext && locationContext.suburb ? locationContext.suburb : 'Practice'} property option`),
    suburb: String(seed && seed.suburb || locationContext && locationContext.suburb || ''),
    propertyType: String(seed && seed.propertyType || 'House'),
    summary: String(seed && seed.summary || ''),
    areaSqm: parseWholeNumber(seed && seed.areaSqm, 0),
    sourceLabel: String(seed && seed.sourceLabel || 'GP Link'),
    sourceUrl: normalizeDomainSourceUrl(seed && seed.sourceUrl),
    lat: coords ? coords.lat : null,
    lng: coords ? coords.lng : null,
    market
  };
}

async function domainApiRequest(resourcePath, options = {}) {
  if (!isDomainLifestyleConfigured()) return null;
  const method = String(options.method || 'GET').toUpperCase();
  const url = resourcePath.startsWith('http') ? resourcePath : `${DOMAIN_API_BASE}${resourcePath}`;
  const headers = await buildDomainApiHeaders(method, options.scope || '');
  if (!headers) return null;
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    if (!response.ok) {
      const failureText = await response.text().catch(() => '');
      logDomainApiWarning(
        `${method} ${resourcePath} failed with status ${response.status}.`,
        failureText ? failureText.slice(0, 240) : ''
      );
      return null;
    }
    return await response.json().catch(() => null);
  } catch (err) {
    logDomainApiWarning(`${method} ${resourcePath} threw an error.`, err && err.message ? String(err.message) : '');
    return null;
  }
}

function buildDomainResidentialSearchPayload(locationContext, market, household, options = {}) {
  const suburb = String(locationContext && locationContext.suburb || '').trim();
  const state = String(locationContext && locationContext.state || '').trim().toUpperCase();
  const postcode = String(locationContext && (locationContext.postcode || locationContext.postCode) || '').trim();
  const label = String(locationContext && locationContext.label || '').trim();
  const radiusKm = clampDomainLifestyleRadiusKm(options.radiusKm, DOMAIN_LIFESTYLE_MAX_RADIUS_KM);
  const keywords = buildDomainLifestyleKeywords(options.searchQuery);
  const minPrice = parseWholeNumber(options.priceMin, 0);
  let maxPrice = parseWholeNumber(options.priceMax, 0);
  if (minPrice > 0 && maxPrice > 0 && maxPrice < minPrice) maxPrice = minPrice;
  const payload = {
    listingType: market === 'buy' ? 'Sale' : 'Rent',
    propertyEstablishedType: 'Any',
    minBedrooms: Math.max(1, household && household.recommendedBedrooms ? household.recommendedBedrooms : 1),
    pageSize: DOMAIN_LIFESTYLE_SEARCH_PAGE_SIZE,
    pageNumber: 1
  };
  if (minPrice > 0) payload.minPrice = minPrice;
  if (maxPrice > 0) payload.maxPrice = maxPrice;
  if (keywords.length) payload.keywords = keywords;
  if (suburb || state || postcode) {
    payload.locations = [
      {
        state,
        region: '',
        area: '',
        suburb,
        postCode: postcode,
        includeSurroundingSuburbs: true,
        surroundingRadiusInMeters: radiusKm * 1000
      }
    ];
  }
  if (!payload.locations && label) {
    payload.locationTerms = label;
  }
  if (!payload.locations && !payload.locationTerms) return null;
  return payload;
}

function applyLifestyleHousingFilters(listings, options = {}, market = 'rent') {
  const radiusKm = clampDomainLifestyleRadiusKm(options.radiusKm, DOMAIN_LIFESTYLE_MAX_RADIUS_KM);
  const query = sanitizeDomainLifestyleSearchQuery(options.searchQuery).toLowerCase();
  const minPrice = parseWholeNumber(options.priceMin, 0);
  let maxPrice = parseWholeNumber(options.priceMax, 0);
  if (minPrice > 0 && maxPrice > 0 && maxPrice < minPrice) maxPrice = minPrice;
  const sortOrder = String(options.sortOrder || '').trim() === 'price_desc'
    ? 'price_desc'
    : (String(options.sortOrder || '').trim() === 'price_asc' ? 'price_asc' : '');
  return (Array.isArray(listings) ? listings : [])
    .filter((item) => {
      const distanceKm = Number(item && item.distanceKm);
      return !Number.isFinite(distanceKm) || distanceKm <= radiusKm;
    })
    .filter((item) => {
      if (!query) return true;
      const haystack = [
        item && item.title,
        item && item.address,
        item && item.suburb,
        item && item.propertyType,
        item && item.summary
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    })
    .filter((item) => {
      const priceValue = parseLifestylePriceValue(item && item.priceValue, market)
        || parseLifestylePriceValue(item && item.price, market);
      if (minPrice > 0 && priceValue > 0 && priceValue < minPrice) return false;
      if (maxPrice > 0 && priceValue > 0 && priceValue > maxPrice) return false;
      return true;
    })
    .sort((left, right) => {
      const leftDistance = Number(left && left.distanceKm || 0);
      const rightDistance = Number(right && right.distanceKm || 0);
      if (sortOrder) {
        const leftPrice = parseLifestylePriceValue(left && left.priceValue, market)
          || parseLifestylePriceValue(left && left.price, market);
        const rightPrice = parseLifestylePriceValue(right && right.priceValue, market)
          || parseLifestylePriceValue(right && right.price, market);
        if (leftPrice !== rightPrice) {
          return sortOrder === 'price_desc'
            ? rightPrice - leftPrice
            : leftPrice - rightPrice;
        }
      }
      return leftDistance - rightDistance;
    });
}

function normalizeDomainAgencyBrand(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function buildDomainAgencyBrandSearchQueries(locationContext, brand) {
  const brandLabel = String(brand || '').trim();
  const suburb = String(locationContext && locationContext.suburb || '').trim();
  const state = String(locationContext && locationContext.state || '').trim().toUpperCase();
  const label = String(locationContext && locationContext.label || '').trim().replace(/,\s*Australia\s*$/i, '');
  const queries = [
    `name:"${brandLabel}" accountType:residential ${suburb} ${state}`.trim(),
    `${brandLabel} ${suburb} ${state}`.trim(),
    `${brandLabel} ${suburb}`.trim(),
    `${brandLabel} ${label}`.trim(),
    brandLabel
  ];
  return Array.from(new Set(queries.map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean))).slice(0, 5);
}

function scoreDomainAgencySearchMatch(agency, brand, locationContext, market) {
  if (!agency || typeof agency !== 'object') return -1;
  const agencyName = normalizeDomainAgencyBrand(agency.name);
  const brandKey = normalizeDomainAgencyBrand(brand);
  if (!agencyName || !brandKey || !agencyName.includes(brandKey)) return -1;
  const suburb = normalizeDomainAgencyBrand(locationContext && locationContext.suburb);
  const state = String(locationContext && locationContext.state || '').trim().toUpperCase();
  let score = 100;
  if (suburb && normalizeDomainAgencyBrand(agency.suburb) === suburb) score += 50;
  if (suburb && agencyName.includes(suburb)) score += 20;
  if (state && String(agency.state || '').trim().toUpperCase() === state) score += 15;
  if (agency.inSuburb === true) score += 10;
  if (market === 'rent') score += Math.min(30, Number(agency.numberForRent || 0) || 0);
  if (market === 'buy') score += Math.min(30, Number(agency.numberForSale || 0) || 0);
  if (agency.hasRecentlySold) score += 5;
  return score;
}

async function searchDomainAgenciesForBrand(locationContext, brand, market) {
  const queries = buildDomainAgencyBrandSearchQueries(locationContext, brand);
  const matches = [];
  const seenAgencyIds = new Set();
  for (const query of queries) {
    const searchParams = new URLSearchParams({
      q: query,
      pageNumber: '1',
      pageSize: '12'
    });
    const response = await domainApiRequest(`/v1/agencies?${searchParams.toString()}`, {
      scope: DOMAIN_AGENCIES_READ_SCOPE
    });
    const rows = Array.isArray(response) ? response : [];
    rows.forEach((agency) => {
      const score = scoreDomainAgencySearchMatch(agency, brand, locationContext, market);
      const agencyId = String(agency && agency.id || '').trim();
      if (!agencyId || score < 0 || seenAgencyIds.has(agencyId)) return;
      seenAgencyIds.add(agencyId);
      matches.push({ ...agency, score, brand });
    });
    if (matches.length >= 3) break;
  }
  return matches
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
    .slice(0, 3);
}

async function collectDomainSelectedAgencyMatches(locationContext, market) {
  const brands = DOMAIN_LIFESTYLE_AGENCY_BRANDS.filter(Boolean);
  if (!brands.length) return [];
  const byBrand = await Promise.all(brands.map((brand) => searchDomainAgenciesForBrand(locationContext, brand, market)));
  const matches = byBrand.flat();
  const deduped = [];
  const seen = new Set();
  matches
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
    .forEach((agency) => {
      const agencyId = String(agency && agency.id || '').trim();
      if (!agencyId || seen.has(agencyId)) return;
      seen.add(agencyId);
      deduped.push(agency);
    });
  return deduped.slice(0, 8);
}

function matchesDomainAgencyListingMarket(record, market) {
  const value = String(
    pickFirstDefined(
      record && record.objective,
      record && record.saleMode,
      record && record.listingType
    ) || ''
  ).trim().toLowerCase();
  if (!value) return true;
  if (market === 'rent') return /(rent|lease)/i.test(value);
  return /(buy|sale|auction)/i.test(value);
}

function normalizeDomainAgencyListing(record, practiceCoords, market, agency) {
  const normalized = normalizeDomainListing(record, practiceCoords, market);
  if (!normalized) return null;
  const agencyName = String(
    pickFirstDefined(
      agency && agency.name,
      record && record.advertiser && record.advertiser.name,
      record && record.advertiserName,
      normalized.sourceLabel
    ) || 'Domain'
  ).trim();
  return {
    ...normalized,
    sourceLabel: agencyName
  };
}

async function fetchDomainSelectedAgencyLifestyleListings(locationContext, practiceCoords, market, household, options = {}) {
  const agencies = await collectDomainSelectedAgencyMatches(locationContext, market);
  if (!agencies.length) return [];
  const listingResponses = await Promise.all(agencies.map(async (agency) => {
    const searchParams = new URLSearchParams({
      listingStatusFilter: 'live',
      pageNumber: '1',
      pageSize: '80'
    });
    const response = await domainApiRequest(`/v1/agencies/${encodeURIComponent(String(agency.id))}/listings?${searchParams.toString()}`);
    const rows = Array.isArray(response) ? response : [];
    return rows
      .filter((item) => String(item && item.channel || '').trim().toLowerCase() === 'residential')
      .filter((item) => matchesDomainAgencyListingMarket(item, market))
      .map((item) => normalizeDomainAgencyListing(item, practiceCoords, market, agency))
      .filter(Boolean);
  }));
  const deduped = [];
  const seenIds = new Set();
  listingResponses.flat().forEach((item) => {
    const listingId = String(item && item.id || '').trim();
    if (!listingId || seenIds.has(listingId)) return;
    seenIds.add(listingId);
    deduped.push(item);
  });
  const bedroomFiltered = deduped.filter((item) => (
    Number(item && item.bedrooms || 0) >= (household && household.recommendedBedrooms ? household.recommendedBedrooms : 1)
  ));
  const candidateRows = bedroomFiltered.length ? bedroomFiltered : deduped;
  return applyLifestyleHousingFilters(candidateRows, options, market)
    .slice(0, DOMAIN_LIFESTYLE_RESULT_LIMIT);
}

function buildLifestyleHousingFallbackCatalog(locationContext, practiceCoords) {
  const suburbKey = normalizeCareerHeroCityKey(locationContext && locationContext.suburb);
  return (suburbKey === 'tweed_heads' || suburbKey === 'tweed_heads_south')
    ? buildTweedLifestyleHousingSeeds(practiceCoords)
    : buildGenericLifestyleHousingSeeds(practiceCoords, locationContext);
}

function buildLifestyleFallbackListings(fallbackRows, practiceCoords, market, locationContext, household, options = {}) {
  const normalizedFallback = (Array.isArray(fallbackRows) ? fallbackRows : [])
    .map((item) => normalizeLifestyleListing(item, practiceCoords, market, locationContext));
  const bedroomFiltered = normalizedFallback.filter((item) => (
    Number(item && item.bedrooms || 0) >= (household && household.recommendedBedrooms ? household.recommendedBedrooms : 1)
  ));
  const candidateRows = bedroomFiltered.length ? bedroomFiltered : normalizedFallback;
  return applyLifestyleHousingFilters(candidateRows, options, market).slice(0, DOMAIN_LIFESTYLE_RESULT_LIMIT);
}

function pickFirstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function getDomainListingNode(record) {
  return record && record.listing && typeof record.listing === 'object'
    ? record.listing
    : (record && typeof record === 'object' ? record : null);
}

function getDomainPropertyDetails(record) {
  const listing = getDomainListingNode(record);
  if (listing && listing.propertyDetails && typeof listing.propertyDetails === 'object') return listing.propertyDetails;
  if (record && record.propertyDetails && typeof record.propertyDetails === 'object') return record.propertyDetails;
  return {};
}

function collectDomainResidentialSearchListingsFromItem(item) {
  if (!item || typeof item !== 'object') return [];
  if (item.listing && typeof item.listing === 'object') return [item];
  if (
    item.propertyDetails && typeof item.propertyDetails === 'object'
    && (item.priceDetails || item.id || item.headline || item.listingSlug)
  ) {
    return [item];
  }

  const nestedCollections = [
    item.listings,
    item.projectListings,
    item.results,
    item.children,
    item.childListings,
    item.project && item.project.listings
  ].filter(Array.isArray);

  if (!nestedCollections.length) return [];

  return nestedCollections.flatMap((collection) => (
    collection.flatMap((entry) => collectDomainResidentialSearchListingsFromItem(entry))
  ));
}

function collectDomainResidentialSearchListings(response) {
  const rows = Array.isArray(response)
    ? response
    : (Array.isArray(response && response.searchResults) ? response.searchResults : []);
  return rows.flatMap((item) => collectDomainResidentialSearchListingsFromItem(item));
}

function extractDomainListingCoordinates(record) {
  const listing = getDomainListingNode(record);
  const propertyDetails = getDomainPropertyDetails(record);
  const lat = parseCareerCoordinate(
    pickFirstDefined(
      record && record.latitude,
      propertyDetails && propertyDetails.latitude,
      propertyDetails && propertyDetails.lat,
      record && record.geoLocation && record.geoLocation.latitude,
      record && record.geoLocation && record.geoLocation.lat,
      listing && listing.latitude,
      listing && listing.geoLocation && listing.geoLocation.latitude,
      listing && listing.geoLocation && listing.geoLocation.lat
    )
  );
  const lng = parseCareerCoordinate(
    pickFirstDefined(
      record && record.longitude,
      propertyDetails && propertyDetails.longitude,
      propertyDetails && propertyDetails.lon,
      record && record.geoLocation && record.geoLocation.longitude,
      record && record.geoLocation && record.geoLocation.lon,
      listing && listing.longitude,
      listing && listing.geoLocation && listing.geoLocation.longitude,
      listing && listing.geoLocation && listing.geoLocation.lon
    )
  );
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function buildDomainListingAddress(record) {
  const listing = getDomainListingNode(record);
  const propertyDetails = getDomainPropertyDetails(record);
  const explicitAddress = buildLocationLabel([
    pickFirstDefined(
      record && record.addressParts && record.addressParts.displayAddress,
      record && record.displayAddress,
      record && record.address,
      propertyDetails && propertyDetails.displayableAddress,
      listing && listing.addressParts && listing.addressParts.displayAddress,
      listing && listing.displayAddress
    )
  ]);
  if (explicitAddress) return explicitAddress;

  const unitNumber = String(
    pickFirstDefined(
      propertyDetails && propertyDetails.unitNumber,
      record && record.addressParts && record.addressParts.unitNumber,
      listing && listing.addressParts && listing.addressParts.unitNumber
    ) || ''
  ).trim();
  const streetNumber = String(
    pickFirstDefined(
      propertyDetails && propertyDetails.streetNumber,
      record && record.addressParts && record.addressParts.streetNumber,
      listing && listing.addressParts && listing.addressParts.streetNumber
    ) || ''
  ).trim();
  const street = String(
    pickFirstDefined(
      propertyDetails && propertyDetails.street,
      record && record.addressParts && record.addressParts.street,
      listing && listing.addressParts && listing.addressParts.street
    ) || ''
  ).trim();
  const suburb = String(
    pickFirstDefined(
      propertyDetails && propertyDetails.suburb,
      record && record.addressParts && record.addressParts.suburb,
      record && record.suburb,
      listing && listing.addressParts && listing.addressParts.suburb
    ) || ''
  ).trim();
  const state = String(
    pickFirstDefined(
      propertyDetails && propertyDetails.state,
      propertyDetails && propertyDetails.stateAbbreviation,
      record && record.addressParts && record.addressParts.state,
      record && record.addressParts && record.addressParts.stateAbbreviation,
      listing && listing.addressParts && listing.addressParts.state,
      listing && listing.addressParts && listing.addressParts.stateAbbreviation
    ) || ''
  ).trim().toUpperCase();
  const postcode = String(
    pickFirstDefined(
      propertyDetails && propertyDetails.postcode,
      record && record.addressParts && record.addressParts.postcode,
      listing && listing.addressParts && listing.addressParts.postcode
    ) || ''
  ).trim();
  const streetLabelCore = buildLocationLabel([streetNumber, street]).replace(/,\s+/g, ' ').trim();
  const streetLabel = unitNumber && streetLabelCore ? `${unitNumber}/${streetLabelCore}` : (unitNumber || streetLabelCore);
  return buildLocationLabel([
    streetLabel,
    buildLocationLabel([suburb, state, postcode])
  ]);
}

function pickDomainImageUrl(record) {
  const listing = getDomainListingNode(record);
  const propertyDetails = getDomainPropertyDetails(record);
  const collections = [
    propertyDetails && propertyDetails.images,
    record && record.media,
    record && record.photos,
    record && record.images,
    listing && listing.media,
    listing && listing.images
  ];
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    const preferred = collection.find((item) => {
      const url = String(item && (item.url || item.imageUrl) || '').trim();
      const category = String(item && item.category || '').trim();
      return !!url && (!category || /image/i.test(category));
    });
    if (preferred) return String(preferred.url || preferred.imageUrl || '').trim();
    const fallback = collection.find((item) => String(item && (item.url || item.imageUrl) || '').trim());
    if (fallback) return String(fallback.url || fallback.imageUrl || '').trim();
  }
  return '';
}

function normalizeDomainListing(record, practiceCoords, market) {
  const listing = getDomainListingNode(record);
  const propertyDetails = getDomainPropertyDetails(record);
  const coords = extractDomainListingCoordinates(record);
  if (!coords) return null;
  const bedrooms = parseBedroomsCount(
    pickFirstDefined(
      record && record.bedrooms,
      record && record.bedroomCount,
      record && record.features && record.features.bedrooms,
      record && record.propertyDetails && record.propertyDetails.bedrooms,
      propertyDetails && propertyDetails.bedrooms
    )
  );
  const bathrooms = parseWholeNumber(
    pickFirstDefined(
      record && record.bathrooms,
      record && record.bathroomCount,
      record && record.features && record.features.bathrooms,
      record && record.propertyDetails && record.propertyDetails.bathrooms,
      propertyDetails && propertyDetails.bathrooms
    ),
    0
  );
  const carSpaces = parseWholeNumber(
    pickFirstDefined(
      record && record.carspaces,
      record && record.carSpaces,
      record && record.parking,
      record && record.features && record.features.parking,
      record && record.features && record.features.carspaces,
      record && record.propertyDetails && record.propertyDetails.carspaces,
      propertyDetails && propertyDetails.carspaces
    ),
    0
  );
  const priceLabel = String(
    pickFirstDefined(
      record && record.priceDetails && record.priceDetails.displayPrice,
      record && record.price,
      record && record.listing && record.listing.priceDetails && record.listing.priceDetails.displayPrice,
      listing && listing.priceDetails && listing.priceDetails.displayPrice
    ) || ''
  ).trim();
  const imageUrl = pickDomainImageUrl(record);
  const address = buildDomainListingAddress(record);
  const title = String(
    pickFirstDefined(
      record && record.headline,
      listing && listing.headline,
      record && record.title,
      record && record.displayAddress,
      record && record.addressParts && record.addressParts.displayAddress,
      record && record.listing && record.listing.headline,
      record && record.listing && record.listing.title,
      propertyDetails && propertyDetails.displayableAddress,
      address
    ) || ''
  ).trim();
  const sourceUrl = normalizeDomainSourceUrl(
    pickFirstDefined(
      record && record.seoUrl,
      record && record.publicUrl,
      record && record.listing && record.listing.seoUrl,
      record && record.listing && record.listing.publicUrl,
      listing && listing.listingSlug
    )
  );
  const propertyType = String(
    pickFirstDefined(
      record && record.propertyType,
      record && record.propertyTypes && record.propertyTypes[0],
      record && record.listing && record.listing.propertyType,
      propertyDetails && propertyDetails.propertyType,
      propertyDetails && propertyDetails.allPropertyTypes && propertyDetails.allPropertyTypes[0]
    ) || ''
  ).trim();
  const suburb = String(
    pickFirstDefined(
      propertyDetails && propertyDetails.suburb,
      record && record.addressParts && record.addressParts.suburb,
      record && record.suburb,
      record && record.listing && record.listing.addressParts && record.listing.addressParts.suburb
    ) || ''
  ).trim();
  const summary = stripHtml(String(
    pickFirstDefined(
      record && record.summaryDescription,
      record && record.summary,
      record && record.description,
      record && record.listing && record.listing.summaryDescription,
      listing && listing.summaryDescription,
      listing && listing.description
    ) || ''
  )).slice(0, 280);
  const distanceKm = calculateDistanceKm(practiceCoords, coords);
  const safeAddress = address || suburb || 'Domain listing';
  const safeTitle = title || address || suburb || 'Domain listing';
  return {
    id: String(pickFirstDefined(record && record.id, record && record.listing && record.listing.id, listing && listing.id, crypto.randomUUID())),
    price: priceLabel || (market === 'buy' ? 'Price on request' : 'Rent on request'),
    priceValue: parseLifestylePriceValue(
      pickFirstDefined(
        record && record.priceDetails && record.priceDetails.displayPrice,
        record && record.price,
        record && record.priceDetails && record.priceDetails.price,
        record && record.priceDetails && record.priceDetails.priceFrom,
        record && record.priceDetails && record.priceDetails.rentPerWeek,
        record && record.listing && record.listing.priceDetails && record.listing.priceDetails.displayPrice,
        listing && listing.priceDetails && listing.priceDetails.displayPrice,
        listing && listing.priceDetails && listing.priceDetails.price,
        listing && listing.priceDetails && listing.priceDetails.priceFrom,
        listing && listing.priceDetails && listing.priceDetails.rentPerWeek
      ),
      market
    ),
    bedrooms,
    bathrooms,
    carSpaces,
    beds: formatBedroomsLabel(bedrooms),
    distanceKm: distanceKm ? Number(distanceKm.toFixed(1)) : 0,
    driveTime: formatLifestyleDriveTime(distanceKm || 0),
    imageUrl: resizeDomainImageUrl(imageUrl || ''),
    imagePosition: 'center',
    address: safeAddress,
    title: safeTitle,
    suburb,
    propertyType,
    summary,
    sourceLabel: 'Domain',
    sourceUrl,
    lat: coords.lat,
    lng: coords.lng,
    market
  };
}

async function fetchDomainLifestyleListings(locationContext, practiceCoords, market, household, options = {}) {
  const payload = buildDomainResidentialSearchPayload(locationContext, market, household, options);
  if (!payload) return [];
  const response = await domainApiRequest('/v1/listings/residential/_search', {
    method: 'POST',
    body: payload
  });
  // Residential search already includes the fields we need for cards and map pins.
  // Avoid secondary listing-detail calls because those can require agency-linked auth.
  const rows = collectDomainResidentialSearchListings(response);
  return applyLifestyleHousingFilters(rows
    .map((item) => normalizeDomainListing(item, practiceCoords, market))
    .filter(Boolean)
    .filter((item) => !!item.sourceUrl && !!item.imageUrl)
  , options, market).slice(0, DOMAIN_LIFESTYLE_RESULT_LIMIT);
}

async function querySchoolFinderSql(query) {
  const sql = String(query || '').trim();
  if (!sql) return [];
  const url = new URL(NSW_SCHOOL_FINDER_SQL_ENDPOINT);
  url.searchParams.set('q', sql);
  try {
    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) return [];
    const payload = await response.json().catch(() => null);
    return Array.isArray(payload && payload.rows) ? payload.rows : [];
  } catch (err) {
    return [];
  }
}

function buildSchoolFinderTypeWhere(phase) {
  return phase === 'secondary'
    ? "(s.type = 'secondary' OR s.type = 'central')"
    : "(s.type = 'primary' OR s.type = 'infants' OR s.type = 'central')";
}

async function fetchNearbyPublicSchools(practiceCoords, phase, limit = 8) {
  const lat = parseCareerCoordinate(practiceCoords && practiceCoords.lat);
  const lng = parseCareerCoordinate(practiceCoords && practiceCoords.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  const sql = [
    'SELECT',
    's.school_code, s.school_name, s.type, s.level_of_schooling,',
    `ST_DISTANCE(s.the_geom::geography, ST_SetSRID(ST_Point(${lng},${lat}),4326)::geography) / 1000 AS distance_km,`,
    'ST_Y(s.the_geom) AS latitude, ST_X(s.the_geom) AS longitude',
    `FROM ${SCHOOL_FINDER_TABLE_SCHOOLS} AS s`,
    `WHERE ${buildSchoolFinderTypeWhere(phase)}`,
    'ORDER BY distance_km ASC',
    `LIMIT ${Math.max(1, Math.min(20, Number(limit) || 8))}`
  ].join(' ');
  return querySchoolFinderSql(sql);
}

async function fetchCatchmentSchoolsForListing(listing, phase) {
  const lat = parseCareerCoordinate(listing && listing.lat);
  const lng = parseCareerCoordinate(listing && listing.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  const sql = [
    'SELECT DISTINCT ON (s.school_code)',
    's.school_code, s.school_name, s.type, s.level_of_schooling,',
    'b.catchment_level, b.calendar_year,',
    `ST_DISTANCE(s.the_geom::geography, ST_SetSRID(ST_Point(${lng},${lat}),4326)::geography) / 1000 AS distance_km,`,
    'ST_Y(s.the_geom) AS latitude, ST_X(s.the_geom) AS longitude',
    `FROM ${SCHOOL_FINDER_TABLE_SCHOOLS} AS s`,
    `JOIN ${SCHOOL_FINDER_TABLE_CATCHMENTS} AS b ON s.school_code = b.school_code`,
    `WHERE ST_CONTAINS(b.the_geom, ST_SetSRID(ST_Point(${lng},${lat}),4326))`,
    `AND ${buildSchoolFinderTypeWhere(phase)}`,
    'ORDER BY s.school_code, b.calendar_year DESC NULLS LAST, distance_km ASC'
  ].join(' ');
  return querySchoolFinderSql(sql);
}

function inferSchoolType(name) {
  const lower = String(name || '').toLowerCase();
  if (/secondary|high school|college|grammar/.test(lower)) return 'secondary';
  if (/primary|infants|elementary/.test(lower)) return 'primary';
  return 'unknown';
}

function inferSchoolSector(name) {
  const lower = String(name || '').toLowerCase();
  if (/catholic|christian|anglican|lutheran|adventist|islamic|jewish|baptist|methodist/.test(lower)) return 'private';
  if (/public|state|government/.test(lower)) return 'public';
  return 'unknown';
}

function buildTweedSchoolHints() {
  return {
    primary: [
      { key: 'tweed heads south public school', sector: 'Public', sectorGroup: 'public', rating: 'Above Average', rankLabel: 'Above Average', rankingScore: 82, starRating: 4.2, coords: { lat: -28.1834, lng: 153.5441 } },
      { key: "st james' primary school banora point", sector: 'Catholic', sectorGroup: 'catholic', rating: 'Above Average', rankLabel: 'Above Average', rankingScore: 80, starRating: 4.0, coords: { lat: -28.2068, lng: 153.5357 } },
      { key: 'lindisfarne anglican grammar school junior school', sector: 'Private', sectorGroup: 'private', rating: 'Top 15%', rankLabel: 'Top 15%', rankingScore: 94, starRating: 4.7, coords: { lat: -28.1837, lng: 153.5215 } },
      { key: "st joseph's primary school tweed heads", sector: 'Catholic', sectorGroup: 'catholic', rating: 'Above Average', rankLabel: 'Above Average', rankingScore: 79, starRating: 4.1, coords: { lat: -28.1718, lng: 153.5456 } }
    ],
    secondary: [
      { key: 'lindisfarne anglican grammar school', sector: 'Private', sectorGroup: 'private', rating: 'Top 15%', rankLabel: 'Top 15%', rankingScore: 95, starRating: 4.7, coords: { lat: -28.2034, lng: 153.5157 } },
      { key: 'pacific coast christian school', sector: 'Private', sectorGroup: 'private', rating: 'Well Regarded', rankLabel: 'Well Regarded', rankingScore: 84, starRating: 4.3, coords: { lat: -28.1813, lng: 153.5352 } },
      { key: 'tweed river high school', sector: 'Public', sectorGroup: 'public', rating: 'Above Average', rankLabel: 'Above Average', rankingScore: 86, starRating: 4.4, coords: { lat: -28.1778, lng: 153.5386 } },
      { key: "st joseph's college banora point", sector: 'Catholic', sectorGroup: 'catholic', rating: 'Above Average', rankLabel: 'Above Average', rankingScore: 81, starRating: 4.1, coords: { lat: -28.2124, lng: 153.5369 } }
    ]
  };
}

function getLifestyleSchoolHints(locationContext) {
  const suburb = normalizeCareerHeroCityKey(locationContext && locationContext.suburb);
  if (suburb === 'tweed_heads' || suburb === 'tweed_heads_south') return buildTweedSchoolHints();
  return { primary: [], secondary: [] };
}

function normalizeLifestyleSchoolEntry(source, phase, practiceCoords, hints = {}, eligibilityByListing = {}) {
  const name = String(pickFirstDefined(source && source.school_name, source && source.name) || '').trim();
  if (!name) return null;
  const hintKey = normalizeCareerHeroCityKey(name);
  const hint = Array.isArray(hints[phase])
    ? hints[phase].find((item) => hintKey.includes(normalizeCareerHeroCityKey(item.key)))
    : null;
  const coords = buildLifestyleCoordinate(
    pickFirstDefined(source && source.latitude, hint && hint.coords && hint.coords.lat),
    pickFirstDefined(source && source.longitude, hint && hint.coords && hint.coords.lng)
  );
  const distanceKm = Number.isFinite(Number(source && source.distance_km))
    ? Number(source.distance_km)
    : (coords && practiceCoords ? calculateDistanceKm(practiceCoords, coords) : null);
  return {
    id: String(pickFirstDefined(source && source.school_code, source && source.id, hintKey || crypto.randomUUID())),
    name,
    sector: String(pickFirstDefined(source && source.sector, hint && hint.sector) || 'Public'),
    sectorGroup: String(pickFirstDefined(source && source.sectorGroup, hint && hint.sectorGroup) || 'public'),
    distanceKm: distanceKm ? Number(distanceKm.toFixed(1)) : 0,
    driveTime: formatLifestyleDriveTime(distanceKm || 0),
    rating: String(pickFirstDefined(source && source.rating, source && source.rating_label, hint && hint.rating) || (phase === 'secondary' ? 'ATAR data pending' : 'Primary catchment option')),
    rankLabel: String(pickFirstDefined(source && source.rankLabel, hint && hint.rankLabel) || ''),
    rankingScore: Number(pickFirstDefined(source && source.rankingScore, source && source.atar_rank, hint && hint.rankingScore) || 0) || 0,
    starRating: Number(pickFirstDefined(source && source.starRating, hint && hint.starRating) || 0) || 0,
    lat: coords ? coords.lat : null,
    lng: coords ? coords.lng : null,
    eligibilityByListing,
    eligibilityLabel: String(pickFirstDefined(source && source.eligibilityLabel, hint && hint.eligibilityLabel) || ''),
    eligibilityTone: String(pickFirstDefined(source && source.eligibilityTone, hint && hint.eligibilityTone) || '')
  };
}

async function buildLifestyleSchools(practiceCoords, housingByMarket, locationContext) {
  const hints = getLifestyleSchoolHints(locationContext);
  const listingPool = []
    .concat(Array.isArray(housingByMarket.rent) ? housingByMarket.rent : [])
    .concat(Array.isArray(housingByMarket.buy) ? housingByMarket.buy : []);
  const listingSubset = listingPool.slice(0, 6);

  const phases = ['primary', 'secondary'];
  const output = {
    defaultPhase: 'all',
    defaultSector: 'all',
    primary: [],
    secondary: []
  };

  for (const phase of phases) {
    const nearbyRows = await fetchNearbyPublicSchools(practiceCoords, phase, 8);
    const bySchoolId = new Map();

    nearbyRows.forEach((row) => {
      const normalized = normalizeLifestyleSchoolEntry(row, phase, practiceCoords, hints, {});
      if (normalized) bySchoolId.set(normalized.id, normalized);
    });

    for (const listing of listingSubset) {
      const catchmentRows = await fetchCatchmentSchoolsForListing(listing, phase);
      catchmentRows.forEach((row) => {
        const schoolId = String(row && row.school_code || '').trim();
        if (!schoolId) return;
        const existing = bySchoolId.get(schoolId) || normalizeLifestyleSchoolEntry(row, phase, practiceCoords, hints, {});
        if (!existing) return;
        existing.eligibilityByListing = {
          ...(existing.eligibilityByListing || {}),
          [listing.id]: 'catchment'
        };
        bySchoolId.set(schoolId, existing);
      });
    }

    if (Array.isArray(hints[phase])) {
      hints[phase].forEach((hint) => {
        const existingByName = Array.from(bySchoolId.values()).find((item) => normalizeCareerHeroCityKey(item && item.name) === normalizeCareerHeroCityKey(hint.key));
        if (existingByName) {
          existingByName.sector = existingByName.sector || hint.sector;
          existingByName.sectorGroup = existingByName.sectorGroup || hint.sectorGroup;
          existingByName.rating = existingByName.rating && !/pending/i.test(existingByName.rating) ? existingByName.rating : hint.rating;
          existingByName.rankLabel = existingByName.rankLabel || hint.rankLabel || '';
          existingByName.rankingScore = Number(existingByName.rankingScore || 0) || Number(hint.rankingScore || 0) || 0;
          existingByName.starRating = Number(existingByName.starRating || 0) || Number(hint.starRating || 0) || 0;
          existingByName.eligibilityLabel = existingByName.eligibilityLabel || hint.eligibilityLabel || '';
          existingByName.eligibilityTone = existingByName.eligibilityTone || hint.eligibilityTone || '';
          return;
        }
        const synthetic = normalizeLifestyleSchoolEntry({
          id: hint.key,
          name: hint.key.replace(/\b\w/g, (part) => part.toUpperCase()),
          sector: hint.sector,
          sectorGroup: hint.sectorGroup,
          rating: hint.rating,
          rankLabel: hint.rankLabel,
          rankingScore: hint.rankingScore,
          starRating: hint.starRating,
          latitude: hint.coords && hint.coords.lat,
          longitude: hint.coords && hint.coords.lng,
          eligibilityLabel: hint.eligibilityLabel,
          eligibilityTone: hint.eligibilityTone
        }, phase, practiceCoords, hints, {});
        if (!synthetic || bySchoolId.has(synthetic.id)) return;
        bySchoolId.set(synthetic.id, synthetic);
      });
    }

    output[phase] = Array.from(bySchoolId.values())
      .sort((left, right) => {
        if (right.rankingScore !== left.rankingScore) return right.rankingScore - left.rankingScore;
        return left.distanceKm - right.distanceKm;
      })
      .slice(0, 8);
  }

  return output;
}

function buildLifestyleFlights(practiceCoords, locationContext) {
  const suburb = normalizeCareerHeroCityKey(locationContext && locationContext.suburb);
  const tweedDestinations = [
    { id: 'ool', name: 'Gold Coast Airport (OOL)', type: 'airport', coords: { lat: -28.1644, lng: 153.5052 } },
    { id: 'bne', name: 'Brisbane Airport (BNE)', type: 'airport', coords: { lat: -27.3842, lng: 153.1175 } },
    { id: 'surfers', name: 'Surfers Paradise', type: 'destination', coords: { lat: -28.0021, lng: 153.4303 } },
    { id: 'byron', name: 'Byron Bay', type: 'destination', coords: { lat: -28.6474, lng: 153.6020 } }
  ];
  const genericDestinations = [
    { id: 'airport', name: 'Nearest Airport', type: 'airport', coords: offsetCoordinate(practiceCoords, 0.045, -0.02) },
    { id: 'capital', name: 'Capital city connector', type: 'airport', coords: offsetCoordinate(practiceCoords, 0.35, 0.22) },
    { id: 'coast', name: 'Coastal lifestyle hub', type: 'destination', coords: offsetCoordinate(practiceCoords, 0.11, -0.14) },
    { id: 'regional', name: 'Regional family base', type: 'destination', coords: offsetCoordinate(practiceCoords, -0.12, 0.1) }
  ];
  const destinations = suburb === 'tweed_heads' ? tweedDestinations : genericDestinations;
  return destinations.map((item) => {
    const coords = buildLifestyleCoordinate(item.coords && item.coords.lat, item.coords && item.coords.lng);
    const distanceKm = coords ? calculateDistanceKm(practiceCoords, coords) : null;
    const minutes = Math.max(12, Math.round((distanceKm || 12) * (item.type === 'airport' ? 1.05 : 1.1)));
    return {
      id: item.id,
      name: item.name,
      distanceLabel: distanceKm ? formatDistanceKm(distanceKm) : '',
      travelTime: minutes >= 60
        ? `${Math.floor(minutes / 60)}h ${minutes % 60} min`
        : `${minutes} min`,
      type: item.type,
      lat: coords ? coords.lat : null,
      lng: coords ? coords.lng : null
    };
  });
}

async function resolvePracticeLifestylePayload({ applicationId, practiceName, location, roleRow, profile }) {
  const household = deriveCareerLifestyleHousehold(profile || {});
  const cacheKey = buildCareerLifestyleCacheKey(applicationId, practiceName, location, household);
  const cached = await getRuntimeKv(cacheKey);
  if (cached && cached.value && typeof cached.value === 'object' && cached.value.status === 'ready' && cached.value.payload) {
    const hydratedCachedPayload = hydrateCareerLifestylePayload(cached.value.payload);
    if (JSON.stringify(hydratedCachedPayload) !== JSON.stringify(cached.value.payload)) {
      await setRuntimeKv(cacheKey, {
        status: 'ready',
        payload: hydratedCachedPayload
      }, Date.now() + CAREER_LIFESTYLE_CACHE_TTL_MS);
    }
    return hydratedCachedPayload;
  }

  const roleMeta = getCareerRoleGpLinkMeta(roleRow);
  const baseLocationContext = buildLifestyleLocationContext(location, roleMeta, roleRow);
  const geocoded = await resolveCareerSuburbCoordinates({
    suburb: baseLocationContext.suburb || (roleMeta && roleMeta.suburb) || '',
    state: roleRow && roleRow.location_state ? roleRow.location_state : baseLocationContext.state,
    country: roleRow && roleRow.location_country ? roleRow.location_country : baseLocationContext.country
  });
  const locationSuburbKey = normalizeCareerHeroCityKey(baseLocationContext.suburb);
  const practiceCoords = buildLifestyleCoordinate(geocoded && geocoded.latitude, geocoded && geocoded.longitude)
    || ((locationSuburbKey === 'tweed_heads' || locationSuburbKey === 'tweed_heads_south') ? { lat: -28.1883, lng: 153.5375 } : null);
  const locationContext = await enrichLifestyleLocationContextForHomely(baseLocationContext, practiceCoords);
  const homelyLocation = await resolveHomelyLifestyleLocation(locationContext) || locationContext;
  const [liveRentListings, liveBuyListings] = await Promise.all([
    fetchHomelyLifestyleListings(homelyLocation, practiceCoords, 'rent', household, {
      radiusKm: DOMAIN_LIFESTYLE_MAX_RADIUS_KM
    }),
    fetchHomelyLifestyleListings(homelyLocation, practiceCoords, 'buy', household, {
      radiusKm: DOMAIN_LIFESTYLE_MAX_RADIUS_KM
    })
  ]);

  const housingByMarket = {
    rent: liveRentListings,
    buy: liveBuyListings
  };
  const housingSources = {
    rent: liveRentListings.length ? 'homely' : 'none',
    buy: liveBuyListings.length ? 'homely' : 'none'
  };

  const schools = practiceCoords
    ? await buildLifestyleSchools(practiceCoords, housingByMarket, locationContext)
    : { defaultPhase: 'all', defaultSector: 'all', primary: [], secondary: [] };
  const flights = practiceCoords ? buildLifestyleFlights(practiceCoords, locationContext) : [];

  const payload = hydrateCareerLifestylePayload({
    key: normalizeCareerHeroCityKey(`${locationContext.suburb}-${locationContext.state}`) || 'practice_lifestyle',
    practiceLabel: practiceName || locationContext.label || location || '',
    heading: 'Relocation Explorer',
    intro: `Explore live homes and nearby schools around ${practiceName || 'the practice'} before you relocate.`,
    title: locationContext.label || location || practiceName,
    subtitle: `Live homes, schools and travel around ${practiceName || 'the practice'}`,
    map: {
      center: practiceCoords,
      zoom: 12,
      googleMaps: getCareerLifestyleGoogleMapsPayload()
    },
    housing: {
      defaultMode: 'rent',
      defaultRadiusKm: 25,
      recommendedBedrooms: household.recommendedBedrooms,
      partySummary: household.partySummary,
      liveSource: 'homely',
      liveEnabled: true,
      fallbackEnabled: false,
      selectedAgencyBrands: [],
      searchContext: homelyLocation,
      sources: housingSources,
      viewAllRentUrl: buildHomelyLifestyleSearchUrl(homelyLocation, 'rent'),
      viewAllBuyUrl: buildHomelyLifestyleSearchUrl(homelyLocation, 'buy'),
      rent: housingByMarket.rent,
      buy: housingByMarket.buy
    },
    schools,
    flights
  });

  await setRuntimeKv(cacheKey, {
    status: 'ready',
    payload
  }, Date.now() + CAREER_LIFESTYLE_CACHE_TTL_MS);

  return payload;
}

const BUILD_PRACTICE_CONTACT_FALLBACKS = {
  '11734000000934182': {
    name: 'Khaleed Mahmoud',
    role: 'Medical centre contact',
    phone: '+61 406 281 243',
    email: 'khaleedmahmoud1211@gmail.com',
    whatsapp: '+61406281243'
  }
};

function buildPlacementFallbackPracticeContact(jobOpeningRecord, fallbackPracticeName, providerRoleId) {
  const seeded = BUILD_PRACTICE_CONTACT_FALLBACKS[String(providerRoleId || '').trim()] || null;
  const name = getZohoField(jobOpeningRecord, ['Contact_Name']) || (seeded && seeded.name) || `${String(fallbackPracticeName || '').trim() || 'Medical Centre'} Team`;
  return {
    name,
    initials: buildInitials(name),
    role: (seeded && seeded.role) || 'Medical centre contact',
    meta: seeded ? 'Reach out directly to the practice' : 'Direct contact details will appear here once synced',
    phone: seeded && seeded.phone ? seeded.phone : '',
    email: seeded && seeded.email ? seeded.email : '',
    whatsapp: seeded && seeded.whatsapp ? seeded.whatsapp : ((seeded && seeded.phone) || '')
  };
}

function buildPracticeContactPayload(contactRecord, fallbackPracticeName) {
  const name = buildZohoDisplayName(contactRecord) || `${String(fallbackPracticeName || '').trim() || 'Medical Centre'} Team`;
  const email = getZohoField(contactRecord, ['Email', 'Secondary_Email']);
  const phone = choosePreferredZohoPhone(contactRecord);
  return {
    name,
    initials: buildInitials(name),
    role: getZohoField(contactRecord, ['Designation', 'Title', 'Role']) || 'Medical centre contact',
    meta: 'Reach out directly to the practice',
    phone,
    email,
    whatsapp: getZohoField(contactRecord, ['Mobile', 'Phone']) || phone
  };
}

async function buildCareerPlacementPayload({
  zoho,
  applicationRecord,
  roleRow,
  jobOpeningRecord,
  startDateIso,
  practiceContacts,
  providerRoleId,
  profile
}) {
  const practiceName = getZohoApplicationPracticeName(applicationRecord)
    || getZohoField(jobOpeningRecord, ['Posting_Title', 'Job_Opening_Name', 'Title'])
    || (roleRow && roleRow.practice_name)
    || 'Medical Centre';
  const roleTitle = derivePlacementRoleTitle(roleRow, jobOpeningRecord, practiceName);
  const location = getZohoPlacementLocation(jobOpeningRecord, roleRow);
  const contractTerms = applicationRecord ? await resolveCareerContractTerms(zoho, sanitizeZohoText(applicationRecord.id)) : null;
  const fallbackTerms = extractPlacementTermsFromJobOpening(jobOpeningRecord, roleRow);
  const billingLabel = normalizeCareerBillingLabel(getZohoField(jobOpeningRecord, ['Billing_Model', 'Billing_Type', 'Remuneration_Model', 'Fee_Model', 'Billing']))
    || normalizeCareerBillingLabel(roleRow && roleRow.billing_model)
    || 'Billing pending';
  const splitDisplay = (contractTerms && contractTerms.splitDisplay) || fallbackTerms.splitDisplay || 'Pending';
  const relocationDisplay = (contractTerms && contractTerms.relocationPackageDisplay) || fallbackTerms.relocationPackageDisplay || 'Pending';
  const contractLengthDisplay = (contractTerms && contractTerms.contractLengthDisplay) || fallbackTerms.contractLengthDisplay || 'Pending';
  const roleClient = roleRow ? mapCareerRoleRowToClient(roleRow) : null;
  const practiceContactRecord = Array.isArray(practiceContacts) && practiceContacts.length > 0
    ? practiceContacts.slice().sort(sortZohoRecordsByRecent)[0]
    : null;
  const practiceContact = practiceContactRecord
    ? buildPracticeContactPayload(practiceContactRecord, practiceName)
    : buildPlacementFallbackPracticeContact(jobOpeningRecord, practiceName, providerRoleId);
  const resolvedStartDateIso = getPlacementStartDate(startDateIso, applicationRecord, jobOpeningRecord, roleRow);
  const lifestyle = await resolvePracticeLifestylePayload({
    applicationId: sanitizeZohoText(applicationRecord && applicationRecord.id),
    practiceName,
    location,
    roleRow,
    profile
  });

  return {
    practiceName,
    roleTitle,
    location,
    statusLabel: 'Placement confirmed',
    startDateIso: resolvedStartDateIso,
    quickStats: [
      { label: 'Billing', value: billingLabel.replace(/\s+Billing$/i, '') || billingLabel },
      { label: 'Split', value: splitDisplay },
      { label: 'Relocation Package', value: relocationDisplay }
    ],
    story: {
      title: location.replace(/,\s*Australia\s*$/i, ''),
      text: (roleRow && roleRow.summary) || (roleClient && roleClient.summary) || 'Your medical centre placement is now secured.',
      imageUrl: roleClient && roleClient.heroImageUrl ? roleClient.heroImageUrl : '',
      mapQuery: roleClient && roleClient.mapQuery ? roleClient.mapQuery : location
    },
    lifestyle,
    practiceContact,
    compensation: {
      range: '$2,500-$3,500',
      unit: 'Per Day',
      note: 'Expected income',
      facts: [
        { label: 'Billing type', value: billingLabel || 'Pending' },
        { label: 'Billing split', value: splitDisplay || 'Pending' },
        { label: 'Relocation package', value: relocationDisplay || 'Pending' },
        {
          label: 'Contract length',
          value: contractLengthDisplay
        }
      ]
    }
  };
}

async function fetchZohoRecruitCareerApplicationsForUser(zoho, email, zohoCandidateId, localApplications) {
  if (!zoho) return [];
  const canSearchApplications = doesZohoRecruitScopeGrant(
    'ZohoRecruit.search.READ',
    zoho.connection && Array.isArray(zoho.connection.scopes) ? zoho.connection.scopes : []
  );

  const liveById = new Map();
  const localIds = Array.isArray(localApplications)
    ? localApplications
      .map((item) => String(item && item.zoho_application_id || '').trim())
      .filter(Boolean)
    : [];

  const directRecords = await Promise.all(localIds.map((id) => fetchZohoRecruitApplicationRecord(zoho, id)));
  directRecords.filter(Boolean).forEach((record) => {
    const id = sanitizeZohoText(record.id);
    if (id) liveById.set(id, record);
  });

  if (canSearchApplications) {
    const searchedByEmail = await searchZohoRecruitApplicationsByEmail(zoho, email);
    searchedByEmail.forEach((record) => {
      const id = sanitizeZohoText(record.id);
      if (id && !liveById.has(id)) liveById.set(id, record);
    });

    if (liveById.size === 0 && zohoCandidateId) {
      const searchedByCandidate = await searchZohoRecruitApplicationsByCandidateId(zoho, zohoCandidateId);
      searchedByCandidate.forEach((record) => {
        const id = sanitizeZohoText(record.id);
        if (id && !liveById.has(id)) liveById.set(id, record);
      });
    }
  }

  return Array.from(liveById.values()).sort(sortZohoRecordsByRecent);
}

function mergeCareerApplications(localApplications, liveApplications) {
  const locals = Array.isArray(localApplications) ? localApplications : [];
  const lives = Array.isArray(liveApplications) ? liveApplications : [];
  const liveByZohoId = new Map();
  const liveByRoleId = new Map();

  lives.forEach((record) => {
    const appId = sanitizeZohoText(record.id);
    const roleId = getZohoApplicationJobOpeningId(record);
    if (appId) liveByZohoId.set(appId, record);
    if (roleId && !liveByRoleId.has(roleId)) liveByRoleId.set(roleId, record);
  });

  const consumedLiveIds = new Set();
  const merged = locals.map((localApp) => {
    let liveRecord = null;
    const zohoAppId = String(localApp && localApp.zoho_application_id || '').trim();
    const providerRoleId = String(localApp && localApp.provider_role_id || '').trim();
    if (zohoAppId && liveByZohoId.has(zohoAppId)) {
      liveRecord = liveByZohoId.get(zohoAppId) || null;
    } else if (providerRoleId && liveByRoleId.has(providerRoleId)) {
      liveRecord = liveByRoleId.get(providerRoleId) || null;
    }
    if (liveRecord && sanitizeZohoText(liveRecord.id)) consumedLiveIds.add(sanitizeZohoText(liveRecord.id));
    return { localApp, liveRecord };
  });

  lives.forEach((record) => {
    const liveId = sanitizeZohoText(record.id);
    if (!liveId || consumedLiveIds.has(liveId)) return;
    merged.push({ localApp: null, liveRecord: record });
  });

  return merged.sort((left, right) => {
    const leftDate = Date.parse(
      (left.localApp && left.localApp.applied_at)
      || getZohoField(left.liveRecord, ['Modified_Time', 'Updated_On', 'Created_Time'])
      || ''
    ) || 0;
    const rightDate = Date.parse(
      (right.localApp && right.localApp.applied_at)
      || getZohoField(right.liveRecord, ['Modified_Time', 'Updated_On', 'Created_Time'])
      || ''
    ) || 0;
    return rightDate - leftDate;
  });
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

async function pushVisaNotificationToOwner(caseId, notification) {
  if (!caseId) return;
  try {
    const caseRes = await supabaseDbRequest('visa_applications', `select=user_id&id=eq.${encodeURIComponent(caseId)}&limit=1`);
    if (!caseRes.ok || !Array.isArray(caseRes.data) || caseRes.data.length === 0) return;
    const userId = caseRes.data[0].user_id;
    if (!userId) return;
    const stateRes = await supabaseDbRequest('user_state', `select=state,updated_at&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    const row = stateRes.ok && Array.isArray(stateRes.data) && stateRes.data.length > 0 ? stateRes.data[0] : null;
    const state = (row && row.state && typeof row.state === 'object') ? { ...row.state } : {};
    const updates = Array.isArray(state.gp_link_updates) ? [...state.gp_link_updates] : [];
    updates.unshift({ type: notification.type || 'info', title: notification.title || 'Visa update', detail: notification.detail || '', ts: Date.now() });
    if (updates.length > 50) updates.length = 50;
    state.gp_link_updates = updates;
    await upsertSupabaseUserState(userId, state, new Date().toISOString());
  } catch (_) { /* non-critical */ }
}

async function pushPbsNotificationToOwner(appId, notification) {
  if (!appId) return;
  try {
    const appRes = await supabaseDbRequest('pbs_applications', `select=user_id&id=eq.${encodeURIComponent(appId)}&limit=1`);
    if (!appRes.ok || !Array.isArray(appRes.data) || appRes.data.length === 0) return;
    const userId = appRes.data[0].user_id;
    if (!userId) return;
    const stateRes = await supabaseDbRequest('user_state', `select=state,updated_at&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    const row = stateRes.ok && Array.isArray(stateRes.data) && stateRes.data.length > 0 ? stateRes.data[0] : null;
    const state = (row && row.state && typeof row.state === 'object') ? { ...row.state } : {};
    const updates = Array.isArray(state.gp_link_updates) ? [...state.gp_link_updates] : [];
    updates.unshift({ type: notification.type || 'info', title: notification.title || 'PBS & Medicare', detail: notification.detail || '', ts: Date.now() });
    if (updates.length > 50) updates.length = 50;
    state.gp_link_updates = updates;
    await upsertSupabaseUserState(userId, state, new Date().toISOString());
  } catch (_) { /* non-critical */ }
}

async function pushCareerNotificationToUser(userId, notification) {
  if (!isSupabaseDbConfigured() || !userId) return;
  try {
    const stateResult = await supabaseDbRequest('user_state', `select=state&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    const currentState = stateResult.ok && Array.isArray(stateResult.data) && stateResult.data[0] && typeof stateResult.data[0].state === 'object'
      ? stateResult.data[0].state
      : {};
    const updates = Array.isArray(currentState.gp_link_updates) ? currentState.gp_link_updates : [];
    const entry = {
      id: 'career_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      type: notification.type || 'info',
      title: notification.title || 'Career Update',
      body: notification.body || '',
      ts: new Date().toISOString(),
      category: 'career'
    };
    updates.unshift(entry);
    if (updates.length > 50) updates.length = 50;
    const nextState = { ...currentState, gp_link_updates: updates };
    await supabaseDbRequest('user_state', `user_id=eq.${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: { state: nextState }
    });
  } catch {}
}

function mapSupabaseProfileRowToApiProfile(row, email) {
  const phone = row.phone || [row.country_dial || '', row.phone_number || ''].filter(Boolean).join(' ').trim();
  return {
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    email: row.email || email,
    phone,
    registrationNumber: row.registration_number || '',
    gmcNumber: row.gmc_number || '',
    specialistCountry: row.registration_country || '',
    hasPassword: true,
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

function filterUserStateForClient(source) {
  const filtered = {};
  const state = source && typeof source === 'object' ? source : {};
  for (const key of USER_STATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(state, key)) {
      filtered[key] = state[key];
    }
  }
  return filtered;
}

function buildFallbackApiProfile(email, sessionProfile = null) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const stored = dbState.userProfiles[normalizedEmail] || {};
  const user = dbState.users[normalizedEmail] || {};
  const sessionData = sessionProfile && typeof sessionProfile === 'object' ? sessionProfile : {};
  const phone = stored.phone || [
    sessionData.countryDial || user.countryDial || '',
    sessionData.phoneNumber || user.phoneNumber || ''
  ].filter(Boolean).join(' ').trim();

  return {
    firstName: stored.firstName || user.firstName || sessionData.firstName || '',
    lastName: stored.lastName || user.lastName || sessionData.lastName || '',
    email: stored.email || user.email || sessionData.email || normalizedEmail,
    phone,
    registrationNumber: stored.registrationNumber || '',
    gmcNumber: stored.gmcNumber || '',
    specialistCountry: user.registrationCountry || stored.specialistCountry || sessionData.registrationCountry || '',
    hasPassword: true,
    profilePhotoName: stored.profilePhotoName || '',
    profilePhotoDataUrl: stored.profilePhotoDataUrl || '',
    idCopyName: stored.idCopyName || '',
    idCopyDataUrl: stored.idCopyDataUrl || '',
    cvFileName: stored.cvFileName || '',
    updatedAt: stored.updatedAt || null
  };
}

function buildBootstrapProfilePayload(profile) {
  const source = profile && typeof profile === 'object' ? profile : {};
  return {
    ...source,
    profilePhotoDataUrl: '',
    idCopyDataUrl: ''
  };
}

async function buildAuthBootstrapForEmail(email, options = {}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const sessionUserId = String(options.sessionUserId || '').trim() || null;
  const sessionProfile = options.sessionProfile && typeof options.sessionProfile === 'object'
    ? options.sessionProfile
    : null;

  if (!normalizedEmail) {
    return {
      sessionProfile,
      state: {},
      stateUpdatedAt: null,
      profile: buildBootstrapProfilePayload(buildFallbackApiProfile('', sessionProfile)),
      accountStatus: 'active',
      cachedAt: new Date().toISOString()
    };
  }

  let profile = buildFallbackApiProfile(normalizedEmail, sessionProfile);
  let filteredState = {};
  let stateUpdatedAt = null;
  let accountStatus = 'active';

  if (isSupabaseDbConfigured()) {
    const [remoteState, remoteProfile] = await Promise.all([
      getSupabaseUserStateByEmail(normalizedEmail),
      getSupabaseUserProfile(normalizedEmail, sessionUserId)
    ]);
    if (remoteState && remoteState.state && typeof remoteState.state === 'object') {
      filteredState = filterUserStateForClient(remoteState.state);
      stateUpdatedAt = remoteState.updatedAt || null;
      if (typeof remoteState.state.account_status === 'string' && remoteState.state.account_status.trim()) {
        accountStatus = remoteState.state.account_status.trim();
      }
    }
    if (remoteProfile) {
      profile = mapSupabaseProfileRowToApiProfile(remoteProfile, normalizedEmail);
    }
  } else {
    const localState = dbState.userState[normalizedEmail] && typeof dbState.userState[normalizedEmail] === 'object'
      ? dbState.userState[normalizedEmail]
      : {};
    filteredState = filterUserStateForClient(localState);
    stateUpdatedAt = typeof localState.updatedAt === 'string' ? localState.updatedAt : null;
    if (typeof localState.account_status === 'string' && localState.account_status.trim()) {
      accountStatus = localState.account_status.trim();
    }
  }

  return {
    sessionProfile,
    state: filteredState,
    stateUpdatedAt,
    profile: buildBootstrapProfilePayload(profile),
    accountStatus,
    cachedAt: new Date().toISOString()
  };
}

function getWarmAuthBootstrap(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;
  const cached = _authBootstrapWarmCache.get(normalizedEmail);
  if (!cached) return null;
  if (Number(cached.expiresAt || 0) <= Date.now()) {
    _authBootstrapWarmCache.delete(normalizedEmail);
    return null;
  }
  return cached.value && typeof cached.value === 'object' ? cached.value : null;
}

function setWarmAuthBootstrap(email, bootstrap) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !bootstrap || typeof bootstrap !== 'object') return;
  _authBootstrapWarmCache.set(normalizedEmail, {
    expiresAt: Date.now() + AUTH_BOOTSTRAP_CACHE_TTL_MS,
    value: bootstrap
  });
}

function queueAuthBootstrapWarm(email, options = {}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !isValidEmail(normalizedEmail)) return Promise.resolve(null);

  const cached = getWarmAuthBootstrap(normalizedEmail);
  if (cached) {
    return Promise.resolve({
      ...cached,
      sessionProfile: options.sessionProfile || cached.sessionProfile || null
    });
  }

  if (_authBootstrapInFlight.has(normalizedEmail)) {
    return _authBootstrapInFlight.get(normalizedEmail);
  }

  const inFlight = buildAuthBootstrapForEmail(normalizedEmail, options)
    .then((bootstrap) => {
      if (bootstrap) setWarmAuthBootstrap(normalizedEmail, bootstrap);
      return bootstrap;
    })
    .catch(() => null)
    .finally(() => {
      _authBootstrapInFlight.delete(normalizedEmail);
    });

  _authBootstrapInFlight.set(normalizedEmail, inFlight);
  return inFlight;
}

async function resolveAuthBootstrap(email, options = {}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const sessionProfile = options.sessionProfile && typeof options.sessionProfile === 'object'
    ? options.sessionProfile
    : null;

  const cached = getWarmAuthBootstrap(normalizedEmail);
  if (cached) {
    const merged = { ...cached, sessionProfile: sessionProfile || cached.sessionProfile || null };
    setWarmAuthBootstrap(normalizedEmail, merged);
    return merged;
  }

  const warmed = await queueAuthBootstrapWarm(normalizedEmail, options);
  if (warmed) {
    const merged = { ...warmed, sessionProfile: sessionProfile || warmed.sessionProfile || null };
    setWarmAuthBootstrap(normalizedEmail, merged);
    return merged;
  }

  return buildAuthBootstrapForEmail(normalizedEmail, options);
}

function resolveFastAuthBootstrap(email, options = {}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const sessionProfile = options.sessionProfile && typeof options.sessionProfile === 'object'
    ? options.sessionProfile
    : null;

  if (!normalizedEmail) {
    return { bootstrap: null, bootstrapPending: false };
  }

  const cached = getWarmAuthBootstrap(normalizedEmail);
  if (cached) {
    const merged = { ...cached, sessionProfile: sessionProfile || cached.sessionProfile || null };
    setWarmAuthBootstrap(normalizedEmail, merged);
    return { bootstrap: merged, bootstrapPending: false };
  }

  queueAuthBootstrapWarm(normalizedEmail, options).catch(() => {});
  return { bootstrap: null, bootstrapPending: true };
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

function getSessionProfileFromSupabaseUser(supaUser, fallbackEmail = '') {
  const email = String(
    (supaUser && typeof supaUser.email === 'string' && supaUser.email) || fallbackEmail || ''
  ).trim().toLowerCase();
  const metadata = supaUser && supaUser.user_metadata && typeof supaUser.user_metadata === 'object'
    ? supaUser.user_metadata
    : {};
  return {
    firstName: String(metadata.firstName || metadata.given_name || '').trim(),
    lastName: String(metadata.lastName || metadata.family_name || '').trim(),
    email,
    supabaseUserId: String((supaUser && supaUser.id) || '').trim(),
    countryDial: String(metadata.countryDial || '').trim(),
    phoneNumber: String(metadata.phoneNumber || '').trim(),
    registrationCountry: String(metadata.registrationCountry || '').trim()
  };
}

// Ensure a user_profiles row exists in Supabase for a newly authenticated user.
// Called after signup/login to guarantee that state, profile, and onboarding
// endpoints can resolve the user ID.
async function ensureSupabaseUserProfile(supaUser) {
  if (!isSupabaseDbConfigured()) return;
  const supabaseUserId = String(supaUser && supaUser.id ? supaUser.id : '').trim();
  const email = String(supaUser && supaUser.email ? supaUser.email : '').trim().toLowerCase();
  if (!supabaseUserId || !email) return;

  // Check if row already exists
  const existing = await supabaseDbRequest(
    'user_profiles',
    `select=user_id&user_id=eq.${encodeURIComponent(supabaseUserId)}&limit=1`
  );
  if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) return;

  const meta = supaUser && typeof supaUser.user_metadata === 'object' && supaUser.user_metadata
    ? supaUser.user_metadata
    : {};
  const payload = {
    user_id: supabaseUserId,
    email,
    first_name: String(meta.firstName || meta.given_name || '').trim(),
    last_name: String(meta.lastName || meta.family_name || '').trim(),
    country_dial: String(meta.countryDial || '').trim(),
    phone_number: String(meta.phoneNumber || '').trim(),
    registration_country: String(meta.registrationCountry || '').trim(),
    updated_at: new Date().toISOString()
  };

  await supabaseDbRequest('user_profiles', 'on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: [payload]
  });
}

function upsertLocalUserFromSupabaseUser(supaUser) {
  const email = String(supaUser && supaUser.email ? supaUser.email : '').trim().toLowerCase();
  if (!email) return null;
  if (isSupabaseDbConfigured()) return email;
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

/* ───────── Zoom Server-to-Server OAuth ───────── */

function isZoomConfigured() {
  return !!(process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET && process.env.ZOOM_ACCOUNT_ID);
}

let _zoomAccessToken = '';
let _zoomTokenExpiresAt = 0;

async function getZoomAccessToken() {
  if (_zoomAccessToken && Date.now() < _zoomTokenExpiresAt - 60000) {
    return _zoomAccessToken;
  }
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;
  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const credentials = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const res = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + credentials,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=account_credentials&account_id=' + encodeURIComponent(accountId)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Zoom OAuth failed: ' + res.status + ' ' + text);
  }
  const data = await res.json();
  _zoomAccessToken = data.access_token || '';
  _zoomTokenExpiresAt = Date.now() + ((data.expires_in || 3600) * 1000);
  return _zoomAccessToken;
}

async function createZoomMeeting(options) {
  const token = await getZoomAccessToken();
  const body = {
    topic: options.topic || 'GP Link Interview',
    type: 2, // scheduled meeting
    start_time: options.startTime, // ISO 8601
    duration: options.duration || 30,
    timezone: options.timezone || 'Australia/Sydney',
    settings: {
      host_video: true,
      participant_video: true,
      join_before_host: false,
      waiting_room: true,
      auto_recording: 'none',
      meeting_authentication: false
    }
  };
  const res = await fetch('https://api.zoom.us/v2/users/me/meetings', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Zoom meeting creation failed: ' + res.status + ' ' + text);
  }
  return res.json();
}

async function deleteZoomMeeting(meetingId) {
  const token = await getZoomAccessToken();
  const res = await fetch('https://api.zoom.us/v2/meetings/' + encodeURIComponent(meetingId), {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + token }
  });
  return res.ok;
}

/* ───────── Email via Resend HTTP API ───────── */

function isEmailConfigured() {
  return !!(process.env.RESEND_API_KEY);
}

async function sendEmail({ to, subject, html, text }) {
  if (!isEmailConfigured()) return { ok: false, error: 'Email not configured' };
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'notifications@mygplink.com.au';
  const fromName = process.env.RESEND_FROM_NAME || 'GP Link';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromName + ' <' + fromEmail + '>',
        to: Array.isArray(to) ? to : [to],
        subject: subject,
        html: html || '',
        text: text || ''
      })
    });
    if (!res.ok) return { ok: false, error: 'Resend API error: ' + res.status };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/* ───────── Push notifications via FCM ───────── */

async function sendPushNotification(userId, { title, body, data }) {
  if (!process.env.FCM_SERVER_KEY) return;
  try {
    const stateResult = await supabaseDbRequest('user_state', `select=state&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    const currentState = stateResult.ok && Array.isArray(stateResult.data) && stateResult.data[0] && typeof stateResult.data[0].state === 'object'
      ? stateResult.data[0].state
      : {};
    const pushTokens = Array.isArray(currentState.gp_push_tokens) ? currentState.gp_push_tokens : [];
    if (pushTokens.length === 0) return;

    for (const entry of pushTokens) {
      if (!entry || !entry.token) continue;
      fetch('https://fcm.googleapis.com/fcm/send', {
        method: 'POST',
        headers: {
          'Authorization': 'key=' + process.env.FCM_SERVER_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          to: entry.token,
          notification: { title: title || 'GP Link', body: body || '' },
          data: data || {}
        })
      }).catch(() => {});
    }
  } catch {}
}

function buildCareerEmailHtml({ title, body, ctaText, ctaUrl, footer }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f4fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">
<div style="background:#fff;border-radius:16px;padding:32px;box-shadow:0 4px 16px rgba(2,6,23,0.08)">
<div style="text-align:center;margin-bottom:24px">
<span style="font-size:22px;font-weight:800;color:#0f172a">GP Link</span>
</div>
<h1 style="font-size:20px;font-weight:700;color:#0f172a;margin:0 0 12px">${title || ''}</h1>
<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 24px">${body || ''}</p>
${ctaText && ctaUrl ? '<div style="text-align:center;margin:24px 0"><a href="' + ctaUrl + '" style="display:inline-block;padding:14px 32px;background:#2563eb;color:#fff;font-weight:700;font-size:15px;text-decoration:none;border-radius:12px">' + ctaText + '</a></div>' : ''}
${footer ? '<p style="font-size:13px;color:#64748b;margin:24px 0 0;border-top:1px solid #e2e8f0;padding-top:16px">' + footer + '</p>' : ''}
</div>
<p style="text-align:center;font-size:12px;color:#94a3b8;margin:16px 0 0">GP Link Australia &middot; <a href="https://app.mygplink.com.au" style="color:#64748b">app.mygplink.com.au</a></p>
</div></body></html>`;
}

async function handleApi(req, res, pathname) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

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

  // DoubleTick inbound webhook — external origin, must be before same-origin enforcement
  if (pathname === '/api/webhooks/doubletick' && req.method === 'POST') {
    return handleDoubleTickWebhook(req, res);
  }

  if (!enforceMutationOrigin(req, res)) return;

  if (pathname.startsWith('/api/admin/') && !isAllowedAdminHost(req)) {
    sendJson(res, 404, { ok: false, message: 'Not found' });
    return;
  }

  if (pathname === '/api/auth/prewarm' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 200, { ok: true });
      return;
    }

    const email = String(body && body.email ? body.email : '').trim().toLowerCase();
    if (isValidEmail(email)) {
      const rateKey = `auth:prewarm:${getClientIp(req)}`;
      const allowed = await checkRateLimitWindow(rateKey, AUTH_PREWARM_RATE_MAX, AUTH_RATE_WINDOW_MS);
      if (allowed) {
        queueAuthBootstrapWarm(email).catch(() => {});
      }
    }

    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/auth/send-code' && req.method === 'POST') {
    if (REQUIRE_SUPABASE_DB) {
      sendJson(res, 410, { ok: false, message: 'OTP code auth is disabled. Use email/password or OAuth via Supabase.' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const firstName = sanitizeUserString(body.firstName, 100);
    const lastName = sanitizeUserString(body.lastName, 100);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 320).replace(/[^\w.@+-]/g, '');
    const countryDial = String(body.countryDial || '').trim().replace(/[^+\d]/g, '').slice(0, 6);
    const phoneNumber = String(body.phoneNumber || '').trim().replace(/[^\d\s()-]/g, '').slice(0, 20);
    const registrationCountry = sanitizeUserString(body.registrationCountry, 30);
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
    if (!(await checkRateLimit(rateKey))) {
      sendJson(res, 429, { ok: false, message: 'Too many requests. Please wait and try again.' });
      return;
    }

    const code = String(crypto.randomInt(10000000, 100000000));
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

  // ─── OAuth 2.0 Token Endpoint ───────────────────────────────────────────
  if (pathname === '/api/auth/oauth/token' && req.method === 'POST') {
    if (!(await enforceAuthRateLimit(req, res, 'oauth'))) return;
    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_request', message: 'Invalid request body.' });
      return;
    }

    const grantType = String(body.grant_type || '');
    const useSupabase = isSupabaseConfigured();

    // ── grant_type=signup ──
    if (grantType === 'signup') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const firstName = String(body.firstName || '').trim();
      const lastName = String(body.lastName || '').trim();

      if (!isValidEmail(email)) {
        sendJson(res, 400, { ok: false, error: 'invalid_email', message: 'Please provide a valid email address.' });
        return;
      }
      if (!firstName || !lastName) {
        sendJson(res, 400, { ok: false, error: 'missing_fields', message: 'firstName and lastName are required.' });
        return;
      }
      if (!isStrongPassword(password)) {
        sendJson(res, 400, { ok: false, error: 'weak_password', message: 'Password must be at least 12 characters and include upper, lower, number, and symbol.' });
        return;
      }

      if (useSupabase) {
        // ── Supabase signup path (production) ──
        const signupResult = await supabaseAuthRequest('signup', {
          email,
          password,
          data: { firstName, lastName }
        });
        if (!signupResult.ok) {
          const msg = (signupResult.data && (signupResult.data.msg || signupResult.data.message)) || 'Unable to create account.';
          const isExists = signupResult.status === 422 || (msg && /already registered|already exists/i.test(msg));
          if (isExists) {
            sendJson(res, 409, { ok: false, error: 'account_exists', message: 'An account with this email already exists.' });
          } else {
            sendJson(res, signupResult.status || 400, { ok: false, error: 'signup_failed', message: msg });
          }
          return;
        }

        const signupUser = signupResult.data && signupResult.data.user ? signupResult.data.user : { email };
        upsertLocalUserFromSupabaseUser(signupUser);
        await ensureSupabaseUserProfile(signupUser);

        // Attempt immediate login to get a session
        const loginResult = await supabaseAuthRequest('token?grant_type=password', { email, password });
        if (!loginResult.ok) {
          sendJson(res, 200, { ok: true, requiresConfirmation: true, message: 'Account created. If email confirmation is enabled, verify your inbox before signing in.' });
          return;
        }

        const loginUser = loginResult.data && loginResult.data.user ? loginResult.data.user : signupUser;
        upsertLocalUserFromSupabaseUser(loginUser);
        await ensureSupabaseUserProfile(loginUser);
        const profile = getSessionProfileFromSupabaseUser(loginUser, email);
        const access = createOAuthAccessToken(profile);
        const refreshToken = createOAuthRefreshToken(email);
        setSession(res, profile);
        sendJson(res, 200, { ok: true, token_type: 'Bearer', access_token: access.token, expires_in: access.expiresIn, refresh_token: refreshToken, profile });
        return;
      }

      // ── Local DB signup path (development / tests) ──
      if (dbState.users[email]) {
        sendJson(res, 409, { ok: false, error: 'account_exists', message: 'An account with this email already exists.' });
        return;
      }
      dbState.users[email] = {
        firstName, lastName, email,
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      saveDbState();

      const profile = getSessionProfileFromUser(email);
      const access = createOAuthAccessToken(profile);
      const refreshToken = createOAuthRefreshToken(email);
      setSession(res, profile);
      sendJson(res, 200, { ok: true, token_type: 'Bearer', access_token: access.token, expires_in: access.expiresIn, refresh_token: refreshToken, profile });
      return;
    }

    // ── grant_type=password ──
    if (grantType === 'password') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');

      if (!isValidEmail(email) || !password) {
        sendJson(res, 400, { ok: false, error: 'invalid_request', message: 'Email and password are required.' });
        return;
      }

      if (useSupabase) {
        // ── Supabase login path (production) ──
        const loginResult = await supabaseAuthRequest('token?grant_type=password', { email, password });
        if (!loginResult.ok) {
          sendJson(res, 401, { ok: false, error: 'invalid_credentials', message: 'Invalid email or password.' });
          return;
        }
        const loginUser = loginResult.data && loginResult.data.user ? loginResult.data.user : { email };
        upsertLocalUserFromSupabaseUser(loginUser);
        await ensureSupabaseUserProfile(loginUser);
        const profile = getSessionProfileFromSupabaseUser(loginUser, email);
        const access = createOAuthAccessToken(profile);
        const refreshToken = createOAuthRefreshToken(email);
        setSession(res, profile);
        sendJson(res, 200, { ok: true, token_type: 'Bearer', access_token: access.token, expires_in: access.expiresIn, refresh_token: refreshToken, profile });
        return;
      }

      // ── Local DB login path (development / tests) ──
      const user = dbState.users[email];
      if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
        sendJson(res, 401, { ok: false, error: 'invalid_credentials', message: 'Invalid email or password.' });
        return;
      }

      const profile = getSessionProfileFromUser(email);
      const access = createOAuthAccessToken(profile);
      const refreshToken = createOAuthRefreshToken(email);
      setSession(res, profile);
      sendJson(res, 200, { ok: true, token_type: 'Bearer', access_token: access.token, expires_in: access.expiresIn, refresh_token: refreshToken, profile });
      return;
    }

    // ── grant_type=refresh_token ──
    if (grantType === 'refresh_token') {
      const refreshTokenValue = String(body.refresh_token || '').trim();
      if (!refreshTokenValue) {
        sendJson(res, 400, { ok: false, error: 'invalid_request', message: 'refresh_token is required.' });
        return;
      }

      const entry = consumeOAuthRefreshToken(refreshTokenValue);
      if (!entry) {
        sendJson(res, 401, { ok: false, error: 'invalid_refresh_token', message: 'Refresh token is invalid or expired.' });
        return;
      }

      const profile = getSessionProfileFromUser(entry.email);
      const access = createOAuthAccessToken(profile);
      const newRefreshToken = createOAuthRefreshToken(entry.email);
      setSession(res, profile);
      sendJson(res, 200, { ok: true, token_type: 'Bearer', access_token: access.token, expires_in: access.expiresIn, refresh_token: newRefreshToken, profile });
      return;
    }

    sendJson(res, 400, { ok: false, error: 'unsupported_grant_type', message: 'Supported grant types: password, signup, refresh_token.' });
    return;
  }

  // ─── OAuth 2.0 UserInfo Endpoint ──────────────────────────────────────
  if (pathname === '/api/auth/oauth/userinfo' && req.method === 'GET') {
    const bearer = getBearerToken(req);
    if (!bearer) {
      sendJson(res, 401, { ok: false, error: 'missing_token', message: 'Authorization Bearer token is required.' });
      return;
    }
    const parsed = parseOAuthAccessToken(bearer);
    if (!parsed) {
      sendJson(res, 401, { ok: false, error: 'invalid_token', message: 'Access token is invalid.' });
      return;
    }
    if (parsed.expired) {
      sendJson(res, 401, { ok: false, error: 'token_expired', message: 'Access token has expired. Use refresh_token to obtain a new one.' });
      return;
    }
    sendJson(res, 200, { ok: true, profile: parsed.profile });
    return;
  }

  // ─── OAuth 2.0 Token Revocation ───────────────────────────────────────
  if (pathname === '/api/auth/oauth/revoke' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }
    const tokenValue = String(body.token || '').trim();
    if (tokenValue) revokeOAuthRefreshToken(tokenValue);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/auth/signup' && req.method === 'POST') {
    if (!(await enforceAuthRateLimit(req, res, 'signup'))) return;
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

    const signupUser = signupResult.data && signupResult.data.user ? signupResult.data.user : { email };
    upsertLocalUserFromSupabaseUser(signupUser);
    await ensureSupabaseUserProfile(signupUser);

    const loginResult = await supabaseAuthRequest('token?grant_type=password', { email, password });
    if (!loginResult.ok) {
      sendJson(res, 200, {
        ok: true,
        requiresConfirmation: true,
        message: 'Account created. If email confirmation is enabled, verify your inbox before signing in.'
      });
      return;
    }

    const loginUser = loginResult.data && loginResult.data.user ? loginResult.data.user : signupUser;
    await ensureSupabaseUserProfile(loginUser);
    const sessionProfile = getSessionProfileFromSupabaseUser(loginUser, email);
    setSession(res, sessionProfile);
    const bootstrap = await resolveAuthBootstrap(email, {
      sessionUserId: sessionProfile.supabaseUserId,
      sessionProfile
    });
    sendJson(res, 200, { ok: true, message: 'Account created.', redirectTo: '/pages/index.html', bootstrap });
    return;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    if (!(await enforceAuthRateLimit(req, res, 'login'))) return;
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

    if (isSupabaseConfigured()) {
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

      const loginUser = loginResult.data && loginResult.data.user ? loginResult.data.user : { email };
      upsertLocalUserFromSupabaseUser(loginUser);
      ensureSupabaseUserProfile(loginUser).catch(() => {});
      const sessionProfile = getSessionProfileFromSupabaseUser(loginUser, email);
      setSession(res, sessionProfile);
      const bootstrapResult = resolveFastAuthBootstrap(email, {
        sessionUserId: sessionProfile.supabaseUserId,
        sessionProfile
      });
      sendJson(res, 200, {
        ok: true,
        message: 'Authenticated',
        redirectTo: '/pages/index.html',
        bootstrap: bootstrapResult.bootstrap,
        bootstrapPending: bootstrapResult.bootstrapPending,
        sessionProfile
      });
      return;
    }

    // Local DB login path (development / tests)
    const user = dbState.users[email];
    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      sendJson(res, 401, { ok: false, message: 'Invalid email or password.' });
      return;
    }

    const sessionProfile = getSessionProfileFromUser(email);
    setSession(res, sessionProfile);
    const bootstrapResult = resolveFastAuthBootstrap(email, { sessionProfile });
    sendJson(res, 200, {
      ok: true,
      message: 'Authenticated',
      redirectTo: '/pages/index.html',
      bootstrap: bootstrapResult.bootstrap,
      bootstrapPending: bootstrapResult.bootstrapPending,
      sessionProfile
    });
    return;
  }

  if (pathname === '/api/auth/supabase-session-login' && req.method === 'POST') {
    if (!(await enforceAuthRateLimit(req, res, 'supabase-session-login'))) return;
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
    ensureSupabaseUserProfile(userData).catch(() => {});

    const sessionProfile = getSessionProfileFromSupabaseUser(userData, email);
    setSession(res, sessionProfile);
    const bootstrapResult = resolveFastAuthBootstrap(email, {
      sessionUserId: sessionProfile.supabaseUserId,
      sessionProfile
    });
    sendJson(res, 200, {
      ok: true,
      message: 'Authenticated',
      redirectTo: '/pages/index.html',
      bootstrap: bootstrapResult.bootstrap,
      bootstrapPending: bootstrapResult.bootstrapPending,
      sessionProfile
    });
    return;
  }

  if (pathname === '/api/auth/verify-code' && req.method === 'POST') {
    if (REQUIRE_SUPABASE_DB) {
      sendJson(res, 410, { ok: false, message: 'OTP verification is disabled. Use email/password or OAuth via Supabase.' });
      return;
    }
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

    if (!/^\d{8}$/.test(code)) {
      sendJson(res, 400, { ok: false, message: 'Verification code must be 8 digits.' });
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

    const bootstrap = await resolveAuthBootstrap(userProfile.email, { sessionProfile: userProfile });
    sendJson(res, 200, { ok: true, message: 'Authenticated', redirectTo: '/pages/index.html', bootstrap });
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

  if (pathname === '/api/media-config' && req.method === 'GET') {
    const media = {
      heroDesktopMp4: HERO_DESKTOP_MP4_URL || '/media/videos/gp-link-hero-desktop.mp4',
      heroDesktopWebm: HERO_DESKTOP_WEBM_URL || '',
      heroMobileMp4: HERO_MOBILE_MP4_URL || '/media/videos/gp-link-hero-mobile.mp4',
      heroMobileWebm: HERO_MOBILE_WEBM_URL || ''
    };

    sendJson(res, 200, { ok: true, media });
    return;
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    clearSession(res, req);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/career/roles' && req.method === 'GET') {
    const session = requireSession(req, res);
    if (!session) return;

    // Try direct Zoho fetch with in-memory cache
    const now = Date.now();
    const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    if (_zohoRolesCache && _zohoRolesCache.roles && (now - _zohoRolesCache.ts) < CACHE_TTL) {
      const manualRows = isSupabaseDbConfigured() ? await listCareerRoleRows(true, 'manual') : [];
      sendJson(res, 200, {
        ok: true,
        source: 'zoho-live',
        roles: mergeCareerRoleClientLists(manualRows.map(mapCareerRoleRowToClient), _zohoRolesCache.roles)
      });
      return;
    }

    // Promise coalescing: if another request is already fetching, wait for it
    if (_zohoRolesFetchPromise) {
      try {
        const cachedRoles = await _zohoRolesFetchPromise;
        if (cachedRoles) {
          const manualRows = isSupabaseDbConfigured() ? await listCareerRoleRows(true, 'manual') : [];
          sendJson(res, 200, {
            ok: true,
            source: 'zoho-live',
            roles: mergeCareerRoleClientLists(manualRows.map(mapCareerRoleRowToClient), cachedRoles)
          });
          return;
        }
      } catch {
        // Fall through to DB fallback
      }
    }

    const zoho = await getZohoRecruitAccessTokenAndDomain();
    if (zoho) {
      _zohoRolesFetchPromise = (async () => {
        const allRoles = [];
        for (let page = 1; page <= ZOHO_RECRUIT_SYNC_MAX_PAGES; page++) {
          const result = await fetchZohoRecruitJobOpenings(zoho.connection, zoho.accessToken, zoho.apiDomain, {
            page,
            per_page: ZOHO_RECRUIT_SYNC_PAGE_SIZE
          });
          if (!result.ok) break;
          const records = Array.isArray(result.data && result.data.data) ? result.data.data : [];
          records.forEach((record) => {
            const mapped = buildCareerRoleRecordFromZoho(record, new Date().toISOString());
            if (!mapped) return;
            // Filter out Test jobs and inactive/filled/closed jobs
            if (/test/i.test(mapped.title || '')) return;
            if (!mapped.is_active) return;
            allRoles.push(mapCareerRoleRowToClient(mapped));
          });
          const moreRecords = !!(result.data && result.data.info && result.data.info.more_records);
          if (!moreRecords || records.length === 0) break;
        }
        _zohoRolesCache = { roles: allRoles, ts: Date.now() };
        return allRoles;
      })().catch((err) => {
        return null;
      }).finally(() => {
        _zohoRolesFetchPromise = null;
      });

      try {
        const allRoles = await _zohoRolesFetchPromise;
        if (allRoles) {
          const manualRows = isSupabaseDbConfigured() ? await listCareerRoleRows(true, 'manual') : [];
          sendJson(res, 200, {
            ok: true,
            source: 'zoho-live',
            roles: mergeCareerRoleClientLists(manualRows.map(mapCareerRoleRowToClient), allRoles)
          });
          return;
        }
      } catch {
        // Fall through to DB fallback
      }
    }

    // Fallback to DB if Zoho is not connected or fails
    if (isSupabaseDbConfigured()) {
      const [rows, connection] = await Promise.all([
        listCareerRoleRows(true),
        getZohoRecruitConnection()
      ]);
      sendJson(res, 200, {
        ok: true,
        source: rows.length ? 'supabase' : ((connection && connection.refreshToken) ? 'supabase-empty' : 'fallback'),
        connected: !!(connection && connection.refreshToken),
        lastSyncAt: connection && connection.lastSyncAt ? connection.lastSyncAt : null,
        roles: rows.map(mapCareerRoleRowToClient)
      });
      return;
    }

    sendJson(res, 200, { ok: true, source: 'fallback', roles: [] });
    return;
  }

  if (pathname === '/api/career/role' && req.method === 'GET') {
    const session = requireSession(req, res);
    if (!session) return;
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Career role details require Supabase database configuration.' });
      return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const parsedId = parseCareerRolePublicId(requestUrl.searchParams.get('id') || '');
    if (!parsedId) {
      sendJson(res, 400, { ok: false, message: 'Missing or invalid role id.' });
      return;
    }

    const existingRow = await getCareerRoleRow(parsedId.provider, parsedId.providerRoleId);
    if (!existingRow) {
      sendJson(res, 404, { ok: false, message: 'Career role not found.' });
      return;
    }

    const billingReadyRow = await ensureCareerRoleWebsiteBilling(existingRow);
    const aiReadyRow = await ensureCareerRoleAiProfile(billingReadyRow || existingRow);
    const heroReadyRow = await ensureCareerRoleHeroImage(aiReadyRow || billingReadyRow || existingRow);
    sendJson(res, 200, {
      ok: true,
      role: mapCareerRoleDetailToClient(heroReadyRow || aiReadyRow || billingReadyRow || existingRow)
    });
    return;
  }

  if (pathname === '/api/career/hero-image' && req.method === 'GET') {
    const session = requireSession(req, res);
    if (!session) return;

    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const requestedRoleId = String(requestUrl.searchParams.get('roleId') || '').trim();
    const parsedId = parseCareerRolePublicId(requestedRoleId);

    if (parsedId) {
      const existingRow = await getCareerRoleRow(parsedId.provider, parsedId.providerRoleId);
      if (existingRow) {
        const heroReadyRow = await ensureCareerRoleHeroImage(existingRow);
        const mappedRole = heroReadyRow ? mapCareerRoleRowToClient(heroReadyRow) : null;
        sendJson(res, 200, {
          ok: true,
          heroImageUrl: mappedRole && mappedRole.heroImageUrl ? mappedRole.heroImageUrl : '',
          heroImageSourceUrl: mappedRole && mappedRole.heroImageSourceUrl ? mappedRole.heroImageSourceUrl : '',
          heroImageCredit: mappedRole && mappedRole.heroImageCredit ? mappedRole.heroImageCredit : '',
          status: mappedRole && mappedRole.heroImageUrl ? 'success' : 'unavailable'
        });
        return;
      }
    }

    const resolved = await resolveCareerHeroImageFromContext({
      roleSeed: requestedRoleId,
      suburb: requestUrl.searchParams.get('suburb') || requestUrl.searchParams.get('mapLabel') || '',
      state: requestUrl.searchParams.get('state') || '',
      city: requestUrl.searchParams.get('city') || '',
      country: requestUrl.searchParams.get('country') || '',
      location: requestUrl.searchParams.get('location') || '',
      locationLine: requestUrl.searchParams.get('locationLine') || '',
      mapQuery: requestUrl.searchParams.get('mapQuery') || ''
    });

    sendJson(res, 200, {
      ok: true,
      heroImageUrl: resolved.heroImageUrl,
      heroImageSourceUrl: resolved.heroImageSourceUrl,
      heroImageCredit: resolved.heroImageCredit,
      status: resolved.heroImageStatus
    });
    return;
  }

  if (pathname === '/api/career/housing-search' && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;

    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const market = body && body.market === 'buy' ? 'buy' : 'rent';
    const practiceCoords = buildLifestyleCoordinate(
      body && body.practiceCoords && body.practiceCoords.lat,
      pickFirstDefined(
        body && body.practiceCoords && body.practiceCoords.lng,
        body && body.practiceCoords && body.practiceCoords.lon,
        body && body.practiceCoords && body.practiceCoords.longitude
      )
    );
    const locationContext = await enrichLifestyleLocationContextForHomely(body && body.locationContext, practiceCoords);
    if (!locationContext.label && !locationContext.suburb && !locationContext.state && !locationContext.postcode) {
      sendJson(res, 400, { ok: false, message: 'Missing housing search location.' });
      return;
    }
    const homelyLocation = await resolveHomelyLifestyleLocation(locationContext) || locationContext;
    const household = normalizeLifestyleSearchHousehold(body && body.household);
    const searchOptions = {
      radiusKm: body && body.radiusKm,
      searchQuery: body && body.searchQuery,
      priceMin: body && body.priceMin,
      priceMax: body && body.priceMax,
      sortOrder: body && body.sortOrder
    };
    const listings = await fetchHomelyLifestyleListings(
      homelyLocation,
      practiceCoords,
      market,
      household,
      searchOptions
    );
    const source = listings.length ? 'homely' : 'none';
    const liveUsed = listings.length > 0;
    const liveEnabled = true;
    const fallbackEnabled = false;

    sendJson(res, 200, {
      ok: true,
      market,
      liveEnabled,
      fallbackEnabled,
      liveUsed,
      source,
      listings
    });
    return;
  }

  if (pathname === '/api/career/apply' && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }

    // Per-user rate limiting
    const rateLimitUserId = getSessionSupabaseUserId(session) || email;
    const now = Date.now();
    const timestamps = (_applyRateLimitStore.get(rateLimitUserId) || []).filter((ts) => now - ts < APPLY_RATE_WINDOW_MS);
    if (timestamps.length >= APPLY_RATE_MAX) {
      sendJson(res, 429, { ok: false, message: 'Too many applications. Please try again later.' });
      return;
    }
    timestamps.push(now);
    _applyRateLimitStore.set(rateLimitUserId, timestamps);

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const roleId = String(body && body.roleId || '').trim();
    if (!roleId) {
      sendJson(res, 400, { ok: false, message: 'Missing roleId.' });
      return;
    }

    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) {
      sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' });
      return;
    }

    // Check onboarding is complete
    const stateResult = await getSupabaseUserStateByEmail(email);
    const userState = stateResult && stateResult.state && typeof stateResult.state === 'object' ? stateResult.state : {};
    if (!userState.gp_onboarding_complete) {
      sendJson(res, 403, { ok: false, message: 'Please complete onboarding before applying.' });
      return;
    }

    // Check CV is uploaded
    const cvResult = await supabaseDbRequest(
      'user_documents',
      `select=id&user_id=eq.${encodeURIComponent(userId)}&document_key=eq.cv_signed_dated&status=eq.uploaded&limit=1`
    );
    if (!cvResult.ok || !Array.isArray(cvResult.data) || cvResult.data.length === 0) {
      sendJson(res, 403, { ok: false, message: 'Please upload your CV before applying.', requiresCv: true });
      return;
    }

    // Get user profile for Zoho candidate ID
    const profileResult = await supabaseDbRequest('user_profiles', `select=zoho_candidate_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    const profile = profileResult.ok && Array.isArray(profileResult.data) && profileResult.data[0] ? profileResult.data[0] : {};
    const zohoCandidateId = String(profile.zoho_candidate_id || '').trim();

    // Resolve the career role to get the Zoho job opening ID
    const parsedRoleId = parseCareerRolePublicId(roleId);
    if (!parsedRoleId) {
      sendJson(res, 400, { ok: false, message: 'Invalid role ID format.' });
      return;
    }
    const roleRow = await getCareerRoleRow(parsedRoleId.provider, parsedRoleId.providerRoleId);
    if (!roleRow) {
      sendJson(res, 404, { ok: false, message: 'Role not found.' });
      return;
    }

    // Check for duplicate application
    const existingApp = await supabaseDbRequest(
      'gp_applications',
      `select=id&user_id=eq.${encodeURIComponent(userId)}&career_role_id=eq.${encodeURIComponent(roleRow.id)}&limit=1`
    );
    if (existingApp.ok && Array.isArray(existingApp.data) && existingApp.data.length > 0) {
      sendJson(res, 409, { ok: false, message: 'You have already applied for this role.' });
      return;
    }

    // Create Zoho Application if we have a candidate ID
    let zohoApplicationId = '';
    if (zohoCandidateId && isZohoRecruitConfigured() && parsedRoleId.provider === 'zoho_recruit') {
      const appResult = await createZohoRecruitApplication(zohoCandidateId, parsedRoleId.providerRoleId);
      if (appResult.ok && appResult.data && appResult.data.data && appResult.data.data[0]) {
        const detail = appResult.data.data[0].details;
        zohoApplicationId = detail && detail.id ? String(detail.id) : '';
      }
    }

    // Save application to DB
    const appRow = {
      user_id: userId,
      career_role_id: roleRow.id,
      provider_role_id: parsedRoleId.providerRoleId,
      zoho_candidate_id: zohoCandidateId || null,
      zoho_application_id: zohoApplicationId || null,
      status: 'applied',
      applied_at: new Date().toISOString()
    };
    const insertResult = await supabaseDbRequest('gp_applications', '', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: [appRow]
    });

    if (!insertResult.ok) {
      sendJson(res, 502, { ok: false, message: 'Failed to save application.' });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      message: 'Application submitted successfully.',
      application: insertResult.data && insertResult.data[0] ? insertResult.data[0] : appRow
    });

    // Push career notification (non-blocking)
    const locationLabel = roleRow && roleRow.location_city ? `${roleRow.location_city}${roleRow.location_state ? ', ' + roleRow.location_state : ''}` : 'a new role';
    pushCareerNotificationToUser(userId, {
      type: 'success',
      title: 'Application Submitted',
      body: `Your application for the ${locationLabel} role has been submitted. We'll keep you updated on its progress.`
    }).catch(() => {});
    sendPushNotification(userId, {
      title: 'Application Submitted',
      body: `Your application for the ${locationLabel} role has been submitted. We'll keep you updated on its progress.`,
      data: { type: 'career', action: 'application_submitted', url: '/pages/career.html#applications' }
    }).catch(() => {});

    // Send email notification (non-blocking)
    if (isEmailConfigured()) {
      sendEmail({
        to: email,
        subject: 'Application Submitted — GP Link',
        html: buildCareerEmailHtml({
          title: 'Application Submitted',
          body: 'Your application for the ' + locationLabel + ' role has been submitted successfully. We\'ll review your profile and keep you updated on your application progress.',
          ctaText: 'View Your Applications',
          ctaUrl: 'https://app.mygplink.com.au/pages/career.html#applications',
          footer: 'You\'re receiving this because you applied for a role on GP Link.'
        })
      }).catch(() => {});
    }

    return;
  }

  if (pathname === '/api/career/applications' && req.method === 'GET') {
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }
    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }

    const [profile, result] = await Promise.all([
      isSupabaseDbConfigured()
        ? getSupabaseUserProfile(email, userId)
        : Promise.resolve(dbState.userProfiles[email] && typeof dbState.userProfiles[email] === 'object' ? dbState.userProfiles[email] : null),
      supabaseDbRequest(
        'gp_applications',
        `select=*&user_id=eq.${encodeURIComponent(userId)}&order=applied_at.desc`
      )
    ]);
    const applications = result.ok && Array.isArray(result.data) ? result.data : [];
    const zoho = isZohoRecruitConfigured() ? await getZohoRecruitAccessTokenAndDomain() : null;
    const liveApplications = zoho
      ? await fetchZohoRecruitCareerApplicationsForUser(
        zoho,
        email,
        profile && profile.zoho_candidate_id ? profile.zoho_candidate_id : '',
        applications
      )
      : [];
    const mergedApplications = mergeCareerApplications(applications, liveApplications);
    const roleCache = new Map();
    const jobOpeningCache = new Map();
    const contactsCache = new Map();
    const syntheticRoleCache = new Map();
    const startDateIso = normalizePlacementStartDate(profile && profile.target_arrival_date);

    async function getRoleRowForEntry(localApp, liveRecord) {
      const explicitRoleId = localApp && localApp.career_role_id ? `career:${localApp.career_role_id}` : '';
      if (explicitRoleId && roleCache.has(explicitRoleId)) return roleCache.get(explicitRoleId);
      if (explicitRoleId) {
        const resolved = await getCareerRoleRowById(localApp.career_role_id);
        roleCache.set(explicitRoleId, resolved || null);
        if (resolved) return resolved;
      }

      const providerRoleId = String(
        (localApp && localApp.provider_role_id)
        || getZohoApplicationJobOpeningId(liveRecord)
        || ''
      ).trim();
      if (!providerRoleId) return null;
      const providerKey = `provider:${providerRoleId}`;
      if (roleCache.has(providerKey)) return roleCache.get(providerKey);

      const stored = await getCareerRoleRow('zoho_recruit', providerRoleId);
      if (stored) {
        roleCache.set(providerKey, stored);
        return stored;
      }

      if (syntheticRoleCache.has(providerKey)) return syntheticRoleCache.get(providerKey);
      const liveJobOpening = zoho ? await getJobOpeningRecord(providerRoleId) : null;
      const synthetic = liveJobOpening ? buildCareerRoleRecordFromZoho(liveJobOpening, new Date().toISOString()) : null;
      syntheticRoleCache.set(providerKey, synthetic || null);
      return synthetic || null;
    }

    async function getJobOpeningRecord(providerRoleId) {
      const key = String(providerRoleId || '').trim();
      if (!zoho || !key) return null;
      if (jobOpeningCache.has(key)) return jobOpeningCache.get(key);
      const record = await fetchZohoRecruitJobOpeningRecord(zoho, key);
      jobOpeningCache.set(key, record || null);
      return record || null;
    }

    async function getClientContacts(clientId) {
      const key = String(clientId || '').trim();
      if (!zoho || !key) return [];
      if (contactsCache.has(key)) return contactsCache.get(key);
      const records = await fetchZohoRecruitClientContacts(zoho, key);
      contactsCache.set(key, Array.isArray(records) ? records : []);
      return contactsCache.get(key) || [];
    }

    const enriched = [];
    for (const entry of mergedApplications) {
      const localApp = entry && entry.localApp ? entry.localApp : null;
      const liveRecord = entry && entry.liveRecord ? entry.liveRecord : null;
      const liveStatus = liveRecord ? getZohoApplicationStatus(liveRecord) : '';
      const status = normalizeCareerApplicationStatusKey(liveStatus)
        || normalizeCareerApplicationStatusKey(localApp && localApp.status)
        || 'applied';
      const providerRoleId = String(
        (localApp && localApp.provider_role_id)
        || getZohoApplicationJobOpeningId(liveRecord)
        || ''
      ).trim();
      const roleRow = await getRoleRowForEntry(localApp, liveRecord);
      const jobOpeningRecord = providerRoleId ? await getJobOpeningRecord(providerRoleId) : null;
      const clientId = getZohoApplicationClientId(liveRecord)
        || getZohoLookupId(jobOpeningRecord, ['Client_Name', 'Client', 'Account_Name']);
      const practiceContacts = clientId ? await getClientContacts(clientId) : [];
      const roleClient = roleRow
        ? mapCareerRoleRowToClient(roleRow)
        : {
          id: providerRoleId ? makeCareerRoleId('zoho_recruit', providerRoleId) : `zoho_application:${sanitizeZohoText(liveRecord && liveRecord.id) || localApp && localApp.id || ''}`,
          practiceName: getZohoApplicationPracticeName(liveRecord) || 'Medical Centre',
          location: getZohoPlacementLocation(jobOpeningRecord, null),
          billing: normalizeCareerBillingLabel(getZohoField(jobOpeningRecord, ['Billing_Model', 'Billing_Type', 'Remuneration_Model', 'Fee_Model', 'Billing'])) || 'Billing pending',
          roleType: getZohoField(jobOpeningRecord, ['Role_Title', 'Job_Title', 'Title']) || 'General Practitioner'
        };
      const placement = (isCareerPlacementSecuredStatus(status) && (liveRecord || localApp))
        ? await buildCareerPlacementPayload({
          zoho,
          applicationRecord: liveRecord,
          roleRow,
          jobOpeningRecord,
          startDateIso: startDateIso
            || normalizePlacementStartDate(getZohoField(liveRecord, ['Expected_Date_of_Joining', 'Expected_Joining_Date']))
            || normalizePlacementStartDate(getZohoField(jobOpeningRecord, ['Target_Date', 'Expected_Start_Date', 'Start_Date'])),
          practiceContacts,
          providerRoleId,
          profile
        })
        : null;

      if (localApp && liveRecord) {
        const patch = {};
        const liveAppId = sanitizeZohoText(liveRecord.id);
        const liveCandidateId = getZohoLookupId(liveRecord, ['Candidate_Id', 'Candidate', 'Candidate_Name']);
        if (status && status !== String(localApp.status || '').trim()) patch.status = status;
        if (!localApp.zoho_application_id && liveAppId) patch.zoho_application_id = liveAppId;
        if (!localApp.zoho_candidate_id && liveCandidateId) patch.zoho_candidate_id = liveCandidateId;
        if (Object.keys(patch).length > 0) {
          patch.updated_at = new Date().toISOString();
          await supabaseDbRequest(
            'gp_applications',
            `id=eq.${encodeURIComponent(localApp.id)}`,
            {
              method: 'PATCH',
              headers: { Prefer: 'return=minimal' },
              body: patch
            }
          );

          // Push notification on status change (non-blocking)
          if (patch.status) {
            const statusLabel = normalizeCareerApplicationStatusKey(status);
            const practiceLabel = roleRow && roleRow.practice_name ? roleRow.practice_name : 'your application';
            let notifTitle = 'Application Update';
            let notifBody = `Your application status has been updated to: ${status}`;
            let notifType = 'info';
            if (statusLabel === 'interview_scheduled' || statusLabel === 'interview') {
              notifTitle = 'Interview Scheduled';
              notifBody = `An interview has been scheduled for ${practiceLabel}. Check your application for details.`;
              notifType = 'action';
            } else if (statusLabel === 'offer' || statusLabel === 'offer_pending' || statusLabel === 'offered') {
              notifTitle = 'Offer Pending';
              notifBody = `Great news! An offer is pending for ${practiceLabel}.`;
              notifType = 'success';
            } else if (isCareerPlacementSecuredStatus(statusLabel)) {
              notifTitle = 'Placement Secured!';
              notifBody = `Congratulations! Your placement at ${practiceLabel} has been secured.`;
              notifType = 'success';
            }
            pushCareerNotificationToUser(userId, { type: notifType, title: notifTitle, body: notifBody }).catch(() => {});
            sendPushNotification(userId, {
              title: notifTitle,
              body: notifBody,
              data: { type: 'career', action: 'status_change', url: '/pages/career.html#applications' }
            }).catch(() => {});

            // Send email on status change (non-blocking)
            if (isEmailConfigured()) {
              const gpEmail = email; // already available in scope
              const practiceLabel2 = roleRow && roleRow.practice_name ? roleRow.practice_name : 'your application';
              let emailSubject = 'Application Update — GP Link';
              let emailTitle = 'Application Update';
              let emailBody = 'Your application status has been updated.';
              let emailCta = { text: 'View Application', url: 'https://app.mygplink.com.au/pages/career.html#applications' };
              let emailFooter = 'You\'re receiving this because you have an active application on GP Link.';

              if (statusLabel === 'interview_scheduled' || statusLabel === 'interview') {
                emailSubject = 'Interview Scheduled — GP Link';
                emailTitle = 'Interview Scheduled';
                // Check for interview with Zoom link
                let interviewDetail = '';
                try {
                  const intResult = await supabaseDbRequest('career_interviews', 'select=scheduled_at,zoom_join_url,format,duration_minutes,interviewer_name&application_id=eq.' + encodeURIComponent(localApp.id) + '&status=neq.cancelled&order=scheduled_at.desc&limit=1');
                  if (intResult.ok && Array.isArray(intResult.data) && intResult.data[0]) {
                    const iv = intResult.data[0];
                    const ivDate = new Date(iv.scheduled_at);
                    interviewDetail = '<br><br><strong>Interview Details:</strong><br>';
                    interviewDetail += 'Date: ' + ivDate.toLocaleDateString('en-AU', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + '<br>';
                    interviewDetail += 'Time: ' + ivDate.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }) + '<br>';
                    if (iv.duration_minutes) interviewDetail += 'Duration: ' + iv.duration_minutes + ' minutes<br>';
                    if (iv.interviewer_name) interviewDetail += 'Interviewer: ' + iv.interviewer_name + '<br>';
                    if (iv.zoom_join_url) {
                      emailCta = { text: 'Join Video Interview', url: iv.zoom_join_url };
                      interviewDetail += '<br>Your Zoom meeting link is ready. Click the button below to join when it\'s time.';
                    }
                  }
                } catch {}
                emailBody = 'Great news! An interview has been scheduled for ' + practiceLabel2 + '.' + interviewDetail;
              } else if (statusLabel === 'offer' || statusLabel === 'offer_pending' || statusLabel === 'offered') {
                emailSubject = 'Offer Pending — GP Link';
                emailTitle = 'Offer Pending';
                emailBody = 'Exciting news! An offer is pending for ' + practiceLabel2 + '. Our team will be in touch with the details.';
              } else if (isCareerPlacementSecuredStatus(statusLabel)) {
                emailSubject = 'Placement Secured! — GP Link';
                emailTitle = 'Congratulations!';
                emailBody = 'Your placement at ' + practiceLabel2 + ' has been secured. Visit your dashboard to see your placement details, start date, and next steps.';
                emailCta = { text: 'View Your Placement', url: 'https://app.mygplink.com.au/pages/career.html#secured' };
              }

              sendEmail({
                to: gpEmail,
                subject: emailSubject,
                html: buildCareerEmailHtml({
                  title: emailTitle,
                  body: emailBody,
                  ctaText: emailCta.text,
                  ctaUrl: emailCta.url,
                  footer: emailFooter
                })
              }).catch(() => {});
            }
          }
        }
      }

      enriched.push({
        id: localApp && localApp.id ? localApp.id : (sanitizeZohoText(liveRecord && liveRecord.id) || providerRoleId || crypto.randomUUID()),
        status,
        appliedAt: (localApp && localApp.applied_at)
          || getZohoField(liveRecord, ['Created_Time', 'Modified_Time', 'Updated_On'])
          || new Date().toISOString(),
        role: roleClient,
        placement
      });
    }

    sendJson(res, 200, { ok: true, applications: enriched });
    return;
  }

  if (pathname === '/api/career/application' && req.method === 'GET') {
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }
    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }

    const params = new URL(req.url, 'http://x').searchParams;
    const id = String(params.get('id') || '').trim();
    if (!id) { sendJson(res, 400, { ok: false, message: 'Missing id parameter.' }); return; }

    // Query by id (UUID) or provider_role_id
    const appResult = await supabaseDbRequest(
      'gp_applications',
      `select=*&user_id=eq.${encodeURIComponent(userId)}&or=(id.eq.${encodeURIComponent(id)},provider_role_id.eq.${encodeURIComponent(id)})&limit=1`
    );
    const appRow = appResult.ok && Array.isArray(appResult.data) && appResult.data[0] ? appResult.data[0] : null;
    if (!appRow) {
      sendJson(res, 404, { ok: false, message: 'Application not found.' });
      return;
    }

    // Enrich with role data
    let roleRow = null;
    if (appRow.career_role_id) {
      roleRow = await getCareerRoleRowById(appRow.career_role_id);
    }
    if (!roleRow && appRow.provider_role_id) {
      roleRow = await getCareerRoleRow('zoho_recruit', appRow.provider_role_id);
    }

    // Get live Zoho status if available
    const zoho = isZohoRecruitConfigured() ? await getZohoRecruitAccessTokenAndDomain() : null;
    let liveStatus = '';
    let liveRecord = null;
    if (zoho && appRow.zoho_application_id) {
      try {
        const liveResult = await fetchZohoRecruitApplicationRecord(zoho, appRow.zoho_application_id);
        if (liveResult) {
          liveRecord = liveResult;
          liveStatus = getZohoApplicationStatus(liveResult);
        }
      } catch {}
    }
    const status = normalizeCareerApplicationStatusKey(liveStatus)
      || normalizeCareerApplicationStatusKey(appRow.status)
      || 'applied';

    const providerRoleId = String(appRow.provider_role_id || '').trim();
    const roleClient = roleRow
      ? mapCareerRoleRowToClient(roleRow)
      : {
        id: providerRoleId ? makeCareerRoleId('zoho_recruit', providerRoleId) : appRow.id,
        practiceName: 'Medical Centre',
        location: '',
        billing: 'Billing pending',
        roleType: 'General Practitioner'
      };

    // Build placement payload if status warrants it
    let placement = null;
    if (isCareerPlacementSecuredStatus(status)) {
      try {
        const profile = await getSupabaseUserProfile(email, userId);
        const startDateIso = normalizePlacementStartDate(profile && profile.target_arrival_date);
        let jobOpeningRecord = null;
        if (zoho && providerRoleId) {
          try { jobOpeningRecord = await fetchZohoRecruitJobOpeningRecord(zoho, providerRoleId); } catch {}
        }
        const clientId = getZohoApplicationClientId(liveRecord)
          || getZohoLookupId(jobOpeningRecord, ['Client_Name', 'Client', 'Account_Name']);
        let practiceContacts = [];
        if (zoho && clientId) {
          try { practiceContacts = await fetchZohoRecruitClientContacts(zoho, clientId); } catch {}
        }
        placement = await buildCareerPlacementPayload({
          zoho,
          applicationRecord: liveRecord,
          roleRow,
          jobOpeningRecord,
          startDateIso: startDateIso
            || normalizePlacementStartDate(getZohoField(liveRecord, ['Expected_Date_of_Joining', 'Expected_Joining_Date']))
            || normalizePlacementStartDate(getZohoField(jobOpeningRecord, ['Target_Date', 'Expected_Start_Date', 'Start_Date'])),
          practiceContacts,
          providerRoleId,
          profile
        });
      } catch {}
    }

    // Sync status back to DB if changed
    if (liveRecord && status && status !== String(appRow.status || '').trim()) {
      supabaseDbRequest('gp_applications', `id=eq.${encodeURIComponent(appRow.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: { status, updated_at: new Date().toISOString() }
      }).catch(() => {});
    }

    // Query interview data (table may not exist yet)
    let interview = null;
    try {
      const intResult = await supabaseDbRequest(
        'career_interviews',
        `select=*&application_id=eq.${encodeURIComponent(appRow.id)}&status=neq.cancelled&order=scheduled_at.desc&limit=1`
      );
      if (intResult.ok && Array.isArray(intResult.data) && intResult.data[0]) {
        const raw = intResult.data[0];
        // Sanitize join URL — only allow https:// or zoomus:// schemes
        const sanitizedJoinUrl = raw.zoom_join_url ? safeZoomOrHttpUrl(raw.zoom_join_url) : null;
        // Strip sensitive fields — never expose host URL, passcode, or internal notes to the GP
        interview = {
          id: raw.id,
          application_id: raw.application_id,
          scheduled_at: raw.scheduled_at,
          duration_minutes: raw.duration_minutes,
          timezone: raw.timezone,
          format: raw.format,
          status: raw.status,
          zoom_join_url: sanitizedJoinUrl || null,
          interviewer_name: raw.interviewer_name || '',
          interviewer_role: raw.interviewer_role || '',
          gp_notes: raw.gp_notes || '',
          created_at: raw.created_at,
          updated_at: raw.updated_at
        };
      }
    } catch {}

    const enrichedApp = {
      id: appRow.id,
      status,
      appliedAt: appRow.applied_at || new Date().toISOString(),
      role: roleClient,
      placement,
      interview
    };

    sendJson(res, 200, { ok: true, application: enrichedApp });
    return;
  }

  if (pathname === '/api/career/interview' && req.method === 'GET') {
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }
    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }

    const qs = new URL(req.url, 'http://localhost').searchParams;
    const applicationId = String(qs.get('applicationId') || '').trim();
    if (!applicationId) { sendJson(res, 400, { ok: false, message: 'Missing applicationId.' }); return; }

    // Verify application belongs to user
    const appCheck = await supabaseDbRequest('gp_applications', `select=id&id=eq.${encodeURIComponent(applicationId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    if (!appCheck.ok || !Array.isArray(appCheck.data) || appCheck.data.length === 0) {
      sendJson(res, 404, { ok: false, message: 'Application not found.' });
      return;
    }

    try {
      const result = await supabaseDbRequest(
        'career_interviews',
        `select=*&application_id=eq.${encodeURIComponent(applicationId)}&status=neq.cancelled&order=scheduled_at.desc&limit=1`
      );
      const raw = result.ok && Array.isArray(result.data) && result.data[0] ? result.data[0] : null;
      // Strip sensitive fields — never expose host URL, passcode, or internal notes to the GP
      const interview = raw ? {
        id: raw.id,
        application_id: raw.application_id,
        scheduled_at: raw.scheduled_at,
        duration_minutes: raw.duration_minutes,
        timezone: raw.timezone,
        format: raw.format,
        status: raw.status,
        zoom_join_url: raw.zoom_join_url ? safeZoomOrHttpUrl(raw.zoom_join_url) : null,
        interviewer_name: raw.interviewer_name || '',
        interviewer_role: raw.interviewer_role || '',
        gp_notes: raw.gp_notes || '',
        created_at: raw.created_at,
        updated_at: raw.updated_at
      } : null;
      sendJson(res, 200, { ok: true, interview });
    } catch {
      sendJson(res, 200, { ok: true, interview: null });
    }
    return;
  }

  if (pathname === '/api/career/application/withdraw' && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }
    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const applicationId = String(body && body.applicationId || '').trim();
    if (!applicationId) { sendJson(res, 400, { ok: false, message: 'Missing applicationId.' }); return; }

    // Verify application belongs to user
    const appResult = await supabaseDbRequest('gp_applications', `select=id,status&id=eq.${encodeURIComponent(applicationId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    if (!appResult.ok || !Array.isArray(appResult.data) || appResult.data.length === 0) {
      sendJson(res, 404, { ok: false, message: 'Application not found.' });
      return;
    }

    const app = appResult.data[0];
    const currentStatus = normalizeCareerApplicationStatusKey(app.status);
    if (isCareerPlacementSecuredStatus(currentStatus)) {
      sendJson(res, 400, { ok: false, message: 'Cannot withdraw a secured placement. Contact GP Link support.' });
      return;
    }

    // Update status to withdrawn
    const patchResult = await supabaseDbRequest('gp_applications', `id=eq.${encodeURIComponent(applicationId)}`, {
      method: 'PATCH',
      body: { status: 'withdrawn', updated_at: new Date().toISOString() }
    });

    if (!patchResult.ok) {
      sendJson(res, 502, { ok: false, message: 'Failed to withdraw application.' });
      return;
    }

    // Cancel any scheduled interviews
    try {
      const interviews = await supabaseDbRequest('career_interviews', `select=id,zoom_meeting_id&application_id=eq.${encodeURIComponent(applicationId)}&status=in.(scheduled,confirmed)`);
      if (interviews.ok && Array.isArray(interviews.data)) {
        for (const iv of interviews.data) {
          await supabaseDbRequest('career_interviews', `id=eq.${encodeURIComponent(iv.id)}`, {
            method: 'PATCH',
            body: { status: 'cancelled', updated_at: new Date().toISOString() }
          });
          if (iv.zoom_meeting_id && isZoomConfigured()) {
            deleteZoomMeeting(iv.zoom_meeting_id).catch(() => {});
          }
        }
      }
    } catch {}

    sendJson(res, 200, { ok: true, message: 'Application withdrawn.' });
    return;
  }

  if (pathname === '/api/career/upload-cv' && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }
    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const fileName = String(body && body.fileName || '').trim().slice(0, 255);
    const fileDataUrl = String(body && body.fileDataUrl || '');
    const mimeType = String(body && body.mimeType || 'application/pdf').trim();

    if (!fileDataUrl || !fileDataUrl.startsWith('data:')) {
      sendJson(res, 400, { ok: false, message: 'Missing or invalid file data.' });
      return;
    }

    if (mimeType !== 'application/pdf') {
      sendJson(res, 400, { ok: false, message: 'Only PDF files are accepted.' });
      return;
    }

    // Check approximate file size (base64 is ~33% larger than binary)
    const base64Part = fileDataUrl.split(',')[1] || '';
    const approxBytes = Math.ceil(base64Part.length * 0.75);
    if (approxBytes > 10 * 1024 * 1024) {
      sendJson(res, 400, { ok: false, message: 'File too large. Maximum 10 MB.' });
      return;
    }

    const selectedCountry = 'AU';
    const docKey = 'cv_signed_dated';
    const storagePath = buildPreparedDocumentStoragePath(userId, selectedCountry, docKey);
    const uploaded = await supabaseStorageUploadObject(SUPABASE_DOCUMENT_BUCKET, storagePath, fileDataUrl, mimeType);
    if (!uploaded) {
      sendJson(res, 502, { ok: false, message: 'Failed to upload file.' });
      return;
    }

    const result = await supabaseDbRequest(
      'user_documents',
      'on_conflict=user_id,document_key,country_code',
      {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: [{
          user_id: userId,
          country_code: selectedCountry,
          document_key: docKey,
          status: 'uploaded',
          file_name: fileName || 'cv.pdf',
          file_url: storagePath,
          updated_at: new Date().toISOString()
        }]
      }
    );

    if (!result.ok) {
      sendJson(res, 502, { ok: false, message: 'Failed to save document record.' });
      return;
    }

    sendJson(res, 200, { ok: true, message: 'CV uploaded successfully.' });
    return;
  }

  if (pathname === '/api/career/alerts' && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const enabled = body && body.enabled === true;
    const filters = body && typeof body.filters === 'object' ? {
      location: String(body.filters.location || '').slice(0, 100),
      billing: String(body.filters.billing || '').slice(0, 100),
      tokens: Array.isArray(body.filters.tokens) ? body.filters.tokens.filter(t => typeof t === 'string').slice(0, 10).map(t => t.slice(0, 50)) : []
    } : {};

    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }

    try {
      const stateResult = await supabaseDbRequest('user_state', `select=state&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
      const currentState = stateResult.ok && Array.isArray(stateResult.data) && stateResult.data[0] && typeof stateResult.data[0].state === 'object'
        ? stateResult.data[0].state
        : {};
      currentState.gp_career_alerts = { enabled, filters, updatedAt: new Date().toISOString() };
      await supabaseDbRequest('user_state', `user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        body: { state: currentState }
      });
      sendJson(res, 200, { ok: true, alerts: currentState.gp_career_alerts });
    } catch {
      sendJson(res, 500, { ok: false, message: 'Failed to update alert preferences.' });
    }
    return;
  }

  if (pathname === '/api/career/alerts' && req.method === 'GET') {
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }
    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }

    try {
      const stateResult = await supabaseDbRequest('user_state', `select=state&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
      const currentState = stateResult.ok && Array.isArray(stateResult.data) && stateResult.data[0] && typeof stateResult.data[0].state === 'object'
        ? stateResult.data[0].state
        : {};
      sendJson(res, 200, { ok: true, alerts: currentState.gp_career_alerts || { enabled: false, filters: {} } });
    } catch {
      sendJson(res, 200, { ok: true, alerts: { enabled: false, filters: {} } });
    }
    return;
  }

  if (pathname === '/api/push/register' && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }
    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const token = String(body && body.token || '').trim().slice(0, 500);
    const platform = ['ios', 'android', 'web'].includes(body && body.platform) ? body.platform : 'web';
    if (!token) { sendJson(res, 400, { ok: false, message: 'Missing push token.' }); return; }

    try {
      const stateResult = await supabaseDbRequest('user_state', `select=state&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
      const currentState = stateResult.ok && Array.isArray(stateResult.data) && stateResult.data[0] && typeof stateResult.data[0].state === 'object'
        ? stateResult.data[0].state
        : {};

      // Store push tokens (allow multiple devices)
      const pushTokens = Array.isArray(currentState.gp_push_tokens) ? currentState.gp_push_tokens : [];
      const existing = pushTokens.findIndex(t => t && t.token === token);
      if (existing >= 0) {
        pushTokens[existing] = { token, platform, updatedAt: new Date().toISOString() };
      } else {
        pushTokens.push({ token, platform, registeredAt: new Date().toISOString() });
      }
      // Keep max 5 tokens per user
      if (pushTokens.length > 5) pushTokens.splice(0, pushTokens.length - 5);

      currentState.gp_push_tokens = pushTokens;
      await supabaseDbRequest('user_state', `user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        body: { state: currentState }
      });
      sendJson(res, 200, { ok: true });
    } catch {
      sendJson(res, 500, { ok: false, message: 'Failed to register push token.' });
    }
    return;
  }

  if (pathname === '/api/integrations/zoho-recruit/status' && req.method === 'GET') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Zoho Recruit integration requires Supabase database configuration.' });
      return;
    }
    const adminCtx = requireIntegrationAdminSession(req, res);
    if (!adminCtx) return;

    const [connection, roles] = await Promise.all([
      getZohoRecruitConnection(),
      listCareerRoleRows(false, 'zoho_recruit')
    ]);
    const scopeStatus = getZohoRecruitScopeStatus(connection);
    sendJson(res, 200, {
      ok: true,
      configured: isZohoRecruitConfigured(),
      redirectUri: getZohoRecruitOauthRedirectUri(),
      configuredRedirectUri: ZOHO_RECRUIT_REDIRECT_URI,
      accountsServer: getZohoRecruitAccountsServer(),
      scopes: scopeStatus.requestedScopes,
      grantedScopes: scopeStatus.grantedScopes,
      missingScopes: scopeStatus.missingScopes,
      missingRequiredScopes: scopeStatus.missingRequiredScopes,
      overbroadGrantedScopes: scopeStatus.overbroadGrantedScopes,
      needsReconnect: scopeStatus.needsReconnect,
      cronConfigured: !!ZOHO_RECRUIT_SYNC_CRON_SECRET,
      cronPath: '/api/integrations/zoho-recruit/cron-sync',
      connected: !!(connection && connection.refreshToken),
      connection,
      roleCount: roles.length
    });
    return;
  }

  if (pathname === '/api/integrations/zoho-recruit/connect' && req.method === 'GET') {
    const adminCtx = requireIntegrationAdminSession(req, res);
    if (!adminCtx) return;
    if (!isZohoRecruitConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Zoho Recruit environment variables are incomplete.' });
      return;
    }

    const oauthRedirectUri = getZohoRecruitOauthRedirectUri();
    const oauthState = await createZohoOauthState(adminCtx.email, {
      redirectUri: oauthRedirectUri,
      returnUrl: buildAbsoluteReturnUrl(req, '/pages/account.html'),
      returnPath: '/pages/account.html'
    });
    const authUrl = new URL(`${getZohoRecruitAccountsServer()}/oauth/v2/auth`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', ZOHO_RECRUIT_CLIENT_ID);
    authUrl.searchParams.set('scope', getZohoRecruitScopes().join(','));
    authUrl.searchParams.set('redirect_uri', oauthRedirectUri);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', oauthState);
    res.writeHead(302, { Location: authUrl.toString() });
    res.end();
    return;
  }

  if (pathname === '/api/integrations/zoho-recruit/callback' && req.method === 'GET') {
    if (!isZohoRecruitConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Zoho Recruit environment variables are incomplete.' });
      return;
    }

    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const state = String(reqUrl.searchParams.get('state') || '').trim();
    const code = String(reqUrl.searchParams.get('code') || '').trim();
    const authError = String(reqUrl.searchParams.get('error') || '').trim();
    const authErrorDescription = String(reqUrl.searchParams.get('error_description') || '').trim();
    const callbackAccountsServer = normalizeUrlBase(
      reqUrl.searchParams.get('accounts-server') || reqUrl.searchParams.get('accounts_server') || '',
      getZohoRecruitAccountsServer()
    );

    if (!state) {
      if (authError) {
        res.writeHead(302, {
          Location: buildAbsoluteReturnUrl(req, `/pages/account.html?zohoRecruit=error&message=${encodeURIComponent(authErrorDescription || authError)}`)
        });
        res.end();
        return;
      }
      if (!code) {
        sendJson(res, 400, { ok: false, message: 'Missing Zoho Recruit callback parameters.' });
        return;
      }
    }
    if (!state || (!code && !authError)) {
      sendJson(res, 400, { ok: false, message: 'Missing Zoho Recruit callback parameters.' });
      return;
    }

    const statePayload = await consumeZohoOauthState(state);
    if (!statePayload || !statePayload.email || !isAdminEmail(statePayload.email)) {
      sendJson(res, 403, { ok: false, message: 'Invalid Zoho Recruit OAuth state.' });
      return;
    }
    const oauthRedirectUri = String(statePayload.redirectUri || getZohoRecruitOauthRedirectUri()).trim();
    const successReturnUrl = String(statePayload.returnUrl || buildAbsoluteReturnUrl(req, statePayload.returnPath || '/pages/account.html')).trim()
      || buildAbsoluteReturnUrl(req, '/pages/account.html');

    if (authError) {
      res.writeHead(302, {
        Location: `${successReturnUrl}?zohoRecruit=error&message=${encodeURIComponent(authErrorDescription || authError)}`
      });
      res.end();
      return;
    }

    const exchanged = await exchangeZohoRecruitAuthorizationCode(code, callbackAccountsServer, oauthRedirectUri);
    if (!exchanged.ok) {
      const errorMessage = getZohoErrorMessage(exchanged.data, 'Failed to connect Zoho Recruit.');
      res.writeHead(302, {
        Location: `${successReturnUrl}?zohoRecruit=error&message=${encodeURIComponent(errorMessage)}`
      });
      res.end();
      return;
    }

    const callbackSession = getSession(req);
    const callbackUserId = callbackSession && getSessionEmail(callbackSession) === statePayload.email
      ? (getSessionSupabaseUserId(callbackSession) || '')
      : '';
    const connectedAt = new Date().toISOString();
    await upsertZohoRecruitConnection({
      status: 'connected',
      accountsServer: callbackAccountsServer,
      apiDomain: normalizeUrlBase(exchanged.data && exchanged.data.api_domain, ''),
      refreshToken: exchanged.data && exchanged.data.refresh_token ? String(exchanged.data.refresh_token) : '',
      scopes: parseZohoRecruitScopes(exchanged.data && exchanged.data.scope ? exchanged.data.scope : getZohoRecruitScopes()),
      connectedByUserId: callbackUserId,
      connectedEmail: statePayload.email,
      tokenLastRefreshedAt: connectedAt,
      connectedAt,
      lastSyncStatus: 'pending',
      lastSyncError: '',
      metadata: {
        apiDomain: normalizeUrlBase(exchanged.data && exchanged.data.api_domain, ''),
        location: String(exchanged.data && exchanged.data.location ? exchanged.data.location : '').trim()
      }
    });

    const syncResult = await syncZohoRecruitRoles();
    if (!syncResult.ok) {
      res.writeHead(302, {
        Location: `${successReturnUrl}?zohoRecruit=connected&sync=error&message=${encodeURIComponent(syncResult.message || 'Sync failed')}`
      });
      res.end();
      return;
    }

    res.writeHead(302, {
      Location: `${successReturnUrl}?zohoRecruit=connected&sync=success&roles=${encodeURIComponent(String(syncResult.syncedRoleCount || 0))}`
    });
    res.end();
    return;
  }

  if (pathname === '/api/integrations/zoho-recruit/sync' && (req.method === 'POST' || req.method === 'GET')) {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Zoho Recruit sync requires Supabase database configuration.' });
      return;
    }
    const adminCtx = requireIntegrationAdminSession(req, res);
    if (!adminCtx) return;

    const syncResult = await syncZohoRecruitRoles();
    sendJson(res, syncResult.ok ? 200 : (syncResult.status || 502), {
      ok: !!syncResult.ok,
      syncedAt: syncResult.syncedAt || null,
      syncedRoleCount: syncResult.syncedRoleCount || 0,
      message: syncResult.message || '',
      connection: syncResult.connected || null
    });
    return;
  }

  if (pathname === '/api/integrations/zoho-recruit/cron-sync' && req.method === 'GET') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Zoho Recruit sync requires Supabase database configuration.' });
      return;
    }
    if (!requireZohoRecruitCronAuth(req, res)) return;

    const syncResult = await runZohoRecruitScheduledSync();
    sendJson(res, syncResult.ok ? 200 : (syncResult.status || 502), {
      ok: !!syncResult.ok,
      skipped: !!syncResult.skipped,
      reason: syncResult.reason || '',
      syncedAt: syncResult.syncedAt || null,
      syncedRoleCount: syncResult.syncedRoleCount || 0,
      message: syncResult.message || '',
      connection: syncResult.connected || null
    });
    return;
  }

  if (pathname === '/api/admin/integrations/zoho-recruit/status' && req.method === 'GET') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Zoho Recruit integration requires Supabase database configuration.' });
      return;
    }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;

    const [connection, roles] = await Promise.all([
      getZohoRecruitConnection(),
      listCareerRoleRows(false, 'zoho_recruit')
    ]);
    const scopeStatus = getZohoRecruitScopeStatus(connection);
    sendJson(res, 200, {
      ok: true,
      configured: isZohoRecruitConfigured(),
      redirectUri: getZohoRecruitOauthRedirectUri(),
      configuredRedirectUri: ZOHO_RECRUIT_REDIRECT_URI,
      accountsServer: getZohoRecruitAccountsServer(),
      scopes: scopeStatus.requestedScopes,
      grantedScopes: scopeStatus.grantedScopes,
      missingScopes: scopeStatus.missingScopes,
      missingRequiredScopes: scopeStatus.missingRequiredScopes,
      overbroadGrantedScopes: scopeStatus.overbroadGrantedScopes,
      needsReconnect: scopeStatus.needsReconnect,
      cronConfigured: !!ZOHO_RECRUIT_SYNC_CRON_SECRET,
      cronPath: '/api/integrations/zoho-recruit/cron-sync',
      connected: !!(connection && connection.refreshToken),
      connection,
      roleCount: roles.length
    });
    return;
  }

  if (pathname === '/api/admin/integrations/zoho-recruit/connect' && req.method === 'GET') {
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    if (!isZohoRecruitConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Zoho Recruit environment variables are incomplete.' });
      return;
    }

    const oauthRedirectUri = getZohoRecruitOauthRedirectUri();
    const oauthState = await createZohoOauthState(adminCtx.email, {
      redirectUri: oauthRedirectUri,
      returnUrl: buildAbsoluteReturnUrl(req, '/pages/admin.html'),
      returnPath: '/pages/admin.html'
    });
    const authUrl = new URL(`${getZohoRecruitAccountsServer()}/oauth/v2/auth`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', ZOHO_RECRUIT_CLIENT_ID);
    authUrl.searchParams.set('scope', getZohoRecruitScopes().join(','));
    authUrl.searchParams.set('redirect_uri', oauthRedirectUri);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', oauthState);
    res.writeHead(302, { Location: authUrl.toString() });
    res.end();
    return;
  }

  if (pathname === '/api/admin/integrations/zoho-recruit/callback' && req.method === 'GET') {
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    if (!isZohoRecruitConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Zoho Recruit environment variables are incomplete.' });
      return;
    }

    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const state = String(reqUrl.searchParams.get('state') || '').trim();
    const code = String(reqUrl.searchParams.get('code') || '').trim();
    const authError = String(reqUrl.searchParams.get('error') || '').trim();
    const authErrorDescription = String(reqUrl.searchParams.get('error_description') || '').trim();
    const callbackAccountsServer = normalizeUrlBase(
      reqUrl.searchParams.get('accounts-server') || reqUrl.searchParams.get('accounts_server') || '',
      getZohoRecruitAccountsServer()
    );

    if (!state) {
      if (authError) {
        res.writeHead(302, {
          Location: buildAbsoluteReturnUrl(req, `/pages/admin.html?zohoRecruit=error&message=${encodeURIComponent(authErrorDescription || authError)}`)
        });
        res.end();
        return;
      }
      if (!code) {
        sendJson(res, 400, { ok: false, message: 'Missing Zoho Recruit callback parameters.' });
        return;
      }
    }
    if (!state || (!code && !authError)) {
      sendJson(res, 400, { ok: false, message: 'Missing Zoho Recruit callback parameters.' });
      return;
    }

    const statePayload = await consumeZohoOauthState(state);
    if (!statePayload || statePayload.email !== adminCtx.email) {
      sendJson(res, 403, { ok: false, message: 'Invalid Zoho Recruit OAuth state.' });
      return;
    }
    const oauthRedirectUri = String(statePayload.redirectUri || getZohoRecruitOauthRedirectUri()).trim();
    const successReturnUrl = String(statePayload.returnUrl || buildAbsoluteReturnUrl(req, statePayload.returnPath || '/pages/admin.html')).trim()
      || buildAbsoluteReturnUrl(req, '/pages/admin.html');

    if (authError) {
      res.writeHead(302, {
        Location: `${successReturnUrl}?zohoRecruit=error&message=${encodeURIComponent(authErrorDescription || authError)}`
      });
      res.end();
      return;
    }

    const exchanged = await exchangeZohoRecruitAuthorizationCode(code, callbackAccountsServer, oauthRedirectUri);
    if (!exchanged.ok) {
      const errorMessage = getZohoErrorMessage(exchanged.data, 'Failed to connect Zoho Recruit.');
      res.writeHead(302, {
        Location: `${successReturnUrl}?zohoRecruit=error&message=${encodeURIComponent(errorMessage)}`
      });
      res.end();
      return;
    }

    const adminUserId = getSessionSupabaseUserId(adminCtx.session) || '';
    const connectedAt = new Date().toISOString();
    await upsertZohoRecruitConnection({
      status: 'connected',
      accountsServer: callbackAccountsServer,
      apiDomain: normalizeUrlBase(exchanged.data && exchanged.data.api_domain, ''),
      refreshToken: exchanged.data && exchanged.data.refresh_token ? String(exchanged.data.refresh_token) : '',
      scopes: parseZohoRecruitScopes(exchanged.data && exchanged.data.scope ? exchanged.data.scope : getZohoRecruitScopes()),
      connectedByUserId: adminUserId,
      connectedEmail: adminCtx.email,
      tokenLastRefreshedAt: connectedAt,
      connectedAt,
      lastSyncStatus: 'pending',
      lastSyncError: '',
      metadata: {
        apiDomain: normalizeUrlBase(exchanged.data && exchanged.data.api_domain, ''),
        location: String(exchanged.data && exchanged.data.location ? exchanged.data.location : '').trim()
      }
    });

    const syncResult = await syncZohoRecruitRoles();
    if (!syncResult.ok) {
      res.writeHead(302, {
        Location: `${successReturnUrl}?zohoRecruit=connected&sync=error&message=${encodeURIComponent(syncResult.message || 'Sync failed')}`
      });
      res.end();
      return;
    }

    res.writeHead(302, {
      Location: `${successReturnUrl}?zohoRecruit=connected&sync=success&roles=${encodeURIComponent(String(syncResult.syncedRoleCount || 0))}`
    });
    res.end();
    return;
  }

  if (pathname === '/api/admin/integrations/zoho-recruit/sync' && (req.method === 'POST' || req.method === 'GET')) {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Zoho Recruit sync requires Supabase database configuration.' });
      return;
    }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;

    const syncResult = await syncZohoRecruitRoles();
    sendJson(res, syncResult.ok ? 200 : (syncResult.status || 502), {
      ok: !!syncResult.ok,
      syncedAt: syncResult.syncedAt || null,
      syncedRoleCount: syncResult.syncedRoleCount || 0,
      message: syncResult.message || '',
      connection: syncResult.connected || null
    });
    return;
  }

  // ── Admin applications list ──────────────────────────────────

  if (pathname === '/api/admin/career/applications' && req.method === 'GET') {
    if (!requireAdminSession(req, res)) return;
    try {
      const result = await supabaseDbRequest(
        'gp_applications',
        'select=*&order=applied_at.desc&limit=200'
      );
      const applications = result.ok && Array.isArray(result.data) ? result.data : [];

      // Enrich with user email and role info
      const enriched = [];
      for (const app of applications.slice(0, 100)) {
        try {
          const profileResult = await supabaseDbRequest('user_profiles', `select=email,first_name,last_name&user_id=eq.${encodeURIComponent(app.user_id)}&limit=1`);
          if (profileResult.ok && Array.isArray(profileResult.data) && profileResult.data[0]) {
            const p = profileResult.data[0];
            app.gp_name = ((p.first_name || '') + ' ' + (p.last_name || '')).trim() || p.email || '';
            app.gp_email = p.email || '';
          }
        } catch {}
        if (app.career_role_id) {
          try {
            const roleResult = await supabaseDbRequest('career_roles', `select=title,practice_name,location_city,location_state&id=eq.${encodeURIComponent(app.career_role_id)}&limit=1`);
            if (roleResult.ok && Array.isArray(roleResult.data) && roleResult.data[0]) {
              const r = roleResult.data[0];
              app.role_title = r.title || 'General Practitioner';
              app.practice_name = r.practice_name || '';
              app.role_location = (r.location_city || '') + (r.location_state ? ', ' + r.location_state : '');
            }
          } catch {}
        }
        enriched.push(app);
      }

      sendJson(res, 200, { ok: true, applications: enriched });
    } catch {
      sendJson(res, 500, { ok: false, message: 'Failed to fetch applications.' });
    }
    return;
  }

  // ── Admin interview scheduling ──────────────────────────────────

  if (pathname === '/api/admin/career/interviews' && req.method === 'GET') {
    if (!requireAdminSession(req, res)) return;
    try {
      const result = await supabaseDbRequest(
        'career_interviews',
        'select=*&order=scheduled_at.desc&limit=100'
      );
      sendJson(res, 200, { ok: true, interviews: result.ok && Array.isArray(result.data) ? result.data : [] });
    } catch {
      sendJson(res, 500, { ok: false, message: 'Failed to fetch interviews.' });
    }
    return;
  }

  if (pathname === '/api/admin/career/interview/schedule' && req.method === 'POST') {
    if (!requireAdminSession(req, res)) return;

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const applicationId = String(body && body.applicationId || '').trim();
    const scheduledAt = String(body && body.scheduledAt || '').trim();
    const duration = Math.max(15, Math.min(120, parseInt(body && body.duration || 30, 10) || 30));
    const timezone = String(body && body.timezone || 'Australia/Sydney').trim();
    const format = ['video', 'phone', 'in_person'].includes(body && body.format) ? body.format : 'video';
    const interviewerName = String(body && body.interviewerName || '').trim().slice(0, 200);
    const interviewerRole = String(body && body.interviewerRole || '').trim().slice(0, 200);
    const interviewerEmail = String(body && body.interviewerEmail || '').trim().slice(0, 320);
    const internalNotes = String(body && body.internalNotes || '').trim().slice(0, 2000);

    if (!applicationId || !scheduledAt) {
      sendJson(res, 400, { ok: false, message: 'Missing applicationId or scheduledAt.' });
      return;
    }

    // Validate scheduledAt is a valid future date
    const scheduledDate = new Date(scheduledAt);
    if (isNaN(scheduledDate.getTime())) {
      sendJson(res, 400, { ok: false, message: 'Invalid scheduledAt date.' });
      return;
    }

    // Get the application and user
    const appResult = await supabaseDbRequest('gp_applications', `select=*&id=eq.${encodeURIComponent(applicationId)}&limit=1`);
    if (!appResult.ok || !Array.isArray(appResult.data) || appResult.data.length === 0) {
      sendJson(res, 404, { ok: false, message: 'Application not found.' });
      return;
    }
    const appRow = appResult.data[0];
    const gpUserId = appRow.user_id;

    // Create Zoom meeting if format is video and Zoom is configured
    let zoomMeetingId = '';
    let zoomJoinUrl = '';
    let zoomHostUrl = '';
    let zoomPasscode = '';

    if (format === 'video' && isZoomConfigured()) {
      try {
        const meeting = await createZoomMeeting({
          topic: 'GP Link Interview - ' + (interviewerName || 'Practice Interview'),
          startTime: scheduledDate.toISOString(),
          duration: duration,
          timezone: timezone
        });
        zoomMeetingId = String(meeting.id || '');
        zoomJoinUrl = String(meeting.join_url || '');
        zoomHostUrl = String(meeting.start_url || '');
        zoomPasscode = String(meeting.password || '');
      } catch (err) {
        // Zoom creation failed — continue without it
      }
    }

    // Insert interview record
    const interviewRow = {
      application_id: applicationId,
      user_id: gpUserId,
      scheduled_at: scheduledDate.toISOString(),
      duration_minutes: duration,
      timezone: timezone,
      format: format,
      status: 'scheduled',
      zoom_meeting_id: zoomMeetingId || null,
      zoom_join_url: zoomJoinUrl || null,
      zoom_host_url: zoomHostUrl || null,
      zoom_passcode: zoomPasscode || null,
      interviewer_name: interviewerName,
      interviewer_role: interviewerRole,
      interviewer_email: interviewerEmail,
      internal_notes: internalNotes
    };

    const insertResult = await supabaseDbRequest('career_interviews', '', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: [interviewRow]
    });

    if (!insertResult.ok) {
      sendJson(res, 502, { ok: false, message: 'Failed to save interview.' });
      return;
    }

    // Update application status to interview_scheduled
    await supabaseDbRequest('gp_applications', `id=eq.${encodeURIComponent(applicationId)}`, {
      method: 'PATCH',
      body: { status: 'interview_scheduled', updated_at: new Date().toISOString() }
    });

    // Notify GP
    pushCareerNotificationToUser(gpUserId, {
      type: 'action',
      title: 'Interview Scheduled',
      body: 'An interview has been scheduled for ' + scheduledDate.toLocaleDateString('en-AU', { weekday: 'long', month: 'long', day: 'numeric' }) + '. Check your application for details.'
    }).catch(() => {});
    sendPushNotification(gpUserId, {
      title: 'Interview Scheduled',
      body: 'An interview has been scheduled for ' + scheduledDate.toLocaleDateString('en-AU', { weekday: 'long', month: 'long', day: 'numeric' }) + '. Check your application for details.',
      data: { type: 'career', action: 'interview_scheduled', url: '/pages/career.html#applications' }
    }).catch(() => {});

    // Send email with Zoom link (non-blocking)
    if (isEmailConfigured()) {
      try {
        const gpProfileResult = await supabaseDbRequest('user_profiles', 'select=email&user_id=eq.' + encodeURIComponent(gpUserId) + '&limit=1');
        const gpEmail = gpProfileResult.ok && Array.isArray(gpProfileResult.data) && gpProfileResult.data[0] ? gpProfileResult.data[0].email : '';
        if (gpEmail) {
          let interviewDetail = 'Date: ' + scheduledDate.toLocaleDateString('en-AU', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + '<br>';
          interviewDetail += 'Time: ' + scheduledDate.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }) + '<br>';
          interviewDetail += 'Duration: ' + duration + ' minutes<br>';
          if (interviewerName) interviewDetail += 'Interviewer: ' + interviewerName + '<br>';
          const formatLabels = { video: 'Video Call (Zoom)', phone: 'Phone Call', in_person: 'In Person' };
          interviewDetail += 'Format: ' + (formatLabels[format] || format) + '<br>';

          sendEmail({
            to: gpEmail,
            subject: 'Interview Scheduled — GP Link',
            html: buildCareerEmailHtml({
              title: 'Interview Scheduled',
              body: 'An interview has been scheduled for your GP Link application.<br><br>' + interviewDetail + (zoomJoinUrl ? '<br>Your Zoom meeting link is included in the button below.' : ''),
              ctaText: zoomJoinUrl ? 'Join Video Interview' : 'View Application',
              ctaUrl: zoomJoinUrl || 'https://app.mygplink.com.au/pages/career.html#applications',
              footer: 'You\'re receiving this because you have an active application on GP Link.'
            })
          }).catch(() => {});
        }
      } catch {}
    }

    sendJson(res, 200, {
      ok: true,
      interview: insertResult.data && insertResult.data[0] ? insertResult.data[0] : interviewRow
    });
    return;
  }

  if (pathname === '/api/admin/career/interview' && req.method === 'PATCH') {
    if (!requireAdminSession(req, res)) return;

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const interviewId = String(body && body.id || '').trim();
    if (!interviewId) { sendJson(res, 400, { ok: false, message: 'Missing interview id.' }); return; }

    const patch = { updated_at: new Date().toISOString() };
    if (body.scheduledAt) patch.scheduled_at = new Date(body.scheduledAt).toISOString();
    if (body.duration) patch.duration_minutes = Math.max(15, Math.min(120, parseInt(body.duration, 10) || 30));
    if (body.status && ['scheduled', 'confirmed', 'cancelled', 'completed', 'no_show'].includes(body.status)) patch.status = body.status;
    if (body.interviewerName !== undefined) patch.interviewer_name = String(body.interviewerName || '').slice(0, 200);
    if (body.internalNotes !== undefined) patch.internal_notes = String(body.internalNotes || '').slice(0, 2000);

    const result = await supabaseDbRequest('career_interviews', `id=eq.${encodeURIComponent(interviewId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: patch
    });

    if (!result.ok) {
      sendJson(res, 502, { ok: false, message: 'Failed to update interview.' });
      return;
    }

    // If cancelled, delete Zoom meeting
    if (patch.status === 'cancelled') {
      const row = result.data && result.data[0];
      if (row && row.zoom_meeting_id && isZoomConfigured()) {
        deleteZoomMeeting(row.zoom_meeting_id).catch(() => {});
      }
      // Notify GP
      if (row && row.user_id) {
        pushCareerNotificationToUser(row.user_id, {
          type: 'info',
          title: 'Interview Cancelled',
          body: 'Your scheduled interview has been cancelled. GP Link will follow up with next steps.'
        }).catch(() => {});
        sendPushNotification(row.user_id, {
          title: 'Interview Cancelled',
          body: 'Your scheduled interview has been cancelled. GP Link will follow up with next steps.',
          data: { type: 'career', action: 'interview_cancelled', url: '/pages/career.html#applications' }
        }).catch(() => {});
      }
    }

    sendJson(res, 200, { ok: true, interview: result.data && result.data[0] ? result.data[0] : null });
    return;
  }

  // ── Onboarding endpoints ──────────────────────────────────────
  if (pathname === '/api/onboarding/save' && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;
    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }

    if (isSupabaseDbConfigured()) {
      const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
      if (userId) {
        const remote = await getSupabaseUserStateByEmail(email);
        const current = remote && remote.state && typeof remote.state === 'object' ? remote.state : {};
        current.gp_onboarding = body;
        await upsertSupabaseUserState(userId, current, new Date().toISOString());
      }
    } else {
      const dbState = loadDbState();
      if (!dbState.userState[email]) dbState.userState[email] = {};
      dbState.userState[email].gp_onboarding = body;
      saveDbState(dbState);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/onboarding/complete' && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;
    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }

    // Save complete onboarding data and mark as done
    let userId = null;
    if (isSupabaseDbConfigured()) {
      userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
      if (userId) {
        const remote = await getSupabaseUserStateByEmail(email);
        const current = remote && remote.state && typeof remote.state === 'object' ? remote.state : {};
        current.gp_onboarding = body;
        current.gp_onboarding_complete = true;
        if (body.accountReviewFlag) {
          current.account_status = 'under_review';
        }
        await upsertSupabaseUserState(userId, current, new Date().toISOString());

        // Also update user profile with onboarding data
        const profileUpdate = {};
        if (body.country) profileUpdate.qualification_country = body.country === 'OTHER' ? body.countryOther : body.country;
        if (body.preferredCity) profileUpdate.preferred_city = body.preferredCity;
        if (body.targetDate) profileUpdate.target_arrival_date = body.targetDate;
        if (body.whoMoving) profileUpdate.who_moving = body.whoMoving;
        if (body.childrenCount) profileUpdate.children_count = body.childrenCount;
        if (Object.keys(profileUpdate).length > 0) {
          profileUpdate.onboarding_completed_at = new Date().toISOString();
          await supabaseDbRequest('user_profiles', `user_id=eq.${encodeURIComponent(userId)}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: profileUpdate
          });
        }
      }
    } else {
      const dbState = loadDbState();
      if (!dbState.userState[email]) dbState.userState[email] = {};
      dbState.userState[email].gp_onboarding = body;
      dbState.userState[email].gp_onboarding_complete = true;
      if (body.accountReviewFlag) {
        dbState.userState[email].account_status = 'under_review';
      }
      if (!dbState.userProfiles[email]) dbState.userProfiles[email] = {};
      if (body.country) dbState.userProfiles[email].qualification_country = body.country === 'OTHER' ? body.countryOther : body.country;
      if (body.preferredCity) dbState.userProfiles[email].preferred_city = body.preferredCity;
      if (body.targetDate) dbState.userProfiles[email].target_arrival_date = body.targetDate;
      if (body.whoMoving) dbState.userProfiles[email].who_moving = body.whoMoving;
      if (body.childrenCount) dbState.userProfiles[email].children_count = body.childrenCount;
      dbState.userProfiles[email].onboarding_completed_at = new Date().toISOString();
      saveDbState(dbState);
    }
    // Create Zoho Recruit Candidate (best-effort, don't block onboarding)
    if (isSupabaseDbConfigured() && isZohoRecruitConfigured() && userId) {
      (async () => {
        try {
          const profile = await supabaseDbRequest('user_profiles', `select=*&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
          const userProfile = profile.ok && Array.isArray(profile.data) && profile.data[0] ? profile.data[0] : {};
          // Only create if not already created
          if (!userProfile.zoho_candidate_id) {
            const candidateResult = await createZohoRecruitCandidate(userId, email, userProfile, body);
            if (candidateResult.ok && candidateResult.zohoId) {
              // Upload documents as attachments
              await uploadDocumentsToZohoCandidate(userId, candidateResult.zohoId);
            }
          }
        } catch (err) {
          // Zoho candidate creation is best-effort
        }
      })();
    }

    sendJson(res, 200, { ok: true, message: 'Onboarding complete.' });
    return;
  }

  if (pathname === '/api/ai/verify-qualification' && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;

    if (!ANTHROPIC_API_KEY) {
      sendJson(res, 503, { ok: false, message: 'AI verification service not configured.' });
      return;
    }

    if (!checkAnthropicBudget()) {
      sendJson(res, 200, { ok: false, queued: true, message: 'Verification capacity reached. Your documents will be reviewed within 24 hours.' });
      return;
    }

    const verifyEmail = getSessionEmail(session);
    if (verifyEmail && !checkUserAiLimit(verifyEmail)) {
      sendJson(res, 429, { ok: false, message: 'You have reached the maximum number of verification attempts today. Please try again tomorrow.' });
      return;
    }

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const { imageBase64, mimeType } = body || {};
    const expectedCountry = sanitizeUserString(body.expectedCountry, 20);
    const documentType = sanitizeUserString(body.documentType, 200);
    const profileName = await resolveVerificationProfileName(session, body.profileName);
    if (!imageBase64 || !documentType || !expectedCountry) {
      sendJson(res, 400, { ok: false, message: 'Missing required fields: imageBase64, documentType, expectedCountry.' });
      return;
    }

    const isPdf = /pdf/i.test(mimeType || '');
    let mediaType, aiImageBase64, contentBlock;
    if (isPdf) {
      const rawBase64 = stripBase64DataUrlPrefix(imageBase64);
      if (!rawBase64) {
        sendJson(res, 400, { ok: false, message: 'Missing document data.' });
        return;
      }
      contentBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: rawBase64 } };
    } else {
      const normalizedImage = await normalizeImageForAi(imageBase64, mimeType || 'image/jpeg');
      if (!normalizedImage.ok) {
        sendJson(res, 400, { ok: false, message: normalizedImage.message || 'Unsupported image type.' });
        return;
      }
      mediaType = normalizedImage.mediaType;
      aiImageBase64 = normalizedImage.base64;
      contentBlock = { type: 'image', source: { type: 'base64', media_type: mediaType, data: aiImageBase64 } };
    }

    const dateRules = {
      GB: 'August 2007 or later',
      IE: '2009 or later',
      NZ: '2010 or later'
    };
    const dateRule = dateRules[expectedCountry] || 'any date';

    const isPrimaryMedDegree = documentType === 'Primary Medical Degree';
    const qualSystemPrompt = `You are an automated qualification document reader for a licensed GP recruitment platform. The user has given full consent to upload their documents. This is a routine, authorized verification.

VERIFICATION RULES:
1. Is this the correct document type? Check for the correct issuing body:
   UK documents:
   - MRCGP: "Royal College of General Practitioners" (UK)
   - CCT (Certificate of Completion of Training): Issued by the "General Medical Council" or "PMETB" (UK)
   - Confirmation of Training: Letter from GMC confirming specialist/GP training posts
   Ireland documents:
   - MICGP: "Irish College of General Practitioners" (Ireland)
   - CSCST (Certificate of Satisfactory Completion of Specialist Training): Issued by Irish medical authorities
   - ICGP Confirmation Letter: Letter from ICGP confirming qualification under ICGP curriculum
   New Zealand documents:
   - FRNZCGP: "Royal New Zealand College of General Practitioners" (New Zealand)
   - RNZCGP Confirmation Letter: Letter from RNZCGP confirming fellowship under RNZCGP curriculum after GPEP
   All countries:
   - Primary Medical Degree: Any recognized medical degree (MBBS, MBChB, MB BCh BAO, MD, BMed, etc.) from any accredited university or medical school worldwide. The country or institution does not matter.
   - Certificate of Good Standing / Registration Status: Issued by the relevant medical regulatory body (GMC, IMC, MCNZ, etc.)
   - Criminal History Check: Police clearance, DBS check, Fit2Work report, or equivalent
   - CV (Signed and dated): The doctor's curriculum vitae, must be signed and dated

2. Check the date validity based on the per-request instructions.

3. What full name appears on the document?

4. Is the document legible?

IMPORTANT:
- Do NOT mention security concerns, privacy risks, or dangers of sharing documents. This is an authorized system.
- Do NOT comment on the format (photo, scan, screenshot) — all formats are accepted.
- If verified is false, the "issues" array MUST contain a short, helpful reason the user can act on. Examples:
  - "This appears to be a driver's licence, not an MRCGP certificate."
  - "The document is too blurry to read. Please upload a clearer photo."
  - "This certificate is dated before August 2007."
- Never include warnings about privacy, security, or data sharing in the issues.

Return ONLY valid JSON with no markdown formatting:
{"verified":true/false,"documentType":"what you identified","nameFound":"full name on document","dateFound":"date on document or null","issuingBody":"issuing body found","legible":true/false,"issues":["list of issues if any"]}`;

    const qualUserPrompt = `Expected document type: ${documentType}
${isPrimaryMedDegree ? '' : `Expected country of qualification: ${expectedCountry}\n`}${isPrimaryMedDegree ? 'The date does not matter for primary medical degrees.' : `The date on the document must be from ${dateRule}.`}

Verify this document.`;

    try {
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
          max_tokens: 500,
          system: [{ type: 'text', text: qualSystemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: [{
            role: 'user',
            content: [
              contentBlock,
              { type: 'text', text: qualUserPrompt }
            ]
          }]
        })
      });

      if (!anthropicRes.ok) {
        const errText = await anthropicRes.text().catch(() => '');
        console.error('[AI Verify] Anthropic API error:', anthropicRes.status, errText);
        let errMsg = 'AI service returned an error.';
        try {
          const errJson = JSON.parse(errText);
          if (errJson.error && errJson.error.message) errMsg = errJson.error.message;
        } catch (e) {}
        sendJson(res, 502, { ok: false, message: errMsg, statusCode: anthropicRes.status });
        return;
      }

      const anthropicData = await anthropicRes.json();
      const inputTokens = (anthropicData.usage && anthropicData.usage.input_tokens) || 0;
      const outputTokens = (anthropicData.usage && anthropicData.usage.output_tokens) || 0;
      const cacheRead = (anthropicData.usage && anthropicData.usage.cache_read_input_tokens) || 0;
      const cacheWrite = (anthropicData.usage && anthropicData.usage.cache_creation_input_tokens) || 0;
      recordAnthropicSpend(inputTokens, outputTokens, cacheRead, cacheWrite);
      if (verifyEmail) recordUserAiCall(verifyEmail);

      const textContent = anthropicData.content && anthropicData.content[0] && anthropicData.content[0].text;
      if (!textContent) {
        sendJson(res, 502, { ok: false, message: 'AI returned empty response.' });
        return;
      }

      let verification;
      try {
        const jsonMatch = textContent.match(/\{[\s\S]*\}/);
        verification = JSON.parse(jsonMatch ? jsonMatch[0] : textContent);
      } catch (parseErr) {
        console.error('[AI Verify] JSON parse failed:', textContent);
        sendJson(res, 502, { ok: false, message: 'AI returned invalid response format.' });
        return;
      }

      // Name matching — check against profile name AND previously verified documents
      let verifiedNames = [];
      if (verifyEmail && isSupabaseDbConfigured()) {
        try {
          const userState = await getSupabaseUserStateByEmail(verifyEmail);
          const onboarding = userState && userState.state && userState.state.gp_onboarding;
          verifiedNames = getVerifiedDocumentNames(onboarding);
        } catch (e) { /* non-critical — proceed with profile name only */ }
      }

      applyQualificationNameMatchPolicy(verification, profileName, verifiedNames);

      // Server-side date enforcement — don't trust AI alone
      if (verification.verified && !isPrimaryMedDegree && verification.dateFound && expectedCountry !== 'any') {
        const dateCutoffs = { GB: '2007-08-01', IE: '2009-01-01', NZ: '2010-01-01' };
        const cutoff = dateCutoffs[expectedCountry];
        if (cutoff) {
          try {
            const docDate = new Date(verification.dateFound);
            const cutoffDate = new Date(cutoff);
            if (!isNaN(docDate.getTime()) && docDate < cutoffDate) {
              verification.verified = false;
              verification.issues = verification.issues || [];
              verification.issues.push('This document is dated ' + verification.dateFound + ', which is before the required date (' + dateRule + ') for the ' + expectedCountry + ' pathway.');
            }
          } catch (e) { /* non-critical — AI flagging is the fallback */ }
        }
      }

      sendJson(res, 200, {
        ok: true,
        verification,
        spend: { todayUsd: Math.round(anthropicDailySpend.totalCostUsd * 100) / 100, callCount: anthropicDailySpend.callCount },
        unlimitedRetries: AI_VERIFY_UNLIMITED_EMAILS.has((verifyEmail || '').toLowerCase())
      });
    } catch (fetchErr) {
      console.error('[AI Verify] Fetch error:', fetchErr.message || fetchErr);
      sendJson(res, 502, { ok: false, message: 'Failed to connect to AI service.' });
    }
    return;
  }

  /* ── Certification verification (checks if a document has been properly certified) ── */
  if (pathname === '/api/ai/verify-certification' && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;

    if (!ANTHROPIC_API_KEY) {
      sendJson(res, 503, { ok: false, message: 'AI verification service not configured.' });
      return;
    }

    if (!checkAnthropicBudget()) {
      sendJson(res, 200, { ok: false, queued: true, message: 'Verification capacity reached. Your document will be reviewed manually within 24 hours.' });
      return;
    }

    const certEmail = getSessionEmail(session);
    if (certEmail && !checkUserAiLimit(certEmail)) {
      sendJson(res, 429, { ok: false, message: 'You have reached the maximum number of verification attempts today. Please try again tomorrow.' });
      return;
    }

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const { imageBase64, mimeType } = body || {};
    const documentType = sanitizeUserString(body.documentType, 200);
    if (!imageBase64) {
      sendJson(res, 400, { ok: false, message: 'Missing required field: imageBase64.' });
      return;
    }

    const isPdf = /pdf/i.test(mimeType || '');
    let contentBlock;
    if (isPdf) {
      const rawBase64 = stripBase64DataUrlPrefix(imageBase64);
      if (!rawBase64) {
        sendJson(res, 400, { ok: false, message: 'Missing document data.' });
        return;
      }
      contentBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: rawBase64 } };
    } else {
      const normalizedImage = await normalizeImageForAi(imageBase64, mimeType || 'image/jpeg');
      if (!normalizedImage.ok) {
        sendJson(res, 400, { ok: false, message: normalizedImage.message || 'Unsupported image type.' });
        return;
      }
      contentBlock = { type: 'image', source: { type: 'base64', media_type: normalizedImage.mediaType, data: normalizedImage.base64 } };
    }

    const certSystemPrompt = `You are an automated document certification checker for a licensed GP recruitment platform. The user has given full consent to upload their documents. This is a routine, authorized check.

Your job is to check whether the document shows evidence of proper certification by a solicitor, public notary, or authorised certifier. A properly certified document should have MOST of the following written, stamped, or printed on the copy:

1. CERTIFICATION STATEMENT - Words like "I certify this to be a true copy of the original" or similar
2. SIGNATURE - A handwritten signature from the certifier
3. CERTIFIER'S NAME - The certifier's printed full name
4. DATE - The date of certification
5. OCCUPATION/PROFESSION - The certifier's occupation (solicitor, notary, JP, etc.)
6. CONTACT DETAILS - Phone number or registration/profession number
7. STAMP/SEAL - An official stamp or seal (not always required)

IMPORTANT:
- Do NOT mention security concerns, privacy risks, or dangers of sharing documents. This is an authorized system.
- Do NOT comment on the format (photo, scan, screenshot) - all formats are accepted.
- If the document appears to be an ORIGINAL certificate without any certification markings, that counts as NOT certified.
- Be lenient: if you can see clear evidence of at least a certification statement + signature + name, consider it certified even if some minor elements are missing.
- If certified is false, the "issues" array MUST contain short, helpful reasons the user can act on.

Return ONLY valid JSON with no markdown formatting:
{"certified":true,"statementPresent":true,"signaturePresent":true,"certifierName":"name or null","certifierOccupation":"occupation or null","certifierDate":"date or null","contactPresent":true,"stampPresent":true,"issues":[]}`;

    const certUserPrompt = `The user has uploaded what should be a CERTIFIED COPY of: ${documentType || 'a qualification document'}

Check this document for certification markings.`;

    try {
      const certRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
          max_tokens: 300,
          system: [{ type: 'text', text: certSystemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: [{
            role: 'user',
            content: [
              contentBlock,
              { type: 'text', text: certUserPrompt }
            ]
          }]
        })
      });

      if (!certRes.ok) {
        const errText = await certRes.text().catch(() => '');
        console.error('[AI CertCheck] Anthropic API error:', certRes.status, errText);
        let errMsg = 'AI service returned an error.';
        try {
          const errJson = JSON.parse(errText);
          if (errJson.error && errJson.error.message) errMsg = errJson.error.message;
        } catch (e) {}
        sendJson(res, 502, { ok: false, message: errMsg, statusCode: certRes.status });
        return;
      }

      const certData = await certRes.json();
      const certInputTokens = (certData.usage && certData.usage.input_tokens) || 0;
      const certOutputTokens = (certData.usage && certData.usage.output_tokens) || 0;
      const certCacheRead = (certData.usage && certData.usage.cache_read_input_tokens) || 0;
      const certCacheWrite = (certData.usage && certData.usage.cache_creation_input_tokens) || 0;
      recordAnthropicSpend(certInputTokens, certOutputTokens, certCacheRead, certCacheWrite);
      if (certEmail) recordUserAiCall(certEmail);

      const certText = certData.content && certData.content[0] && certData.content[0].text;
      if (!certText) {
        sendJson(res, 502, { ok: false, message: 'AI returned empty response.' });
        return;
      }

      let certVerification;
      try {
        const jsonMatch = certText.match(/\{[\s\S]*\}/);
        certVerification = JSON.parse(jsonMatch ? jsonMatch[0] : certText);
      } catch (parseErr) {
        console.error('[AI CertCheck] JSON parse failed:', certText);
        sendJson(res, 502, { ok: false, message: 'AI returned invalid response format.' });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        verification: certVerification,
        spend: { todayUsd: Math.round(anthropicDailySpend.totalCostUsd * 100) / 100, callCount: anthropicDailySpend.callCount }
      });
    } catch (fetchErr) {
      console.error('[AI CertCheck] Fetch error:', fetchErr.message || fetchErr);
      sendJson(res, 502, { ok: false, message: 'Failed to connect to AI service.' });
    }
    return;
  }

  /* ── AI Document Classification (Claude Vision — images + PDFs) ── */
  if (pathname === '/api/ai/classify-document' && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;

    if (!ANTHROPIC_API_KEY) {
      sendJson(res, 503, { ok: false, message: 'AI verification service not configured.' });
      return;
    }

    if (!checkAnthropicBudget()) {
      sendJson(res, 200, { ok: false, message: 'Verification capacity reached. Please try again later.' });
      return;
    }

    const classifyEmail = getSessionEmail(session);
    if (classifyEmail && !checkUserAiLimit(classifyEmail)) {
      sendJson(res, 429, { ok: false, message: 'You have reached the maximum number of verification attempts today. Please try again tomorrow.' });
      return;
    }

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const { fileBase64, mimeType } = body || {};
    const expectedKey = sanitizeUserString(body.expectedKey, 100);
    const expectedLabel = sanitizeUserString(body.expectedLabel, 200);
    if (!fileBase64 || !expectedKey || !expectedLabel) {
      sendJson(res, 400, { ok: false, message: 'Missing required fields.' });
      return;
    }

    /* Build the content block — image or document (PDF) */
    const isPdf = /pdf/i.test(mimeType || '');
    let contentBlock;
    if (isPdf) {
      contentBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } };
    } else {
      const normalizedImage = await normalizeImageForAi(fileBase64, mimeType || 'image/jpeg');
      if (!normalizedImage.ok) {
        sendJson(res, 400, { ok: false, message: normalizedImage.message || 'Unsupported file type for AI classification.' });
        return;
      }
      contentBlock = { type: 'image', source: { type: 'base64', media_type: normalizedImage.mediaType, data: normalizedImage.base64 } };
    }

    const classifySystemPrompt = `You are an automated document classifier for a licensed GP recruitment platform. The user has given full consent to upload their documents. This is a routine, authorized check.

Your job is to determine whether a document matches what the user claims it is, or something else entirely.

Valid document types and what they look like:
- Primary Medical Degree: MBBS, MBChB, MB BCh BAO, MD, BMed certificate from a university/medical school
- MRCGP: Certificate from Royal College of General Practitioners (UK)
- CCT: Certificate of Completion of Training from GMC or PMETB (UK)
- MICGP: Certificate from Irish College of General Practitioners
- CSCST: Certificate of Satisfactory Completion of Specialist Training (Ireland)
- ICGP Confirmation Letter: Letter from ICGP confirming qualification
- FRNZCGP: Fellowship certificate from Royal New Zealand College of General Practitioners
- RNZCGP Confirmation Letter: Letter from RNZCGP confirming fellowship
- Certificate of Good Standing: Registration status document from a medical regulatory body (GMC, IMC, MCNZ, etc.)
- Criminal History Check: Police clearance, DBS check, Fit2Work report, or equivalent
- CV (Signed and dated): A doctor's curriculum vitae / resume that is visibly signed and dated
- Confirmation of Training: Letter from GMC or equivalent confirming training posts

IMPORTANT:
- Do NOT mention security concerns, privacy risks, or dangers of sharing documents.
- Focus ONLY on whether the document matches what the user claims it is.
- If it is clearly a different type of document, identify what it actually appears to be.
- If the expected document is "CV (Signed and dated)", return "matches": true only when the file is clearly a CV/resume and it appears signed and dated. If it is a CV missing a visible signature or date, return "matches": false and explain that it appears to be an unsigned or undated CV.

Return ONLY valid JSON with no markdown formatting:
{"matches": true/false, "identifiedAs": "what the document actually appears to be", "reason": "brief explanation"}`;

    const classifyUserPrompt = `The user is trying to upload a document for: ${expectedLabel}

Classify this document.`;

    try {
      const classifyRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
          max_tokens: 150,
          system: [{ type: 'text', text: classifySystemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: [{
            role: 'user',
            content: [
              contentBlock,
              { type: 'text', text: classifyUserPrompt }
            ]
          }]
        })
      });

      if (!classifyRes.ok) {
        const errText = await classifyRes.text().catch(() => '');
        console.error('[AI Classify] Anthropic API error:', classifyRes.status, errText);
        let errMsg = 'AI service returned an error.';
        try { const ej = JSON.parse(errText); if (ej.error && ej.error.message) errMsg = ej.error.message; } catch (e) {}
        sendJson(res, 502, { ok: false, message: errMsg });
        return;
      }

      const classifyData = await classifyRes.json();
      const cInputTokens = (classifyData.usage && classifyData.usage.input_tokens) || 0;
      const cOutputTokens = (classifyData.usage && classifyData.usage.output_tokens) || 0;
      const cCacheRead = (classifyData.usage && classifyData.usage.cache_read_input_tokens) || 0;
      const cCacheWrite = (classifyData.usage && classifyData.usage.cache_creation_input_tokens) || 0;
      recordAnthropicSpend(cInputTokens, cOutputTokens, cCacheRead, cCacheWrite);
      if (classifyEmail) recordUserAiCall(classifyEmail);

      const classifyText = classifyData.content && classifyData.content[0] && classifyData.content[0].text;
      if (!classifyText) {
        sendJson(res, 502, { ok: false, message: 'AI returned empty response.' });
        return;
      }

      let classifyResult;
      try {
        const jm = classifyText.match(/\{[\s\S]*\}/);
        classifyResult = JSON.parse(jm ? jm[0] : classifyText);
      } catch (parseErr) {
        console.error('[AI Classify] JSON parse failed:', classifyText);
        sendJson(res, 502, { ok: false, message: 'AI returned invalid response format.' });
        return;
      }

      sendJson(res, 200, { ok: true, classification: classifyResult });
    } catch (fetchErr) {
      console.error('[AI Classify] Fetch error:', fetchErr.message || fetchErr);
      sendJson(res, 502, { ok: false, message: 'Failed to connect to AI service.' });
    }
    return;
  }

  if (pathname === '/api/account/status' && req.method === 'GET') {
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false }); return; }

    let accountStatus = 'active';
    if (isSupabaseDbConfigured()) {
      try {
        const remote = await getSupabaseUserStateByEmail(email);
        if (remote && remote.state && remote.state.account_status) {
          accountStatus = remote.state.account_status;
        }
      } catch (e) { /* ignore */ }
    } else {
      const dbState = loadDbState();
      if (dbState.userState[email] && dbState.userState[email].account_status) {
        accountStatus = dbState.userState[email].account_status;
      }
    }
    sendJson(res, 200, { ok: true, accountStatus });
    return;
  }

  // Admin: set account status (for testing restricted mode)
  if (pathname === '/api/account/set-status' && (req.method === 'POST' || req.method === 'GET')) {
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;

    let targetEmail, status;
    if (req.method === 'GET') {
      const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      targetEmail = requestUrl.searchParams.get('email');
      status = requestUrl.searchParams.get('status');
    } else {
      let body;
      try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, message: 'Invalid request body.' }); return; }
      targetEmail = body.email;
      status = body.status;
    }
    // Validate status value to prevent arbitrary state injection
    const ALLOWED_STATUSES = ['active', 'under_review', 'suspended'];
    if (!ALLOWED_STATUSES.includes(status)) {
      sendJson(res, 400, { ok: false, message: 'Invalid status. Allowed: ' + ALLOWED_STATUSES.join(', ') });
      return;
    }
    targetEmail = String(targetEmail || '').trim().toLowerCase();
    if (!targetEmail || !isValidEmail(targetEmail) || !status) {
      sendJson(res, 400, { ok: false, message: 'email and status required' });
      return;
    }

    async function setAccountStatus(email, newStatus) {
      if (isSupabaseDbConfigured()) {
        try {
          const remote = await getSupabaseUserStateByEmail(email);
          if (remote && remote.userId) {
            const newState = remote.state || {};
            newState.account_status = newStatus;
            await upsertSupabaseUserState(remote.userId, newState, new Date().toISOString());
          }
        } catch (e) {
          console.error('[SetStatus] Supabase error:', e.message);
        }
      } else {
        const dbState = loadDbState();
        if (!dbState.userState[email]) dbState.userState[email] = {};
        dbState.userState[email].account_status = newStatus;
        saveDbState(dbState);
      }
    }

    await setAccountStatus(targetEmail, status);

    // If setting to under_review, auto-revert to active after 5 minutes
    if (status === 'under_review') {
      setTimeout(async () => {
        try {
          await setAccountStatus(targetEmail, 'active');
          console.log('[SetStatus] Auto-reverted ' + targetEmail + ' to active after 5 minutes');
        } catch (e) {
          console.error('[SetStatus] Auto-revert error:', e.message);
        }
      }, 5 * 60 * 1000);
    }

    if (req.method === 'GET') {
      res.writeHead(302, { Location: '/pages/index.html' });
      res.end();
    } else {
      sendJson(res, 200, { ok: true, accountStatus: status });
    }
    return;
  }

  if (pathname === '/api/ai/verify-identity' && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;

    if (!ANTHROPIC_API_KEY) {
      sendJson(res, 503, { ok: false, message: 'AI verification service not configured.' });
      return;
    }

    if (!checkAnthropicBudget()) {
      sendJson(res, 200, { ok: false, message: 'Verification capacity reached. Please try again later.' });
      return;
    }

    const verifyEmail = getSessionEmail(session);
    if (verifyEmail && !checkUserAiLimit(verifyEmail)) {
      sendJson(res, 429, { ok: false, message: 'Maximum verification attempts reached today. Please try again tomorrow.' });
      return;
    }

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const { imageBase64, mimeType } = body || {};
    const qualificationName = sanitizeUserString(body.qualificationName, 200);
    const profileName = await resolveVerificationProfileName(session, body.profileName);
    if (!imageBase64) {
      sendJson(res, 400, { ok: false, message: 'Missing image data.' });
      return;
    }

    const normalizedImage = await normalizeImageForAi(imageBase64, mimeType || 'image/jpeg');
    if (!normalizedImage.ok) {
      sendJson(res, 400, { ok: false, message: normalizedImage.message || 'Unsupported image type.' });
      return;
    }
    const mediaType = normalizedImage.mediaType;
    const aiImageBase64 = normalizedImage.base64;

    const idSystemPrompt = `You are an automated identity document reader for a licensed GP recruitment platform. The user has given full consent to upload their ID for name verification. This is a routine, authorized identity check.

YOUR ONLY JOB:
1. Identify whether this is a passport or driver's licence.
2. Extract the full name on the document.
3. Check if the document is legible.
4. Check if the document has expired. Look for an expiry date / date of expiry / valid until field. Today's date is ${new Date().toISOString().slice(0, 10)}.

IMPORTANT RULES:
- Do NOT mention security concerns, privacy risks, or dangers of sharing identity documents. This is an authorized verification system.
- Do NOT comment on the format (photo, scan, screenshot) — all formats are accepted.
- If the document has expired, mark verified as false and include the expiry date in the issues.
- If it is a passport or driver's licence, mark verified as true as long as you can read the name AND the document is not expired.
- Mark verified as false if it is NOT a passport or driver's licence, or if the name is completely unreadable, or if the document has expired.
- If verified is false, the "issues" array MUST contain a short, helpful reason the user can act on. Examples:
  - "This appears to be a medical certificate, not a passport or driver's licence."
  - "The name on the document is not readable. Please upload a clearer photo."
  - "This does not appear to be an identity document."
  - "This document expired on 2024-03-15. Please upload a valid, non-expired ID."
- Never include warnings about privacy, security, or data sharing in the issues.

Return ONLY valid JSON with no markdown formatting:
{"verified":true/false,"documentType":"passport or drivers_licence or other","nameFound":"full name on document","expiryDate":"YYYY-MM-DD or null","expired":true/false,"legible":true/false,"issues":["list of issues if any"]}`;

    const idUserPrompt = 'Verify this ID document.';

    try {
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
          max_tokens: 200,
          system: [{ type: 'text', text: idSystemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: aiImageBase64 } },
              { type: 'text', text: idUserPrompt }
            ]
          }]
        })
      });

      if (!anthropicRes.ok) {
        const errText = await anthropicRes.text().catch(() => '');
        console.error('[ID Verify] Anthropic API error:', anthropicRes.status, errText);
        let errMsg = 'AI service returned an error.';
        try { const ej = JSON.parse(errText); if (ej.error && ej.error.message) errMsg = ej.error.message; } catch (e) {}
        sendJson(res, 502, { ok: false, message: errMsg });
        return;
      }

      const anthropicData = await anthropicRes.json();
      const inputTokens = (anthropicData.usage && anthropicData.usage.input_tokens) || 0;
      const outputTokens = (anthropicData.usage && anthropicData.usage.output_tokens) || 0;
      const idCacheRead = (anthropicData.usage && anthropicData.usage.cache_read_input_tokens) || 0;
      const idCacheWrite = (anthropicData.usage && anthropicData.usage.cache_creation_input_tokens) || 0;
      recordAnthropicSpend(inputTokens, outputTokens, idCacheRead, idCacheWrite);
      if (verifyEmail) recordUserAiCall(verifyEmail);

      const textContent = anthropicData.content && anthropicData.content[0] && anthropicData.content[0].text;
      if (!textContent) {
        sendJson(res, 502, { ok: false, message: 'AI returned empty response.' });
        return;
      }

      let verification;
      try {
        const jsonMatch = textContent.match(/\{[\s\S]*\}/);
        verification = JSON.parse(jsonMatch ? jsonMatch[0] : textContent);
      } catch (parseErr) {
        console.error('[ID Verify] JSON parse failed:', textContent);
        sendJson(res, 502, { ok: false, message: 'AI returned invalid response.' });
        return;
      }

      // Check document type is passport or licence
      const docType = String(verification.documentType || '').toLowerCase();
      if (docType !== 'passport' && docType !== 'drivers_licence' && docType !== "driver's licence" && docType !== 'drivers licence') {
        verification.verified = false;
        verification.issues = verification.issues || [];
        verification.issues.push('Please upload a passport or driver\'s licence. This appears to be: ' + (verification.documentType || 'unknown'));
      }

      // Server-side expiry enforcement — don't trust AI alone
      if (verification.verified && verification.expiryDate) {
        try {
          const expiry = new Date(verification.expiryDate);
          if (!isNaN(expiry.getTime()) && expiry < new Date()) {
            verification.verified = false;
            verification.expired = true;
            verification.issues = verification.issues || [];
            verification.issues.push('This document expired on ' + verification.expiryDate + '. Please upload a valid, non-expired ID.');
          }
        } catch (e) { /* non-critical — AI flagging is the fallback */ }
      }

      // Name matching against profile, qualification name, AND previously verified documents
      if (verification.verified && verification.nameFound) {
        const idName = verification.nameFound;

        // Gather all known names to check against
        const namesToCheck = [];
        if (qualificationName) namesToCheck.push(qualificationName);
        if (profileName) namesToCheck.push(profileName);

        // Fetch previously verified document names from onboarding state
        const verifyEmail = getSessionEmail(session);
        if (verifyEmail && isSupabaseDbConfigured()) {
          try {
            const userState = await getSupabaseUserStateByEmail(verifyEmail);
            const onboarding = userState && userState.state && userState.state.gp_onboarding;
            const prevNames = getVerifiedDocumentNames(onboarding);
            namesToCheck.push(...prevNames);
          } catch (e) { /* non-critical */ }
        }

        const hasReferenceNames = namesToCheck.length > 0;
        const nameCheck = crossCheckDocumentName(idName, profileName, namesToCheck);
        verification.nameMatch = nameCheck.match;
        verification.nameMatchedAgainst = nameCheck.matchedAgainst;
        if (nameCheck.match === 'mismatch') {
          verification.verified = false;
          verification.issues = verification.issues || [];
          verification.issues.push('Name on ID does not match your profile name or previously verified documents. Please upload an ID with the same name as your qualifications.');
        } else if (hasReferenceNames && !isConfirmedNameMatch(nameCheck.match)) {
          verification.verified = false;
          verification.issues = verification.issues || [];
          verification.issues.push('We could not confidently match the full name on your ID to your account or verified documents. Please upload a clearer photo showing the full name.');
        }
      }

      sendJson(res, 200, { ok: true, verification });
    } catch (fetchErr) {
      console.error('[ID Verify] Fetch error:', fetchErr.message || fetchErr);
      sendJson(res, 502, { ok: false, message: 'Failed to connect to AI service.' });
    }
    return;
  }

  if (pathname === '/api/support/qualification-help' && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'No session.' }); return; }

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request.' });
      return;
    }

    const docType = String(body.documentType || 'Qualification').slice(0, 100);
    const issues = Array.isArray(body.issues) ? body.issues.map(i => String(i).slice(0, 300)).join('; ') : '';
    const country = String(body.country || '').slice(0, 10);

    const ticketId = 'case_qual_' + Date.now();
    const now = new Date().toISOString();
    const ticket = {
      id: ticketId,
      title: 'Qualification Verification Help — ' + docType,
      category: 'Qualification Verification',
      status: 'open',
      priority: 'normal',
      unread: true,
      createdAt: now,
      updatedAt: now,
      thread: [{
        from: email,
        text: 'I need help verifying my ' + docType + ' (country: ' + country + '). AI scan issues: ' + (issues || 'None specified') + '. Please assist with manual verification.',
        ts: now
      }]
    };

    // Save ticket to user state
    if (isSupabaseDbConfigured()) {
      try {
        const stateRes = await fetch(`${SUPABASE_URL}/rest/v1/user_state?user_id=eq.${encodeURIComponent(session.user_id || '')}`, {
          headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
        });
        const rows = await stateRes.json();
        const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
        const existingState = (row && row.state && typeof row.state === 'object') ? row.state : {};
        const parsedCases = parseJsonLike(existingState.gpLinkSupportCases);
        const cases = Array.isArray(parsedCases) ? parsedCases : [];
        cases.push(ticket);

        const nextState = {
          ...existingState,
          gpLinkSupportCases: JSON.stringify(cases),
          account_status: 'under_review',
          updatedAt: now
        };
        await upsertSupabaseUserState(session.user_id || row?.user_id, nextState, now);
      } catch (e) { console.error('[SupportTicket] Supabase error:', e.message); }
    } else {
      const dbState = loadDbState();
      const userState = dbState.userState[email] || {};
      const parsedCases = parseJsonLike(userState.gpLinkSupportCases);
      const cases = Array.isArray(parsedCases) ? parsedCases : [];
      cases.push(ticket);
      userState.gpLinkSupportCases = JSON.stringify(cases);
      userState.account_status = 'under_review';
      userState.updatedAt = now;
      dbState.userState[email] = userState;
      saveDbState(dbState);
    }

    invalidateAdminDashboardCache();
    console.log(`[SupportTicket] Created qualification help ticket ${ticketId} for ${email}`);
    sendJson(res, 200, { ok: true, ticketId });
    return;
  }

  // ─── SUPPORT TICKET CRUD ───────────────────────────────────────────
  // GET /api/support/tickets — list current user's tickets
  if (pathname === '/api/support/tickets' && req.method === 'GET') {
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'No session.' }); return; }

    let cases = [];
    if (isSupabaseDbConfigured()) {
      try {
        const remote = await getSupabaseUserStateByEmail(email);
        const st = remote && remote.state ? remote.state : {};
        const parsed = parseJsonLike(st.gpLinkSupportCases);
        cases = Array.isArray(parsed) ? parsed : [];
      } catch (e) { console.error('[SupportTickets] Supabase read error:', e.message); }
    } else {
      const dbState = loadDbState();
      const userState = dbState.userState[email] || {};
      const parsed = parseJsonLike(userState.gpLinkSupportCases);
      cases = Array.isArray(parsed) ? parsed : [];
    }
    sendJson(res, 200, { ok: true, tickets: cases });
    return;
  }

  // POST /api/support/tickets — create a new ticket
  if (pathname === '/api/support/tickets' && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'No session.' }); return; }

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request.' });
      return;
    }

    const now = new Date().toISOString();
    const ticket = {
      id: typeof body.id === 'string' && body.id ? body.id : ('case_' + Date.now() + '_' + Math.floor(Math.random() * 1000)),
      caseCode: typeof body.caseCode === 'string' && body.caseCode ? body.caseCode : ('Case GP-' + now.slice(0, 10).replace(/-/g, '') + '-' + String(Math.floor(Math.random() * 1000)).padStart(3, '0')),
      title: String(body.title || 'Support request').slice(0, 200),
      category: ['EPIC', 'AMC', 'Documents', 'AHPRA', 'Provider', 'Contract', 'Other'].includes(body.category) ? body.category : 'Other',
      priority: ['normal', 'blocked', 'time_sensitive'].includes(body.priority) ? body.priority : 'normal',
      status: 'open',
      unread: false,
      createdAt: now,
      updatedAt: now,
      thread: Array.isArray(body.thread) ? body.thread.slice(0, 1).map(e => ({
        from: 'me',
        text: String(e && e.text || '').slice(0, 5000),
        ts: now,
        attachments: []
      })) : []
    };

    if (isSupabaseDbConfigured()) {
      try {
        const remote = await getSupabaseUserStateByEmail(email);
        const st = remote && remote.state ? remote.state : {};
        const parsed = parseJsonLike(st.gpLinkSupportCases);
        const cases = Array.isArray(parsed) ? parsed : [];
        cases.unshift(ticket);
        const nextState = { ...st, gpLinkSupportCases: JSON.stringify(cases), updatedAt: now };
        await upsertSupabaseUserState(remote ? (remote.userId || session.user_id) : session.user_id, nextState, now);
      } catch (e) { console.error('[SupportTickets] Supabase write error:', e.message); }
    } else {
      const dbState = loadDbState();
      const userState = dbState.userState[email] || {};
      const parsed = parseJsonLike(userState.gpLinkSupportCases);
      const cases = Array.isArray(parsed) ? parsed : [];
      cases.unshift(ticket);
      userState.gpLinkSupportCases = JSON.stringify(cases);
      userState.updatedAt = now;
      dbState.userState[email] = userState;
      saveDbState(dbState);
    }

    invalidateAdminDashboardCache();
    console.log(`[SupportTickets] Created ticket ${ticket.id} for ${email}`);
    sendJson(res, 200, { ok: true, ticket });
    return;
  }

  // POST /api/support/tickets/:id/messages — add a message to a ticket
  const ticketMsgMatch = pathname.match(/^\/api\/support\/tickets\/([^/]+)\/messages$/);
  if (ticketMsgMatch && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'No session.' }); return; }

    const ticketId = decodeURIComponent(ticketMsgMatch[1] || '').trim();
    if (!ticketId) { sendJson(res, 400, { ok: false, message: 'Invalid ticket id.' }); return; }

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request.' });
      return;
    }

    const text = String(body.text || '').trim().slice(0, 5000);
    if (!text) { sendJson(res, 400, { ok: false, message: 'Message text required.' }); return; }
    const from = body.from === 'gp' ? 'gp' : 'me';
    const now = new Date().toISOString();

    function addMessageToCase(cases) {
      const idx = cases.findIndex(c => c && String(c.id || '') === ticketId);
      if (idx === -1) return null;
      if (!Array.isArray(cases[idx].thread)) cases[idx].thread = [];
      cases[idx].thread.push({ from, text, ts: now, attachments: [] });
      cases[idx].updatedAt = now;
      if (from === 'gp') cases[idx].unread = true;
      return cases[idx];
    }

    let updatedCase = null;
    if (isSupabaseDbConfigured()) {
      try {
        const remote = await getSupabaseUserStateByEmail(email);
        const st = remote && remote.state ? remote.state : {};
        const parsed = parseJsonLike(st.gpLinkSupportCases);
        const cases = Array.isArray(parsed) ? parsed : [];
        updatedCase = addMessageToCase(cases);
        if (updatedCase) {
          const nextState = { ...st, gpLinkSupportCases: JSON.stringify(cases), updatedAt: now };
          await upsertSupabaseUserState(remote ? (remote.userId || session.user_id) : session.user_id, nextState, now);
        }
      } catch (e) { console.error('[SupportTickets] Message add error:', e.message); }
    } else {
      const dbState = loadDbState();
      const userState = dbState.userState[email] || {};
      const parsed = parseJsonLike(userState.gpLinkSupportCases);
      const cases = Array.isArray(parsed) ? parsed : [];
      updatedCase = addMessageToCase(cases);
      if (updatedCase) {
        userState.gpLinkSupportCases = JSON.stringify(cases);
        userState.updatedAt = now;
        dbState.userState[email] = userState;
        saveDbState(dbState);
      }
    }

    if (!updatedCase) { sendJson(res, 404, { ok: false, message: 'Ticket not found.' }); return; }
    invalidateAdminDashboardCache();
    sendJson(res, 200, { ok: true, ticket: updatedCase });
    return;
  }

  // PUT /api/support/tickets/:id/status — update ticket status
  const ticketStatusMatch = pathname.match(/^\/api\/support\/tickets\/([^/]+)\/status$/);
  if (ticketStatusMatch && req.method === 'PUT') {
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'No session.' }); return; }

    const ticketId = decodeURIComponent(ticketStatusMatch[1] || '').trim();
    if (!ticketId) { sendJson(res, 400, { ok: false, message: 'Invalid ticket id.' }); return; }

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request.' });
      return;
    }

    const status = body.status === 'closed' ? 'closed' : 'open';
    const now = new Date().toISOString();

    function updateCaseStatus(cases) {
      const idx = cases.findIndex(c => c && String(c.id || '') === ticketId);
      if (idx === -1) return null;
      cases[idx].status = status;
      cases[idx].updatedAt = now;
      return cases[idx];
    }

    let updatedCase = null;
    if (isSupabaseDbConfigured()) {
      try {
        const remote = await getSupabaseUserStateByEmail(email);
        const st = remote && remote.state ? remote.state : {};
        const parsed = parseJsonLike(st.gpLinkSupportCases);
        const cases = Array.isArray(parsed) ? parsed : [];
        updatedCase = updateCaseStatus(cases);
        if (updatedCase) {
          const nextState = { ...st, gpLinkSupportCases: JSON.stringify(cases), updatedAt: now };
          await upsertSupabaseUserState(remote ? (remote.userId || session.user_id) : session.user_id, nextState, now);
        }
      } catch (e) { console.error('[SupportTickets] Status update error:', e.message); }
    } else {
      const dbState = loadDbState();
      const userState = dbState.userState[email] || {};
      const parsed = parseJsonLike(userState.gpLinkSupportCases);
      const cases = Array.isArray(parsed) ? parsed : [];
      updatedCase = updateCaseStatus(cases);
      if (updatedCase) {
        userState.gpLinkSupportCases = JSON.stringify(cases);
        userState.updatedAt = now;
        dbState.userState[email] = userState;
        saveDbState(dbState);
      }
    }

    if (!updatedCase) { sendJson(res, 404, { ok: false, message: 'Ticket not found.' }); return; }
    invalidateAdminDashboardCache();
    sendJson(res, 200, { ok: true, ticket: updatedCase });
    return;
  }

  // ─── ADMIN TICKET ENDPOINTS ────────────────────────────────────────
  // GET /api/admin/tickets — list ALL tickets across all users (admin only)
  if (pathname === '/api/admin/tickets' && req.method === 'GET') {
    const adminSession = requireAdminSession(req, res);
    if (!adminSession) return;

    const tickets = [];
    if (isSupabaseDbConfigured()) {
      try {
        const allStatesRes = await fetch(`${SUPABASE_URL}/rest/v1/user_state?select=user_id,state,updated_at`, {
          headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
        });
        const allStates = await allStatesRes.json().catch(() => []);
        if (Array.isArray(allStates)) {
          allStates.forEach(row => {
            const st = row && row.state && typeof row.state === 'object' ? row.state : {};
            const email = st.email || st.owner || row.user_id || '';
            const parsed = parseJsonLike(st.gpLinkSupportCases);
            if (Array.isArray(parsed)) {
              parsed.forEach(c => {
                if (c && typeof c === 'object') {
                  tickets.push({ ...c, candidateEmail: email, candidateId: row.user_id || email });
                }
              });
            }
          });
        }
      } catch (e) { console.error('[AdminTickets] Supabase error:', e.message); }
    } else {
      const dbState = loadDbState();
      Object.entries(dbState.userState || {}).forEach(([email, userState]) => {
        const parsed = parseJsonLike(userState.gpLinkSupportCases);
        if (Array.isArray(parsed)) {
          parsed.forEach(c => {
            if (c && typeof c === 'object') {
              tickets.push({ ...c, candidateEmail: email, candidateId: email });
            }
          });
        }
      });
    }

    tickets.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
    sendJson(res, 200, { ok: true, tickets });
    return;
  }

  // POST /api/admin/tickets/:id/reply — admin replies to a ticket
  const adminTicketReplyMatch = pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/reply$/);
  if (adminTicketReplyMatch && req.method === 'POST') {
    const adminSession = requireAdminSession(req, res);
    if (!adminSession) return;

    const ticketId = decodeURIComponent(adminTicketReplyMatch[1] || '').trim();
    if (!ticketId) { sendJson(res, 400, { ok: false, message: 'Invalid ticket id.' }); return; }

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request.' });
      return;
    }

    const text = String(body.text || '').trim().slice(0, 5000);
    const candidateEmail = String(body.candidateEmail || '').trim();
    if (!text) { sendJson(res, 400, { ok: false, message: 'Reply text required.' }); return; }
    if (!candidateEmail) { sendJson(res, 400, { ok: false, message: 'Candidate email required.' }); return; }

    const now = new Date().toISOString();
    const updatedTicket = await persistSupportCaseUpdate(ticketId, (item) => {
      if (!Array.isArray(item.thread)) item.thread = [];
      item.thread.push({ from: 'gp', text, ts: now, attachments: [] });
      item.updatedAt = now;
      item.unread = true;
      return item;
    }, { candidateEmail });

    if (!updatedTicket) { sendJson(res, 404, { ok: false, message: 'Ticket not found.' }); return; }
    invalidateAdminDashboardCache();
    sendJson(res, 200, { ok: true, ticket: updatedTicket });
    return;
  }

  // PUT /api/admin/tickets/:id/status — admin changes ticket status
  const adminTicketStatusMatch = pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/status$/);
  if (adminTicketStatusMatch && req.method === 'PUT') {
    const adminSession = requireAdminSession(req, res);
    if (!adminSession) return;

    const ticketId = decodeURIComponent(adminTicketStatusMatch[1] || '').trim();
    if (!ticketId) { sendJson(res, 400, { ok: false, message: 'Invalid ticket id.' }); return; }

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request.' });
      return;
    }

    const status = body.status === 'closed' ? 'closed' : 'open';
    const candidateEmail = String(body.candidateEmail || '').trim();
    if (!candidateEmail) { sendJson(res, 400, { ok: false, message: 'Candidate email required.' }); return; }

    const now = new Date().toISOString();
    const updatedTicket = await persistSupportCaseUpdate(ticketId, (item) => {
      item.status = status;
      item.updatedAt = now;
      return item;
    }, { candidateEmail });

    if (!updatedTicket) { sendJson(res, 404, { ok: false, message: 'Ticket not found.' }); return; }
    invalidateAdminDashboardCache();
    sendJson(res, 200, { ok: true, ticket: updatedTicket });
    return;
  }

  // PUT /api/admin/tickets/:id/assign — admin assigns a ticket
  const adminTicketAssignMatch = pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/assign$/);
  if (adminTicketAssignMatch && req.method === 'PUT') {
    const adminSession = requireAdminSession(req, res);
    if (!adminSession) return;

    const ticketId = decodeURIComponent(adminTicketAssignMatch[1] || '').trim();
    if (!ticketId) { sendJson(res, 400, { ok: false, message: 'Invalid ticket id.' }); return; }

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request.' });
      return;
    }

    const assignee = String(body.assignee || '').trim().slice(0, 200);
    const candidateEmail = String(body.candidateEmail || '').trim();
    if (!candidateEmail) { sendJson(res, 400, { ok: false, message: 'Candidate email required.' }); return; }

    const now = new Date().toISOString();
    const updatedTicket = await persistSupportCaseUpdate(ticketId, (item) => {
      item.assignedTo = assignee;
      item.updatedAt = now;
      return item;
    }, { candidateEmail });

    if (!updatedTicket) { sendJson(res, 404, { ok: false, message: 'Ticket not found.' }); return; }
    invalidateAdminDashboardCache();
    sendJson(res, 200, { ok: true, ticket: updatedTicket });
    return;
  }

  if (pathname === '/api/account/update-name' && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'No session email.' }); return; }

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const firstName = String(body.firstName || '').trim().slice(0, 100);
    const lastName = String(body.lastName || '').trim().slice(0, 200);
    if (!firstName || !lastName) {
      sendJson(res, 400, { ok: false, message: 'First and last name required.' });
      return;
    }

    // Update in Supabase
    if (isSupabaseDbConfigured()) {
      try {
        const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({ first_name: firstName, last_name: lastName })
        });
        if (!patchRes.ok) console.error('[UpdateName] Supabase PATCH error:', patchRes.status);
      } catch (e) { console.error('[UpdateName] Supabase error:', e.message); }
    }

    // Update in local DB
    const dbState = loadDbState();
    if (dbState.userProfiles[email]) {
      dbState.userProfiles[email].first_name = firstName;
      dbState.userProfiles[email].last_name = lastName;
      saveDbState(dbState);
    }

    console.log(`[UpdateName] Account ${email} name updated to: ${firstName} ${lastName} (auto-matched from documents)`);
    sendJson(res, 200, { ok: true, firstName, lastName });
    return;
  }

  if (pathname === '/api/ai/scan-qualification' && req.method === 'POST') {
    const session = requireSession(req, res);
    if (!session) return;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const fileName = sanitizeUserString(body.fileName, 260);
    const textSnippet = sanitizeUserString(body.textSnippet, 8000);
    if (!fileName) {
      sendJson(res, 400, { ok: false, message: 'File name is required.' });
      return;
    }

    const classification = await classifyQualificationDocument(fileName, textSnippet);
    sendJson(res, 200, {
      ok: true,
      classification,
      scannedAt: new Date().toISOString()
    });
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
    if (!(await enforceAuthRateLimit(req, res, 'request-password-reset'))) return;
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
    } else if (!REQUIRE_SUPABASE_DB && isValidEmail(email) && dbState.users[email]) {
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
    if (!(await enforceAuthRateLimit(req, res, 'reset-password'))) return;
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
    const hostScope = getAdminHostScope(req);
    const hostLabel = getAdminHostLabel(hostScope);
    if (!hostScope) {
      sendJson(res, 404, { ok: false, message: 'Not found', hostScope: '', hostLabel: '' });
      return;
    }
    const session = getAdminSession(req);
    if (!session) {
      sendJson(res, 401, {
        ok: false,
        authenticated: false,
        hostScope,
        hostLabel,
        requiredRole: hostScope === 'super_admin' ? 'super_admin' : 'admin'
      });
      return;
    }
    const email = getSessionEmail(session);
    const role = getAdminRoleFromSession(session);
    if (!doesAdminRoleMatchHost(role, hostScope)) {
      sendJson(res, 403, {
        ok: false,
        authenticated: true,
        hostScope,
        hostLabel,
        profile: buildAdminSessionProfile(session.userProfile, role),
        message: hostScope === 'super_admin'
          ? 'Super admin access required on this host.'
          : 'Admin access required.'
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      authenticated: true,
      hostScope,
      hostLabel,
      profile: buildAdminSessionProfile(session.userProfile, role),
      redirectTo: '/pages/admin.html'
    });
    return;
  }

  if (pathname === '/api/admin/auth/login' && req.method === 'POST') {
    if (!(await enforceAuthRateLimit(req, res, 'admin-login'))) return;
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

    const loginUser = loginResult.data && loginResult.data.user ? loginResult.data.user : { email };
    const adminRole = await resolveAdminRoleForSupabaseUser(loginUser, email);
    const hostScope = getAdminHostScope(req);
    if (!hasAdminPortalAccess(adminRole)) {
      sendJson(res, 403, { ok: false, message: 'This account is not assigned to the admin portal.' });
      return;
    }
    if (!doesAdminRoleMatchHost(adminRole, hostScope)) {
      sendJson(res, 403, {
        ok: false,
        message: hostScope === 'super_admin'
          ? 'This host is reserved for super admin access.'
          : 'This admin account is not allowed on this host.'
      });
      return;
    }
    upsertLocalUserFromSupabaseUser(loginUser);
    await ensureSupabaseUserProfile(loginUser);
    setAdminSession(res, buildAdminSessionProfile(getSessionProfileFromSupabaseUser(loginUser, email), adminRole));
    sendJson(res, 200, {
      ok: true,
      message: 'Authenticated',
      redirectTo: '/pages/admin.html',
      hostScope,
      hostLabel: getAdminHostLabel(hostScope),
      profile: {
        email,
        adminRole,
        roleLabel: getAdminRoleLabel(adminRole),
        hostScope,
        hostLabel: getAdminHostLabel(hostScope)
      }
    });
    return;
  }

  if (pathname === '/api/admin/auth/logout' && req.method === 'POST') {
    clearAdminSession(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/profile' && req.method === 'GET') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Profile API requires Supabase database configuration.' });
      return;
    }
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
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Profile API requires Supabase database configuration.' });
      return;
    }
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

  if (pathname === '/api/prepared-documents' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Prepared document storage requires Supabase configuration.' });
      return;
    }
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) {
      sendJson(res, 400, { ok: false, message: 'Session missing email.' });
      return;
    }

    let country = '';
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      country = normalizeDocumentCountry(requestUrl.searchParams.get('country') || '');
    } catch (err) {
      country = '';
    }
    if (!country) {
      sendJson(res, 400, { ok: false, message: 'Country is required.' });
      return;
    }

    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (isSupabaseDbConfigured() && !userId) {
      sendJson(res, 409, { ok: false, message: 'Cannot resolve database user id for document fetch.' });
      return;
    }

    const docs = await getPreparedDocumentsForUser(userId, email, country);
    sendJson(res, 200, { ok: true, country, docs: docs.docs, updatedAt: docs.updatedAt || null });
    return;
  }

  if (pathname === '/api/onboarding-documents' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Onboarding document storage requires Supabase configuration.' });
      return;
    }
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) {
      sendJson(res, 400, { ok: false, message: 'Session missing email.' });
      return;
    }

    let country = '';
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      country = normalizeDocumentCountry(requestUrl.searchParams.get('country') || '');
    } catch (err) {
      country = '';
    }
    if (!country) {
      sendJson(res, 400, { ok: false, message: 'Country is required.' });
      return;
    }

    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (isSupabaseDbConfigured() && !userId) {
      sendJson(res, 409, { ok: false, message: 'Cannot resolve database user id for document fetch.' });
      return;
    }

    const docs = await getOnboardingDocumentsForUser(userId, email, country);
    sendJson(res, 200, { ok: true, country, docs: docs.docs, updatedAt: docs.updatedAt || null });
    return;
  }

  if (pathname === '/api/prepared-documents/download' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Prepared document storage requires Supabase configuration.' });
      return;
    }
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) {
      sendJson(res, 400, { ok: false, message: 'Session missing email.' });
      return;
    }

    let country = '';
    let key = '';
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      country = normalizeDocumentCountry(requestUrl.searchParams.get('country') || '');
      key = sanitizeUserString(requestUrl.searchParams.get('key') || '', 120);
    } catch (err) {
      country = '';
      key = '';
    }
    if (!country || !PREPARED_DOCUMENT_KEYS.has(key)) {
      sendJson(res, 400, { ok: false, message: 'Invalid download request.' });
      return;
    }

    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) {
      sendJson(res, 409, { ok: false, message: 'Cannot resolve database user id for document download.' });
      return;
    }

    const existing = await getPreparedDocumentRow(userId, country, key);
    const mapped = mapPreparedDocumentRow(existing);
    if (!mapped || !mapped.storagePath) {
      sendJson(res, 404, { ok: false, message: 'Document not found.' });
      return;
    }

    const signedUrl = await supabaseStorageCreateSignedUrl(
      mapped.storageBucket || SUPABASE_DOCUMENT_BUCKET,
      mapped.storagePath,
      mapped.fileName || ''
    );
    if (!signedUrl) {
      sendJson(res, 502, { ok: false, message: 'Failed to create document download URL.' });
      return;
    }

    res.writeHead(302, {
      Location: signedUrl,
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS
    });
    res.end();
    return;
  }

  if (pathname === '/api/onboarding-documents/download' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Onboarding document storage requires Supabase configuration.' });
      return;
    }
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) {
      sendJson(res, 400, { ok: false, message: 'Session missing email.' });
      return;
    }

    let country = '';
    let key = '';
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      country = normalizeDocumentCountry(requestUrl.searchParams.get('country') || '');
      key = sanitizeUserString(requestUrl.searchParams.get('key') || '', 120);
    } catch (err) {
      country = '';
      key = '';
    }
    if (!country || !ONBOARDING_DOCUMENT_KEYS.has(key)) {
      sendJson(res, 400, { ok: false, message: 'Invalid download request.' });
      return;
    }

    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) {
      sendJson(res, 409, { ok: false, message: 'Cannot resolve database user id for document download.' });
      return;
    }

    const existing = await getOnboardingDocumentRow(userId, country, key);
    const mapped = mapPreparedDocumentRow(existing);
    if (!mapped || !mapped.storagePath) {
      sendJson(res, 404, { ok: false, message: 'Document not found.' });
      return;
    }

    const signedUrl = await supabaseStorageCreateSignedUrl(
      mapped.storageBucket || SUPABASE_DOCUMENT_BUCKET,
      mapped.storagePath,
      mapped.fileName || ''
    );
    if (!signedUrl) {
      sendJson(res, 502, { ok: false, message: 'Failed to create document download URL.' });
      return;
    }

    res.writeHead(302, {
      Location: signedUrl,
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS
    });
    res.end();
    return;
  }

  if (pathname === '/api/prepared-documents' && req.method === 'PUT') {
    if (!isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Prepared document storage requires Supabase configuration.' });
      return;
    }
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) {
      sendJson(res, 400, { ok: false, message: 'Session missing email.' });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const payload = sanitizePreparedDocumentPayload(body);
    if (!payload) {
      sendJson(res, 400, { ok: false, message: 'Invalid prepared document payload.' });
      return;
    }

    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (isSupabaseDbConfigured() && !userId) {
      sendJson(res, 409, { ok: false, message: 'Cannot resolve database user id for document save.' });
      return;
    }

    const saved = await savePreparedDocumentForUser(userId, email, payload);
    if (!saved) {
      sendJson(res, 502, { ok: false, message: 'Failed to persist prepared document.' });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      document: {
        ...saved
      }
    });
    return;
  }

  if (pathname === '/api/onboarding-documents' && req.method === 'PUT') {
    if (!isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Onboarding document storage requires Supabase configuration.' });
      return;
    }
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) {
      sendJson(res, 400, { ok: false, message: 'Session missing email.' });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const payload = sanitizeOnboardingDocumentPayload(body);
    if (!payload) {
      sendJson(res, 400, { ok: false, message: 'Invalid onboarding document payload.' });
      return;
    }

    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (isSupabaseDbConfigured() && !userId) {
      sendJson(res, 409, { ok: false, message: 'Cannot resolve database user id for document save.' });
      return;
    }

    const saved = await saveOnboardingDocumentForUser(userId, email, payload);
    if (!saved) {
      sendJson(res, 502, { ok: false, message: 'Failed to persist onboarding document.' });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      document: {
        ...saved
      }
    });
    return;
  }

  if (pathname === '/api/prepared-documents' && req.method === 'DELETE') {
    if (!isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Prepared document storage requires Supabase configuration.' });
      return;
    }
    const session = requireSession(req, res);
    if (!session) return;
    const email = getSessionEmail(session);
    if (!email) {
      sendJson(res, 400, { ok: false, message: 'Session missing email.' });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const country = normalizeDocumentCountry(body && body.country);
    const key = sanitizeUserString(body && body.key, 120);
    if (!country || !PREPARED_DOCUMENT_KEYS.has(key)) {
      sendJson(res, 400, { ok: false, message: 'Invalid document delete request.' });
      return;
    }

    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (isSupabaseDbConfigured() && !userId) {
      sendJson(res, 409, { ok: false, message: 'Cannot resolve database user id for document delete.' });
      return;
    }

    const removed = await deletePreparedDocumentForUser(userId, email, country, key);
    if (!removed) {
      sendJson(res, 502, { ok: false, message: 'Failed to delete prepared document.' });
      return;
    }

    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'State API requires Supabase database configuration.' });
      return;
    }
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
        const remoteResetAt = Number(remoteState.state && remoteState.state.__gp_reset_at);
        sendJson(res, 200, {
          ok: true,
          state: filtered,
          updatedAt: remoteState.updatedAt,
          resetAt: Number.isFinite(remoteResetAt) && remoteResetAt > 0 ? remoteResetAt : 0
        });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        state: {},
        updatedAt: null,
        resetAt: 0
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
    const localResetAt = Number(state && state.__gp_reset_at);

    sendJson(res, 200, {
      ok: true,
      state: filtered,
      updatedAt: state.updatedAt || null,
      resetAt: Number.isFinite(localResetAt) && localResetAt > 0 ? localResetAt : 0
    });
    return;
  }

  if (pathname === '/api/state' && req.method === 'PUT') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'State API requires Supabase database configuration.' });
      return;
    }
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

    // ── AHPRA locking: block AHPRA progress unless career is secured ──
    const BYPASS_LOCK_EMAILS = new Set(['hello@mygplink.com.au']);
    if (incoming.gp_ahpra_progress && typeof incoming.gp_ahpra_progress === 'object' && !BYPASS_LOCK_EMAILS.has(email)) {
      // Need to check current state for career_secured
      const preCheckRemote = isSupabaseDbConfigured() ? await getSupabaseUserStateByEmail(email) : null;
      const preCheckState = preCheckRemote && preCheckRemote.state && typeof preCheckRemote.state === 'object'
        ? preCheckRemote.state
        : (dbState.userState[email] && typeof dbState.userState[email] === 'object' ? dbState.userState[email] : {});
      const careerState = preCheckState.gp_career_state && typeof preCheckState.gp_career_state === 'object' ? preCheckState.gp_career_state : {};
      const careerSecured = !!(careerState.career_secured || careerState.secured);
      if (!careerSecured) {
        sendJson(res, 403, { ok: false, message: 'Cannot start AHPRA registration until career is secured.' });
        return;
      }
    }

    const currentLocal = dbState.userState[email] && typeof dbState.userState[email] === 'object'
      ? dbState.userState[email]
      : {};
    let currentRemote = isSupabaseDbConfigured()
      ? await getSupabaseUserStateByEmail(email)
      : null;
    // If no user_profiles row found by email, try userId from session
    let resolvedUserId = currentRemote && currentRemote.userId ? currentRemote.userId : null;
    if (isSupabaseDbConfigured() && !resolvedUserId) {
      resolvedUserId = getSessionSupabaseUserId(session);
    }
    if (isSupabaseDbConfigured() && !resolvedUserId) {
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

    if (resolvedUserId) {
      const saved = await upsertSupabaseUserState(resolvedUserId, next, updatedAt);
      if (!saved) {
        sendJson(res, 502, { ok: false, message: 'Failed to persist user state to database.' });
        return;
      }
    } else {
      dbState.userState[email] = next;
      saveDbState();
    }

    invalidateAdminDashboardCache();

    // Fire-and-forget: detect state transitions and create/complete tasks
    if (resolvedUserId) {
      processRegistrationTaskAutomation(resolvedUserId, email, current, next).catch(function (err) { console.error('[task-automation] processRegistrationTaskAutomation failed:', err); });
    }

    sendJson(res, 200, { ok: true, updatedAt });
    return;
  }

  if (pathname === '/api/admin/dashboard' && req.method === 'GET') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Admin dashboard requires Supabase database configuration.' });
      return;
    }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;

    const dashboard = await getCachedAdminDashboardData();
    if (!dashboard) {
      sendJson(res, 502, { ok: false, message: 'Failed to load admin dashboard from database.' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      refreshedAt: new Date().toISOString(),
      ...dashboard
    });
    return;
  }

  if (pathname === '/api/admin/agent-control/workers' && req.method === 'GET') {
    const adminCtx = requireSuperAdminSession(req, res);
    if (!adminCtx) return;
    const bridgeStore = await getPersistentHybridAgentBridgeStore(false);
    sendJson(res, 200, {
      ok: true,
      workers: listHybridAgentWorkers(bridgeStore),
      primaryWorkerId: bridgeStore.primaryWorkerId || '',
      bridge: buildHybridAgentBridgeStatus(req, bridgeStore)
    });
    return;
  }

  if ((pathname === '/api/admin/agent-control/workers/register' && req.method === 'POST')
    || (pathname === '/api/admin/agent-control/bridge/token' && req.method === 'GET')) {
    const adminCtx = requireSuperAdminSession(req, res);
    if (!adminCtx) return;
    let body = {};
    if (req.method === 'POST') {
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { ok: false, message: 'Invalid worker registration body.' });
        return;
      }
    }
    const bridgeStore = await getPersistentHybridAgentBridgeStore(false);
    const issued = createHybridAgentWorkerRegistration(bridgeStore, adminCtx.email || '', {
      name: body && typeof body.name === 'string' ? body.name : ''
    });
    await savePersistentHybridAgentBridgeStore(issued.store);
    sendJson(res, 200, {
      ok: true,
      relayUrl: getRequestOrigin(req),
      workerId: issued.workerId,
      workerName: issued.workerName,
      token: issued.token,
      command: `/usr/local/Cellar/node@18/18.20.8/bin/node scripts/agent-bridge.js --relay "${getRequestOrigin(req)}" --worker-id "${issued.workerId}" --token "${issued.token}"`,
      workers: listHybridAgentWorkers(issued.store),
      primaryWorkerId: issued.store.primaryWorkerId || ''
    });
    return;
  }

  if (pathname === '/api/admin/agent-control/bridge/sync' && req.method === 'POST') {
    const bridgeToken = getHybridAgentBridgeRequestToken(req);
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid bridge sync body.' });
      return;
    }
    const bridgeStore = await getPersistentHybridAgentBridgeStore(false);
    const bridgeEntry = bridgeToken ? findHybridAgentWorkerByCredentials(bridgeStore, body && body.workerId, bridgeToken) : null;
    if (!bridgeEntry) {
      sendJson(res, 401, { ok: false, message: 'Bridge token is missing or invalid.' });
      return;
    }
    let nextBridgeStore = applyHybridAgentBridgeCommandUpdates(bridgeStore, bridgeEntry.id, body && body.commandUpdates);
    nextBridgeStore = updateHybridAgentBridgeSnapshot(nextBridgeStore, bridgeEntry.id, body || {}, req);
    const pending = takePendingHybridAgentBridgeCommands(nextBridgeStore, bridgeEntry.id, 8);
    nextBridgeStore = pending.store;
    await savePersistentHybridAgentBridgeStore(nextBridgeStore);
    sendJson(res, 200, {
      ok: true,
      syncedAt: new Date().toISOString(),
      commands: pending.commands,
      bridge: buildHybridAgentBridgeStatus(req, nextBridgeStore),
      workers: listHybridAgentWorkers(nextBridgeStore),
      primaryWorkerId: nextBridgeStore.primaryWorkerId || ''
    });
    return;
  }

  if (pathname === '/api/admin/agent-control/workers/select' && req.method === 'POST') {
    const adminCtx = requireSuperAdminSession(req, res);
    if (!adminCtx) return;
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid worker selection body.' });
      return;
    }
    const workerId = sanitizeHybridAgentWorkerId(body && body.workerId);
    const bridgeStore = await getPersistentHybridAgentBridgeStore(false);
    if (!workerId || !bridgeStore.workers[workerId] || bridgeStore.workers[workerId].enabled === false) {
      sendJson(res, 404, { ok: false, message: 'Worker not found.' });
      return;
    }
    const nextBridgeStore = normalizeHybridAgentBridgeStore({
      ...bridgeStore,
      primaryWorkerId: workerId
    });
    await savePersistentHybridAgentBridgeStore(nextBridgeStore);
    sendJson(res, 200, {
      ok: true,
      workerId,
      workers: listHybridAgentWorkers(nextBridgeStore),
      primaryWorkerId: nextBridgeStore.primaryWorkerId || '',
      bridge: buildHybridAgentBridgeStatus(req, nextBridgeStore)
    });
    return;
  }

  if (pathname === '/api/admin/agent-control/workers/revoke' && req.method === 'POST') {
    const adminCtx = requireSuperAdminSession(req, res);
    if (!adminCtx) return;
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid worker revoke body.' });
      return;
    }
    const workerId = sanitizeHybridAgentWorkerId(body && body.workerId);
    const bridgeStore = await getPersistentHybridAgentBridgeStore(false);
    const worker = workerId ? bridgeStore.workers[workerId] : null;
    if (!worker) {
      sendJson(res, 404, { ok: false, message: 'Worker not found.' });
      return;
    }
    const nextBridgeStore = normalizeHybridAgentBridgeStore({
      ...bridgeStore,
      primaryWorkerId: bridgeStore.primaryWorkerId === workerId ? '' : bridgeStore.primaryWorkerId,
      workers: {
        ...bridgeStore.workers,
        [workerId]: {
          ...worker,
          enabled: false,
          tokenHash: '',
          revokedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      },
      commands: Array.isArray(bridgeStore.commands) ? bridgeStore.commands.filter(function (command) { return command.workerId !== workerId; }) : []
    });
    await savePersistentHybridAgentBridgeStore(nextBridgeStore);
    sendJson(res, 200, {
      ok: true,
      workerId,
      workers: listHybridAgentWorkers(nextBridgeStore),
      primaryWorkerId: nextBridgeStore.primaryWorkerId || '',
      bridge: buildHybridAgentBridgeStatus(req, nextBridgeStore)
    });
    return;
  }

  if (pathname === '/api/admin/agent-control/status' && req.method === 'GET') {
    const adminCtx = requireSuperAdminSession(req, res);
    if (!adminCtx) return;

    const bridgeStore = await getPersistentHybridAgentBridgeStore(false);
    const relay = getActiveHybridAgentRelay(bridgeStore);
    let providers;
    if (relay && relay.providers) {
      providers = relay.providers;
    } else {
      try {
        providers = await getCachedHybridAgentProviderStatus(url.searchParams.get('refresh') === 'true');
      } catch (error) {
        sendJson(res, 502, { ok: false, message: error && error.message ? error.message : 'Failed to inspect provider status.' });
        return;
      }
    }

    const draftTask = String(url.searchParams.get('task') || '').trim();
    const profile = typeof url.searchParams.get('profile') === 'string' ? url.searchParams.get('profile').trim() : 'balanced';
    const collaborationMode = typeof url.searchParams.get('collaborationMode') === 'string' ? url.searchParams.get('collaborationMode').trim() : 'paired';
    const complexityMode = typeof url.searchParams.get('complexity') === 'string' ? url.searchParams.get('complexity').trim() : 'auto';
    sendJson(res, 200, {
      ok: true,
      refreshedAt: new Date().toISOString(),
      providers,
      dashboard: buildHybridAgentDashboardState(draftTask, {
        profile,
        collaborationMode,
        complexityMode,
        providerStates: providers,
        bridgeState: relay,
        bridgeStore
      }),
      connectCommands: {
        openai: 'codex login',
        anthropic: 'claude auth login',
        localBridge: 'Open Start Bridge help to register a persistent worker.'
      },
      bridge: buildHybridAgentBridgeStatus(req, bridgeStore)
    });
    return;
  }

  if (pathname === '/api/admin/agent-control/providers/refresh' && req.method === 'POST') {
    const adminCtx = requireSuperAdminSession(req, res);
    if (!adminCtx) return;

    const bridgeStore = await getPersistentHybridAgentBridgeStore(false);
    const relay = getActiveHybridAgentRelay(bridgeStore);
    if (relay) {
      const queued = queueHybridAgentBridgeCommand(bridgeStore, relay.workerId, 'refresh-providers', {}, adminCtx.email || '');
      await savePersistentHybridAgentBridgeStore(queued.store);
      sendJson(res, 202, {
        ok: true,
        queued: true,
        commandId: queued.command ? queued.command.id : '',
        message: 'Queued a provider refresh for the connected local bridge.',
        bridge: buildHybridAgentBridgeStatus(req, queued.store)
      });
      return;
    }

    try {
      const providers = await getCachedHybridAgentProviderStatus(true);
      sendJson(res, 200, { ok: true, refreshedAt: new Date().toISOString(), providers });
    } catch (error) {
      sendJson(res, 502, { ok: false, message: error && error.message ? error.message : 'Failed to refresh provider status.' });
    }
    return;
  }

  if (pathname === '/api/admin/agent-control/runs' && req.method === 'GET') {
    const adminCtx = requireSuperAdminSession(req, res);
    if (!adminCtx) return;
    const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit') || 12) || 12));
    const bridgeStore = await getPersistentHybridAgentBridgeStore(false);
    const relay = getActiveHybridAgentRelay(bridgeStore);
    sendJson(res, 200, {
      ok: true,
      runs: relay && Array.isArray(relay.runs) ? relay.runs.slice(0, limit) : listHybridAgentRuns(limit),
      activeRunId: relay && relay.activeRunId ? relay.activeRunId : (hybridAgentControlState.activeRunId || ''),
      bridge: buildHybridAgentBridgeStatus(req, bridgeStore)
    });
    return;
  }

  if (pathname === '/api/admin/agent-control/run' && req.method === 'GET') {
    const adminCtx = requireSuperAdminSession(req, res);
    if (!adminCtx) return;
    const runId = sanitizeAgentRunId(url.searchParams.get('id') || '');
    if (!runId) {
      sendJson(res, 400, { ok: false, message: 'Run id is required.' });
      return;
    }
    const bridgeStore = await getPersistentHybridAgentBridgeStore(false);
    const relay = getActiveHybridAgentRelay(bridgeStore);
    const run = relay && Array.isArray(relay.runs)
      ? (relay.runs.find(function (entry) { return entry.runId === runId; }) || null)
      : getHybridAgentRunSummary(runId);
    if (!run) {
      sendJson(res, 404, { ok: false, message: 'Run not found.' });
      return;
    }
    sendJson(res, 200, { ok: true, run });
    return;
  }

  if (pathname === '/api/admin/agent-control/run' && req.method === 'POST') {
    const adminCtx = requireSuperAdminSession(req, res);
    if (!adminCtx) return;
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const task = typeof body.task === 'string' ? body.task.trim() : '';
    const profile = typeof body.profile === 'string' ? body.profile.trim() : 'balanced';
    const collaborationMode = typeof body.collaborationMode === 'string' ? body.collaborationMode.trim() : 'paired';
    const complexity = typeof body.complexity === 'string' ? body.complexity.trim() : 'auto';
    if (!task || task.length < 12) {
      sendJson(res, 400, { ok: false, message: 'Provide a more specific task for the agent.' });
      return;
    }
    if (task.length > 5000) {
      sendJson(res, 400, { ok: false, message: 'Task is too long. Keep it under 5000 characters.' });
      return;
    }

    const bridgeStore = await getPersistentHybridAgentBridgeStore(false);
    const relay = getActiveHybridAgentRelay(bridgeStore);
    let providers;
    if (relay && relay.providers) {
      providers = relay.providers;
    } else {
      try {
        providers = await getCachedHybridAgentProviderStatus(false);
      } catch (error) {
        sendJson(res, 502, { ok: false, message: error && error.message ? error.message : 'Unable to inspect provider state before launch.' });
        return;
      }
    }
    const availableProviders = Object.values(providers).filter(function (state) { return state && state.available; });
    if (!availableProviders.length) {
      sendJson(res, 409, { ok: false, message: 'Connect Codex and/or Claude before starting a run.' });
      return;
    }

    if (relay) {
      if (relay.activeRunId || (Array.isArray(relay.runs) && relay.runs.find(function (run) {
        return run && (run.status === 'running' || run.status === 'starting' || run.status === 'launching' || run.status === 'cancelling');
      }))) {
        sendJson(res, 409, { ok: false, message: 'An agent run is already in progress on the connected local bridge.' });
        return;
      }
      const runId = sanitizeAgentRunId(`agent-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
      const queued = queueHybridAgentBridgeCommand(bridgeStore, relay.workerId, 'start-run', {
        runId,
        task,
        profile,
        collaborationMode,
        complexity
      }, adminCtx.email || '');
      await savePersistentHybridAgentBridgeStore(queued.store);
      sendJson(res, 202, {
        ok: true,
        queued: true,
        commandId: queued.command ? queued.command.id : '',
        run: { runId, task, profile, collaborationMode, complexityMode: complexity },
        message: 'Agent run queued for the connected local bridge.',
        policy: hybridAgents.getModelPolicy(task, complexity, profile, collaborationMode),
        warning: collaborationMode === 'paired' && availableProviders.length < 2
          ? 'Only one provider is connected, so this run will execute in routed mode until both providers are available.'
          : '',
        bridge: buildHybridAgentBridgeStatus(req, queued.store)
      });
      return;
    }

    try {
      const launched = startHybridAgentRun({ task, profile, collaborationMode, complexity, requestedBy: adminCtx.email || '' });
      sendJson(res, 201, {
        ok: true,
        run: launched,
        message: 'Agent run started.',
        policy: hybridAgents.getModelPolicy(task, complexity, profile, collaborationMode),
        warning: collaborationMode === 'paired' && availableProviders.length < 2
          ? 'Only one provider is connected, so this run will execute in routed mode until both providers are available.'
          : ''
      });
    } catch (error) {
      sendJson(res, 409, { ok: false, message: error && error.message ? error.message : 'Unable to start agent run.' });
    }
    return;
  }

  if (pathname === '/api/admin/agent-control/run/cancel' && req.method === 'POST') {
    const adminCtx = requireSuperAdminSession(req, res);
    if (!adminCtx) return;
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }
    const runId = sanitizeAgentRunId(body && body.runId);
    if (!runId) {
      sendJson(res, 400, { ok: false, message: 'Run id is required.' });
      return;
    }
    const bridgeStore = await getPersistentHybridAgentBridgeStore(false);
    const relay = getActiveHybridAgentRelay(bridgeStore);
    if (relay) {
      const queued = queueHybridAgentBridgeCommand(bridgeStore, relay.workerId, 'cancel-run', { runId }, adminCtx.email || '');
      await savePersistentHybridAgentBridgeStore(queued.store);
      sendJson(res, 202, {
        ok: true,
        queued: true,
        commandId: queued.command ? queued.command.id : '',
        runId,
        message: 'Cancellation queued for the connected local bridge.',
        bridge: buildHybridAgentBridgeStatus(req, queued.store)
      });
      return;
    }
    const cancelled = cancelHybridAgentRun(runId);
    if (!cancelled) {
      sendJson(res, 409, { ok: false, message: 'Run is not currently cancellable.' });
      return;
    }
    sendJson(res, 200, { ok: true, runId, message: 'Cancellation requested.' });
    return;
  }

  // ══════ Registration Cases & Tasks API ══════

  // ── List all cases ──
  if (pathname === '/api/admin/cases' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const casesRes = await supabaseDbRequest('registration_cases', 'select=*&order=updated_at.desc');
    if (!casesRes.ok) { sendJson(res, 502, { ok: false, message: 'Failed to load cases.' }); return; }
    const cases = Array.isArray(casesRes.data) ? casesRes.data : [];
    const userIds = [...new Set(cases.map(function (c) { return c.user_id; }).filter(Boolean))];
    let profileMap = {};
    if (userIds.length > 0) {
      const pRes = await supabaseDbRequest('user_profiles', 'select=user_id,first_name,last_name,email,phone,phone_number&user_id=in.(' + userIds.map(encodeURIComponent).join(',') + ')');
      if (pRes.ok && Array.isArray(pRes.data)) { pRes.data.forEach(function (p) { profileMap[p.user_id] = p; }); }
    }
    // Get open task counts per case
    const tasksRes = await supabaseDbRequest('registration_tasks', 'select=id,case_id,priority,status,due_date&status=in.(open,in_progress,waiting)');
    const tasksByCase = {};
    if (tasksRes.ok && Array.isArray(tasksRes.data)) {
      tasksRes.data.forEach(function (t) {
        if (!tasksByCase[t.case_id]) tasksByCase[t.case_id] = { open: 0, urgent: 0, overdue: 0 };
        tasksByCase[t.case_id].open++;
        if (t.priority === 'urgent') tasksByCase[t.case_id].urgent++;
        if (t.due_date && new Date(t.due_date) < new Date()) tasksByCase[t.case_id].overdue++;
      });
    }
    const enriched = cases.map(function (c) {
      const p = profileMap[c.user_id] || {};
      const tc = tasksByCase[c.id] || { open: 0, urgent: 0, overdue: 0 };
      return Object.assign({}, c, {
        gp_name: [(p.first_name || ''), (p.last_name || '')].join(' ').trim() || (p.email || ''),
        gp_email: p.email || '',
        gp_phone: p.phone || p.phone_number || '',
        open_tasks: tc.open, urgent_tasks: tc.urgent, overdue_tasks: tc.overdue
      });
    });
    sendJson(res, 200, { ok: true, cases: enriched });
    return;
  }

  // ── Single case detail with tasks + timeline ──
  if (pathname === '/api/admin/case' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const caseId = url.searchParams.get('id');
    if (!caseId) { sendJson(res, 400, { ok: false, message: 'Missing id.' }); return; }
    const [caseRes, tasksRes, tlRes] = await Promise.all([
      supabaseDbRequest('registration_cases', 'select=*&id=eq.' + encodeURIComponent(caseId) + '&limit=1'),
      supabaseDbRequest('registration_tasks', 'select=*&case_id=eq.' + encodeURIComponent(caseId) + '&order=created_at.desc'),
      supabaseDbRequest('task_timeline', 'select=*&case_id=eq.' + encodeURIComponent(caseId) + '&order=created_at.desc&limit=100')
    ]);
    if (!caseRes.ok || !Array.isArray(caseRes.data) || caseRes.data.length === 0) { sendJson(res, 404, { ok: false, message: 'Case not found.' }); return; }
    const regCase = caseRes.data[0];
    const pRes = await supabaseDbRequest('user_profiles', 'select=first_name,last_name,email,phone_number&user_id=eq.' + encodeURIComponent(regCase.user_id) + '&limit=1');
    const profile = pRes.ok && Array.isArray(pRes.data) && pRes.data.length > 0 ? pRes.data[0] : {};
    regCase.gp_name = [(profile.first_name || ''), (profile.last_name || '')].join(' ').trim() || 'Unknown';
    regCase.gp_email = profile.email || '';
    regCase.gp_phone = profile.phone_number || '';
    sendJson(res, 200, {
      ok: true,
      case: regCase,
      tasks: tasksRes.ok && Array.isArray(tasksRes.data) ? tasksRes.data : [],
      timeline: tlRes.ok && Array.isArray(tlRes.data) ? tlRes.data : []
    });
    return;
  }

  // ── Update case ──
  if (pathname === '/api/admin/case' && req.method === 'PUT') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const caseId = url.searchParams.get('id');
    if (!caseId) { sendJson(res, 400, { ok: false, message: 'Missing id.' }); return; }
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const allowed = ['assigned_va', 'status', 'blocker_status', 'blocker_reason', 'next_followup_date', 'practice_name', 'practice_contact', 'handover_notes', 'gp_verified_stage'];
    const patch = {};
    for (const key of allowed) { if (body && body[key] !== undefined) patch[key] = body[key]; }
    patch.last_va_action_at = new Date().toISOString();
    const r = await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(caseId), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch });
    if (!r.ok) { sendJson(res, 502, { ok: false, message: 'Failed to update case.' }); return; }
    // Log timeline
    const changes = Object.keys(patch).filter(function (k) { return k !== 'last_va_action_at'; });
    if (changes.length > 0) {
      await _logCaseEvent(caseId, null, changes.includes('blocker_status') ? (patch.blocker_status ? 'blocker_set' : 'blocker_cleared') : 'status_change', 'Case updated: ' + changes.join(', '), JSON.stringify(patch), adminCtx.email);
    }
    sendJson(res, 200, { ok: true, case: r.ok && Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : null });
    return;
  }

  // ── Add case note ──
  if (pathname === '/api/admin/case/note' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const caseId = url.searchParams.get('id');
    if (!caseId) { sendJson(res, 400, { ok: false, message: 'Missing id.' }); return; }
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const text = body && typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) { sendJson(res, 400, { ok: false, message: 'Missing text.' }); return; }
    await _logCaseEvent(caseId, null, 'note', 'Note added', text, adminCtx.email);
    await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(caseId), { method: 'PATCH', body: { last_va_action_at: new Date().toISOString() } });
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── List tasks (with case/GP enrichment) ──
  if (pathname === '/api/admin/tasks' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const statusFilter = url.searchParams.get('status') || 'open,in_progress,waiting';
    const statuses = statusFilter.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    const tasksRes = await supabaseDbRequest('registration_tasks', 'select=*&status=in.(' + statuses.join(',') + ')&order=priority.asc,created_at.desc&limit=200');
    if (!tasksRes.ok) { sendJson(res, 502, { ok: false, message: 'Failed to load tasks.' }); return; }
    const tasks = Array.isArray(tasksRes.data) ? tasksRes.data : [];
    // Enrich with case + GP info
    const caseIds = [...new Set(tasks.map(function (t) { return t.case_id; }).filter(Boolean))];
    let caseMap = {};
    if (caseIds.length > 0) {
      const cRes = await supabaseDbRequest('registration_cases', 'select=id,user_id,stage,status,assigned_va&id=in.(' + caseIds.map(encodeURIComponent).join(',') + ')');
      if (cRes.ok && Array.isArray(cRes.data)) { cRes.data.forEach(function (c) { caseMap[c.id] = c; }); }
    }
    const userIds = [...new Set(Object.values(caseMap).map(function (c) { return c.user_id; }).filter(Boolean))];
    let profileMap = {};
    if (userIds.length > 0) {
      const pRes = await supabaseDbRequest('user_profiles', 'select=user_id,first_name,last_name,email,phone,phone_number&user_id=in.(' + userIds.map(encodeURIComponent).join(',') + ')');
      if (pRes.ok && Array.isArray(pRes.data)) { pRes.data.forEach(function (p) { profileMap[p.user_id] = p; }); }
    }
    const enriched = tasks.map(function (t) {
      const c = caseMap[t.case_id] || {};
      const p = profileMap[c.user_id] || {};
      return Object.assign({}, t, {
        gp_name: [(p.first_name || ''), (p.last_name || '')].join(' ').trim() || (p.email || ''),
        gp_email: p.email || '',
        gp_phone: p.phone || p.phone_number || '',
        case_stage: c.stage || '',
        case_status: c.status || ''
      });
    });
    sendJson(res, 200, { ok: true, tasks: enriched });
    return;
  }

  // ── Create task ──
  if (pathname === '/api/admin/tasks' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    if (!body || !body.case_id || !body.title) { sendJson(res, 400, { ok: false, message: 'case_id and title required.' }); return; }
    const task = await _createRegTask(body.case_id, {
      task_type: body.task_type || 'manual',
      title: body.title,
      description: body.description || null,
      priority: body.priority || 'normal',
      due_date: body.due_date || null,
      related_stage: body.related_stage || null,
      related_document_key: body.related_document_key || null,
      parent_task_id: body.parent_task_id || null,
      source_trigger: 'va_manual',
      _actor: adminCtx.email
    });
    if (!task) { sendJson(res, 502, { ok: false, message: 'Failed to create task.' }); return; }
    // Update case last_va_action_at
    await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(body.case_id), { method: 'PATCH', body: { last_va_action_at: new Date().toISOString() } });
    sendJson(res, 201, { ok: true, task: task });
    return;
  }

  // ── Update task ──
  if (pathname === '/api/admin/task' && req.method === 'PUT') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const taskId = url.searchParams.get('id');
    if (!taskId) { sendJson(res, 400, { ok: false, message: 'Missing id.' }); return; }
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const allowed = ['status', 'priority', 'assignee', 'due_date', 'blocker_reason', 'description'];
    const patch = {};
    for (const key of allowed) { if (body && body[key] !== undefined) patch[key] = body[key]; }
    if (patch.status === 'completed') {
      patch.completed_at = new Date().toISOString();
      patch.completed_by = adminCtx.email;
    }
    const r = await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(taskId), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch });
    if (!r.ok) { sendJson(res, 502, { ok: false, message: 'Failed to update task.' }); return; }
    const updated = r.ok && Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : null;
    // Timeline
    const evType = patch.status === 'completed' ? 'completed' : patch.status === 'cancelled' ? 'cancelled' : patch.priority ? 'priority_change' : 'status_change';
    if (updated) {
      await _logCaseEvent(updated.case_id, taskId, evType, 'Task updated: ' + Object.keys(patch).join(', '), JSON.stringify(patch), adminCtx.email);
      await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(updated.case_id), { method: 'PATCH', body: { last_va_action_at: new Date().toISOString() } });
    }
    sendJson(res, 200, { ok: true, task: updated });
    return;
  }

  // ── Add task note ──
  if (pathname === '/api/admin/task/note' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const taskId = url.searchParams.get('id');
    if (!taskId) { sendJson(res, 400, { ok: false, message: 'Missing id.' }); return; }
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const text = body && typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) { sendJson(res, 400, { ok: false, message: 'Missing text.' }); return; }
    // Get task to find case_id
    const tRes = await supabaseDbRequest('registration_tasks', 'select=case_id&id=eq.' + encodeURIComponent(taskId) + '&limit=1');
    const caseId = tRes.ok && Array.isArray(tRes.data) && tRes.data.length > 0 ? tRes.data[0].case_id : null;
    if (!caseId) { sendJson(res, 404, { ok: false, message: 'Task not found.' }); return; }
    await _logCaseEvent(caseId, taskId, 'note', 'Note added', text, adminCtx.email);
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── Sync: bulk create cases for all GPs ──
  if (pathname === '/api/admin/cases/sync' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    // Get all users with state
    const stateRes = await supabaseDbRequest('user_state', 'select=user_id,state');
    if (!stateRes.ok) { sendJson(res, 502, { ok: false, message: 'Failed to load user states.' }); return; }
    const states = Array.isArray(stateRes.data) ? stateRes.data : [];
    let created = 0, updated = 0, skipped = 0;
    for (const row of states) {
      if (!row.user_id || !row.state) { skipped++; continue; }
      const state = typeof row.state === 'object' ? row.state : {};
      const regCase = await _ensureRegCase(row.user_id);
      if (!regCase) { skipped++; continue; }
      const stage = _deriveStageFromState(state);
      if (stage !== regCase.stage) {
        await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(regCase.id), { method: 'PATCH', body: { stage: stage } });
        updated++;
      }
      // Create kickoff task if none exist for current stage
      const existingTasks = await supabaseDbRequest('registration_tasks', 'select=id&case_id=eq.' + encodeURIComponent(regCase.id) + '&related_stage=eq.' + encodeURIComponent(stage) + '&limit=1');
      if (existingTasks.ok && Array.isArray(existingTasks.data) && existingTasks.data.length === 0) {
        await _createRegTask(regCase.id, { task_type: 'kickoff', title: 'Review ' + stage + ' stage progress', source_trigger: 'sync', related_stage: stage, _actor: adminCtx.email });
        created++;
      }
    }
    invalidateAdminDashboardCache();
    sendJson(res, 200, { ok: true, synced: states.length, created: created, updated: updated, skipped: skipped });
    return;
  }

  // ══════ VA Dashboard (rebuild) — aggregated endpoints ══════

  // ── Aggregated dashboard payload (one call for the new UI) ──
  if (pathname === '/api/admin/va/dashboard' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;

    const [casesRes, tasksRes, ticketsRes] = await Promise.all([
      supabaseDbRequest('registration_cases', 'select=*&order=updated_at.desc'),
      supabaseDbRequest('registration_tasks', 'select=*&status=in.(open,in_progress,waiting,waiting_on_gp,waiting_on_practice,waiting_on_external)&order=priority.asc,created_at.asc&limit=500'),
      supabaseDbRequest('support_tickets', 'select=*&status=neq.closed&order=created_at.asc&limit=500')
    ]);
    const cases = casesRes.ok && Array.isArray(casesRes.data) ? casesRes.data : [];
    const tasks = tasksRes.ok && Array.isArray(tasksRes.data) ? tasksRes.data : [];
    const openTickets = ticketsRes.ok && Array.isArray(ticketsRes.data) ? ticketsRes.data : [];

    const userIds = [...new Set(cases.map(function (c) { return c.user_id; }).filter(Boolean))];
    let profileMap = {};
    let stateMap = {};
    if (userIds.length > 0) {
      const [pRes, sRes] = await Promise.all([
        supabaseDbRequest('user_profiles', 'select=user_id,first_name,last_name,email,phone_number,phone,country_of_qualification,created_at&user_id=in.(' + userIds.map(encodeURIComponent).join(',') + ')'),
        supabaseDbRequest('user_state', 'select=user_id,state&user_id=in.(' + userIds.map(encodeURIComponent).join(',') + ')')
      ]);
      if (pRes.ok && Array.isArray(pRes.data)) pRes.data.forEach(function (p) { profileMap[p.user_id] = p; });
      if (sRes.ok && Array.isArray(sRes.data)) sRes.data.forEach(function (s) { stateMap[s.user_id] = (s && typeof s.state === 'object') ? s.state : {}; });
    }

    // Task/ticket counts per case
    const taskCountsByCase = {};
    tasks.forEach(function (t) {
      if (!taskCountsByCase[t.case_id]) taskCountsByCase[t.case_id] = { open: 0, urgent: 0, overdue: 0 };
      taskCountsByCase[t.case_id].open++;
      if (t.priority === 'urgent') taskCountsByCase[t.case_id].urgent++;
      if (t.due_date && new Date(t.due_date) < new Date()) taskCountsByCase[t.case_id].overdue++;
    });
    const ticketCountsByUser = {};
    openTickets.forEach(function (tk) { ticketCountsByUser[tk.user_id] = (ticketCountsByUser[tk.user_id] || 0) + 1; });

    // Enriched users list with quick qual snapshot (required + approved counts only, not full lists)
    const users = [];
    for (const c of cases) {
      const p = profileMap[c.user_id] || {};
      const st = stateMap[c.user_id] || {};
      const countryRaw = (p.country_of_qualification || st.gp_selected_country || st.gp_onboarding && st.gp_onboarding.country || 'GB').toString().toUpperCase();
      // Map common name → code
      const countryCode = ({ 'UNITED KINGDOM': 'GB', 'UK': 'GB', 'GREAT BRITAIN': 'GB', 'IRELAND': 'IE', 'NEW ZEALAND': 'NZ' })[countryRaw] || (['GB','IE','NZ'].includes(countryRaw) ? countryRaw : 'GB');
      const qualSnap = await getUserQualificationSnapshot(c.user_id, countryCode);
      const tc = taskCountsByCase[c.id] || { open: 0, urgent: 0, overdue: 0 };
      users.push({
        case_id: c.id,
        user_id: c.user_id,
        gp_name: [(p.first_name || ''), (p.last_name || '')].join(' ').trim() || (p.email || 'Unknown'),
        gp_first_name: p.first_name || '',
        gp_email: p.email || '',
        gp_phone: p.phone || p.phone_number || '',
        country: countryCode,
        stage: c.stage,
        substage: c.substage,
        status: c.status,
        blocker_status: c.blocker_status,
        created_at: c.created_at,
        last_gp_activity_at: c.last_gp_activity_at,
        last_va_action_at: c.last_va_action_at,
        open_tasks: tc.open,
        urgent_tasks: tc.urgent,
        overdue_tasks: tc.overdue,
        open_tickets: ticketCountsByUser[c.user_id] || 0,
        quals_required: qualSnap.required.length,
        quals_approved: qualSnap.approved.length,
        quals_missing: qualSnap.missing.length,
        whatsapp_link: buildWhatsAppLink(c.stage, p.first_name || '')
      });
    }

    // Enriched today's tasks (case + GP info joined)
    const caseMap = {};
    cases.forEach(function (c) { caseMap[c.id] = c; });
    const enrichedTasks = tasks.map(function (t) {
      const c = caseMap[t.case_id] || {};
      const p = profileMap[c.user_id] || {};
      return Object.assign({}, t, {
        gp_name: [(p.first_name || ''), (p.last_name || '')].join(' ').trim() || (p.email || ''),
        gp_first_name: p.first_name || '',
        gp_email: p.email || '',
        gp_phone: p.phone || p.phone_number || '',
        gp_user_id: c.user_id || null,
        case_stage: c.stage || '',
        case_substage: c.substage || '',
        whatsapp_link: buildWhatsAppLink(c.stage, p.first_name || '')
      });
    });

    // Enriched open tickets
    const enrichedTickets = openTickets.map(function (tk) {
      const p = profileMap[tk.user_id] || {};
      return Object.assign({}, tk, {
        gp_name: [(p.first_name || ''), (p.last_name || '')].join(' ').trim() || (p.email || ''),
        gp_first_name: p.first_name || '',
        gp_email: p.email || '',
        gp_phone: p.phone || p.phone_number || '',
        whatsapp_link: buildWhatsAppLink(tk.stage, p.first_name || '')
      });
    });

    const urgentCount = enrichedTasks.filter(function (t) { return t.priority === 'urgent'; }).length;
    const overdueCount = enrichedTasks.filter(function (t) { return t.due_date && new Date(t.due_date) < new Date(); }).length;

    sendJson(res, 200, {
      ok: true,
      metrics: {
        total_gps: users.length,
        urgent: urgentCount,
        overdue: overdueCount,
        open_tasks: enrichedTasks.length,
        open_tickets: enrichedTickets.length
      },
      users: users,
      todays_tasks: enrichedTasks,
      open_tickets: enrichedTickets,
      whatsapp_number: HAZEL_WHATSAPP_NUMBER
    });
    return;
  }

  // ── List tickets (for VA Tickets tab) with status filter ──
  if (pathname === '/api/admin/va/tickets' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const statusParam = (url.searchParams.get('status') || 'open').toLowerCase();
    const query = statusParam === 'closed'
      ? 'select=*&status=eq.closed&order=resolved_at.desc.nullslast,updated_at.desc&limit=500'
      : 'select=*&status=neq.closed&order=created_at.asc&limit=500';
    const tRes = await supabaseDbRequest('support_tickets', query);
    const tickets = tRes.ok && Array.isArray(tRes.data) ? tRes.data : [];
    const userIds = [...new Set(tickets.map(function (t) { return t.user_id; }).filter(Boolean))];
    let profileMap = {};
    if (userIds.length > 0) {
      const pRes = await supabaseDbRequest('user_profiles', 'select=user_id,first_name,last_name,email&user_id=in.(' + userIds.map(encodeURIComponent).join(',') + ')');
      if (pRes.ok && Array.isArray(pRes.data)) pRes.data.forEach(function (p) { profileMap[p.user_id] = p; });
    }
    const enriched = tickets.map(function (t) {
      const p = profileMap[t.user_id] || {};
      return Object.assign({}, t, {
        gp_name: [(p.first_name || ''), (p.last_name || '')].join(' ').trim() || 'Unknown',
        gp_email: p.email || '',
        whatsapp_link: buildWhatsAppLink(t.stage, p.first_name || '')
      });
    });
    sendJson(res, 200, { ok: true, tickets: enriched });
    return;
  }

  // ── Update a ticket (close/reopen) ──
  const vaTicketMatch = pathname.match(/^\/api\/admin\/va\/ticket\/([^/]+)$/);
  if (vaTicketMatch && req.method === 'PUT') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const ticketId = decodeURIComponent(vaTicketMatch[1] || '');
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const nextStatus = body && body.status === 'closed' ? 'closed' : body && body.status === 'open' ? 'open' : null;
    if (!nextStatus) { sendJson(res, 400, { ok: false, message: 'status must be open or closed.' }); return; }
    const patch = { status: nextStatus, updated_at: new Date().toISOString() };
    if (nextStatus === 'closed') { patch.resolved_at = new Date().toISOString(); patch.resolved_by = adminCtx.email; }
    else { patch.resolved_at = null; patch.resolved_by = null; }
    const r = await supabaseDbRequest('support_tickets', 'id=eq.' + encodeURIComponent(ticketId), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch });
    const updated = r.ok && Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : null;
    if (!updated) { sendJson(res, 404, { ok: false, message: 'Ticket not found.' }); return; }
    // Also mirror to the legacy user-state JSON so /api/support/tickets stays consistent
    try {
      const pRes = await supabaseDbRequest('user_profiles', 'select=email&user_id=eq.' + encodeURIComponent(updated.user_id) + '&limit=1');
      const gpEmail = pRes.ok && Array.isArray(pRes.data) && pRes.data[0] ? pRes.data[0].email : null;
      if (gpEmail && updated.source_ticket_id) {
        const remote = await getSupabaseUserStateByEmail(gpEmail);
        const st = remote && remote.state ? remote.state : {};
        const parsed = parseJsonLike(st.gpLinkSupportCases);
        const cases = Array.isArray(parsed) ? parsed : [];
        const idx = cases.findIndex(function (c) { return c && String(c.id || '') === updated.source_ticket_id; });
        if (idx >= 0) {
          cases[idx].status = nextStatus;
          cases[idx].updatedAt = patch.updated_at;
          const nextState = Object.assign({}, st, { gpLinkSupportCases: JSON.stringify(cases), updatedAt: patch.updated_at });
          await upsertSupabaseUserState(remote ? (remote.userId || null) : null, nextState, patch.updated_at);
        }
      }
    } catch (e) { console.error('[VA ticket] legacy mirror error:', e && e.message); }
    // Mirror blocker task status
    if (updated.source_ticket_id) {
      try {
        const tkRes = await supabaseDbRequest('registration_tasks', 'select=id,case_id&related_ticket_id=eq.' + encodeURIComponent(updated.source_ticket_id) + '&task_type=eq.blocker&limit=1');
        if (tkRes.ok && Array.isArray(tkRes.data) && tkRes.data[0]) {
          const rt = tkRes.data[0];
          if (nextStatus === 'closed') {
            await _completeRegTask(rt.id, rt.case_id, adminCtx.email);
          } else {
            await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(rt.id), { method: 'PATCH', body: { status: 'open', completed_at: null, completed_by: null } });
          }
        }
      } catch (e) { console.error('[VA ticket] task mirror error:', e && e.message); }
    }
    invalidateAdminDashboardCache();
    sendJson(res, 200, { ok: true, ticket: updated });
    return;
  }

  // ── Send a nudge to a GP ──
  if (pathname === '/api/admin/va/nudge' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const targetUserId = body && body.user_id;
    if (!targetUserId) { sendJson(res, 400, { ok: false, message: 'user_id required.' }); return; }
    // Resolve case for stage context
    const caseRes = await supabaseDbRequest('registration_cases', 'select=*&user_id=eq.' + encodeURIComponent(targetUserId) + '&limit=1');
    const regCase = caseRes.ok && Array.isArray(caseRes.data) && caseRes.data[0] ? caseRes.data[0] : null;
    const stage = (body && body.stage) || (regCase && regCase.stage) || null;
    const substage = (body && body.substage) || (regCase && regCase.substage) || null;
    const tpl = resolveNudgeTemplate(stage, substage);
    const title = sanitizeUserString(body && body.title, 200) || tpl.title;
    const message = sanitizeUserString(body && body.message, 1200) || tpl.body;
    const pRes = await supabaseDbRequest('user_profiles', 'select=first_name&user_id=eq.' + encodeURIComponent(targetUserId) + '&limit=1');
    const firstName = pRes.ok && Array.isArray(pRes.data) && pRes.data[0] ? pRes.data[0].first_name : '';
    const whatsappLink = buildWhatsAppLink(stage, firstName);

    const insertRes = await supabaseDbRequest('user_nudges', '', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: [{
        user_id: targetUserId,
        case_id: regCase ? regCase.id : null,
        stage: stage,
        substage: substage,
        title: title,
        message: message,
        whatsapp_number: HAZEL_WHATSAPP_NUMBER,
        delivered_channels: ['in_app'],
        status: 'pending',
        created_by: adminCtx.email
      }]
    });
    const nudge = insertRes.ok && Array.isArray(insertRes.data) && insertRes.data[0] ? insertRes.data[0] : null;
    if (!nudge) { sendJson(res, 502, { ok: false, message: 'Failed to create nudge.' }); return; }
    // Log to case timeline
    if (regCase) {
      await _logCaseEvent(regCase.id, null, 'note', 'Nudge sent', title + ' — ' + message, adminCtx.email);
      await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(regCase.id), { method: 'PATCH', body: { last_va_action_at: new Date().toISOString() } });
    }
    sendJson(res, 200, { ok: true, nudge: nudge, whatsapp_link: whatsappLink });
    return;
  }

  // ── Per-user qualification snapshot (VA detail panel) ──
  if (pathname === '/api/admin/va/user-qualifications' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const userId = url.searchParams.get('user_id');
    if (!userId) { sendJson(res, 400, { ok: false, message: 'user_id required.' }); return; }
    const pRes = await supabaseDbRequest('user_profiles', 'select=country_of_qualification&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
    const sRes = await supabaseDbRequest('user_state', 'select=state&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
    let country = 'GB';
    if (pRes.ok && Array.isArray(pRes.data) && pRes.data[0] && pRes.data[0].country_of_qualification) country = String(pRes.data[0].country_of_qualification).toUpperCase();
    else if (sRes.ok && Array.isArray(sRes.data) && sRes.data[0]) {
      const st = sRes.data[0].state || {};
      const raw = (st.gp_selected_country || (st.gp_onboarding && st.gp_onboarding.country) || 'GB').toString().toUpperCase();
      country = ({ 'UNITED KINGDOM': 'GB', 'UK': 'GB', 'GREAT BRITAIN': 'GB', 'IRELAND': 'IE', 'NEW ZEALAND': 'NZ' })[raw] || (['GB','IE','NZ'].includes(raw) ? raw : 'GB');
    }
    const snap = await getUserQualificationSnapshot(userId, country);
    sendJson(res, 200, { ok: true, snapshot: snap });
    return;
  }

  // ── Weekly check-in sweep (create chase tasks for stalled GPs) ──
  if (pathname === '/api/admin/va/weekly-checkin/sweep' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;

    const now = new Date();
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Only in-scope stages for this run: myintealth + amc. Active or blocked cases only.
    const casesRes = await supabaseDbRequest('registration_cases',
      'select=id,user_id,stage,substage,status,created_at,last_gp_activity_at' +
      '&stage=in.(myintealth,amc)&status=in.(active,blocked)' +
      '&created_at=lte.' + encodeURIComponent(twoWeeksAgo));
    const cases = casesRes.ok && Array.isArray(casesRes.data) ? casesRes.data : [];

    let created = 0, skipped = 0;
    for (const c of cases) {
      const lastActivity = c.last_gp_activity_at || c.created_at;
      if (!lastActivity || lastActivity > twoWeeksAgo) { skipped++; continue; }
      // Skip if a weekly check-in task was already created in the last 7 days
      const existingRes = await supabaseDbRequest('registration_tasks',
        'select=id,created_at&case_id=eq.' + encodeURIComponent(c.id) +
        '&task_type=eq.chase&source_trigger=eq.weekly_checkin&created_at=gte.' + encodeURIComponent(sevenDaysAgo) + '&limit=1');
      if (existingRes.ok && Array.isArray(existingRes.data) && existingRes.data.length > 0) { skipped++; continue; }
      await _createRegTask(c.id, {
        task_type: 'chase',
        title: 'Weekly check-in — GP stalled ≥14 days on ' + c.stage,
        description: 'GP has not progressed in ≥14 days. Reach out via WhatsApp or send an in-app nudge.',
        priority: 'high',
        source_trigger: 'weekly_checkin',
        related_stage: c.stage,
        related_substage: c.substage || null,
        _actor: 'system'
      });
      created++;
    }
    invalidateAdminDashboardCache();
    sendJson(res, 200, { ok: true, scanned: cases.length, created: created, skipped: skipped });
    return;
  }

  // ══════ User-facing nudge endpoints ══════

  // ── List my nudges (unread first) ──
  if (pathname === '/api/user/nudges' && req.method === 'GET') {
    const session = requireSession(req, res);
    if (!session) return;
    if (!isSupabaseDbConfigured()) { sendJson(res, 200, { ok: true, nudges: [] }); return; }
    const email = getSessionEmail(session);
    const userId = email ? await getSupabaseUserIdByEmail(email) : null;
    if (!userId) { sendJson(res, 200, { ok: true, nudges: [] }); return; }
    const r = await supabaseDbRequest('user_nudges',
      'select=*&user_id=eq.' + encodeURIComponent(userId) + '&status=in.(pending,delivered)&order=created_at.desc&limit=50');
    const nudges = r.ok && Array.isArray(r.data) ? r.data : [];
    // Mark as delivered on first fetch (pending → delivered)
    const pendingIds = nudges.filter(function (n) { return n.status === 'pending'; }).map(function (n) { return n.id; });
    if (pendingIds.length > 0) {
      await supabaseDbRequest('user_nudges', 'id=in.(' + pendingIds.map(encodeURIComponent).join(',') + ')',
        { method: 'PATCH', body: { status: 'delivered', delivered_at: new Date().toISOString() } });
    }
    sendJson(res, 200, { ok: true, nudges: nudges, whatsapp_number: HAZEL_WHATSAPP_NUMBER });
    return;
  }

  // ── Mark nudge read/dismissed ──
  const nudgeReadMatch = pathname.match(/^\/api\/user\/nudges\/([^/]+)\/(read|dismiss)$/);
  if (nudgeReadMatch && req.method === 'PUT') {
    const session = requireSession(req, res);
    if (!session) return;
    if (!isSupabaseDbConfigured()) { sendJson(res, 200, { ok: true }); return; }
    const email = getSessionEmail(session);
    const userId = email ? await getSupabaseUserIdByEmail(email) : null;
    if (!userId) { sendJson(res, 400, { ok: false }); return; }
    const nudgeId = decodeURIComponent(nudgeReadMatch[1] || '');
    const nextStatus = nudgeReadMatch[2] === 'dismiss' ? 'dismissed' : 'read';
    const patch = { status: nextStatus };
    if (nextStatus === 'read') patch.read_at = new Date().toISOString();
    const r = await supabaseDbRequest('user_nudges',
      'id=eq.' + encodeURIComponent(nudgeId) + '&user_id=eq.' + encodeURIComponent(userId),
      { method: 'PATCH', body: patch });
    sendJson(res, r.ok ? 200 : 502, { ok: !!r.ok });
    return;
  }

  // TEMP: Seed onboarding data for a test user
  if (pathname === '/api/admin/seed-onboarding' && req.method === 'POST') {
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const targetEmail = (body && body.email || '').trim().toLowerCase();
    const country = body && body.country || 'GB';
    if (!targetEmail) { sendJson(res, 400, { ok: false, message: 'email required' }); return; }

    const COUNTRY_NAMES = { GB: 'United Kingdom', IE: 'Ireland', NZ: 'New Zealand' };
    const countryName = COUNTRY_NAMES[country] || country;

    if (isSupabaseDbConfigured()) {
      const userId = await getSupabaseUserIdByEmail(targetEmail);
      if (!userId) { sendJson(res, 404, { ok: false, message: 'User not found' }); return; }
      const remote = await getSupabaseUserStateByEmail(targetEmail);
      const current = remote && remote.state && typeof remote.state === 'object' ? remote.state : {};
      current.gp_onboarding_complete = true;
      current.gp_selected_country = countryName;
      current.gp_onboarding = {
        country: country,
        completedAt: new Date().toISOString(),
        step: 5,
        preferredCity: 'Melbourne',
        targetDate: '2026-09',
        whoMoving: 'Just me',
        childrenCount: '0',
        accountReviewFlag: false
      };
      // Clear old docs state so it re-initialises with the correct country
      delete current.gp_documents_prep;
      await upsertSupabaseUserState(userId, current, new Date().toISOString());

      // Update profile
      await supabaseDbRequest('user_profiles', `user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: {
          qualification_country: country,
          preferred_city: 'Melbourne',
          target_arrival_date: '2026-09',
          who_moving: 'Just me',
          children_count: '0',
          onboarding_completed_at: new Date().toISOString()
        }
      });
      sendJson(res, 200, { ok: true, message: `Onboarding seeded for ${targetEmail} with country ${countryName}` });
    } else {
      sendJson(res, 503, { ok: false, message: 'Requires Supabase' });
    }
    return;
  }

  const adminTicketMatch = pathname.match(/^\/api\/admin\/tickets\/([^/]+)$/);
  if (adminTicketMatch && req.method === 'PUT') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Admin ticket updates require Supabase database configuration.' });
      return;
    }
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
    const candidateEmail = body && typeof body.candidateEmail === 'string' ? body.candidateEmail.trim().toLowerCase() : '';
    const candidateUserId = body && typeof body.candidateUserId === 'string' ? body.candidateUserId.trim() : '';

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
    }, { candidateEmail, candidateUserId });

    if (!updatedTicket) {
      sendJson(res, 404, { ok: false, message: 'Ticket not found.' });
      return;
    }

    sendJson(res, 200, { ok: true, ticket: updatedTicket });
    return;
  }

  // ── Rate-limit helper for new endpoints ──
  function enforceApiRateLimit(req, res, session) {
    const userId = getSessionSupabaseUserId(session) || getSessionEmail(session) || getClientIp(req);
    const ts = Date.now();
    const timestamps = (_apiRateLimitStore.get(userId) || []).filter((t) => ts - t < API_RATE_WINDOW_MS);
    if (timestamps.length >= API_RATE_MAX_REQUESTS) {
      sendJson(res, 429, { ok: false, message: 'Too many requests. Please try again later.' });
      return false;
    }
    timestamps.push(ts);
    _apiRateLimitStore.set(userId, timestamps);
    return true;
  }

  // ── Registration prerequisite check ──
  if (pathname === '/api/registration/can-proceed' && req.method === 'GET') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Registration API requires Supabase database configuration.' });
      return;
    }
    const session = requireSession(req, res);
    if (!session) return;
    if (!enforceApiRateLimit(req, res, session)) return;

    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }

    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }

    // Fetch user state
    const stateResult = await getSupabaseUserStateByEmail(email);
    const userState = stateResult && stateResult.state && typeof stateResult.state === 'object' ? stateResult.state : {};

    // Determine career_secured from gp_career_state
    const careerState = userState.gp_career_state && typeof userState.gp_career_state === 'object' ? userState.gp_career_state : {};
    const careerSecured = !!(careerState.career_secured || careerState.secured);

    // Check AHPRA progress
    const ahpraProgress = userState.gp_ahpra_progress && typeof userState.gp_ahpra_progress === 'object' ? userState.gp_ahpra_progress : {};
    const ahpraCompleted = !!(ahpraProgress.completed || ahpraProgress.status === 'completed' || ahpraProgress.status === 'approved');

    // Check visa status from DB
    let visaGranted = false;
    if (isSupabaseDbConfigured()) {
      const visaResult = await supabaseDbRequest(
        'visa_applications',
        `select=stage&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=1`
      );
      if (visaResult.ok && Array.isArray(visaResult.data) && visaResult.data.length > 0) {
        visaGranted = visaResult.data[0].stage === 'granted';
      }
    }

    // Check PBS status from DB
    let pbsApproved = false;
    if (isSupabaseDbConfigured()) {
      const pbsResult = await supabaseDbRequest(
        'pbs_applications',
        `select=status&user_id=eq.${encodeURIComponent(userId)}&status=eq.approved&limit=1`
      );
      if (pbsResult.ok && Array.isArray(pbsResult.data) && pbsResult.data.length > 0) {
        pbsApproved = true;
      }
    }

    const BYPASS_LOCK_EMAILS_REG = new Set(['hello@mygplink.com.au']);
    const bypassAll = BYPASS_LOCK_EMAILS_REG.has(email);
    const steps = {
      career: { accessible: true, completed: careerSecured },
      ahpra: { accessible: bypassAll || careerSecured, completed: ahpraCompleted, locked_reason: (bypassAll || careerSecured) ? null : 'Career must be secured first.' },
      visa: { accessible: bypassAll || ahpraCompleted, completed: visaGranted, locked_reason: (bypassAll || ahpraCompleted) ? null : 'AHPRA registration must be completed first.' },
      pbs: { accessible: bypassAll || visaGranted, completed: pbsApproved, locked_reason: (bypassAll || visaGranted) ? null : 'Visa must be granted first.' },
      commencement: { accessible: bypassAll || pbsApproved, completed: false, locked_reason: (bypassAll || pbsApproved) ? null : 'PBS/Medicare must be approved first.' }
    };

    sendJson(res, 200, { ok: true, steps });
    return;
  }

  // ── Visa Status ──
  if (pathname === '/api/visa/status' && req.method === 'GET') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Visa API requires Supabase database configuration.' });
      return;
    }
    const session = requireSession(req, res);
    if (!session) return;
    if (!enforceApiRateLimit(req, res, session)) return;

    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }

    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }

    const result = await supabaseDbRequest(
      'visa_applications',
      `select=*&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=1`
    );
    if (!result.ok) {
      sendJson(res, 502, { ok: false, message: 'Failed to fetch visa status.' });
      return;
    }

    const application = Array.isArray(result.data) && result.data.length > 0 ? result.data[0] : null;

    // Fetch related data if case exists
    let documents = [];
    let updates = [];
    let timelineEvents = [];
    let dependants = [];
    if (application) {
      const caseId = encodeURIComponent(application.id);
      const [docsRes, updatesRes, eventsRes, depsRes] = await Promise.all([
        supabaseDbRequest('visa_documents', `select=*&visa_application_id=eq.${caseId}&order=uploaded_at.desc`),
        supabaseDbRequest('visa_updates', `select=*&visa_case_id=eq.${caseId}&visibility=eq.gp&order=created_at.desc`),
        supabaseDbRequest('visa_timeline_events', `select=*&visa_case_id=eq.${caseId}&visible_to_gp=eq.true&order=created_at.desc`),
        supabaseDbRequest('visa_dependants', `select=*&visa_case_id=eq.${caseId}&order=created_at.asc`)
      ]);
      if (docsRes.ok && Array.isArray(docsRes.data)) documents = docsRes.data;
      if (updatesRes.ok && Array.isArray(updatesRes.data)) updates = updatesRes.data;
      if (eventsRes.ok && Array.isArray(eventsRes.data)) timelineEvents = eventsRes.data;
      if (depsRes.ok && Array.isArray(depsRes.data)) dependants = depsRes.data;
    }

    sendJson(res, 200, { ok: true, application, documents, updates, timelineEvents, dependants });
    return;
  }

  // ── Visa Update (admin-only) ──
  if (pathname === '/api/visa/update' && req.method === 'POST') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Visa API requires Supabase database configuration.' });
      return;
    }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const applicationId = String(body && body.applicationId || '').trim();
    const targetUserId = String(body && body.userId || '').trim();
    if (!applicationId && !targetUserId) {
      sendJson(res, 400, { ok: false, message: 'Missing applicationId or userId.' });
      return;
    }

    const stage = body && typeof body.stage === 'string' && VISA_STAGES.includes(body.stage) ? body.stage : null;
    const sponsorStatus = body && typeof body.sponsorStatus === 'string' ? body.sponsorStatus.trim().slice(0, 200) : undefined;
    const noteText = body && typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';

    const updatePayload = { updated_at: new Date().toISOString() };
    if (stage) {
      updatePayload.stage = stage;
      if (stage === 'nomination' && body.nominationDate) updatePayload.nomination_date = body.nominationDate;
      if (stage === 'lodgement' && body.lodgementDate) updatePayload.lodgement_date = body.lodgementDate;
      if (stage === 'granted' && body.grantDate) updatePayload.grant_date = body.grantDate;
    }
    if (sponsorStatus !== undefined) updatePayload.sponsor_status = sponsorStatus;

    // V2 case management fields
    const v2StringFields = {
      visa_type: 'visaType', responsible_party: 'responsibleParty',
      estimated_timeline: 'estimatedTimeline', current_action_title: 'currentActionTitle',
      current_action_description: 'currentActionDescription', current_action_owner: 'currentActionOwner',
      sponsor_name: 'sponsorName', sponsor_contact: 'sponsorContact',
      reference_number: 'referenceNumber', status_message: 'statusMessage'
    };
    for (const [dbCol, bodyKey] of Object.entries(v2StringFields)) {
      if (body && typeof body[bodyKey] === 'string') updatePayload[dbCol] = body[bodyKey].trim().slice(0, 500);
    }
    if (body && body.currentActionDueDate) {
      updatePayload.current_action_due_date = typeof body.currentActionDueDate === 'string' ? body.currentActionDueDate.slice(0, 10) : null;
    }

    // If we have an applicationId, update directly
    let filterQuery;
    if (applicationId) {
      filterQuery = `id=eq.${encodeURIComponent(applicationId)}`;
    } else {
      // Create or update by userId
      const existingResult = await supabaseDbRequest(
        'visa_applications',
        `select=id,notes&user_id=eq.${encodeURIComponent(targetUserId)}&order=created_at.desc&limit=1`
      );
      if (existingResult.ok && Array.isArray(existingResult.data) && existingResult.data.length > 0) {
        filterQuery = `id=eq.${encodeURIComponent(existingResult.data[0].id)}`;
        // Append note to existing notes
        if (noteText) {
          const existingNotes = Array.isArray(existingResult.data[0].notes) ? existingResult.data[0].notes : [];
          existingNotes.push({ text: noteText, author: adminCtx.email, ts: new Date().toISOString() });
          updatePayload.notes = existingNotes;
        }
      } else {
        // Create new application
        const createPayload = {
          user_id: targetUserId,
          stage: stage || 'nomination',
          visa_subclass: body && typeof body.visaSubclass === 'string' ? body.visaSubclass.trim().slice(0, 100) : null,
          job_id: body && typeof body.jobId === 'string' ? body.jobId.trim() : null,
          sponsor_status: sponsorStatus || null,
          notes: noteText ? [{ text: noteText, author: adminCtx.email, ts: new Date().toISOString() }] : [],
          nomination_date: body && body.nominationDate || null,
          lodgement_date: body && body.lodgementDate || null,
          grant_date: body && body.grantDate || null,
          visa_type: body && typeof body.visaType === 'string' ? body.visaType.trim().slice(0, 200) : null,
          responsible_party: body && typeof body.responsibleParty === 'string' ? body.responsibleParty.trim().slice(0, 200) : null,
          estimated_timeline: body && typeof body.estimatedTimeline === 'string' ? body.estimatedTimeline.trim().slice(0, 200) : null,
          current_action_title: body && typeof body.currentActionTitle === 'string' ? body.currentActionTitle.trim().slice(0, 500) : null,
          current_action_description: body && typeof body.currentActionDescription === 'string' ? body.currentActionDescription.trim().slice(0, 2000) : null,
          current_action_owner: body && typeof body.currentActionOwner === 'string' ? body.currentActionOwner.trim().slice(0, 200) : null,
          current_action_due_date: body && typeof body.currentActionDueDate === 'string' ? body.currentActionDueDate.slice(0, 10) : null,
          sponsor_name: body && typeof body.sponsorName === 'string' ? body.sponsorName.trim().slice(0, 200) : null,
          sponsor_contact: body && typeof body.sponsorContact === 'string' ? body.sponsorContact.trim().slice(0, 200) : null,
          reference_number: body && typeof body.referenceNumber === 'string' ? body.referenceNumber.trim().slice(0, 100) : null,
          status_message: body && typeof body.statusMessage === 'string' ? body.statusMessage.trim().slice(0, 500) : null
        };
        const createResult = await supabaseDbRequest('visa_applications', '', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: [createPayload]
        });
        if (!createResult.ok) {
          sendJson(res, 502, { ok: false, message: 'Failed to create visa application.' });
          return;
        }
        const created = Array.isArray(createResult.data) && createResult.data.length > 0 ? createResult.data[0] : null;
        // Auto-create "Case created" timeline event + link to reg case
        if (created) {
          await supabaseDbRequest('visa_timeline_events', '', {
            method: 'POST',
            body: [{ visa_case_id: created.id, event_title: 'Visa case created', event_description: created.visa_subclass ? 'Subclass ' + created.visa_subclass : null, visible_to_gp: true, created_by: adminCtx.email }]
          });
          // Link visa case to registration case and create initial task
          _linkVisaCaseToRegCase(targetUserId, created.id).catch(function () {});
          const rc = await _getRegCaseForUser(targetUserId);
          if (rc) {
            _createVaTask(rc.id, {
              task_type: 'visa_stage', title: 'Review visa case setup',
              domain: 'visa', visa_case_id: created.id,
              priority: 'high', source_trigger: 'visa_case_created',
              related_stage: 'visa', _actor: adminCtx.email
            }).catch(function () {});
          }
        }
        sendJson(res, 201, { ok: true, application: created });
        return;
      }
    }

    if (noteText && !updatePayload.notes) {
      // Fetch existing notes to append
      const fetchResult = await supabaseDbRequest(
        'visa_applications',
        `select=notes&${filterQuery}`
      );
      if (fetchResult.ok && Array.isArray(fetchResult.data) && fetchResult.data.length > 0) {
        const existingNotes = Array.isArray(fetchResult.data[0].notes) ? fetchResult.data[0].notes : [];
        existingNotes.push({ text: noteText, author: adminCtx.email, ts: new Date().toISOString() });
        updatePayload.notes = existingNotes;
      }
    }

    // Capture old stage before update for auto-timeline
    let oldStage = null;
    let caseIdForEvents = null;
    if (stage && filterQuery) {
      const oldRes = await supabaseDbRequest('visa_applications', `select=id,stage&${filterQuery}`);
      if (oldRes.ok && Array.isArray(oldRes.data) && oldRes.data.length > 0) {
        oldStage = oldRes.data[0].stage;
        caseIdForEvents = oldRes.data[0].id;
      }
    }

    const updateResult = await supabaseDbRequest('visa_applications', filterQuery, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: updatePayload
    });
    if (!updateResult.ok) {
      sendJson(res, 502, { ok: false, message: 'Failed to update visa application.' });
      return;
    }

    const updated = Array.isArray(updateResult.data) && updateResult.data.length > 0 ? updateResult.data[0] : null;

    // Auto-create timeline events for stage transitions
    if (updated && stage && oldStage && stage !== oldStage) {
      const stageLabels = { nomination: 'Nomination', lodgement: 'Lodgement', processing: 'Processing', granted: 'Granted', refused: 'Refused' };
      const label = stageLabels[stage] || stage;
      await supabaseDbRequest('visa_timeline_events', '', {
        method: 'POST',
        body: [{ visa_case_id: updated.id, event_title: 'Stage changed to ' + label, visible_to_gp: true, created_by: adminCtx.email }]
      });
      pushVisaNotificationToOwner(updated.id, { type: 'action', title: 'Visa stage updated', detail: 'Your visa case has moved to ' + label });
    }

    // Fire-and-forget: create/complete visa tasks
    if (updated && updated.user_id) {
      const visaChanges = {};
      if (stage && oldStage && stage !== oldStage) visaChanges.stage = stage;
      if (updatePayload.sponsor_name) visaChanges.sponsorName = updatePayload.sponsor_name;
      if (updatePayload.sponsor_contact) visaChanges.sponsorContact = updatePayload.sponsor_contact;
      if (Object.keys(visaChanges).length > 0) {
        processVisaTaskAutomation(updated.id, updated.user_id, visaChanges, adminCtx.email).catch(function () {});
      }
    }

    sendJson(res, 200, { ok: true, application: updated });
    return;
  }

  // ── Visa Document Upload ──
  if (pathname === '/api/visa/documents' && req.method === 'POST') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Visa API requires Supabase database configuration.' });
      return;
    }
    const session = requireSession(req, res);
    if (!session) return;
    if (!enforceApiRateLimit(req, res, session)) return;

    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }

    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const visaApplicationId = String(body && body.visaApplicationId || '').trim();
    const documentType = String(body && body.documentType || '').trim().slice(0, 200);
    const fileDataUrl = typeof body.fileDataUrl === 'string' ? body.fileDataUrl.trim() : '';
    const fileName = sanitizeUserString(body && body.fileName, 240);
    const mimeType = sanitizeUserString(body && body.mimeType, 160);

    if (!visaApplicationId || !documentType || !fileDataUrl || !fileName) {
      sendJson(res, 400, { ok: false, message: 'Missing required fields: visaApplicationId, documentType, fileDataUrl, fileName.' });
      return;
    }

    // Verify the visa application belongs to this user
    const ownerCheck = await supabaseDbRequest(
      'visa_applications',
      `select=id&id=eq.${encodeURIComponent(visaApplicationId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`
    );
    if (!ownerCheck.ok || !Array.isArray(ownerCheck.data) || ownerCheck.data.length === 0) {
      sendJson(res, 403, { ok: false, message: 'Visa application not found or not owned by user.' });
      return;
    }

    // Upload to storage
    const storagePath = ['users', sanitizeStoragePathSegment(userId, 80), 'visa-documents', sanitizeStoragePathSegment(visaApplicationId, 80), sanitizeStoragePathSegment(documentType, 120), 'current'].join('/');
    const uploaded = await supabaseStorageUploadObject(SUPABASE_DOCUMENT_BUCKET, storagePath, fileDataUrl, mimeType);
    if (!uploaded) {
      sendJson(res, 502, { ok: false, message: 'Failed to upload visa document.' });
      return;
    }

    // Insert document record
    const docResult = await supabaseDbRequest('visa_documents', '', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: [{
        visa_application_id: visaApplicationId,
        document_type: documentType,
        file_path: storagePath,
        verified: false,
        status: 'uploaded',
        original_file_name: fileName,
        uploaded_by_user_id: userId
      }]
    });
    if (!docResult.ok) {
      sendJson(res, 502, { ok: false, message: 'Failed to save visa document record.' });
      return;
    }

    const doc = Array.isArray(docResult.data) && docResult.data.length > 0 ? docResult.data[0] : null;

    // Auto-create timeline event for the upload
    await supabaseDbRequest('visa_timeline_events', '', {
      method: 'POST',
      body: [{ visa_case_id: visaApplicationId, event_title: documentType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) + ' uploaded', visible_to_gp: true, created_by: 'system' }]
    });

    // Create review task for VA
    const rc = await _getRegCaseForUser(userId);
    if (rc) {
      _createVaTask(rc.id, {
        task_type: 'visa_doc', title: 'Review visa document: ' + documentType.replace(/_/g, ' '),
        domain: 'visa', visa_case_id: visaApplicationId,
        source_trigger: 'visa_doc_upload', related_stage: 'visa',
        related_document_key: documentType, _actor: 'system'
      }).catch(function () {});
    }

    sendJson(res, 201, { ok: true, document: doc });
    return;
  }

  // ── Visa Timeline ──
  if (pathname === '/api/visa/timeline' && req.method === 'GET') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Visa API requires Supabase database configuration.' });
      return;
    }
    const session = requireSession(req, res);
    if (!session) return;
    if (!enforceApiRateLimit(req, res, session)) return;

    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }

    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }

    // Fetch all visa applications for the user
    const appsResult = await supabaseDbRequest(
      'visa_applications',
      `select=*&user_id=eq.${encodeURIComponent(userId)}&order=created_at.asc`
    );
    if (!appsResult.ok) {
      sendJson(res, 502, { ok: false, message: 'Failed to fetch visa timeline.' });
      return;
    }

    const applications = Array.isArray(appsResult.data) ? appsResult.data : [];

    // Build timeline events from notes and stage dates
    const timeline = [];
    for (const app of applications) {
      if (app.created_at) {
        timeline.push({ type: 'created', date: app.created_at, stage: app.stage, visaSubclass: app.visa_subclass });
      }
      if (app.nomination_date) {
        timeline.push({ type: 'nomination', date: app.nomination_date, applicationId: app.id });
      }
      if (app.lodgement_date) {
        timeline.push({ type: 'lodgement', date: app.lodgement_date, applicationId: app.id });
      }
      if (app.grant_date) {
        timeline.push({ type: 'granted', date: app.grant_date, applicationId: app.id });
      }
      if (Array.isArray(app.notes)) {
        for (const note of app.notes) {
          if (note && note.ts) {
            timeline.push({ type: 'note', date: note.ts, text: note.text, author: note.author, applicationId: app.id });
          }
        }
      }
    }

    // Sort timeline chronologically
    timeline.sort((a, b) => {
      const da = new Date(a.date || 0).getTime();
      const db = new Date(b.date || 0).getTime();
      return da - db;
    });

    sendJson(res, 200, { ok: true, timeline });
    return;
  }

  // ── Visa Updates (GP reads, admin writes) ──
  if (pathname === '/api/visa/updates' && req.method === 'GET') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const session = requireSession(req, res);
    if (!session) return;
    if (!enforceApiRateLimit(req, res, session)) return;
    const email = getSessionEmail(session);
    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }
    const caseId = url.searchParams.get('caseId');
    if (!caseId) { sendJson(res, 400, { ok: false, message: 'Missing caseId.' }); return; }
    // Verify ownership
    const own = await supabaseDbRequest('visa_applications', `select=id&id=eq.${encodeURIComponent(caseId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    if (!own.ok || !Array.isArray(own.data) || own.data.length === 0) { sendJson(res, 403, { ok: false, message: 'Not authorized.' }); return; }
    const updatesRes = await supabaseDbRequest('visa_updates', `select=*&visa_case_id=eq.${encodeURIComponent(caseId)}&visibility=eq.gp&order=created_at.desc`);
    sendJson(res, 200, { ok: true, updates: updatesRes.ok && Array.isArray(updatesRes.data) ? updatesRes.data : [] });
    return;
  }

  if (pathname === '/api/visa/updates' && req.method === 'POST') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx2 = requireAdminSession(req, res);
    if (!adminCtx2) return;
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, message: 'Invalid body.' }); return; }
    const caseId = String(body && body.caseId || '').trim();
    const noteBody = String(body && body.body || '').trim().slice(0, 4000);
    const visibility = body && body.visibility === 'internal' ? 'internal' : 'gp';
    if (!caseId || !noteBody) { sendJson(res, 400, { ok: false, message: 'Missing caseId or body.' }); return; }
    const insertRes = await supabaseDbRequest('visa_updates', '', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: [{ visa_case_id: caseId, body: noteBody, visibility, created_by: adminCtx2.email }]
    });
    if (!insertRes.ok) { sendJson(res, 502, { ok: false, message: 'Failed to create update.' }); return; }
    // Auto-create timeline event for GP-visible updates
    if (visibility === 'gp') {
      await supabaseDbRequest('visa_timeline_events', '', {
        method: 'POST',
        body: [{ visa_case_id: caseId, event_title: 'New update from GP Link team', visible_to_gp: true, created_by: adminCtx2.email }]
      });
      pushVisaNotificationToOwner(caseId, { type: 'info', title: 'Visa update', detail: noteBody.length > 80 ? noteBody.slice(0, 77) + '...' : noteBody });
    }
    const update = Array.isArray(insertRes.data) && insertRes.data.length > 0 ? insertRes.data[0] : null;
    sendJson(res, 201, { ok: true, update });
    return;
  }

  // ── Visa Timeline Events (admin creates) ──
  if (pathname === '/api/visa/events' && req.method === 'POST') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx3 = requireAdminSession(req, res);
    if (!adminCtx3) return;
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, message: 'Invalid body.' }); return; }
    const caseId = String(body && body.caseId || '').trim();
    const eventTitle = String(body && body.eventTitle || '').trim().slice(0, 500);
    const eventDescription = body && typeof body.eventDescription === 'string' ? body.eventDescription.trim().slice(0, 2000) : null;
    const visibleToGp = body && body.visibleToGp === false ? false : true;
    if (!caseId || !eventTitle) { sendJson(res, 400, { ok: false, message: 'Missing caseId or eventTitle.' }); return; }
    const insertRes = await supabaseDbRequest('visa_timeline_events', '', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: [{ visa_case_id: caseId, event_title: eventTitle, event_description: eventDescription, visible_to_gp: visibleToGp, created_by: adminCtx3.email }]
    });
    if (!insertRes.ok) { sendJson(res, 502, { ok: false, message: 'Failed to create event.' }); return; }
    const evt = Array.isArray(insertRes.data) && insertRes.data.length > 0 ? insertRes.data[0] : null;
    sendJson(res, 201, { ok: true, event: evt });
    return;
  }

  // ── Visa Document Review (admin approves/rejects) ──
  if (pathname === '/api/visa/documents/review' && req.method === 'POST') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx4 = requireAdminSession(req, res);
    if (!adminCtx4) return;
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, message: 'Invalid body.' }); return; }
    const documentId = String(body && body.documentId || '').trim();
    const status = String(body && body.status || '').trim();
    if (!documentId || !['approved', 'rejected', 'under_review'].includes(status)) {
      sendJson(res, 400, { ok: false, message: 'Missing documentId or invalid status (approved|rejected|under_review).' }); return;
    }
    const payload = { status, verified: status === 'approved', reviewed_by: adminCtx4.email, reviewed_at: new Date().toISOString() };
    if (status === 'rejected' && body && typeof body.rejectionReason === 'string') {
      payload.rejection_reason = body.rejectionReason.trim().slice(0, 1000);
    }
    if (status !== 'rejected') payload.rejection_reason = null;
    const updateRes = await supabaseDbRequest('visa_documents', `id=eq.${encodeURIComponent(documentId)}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: payload
    });
    if (!updateRes.ok) { sendJson(res, 502, { ok: false, message: 'Failed to review document.' }); return; }
    const doc = Array.isArray(updateRes.data) && updateRes.data.length > 0 ? updateRes.data[0] : null;
    // Auto-create timeline event
    if (doc && doc.visa_application_id) {
      const docLabel = (doc.document_type || 'Document').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      await supabaseDbRequest('visa_timeline_events', '', {
        method: 'POST',
        body: [{ visa_case_id: doc.visa_application_id, event_title: docLabel + ' ' + status, visible_to_gp: true, created_by: adminCtx4.email }]
      });
      const notifType = status === 'approved' ? 'success' : 'action';
      const notifDetail = status === 'approved' ? docLabel + ' has been approved' : docLabel + ' was rejected — please re-upload';
      pushVisaNotificationToOwner(doc.visa_application_id, { type: notifType, title: 'Document ' + status, detail: notifDetail });
    }
    sendJson(res, 200, { ok: true, document: doc });
    return;
  }

  // ── Visa Document Request (admin requests doc from GP) ──
  if (pathname === '/api/visa/documents/request' && req.method === 'POST') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtxReq = requireAdminSession(req, res);
    if (!adminCtxReq) return;
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, message: 'Invalid body.' }); return; }
    const caseId = String(body && body.caseId || '').trim();
    const documentType = String(body && body.documentType || '').trim().slice(0, 200);
    const requestNote = body && typeof body.requestNote === 'string' ? body.requestNote.trim().slice(0, 1000) : null;
    if (!caseId || !documentType) { sendJson(res, 400, { ok: false, message: 'Missing caseId or documentType.' }); return; }
    // Find the visa_application_id (caseId IS the visa_application id)
    const caseCheck = await supabaseDbRequest('visa_applications', `select=id&id=eq.${encodeURIComponent(caseId)}&limit=1`);
    if (!caseCheck.ok || !Array.isArray(caseCheck.data) || caseCheck.data.length === 0) {
      sendJson(res, 404, { ok: false, message: 'Visa case not found.' }); return;
    }
    const insertRes = await supabaseDbRequest('visa_documents', '', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: [{
        visa_application_id: caseId,
        document_type: documentType,
        file_path: '',
        verified: false,
        status: 'missing',
        requested_by: adminCtxReq.email,
        requested_at: new Date().toISOString(),
        request_note: requestNote
      }]
    });
    if (!insertRes.ok) { sendJson(res, 502, { ok: false, message: 'Failed to create document request.' }); return; }
    const doc = Array.isArray(insertRes.data) && insertRes.data.length > 0 ? insertRes.data[0] : null;
    // Auto-timeline event
    const docLabel = documentType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    await supabaseDbRequest('visa_timeline_events', '', {
      method: 'POST',
      body: [{ visa_case_id: caseId, event_title: docLabel + ' requested', visible_to_gp: true, created_by: adminCtxReq.email }]
    });
    pushVisaNotificationToOwner(caseId, { type: 'action', title: 'Document requested', detail: docLabel + ' — please upload this document' });
    sendJson(res, 201, { ok: true, document: doc });
    return;
  }

  // ── Visa Dependants (GP CRUD) ──
  if (pathname === '/api/visa/dependants' && req.method === 'GET') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const session = requireSession(req, res);
    if (!session) return;
    if (!enforceApiRateLimit(req, res, session)) return;
    const email = getSessionEmail(session);
    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }
    const caseId = url.searchParams.get('caseId');
    if (!caseId) { sendJson(res, 400, { ok: false, message: 'Missing caseId.' }); return; }
    const own = await supabaseDbRequest('visa_applications', `select=id&id=eq.${encodeURIComponent(caseId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    if (!own.ok || !Array.isArray(own.data) || own.data.length === 0) { sendJson(res, 403, { ok: false, message: 'Not authorized.' }); return; }
    const depRes = await supabaseDbRequest('visa_dependants', `select=*&visa_case_id=eq.${encodeURIComponent(caseId)}&order=created_at.asc`);
    sendJson(res, 200, { ok: true, dependants: depRes.ok && Array.isArray(depRes.data) ? depRes.data : [] });
    return;
  }

  if (pathname === '/api/visa/dependants' && req.method === 'POST') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const session = requireSession(req, res);
    if (!session) return;
    if (!enforceApiRateLimit(req, res, session)) return;
    const email = getSessionEmail(session);
    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, message: 'Invalid body.' }); return; }
    const caseId = String(body && body.caseId || '').trim();
    if (!caseId) { sendJson(res, 400, { ok: false, message: 'Missing caseId.' }); return; }
    const own = await supabaseDbRequest('visa_applications', `select=id&id=eq.${encodeURIComponent(caseId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    if (!own.ok || !Array.isArray(own.data) || own.data.length === 0) { sendJson(res, 403, { ok: false, message: 'Not authorized.' }); return; }
    const fullName = String(body.fullName || '').trim().slice(0, 200);
    const relationship = ['spouse', 'child', 'other'].includes(body.relationship) ? body.relationship : 'other';
    if (!fullName) { sendJson(res, 400, { ok: false, message: 'Missing fullName.' }); return; }
    const insertRes = await supabaseDbRequest('visa_dependants', '', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: [{
        visa_case_id: caseId,
        full_name: fullName,
        relationship: relationship,
        date_of_birth: body.dateOfBirth && typeof body.dateOfBirth === 'string' ? body.dateOfBirth.slice(0, 10) : null,
        passport_number: body.passportNumber && typeof body.passportNumber === 'string' ? body.passportNumber.trim().slice(0, 50) : null,
        passport_country: body.passportCountry && typeof body.passportCountry === 'string' ? body.passportCountry.trim().slice(0, 100) : null,
        notes: body.notes && typeof body.notes === 'string' ? body.notes.trim().slice(0, 500) : null
      }]
    });
    if (!insertRes.ok) { sendJson(res, 502, { ok: false, message: 'Failed to add dependant.' }); return; }
    const dep = Array.isArray(insertRes.data) && insertRes.data.length > 0 ? insertRes.data[0] : null;
    // Auto-timeline event
    if (dep) {
      await supabaseDbRequest('visa_timeline_events', '', {
        method: 'POST',
        body: [{ visa_case_id: caseId, event_title: 'Dependant added: ' + fullName, visible_to_gp: true, created_by: 'system' }]
      });
    }
    sendJson(res, 201, { ok: true, dependant: dep });
    return;
  }

  if (pathname === '/api/visa/dependants' && req.method === 'PATCH') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const session = requireSession(req, res);
    if (!session) return;
    if (!enforceApiRateLimit(req, res, session)) return;
    const email = getSessionEmail(session);
    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, message: 'Invalid body.' }); return; }
    const depId = String(body && body.id || '').trim();
    if (!depId) { sendJson(res, 400, { ok: false, message: 'Missing id.' }); return; }
    // Verify ownership through case
    const depCheck = await supabaseDbRequest('visa_dependants', `select=id,visa_case_id&id=eq.${encodeURIComponent(depId)}`);
    if (!depCheck.ok || !Array.isArray(depCheck.data) || depCheck.data.length === 0) { sendJson(res, 404, { ok: false, message: 'Dependant not found.' }); return; }
    const depCaseId = depCheck.data[0].visa_case_id;
    const own = await supabaseDbRequest('visa_applications', `select=id&id=eq.${encodeURIComponent(depCaseId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    if (!own.ok || !Array.isArray(own.data) || own.data.length === 0) { sendJson(res, 403, { ok: false, message: 'Not authorized.' }); return; }
    const patch = { updated_at: new Date().toISOString() };
    if (typeof body.fullName === 'string') patch.full_name = body.fullName.trim().slice(0, 200);
    if (['spouse', 'child', 'other'].includes(body.relationship)) patch.relationship = body.relationship;
    if (typeof body.dateOfBirth === 'string') patch.date_of_birth = body.dateOfBirth.slice(0, 10) || null;
    if (typeof body.passportNumber === 'string') patch.passport_number = body.passportNumber.trim().slice(0, 50);
    if (typeof body.passportCountry === 'string') patch.passport_country = body.passportCountry.trim().slice(0, 100);
    if (typeof body.notes === 'string') patch.notes = body.notes.trim().slice(0, 500);
    const updateRes = await supabaseDbRequest('visa_dependants', `id=eq.${encodeURIComponent(depId)}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch
    });
    if (!updateRes.ok) { sendJson(res, 502, { ok: false, message: 'Failed to update dependant.' }); return; }
    const updated = Array.isArray(updateRes.data) && updateRes.data.length > 0 ? updateRes.data[0] : null;
    sendJson(res, 200, { ok: true, dependant: updated });
    return;
  }

  if (pathname === '/api/visa/dependants' && req.method === 'DELETE') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const session = requireSession(req, res);
    if (!session) return;
    if (!enforceApiRateLimit(req, res, session)) return;
    const email = getSessionEmail(session);
    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }
    const depId = url.searchParams.get('id');
    if (!depId) { sendJson(res, 400, { ok: false, message: 'Missing id.' }); return; }
    const depCheck = await supabaseDbRequest('visa_dependants', `select=id,visa_case_id,full_name&id=eq.${encodeURIComponent(depId)}`);
    if (!depCheck.ok || !Array.isArray(depCheck.data) || depCheck.data.length === 0) { sendJson(res, 404, { ok: false, message: 'Dependant not found.' }); return; }
    const depCaseId = depCheck.data[0].visa_case_id;
    const depName = depCheck.data[0].full_name;
    const own = await supabaseDbRequest('visa_applications', `select=id&id=eq.${encodeURIComponent(depCaseId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    if (!own.ok || !Array.isArray(own.data) || own.data.length === 0) { sendJson(res, 403, { ok: false, message: 'Not authorized.' }); return; }
    const delRes = await supabaseDbRequest('visa_dependants', `id=eq.${encodeURIComponent(depId)}`, { method: 'DELETE' });
    if (!delRes.ok) { sendJson(res, 502, { ok: false, message: 'Failed to remove dependant.' }); return; }
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── Admin: Get Dependants for a case ──
  if (pathname === '/api/admin/visa/dependants' && req.method === 'GET') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtxDep = requireAdminSession(req, res);
    if (!adminCtxDep) return;
    const caseId = url.searchParams.get('caseId');
    if (!caseId) { sendJson(res, 400, { ok: false, message: 'Missing caseId.' }); return; }
    const depRes = await supabaseDbRequest('visa_dependants', `select=*&visa_case_id=eq.${encodeURIComponent(caseId)}&order=created_at.asc`);
    sendJson(res, 200, { ok: true, dependants: depRes.ok && Array.isArray(depRes.data) ? depRes.data : [] });
    return;
  }

  // ── Admin: List All Visa Cases ──
  if (pathname === '/api/admin/visa/cases' && req.method === 'GET') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx5 = requireAdminSession(req, res);
    if (!adminCtx5) return;
    const casesRes = await supabaseDbRequest('visa_applications', 'select=*&order=updated_at.desc&limit=100');
    if (!casesRes.ok) { sendJson(res, 502, { ok: false, message: 'Failed to fetch visa cases.' }); return; }
    const cases = Array.isArray(casesRes.data) ? casesRes.data : [];
    // Enrich with user profile names
    const userIds = [...new Set(cases.map(c => c.user_id).filter(Boolean))];
    let profileMap = {};
    if (userIds.length > 0) {
      const profilesRes = await supabaseDbRequest('user_profiles', `select=user_id,first_name,last_name,email&user_id=in.(${userIds.map(encodeURIComponent).join(',')})`);
      if (profilesRes.ok && Array.isArray(profilesRes.data)) {
        for (const p of profilesRes.data) profileMap[p.user_id] = p;
      }
    }
    const enriched = cases.map(c => ({ ...c, profile: profileMap[c.user_id] || null }));
    sendJson(res, 200, { ok: true, cases: enriched });
    return;
  }

  // ── Admin: Get Full Visa Case Detail ──
  if (pathname === '/api/admin/visa/case' && req.method === 'GET') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx6 = requireAdminSession(req, res);
    if (!adminCtx6) return;
    const caseId = url.searchParams.get('id');
    if (!caseId) { sendJson(res, 400, { ok: false, message: 'Missing id.' }); return; }
    const caseIdEnc = encodeURIComponent(caseId);
    const [caseRes, docsRes, updatesRes, eventsRes, depsRes] = await Promise.all([
      supabaseDbRequest('visa_applications', `select=*&id=eq.${caseIdEnc}&limit=1`),
      supabaseDbRequest('visa_documents', `select=*&visa_application_id=eq.${caseIdEnc}&order=uploaded_at.desc`),
      supabaseDbRequest('visa_updates', `select=*&visa_case_id=eq.${caseIdEnc}&order=created_at.desc`),
      supabaseDbRequest('visa_timeline_events', `select=*&visa_case_id=eq.${caseIdEnc}&order=created_at.desc`),
      supabaseDbRequest('visa_dependants', `select=*&visa_case_id=eq.${caseIdEnc}&order=created_at.asc`)
    ]);
    const application = caseRes.ok && Array.isArray(caseRes.data) && caseRes.data.length > 0 ? caseRes.data[0] : null;
    if (!application) { sendJson(res, 404, { ok: false, message: 'Case not found.' }); return; }
    // Get profile
    let profile = null;
    if (application.user_id) {
      const profRes = await supabaseDbRequest('user_profiles', `select=*&user_id=eq.${encodeURIComponent(application.user_id)}&limit=1`);
      if (profRes.ok && Array.isArray(profRes.data) && profRes.data.length > 0) profile = profRes.data[0];
    }
    sendJson(res, 200, {
      ok: true, application, profile,
      documents: docsRes.ok && Array.isArray(docsRes.data) ? docsRes.data : [],
      updates: updatesRes.ok && Array.isArray(updatesRes.data) ? updatesRes.data : [],
      timelineEvents: eventsRes.ok && Array.isArray(eventsRes.data) ? eventsRes.data : [],
      dependants: depsRes.ok && Array.isArray(depsRes.data) ? depsRes.data : []
    });
    return;
  }

  // ── PBS Status (V2: returns docs, updates, timeline) ──
  if (pathname === '/api/pbs/status' && req.method === 'GET') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const session = requireSession(req, res);
    if (!session) return;
    if (!enforceApiRateLimit(req, res, session)) return;
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }
    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }

    const result = await supabaseDbRequest('pbs_applications', `select=*&user_id=eq.${encodeURIComponent(userId)}&order=application_type.asc`);
    if (!result.ok) { sendJson(res, 502, { ok: false, message: 'Failed to fetch PBS status.' }); return; }
    const rows = Array.isArray(result.data) ? result.data : [];
    const medicareProvider = rows.find((r) => r.application_type === 'medicare_provider') || null;
    const pbsPrescriber = rows.find((r) => r.application_type === 'pbs_prescriber') || null;
    const appIds = rows.map(r => r.id);

    let documents = [], updates = [], timelineEvents = [];
    if (appIds.length > 0) {
      const idFilter = appIds.map(id => encodeURIComponent(id)).join(',');
      const [docsRes, updatesRes, eventsRes] = await Promise.all([
        supabaseDbRequest('pbs_documents', `select=*&pbs_application_id=in.(${idFilter})&order=created_at.desc`),
        supabaseDbRequest('pbs_updates', `select=*&pbs_application_id=in.(${idFilter})&visibility=eq.gp&order=created_at.desc`),
        supabaseDbRequest('pbs_timeline_events', `select=*&pbs_application_id=in.(${idFilter})&visible_to_gp=eq.true&order=created_at.desc`)
      ]);
      documents = docsRes.ok && Array.isArray(docsRes.data) ? docsRes.data : [];
      updates = updatesRes.ok && Array.isArray(updatesRes.data) ? updatesRes.data : [];
      timelineEvents = eventsRes.ok && Array.isArray(eventsRes.data) ? eventsRes.data : [];
    }

    sendJson(res, 200, { ok: true, medicareProvider, pbsPrescriber, documents, updates, timelineEvents });
    return;
  }

  // ── PBS Update (V2: enhanced with case management fields + auto-timeline) ──
  if (pathname === '/api/pbs/update' && req.method === 'POST') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, message: 'Invalid body.' }); return; }

    const targetUserId = String(body && body.userId || '').trim();
    const applicationType = body && typeof body.applicationType === 'string' && PBS_APPLICATION_TYPES.includes(body.applicationType) ? body.applicationType : null;
    if (!targetUserId || !applicationType) { sendJson(res, 400, { ok: false, message: 'Missing userId or valid applicationType.' }); return; }

    const status = body && typeof body.status === 'string' && PBS_STATUSES.includes(body.status) ? body.status : null;
    const referenceNumber = body && typeof body.referenceNumber === 'string' ? body.referenceNumber.trim().slice(0, 100) : undefined;
    const noteText = body && typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';

    const v2Fields = {};
    const v2Map = {
      provider_number: 'providerNumber', prescriber_number: 'prescriberNumber',
      current_action_title: 'currentActionTitle', current_action_description: 'currentActionDescription',
      current_action_owner: 'currentActionOwner', practice_name: 'practiceName',
      practice_contact: 'practiceContact', status_message: 'statusMessage'
    };
    for (const [dbCol, bodyKey] of Object.entries(v2Map)) {
      if (body && typeof body[bodyKey] === 'string') v2Fields[dbCol] = body[bodyKey].trim().slice(0, 500);
    }
    if (body && typeof body.currentActionDueDate === 'string') {
      const dd = body.currentActionDueDate.trim();
      v2Fields.current_action_due_date = dd || null;
    }

    const existingResult = await supabaseDbRequest('pbs_applications', `select=*&user_id=eq.${encodeURIComponent(targetUserId)}&application_type=eq.${encodeURIComponent(applicationType)}&limit=1`);

    if (existingResult.ok && Array.isArray(existingResult.data) && existingResult.data.length > 0) {
      const existing = existingResult.data[0];
      const oldStatus = existing.status;
      const updatePayload = { updated_at: new Date().toISOString(), ...v2Fields };
      if (status) {
        updatePayload.status = status;
        if (status === 'submitted' && !existing.application_date) updatePayload.application_date = new Date().toISOString();
        if ((status === 'approved' || status === 'complete') && !existing.approval_date) updatePayload.approval_date = new Date().toISOString();
      }
      if (referenceNumber !== undefined) updatePayload.reference_number = referenceNumber;
      if (noteText) {
        const existingNotes = Array.isArray(existing.notes) ? existing.notes : [];
        existingNotes.push({ text: noteText, author: adminCtx.email, ts: new Date().toISOString() });
        updatePayload.notes = existingNotes;
      }

      const updateResult = await supabaseDbRequest('pbs_applications', `id=eq.${encodeURIComponent(existing.id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: updatePayload });
      if (!updateResult.ok) { sendJson(res, 502, { ok: false, message: 'Failed to update PBS application.' }); return; }
      const updated = Array.isArray(updateResult.data) && updateResult.data.length > 0 ? updateResult.data[0] : null;

      if (updated && status && oldStatus && status !== oldStatus) {
        const typeLabel = applicationType === 'medicare_provider' ? 'Medicare' : 'PBS';
        const statusLabel = status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        await supabaseDbRequest('pbs_timeline_events', '', { method: 'POST', body: [{ pbs_application_id: updated.id, event_title: typeLabel + ' status changed to ' + statusLabel, visible_to_gp: true, created_by: adminCtx.email }] });
        pushPbsNotificationToOwner(updated.id, { type: 'action', title: typeLabel + ' status updated', detail: typeLabel + ' is now ' + statusLabel });
      }
      if (updated && v2Fields.provider_number && !existing.provider_number) {
        await supabaseDbRequest('pbs_timeline_events', '', { method: 'POST', body: [{ pbs_application_id: updated.id, event_title: 'Medicare Provider Number assigned', visible_to_gp: true, created_by: adminCtx.email }] });
        pushPbsNotificationToOwner(updated.id, { type: 'success', title: 'Provider number assigned', detail: 'Your Medicare Provider Number has been set' });
      }
      if (updated && v2Fields.prescriber_number && !existing.prescriber_number) {
        await supabaseDbRequest('pbs_timeline_events', '', { method: 'POST', body: [{ pbs_application_id: updated.id, event_title: 'PBS Prescriber Number assigned', visible_to_gp: true, created_by: adminCtx.email }] });
        pushPbsNotificationToOwner(updated.id, { type: 'success', title: 'Prescriber number assigned', detail: 'Your PBS Prescriber Number has been set' });
      }

      sendJson(res, 200, { ok: true, application: updated });
    } else {
      const createPayload = {
        user_id: targetUserId, application_type: applicationType,
        status: status || 'not_started', reference_number: referenceNumber || null,
        application_date: status === 'submitted' ? new Date().toISOString() : null,
        approval_date: (status === 'approved' || status === 'complete') ? new Date().toISOString() : null,
        documents: [], notes: noteText ? [{ text: noteText, author: adminCtx.email, ts: new Date().toISOString() }] : [],
        ...v2Fields
      };
      const createResult = await supabaseDbRequest('pbs_applications', '', { method: 'POST', headers: { Prefer: 'return=representation' }, body: [createPayload] });
      if (!createResult.ok) { sendJson(res, 502, { ok: false, message: 'Failed to create PBS application.' }); return; }
      const created = Array.isArray(createResult.data) && createResult.data.length > 0 ? createResult.data[0] : null;
      if (created) {
        const typeLabel = applicationType === 'medicare_provider' ? 'Medicare' : 'PBS';
        await supabaseDbRequest('pbs_timeline_events', '', { method: 'POST', body: [{ pbs_application_id: created.id, event_title: typeLabel + ' application created', visible_to_gp: true, created_by: adminCtx.email }] });
      }
      sendJson(res, 201, { ok: true, application: created });
    }
    return;
  }

  // ── PBS Document Upload (V2: uses pbs_documents table + auto-timeline) ──
  if (pathname === '/api/pbs/documents' && req.method === 'POST') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const session = requireSession(req, res);
    if (!session) return;
    if (!enforceApiRateLimit(req, res, session)) return;
    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }
    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }

    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, message: 'Invalid body.' }); return; }
    const applicationType = body && typeof body.applicationType === 'string' && PBS_APPLICATION_TYPES.includes(body.applicationType) ? body.applicationType : null;
    const documentType = String(body && body.documentType || '').trim().slice(0, 200);
    const fileDataUrl = typeof body.fileDataUrl === 'string' ? body.fileDataUrl.trim() : '';
    const fileName = sanitizeUserString(body && body.fileName, 240);
    const mimeType = sanitizeUserString(body && body.mimeType, 160);
    if (!applicationType || !documentType || !fileDataUrl || !fileName) { sendJson(res, 400, { ok: false, message: 'Missing required fields.' }); return; }

    let pbsApp = null;
    const existingResult = await supabaseDbRequest('pbs_applications', `select=*&user_id=eq.${encodeURIComponent(userId)}&application_type=eq.${encodeURIComponent(applicationType)}&limit=1`);
    if (existingResult.ok && Array.isArray(existingResult.data) && existingResult.data.length > 0) {
      pbsApp = existingResult.data[0];
    } else {
      const createResult = await supabaseDbRequest('pbs_applications', '', { method: 'POST', headers: { Prefer: 'return=representation' }, body: [{ user_id: userId, application_type: applicationType, status: 'in_progress', documents: [], notes: [] }] });
      if (createResult.ok && Array.isArray(createResult.data) && createResult.data.length > 0) pbsApp = createResult.data[0];
    }
    if (!pbsApp) { sendJson(res, 502, { ok: false, message: 'Failed to resolve PBS application.' }); return; }
    if (pbsApp.user_id !== userId) { sendJson(res, 403, { ok: false, message: 'Not authorized.' }); return; }

    const storagePath = ['users', sanitizeStoragePathSegment(userId, 80), 'pbs-documents', sanitizeStoragePathSegment(applicationType, 40), sanitizeStoragePathSegment(documentType, 120), 'current'].join('/');
    const uploaded = await supabaseStorageUploadObject(SUPABASE_DOCUMENT_BUCKET, storagePath, fileDataUrl, mimeType);
    if (!uploaded) { sendJson(res, 502, { ok: false, message: 'Failed to upload document.' }); return; }

    const missingDoc = await supabaseDbRequest('pbs_documents', `select=id&pbs_application_id=eq.${encodeURIComponent(pbsApp.id)}&document_type=eq.${encodeURIComponent(documentType)}&status=eq.missing&limit=1`);
    if (missingDoc.ok && Array.isArray(missingDoc.data) && missingDoc.data.length > 0) {
      await supabaseDbRequest('pbs_documents', `id=eq.${encodeURIComponent(missingDoc.data[0].id)}`, { method: 'PATCH', body: { file_path: storagePath, original_file_name: fileName, mime_type: mimeType, status: 'uploaded', uploaded_by_user_id: userId, updated_at: new Date().toISOString() } });
    } else {
      await supabaseDbRequest('pbs_documents', '', { method: 'POST', body: [{ pbs_application_id: pbsApp.id, document_type: documentType, file_path: storagePath, original_file_name: fileName, mime_type: mimeType, status: 'uploaded', uploaded_by_user_id: userId }] });
    }

    const docLabel = documentType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    await supabaseDbRequest('pbs_timeline_events', '', { method: 'POST', body: [{ pbs_application_id: pbsApp.id, event_title: docLabel + ' uploaded', visible_to_gp: true, created_by: 'system' }] });
    const appPatch = { updated_at: new Date().toISOString() };
    if (pbsApp.status === 'not_started') appPatch.status = 'in_progress';
    await supabaseDbRequest('pbs_applications', `id=eq.${encodeURIComponent(pbsApp.id)}`, { method: 'PATCH', body: appPatch });

    sendJson(res, 201, { ok: true, document: { documentType, fileName, storagePath } });
    return;
  }

  // ── PBS Updates (GP reads, admin writes) ──
  if (pathname === '/api/pbs/updates' && req.method === 'GET') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const session = requireSession(req, res);
    if (!session) return;
    if (!enforceApiRateLimit(req, res, session)) return;
    const email = getSessionEmail(session);
    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }
    const appId = url.searchParams.get('appId');
    if (!appId) { sendJson(res, 400, { ok: false, message: 'Missing appId.' }); return; }
    const own = await supabaseDbRequest('pbs_applications', `select=id&id=eq.${encodeURIComponent(appId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    if (!own.ok || !Array.isArray(own.data) || own.data.length === 0) { sendJson(res, 403, { ok: false, message: 'Not authorized.' }); return; }
    const updatesRes = await supabaseDbRequest('pbs_updates', `select=*&pbs_application_id=eq.${encodeURIComponent(appId)}&visibility=eq.gp&order=created_at.desc`);
    sendJson(res, 200, { ok: true, updates: updatesRes.ok && Array.isArray(updatesRes.data) ? updatesRes.data : [] });
    return;
  }

  if (pathname === '/api/pbs/updates' && req.method === 'POST') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx2 = requireAdminSession(req, res);
    if (!adminCtx2) return;
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, message: 'Invalid body.' }); return; }
    const appId = String(body && body.appId || '').trim();
    const noteBody = String(body && body.body || '').trim().slice(0, 4000);
    const visibility = body && body.visibility === 'internal' ? 'internal' : 'gp';
    if (!appId || !noteBody) { sendJson(res, 400, { ok: false, message: 'Missing appId or body.' }); return; }
    const insertRes = await supabaseDbRequest('pbs_updates', '', { method: 'POST', headers: { Prefer: 'return=representation' }, body: [{ pbs_application_id: appId, body: noteBody, visibility, created_by: adminCtx2.email }] });
    if (!insertRes.ok) { sendJson(res, 502, { ok: false, message: 'Failed to create update.' }); return; }
    if (visibility === 'gp') {
      await supabaseDbRequest('pbs_timeline_events', '', { method: 'POST', body: [{ pbs_application_id: appId, event_title: 'New update from GP Link team', visible_to_gp: true, created_by: adminCtx2.email }] });
      pushPbsNotificationToOwner(appId, { type: 'info', title: 'PBS & Medicare update', detail: noteBody.length > 80 ? noteBody.slice(0, 77) + '...' : noteBody });
    }
    const update = Array.isArray(insertRes.data) && insertRes.data.length > 0 ? insertRes.data[0] : null;
    sendJson(res, 201, { ok: true, update });
    return;
  }

  // ── PBS Timeline Events (admin creates) ──
  if (pathname === '/api/pbs/events' && req.method === 'POST') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx3 = requireAdminSession(req, res);
    if (!adminCtx3) return;
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, message: 'Invalid body.' }); return; }
    const appId = String(body && body.appId || '').trim();
    const eventTitle = String(body && body.eventTitle || '').trim().slice(0, 500);
    const eventDescription = body && typeof body.eventDescription === 'string' ? body.eventDescription.trim().slice(0, 2000) : null;
    const visibleToGp = body && body.visibleToGp === false ? false : true;
    if (!appId || !eventTitle) { sendJson(res, 400, { ok: false, message: 'Missing appId or eventTitle.' }); return; }
    const insertRes = await supabaseDbRequest('pbs_timeline_events', '', { method: 'POST', headers: { Prefer: 'return=representation' }, body: [{ pbs_application_id: appId, event_title: eventTitle, event_description: eventDescription, visible_to_gp: visibleToGp, created_by: adminCtx3.email }] });
    if (!insertRes.ok) { sendJson(res, 502, { ok: false, message: 'Failed to create event.' }); return; }
    const evt = Array.isArray(insertRes.data) && insertRes.data.length > 0 ? insertRes.data[0] : null;
    sendJson(res, 201, { ok: true, event: evt });
    return;
  }

  // ── PBS Document Review (admin approves/rejects) ──
  if (pathname === '/api/pbs/documents/review' && req.method === 'POST') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx4 = requireAdminSession(req, res);
    if (!adminCtx4) return;
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, message: 'Invalid body.' }); return; }
    const documentId = String(body && body.documentId || '').trim();
    const status = String(body && body.status || '').trim();
    if (!documentId || !['approved', 'rejected', 'under_review'].includes(status)) { sendJson(res, 400, { ok: false, message: 'Missing documentId or invalid status.' }); return; }
    const payload = { status, verified: status === 'approved', reviewed_by: adminCtx4.email, reviewed_at: new Date().toISOString() };
    if (status === 'rejected' && body && typeof body.rejectionReason === 'string') payload.rejection_reason = body.rejectionReason.trim().slice(0, 1000);
    if (status !== 'rejected') payload.rejection_reason = null;
    const updateRes = await supabaseDbRequest('pbs_documents', `id=eq.${encodeURIComponent(documentId)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: payload });
    if (!updateRes.ok) { sendJson(res, 502, { ok: false, message: 'Failed to review document.' }); return; }
    const doc = Array.isArray(updateRes.data) && updateRes.data.length > 0 ? updateRes.data[0] : null;
    if (doc && doc.pbs_application_id) {
      const docLabel = (doc.document_type || 'Document').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      await supabaseDbRequest('pbs_timeline_events', '', { method: 'POST', body: [{ pbs_application_id: doc.pbs_application_id, event_title: docLabel + ' ' + status, visible_to_gp: true, created_by: adminCtx4.email }] });
      const notifType = status === 'approved' ? 'success' : 'action';
      const notifDetail = status === 'approved' ? docLabel + ' has been approved' : docLabel + ' was rejected — please re-upload';
      pushPbsNotificationToOwner(doc.pbs_application_id, { type: notifType, title: 'Document ' + status, detail: notifDetail });
    }
    sendJson(res, 200, { ok: true, document: doc });
    return;
  }

  // ── PBS Document Request (admin requests doc from GP) ──
  if (pathname === '/api/pbs/documents/request' && req.method === 'POST') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtxReq = requireAdminSession(req, res);
    if (!adminCtxReq) return;
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, message: 'Invalid body.' }); return; }
    const appId = String(body && body.appId || '').trim();
    const documentType = String(body && body.documentType || '').trim().slice(0, 200);
    const requestNote = body && typeof body.requestNote === 'string' ? body.requestNote.trim().slice(0, 1000) : null;
    if (!appId || !documentType) { sendJson(res, 400, { ok: false, message: 'Missing appId or documentType.' }); return; }
    const caseCheck = await supabaseDbRequest('pbs_applications', `select=id&id=eq.${encodeURIComponent(appId)}&limit=1`);
    if (!caseCheck.ok || !Array.isArray(caseCheck.data) || caseCheck.data.length === 0) { sendJson(res, 404, { ok: false, message: 'Application not found.' }); return; }
    const insertRes = await supabaseDbRequest('pbs_documents', '', { method: 'POST', headers: { Prefer: 'return=representation' }, body: [{ pbs_application_id: appId, document_type: documentType, file_path: '', verified: false, status: 'missing', requested_by: adminCtxReq.email, requested_at: new Date().toISOString(), request_note: requestNote }] });
    if (!insertRes.ok) { sendJson(res, 502, { ok: false, message: 'Failed to create document request.' }); return; }
    const doc = Array.isArray(insertRes.data) && insertRes.data.length > 0 ? insertRes.data[0] : null;
    const docLabel = documentType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    await supabaseDbRequest('pbs_timeline_events', '', { method: 'POST', body: [{ pbs_application_id: appId, event_title: docLabel + ' requested', visible_to_gp: true, created_by: adminCtxReq.email }] });
    pushPbsNotificationToOwner(appId, { type: 'action', title: 'Document requested', detail: docLabel + ' — please upload this document' });
    sendJson(res, 201, { ok: true, document: doc });
    return;
  }

  // ── Admin PBS Cases (list all) ──
  if (pathname === '/api/admin/pbs/cases' && req.method === 'GET') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const appsRes = await supabaseDbRequest('pbs_applications', 'select=*&order=updated_at.desc');
    if (!appsRes.ok) { sendJson(res, 502, { ok: false, message: 'Failed to fetch cases.' }); return; }
    const apps = Array.isArray(appsRes.data) ? appsRes.data : [];
    const userIds = [...new Set(apps.map(a => a.user_id).filter(Boolean))];
    let profileMap = {};
    if (userIds.length > 0) {
      const profileRes = await supabaseDbRequest('user_profiles', `select=user_id,first_name,last_name,email&user_id=in.(${userIds.map(id => encodeURIComponent(id)).join(',')})`);
      if (profileRes.ok && Array.isArray(profileRes.data)) {
        profileRes.data.forEach(p => { profileMap[p.user_id] = p; });
      }
    }
    const cases = apps.map(a => {
      const p = profileMap[a.user_id] || {};
      return { ...a, gp_name: [(p.first_name || ''), (p.last_name || '')].join(' ').trim() || 'Unknown', gp_email: p.email || '' };
    });
    sendJson(res, 200, { ok: true, cases });
    return;
  }

  // ── Admin PBS Case Detail ──
  if (pathname === '/api/admin/pbs/case' && req.method === 'GET') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const appId = url.searchParams.get('id');
    if (!appId) { sendJson(res, 400, { ok: false, message: 'Missing id.' }); return; }
    const [appRes, docsRes, updatesRes, eventsRes] = await Promise.all([
      supabaseDbRequest('pbs_applications', `select=*&id=eq.${encodeURIComponent(appId)}&limit=1`),
      supabaseDbRequest('pbs_documents', `select=*&pbs_application_id=eq.${encodeURIComponent(appId)}&order=created_at.desc`),
      supabaseDbRequest('pbs_updates', `select=*&pbs_application_id=eq.${encodeURIComponent(appId)}&order=created_at.desc`),
      supabaseDbRequest('pbs_timeline_events', `select=*&pbs_application_id=eq.${encodeURIComponent(appId)}&order=created_at.desc`)
    ]);
    if (!appRes.ok || !Array.isArray(appRes.data) || appRes.data.length === 0) { sendJson(res, 404, { ok: false, message: 'Not found.' }); return; }
    const application = appRes.data[0];
    const profileRes = await supabaseDbRequest('user_profiles', `select=first_name,last_name,email&user_id=eq.${encodeURIComponent(application.user_id)}&limit=1`);
    const profile = profileRes.ok && Array.isArray(profileRes.data) && profileRes.data.length > 0 ? profileRes.data[0] : {};
    application.gp_name = [(profile.first_name || ''), (profile.last_name || '')].join(' ').trim() || 'Unknown';
    application.gp_email = profile.email || '';

    sendJson(res, 200, {
      ok: true, application,
      documents: docsRes.ok && Array.isArray(docsRes.data) ? docsRes.data : [],
      updates: updatesRes.ok && Array.isArray(updatesRes.data) ? updatesRes.data : [],
      timelineEvents: eventsRes.ok && Array.isArray(eventsRes.data) ? eventsRes.data : []
    });
    return;
  }

  // ── Schools Search ──
  if (pathname === '/api/schools/search' && req.method === 'GET') {
    const session = requireSession(req, res);
    if (!session) return;
    if (!enforceApiRateLimit(req, res, session)) return;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const lat = parseFloat(url.searchParams.get('lat'));
    const lng = parseFloat(url.searchParams.get('lng'));
    const radius = Math.max(1, Math.min(50, Number(url.searchParams.get('radius')) || 10));
    const type = url.searchParams.get('type') || 'all'; // primary, secondary, all

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      sendJson(res, 400, { ok: false, message: 'Valid lat and lng query parameters are required.' });
      return;
    }

    // Check cache
    const cacheKey = `schools:${lat.toFixed(4)}:${lng.toFixed(4)}:${radius}:${type}`;
    const cached = _schoolsSearchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SCHOOLS_SEARCH_CACHE_TTL_MS) {
      sendJson(res, 200, { ok: true, source: 'cache', schools: cached.value });
      return;
    }

    let schools = [];

    // Try Google Places API first
    if (GOOGLE_PLACES_API_KEY) {
      try {
        const keyword = type === 'secondary' ? 'secondary school' : type === 'primary' ? 'primary school' : 'school';
        const placesUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius * 1000}&type=school&keyword=${encodeURIComponent(keyword)}&key=${encodeURIComponent(GOOGLE_PLACES_API_KEY)}`;
        const placesResponse = await fetch(placesUrl).catch(() => null);
        if (placesResponse && placesResponse.ok) {
          const placesData = await placesResponse.json().catch(() => null);
          if (placesData && Array.isArray(placesData.results)) {
            schools = placesData.results.slice(0, 20).map((place) => {
              const placeLat = place.geometry && place.geometry.location && place.geometry.location.lat;
              const placeLng = place.geometry && place.geometry.location && place.geometry.location.lng;
              const distKm = Number.isFinite(placeLat) && Number.isFinite(placeLng)
                ? haversineDistanceKm(lat, lng, placeLat, placeLng)
                : null;
              return {
                name: place.name || '',
                type: inferSchoolType(place.name || ''),
                sector: inferSchoolSector(place.name || ''),
                distance_km: distKm !== null ? Math.round(distKm * 100) / 100 : null,
                rating: place.rating || null,
                address: place.vicinity || '',
                lat: placeLat || null,
                lng: placeLng || null
              };
            });
          }
        }
      } catch (err) {
        // Fall through to NSW School Finder fallback
      }
    }

    // Fallback to NSW School Finder (Carto SQL) if no Google results
    if (!schools.length) {
      try {
        const phases = type === 'all' ? ['primary', 'secondary'] : [type];
        for (const phase of phases) {
          const rows = await fetchNearbyPublicSchools({ lat, lng }, phase, 10);
          for (const row of rows) {
            schools.push({
              name: row.school_name || '',
              type: row.type || phase,
              sector: 'public',
              distance_km: row.distance_km != null ? Math.round(Number(row.distance_km) * 100) / 100 : null,
              rating: null,
              address: '',
              lat: row.latitude || null,
              lng: row.longitude || null
            });
          }
        }
      } catch (err) {
        // Ignore fallback errors
      }
    }

    // Sort by distance
    schools.sort((a, b) => (a.distance_km || 999) - (b.distance_km || 999));

    // Cache results
    _schoolsSearchCache.set(cacheKey, { ts: Date.now(), value: schools });

    // Clean expired cache entries periodically
    if (_schoolsSearchCache.size > 500) {
      const cutoff = Date.now() - SCHOOLS_SEARCH_CACHE_TTL_MS;
      for (const [k, v] of _schoolsSearchCache) {
        if (v.ts < cutoff) _schoolsSearchCache.delete(k);
      }
    }

    sendJson(res, 200, { ok: true, source: GOOGLE_PLACES_API_KEY && schools.length ? 'google_places' : 'school_finder', schools });
    return;
  }

  // ── Commencement Status ──
  if (pathname === '/api/commencement/status' && req.method === 'GET') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Commencement API requires Supabase database configuration.' });
      return;
    }
    const session = requireSession(req, res);
    if (!session) return;
    if (!enforceApiRateLimit(req, res, session)) return;

    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }

    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }

    const result = await supabaseDbRequest(
      'commencement_items',
      `select=*&user_id=eq.${encodeURIComponent(userId)}&order=item_key.asc`
    );
    if (!result.ok) {
      sendJson(res, 502, { ok: false, message: 'Failed to fetch commencement status.' });
      return;
    }

    const items = Array.isArray(result.data) ? result.data : [];
    sendJson(res, 200, { ok: true, items });
    return;
  }

  // ── Commencement Toggle ──
  if (pathname === '/api/commencement/toggle' && req.method === 'POST') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Commencement API requires Supabase database configuration.' });
      return;
    }
    const session = requireSession(req, res);
    if (!session) return;
    if (!enforceApiRateLimit(req, res, session)) return;

    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }

    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const itemKey = sanitizeUserString(body && body.itemKey, 120);
    if (!itemKey) {
      sendJson(res, 400, { ok: false, message: 'Missing itemKey.' });
      return;
    }

    // Check if item exists
    const existingResult = await supabaseDbRequest(
      'commencement_items',
      `select=*&user_id=eq.${encodeURIComponent(userId)}&item_key=eq.${encodeURIComponent(itemKey)}&limit=1`
    );

    if (existingResult.ok && Array.isArray(existingResult.data) && existingResult.data.length > 0) {
      const existing = existingResult.data[0];
      const nextCompleted = !existing.completed;
      const updateResult = await supabaseDbRequest(
        'commencement_items',
        `id=eq.${encodeURIComponent(existing.id)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: {
            completed: nextCompleted,
            completed_at: nextCompleted ? new Date().toISOString() : null,
            updated_at: new Date().toISOString()
          }
        }
      );
      if (!updateResult.ok) {
        sendJson(res, 502, { ok: false, message: 'Failed to toggle commencement item.' });
        return;
      }
      const updated = Array.isArray(updateResult.data) && updateResult.data.length > 0 ? updateResult.data[0] : null;
      sendJson(res, 200, { ok: true, item: updated });
    } else {
      // Create with completed = true (first toggle)
      const createResult = await supabaseDbRequest('commencement_items', '', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: [{
          user_id: userId,
          item_key: itemKey,
          completed: true,
          completed_at: new Date().toISOString()
        }]
      });
      if (!createResult.ok) {
        sendJson(res, 502, { ok: false, message: 'Failed to create commencement item.' });
        return;
      }
      const created = Array.isArray(createResult.data) && createResult.data.length > 0 ? createResult.data[0] : null;
      sendJson(res, 201, { ok: true, item: created });
    }
    return;
  }

  // ── Commencement Update (notes/details) ──
  if (pathname === '/api/commencement/update' && req.method === 'POST') {
    if (REQUIRE_SUPABASE_DB && !isSupabaseDbConfigured()) {
      sendJson(res, 503, { ok: false, message: 'Commencement API requires Supabase database configuration.' });
      return;
    }
    const session = requireSession(req, res);
    if (!session) return;
    if (!enforceApiRateLimit(req, res, session)) return;

    const email = getSessionEmail(session);
    if (!email) { sendJson(res, 400, { ok: false, message: 'Session missing email.' }); return; }

    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }

    let body;
    try { body = await readJsonBody(req); } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' });
      return;
    }

    const itemKey = sanitizeUserString(body && body.itemKey, 120);
    const notes = body && typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : undefined;

    if (!itemKey) {
      sendJson(res, 400, { ok: false, message: 'Missing itemKey.' });
      return;
    }

    // Check if item exists
    const existingResult = await supabaseDbRequest(
      'commencement_items',
      `select=*&user_id=eq.${encodeURIComponent(userId)}&item_key=eq.${encodeURIComponent(itemKey)}&limit=1`
    );

    if (existingResult.ok && Array.isArray(existingResult.data) && existingResult.data.length > 0) {
      const existing = existingResult.data[0];
      const updatePayload = { updated_at: new Date().toISOString() };
      if (notes !== undefined) updatePayload.notes = notes;
      if (body && typeof body.completed === 'boolean') {
        updatePayload.completed = body.completed;
        updatePayload.completed_at = body.completed ? new Date().toISOString() : null;
      }

      const updateResult = await supabaseDbRequest(
        'commencement_items',
        `id=eq.${encodeURIComponent(existing.id)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: updatePayload
        }
      );
      if (!updateResult.ok) {
        sendJson(res, 502, { ok: false, message: 'Failed to update commencement item.' });
        return;
      }
      const updated = Array.isArray(updateResult.data) && updateResult.data.length > 0 ? updateResult.data[0] : null;
      sendJson(res, 200, { ok: true, item: updated });
    } else {
      // Create new item
      const createResult = await supabaseDbRequest('commencement_items', '', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: [{
          user_id: userId,
          item_key: itemKey,
          completed: body && body.completed === true,
          completed_at: body && body.completed === true ? new Date().toISOString() : null,
          notes: notes || null
        }]
      });
      if (!createResult.ok) {
        sendJson(res, 502, { ok: false, message: 'Failed to create commencement item.' });
        return;
      }
      const created = Array.isArray(createResult.data) && createResult.data.length > 0 ? createResult.data[0] : null;
      sendJson(res, 201, { ok: true, item: created });
    }
    return;
  }

  // ══════════════════════════════════════════════════════════════════
  // VA Unified Operations API Endpoints
  // ══════════════════════════════════════════════════════════════════

  // ── Unified Ops Queue: all open tasks across all domains ──
  if (pathname === '/api/admin/ops/queue' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const domainFilter = url.searchParams.get('domain') || '';
    const statusFilter = url.searchParams.get('status') || 'open,in_progress,waiting,waiting_on_gp,waiting_on_practice,waiting_on_external,blocked';
    const priorityFilter = url.searchParams.get('priority') || '';
    const assigneeFilter = url.searchParams.get('assignee') || '';
    const overdueOnly = url.searchParams.get('overdue') === 'true';
    const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit')) || 200), 500);

    let query = 'select=*&order=priority.asc,created_at.desc&limit=' + limit;
    const statuses = statusFilter.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (statuses.length > 0) query += '&status=in.(' + statuses.join(',') + ')';
    if (domainFilter) query += '&domain=eq.' + encodeURIComponent(domainFilter);
    if (priorityFilter) query += '&priority=eq.' + encodeURIComponent(priorityFilter);
    if (assigneeFilter) query += '&assignee=eq.' + encodeURIComponent(assigneeFilter);
    if (overdueOnly) query += '&due_date=lt.' + new Date().toISOString().slice(0, 10);

    const tasksRes = await supabaseDbRequest('registration_tasks', query);
    if (!tasksRes.ok) { sendJson(res, 502, { ok: false, message: 'Failed to load tasks.' }); return; }
    const tasks = Array.isArray(tasksRes.data) ? tasksRes.data : [];

    // Enrich with case + GP info
    const caseIds = [...new Set(tasks.map(function (t) { return t.case_id; }).filter(Boolean))];
    let caseMap = {};
    if (caseIds.length > 0) {
      const cRes = await supabaseDbRequest('registration_cases', 'select=id,user_id,stage,status,assigned_va,visa_case_id,practice_name,sponsor_name&id=in.(' + caseIds.map(encodeURIComponent).join(',') + ')');
      if (cRes.ok && Array.isArray(cRes.data)) { cRes.data.forEach(function (c) { caseMap[c.id] = c; }); }
    }
    const userIds = [...new Set(Object.values(caseMap).map(function (c) { return c.user_id; }).filter(Boolean))];
    let profileMap = {};
    if (userIds.length > 0) {
      const pRes = await supabaseDbRequest('user_profiles', 'select=user_id,first_name,last_name,email&user_id=in.(' + userIds.map(encodeURIComponent).join(',') + ')');
      if (pRes.ok && Array.isArray(pRes.data)) { pRes.data.forEach(function (p) { profileMap[p.user_id] = p; }); }
    }
    const enriched = tasks.map(function (t) {
      const c = caseMap[t.case_id] || {};
      const p = profileMap[c.user_id] || {};
      return Object.assign({}, t, {
        gp_name: [(p.first_name || ''), (p.last_name || '')].join(' ').trim() || 'Unknown',
        gp_email: p.email || '',
        case_stage: c.stage || '',
        case_status: c.status || '',
        practice_name: c.practice_name || '',
        sponsor_name: c.sponsor_name || ''
      });
    });
    sendJson(res, 200, { ok: true, tasks: enriched });
    return;
  }

  // ── Admin: Create visa-domain task ──
  if (pathname === '/api/admin/visa/task' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    if (!body || !body.case_id || !body.title) { sendJson(res, 400, { ok: false, message: 'case_id and title required.' }); return; }
    const domain = body.domain && VA_TASK_DOMAINS.includes(body.domain) ? body.domain : 'visa';
    const taskType = body.task_type && VA_TASK_TYPES_EXTENDED.includes(body.task_type) ? body.task_type : 'manual';
    const task = await _createVaTask(body.case_id, {
      task_type: taskType,
      title: body.title,
      description: body.description || null,
      domain: domain,
      priority: body.priority || 'normal',
      status: body.status || 'open',
      due_date: body.due_date || null,
      follow_up_date: body.follow_up_date || null,
      visa_case_id: body.visa_case_id || null,
      related_stage: body.related_stage || 'visa',
      related_document_key: body.related_document_key || null,
      related_ticket_id: body.related_ticket_id || null,
      parent_task_id: body.parent_task_id || null,
      source_trigger: 'va_manual',
      created_by: adminCtx.email,
      _actor: adminCtx.email
    });
    if (!task) { sendJson(res, 502, { ok: false, message: 'Failed to create task.' }); return; }
    await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(body.case_id), { method: 'PATCH', body: { last_va_action_at: new Date().toISOString() } });
    sendJson(res, 201, { ok: true, task: task });
    return;
  }

  // ── Admin: Update visa case (extended) ──
  if (pathname === '/api/admin/visa/case' && req.method === 'PUT') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const caseId = url.searchParams.get('id');
    if (!caseId) { sendJson(res, 400, { ok: false, message: 'Missing id.' }); return; }
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const allowed = ['stage', 'visa_subclass', 'visa_type', 'sponsor_status', 'responsible_party', 'estimated_timeline',
      'current_action_title', 'current_action_description', 'current_action_owner', 'current_action_due_date',
      'sponsor_name', 'sponsor_contact', 'reference_number', 'status_message', 'nomination_date', 'lodgement_date', 'grant_date'];
    const patch = {};
    for (const key of allowed) { if (body && body[key] !== undefined) patch[key] = body[key]; }
    patch.updated_at = new Date().toISOString();
    // Fetch old stage for automation
    const oldRes = await supabaseDbRequest('visa_applications', 'select=id,user_id,stage&id=eq.' + encodeURIComponent(caseId) + '&limit=1');
    const oldCase = oldRes.ok && Array.isArray(oldRes.data) && oldRes.data.length > 0 ? oldRes.data[0] : null;
    if (!oldCase) { sendJson(res, 404, { ok: false, message: 'Case not found.' }); return; }

    const r = await supabaseDbRequest('visa_applications', 'id=eq.' + encodeURIComponent(caseId), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch });
    if (!r.ok) { sendJson(res, 502, { ok: false, message: 'Failed to update.' }); return; }
    const updated = r.ok && Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : null;

    // Timeline event for stage change
    if (updated && patch.stage && oldCase.stage !== patch.stage) {
      const stageLabels = { nomination: 'Nomination', lodgement: 'Lodgement', processing: 'Processing', granted: 'Granted', refused: 'Refused' };
      await supabaseDbRequest('visa_timeline_events', '', {
        method: 'POST',
        body: [{ visa_case_id: updated.id, event_title: 'Stage changed to ' + (stageLabels[patch.stage] || patch.stage), visible_to_gp: true, created_by: adminCtx.email }]
      });
      pushVisaNotificationToOwner(updated.id, { type: 'action', title: 'Visa stage updated', detail: 'Your visa case has moved to ' + (stageLabels[patch.stage] || patch.stage) });
    }

    // Fire-and-forget task automation
    const visaChanges = {};
    if (patch.stage && oldCase.stage !== patch.stage) visaChanges.stage = patch.stage;
    if (patch.sponsor_name) visaChanges.sponsorName = patch.sponsor_name;
    if (patch.sponsor_contact) visaChanges.sponsorContact = patch.sponsor_contact;
    if (Object.keys(visaChanges).length > 0) {
      processVisaTaskAutomation(caseId, oldCase.user_id, visaChanges, adminCtx.email).catch(function () {});
    }

    // Update reg case sponsor info if present
    if (patch.sponsor_name || patch.sponsor_contact) {
      const rc = await _getRegCaseForUser(oldCase.user_id);
      if (rc) {
        const rcPatch = {};
        if (patch.sponsor_name) rcPatch.sponsor_name = patch.sponsor_name;
        if (patch.sponsor_contact) rcPatch.sponsor_contact = patch.sponsor_contact;
        rcPatch.last_va_action_at = new Date().toISOString();
        await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(rc.id), { method: 'PATCH', body: rcPatch });
      }
    }

    sendJson(res, 200, { ok: true, application: updated });
    return;
  }

  // ── Admin: Get enriched case detail (unified: reg + visa + tasks + timeline + docs) ──
  if (pathname === '/api/admin/ops/case' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const caseId = url.searchParams.get('id');
    if (!caseId) { sendJson(res, 400, { ok: false, message: 'Missing id.' }); return; }
    const [caseRes, tasksRes, tlRes, docOpsRes] = await Promise.all([
      supabaseDbRequest('registration_cases', 'select=*&id=eq.' + encodeURIComponent(caseId) + '&limit=1'),
      supabaseDbRequest('registration_tasks', 'select=*&case_id=eq.' + encodeURIComponent(caseId) + '&order=created_at.desc'),
      supabaseDbRequest('task_timeline', 'select=*&case_id=eq.' + encodeURIComponent(caseId) + '&order=created_at.desc&limit=200'),
      supabaseDbRequest('practice_doc_ops', 'select=*&case_id=eq.' + encodeURIComponent(caseId) + '&order=created_at.asc')
    ]);
    if (!caseRes.ok || !Array.isArray(caseRes.data) || caseRes.data.length === 0) { sendJson(res, 404, { ok: false, message: 'Case not found.' }); return; }
    const regCase = caseRes.data[0];
    const pRes = await supabaseDbRequest('user_profiles', 'select=first_name,last_name,email,phone_number&user_id=eq.' + encodeURIComponent(regCase.user_id) + '&limit=1');
    const profile = pRes.ok && Array.isArray(pRes.data) && pRes.data.length > 0 ? pRes.data[0] : {};
    regCase.gp_name = [(profile.first_name || ''), (profile.last_name || '')].join(' ').trim() || 'Unknown';
    regCase.gp_email = profile.email || '';
    regCase.gp_phone = profile.phone_number || '';

    // Fetch visa case detail if linked
    let visaCase = null;
    let visaDocs = [];
    let visaUpdates = [];
    let visaTimeline = [];
    let visaDependants = [];
    let questionnaire = null;
    if (regCase.visa_case_id) {
      const vcId = encodeURIComponent(regCase.visa_case_id);
      const [vcRes, vdRes, vuRes, vtRes, vdepRes, vqRes] = await Promise.all([
        supabaseDbRequest('visa_applications', 'select=*&id=eq.' + vcId + '&limit=1'),
        supabaseDbRequest('visa_documents', 'select=*&visa_application_id=eq.' + vcId + '&order=uploaded_at.desc'),
        supabaseDbRequest('visa_updates', 'select=*&visa_case_id=eq.' + vcId + '&order=created_at.desc'),
        supabaseDbRequest('visa_timeline_events', 'select=*&visa_case_id=eq.' + vcId + '&order=created_at.desc'),
        supabaseDbRequest('visa_dependants', 'select=*&visa_case_id=eq.' + vcId + '&order=created_at.asc'),
        supabaseDbRequest('visa_questionnaires', 'select=*&visa_case_id=eq.' + vcId + '&limit=1')
      ]);
      visaCase = vcRes.ok && Array.isArray(vcRes.data) && vcRes.data.length > 0 ? vcRes.data[0] : null;
      visaDocs = vdRes.ok && Array.isArray(vdRes.data) ? vdRes.data : [];
      visaUpdates = vuRes.ok && Array.isArray(vuRes.data) ? vuRes.data : [];
      visaTimeline = vtRes.ok && Array.isArray(vtRes.data) ? vtRes.data : [];
      visaDependants = vdepRes.ok && Array.isArray(vdepRes.data) ? vdepRes.data : [];
      questionnaire = vqRes.ok && Array.isArray(vqRes.data) && vqRes.data.length > 0 ? vqRes.data[0] : null;
    }

    // Fetch linked support tickets from user state
    const stateRes = await supabaseDbRequest('user_state', 'select=state&user_id=eq.' + encodeURIComponent(regCase.user_id) + '&limit=1');
    let supportTickets = [];
    if (stateRes.ok && Array.isArray(stateRes.data) && stateRes.data.length > 0) {
      const st = stateRes.data[0].state;
      const rawTickets = st && st.gpLinkSupportCases;
      if (typeof rawTickets === 'string') { try { supportTickets = JSON.parse(rawTickets); } catch { supportTickets = []; } }
      else if (Array.isArray(rawTickets)) supportTickets = rawTickets;
    }

    sendJson(res, 200, {
      ok: true,
      case: regCase,
      tasks: tasksRes.ok && Array.isArray(tasksRes.data) ? tasksRes.data : [],
      timeline: tlRes.ok && Array.isArray(tlRes.data) ? tlRes.data : [],
      practiceDocOps: docOpsRes.ok && Array.isArray(docOpsRes.data) ? docOpsRes.data : [],
      visaCase: visaCase,
      visaDocs: visaDocs,
      visaUpdates: visaUpdates,
      visaTimeline: visaTimeline,
      visaDependants: visaDependants,
      questionnaire: questionnaire,
      supportTickets: supportTickets
    });
    return;
  }

  // ── Practice Doc Ops: Get for a case ──
  if (pathname === '/api/admin/practice-docs' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const caseId = url.searchParams.get('caseId');
    if (!caseId) { sendJson(res, 400, { ok: false, message: 'Missing caseId.' }); return; }
    const docs = await _ensurePracticeDocOps(caseId);
    sendJson(res, 200, { ok: true, docs: docs });
    return;
  }

  // ── Practice Doc Ops: Update ──
  if (pathname === '/api/admin/practice-docs' && req.method === 'PUT') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const docId = body && body.id;
    if (!docId) { sendJson(res, 400, { ok: false, message: 'Missing id.' }); return; }
    const allowed = ['ops_status', 'requested_from', 'practice_contact', 'request_date', 'due_date', 'last_chased_date', 'file_version', 'review_outcome', 'correction_note'];
    const patch = {};
    for (const key of allowed) { if (body[key] !== undefined) patch[key] = body[key]; }
    if (patch.ops_status && !PRACTICE_DOC_OPS_STATUSES.includes(patch.ops_status)) { sendJson(res, 400, { ok: false, message: 'Invalid ops_status.' }); return; }
    const r = await supabaseDbRequest('practice_doc_ops', 'id=eq.' + encodeURIComponent(docId), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch });
    if (!r.ok) { sendJson(res, 502, { ok: false, message: 'Failed to update.' }); return; }
    const updated = r.ok && Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : null;
    // Create document_ops task if status changed to actionable
    if (updated && patch.ops_status && ['requested', 'awaiting_practice', 'under_review', 'needs_correction'].includes(patch.ops_status)) {
      const docLabel = (updated.document_key || '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
      const rc = await _getRegCaseForUser(''); // we need case_id directly
      // case_id is on the doc ops record
      if (!(await _hasOpenTaskByDomain(updated.case_id, 'document', 'document_ops'))) {
        await _createVaTask(updated.case_id, {
          task_type: 'document_ops', title: docLabel + ': ' + patch.ops_status.replace(/_/g, ' '),
          domain: 'document', related_stage: 'career', related_document_key: updated.document_key,
          source_trigger: 'practice_doc_status_change', _actor: adminCtx.email
        });
      }
    }
    // Timeline
    if (updated) {
      await _logCaseEvent(updated.case_id, null, 'status_change', 'Practice doc ' + (updated.document_key || '') + ' → ' + (patch.ops_status || ''), JSON.stringify(patch), adminCtx.email);
    }
    sendJson(res, 200, { ok: true, doc: updated });
    return;
  }

  // ══════════════════════════════════════════════════════════════════
  // Visa Questionnaire Endpoints
  // ══════════════════════════════════════════════════════════════════

  // ── GP: Get own questionnaire ──
  if (pathname === '/api/visa/questionnaire' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const session = requireSession(req, res);
    if (!session) return;
    if (!enforceApiRateLimit(req, res, session)) return;
    const email = getSessionEmail(session);
    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }
    const visaCaseId = url.searchParams.get('visaCaseId');
    if (!visaCaseId) { sendJson(res, 400, { ok: false, message: 'Missing visaCaseId.' }); return; }
    // Verify ownership
    const own = await supabaseDbRequest('visa_applications', 'select=id&id=eq.' + encodeURIComponent(visaCaseId) + '&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
    if (!own.ok || !Array.isArray(own.data) || own.data.length === 0) { sendJson(res, 403, { ok: false, message: 'Not authorized.' }); return; }
    const qRes = await supabaseDbRequest('visa_questionnaires', 'select=*&visa_case_id=eq.' + encodeURIComponent(visaCaseId) + '&limit=1');
    const questionnaire = qRes.ok && Array.isArray(qRes.data) && qRes.data.length > 0 ? qRes.data[0] : null;
    // Strip admin-only fields for GP
    if (questionnaire) {
      delete questionnaire.review_note;
      delete questionnaire.send_note;
      delete questionnaire.reviewed_by;
      delete questionnaire.sent_by;
      delete questionnaire.recipient_route;
    }
    sendJson(res, 200, { ok: true, questionnaire: questionnaire });
    return;
  }

  // ── GP: Save/submit questionnaire ──
  if (pathname === '/api/visa/questionnaire' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const session = requireSession(req, res);
    if (!session) return;
    if (!enforceApiRateLimit(req, res, session)) return;
    const email = getSessionEmail(session);
    const userId = getSessionSupabaseUserId(session) || await getSupabaseUserIdByEmail(email);
    if (!userId) { sendJson(res, 400, { ok: false, message: 'Cannot resolve user.' }); return; }
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, message: 'Invalid body.' }); return; }
    const visaCaseId = String(body && body.visaCaseId || '').trim();
    const action = String(body && body.action || '').trim(); // 'save' or 'submit'
    const data = body && body.data && typeof body.data === 'object' ? body.data : {};
    if (!visaCaseId) { sendJson(res, 400, { ok: false, message: 'Missing visaCaseId.' }); return; }
    if (!['save', 'submit'].includes(action)) { sendJson(res, 400, { ok: false, message: 'action must be save or submit.' }); return; }

    // Verify ownership
    const own = await supabaseDbRequest('visa_applications', 'select=id&id=eq.' + encodeURIComponent(visaCaseId) + '&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
    if (!own.ok || !Array.isArray(own.data) || own.data.length === 0) { sendJson(res, 403, { ok: false, message: 'Not authorized.' }); return; }

    // Check if questionnaire exists
    const existing = await supabaseDbRequest('visa_questionnaires', 'select=*&visa_case_id=eq.' + encodeURIComponent(visaCaseId) + '&limit=1');
    const existingQ = existing.ok && Array.isArray(existing.data) && existing.data.length > 0 ? existing.data[0] : null;

    if (existingQ) {
      // Can only edit if draft or returned_for_changes
      if (!['draft', 'returned_for_changes'].includes(existingQ.status)) {
        sendJson(res, 409, { ok: false, message: 'Questionnaire cannot be edited in current status (' + existingQ.status + ').' });
        return;
      }
      const patch = { data: data };
      if (action === 'submit') {
        patch.status = 'submitted';
        if (existingQ.status === 'returned_for_changes') patch.version = (existingQ.version || 1) + 1;
      }
      const r = await supabaseDbRequest('visa_questionnaires', 'id=eq.' + encodeURIComponent(existingQ.id), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch });
      if (!r.ok) { sendJson(res, 502, { ok: false, message: 'Failed to update questionnaire.' }); return; }
      const updated = r.ok && Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : null;
      if (action === 'submit' && updated) {
        // Create timeline event
        await supabaseDbRequest('visa_timeline_events', '', {
          method: 'POST', body: [{ visa_case_id: visaCaseId, event_title: 'Visa intake questionnaire submitted (v' + (updated.version || 1) + ')', visible_to_gp: true, created_by: 'GP' }]
        });
        // Task automation
        const rc = await _getRegCaseForUser(userId);
        if (rc) {
          await _logCaseEvent(rc.id, null, 'questionnaire_submitted', 'Questionnaire submitted (v' + (updated.version || 1) + ')', null, email);
          processQuestionnaireTaskAutomation(rc.id, visaCaseId, 'submitted', 'system').catch(function () {});
        }
      }
      // Strip admin-only fields
      if (updated) { delete updated.review_note; delete updated.send_note; delete updated.reviewed_by; delete updated.sent_by; delete updated.recipient_route; }
      sendJson(res, 200, { ok: true, questionnaire: updated });
    } else {
      // Create new
      const status = action === 'submit' ? 'submitted' : 'draft';
      const r = await supabaseDbRequest('visa_questionnaires', '', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: [{ visa_case_id: visaCaseId, user_id: userId, status: status, version: 1, data: data }]
      });
      if (!r.ok) { sendJson(res, 502, { ok: false, message: 'Failed to create questionnaire.' }); return; }
      const created = r.ok && Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : null;
      if (action === 'submit' && created) {
        await supabaseDbRequest('visa_timeline_events', '', {
          method: 'POST', body: [{ visa_case_id: visaCaseId, event_title: 'Visa intake questionnaire submitted', visible_to_gp: true, created_by: 'GP' }]
        });
        const rc = await _getRegCaseForUser(userId);
        if (rc) {
          await _logCaseEvent(rc.id, null, 'questionnaire_submitted', 'Questionnaire submitted', null, email);
          processQuestionnaireTaskAutomation(rc.id, visaCaseId, 'submitted', 'system').catch(function () {});
        }
      }
      if (created) { delete created.review_note; delete created.send_note; delete created.reviewed_by; delete created.sent_by; delete created.recipient_route; }
      sendJson(res, 201, { ok: true, questionnaire: created });
    }
    return;
  }

  // ── Admin: Get questionnaire for review ──
  if (pathname === '/api/admin/visa/questionnaire' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const visaCaseId = url.searchParams.get('visaCaseId');
    if (!visaCaseId) { sendJson(res, 400, { ok: false, message: 'Missing visaCaseId.' }); return; }
    const qRes = await supabaseDbRequest('visa_questionnaires', 'select=*&visa_case_id=eq.' + encodeURIComponent(visaCaseId) + '&limit=1');
    const questionnaire = qRes.ok && Array.isArray(qRes.data) && qRes.data.length > 0 ? qRes.data[0] : null;
    sendJson(res, 200, { ok: true, questionnaire: questionnaire });
    return;
  }

  // ── Admin: Review/return questionnaire ──
  if (pathname === '/api/admin/visa/questionnaire/review' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const visaCaseId = String(body && body.visaCaseId || '').trim();
    const action = String(body && body.action || '').trim(); // 'approve' or 'return'
    if (!visaCaseId || !['approve', 'return'].includes(action)) { sendJson(res, 400, { ok: false, message: 'visaCaseId and action (approve|return) required.' }); return; }

    const qRes = await supabaseDbRequest('visa_questionnaires', 'select=*&visa_case_id=eq.' + encodeURIComponent(visaCaseId) + '&limit=1');
    const q = qRes.ok && Array.isArray(qRes.data) && qRes.data.length > 0 ? qRes.data[0] : null;
    if (!q) { sendJson(res, 404, { ok: false, message: 'Questionnaire not found.' }); return; }
    if (q.status !== 'submitted') { sendJson(res, 409, { ok: false, message: 'Questionnaire must be in submitted status to review.' }); return; }

    const patch = { reviewed_by: adminCtx.email, reviewed_at: new Date().toISOString() };
    if (action === 'approve') {
      patch.status = 'va_reviewed';
      patch.review_note = body.reviewNote ? String(body.reviewNote).trim().slice(0, 2000) : null;
    } else {
      patch.status = 'returned_for_changes';
      patch.return_note = body.returnNote ? String(body.returnNote).trim().slice(0, 2000) : '';
    }
    const r = await supabaseDbRequest('visa_questionnaires', 'id=eq.' + encodeURIComponent(q.id), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch });
    if (!r.ok) { sendJson(res, 502, { ok: false, message: 'Failed to update questionnaire.' }); return; }
    const updated = r.ok && Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : null;

    // Timeline + notification
    const evTitle = action === 'approve' ? 'Questionnaire reviewed and approved' : 'Questionnaire returned for changes';
    await supabaseDbRequest('visa_timeline_events', '', {
      method: 'POST', body: [{ visa_case_id: visaCaseId, event_title: evTitle, visible_to_gp: true, created_by: adminCtx.email }]
    });
    pushVisaNotificationToOwner(visaCaseId, {
      type: action === 'approve' ? 'success' : 'action',
      title: action === 'approve' ? 'Questionnaire approved' : 'Questionnaire returned',
      detail: action === 'approve' ? 'Your visa intake questionnaire has been reviewed' : (patch.return_note || 'Please update and resubmit your questionnaire')
    });

    // Task automation
    const rc = await _getRegCaseForUser(q.user_id);
    if (rc) {
      const evType = action === 'approve' ? 'questionnaire_reviewed' : 'questionnaire_returned';
      await _logCaseEvent(rc.id, null, evType, evTitle, action === 'return' ? patch.return_note : null, adminCtx.email);
      processQuestionnaireTaskAutomation(rc.id, visaCaseId, action === 'approve' ? 'va_reviewed' : 'returned_for_changes', adminCtx.email).catch(function () {});
    }

    sendJson(res, 200, { ok: true, questionnaire: updated });
    return;
  }

  // ── Admin: Generate questionnaire PDF ──
  if (pathname === '/api/admin/visa/questionnaire/pdf' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const visaCaseId = url.searchParams.get('visaCaseId');
    if (!visaCaseId) { sendJson(res, 400, { ok: false, message: 'Missing visaCaseId.' }); return; }

    const [qRes, vcRes] = await Promise.all([
      supabaseDbRequest('visa_questionnaires', 'select=*&visa_case_id=eq.' + encodeURIComponent(visaCaseId) + '&limit=1'),
      supabaseDbRequest('visa_applications', 'select=*&id=eq.' + encodeURIComponent(visaCaseId) + '&limit=1')
    ]);
    const q = qRes.ok && Array.isArray(qRes.data) && qRes.data.length > 0 ? qRes.data[0] : null;
    const vc = vcRes.ok && Array.isArray(vcRes.data) && vcRes.data.length > 0 ? vcRes.data[0] : null;
    if (!q) { sendJson(res, 404, { ok: false, message: 'Questionnaire not found.' }); return; }

    let gpProfile = null;
    if (q.user_id) {
      const pRes = await supabaseDbRequest('user_profiles', 'select=first_name,last_name,email&user_id=eq.' + encodeURIComponent(q.user_id) + '&limit=1');
      gpProfile = pRes.ok && Array.isArray(pRes.data) && pRes.data.length > 0 ? pRes.data[0] : null;
    }

    const pdfBuffer = await generateQuestionnairePdf(q, gpProfile, vc);
    if (!pdfBuffer) {
      sendJson(res, 500, { ok: false, message: 'PDF generation failed. Ensure pdfkit is installed.' });
      return;
    }

    // Update questionnaire metadata
    await supabaseDbRequest('visa_questionnaires', 'id=eq.' + encodeURIComponent(q.id), {
      method: 'PATCH', body: { pdf_generated_at: new Date().toISOString(), pdf_version: q.version || 1 }
    });

    // Timeline
    const rc = await _getRegCaseForUser(q.user_id);
    if (rc) {
      await _logCaseEvent(rc.id, null, 'pdf_generated', 'Questionnaire PDF generated (v' + (q.version || 1) + ')', null, adminCtx.email);
    }

    const gpName = gpProfile ? [(gpProfile.first_name || ''), (gpProfile.last_name || '')].join('_').trim().replace(/\s/g, '_') || 'GP' : 'GP';
    const fileName = 'VisaIntakeQuestionnaire_' + gpName + '_v' + (q.version || 1) + '.pdf';
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="' + fileName + '"',
      'Content-Length': pdfBuffer.length
    });
    res.end(pdfBuffer);
    return;
  }

  // ── Admin: Mark questionnaire as ready to send / sent ──
  if (pathname === '/api/admin/visa/questionnaire/send' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const visaCaseId = String(body && body.visaCaseId || '').trim();
    const action = String(body && body.action || '').trim(); // 'ready' or 'sent'
    const recipientRoute = body && body.recipientRoute && QUESTIONNAIRE_ROUTES.includes(body.recipientRoute) ? body.recipientRoute : null;
    if (!visaCaseId || !['ready', 'sent'].includes(action)) { sendJson(res, 400, { ok: false, message: 'visaCaseId and action (ready|sent) required.' }); return; }

    const qRes = await supabaseDbRequest('visa_questionnaires', 'select=*&visa_case_id=eq.' + encodeURIComponent(visaCaseId) + '&limit=1');
    const q = qRes.ok && Array.isArray(qRes.data) && qRes.data.length > 0 ? qRes.data[0] : null;
    if (!q) { sendJson(res, 404, { ok: false, message: 'Questionnaire not found.' }); return; }

    const patch = {};
    if (action === 'ready') {
      if (!['va_reviewed'].includes(q.status)) { sendJson(res, 409, { ok: false, message: 'Must be va_reviewed to mark ready.' }); return; }
      patch.status = 'ready_to_send';
      if (recipientRoute) patch.recipient_route = recipientRoute;
      patch.send_note = body.sendNote ? String(body.sendNote).trim().slice(0, 2000) : null;
    } else {
      if (!['ready_to_send', 'va_reviewed'].includes(q.status)) { sendJson(res, 409, { ok: false, message: 'Must be ready_to_send or va_reviewed to mark sent.' }); return; }
      patch.status = 'sent';
      patch.sent_by = adminCtx.email;
      patch.sent_at = new Date().toISOString();
      if (recipientRoute) patch.recipient_route = recipientRoute;
      patch.send_note = body.sendNote ? String(body.sendNote).trim().slice(0, 2000) : null;
    }
    const r = await supabaseDbRequest('visa_questionnaires', 'id=eq.' + encodeURIComponent(q.id), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch });
    if (!r.ok) { sendJson(res, 502, { ok: false, message: 'Failed to update.' }); return; }
    const updated = r.ok && Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : null;

    // Route label
    const routeLabels = { gplink_migration_agent: 'GP Link migration agent', practice_agent: 'practice migration agent', practice_direct: 'practice directly' };
    const routeLabel = routeLabels[patch.recipient_route || q.recipient_route] || 'recipient';
    const evTitle = action === 'sent' ? 'Questionnaire sent to ' + routeLabel : 'Questionnaire marked ready to send';
    await supabaseDbRequest('visa_timeline_events', '', {
      method: 'POST', body: [{ visa_case_id: visaCaseId, event_title: evTitle, visible_to_gp: false, created_by: adminCtx.email }]
    });

    // Task automation
    const rc = await _getRegCaseForUser(q.user_id);
    if (rc) {
      await _logCaseEvent(rc.id, null, action === 'sent' ? 'questionnaire_sent' : 'status_change', evTitle, null, adminCtx.email);
      if (action === 'sent') processQuestionnaireTaskAutomation(rc.id, visaCaseId, 'sent', adminCtx.email).catch(function () {});
      else processQuestionnaireTaskAutomation(rc.id, visaCaseId, 'ready_to_send', adminCtx.email).catch(function () {});
    }

    sendJson(res, 200, { ok: true, questionnaire: updated });
    return;
  }

  // ── Admin: Request questionnaire from GP (creates task + notification) ──
  if (pathname === '/api/admin/visa/questionnaire/request' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const visaCaseId = String(body && body.visaCaseId || '').trim();
    const userId = String(body && body.userId || '').trim();
    if (!visaCaseId || !userId) { sendJson(res, 400, { ok: false, message: 'visaCaseId and userId required.' }); return; }

    // Ensure questionnaire record exists (create as draft if not)
    const existing = await supabaseDbRequest('visa_questionnaires', 'select=id,status&visa_case_id=eq.' + encodeURIComponent(visaCaseId) + '&limit=1');
    if (!(existing.ok && Array.isArray(existing.data) && existing.data.length > 0)) {
      await supabaseDbRequest('visa_questionnaires', '', {
        method: 'POST', body: [{ visa_case_id: visaCaseId, user_id: userId, status: 'draft', version: 1, data: {} }]
      });
    }

    // Timeline + notification
    await supabaseDbRequest('visa_timeline_events', '', {
      method: 'POST', body: [{ visa_case_id: visaCaseId, event_title: 'Visa intake questionnaire requested', visible_to_gp: true, created_by: adminCtx.email }]
    });
    pushVisaNotificationToOwner(visaCaseId, { type: 'action', title: 'Questionnaire requested', detail: 'Please complete your visa intake questionnaire' });

    // Create task
    const rc = await _getRegCaseForUser(userId);
    if (rc) {
      await _createVaTask(rc.id, {
        task_type: 'questionnaire', title: 'Request visa intake questionnaire',
        domain: 'questionnaire', visa_case_id: visaCaseId,
        status: 'waiting_on_gp', priority: 'high',
        source_trigger: 'va_request', related_stage: 'visa', _actor: adminCtx.email
      });
      await _logCaseEvent(rc.id, null, 'system', 'Questionnaire requested from GP', null, adminCtx.email);
    }

    sendJson(res, 200, { ok: true });
    return;
  }

  // ── Admin: SLA check ──
  if (pathname === '/api/admin/sla/check' && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const result = await runSlaCheck(adminCtx.email);
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  // ── Admin: Update registration case (extended with sponsor/agent fields) ──
  if (pathname === '/api/admin/ops/case' && req.method === 'PUT') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;
    const caseId = url.searchParams.get('id');
    if (!caseId) { sendJson(res, 400, { ok: false, message: 'Missing id.' }); return; }
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const allowed = ['assigned_va', 'status', 'blocker_status', 'blocker_reason', 'next_followup_date',
      'practice_name', 'practice_contact', 'handover_notes', 'gp_verified_stage', 'priority',
      'sponsor_name', 'sponsor_contact', 'migration_agent', 'migration_agent_contact', 'risk_notes'];
    const patch = {};
    for (const key of allowed) { if (body && body[key] !== undefined) patch[key] = body[key]; }
    patch.last_va_action_at = new Date().toISOString();
    const r = await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(caseId), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch });
    if (!r.ok) { sendJson(res, 502, { ok: false, message: 'Failed to update case.' }); return; }
    const changes = Object.keys(patch).filter(function (k) { return k !== 'last_va_action_at'; });
    if (changes.length > 0) {
      const evType = changes.includes('assigned_va') ? 'owner_changed' : changes.includes('blocker_status') ? (patch.blocker_status ? 'blocker_set' : 'blocker_cleared') : 'status_change';
      await _logCaseEvent(caseId, null, evType, 'Case updated: ' + changes.join(', '), JSON.stringify(patch), adminCtx.email);
    }
    sendJson(res, 200, { ok: true, case: r.ok && Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : null });
    return;
  }

  sendJson(res, 404, { ok: false, message: 'Not found' });
}

async function handleRequest(req, res) {
  cleanup();

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const mappedRegistrationPath = mapRegistrationPath(url.pathname);
  const pathname = mappedRegistrationPath || url.pathname;

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

  if ((pathname === '/pages/admin.html' || pathname === '/pages/admin-signin.html' || pathname === '/pages/admin-visa.html' || pathname === '/pages/admin-pbs.html') && !isAllowedAdminHost(req)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const session = getSession(req);
  const adminSession = getAdminSession(req);
  const isPublic =
    pathname === '/pages/signin.html' ||
    pathname === '/pages/admin-signin.html' ||
    pathname.startsWith('/media/images/') ||
    pathname.startsWith('/media/videos/') ||
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
    const adminRole = getAdminRoleFromSession(adminSession);
    const adminHostScope = getAdminHostScope(req);
    if (doesAdminRoleMatchHost(adminRole, adminHostScope)) {
      res.writeHead(302, { Location: '/pages/admin.html' });
      res.end();
      return;
    }
    clearAdminSession(res);
  }

  if (pathname === '/pages/admin.html') {
    if (!adminSession) {
      res.writeHead(302, { Location: '/pages/admin-signin.html' });
      res.end();
      return;
    }
    const adminRole = getAdminRoleFromSession(adminSession);
    const adminHostScope = getAdminHostScope(req);
    if (!doesAdminRoleMatchHost(adminRole, adminHostScope)) {
      clearAdminSession(res);
      res.writeHead(302, { Location: '/pages/admin-signin.html' });
      res.end();
      return;
    }
  }

  if (pathname !== '/pages/admin.html' && !isPublic && !session && (pathname.endsWith('.html') || pathname === '/')) {
    if (AUTH_DISABLED) {
      if (shouldServeAppShell(url, pathname)) {
        serveStatic(req, res, '/pages/app-shell.html');
        return;
      }
      serveStatic(req, res, pathname);
      return;
    }
    res.writeHead(302, { Location: '/pages/signin.html' });
    res.end();
    return;
  }

  if (shouldServeAppShell(url, pathname)) {
    serveStatic(req, res, '/pages/app-shell.html');
    return;
  }

  serveStatic(req, res, pathname);
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      console.error('[SERVER ERROR]', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
    }
  });
}

if (process.env.VERCEL) {
  module.exports = async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      console.error('[SERVER ERROR]', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
    }
  };
} else if (process.env.NODE_ENV !== 'test') {
  const server = createServer();

  server.listen(PORT, HOST, () => {
    console.log(`GP Link server running on http://${HOST}:${PORT}`);
    console.log(`[ENV] NODE_ENV=${NODE_ENV} AUTH_DISABLED=${AUTH_DISABLED} DB_FILE_PATH=${DB_FILE_PATH}`);
    if (SECRET === 'replace-me-in-production') {
      console.warn('[WARN] AUTH_SECRET is using the default placeholder. Set AUTH_SECRET before going live.');
    }
  });
}

module.exports.createServer = createServer;
module.exports.__testUtils = {
  applyQualificationNameMatchPolicy,
  buildDomainAgencyBrandSearchQueries,
  buildDomainResidentialSearchPayload,
  collectDomainResidentialSearchListings,
  extractDomainListingCoordinates,
  crossCheckDocumentName,
  hasUsableFullName,
  matchNames,
  matchesDomainAgencyListingMarket,
  normalizeDomainAgencyListing,
  normalizeDomainListing,
  normalizeDomainSourceUrl,
  parseLifestylePriceValue,
  resizeDomainImageUrl
};
