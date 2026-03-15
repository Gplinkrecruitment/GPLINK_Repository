#!/usr/bin/env node
/**
 * GP Link Multi-Agent Build System
 *
 * Architecture:
 *   LeadAgent   — receives a task, plans it, delegates subtasks
 *   FrontendAgent — HTML/CSS/JS UI changes
 *   BackendAgent  — server.js endpoints, Supabase schema, API logic
 *   ReviewAgent   — code quality, security, consistency check
 *
 * Usage:
 *   node scripts/agents.js "add a notifications bell to the mobile nav"
 *   node scripts/agents.js --task "your task here"
 *
 * Output:
 *   Each agent writes its work to agents-output/<timestamp>/
 *   A final REPORT.md summarises everything
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// Load .env from project root if present
(function loadDotEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key && val && !process.env[key]) process.env[key] = val;
    }
  } catch { /* no .env — that's fine */ }
})();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const ROOT  = path.resolve(__dirname, '..');

if (!ANTHROPIC_API_KEY) {
  console.error('❌  ANTHROPIC_API_KEY is required.');
  console.error('    Set it in .env or run:');
  console.error('    ANTHROPIC_API_KEY=sk-ant-... node scripts/agents.js "your task"');
  process.exit(1);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function readFileSafe(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch { return null; }
}

function readProjectContext() {
  // Pull Zoho-related lines from server.js as a focused snippet
  const serverFull = readFileSafe(path.join(ROOT, 'server.js')) || '';
  const serverTop = serverFull.split('\n').slice(0, 120).join('\n');
  const zohoLines = serverFull.split('\n')
    .filter(l => /zoho|ZOHO|recruit|RECRUIT/i.test(l))
    .slice(0, 40).join('\n');
  const supabaseLines = serverFull.split('\n')
    .filter(l => /supabase|SUPABASE/i.test(l))
    .slice(0, 30).join('\n');

  // Supabase migrations list
  const migrationsDir = path.join(ROOT, 'supabase', 'migrations');
  let migrationsList = '';
  try {
    migrationsList = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).join('\n');
  } catch { migrationsList = '(no migrations dir found)'; }

  // vercel.json
  const vercelJson = readFileSafe(path.join(ROOT, 'vercel.json'));

  const files = {
    'server.js — top 120 lines (routing patterns, env vars)': serverTop,
    'server.js — Zoho Recruit lines': zohoLines || '(none found)',
    'server.js — Supabase lines': supabaseLines || '(none found)',
    'vercel.json': vercelJson,
    'supabase/migrations (existing files)': migrationsList,
    'pages/career.html — structure (first 80 lines)': readFileSafe(path.join(ROOT, 'pages/career.html'))?.split('\n').slice(0, 80).join('\n'),
    'pages/my-documents.html — structure (first 80 lines)': readFileSafe(path.join(ROOT, 'pages/my-documents.html'))?.split('\n').slice(0, 80).join('\n'),
    'js/auth-guard.js (first 40 lines)': readFileSafe(path.join(ROOT, 'js/auth-guard.js'))?.split('\n').slice(0, 40).join('\n'),
    'docs/ai-scan-reference.md': readFileSafe(path.join(ROOT, 'docs/ai-scan-reference.md')),
    '.env.example (available env vars)': readFileSafe(path.join(ROOT, '.env.example')),
  };

  return Object.entries(files)
    .filter(([, v]) => v)
    .map(([k, v]) => `### ${k}\n\`\`\`\n${v}\n\`\`\``)
    .join('\n\n');
}

async function callClaude(systemPrompt, userMessage, { label = 'Agent', maxTokens = 4096 } = {}) {
  process.stdout.write(`  [${label}] thinking...`);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error (${response.status}): ${err}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '';
  process.stdout.write(` done (${text.length} chars)\n`);
  return text;
}

function parseJSON(text) {
  // Extract JSON from markdown code fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  try { return JSON.parse(raw.trim()); }
  catch { return null; }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ─── Lead Agent ─────────────────────────────────────────────────────────────

async function leadAgent(task, projectContext) {
  const system = `You are the Lead Agent for GP Link, a GP recruitment web app.

Full stack overview:
- Frontend: vanilla HTML/CSS/JS pages in /pages/ — no React, no build step, pure JS
- Backend: server.js — Node.js HTTP server (no Express), manual routing
- Database: Supabase (Postgres) — accessed via REST API, migrations in supabase/migrations/
- CRM/ATS: Zoho Recruit — OAuth 2.0, syncs job openings, candidates, applications
- Hosting: Vercel — vercel.json routes everything through server.js, env vars in Vercel dashboard
- AI: Anthropic Claude (claude-sonnet-4-6) — document verification, classification

Backend agent capabilities:
- Can add/edit API endpoints in server.js
- Can write Supabase SQL migrations (new tables, columns, RLS policies, functions)
- Can add/modify Zoho Recruit API calls (list jobs, create candidates, update application stage)
- Can add Vercel cron jobs in vercel.json
- Knows all env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ZOHO_RECRUIT_CLIENT_ID,
  ZOHO_RECRUIT_CLIENT_SECRET, ZOHO_RECRUIT_ACCOUNTS_SERVER, ANTHROPIC_API_KEY, AUTH_SECRET

Your job is to:
1. Understand the task
2. Break it into specific subtasks for specialist agents
3. Return a structured plan as JSON

The specialist agents are:
- frontend: HTML pages in /pages/, inline CSS, inline JS, mobile nav, modals, cards, design system
- backend: server.js endpoints, Supabase schema, Zoho Recruit API calls, Vercel cron jobs
- review: security audit, bug check, accessibility, design consistency

Rules:
- Only include an agent if the task genuinely needs it
- Be specific — each subtask must be self-contained and actionable
- frontend subtasks must name which HTML file(s) to edit
- backend subtasks must name which endpoint, table, or Zoho module is affected
- If a task touches Zoho data AND the UI, backend runs first, frontend depends on it
- review always runs last with dependsOn pointing to all other subtask ids

Return ONLY valid JSON (no markdown fences):
{
  "summary": "one sentence describing what will be built",
  "subtasks": [
    {
      "agent": "frontend" | "backend" | "review",
      "id": "short-kebab-id",
      "title": "short title",
      "description": "detailed description of exactly what to do",
      "files": ["list of files involved"],
      "dependsOn": ["ids of subtasks that must complete first, or empty array"]
    }
  ]
}`;

  const message = `Project context:\n${projectContext}\n\n---\nTask: ${task}`;
  const raw = await callClaude(system, message, { label: 'Lead', maxTokens: 2048 });
  const plan = parseJSON(raw);
  if (!plan || !Array.isArray(plan.subtasks)) {
    throw new Error('Lead agent returned invalid plan:\n' + raw);
  }
  return plan;
}

// ─── Frontend Agent ──────────────────────────────────────────────────────────

async function frontendAgent(subtask, projectContext, previousOutputs) {
  const system = `You are the Frontend Agent for GP Link.

Design system:
- Font: Inter (from Google Fonts, already loaded)
- Colors: --blue #2563eb, --blue2 #1d4ed8, --blue3 #1e3a8a, --bg #f0f4fa, --text #0f172a, --muted #64748b, --line #e2e8f0
- Glass cards: background rgba(255,255,255,0.72), backdrop-filter blur(20px) saturate(1.4), border 1px solid rgba(255,255,255,0.5)
- Radial gradient body background already set on each page
- Mobile nav: 5 tabs (Home, Registration, Scan, Career, Account) — grid-template-columns: repeat(5, 1fr)
- No frameworks — pure HTML, inline <style>, inline <script>
- cache busters on script tags: ?v=YYYYMMDD[letter]
- Event delegation preferred over per-element listeners

Your output must be a JSON object:
{
  "files": [
    {
      "path": "pages/filename.html",
      "action": "edit" | "create",
      "description": "what changed and why",
      "changes": [
        {
          "description": "what this change does",
          "find": "exact text to find and replace (for edits) — must match file content exactly",
          "replace": "replacement text"
        }
      ]
    }
  ],
  "notes": "any important implementation notes"
}

For 'create' actions, omit 'changes' and instead include 'fullContent': "complete file content".
Be precise — 'find' strings must match exactly what's in the file.`;

  const prevContext = previousOutputs.length
    ? `\n\nPrevious agent outputs:\n${previousOutputs.map(o => `[${o.id}]\n${o.output}`).join('\n\n')}`
    : '';

  const message = `Project context:\n${projectContext}${prevContext}\n\n---\nSubtask: ${subtask.title}\n${subtask.description}\nFiles involved: ${subtask.files.join(', ')}`;
  const raw = await callClaude(system, message, { label: `Frontend:${subtask.id}`, maxTokens: 6000 });
  return { raw, parsed: parseJSON(raw) };
}

// ─── Backend Agent ───────────────────────────────────────────────────────────

async function backendAgent(subtask, projectContext, previousOutputs) {
  const system = `You are the Backend Agent for GP Link. You have full knowledge of and access to three systems:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. SERVER.JS — Node.js HTTP server
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- No Express — native http module with manual routing
- Routes: if (method === 'POST' && pathname === '/api/...')
- Auth: verifySession(req) returns { userId, email } or throws
- Always return JSON: res.end(JSON.stringify({ ok: true, ... }))
- Env vars already available: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  ZOHO_RECRUIT_CLIENT_ID, ZOHO_RECRUIT_CLIENT_SECRET, ZOHO_RECRUIT_ACCOUNTS_SERVER,
  ZOHO_RECRUIT_REDIRECT_URI, ZOHO_RECRUIT_SCOPES

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2. SUPABASE — Postgres database (REST API)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- REST calls: fetch(\`\${SUPABASE_URL}/rest/v1/tablename\`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: \`Bearer \${SUPABASE_SERVICE_ROLE_KEY}\`,
               'Content-Type': 'application/json', Prefer: 'return=representation' }
  })
- SELECT: GET with ?select=col1,col2&filter=eq.value
- INSERT: POST with body JSON
- UPDATE: PATCH with ?id=eq.value and body JSON
- UPSERT: POST with Prefer: resolution=merge-duplicates
- RPC: POST to /rest/v1/rpc/function_name
- Migrations: supabase/migrations/YYYYMMDDHHMMSS_name.sql
- Key tables: gp_users, gp_onboarding_state, gp_documents, gp_career_roles, gp_applications
- Storage buckets: gp-link-documents (for uploaded files)
- Always add Row Level Security (RLS) policies in migrations

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3. ZOHO RECRUIT — CRM/ATS integration
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- OAuth 2.0 flow: ZOHO_RECRUIT_CLIENT_ID + ZOHO_RECRUIT_CLIENT_SECRET
- Token endpoint: \`\${ZOHO_RECRUIT_ACCOUNTS_SERVER}/oauth/v2/token\`
- API base: https://recruit.zoho.com/recruit/v2/ (or region-specific)
- Key modules: Job_Openings, Candidates, Applications, Interviews
- Tokens stored in Supabase (zoho_tokens table) — refresh before each call
- Sync endpoint already exists: GET /api/integrations/zoho-recruit/cron-sync
- Webhook support: POST /api/integrations/zoho-recruit/webhook
- Common operations:
  - List jobs: GET /recruit/v2/Job_Openings?fields=Job_Opening_Name,City,State,Salary&status=Open
  - Get candidate: GET /recruit/v2/Candidates/{id}
  - Create application: POST /recruit/v2/Applications
  - Update stage: PUT /recruit/v2/Applications/{id}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
4. VERCEL — Deployment platform
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Deployed via vercel.json — all routes go through server.js
- Cron jobs defined in vercel.json under "crons": [{ "path": "/api/...", "schedule": "0 * * * *" }]
- Env vars set in Vercel dashboard (not in .env for production)
- vercel.json maxDuration: 30 (seconds) per request — keep endpoints fast
- For long-running tasks use background jobs or split into smaller calls
- Edge config not used — all config via env vars

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your output must be a JSON object:
{
  "files": [
    {
      "path": "server.js" | "supabase/migrations/YYYYMMDDHHMMSS_name.sql" | "vercel.json",
      "action": "edit" | "create",
      "description": "what changed and why",
      "changes": [
        {
          "description": "what this change does",
          "find": "exact text to find (for edits) — must match file exactly",
          "replace": "replacement text"
        }
      ]
    }
  ],
  "envVars": [
    { "name": "VAR_NAME", "description": "what it's for", "required": true }
  ],
  "supabaseMigrations": ["list any SQL migration files created"],
  "zohoScopes": ["any additional Zoho OAuth scopes needed beyond the default"],
  "notes": "deployment steps, cron schedules, migration instructions"
}

For 'create' actions, include 'fullContent' instead of 'changes'.
Always validate inputs server-side. Always check auth with verifySession() on protected routes.
Never log secrets. Use parameterised queries / Supabase REST params, never string-concatenated SQL.`;

  const prevContext = previousOutputs.length
    ? `\n\nPrevious agent outputs:\n${previousOutputs.map(o => `[${o.id}]\n${o.output}`).join('\n\n')}`
    : '';

  const message = `Project context:\n${projectContext}${prevContext}\n\n---\nSubtask: ${subtask.title}\n${subtask.description}\nFiles involved: ${subtask.files.join(', ')}`;
  const raw = await callClaude(system, message, { label: `Backend:${subtask.id}`, maxTokens: 6000 });
  return { raw, parsed: parseJSON(raw) };
}

// ─── Review Agent ────────────────────────────────────────────────────────────

async function reviewAgent(subtask, projectContext, previousOutputs) {
  const system = `You are the Security & Code Review Agent for GP Link.

You review changes across all three backend systems plus the frontend:

FRONTEND checks:
- XSS: no innerHTML with unescaped user data, no eval()
- Missing cache busters on script/link tags (?v=YYYYMMDD)
- Mobile nav must have exactly 5 tabs (Home, Registration, Scan, Career, Account)
- Design system: Inter font, --blue #2563eb, glass cards with backdrop-filter
- Accessibility: aria labels, keyboard nav, sufficient contrast

BACKEND / server.js checks:
- Every protected endpoint calls verifySession() before touching data
- No secrets logged or returned to client
- Input validated and sanitised before use
- JSON parse wrapped in try/catch
- Errors return { ok: false, error: "..." } not stack traces

SUPABASE checks:
- New tables have RLS enabled in migration SQL
- RLS policies exist for SELECT/INSERT/UPDATE/DELETE
- No raw SQL string concatenation — use Supabase REST params
- Migrations are additive (no DROP TABLE on live data without backup plan)

ZOHO RECRUIT checks:
- OAuth tokens refreshed before each API call, not assumed valid
- Zoho API errors handled gracefully (rate limits, 401, 429)
- No Zoho credentials exposed to frontend responses
- Synced data normalised before storing in Supabase

VERCEL checks:
- maxDuration not exceeded (30s limit per request)
- Cron jobs have auth protection (CRON_SECRET header check)
- No secrets in vercel.json (env vars only in dashboard)

Return a JSON report:
{
  "approved": true | false,
  "issues": [
    {
      "severity": "critical" | "warning" | "suggestion",
      "agent": "frontend" | "backend",
      "file": "filename",
      "description": "what the issue is",
      "fix": "exactly how to fix it"
    }
  ],
  "summary": "overall assessment in 1-2 sentences"
}

approved: false if any critical issues exist.`;

  const allOutputs = previousOutputs.map(o => `[${o.id} — ${o.agent}]\n${o.output}`).join('\n\n');
  const message = `Project context:\n${projectContext}\n\nAll agent outputs to review:\n${allOutputs}\n\n---\nReview task: ${subtask.description}`;
  const raw = await callClaude(system, message, { label: 'Review', maxTokens: 3000 });
  return { raw, parsed: parseJSON(raw) };
}

// ─── Apply changes ───────────────────────────────────────────────────────────

function applyFileChanges(fileSpec, outputDir) {
  const filePath = path.join(ROOT, fileSpec.path);
  const outputPath = path.join(outputDir, fileSpec.path.replace(/\//g, '_'));

  if (fileSpec.action === 'create' && fileSpec.fullContent) {
    fs.writeFileSync(outputPath + '.new', fileSpec.fullContent, 'utf8');
    console.log(`    📄 Would create: ${fileSpec.path}`);
    return { applied: false, reason: 'create — review output file before applying' };
  }

  if (fileSpec.action === 'edit' && Array.isArray(fileSpec.changes)) {
    let content = readFileSafe(filePath);
    if (!content) {
      console.log(`    ⚠️  File not found: ${fileSpec.path}`);
      return { applied: false, reason: 'file not found' };
    }

    let applied = 0;
    const results = [];
    for (const change of fileSpec.changes) {
      if (content.includes(change.find)) {
        content = content.replace(change.find, change.replace);
        applied++;
        results.push({ ok: true, desc: change.description });
      } else {
        results.push({ ok: false, desc: change.description, reason: 'find string not matched' });
      }
    }

    // Write patched version to output dir for review
    fs.writeFileSync(outputPath + '.patched', content, 'utf8');
    console.log(`    ✏️  ${fileSpec.path}: ${applied}/${fileSpec.changes.length} changes matched`);
    return { applied: applied > 0, results };
  }

  return { applied: false, reason: 'unknown action' };
}

// ─── Main orchestrator ───────────────────────────────────────────────────────

async function run(task) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputDir = path.join(ROOT, 'agents-output', timestamp);
  ensureDir(outputDir);

  console.log('\n🤖 GP Link Multi-Agent System');
  console.log('━'.repeat(50));
  console.log(`📋 Task: ${task}`);
  console.log(`📁 Output: agents-output/${timestamp}/`);
  console.log('━'.repeat(50) + '\n');

  // Read project context once
  console.log('📖 Reading project context...');
  const projectContext = readProjectContext();

  // Step 1: Lead agent plans
  console.log('\n🎯 LEAD AGENT — Planning\n');
  const plan = await leadAgent(task, projectContext);

  console.log(`\n📌 Plan: ${plan.summary}`);
  console.log(`   ${plan.subtasks.length} subtasks:\n`);
  plan.subtasks.forEach(s => {
    console.log(`   [${s.agent.toUpperCase()}] ${s.id}: ${s.title}`);
  });

  fs.writeFileSync(path.join(outputDir, 'plan.json'), JSON.stringify(plan, null, 2));

  // Step 2: Execute subtasks in dependency order
  const completed = {};   // id → { output, agent }
  const remaining = [...plan.subtasks];
  let iterations = 0;

  while (remaining.length > 0 && iterations < 20) {
    iterations++;
    const ready = remaining.filter(s =>
      s.dependsOn.every(dep => completed[dep])
    );

    if (ready.length === 0) {
      console.error('\n❌ Dependency deadlock — remaining:', remaining.map(s => s.id));
      break;
    }

    for (const subtask of ready) {
      remaining.splice(remaining.indexOf(subtask), 1);

      const prevOutputs = subtask.dependsOn.map(dep => ({
        id: dep,
        agent: completed[dep].agent,
        output: completed[dep].output,
      }));

      console.log(`\n${'─'.repeat(50)}`);
      console.log(`⚙️  [${subtask.agent.toUpperCase()}] ${subtask.title}`);
      console.log(`   ${subtask.description.slice(0, 120)}${subtask.description.length > 120 ? '…' : ''}`);
      console.log('');

      let result;
      if (subtask.agent === 'frontend') {
        result = await frontendAgent(subtask, projectContext, prevOutputs);
      } else if (subtask.agent === 'backend') {
        result = await backendAgent(subtask, projectContext, prevOutputs);
      } else if (subtask.agent === 'review') {
        result = await reviewAgent(subtask, projectContext, prevOutputs);
      }

      // Save raw output
      const outFile = path.join(outputDir, `${subtask.id}_${subtask.agent}.md`);
      fs.writeFileSync(outFile, result.raw, 'utf8');

      // Apply changes if parsed successfully
      if (result.parsed && result.parsed.files) {
        console.log(`\n   Applying ${result.parsed.files.length} file(s):`);
        result.parsed.files.forEach(f => applyFileChanges(f, outputDir));
      } else if (result.parsed && result.parsed.issues) {
        // Review output
        const { approved, issues, summary } = result.parsed;
        console.log(`\n   Review: ${approved ? '✅ APPROVED' : '❌ NOT APPROVED'}`);
        console.log(`   ${summary}`);
        if (issues && issues.length > 0) {
          issues.forEach(issue => {
            const icon = issue.severity === 'critical' ? '🔴' : issue.severity === 'warning' ? '🟡' : '💡';
            console.log(`   ${icon} [${issue.file}] ${issue.description}`);
          });
        }
      }

      completed[subtask.id] = { output: result.raw, agent: subtask.agent };
    }
  }

  // Step 3: Write final report
  const report = [
    `# GP Link Agent Report`,
    `**Task:** ${task}`,
    `**Date:** ${new Date().toISOString()}`,
    `**Model:** ${MODEL}`,
    '',
    `## Plan`,
    `${plan.summary}`,
    '',
    `## Subtasks`,
    ...plan.subtasks.map(s => [
      `### [${s.agent.toUpperCase()}] ${s.title}`,
      s.description,
      `**Files:** ${s.files.join(', ')}`,
      '',
    ].join('\n')),
    `## Output Files`,
    `All agent outputs saved to \`agents-output/${timestamp}/\``,
    '',
    `### Files generated:`,
    ...Object.keys(completed).map(id => `- \`${id}_${plan.subtasks.find(s=>s.id===id)?.agent}.md\``),
    '',
    `## How to apply changes`,
    `1. Review \`.patched\` files in the output directory`,
    `2. If happy, copy them over the originals`,
    `3. For \`.new\` files, review and place in the correct location`,
    `4. Run the app locally to verify: \`npm start\``,
    `5. Commit and push`,
  ].join('\n');

  fs.writeFileSync(path.join(outputDir, 'REPORT.md'), report);

  console.log('\n' + '━'.repeat(50));
  console.log(`✅ All agents complete`);
  console.log(`📁 Output: agents-output/${timestamp}/`);
  console.log(`📄 Report: agents-output/${timestamp}/REPORT.md`);
  console.log('━'.repeat(50) + '\n');
  console.log('Next steps:');
  console.log('  1. Review .patched files in the output directory');
  console.log('  2. Apply the ones you approve');
  console.log('  3. Run: npm start');
  console.log('');
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const taskArgIdx = args.indexOf('--task');
const task = taskArgIdx !== -1
  ? args[taskArgIdx + 1]
  : args.join(' ').trim();

if (!task) {
  console.error('Usage: node scripts/agents.js "your task description"');
  console.error('       node scripts/agents.js --task "your task description"');
  process.exit(1);
}

run(task).catch(err => {
  console.error('\n❌ Agent system error:', err.message);
  process.exit(1);
});
