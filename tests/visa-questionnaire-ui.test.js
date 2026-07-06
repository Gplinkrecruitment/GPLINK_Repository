// Phase 6 Batch I3 — the EXISTING visa questionnaire server flow is wired into
// the admin UI (GP file's visa step in pages/admin.html). RSOs previously had
// no button for it there: admin.html only ever called /api/admin/visa/cases.
//
// Contract pinned here:
//   - the GP file's visa step renders a questionnaire pane with lifecycle
//     actions (request → review approve/return → PDF → mark ready/sent) plus a
//     read-only dependants list;
//   - every route the UI calls actually exists in server.js (no invented
//     endpoints);
//   - recipient-route dropdowns only offer values the server accepts
//     (QUESTIONNAIRE_ROUTES) — admin-visa.html previously sent values the
//     server silently dropped;
//   - all interpolated GP data goes through esc() (XSS).
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let adminHtml, adminVisaHtml, serverJs;

beforeAll(() => {
  adminHtml = fs.readFileSync(path.join(root, 'pages', 'admin.html'), 'utf8');
  adminVisaHtml = fs.readFileSync(path.join(root, 'pages', 'admin-visa.html'), 'utf8');
  serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
});

// Every route the new admin.html pane calls, with the method-check that must
// exist in server.js for it.
const WIRED_ROUTES = [
  { route: '/api/admin/visa/questionnaire', method: 'GET' },
  { route: '/api/admin/visa/questionnaire/request', method: 'POST' },
  { route: '/api/admin/visa/questionnaire/review', method: 'POST' },
  { route: '/api/admin/visa/questionnaire/pdf', method: 'GET' },
  { route: '/api/admin/visa/questionnaire/send', method: 'POST' },
  { route: '/api/admin/visa/dependants', method: 'GET' },
];

describe('admin.html GP-file visa step — questionnaire pane', () => {
  it('renders the questionnaire pane inside the visa journey step', () => {
    expect(adminHtml).toContain('renderVisaQuestionnairePane(c)');
    // wired into the visa step template next to the Manage Visa link
    expect(adminHtml).toMatch(/Manage Visa<\/a>\$\{renderVisaQuestionnairePane\(c\)\}/);
    expect(adminHtml).toContain('data-vq-panel');
  });

  it('loads state from the questionnaire + dependants endpoints', () => {
    expect(adminHtml).toContain('/api/admin/visa/questionnaire?visaCaseId=');
    expect(adminHtml).toContain('/api/admin/visa/dependants?caseId=');
  });

  it('has a lifecycle action for each existing endpoint', () => {
    expect(adminHtml).toContain('data-vq-request');   // request from GP
    expect(adminHtml).toContain('data-vq-approve');   // review: approve
    expect(adminHtml).toContain('data-vq-return-confirm'); // review: return
    expect(adminHtml).toContain('/api/admin/visa/questionnaire/pdf?visaCaseId=');
    expect(adminHtml).toContain('data-vq-ready');     // send: ready
    expect(adminHtml).toContain('data-vq-sent');      // send: sent
  });

  it('posts to the correct routes with the payload fields the server reads', () => {
    expect(adminHtml).toMatch(/\/api\/admin\/visa\/questionnaire\/request",\{visaCaseId:[^}]*userId:/);
    expect(adminHtml).toMatch(/\/api\/admin\/visa\/questionnaire\/review",\{visaCaseId:[^}]*action:"approve"/);
    expect(adminHtml).toMatch(/\/api\/admin\/visa\/questionnaire\/review",\{visaCaseId:[^}]*action:"return",returnNote:/);
    expect(adminHtml).toMatch(/\/api\/admin\/visa\/questionnaire\/send",\{visaCaseId:[^}]*action:"ready",recipientRoute:/);
    expect(adminHtml).toMatch(/\/api\/admin\/visa\/questionnaire\/send",\{visaCaseId:[^}]*action:"sent",recipientRoute:[^}]*sendNote:/);
  });

  it('guards the step-collapse toggle so clicks inside the pane do not collapse it', () => {
    expect(adminHtml).toMatch(/data-toggle-step[^\n]*closest\("\[data-vq-panel\]"\)/);
  });

  it('escapes interpolated GP data in the pane (return note, answers, dependants)', () => {
    expect(adminHtml).toMatch(/esc\(q\.return_note\)/);
    expect(adminHtml).toMatch(/esc\(d\.full_name\|\|""\)/);
    expect(adminHtml).toMatch(/esc\(Array\.isArray\(v\)\?v\.join\(", "\):String\(v\)\)/);
    expect(adminHtml).toMatch(/esc\(q\.sent_by\)/);
  });
});

describe('no invented endpoints — every wired route exists in server.js', () => {
  for (const { route, method } of WIRED_ROUTES) {
    it(`${method} ${route} exists`, () => {
      const handler = `pathname === '${route}' && req.method === '${method}'`;
      expect(serverJs).toContain(handler);
    });
  }

  it('wired routes all require an admin session', () => {
    for (const { route, method } of WIRED_ROUTES) {
      const idx = serverJs.indexOf(`pathname === '${route}' && req.method === '${method}'`);
      expect(idx).toBeGreaterThan(-1);
      const body = serverJs.slice(idx, idx + 600);
      expect(body, `${route} should call requireAdminSession`).toContain('requireAdminSession');
    }
  });
});

describe('recipient routes match the server allowlist', () => {
  it('server QUESTIONNAIRE_ROUTES is the known 3-value list', () => {
    expect(serverJs).toContain(
      "const QUESTIONNAIRE_ROUTES = ['gplink_migration_agent','practice_agent','practice_direct']"
    );
  });

  it('admin.html route dropdown only offers server-accepted values', () => {
    expect(adminHtml).toContain('"gplink_migration_agent"');
    expect(adminHtml).toContain('"practice_agent"');
    expect(adminHtml).toContain('"practice_direct"');
  });

  it('admin-visa.html recipient-route dropdowns no longer send values the server drops', () => {
    // Previously qRecipientRoute/qSendRoute offered migration_agent / sponsor /
    // department / other — all outside QUESTIONNAIRE_ROUTES, so recipient_route
    // was silently nulled. (Other selects on the page — doc type, task type,
    // task domain — legitimately use their own vocabularies.)
    for (const selectId of ['qRecipientRoute', 'qSendRoute']) {
      const start = adminVisaHtml.indexOf('id="' + selectId + '"');
      expect(start, selectId + ' select exists').toBeGreaterThan(-1);
      const block = adminVisaHtml.slice(start, adminVisaHtml.indexOf('</select>', start));
      expect(block).not.toContain('value="migration_agent"');
      expect(block).not.toContain('value="sponsor"');
      expect(block).not.toContain('value="department"');
      expect(block).not.toContain('value="other"');
      expect(block).toContain('value="gplink_migration_agent"');
      expect(block).toContain('value="practice_agent"');
      expect(block).toContain('value="practice_direct"');
    }
  });
});

describe('no GP-facing surface touched', () => {
  it('the pane lives in admin.html only — GP-facing visa.html does not gain admin questionnaire actions', () => {
    const visaHtml = fs.readFileSync(path.join(root, 'pages', 'visa.html'), 'utf8');
    expect(visaHtml).not.toContain('data-vq-request');
    expect(visaHtml).not.toContain('/api/admin/visa/questionnaire');
  });
});
