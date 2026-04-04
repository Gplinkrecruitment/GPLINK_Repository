#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const hybridAgents = require('./agents.js');

const ROOT = path.resolve(__dirname, '..');
const AGENT_OUTPUT_ROOT = path.join(ROOT, 'agents-output');
const DEFAULT_HOST = String(process.env.AGENT_BRIDGE_HOST || '127.0.0.1').trim() || '127.0.0.1';
const DEFAULT_PORT = Math.max(1, Number.parseInt(process.env.AGENT_BRIDGE_PORT || '4317', 10) || 4317);
const DEFAULT_ALLOWED_ORIGINS = [
  'https://ceo.admin.mygplink.com.au',
  'https://admin.mygplink.com.au',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://localhost:3000',
  'https://127.0.0.1:3000',
];

const ALLOWED_ORIGINS = new Set(
  String(process.env.AGENT_BRIDGE_ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);

const bridgeState = {
  activeRunId: '',
  runs: {},
  providerStatusCache: {
    expiresAt: 0,
    refreshedAt: '',
    data: null,
    inFlight: null,
  },
};

function parseArgs(rawArgs) {
  const options = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    help: false,
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--host') {
      options.host = String(rawArgs[i + 1] || options.host).trim() || options.host;
      i++;
    } else if (arg === '--port') {
      options.port = Math.max(1, Number.parseInt(rawArgs[i + 1] || String(options.port), 10) || options.port);
      i++;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`GP Link local hybrid-agent bridge

Usage:
  node scripts/agent-bridge.js
  node scripts/agent-bridge.js --host 127.0.0.1 --port 4317

This bridge runs on your Mac and lets the live admin dashboard call your local
Codex and Claude CLIs over localhost only.

Environment:
  AGENT_BRIDGE_HOST             Default: ${DEFAULT_HOST}
  AGENT_BRIDGE_PORT             Default: ${DEFAULT_PORT}
  AGENT_BRIDGE_ALLOWED_ORIGINS  Default: ${Array.from(ALLOWED_ORIGINS).join(', ')}`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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
  ensureDir(path.dirname(filePath));
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

function sanitizeRunId(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function getRunDir(runId) {
  return path.join(AGENT_OUTPUT_ROOT, sanitizeRunId(runId));
}

function getRunSummary(runId) {
  const safeRunId = sanitizeRunId(runId);
  if (!safeRunId) return null;
  const runDir = getRunDir(safeRunId);
  const runState = readJsonFileSafe(path.join(runDir, 'run-state.json')) || {};
  const registry = bridgeState.runs[safeRunId] || {};
  const launch = readJsonFileSafe(path.join(runDir, 'launch.json')) || {};
  const reportPath = path.join(runDir, 'REPORT.md');
  const stdoutPath = path.join(runDir, 'orchestrator.stdout.log');
  const stderrPath = path.join(runDir, 'orchestrator.stderr.log');

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
    requestedBy: runState.requestedBy || registry.requestedBy || launch.requestedBy || 'Local bridge',
    currentSubtask: runState.currentSubtask || registry.currentSubtask || null,
    completedSubtasks: Array.isArray(runState.completedSubtasks) ? runState.completedSubtasks : [],
    planSummary: runState.planSummary || '',
    outputDir: path.relative(ROOT, runDir),
    reportExists: fs.existsSync(reportPath),
    reportPath: fs.existsSync(reportPath) ? path.relative(ROOT, reportPath) : '',
    reportPreview: fs.existsSync(reportPath) ? tailFile(reportPath, 10000) : '',
    stdoutTail: tailFile(stdoutPath, 8000),
    stderrTail: tailFile(stderrPath, 4000),
  };
}

function listRuns(limit = 12) {
  ensureDir(AGENT_OUTPUT_ROOT);
  let entries = [];
  try {
    entries = fs.readdirSync(AGENT_OUTPUT_ROOT, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
      .reverse();
  } catch {
    entries = [];
  }

  const runs = [];
  for (const runId of entries) {
    const summary = getRunSummary(runId);
    if (summary) runs.push(summary);
    if (runs.length >= limit) break;
  }

  const activeRunId = bridgeState.activeRunId;
  if (activeRunId && !runs.find(run => run.runId === activeRunId)) {
    const live = getRunSummary(activeRunId);
    if (live) runs.unshift(live);
  }

  return runs.slice(0, limit);
}

function hasActiveRun() {
  const activeRunId = bridgeState.activeRunId;
  if (!activeRunId) return false;
  const record = bridgeState.runs[activeRunId];
  return !!(record && record.status === 'running');
}

function updateRunRegistry(runId, patch) {
  const safeRunId = sanitizeRunId(runId);
  if (!safeRunId) return null;
  bridgeState.runs[safeRunId] = {
    ...(bridgeState.runs[safeRunId] || {}),
    ...patch,
    runId: safeRunId,
  };
  return bridgeState.runs[safeRunId];
}

function buildChildEnv() {
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
    'ANTHROPIC_SIMPLE_MODEL',
  ];

  allowList.forEach(key => {
    if (typeof process.env[key] === 'string' && process.env[key]) env[key] = process.env[key];
  });

  env.PATH = process.env.PATH || env.PATH || '';
  env.HOME = process.env.HOME || env.HOME || '';
  env.NODE_ENV = process.env.NODE_ENV || 'production';
  env.AGENT_SKIP_DOTENV = 'true';
  return env;
}

async function getCachedProviderStatus(force = false) {
  const nowMs = Date.now();
  if (!force && bridgeState.providerStatusCache.data && bridgeState.providerStatusCache.expiresAt > nowMs) {
    return bridgeState.providerStatusCache.data;
  }
  if (!force && bridgeState.providerStatusCache.inFlight) {
    return bridgeState.providerStatusCache.inFlight;
  }

  const promise = hybridAgents.inspectProviders()
    .then(data => {
      bridgeState.providerStatusCache.data = data;
      bridgeState.providerStatusCache.expiresAt = Date.now() + 10000;
      bridgeState.providerStatusCache.refreshedAt = new Date().toISOString();
      bridgeState.providerStatusCache.inFlight = null;
      return data;
    })
    .catch(error => {
      bridgeState.providerStatusCache.inFlight = null;
      throw error;
    });

  bridgeState.providerStatusCache.inFlight = promise;
  return promise;
}

function buildDashboardState(taskText, options) {
  const task = String(taskText || '').trim();
  const profile = options && options.profile ? options.profile : 'balanced';
  const collaborationMode = options && options.collaborationMode ? options.collaborationMode : 'paired';
  const complexityMode = options && options.complexityMode ? options.complexityMode : 'auto';
  const providerStates = options && options.providerStates ? options.providerStates : bridgeState.providerStatusCache.data;
  const providerEntries = providerStates ? Object.values(providerStates) : [];
  const availableProviders = providerEntries.filter(state => state && state.available);
  const warnings = [];

  if (!availableProviders.length) {
    warnings.push('Neither Codex nor Claude is currently connected on this Mac. Run the connect commands locally.');
  } else if (collaborationMode === 'paired' && availableProviders.length < 2) {
    warnings.push('Only one provider is connected locally, so paired mode will automatically fall back to routed execution.');
  }
  if (task && hybridAgents.inferBrowserUseNeed && hybridAgents.inferBrowserUseNeed(task) && !(providerStates && providerStates.anthropic && providerStates.anthropic.browserUse && providerStates.anthropic.browserUse.available)) {
    warnings.push('This task looks like a browser/computer walkthrough, but Claude browser-use MCP is not connected on this Mac.');
  }
  if (task && task.length < 12) {
    warnings.push('Short prompts produce weaker plans. Give the agent a concrete, repo-specific task.');
  }

  return {
    policy: hybridAgents.getModelPolicy(task, complexityMode, profile, collaborationMode),
    activeRunId: bridgeState.activeRunId || '',
    runs: listRuns(12),
    providerStatusRefreshedAt: bridgeState.providerStatusCache.refreshedAt || '',
    warnings,
    security: {
      superAdminOnly: true,
      sameOriginRequired: true,
      singleActiveRun: true,
      subscriptionCliOnly: true,
      secretsPassedToChild: false,
      bridgeLoopbackOnly: true,
      allowedOrigins: Array.from(ALLOWED_ORIGINS),
    },
  };
}

function startRun(options) {
  const task = String(options && options.task ? options.task : '').trim();
  if (!task) throw new Error('Task is required.');
  if (hasActiveRun()) throw new Error('An agent run is already in progress.');

  const profile = ['balanced', 'codex-heavy', 'claude-heavy'].includes(options.profile) ? options.profile : 'balanced';
  const collaborationMode = ['single', 'routed', 'paired'].includes(options.collaborationMode) ? options.collaborationMode : 'paired';
  const complexity = ['auto', 'simple', 'standard', 'complex'].includes(options.complexity) ? options.complexity : 'auto';
  const runId = sanitizeRunId(options.runId || `agent-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  const requestedBy = typeof options.requestedBy === 'string' ? options.requestedBy.trim() : 'Local bridge';
  const runDir = getRunDir(runId);
  ensureDir(runDir);

  const stdoutPath = path.join(runDir, 'orchestrator.stdout.log');
  const stderrPath = path.join(runDir, 'orchestrator.stderr.log');
  const stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'a' });
  const stderrStream = fs.createWriteStream(stderrPath, { flags: 'a' });
  const args = [
    'scripts/agents.js',
    '--task', task,
    '--profile', profile,
    '--collaboration', collaborationMode,
    '--complexity', complexity,
    '--run-id', runId,
  ];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: buildChildEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  bridgeState.activeRunId = runId;
  updateRunRegistry(runId, {
    status: 'running',
    phase: 'launching',
    startedAt: new Date().toISOString(),
    task,
    profile,
    collaborationMode,
    complexityMode: complexity,
    taskComplexity: hybridAgents.resolveTaskComplexity(task, complexity),
    requestedBy,
    pid: child.pid,
    stdoutPath,
    stderrPath,
  });

  writeJsonFileSafe(path.join(runDir, 'launch.json'), {
    runId,
    task,
    profile,
    collaborationMode,
    complexityMode: complexity,
    pid: child.pid,
    requestedBy,
    startedAt: new Date().toISOString(),
  });

  child.stdout.on('data', chunk => stdoutStream.write(chunk));
  child.stderr.on('data', chunk => stderrStream.write(chunk));
  child.on('close', (code, signal) => {
    stdoutStream.end();
    stderrStream.end();
    const existingState = readJsonFileSafe(path.join(runDir, 'run-state.json')) || {};
    updateRunRegistry(runId, {
      status: code === 0 ? 'completed' : (signal ? 'cancelled' : 'failed'),
      phase: code === 0 ? 'completed' : (signal ? 'cancelled' : 'error'),
      finishedAt: new Date().toISOString(),
      exitCode: code,
      signal: signal || '',
      currentSubtask: null,
    });
    if (!existingState || !existingState.status || existingState.status === 'running' || existingState.status === 'starting') {
      writeJsonFileSafe(path.join(runDir, 'run-state.json'), {
        ...existingState,
        runId,
        task,
        profile,
        collaborationMode,
        complexityMode: complexity,
        taskComplexity: hybridAgents.resolveTaskComplexity(task, complexity),
        requestedBy: existingState.requestedBy || requestedBy,
        status: code === 0 ? 'completed' : (signal ? 'cancelled' : 'failed'),
        phase: code === 0 ? 'completed' : (signal ? 'cancelled' : 'error'),
        startedAt: existingState.startedAt || new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        outputDir: path.relative(ROOT, runDir),
        error: code === 0 ? '' : `Process exited with code ${code}${signal ? ` (signal ${signal})` : ''}`,
      });
    }
    if (bridgeState.activeRunId === runId) bridgeState.activeRunId = '';
  });
  child.on('error', error => {
    stdoutStream.end();
    stderrStream.end();
    updateRunRegistry(runId, {
      status: 'failed',
      phase: 'error',
      finishedAt: new Date().toISOString(),
      error: error && error.message ? error.message : 'Failed to launch agent run.',
    });
    writeJsonFileSafe(path.join(runDir, 'run-state.json'), {
      runId,
      task,
      profile,
      collaborationMode,
      complexityMode: complexity,
      taskComplexity: hybridAgents.resolveTaskComplexity(task, complexity),
      requestedBy,
      status: 'failed',
      phase: 'error',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outputDir: path.relative(ROOT, runDir),
      error: error && error.message ? error.message : 'Failed to launch agent run.',
    });
    if (bridgeState.activeRunId === runId) bridgeState.activeRunId = '';
  });

  return { runId, task, profile, collaborationMode, complexityMode: complexity, pid: child.pid };
}

function cancelRun(runId) {
  const safeRunId = sanitizeRunId(runId);
  const record = bridgeState.runs[safeRunId];
  if (!record || !record.pid || record.status !== 'running') return false;
  try {
    process.kill(record.pid, 'SIGTERM');
    updateRunRegistry(safeRunId, { status: 'cancelling', phase: 'cancelling' });
    return true;
  } catch {
    return false;
  }
}

function sendJson(res, statusCode, payload, origin) {
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'false');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

function sendNoContent(res, origin) {
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'false');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  res.writeHead(204);
  res.end();
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk.toString('utf8');
      if (raw.length > 1024 * 1024) {
        reject(new Error('Body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function handleRequest(req, res) {
  const origin = String(req.headers.origin || '').trim();
  if (req.method === 'OPTIONS') {
    if (!isAllowedOrigin(origin)) {
      sendJson(res, 403, { ok: false, message: 'Origin not allowed.' }, origin);
      return;
    }
    sendNoContent(res, origin);
    return;
  }

  if (!isAllowedOrigin(origin)) {
    sendJson(res, 403, { ok: false, message: 'Origin not allowed.' }, origin);
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || `${DEFAULT_HOST}:${DEFAULT_PORT}`}`);
  const pathname = requestUrl.pathname;

  if (pathname === '/health' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      service: 'gp-link-agent-bridge',
      version: 1,
      cwd: ROOT,
      pid: process.pid,
      allowedOrigins: Array.from(ALLOWED_ORIGINS),
    }, origin);
    return;
  }

  if (pathname === '/api/admin/agent-control/status' && req.method === 'GET') {
    let providers;
    try {
      providers = await getCachedProviderStatus(requestUrl.searchParams.get('refresh') === 'true');
    } catch (error) {
      sendJson(res, 502, { ok: false, message: error && error.message ? error.message : 'Failed to inspect provider status.' }, origin);
      return;
    }
    const task = String(requestUrl.searchParams.get('task') || '').trim();
    const profile = String(requestUrl.searchParams.get('profile') || 'balanced').trim();
    const collaborationMode = String(requestUrl.searchParams.get('collaborationMode') || 'paired').trim();
    const complexityMode = String(requestUrl.searchParams.get('complexity') || 'auto').trim();
    sendJson(res, 200, {
      ok: true,
      refreshedAt: new Date().toISOString(),
      providers,
      dashboard: buildDashboardState(task, {
        profile,
        collaborationMode,
        complexityMode,
        providerStates: providers,
      }),
      connectCommands: {
        openai: 'codex login',
        anthropic: 'claude auth login',
        localBridge: 'npm run agent-bridge',
      },
      bridge: {
        connected: true,
        mode: 'local-bridge',
        baseUrl: `http://${server.address().address}:${server.address().port}`,
        host: server.address().address,
        port: server.address().port,
      },
    }, origin);
    return;
  }

  if (pathname === '/api/admin/agent-control/providers/refresh' && req.method === 'POST') {
    try {
      const providers = await getCachedProviderStatus(true);
      sendJson(res, 200, {
        ok: true,
        refreshedAt: new Date().toISOString(),
        providers,
      }, origin);
    } catch (error) {
      sendJson(res, 502, { ok: false, message: error && error.message ? error.message : 'Failed to refresh provider status.' }, origin);
    }
    return;
  }

  if (pathname === '/api/admin/agent-control/runs' && req.method === 'GET') {
    const limit = Math.max(1, Math.min(20, Number(requestUrl.searchParams.get('limit') || 12) || 12));
    sendJson(res, 200, { ok: true, runs: listRuns(limit), activeRunId: bridgeState.activeRunId || '' }, origin);
    return;
  }

  if (pathname === '/api/admin/agent-control/run' && req.method === 'GET') {
    const runId = sanitizeRunId(requestUrl.searchParams.get('id') || '');
    if (!runId) {
      sendJson(res, 400, { ok: false, message: 'Run id is required.' }, origin);
      return;
    }
    const run = getRunSummary(runId);
    if (!run) {
      sendJson(res, 404, { ok: false, message: 'Run not found.' }, origin);
      return;
    }
    sendJson(res, 200, { ok: true, run }, origin);
    return;
  }

  if (pathname === '/api/admin/agent-control/run' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' }, origin);
      return;
    }

    const task = typeof body.task === 'string' ? body.task.trim() : '';
    const profile = typeof body.profile === 'string' ? body.profile.trim() : 'balanced';
    const collaborationMode = typeof body.collaborationMode === 'string' ? body.collaborationMode.trim() : 'paired';
    const complexity = typeof body.complexity === 'string' ? body.complexity.trim() : 'auto';
    if (!task || task.length < 12) {
      sendJson(res, 400, { ok: false, message: 'Provide a more specific task for the agent.' }, origin);
      return;
    }
    if (task.length > 5000) {
      sendJson(res, 400, { ok: false, message: 'Task is too long. Keep it under 5000 characters.' }, origin);
      return;
    }

    let providers;
    try {
      providers = await getCachedProviderStatus(false);
    } catch (error) {
      sendJson(res, 502, { ok: false, message: error && error.message ? error.message : 'Unable to inspect provider state before launch.' }, origin);
      return;
    }
    const availableProviders = Object.values(providers).filter(state => state && state.available);
    if (!availableProviders.length) {
      sendJson(res, 409, { ok: false, message: 'Connect Codex and/or Claude on this Mac before starting a run.' }, origin);
      return;
    }

    try {
      const launched = startRun({
        task,
        profile,
        collaborationMode,
        complexity,
        requestedBy: 'Dashboard via local bridge',
      });
      sendJson(res, 201, {
        ok: true,
        run: launched,
        message: 'Agent run started via local bridge.',
        policy: hybridAgents.getModelPolicy(task, complexity, profile, collaborationMode),
        warning: collaborationMode === 'paired' && availableProviders.length < 2
          ? 'Only one provider is connected, so this run will execute in routed mode until both providers are available.'
          : '',
      }, origin);
    } catch (error) {
      sendJson(res, 409, { ok: false, message: error && error.message ? error.message : 'Unable to start agent run.' }, origin);
    }
    return;
  }

  if (pathname === '/api/admin/agent-control/run/cancel' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, message: 'Invalid request body.' }, origin);
      return;
    }
    const runId = sanitizeRunId(body && body.runId);
    if (!runId) {
      sendJson(res, 400, { ok: false, message: 'Run id is required.' }, origin);
      return;
    }
    const cancelled = cancelRun(runId);
    if (!cancelled) {
      sendJson(res, 409, { ok: false, message: 'Run is not currently cancellable.' }, origin);
      return;
    }
    sendJson(res, 200, { ok: true, runId, message: 'Cancellation requested.' }, origin);
    return;
  }

  sendJson(res, 404, { ok: false, message: 'Not found.' }, origin);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    const origin = String(req.headers.origin || '').trim();
    sendJson(res, 500, { ok: false, message: error && error.message ? error.message : 'Bridge error.' }, origin);
  });
});

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (options.help) {
  printHelp();
  process.exit(0);
}

server.listen(options.port, options.host, () => {
  ensureDir(AGENT_OUTPUT_ROOT);
  console.log('GP Link local hybrid-agent bridge');
  console.log(`Listening on http://${options.host}:${options.port}`);
  console.log(`Allowed origins: ${Array.from(ALLOWED_ORIGINS).join(', ')}`);
  console.log('Keep this running while using the live Agent dashboard.');
  getCachedProviderStatus(true)
    .then(() => {
      console.log('Provider status warm cache ready.');
    })
    .catch(error => {
      console.warn(`Provider status warm-up failed: ${error && error.message ? error.message : 'unknown error'}`);
    });
});
