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
  const files = {
    'server.js (first 120 lines)': readFileSafe(path.join(ROOT, 'server.js'))?.split('\n').slice(0, 120).join('\n'),
    'pages/career.html (structure)': readFileSafe(path.join(ROOT, 'pages/career.html'))?.split('\n').slice(0, 80).join('\n'),
    'pages/my-documents.html (structure)': readFileSafe(path.join(ROOT, 'pages/my-documents.html'))?.split('\n').slice(0, 80).join('\n'),
    'js/auth-guard.js (first 40 lines)': readFileSafe(path.join(ROOT, 'js/auth-guard.js'))?.split('\n').slice(0, 40).join('\n'),
    'docs/ai-scan-reference.md': readFileSafe(path.join(ROOT, 'docs/ai-scan-reference.md')),
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

The stack is: vanilla HTML/CSS/JS pages in /pages/, a Node.js server in server.js,
Supabase for the database, deployed on Vercel. No React on the main pages — pure JS.

Your job is to:
1. Understand the task
2. Break it into specific subtasks for specialist agents
3. Return a structured plan as JSON

The specialist agents are:
- frontend: handles HTML pages in /pages/, inline CSS, inline JS, mobile nav, modals, cards
- backend: handles server.js API endpoints, Supabase schema (SQL migrations), auth logic
- review: audits code for security issues, bugs, consistency, accessibility

Rules:
- Only include an agent if the task genuinely needs it
- Be specific — each subtask should be self-contained and actionable
- frontend subtasks should name which HTML file(s) to edit
- backend subtasks should name which endpoint or table is affected
- review always runs last

Return ONLY this JSON (no markdown fences needed):
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
  const system = `You are the Backend Agent for GP Link.

Stack:
- server.js: Node.js HTTP server (no Express), uses native \`http\` module + manual routing
- Supabase: postgres DB accessed via REST API using SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
- Auth: gp_session cookie (signed JWT-like), parsed by verifySession()
- AI: fetch to https://api.anthropic.com/v1/messages with ANTHROPIC_API_KEY
- Deployed on Vercel via @vercel/node

Patterns in server.js:
- Routes matched by: if (method === 'POST' && pathname === '/api/...')
- DB calls: fetch(\`\${SUPABASE_URL}/rest/v1/tablename\`, { headers: { apikey, Authorization } })
- Always return JSON: res.end(JSON.stringify({ ok: true, ... }))
- Migrations go in supabase/migrations/YYYYMMDDHHMMSS_name.sql

Your output must be a JSON object:
{
  "files": [
    {
      "path": "server.js" | "supabase/migrations/....sql",
      "action": "edit" | "create",
      "description": "what changed and why",
      "changes": [
        {
          "description": "what this change does",
          "find": "exact text to find (for edits)",
          "replace": "replacement text"
        }
      ]
    }
  ],
  "notes": "any env vars needed, migration steps, or deployment notes"
}

For 'create' actions, include 'fullContent' instead of 'changes'.`;

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

Review all agent outputs for:
1. Security: XSS, SQL injection, missing auth checks, exposed secrets, unvalidated input
2. Bugs: off-by-one errors, missing null checks, unhandled promise rejections
3. Consistency: design system compliance (colors, spacing, fonts), mobile nav structure
4. Accessibility: missing aria labels, poor contrast, keyboard traps
5. Performance: unnecessary re-renders, missing cache busters, large payloads

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
  "summary": "overall assessment"
}

If approved is false, list all critical issues that must be fixed before shipping.`;

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
