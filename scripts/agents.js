#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ALLOWED_AGENTS = new Set([
  'frontend',
  'backend',
  'database',
  'research',
  'extrapolation',
  'review',
]);
const IGNORE_DIRS = new Set([
  '.git',
  '.next',
  'agents-output',
  'backups',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'app', 'are', 'be', 'build', 'by', 'can', 'create', 'data',
  'database', 'do', 'for', 'from', 'gp', 'gplink', 'how', 'if', 'in', 'into',
  'is', 'it', 'make', 'model', 'models', 'of', 'on', 'or', 'page', 'pages',
  'project', 'repo', 'that', 'the', 'this', 'to', 'use', 'using', 'with', 'your',
]);

// Load .env from project root if present.
(function loadDotEnv() {
  if (process.env.AGENT_SKIP_DOTENV === 'true') return;
  const envPath = path.join(ROOT, '.env');
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '');
      if (key && value && !process.env[key]) process.env[key] = value;
    }
  } catch {
    // No local .env file is fine.
  }
})();

const DEFAULTS = {
  profile: process.env.AGENT_PROFILE || 'balanced',
  collaborationMode: process.env.AGENT_COLLABORATION_MODE || 'paired',
  complexity: process.env.AGENT_COMPLEXITY_MODE || 'auto',
  enableClaudeBrowserUseMcp: process.env.AGENT_ENABLE_CLAUDE_BROWSER_USE_MCP !== 'false',
  claudeBrowserMcpName: process.env.CLAUDE_BROWSER_MCP_NAME || 'browser-use',
  openaiComplexModel: process.env.OPENAI_COMPLEX_MODEL || process.env.OPENAI_AGENT_MODEL || 'gpt-5.4',
  openaiStandardModel: process.env.OPENAI_STANDARD_MODEL || 'gpt-5.4-mini',
  openaiSimpleModel: process.env.OPENAI_SIMPLE_MODEL || process.env.OPENAI_STANDARD_MODEL || 'gpt-5.4-mini',
  openaiComplexReviewModel: process.env.OPENAI_COMPLEX_REVIEW_MODEL || process.env.OPENAI_REVIEW_MODEL || process.env.OPENAI_COMPLEX_MODEL || process.env.OPENAI_AGENT_MODEL || 'gpt-5.4',
  openaiStandardReviewModel: process.env.OPENAI_STANDARD_REVIEW_MODEL || process.env.OPENAI_REVIEW_MODEL || process.env.OPENAI_STANDARD_MODEL || 'gpt-5.4-mini',
  anthropicComplexModel: process.env.ANTHROPIC_COMPLEX_MODEL || process.env.ANTHROPIC_AGENT_MODEL || 'opus',
  anthropicStandardModel: process.env.ANTHROPIC_STANDARD_MODEL || process.env.ANTHROPIC_RESEARCH_MODEL || process.env.ANTHROPIC_AGENT_MODEL || 'sonnet',
  anthropicSimpleModel: process.env.ANTHROPIC_SIMPLE_MODEL || process.env.ANTHROPIC_STANDARD_MODEL || 'sonnet',
  codexCliPath: process.env.CODEX_CLI_PATH || '',
  claudeCliPath: process.env.CLAUDE_CLI_PATH || '',
  maxFileContextChars: numberFromEnv('AGENT_MAX_FILE_CONTEXT_CHARS', 24000),
  maxPlannerFiles: numberFromEnv('AGENT_MAX_PLANNER_FILES', 220),
  maxSubtasks: numberFromEnv('AGENT_MAX_SUBTASKS', 6),
  maxDependencyContextChars: numberFromEnv('AGENT_MAX_DEPENDENCY_CONTEXT_CHARS', 14000),
  maxSharedMemoryItems: numberFromEnv('AGENT_MAX_SHARED_MEMORY_ITEMS', 40),
};

const PROVIDER_RUNTIME = {
  openai: null,
  anthropic: null,
};

const PROFILE_ROLE_DEFAULTS = {
  balanced: {
    planner: 'anthropic',
    frontend: 'openai',
    backend: 'openai',
    database: 'anthropic',
    research: 'anthropic',
    extrapolation: 'anthropic',
    review: 'openai',
  },
  'codex-heavy': {
    planner: 'openai',
    frontend: 'openai',
    backend: 'openai',
    database: 'openai',
    research: 'anthropic',
    extrapolation: 'anthropic',
    review: 'anthropic',
  },
  'claude-heavy': {
    planner: 'anthropic',
    frontend: 'openai',
    backend: 'anthropic',
    database: 'anthropic',
    research: 'anthropic',
    extrapolation: 'anthropic',
    review: 'openai',
  },
};
const POLICY_ROLES = [
  'planner',
  'frontend',
  'backend',
  'database',
  'research',
  'extrapolation',
  'review',
];

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function slugify(value, fallback) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || fallback;
}

function truncateText(value, maxChars) {
  if (!value || value.length <= maxChars) return value || '';
  return `${value.slice(0, Math.max(0, maxChars - 20))}\n\n[truncated]`;
}

function isSafeRelativePath(relPath) {
  if (!relPath || typeof relPath !== 'string') return false;
  if (path.isAbsolute(relPath)) return false;
  const normalized = path.normalize(relPath);
  return normalized && !normalized.startsWith('..') && !normalized.includes(`..${path.sep}`);
}

function parseArgs(rawArgs) {
  const options = {
    task: '',
    apply: false,
    help: false,
    profile: DEFAULTS.profile,
    collaborationMode: DEFAULTS.collaborationMode,
    complexity: DEFAULTS.complexity,
    runId: '',
  };
  const positional = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--task') {
      options.task = rawArgs[i + 1] || '';
      i++;
    } else if (arg === '--profile') {
      options.profile = rawArgs[i + 1] || options.profile;
      i++;
    } else if (arg === '--collaboration') {
      options.collaborationMode = rawArgs[i + 1] || options.collaborationMode;
      i++;
    } else if (arg === '--complexity') {
      options.complexity = rawArgs[i + 1] || options.complexity;
      i++;
    } else if (arg === '--run-id') {
      options.runId = rawArgs[i + 1] || options.runId;
      i++;
    } else if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (!options.task) options.task = positional.join(' ').trim();
  options.profile = normalizeProfile(options.profile);
  options.collaborationMode = normalizeCollaborationMode(options.collaborationMode);
  options.complexity = normalizeComplexityMode(options.complexity);
  options.runId = normalizeRunId(options.runId);
  return options;
}

function normalizeProfile(profile) {
  return PROFILE_ROLE_DEFAULTS[profile] ? profile : 'balanced';
}

function normalizeCollaborationMode(mode) {
  return ['single', 'routed', 'paired'].includes(mode) ? mode : 'paired';
}

function normalizeComplexityMode(mode) {
  return ['auto', 'simple', 'standard', 'complex'].includes(mode) ? mode : 'auto';
}

function normalizeRunId(value) {
  if (!value) return '';
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function inferTaskComplexity(task) {
  const text = String(task || '').trim().toLowerCase();
  if (!text) return 'standard';

  let score = 0;
  const complexSignals = [
    'redesign', 'research', 'architecture', 'workflow', 'dashboard', 'publishable',
    'production', 'secure', 'security', 'full app', 'whole app', 'start to finish',
    'end to end', 'database', 'migration', 'multi-agent', 'orchestr', 'admin',
    'complex', 'audit', 'investigate', 'integration', 'refactor', 'rollout',
  ];
  const simpleSignals = [
    'typo', 'copy', 'label', 'rename', 'text only', 'small', 'minor', 'simple',
    'tiny', 'single button', 'single page', 'one field',
  ];
  const hardComplexSignals = [
    'research', 'architecture', 'workflow', 'publishable', 'production', 'secure',
    'security', 'full app', 'whole app', 'start to finish', 'end to end', 'migration',
    'multi-agent', 'orchestr', 'audit', 'investigate', 'integration', 'rollout',
  ];

  const hasSimpleSignal = simpleSignals.some(signal => text.includes(signal));
  const hasHardComplexSignal = hardComplexSignals.some(signal => text.includes(signal));
  if (hasSimpleSignal && text.length < 160 && !hasHardComplexSignal) return 'simple';

  complexSignals.forEach(signal => {
    if (text.includes(signal)) score += 2;
  });
  simpleSignals.forEach(signal => {
    if (text.includes(signal)) score -= 2;
  });

  if (text.length > 220) score += 2;
  if ((text.match(/\band\b/g) || []).length >= 3) score += 1;
  if ((text.match(/,/g) || []).length >= 4) score += 1;

  if (score >= 4) return 'complex';
  if (score <= -2) return 'simple';
  return 'standard';
}

function resolveTaskComplexity(task, mode) {
  return mode === 'auto' ? inferTaskComplexity(task) : mode;
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutableOnPath(name) {
  const result = spawnSync('/bin/bash', ['-lc', `command -v ${name}`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status === 0) {
    const resolved = String(result.stdout || '').trim().split('\n')[0];
    return resolved || '';
  }
  return '';
}

function findCodexExtensionBinary() {
  const extensionsDir = path.join(os.homedir(), '.vscode', 'extensions');
  try {
    const extensionDirs = fs.readdirSync(extensionsDir)
      .filter(name => name.startsWith('openai.chatgpt-'))
      .sort()
      .reverse();

    for (const dirName of extensionDirs) {
      const binDir = path.join(extensionsDir, dirName, 'bin');
      if (!fs.existsSync(binDir)) continue;
      for (const child of fs.readdirSync(binDir)) {
        const candidate = path.join(binDir, child, 'codex');
        if (fileExists(candidate)) return candidate;
      }
    }
  } catch {
    // Ignore lookup failures and keep scanning.
  }
  return '';
}

function resolveBinaryPath(provider) {
  if (provider === 'openai') {
    const candidates = [
      DEFAULTS.codexCliPath,
      findExecutableOnPath('codex'),
      findCodexExtensionBinary(),
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
    ];
    return candidates.find(fileExists) || '';
  }

  const candidates = [
    DEFAULTS.claudeCliPath,
    findExecutableOnPath('claude'),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  return candidates.find(fileExists) || '';
}

function parseCodexLoginStatusOutput(text) {
  const summary = String(text || '').trim();
  const lower = summary.toLowerCase();
  return {
    loggedIn: lower.includes('logged in'),
    usesSubscription: lower.includes('chatgpt'),
    summary,
  };
}

function parseClaudeAuthStatusOutput(text) {
  const parsed = parseJSON(text) || {};
  const authMethod = typeof parsed.authMethod === 'string' ? parsed.authMethod : '';
  const apiProvider = typeof parsed.apiProvider === 'string' ? parsed.apiProvider : '';
  const subscriptionType = typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : '';
  return {
    loggedIn: Boolean(parsed.loggedIn),
    usesSubscription: authMethod === 'claude.ai' && apiProvider === 'firstParty',
    authMethod,
    apiProvider,
    subscriptionType,
    summary: authMethod
      ? `${authMethod}${subscriptionType ? `/${subscriptionType}` : ''}`
      : 'unknown',
    raw: parsed,
  };
}

function parseClaudeMcpListOutput(text, targetName = DEFAULTS.claudeBrowserMcpName) {
  const lines = String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^checking mcp server health/i.test(line));

  const servers = lines
    .map(line => {
      const match = line.match(/^([^:]+):\s+(.+?)\s+-\s+(.+)$/);
      if (!match) return null;
      const [, name, target, statusText] = match;
      const normalizedStatus = statusText.toLowerCase();
      return {
        name: name.trim(),
        target: target.trim(),
        status: statusText.trim(),
        connected: normalizedStatus.includes('connected'),
        needsAuthentication: normalizedStatus.includes('needs authentication'),
      };
    })
    .filter(Boolean);

  const browserUse = servers.find(server => server.name === targetName) || null;
  return {
    servers,
    browserUse: browserUse
      ? {
          name: browserUse.name,
          target: browserUse.target,
          status: browserUse.status,
          available: browserUse.connected,
          needsAuthentication: browserUse.needsAuthentication,
        }
      : null,
  };
}

function inferBrowserUseNeed(text) {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) return false;
  const browserSignals = [
    'navigate',
    'walk through',
    'walkthrough',
    'browser',
    'browser-use',
    'computer',
    'click through',
    'clickthrough',
    'inspect ui',
    'ui flow',
    'take screenshot',
    'screenshots',
    'start to finish',
    'end to end',
    'first-time gp',
    'first time gp',
    'flow check',
    'test the app',
    'follow the process',
  ];
  return browserSignals.some(signal => normalized.includes(signal));
}

function shouldUseClaudeBrowserMcp(role, text) {
  if (!DEFAULTS.enableClaudeBrowserUseMcp) return false;
  if (!inferBrowserUseNeed(text)) return false;
  return ['planner', 'frontend', 'research', 'extrapolation', 'review'].includes(role);
}

function buildProviderEnv() {
  const env = { ...process.env };
  // Strip direct API credentials so the CLIs stay on subscription/OAuth auth.
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  return env;
}

function runCliCommand(binaryPath, args, { cwd = ROOT, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      cwd,
      env: buildProviderEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }

      const message = [
        `Command failed: ${binaryPath} ${args.join(' ')}`,
        `Exit code: ${code}`,
        stdout.trim() ? `stdout:\n${truncateText(stdout.trim(), 4000)}` : '',
        stderr.trim() ? `stderr:\n${truncateText(stderr.trim(), 4000)}` : '',
      ].filter(Boolean).join('\n\n');
      reject(new Error(message));
    });

    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

async function inspectProviders() {
  const openaiPath = resolveBinaryPath('openai');
  const anthropicPath = resolveBinaryPath('anthropic');

  const states = {
    openai: {
      provider: 'openai',
      label: 'Codex/OpenAI',
      binaryPath: openaiPath,
      available: false,
      authSummary: '',
      reason: '',
      mcp: null,
      browserUse: null,
    },
    anthropic: {
      provider: 'anthropic',
      label: 'Claude/Anthropic',
      binaryPath: anthropicPath,
      available: false,
      authSummary: '',
      reason: '',
      mcp: null,
      browserUse: null,
    },
  };

  if (!openaiPath) {
    states.openai.reason = 'codex CLI not found';
  } else {
    try {
      const result = await runCliCommand(openaiPath, ['login', 'status']);
      const status = parseCodexLoginStatusOutput(result.stdout || result.stderr);
      states.openai.authSummary = status.summary;
      if (status.loggedIn && status.usesSubscription) {
        states.openai.available = true;
      } else {
        states.openai.reason = status.loggedIn
          ? 'codex is not logged in with a ChatGPT subscription account'
          : 'codex is not logged in';
      }
    } catch (error) {
      states.openai.reason = error.message;
    }
  }

  if (!anthropicPath) {
    states.anthropic.reason = 'claude CLI not found';
  } else {
    try {
      const result = await runCliCommand(anthropicPath, ['auth', 'status']);
      const status = parseClaudeAuthStatusOutput(result.stdout);
      states.anthropic.authSummary = status.summary;
      if (status.loggedIn && status.usesSubscription) {
        states.anthropic.available = true;
        try {
          const mcpResult = await runCliCommand(anthropicPath, ['mcp', 'list']);
          const mcp = parseClaudeMcpListOutput(mcpResult.stdout);
          states.anthropic.mcp = mcp;
          states.anthropic.browserUse = mcp.browserUse;
        } catch (mcpError) {
          states.anthropic.mcp = { servers: [], browserUse: null, error: mcpError.message };
          states.anthropic.browserUse = null;
        }
      } else {
        states.anthropic.reason = status.loggedIn
          ? 'claude is not using claude.ai subscription auth'
          : 'claude is not logged in';
      }
    } catch (error) {
      states.anthropic.reason = error.message;
    }
  }

  PROVIDER_RUNTIME.openai = states.openai;
  PROVIDER_RUNTIME.anthropic = states.anthropic;

  return states;
}

function getReasoningEffort(role, complexity) {
  if (complexity === 'complex') return 'high';
  if (complexity === 'simple') return role === 'review' ? 'medium' : 'low';
  return role === 'review' ? 'medium' : 'medium';
}

function selectOpenAIModel(role, complexity) {
  if (complexity === 'complex') {
    return role === 'review' ? DEFAULTS.openaiComplexReviewModel : DEFAULTS.openaiComplexModel;
  }
  if (complexity === 'simple') {
    return role === 'review' ? DEFAULTS.openaiStandardReviewModel : DEFAULTS.openaiSimpleModel;
  }
  return role === 'review' ? DEFAULTS.openaiStandardReviewModel : DEFAULTS.openaiStandardModel;
}

function selectAnthropicModel(complexity) {
  if (complexity === 'complex') return DEFAULTS.anthropicComplexModel;
  if (complexity === 'simple') return DEFAULTS.anthropicSimpleModel;
  return DEFAULTS.anthropicStandardModel;
}

function buildProviderConfig(provider, role, complexity = 'standard') {
  if (provider === 'openai') {
    return {
      provider,
      model: selectOpenAIModel(role, complexity),
      label: 'Codex/OpenAI',
      reasoningEffort: getReasoningEffort(role, complexity),
      complexity,
    };
  }

  return {
    provider: 'anthropic',
    model: selectAnthropicModel(complexity),
    label: 'Claude/Anthropic',
    reasoningEffort: getReasoningEffort(role, complexity),
    complexity,
  };
}

function buildRolePolicy(profile, complexity) {
  const normalizedProfile = normalizeProfile(profile);
  const profileDefaults = PROFILE_ROLE_DEFAULTS[normalizedProfile] || PROFILE_ROLE_DEFAULTS.balanced;
  return POLICY_ROLES.map(role => {
    const preferredProvider = profileDefaults[role] || profileDefaults.review || 'openai';
    const config = buildProviderConfig(preferredProvider, role, complexity);
    return {
      role,
      provider: config.provider,
      providerLabel: config.label,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
    };
  });
}

function resolveProviderForRole(role, preferredProvider, profile, availableProviders) {
  if (preferredProvider && preferredProvider !== 'either' && availableProviders.includes(preferredProvider)) {
    return preferredProvider;
  }

  const profileDefaults = PROFILE_ROLE_DEFAULTS[profile] || PROFILE_ROLE_DEFAULTS.balanced;
  const ordered = uniq([
    profileDefaults[role],
    role === 'review' ? getAlternateProvider(profileDefaults[role]) : null,
    'openai',
    'anthropic',
  ]);

  return ordered.find(provider => availableProviders.includes(provider)) || availableProviders[0];
}

function getAlternateProvider(provider) {
  if (provider === 'openai') return 'anthropic';
  if (provider === 'anthropic') return 'openai';
  return null;
}

function resolveAssignment(subtask, options, availableProviders) {
  const primaryProvider = resolveProviderForRole(
    subtask.agent,
    subtask.modelPreference,
    options.profile,
    availableProviders
  );
  const primary = buildProviderConfig(primaryProvider, subtask.agent, options.taskComplexity || 'standard');

  let advisor = null;
  if (options.collaborationMode === 'paired' && subtask.agent !== 'review') {
    const advisorProvider = getAlternateProvider(primary.provider);
    if (advisorProvider && availableProviders.includes(advisorProvider)) {
      advisor = buildProviderConfig(advisorProvider, 'review', options.taskComplexity || 'standard');
    }
  }

  return { primary, advisor };
}

function listRepoFiles(dirPath = ROOT, prefix = '') {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.DS_Store')) continue;
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      output.push(...listRepoFiles(path.join(dirPath, entry.name), path.join(prefix, entry.name)));
      continue;
    }
    output.push(path.join(prefix, entry.name));
  }
  return output.sort();
}

function buildServerRouteIndex() {
  const content = readFileSafe(path.join(ROOT, 'server.js'));
  if (!content) return [];

  const matches = new Set();
  const patterns = [
    /pathname\s*===\s*['"`]([^'"`]+)['"`]/g,
    /pathname\.startsWith\(\s*['"`]([^'"`]+)['"`]/g,
    /pathname\.match\(\s*\/([^/]+)\//g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const route = match[1];
      if (route) matches.add(route);
    }
  }

  return [...matches].sort().slice(0, 120);
}

function readProjectOverview() {
  const claudeMd = readFileSafe(path.join(ROOT, 'CLAUDE.md')) || '';
  const packageJsonRaw = readFileSafe(path.join(ROOT, 'package.json')) || '{}';
  let packageJson = {};
  try {
    packageJson = JSON.parse(packageJsonRaw);
  } catch {
    packageJson = {};
  }

  const repoFiles = listRepoFiles().slice(0, DEFAULTS.maxPlannerFiles);
  const routeIndex = buildServerRouteIndex();
  const migrations = listRepoFiles(path.join(ROOT, 'supabase'), 'supabase')
    .filter(file => file.startsWith('supabase/migrations/') && file.endsWith('.sql'))
    .slice(-12);

  const packageSummary = JSON.stringify({
    name: packageJson.name,
    scripts: packageJson.scripts,
    dependencies: Object.keys(packageJson.dependencies || {}),
    devDependencies: Object.keys(packageJson.devDependencies || {}),
  }, null, 2);

  return [
    '## CLAUDE.md',
    claudeMd,
    '## package.json summary',
    `\`\`\`json\n${packageSummary}\n\`\`\``,
    '## Repo file index',
    repoFiles.map(file => `- ${file}`).join('\n'),
    '## server.js route index',
    routeIndex.length ? routeIndex.map(route => `- ${route}`).join('\n') : '- No route index found',
    '## Recent Supabase migrations',
    migrations.length ? migrations.map(file => `- ${file}`).join('\n') : '- No migrations found',
  ].join('\n\n');
}

function tokenize(text) {
  return uniq(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9_/-]+/)
      .map(token => token.trim())
      .filter(token => token.length >= 3 && !STOP_WORDS.has(token))
  );
}

function extractRelevantSections(content, query, maxChars) {
  if (!content || content.length <= maxChars) return content || '';

  const lines = content.split('\n');
  const tokens = tokenize(query).slice(0, 14);
  const hits = [];

  for (let index = 0; index < lines.length; index++) {
    const lower = lines[index].toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (lower.includes(token)) score++;
    }
    if (score > 0) hits.push({ index, score });
  }

  hits.sort((a, b) => b.score - a.score);

  const ranges = [];
  function addRange(start, end, score) {
    const safeStart = Math.max(0, start);
    const safeEnd = Math.min(lines.length - 1, end);
    const existing = ranges.find(range => !(safeEnd < range.start || safeStart > range.end));
    if (existing) {
      existing.start = Math.min(existing.start, safeStart);
      existing.end = Math.max(existing.end, safeEnd);
      existing.score = Math.max(existing.score, score);
      return;
    }
    ranges.push({ start: safeStart, end: safeEnd, score });
  }

  addRange(0, Math.min(34, lines.length - 1), 1);
  addRange(Math.max(0, lines.length - 35), lines.length - 1, 1);
  for (const hit of hits.slice(0, 8)) addRange(hit.index - 32, hit.index + 32, 10 + hit.score);

  const snippets = ranges.map(range => {
    const body = lines.slice(range.start, range.end + 1).join('\n');
    return {
      start: range.start,
      score: range.score,
      text: `// lines ${range.start + 1}-${range.end + 1}\n${body}`,
    };
  });

  const selected = [];
  let usedChars = 0;
  const separator = '\n\n/* --- next snippet --- */\n\n';
  for (const snippet of snippets.sort((a, b) => b.score - a.score || a.start - b.start)) {
    const extraChars = snippet.text.length + (selected.length ? separator.length : 0);
    if (!selected.length || usedChars + extraChars <= maxChars) {
      selected.push(snippet);
      usedChars += extraChars;
    }
  }

  selected.sort((a, b) => a.start - b.start);
  return truncateText(selected.map(snippet => snippet.text).join(separator), maxChars);
}

function buildSubtaskContext(subtask) {
  const taskFiles = uniq((subtask.files || []).filter(isSafeRelativePath)).slice(0, 10);
  if (!taskFiles.length) return 'No specific files were attached to this subtask.';

  const perFileBudget = Math.max(3500, Math.floor(DEFAULTS.maxFileContextChars / taskFiles.length));
  const query = `${subtask.title}\n${subtask.description}\n${taskFiles.join('\n')}`;

  const parts = [];
  for (const relPath of taskFiles) {
    const absPath = path.join(ROOT, relPath);
    const content = readFileSafe(absPath);
    if (!content) {
      parts.push(`### ${relPath}\n(file not found)`);
      continue;
    }
    const rendered = content.length <= perFileBudget
      ? content
      : extractRelevantSections(content, query, perFileBudget);
    const modeLabel = content.length <= perFileBudget ? 'FULL CONTENT' : 'FOCUSED SNIPPETS';
    parts.push(`### ${relPath} (${modeLabel})\n\`\`\`\n${rendered}\n\`\`\``);
  }

  return parts.join('\n\n');
}

function parseJSON(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) candidates.push(fenced[1].trim());

  const firstObject = extractBalancedBlock(trimmed, '{', '}');
  if (firstObject) candidates.push(firstObject);

  const firstArray = extractBalancedBlock(trimmed, '[', ']');
  if (firstArray) candidates.push(firstArray);

  for (const candidate of uniq(candidates)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function extractBalancedBlock(text, openChar, closeChar) {
  const startIndex = text.indexOf(openChar);
  if (startIndex === -1) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === openChar) depth++;
    if (char === closeChar) {
      depth--;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }

  return '';
}

async function callProvider(config, systemPrompt, userMessage, options = {}) {
  if (config.provider === 'openai') {
    return callCodexCli(config, systemPrompt, userMessage, options);
  }
  return callClaudeCli(config, systemPrompt, userMessage, options);
}

function requireProviderRuntime(provider) {
  const runtime = PROVIDER_RUNTIME[provider];
  if (!runtime || !runtime.available || !runtime.binaryPath) {
    throw new Error(`Provider ${provider} is not available for subscription-backed CLI execution.`);
  }
  return runtime;
}

function buildLeadSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'assumptions', 'subtasks'],
    properties: {
      summary: { type: 'string' },
      assumptions: {
        type: 'array',
        items: { type: 'string' },
      },
      subtasks: {
        type: 'array',
        maxItems: DEFAULTS.maxSubtasks,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['agent', 'id', 'title', 'description', 'files', 'dependsOn', 'modelPreference'],
          properties: {
            agent: { type: 'string', enum: [...ALLOWED_AGENTS] },
            id: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } },
            dependsOn: { type: 'array', items: { type: 'string' } },
            modelPreference: { type: 'string', enum: ['openai', 'anthropic', 'either'] },
          },
        },
      },
    },
  };
}

function buildImplementationSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'files', 'sharedContext', 'handoff', 'notes'],
    properties: {
      summary: { type: 'string' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'action', 'description'],
          properties: {
            path: { type: 'string' },
            action: { type: 'string', enum: ['edit', 'create'] },
            description: { type: 'string' },
            changes: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['description', 'find', 'replace'],
                properties: {
                  description: { type: 'string' },
                  find: { type: 'string' },
                  replace: { type: 'string' },
                },
              },
            },
            fullContent: { type: 'string' },
          },
        },
      },
      sharedContext: { type: 'array', items: { type: 'string' } },
      handoff: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
    },
  };
}

function buildResearchSchema(role) {
  const listField = role === 'research' ? 'findings' : 'risks';
  const itemProperties = role === 'research'
    ? {
        title: { type: 'string' },
        detail: { type: 'string' },
        impact: { type: 'string' },
      }
    : {
        title: { type: 'string' },
        detail: { type: 'string' },
        mitigation: { type: 'string' },
      };

  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', listField, 'recommendations', 'fileSuggestions', 'sharedContext', 'notes'],
    properties: {
      summary: { type: 'string' },
      [listField]: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: Object.keys(itemProperties),
          properties: itemProperties,
        },
      },
      recommendations: { type: 'array', items: { type: 'string' } },
      fileSuggestions: { type: 'array', items: { type: 'string' } },
      sharedContext: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
    },
  };
}

function buildReviewSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['approved', 'summary', 'issues', 'sharedContext'],
    properties: {
      approved: { type: 'boolean' },
      summary: { type: 'string' },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['severity', 'file', 'description', 'fix'],
          properties: {
            severity: { type: 'string', enum: ['critical', 'warning', 'suggestion'] },
            file: { type: 'string' },
            description: { type: 'string' },
            fix: { type: 'string' },
          },
        },
      },
      sharedContext: { type: 'array', items: { type: 'string' } },
    },
  };
}

function buildAdvisorSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['approved', 'issues', 'sharedContext', 'notes'],
    properties: {
      approved: { type: 'boolean' },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['severity', 'description', 'fix'],
          properties: {
            severity: { type: 'string', enum: ['critical', 'warning', 'suggestion'] },
            description: { type: 'string' },
            fix: { type: 'string' },
          },
        },
      },
      sharedContext: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
    },
  };
}

function parseCodexJsonl(stdout) {
  const lines = String(stdout || '').split('\n').map(line => line.trim()).filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Ignore non-JSON log lines.
    }
  }
  return events;
}

async function callCodexCli(config, systemPrompt, userMessage, options = {}) {
  const runtime = requireProviderRuntime('openai');
  const label = options.label || 'Codex';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-link-codex-'));
  const schemaPath = path.join(tempDir, 'schema.json');
  const outputPath = path.join(tempDir, 'last-message.json');
  const prompt = `SYSTEM INSTRUCTIONS:\n${systemPrompt}\n\nUSER REQUEST:\n${userMessage}\n\nReturn JSON only.`;
  const schema = options.schema || { type: 'object' };

  fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2), 'utf8');
  process.stdout.write(`  [${label}] ${config.model} via ${runtime.label} CLI...`);

  try {
    const args = [
      'exec',
      '--cd', ROOT,
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--ephemeral',
      '--model', config.model,
      '--json',
      '--output-schema', schemaPath,
      '--output-last-message', outputPath,
      '-',
    ];
    const result = await runCliCommand(runtime.binaryPath, args, { cwd: ROOT, input: prompt });
    const raw = readFileSafe(outputPath) || '';
    const events = parseCodexJsonl(result.stdout);
    const usageEvent = [...events].reverse().find(event => event.type === 'turn.completed');
    const fallbackMessageEvent = [...events].reverse().find(event => event.type === 'item.completed' && event.item && event.item.type === 'agent_message');
    const text = raw.trim() || String(fallbackMessageEvent?.item?.text || '').trim();
    process.stdout.write(` done (${text.length} chars)\n`);
    return {
      provider: config.provider,
      model: config.model,
      raw: text,
      parsed: parseJSON(text),
      usage: usageEvent?.usage || {},
      meta: {
        authSummary: runtime.authSummary,
        binaryPath: runtime.binaryPath,
      },
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function callClaudeCli(config, systemPrompt, userMessage, options = {}) {
  const runtime = requireProviderRuntime('anthropic');
  const label = options.label || 'Claude';
  const schema = options.schema || { type: 'object' };
  const browserUseEnabled = Boolean(
    options.enableBrowserUseMcp &&
    runtime.browserUse &&
    runtime.browserUse.available
  );
  const browserUsePrompt = browserUseEnabled
    ? `\n\nTooling note:\n- The Claude MCP server "${runtime.browserUse.name}" is available for browser/computer navigation.\n- Use it when it materially helps inspect the local app, browser flow, or on-machine UI state.\n- Do not use browser/computer tooling for repo-only reasoning tasks.`
    : '';

  process.stdout.write(`  [${label}] ${config.model} via ${runtime.label} CLI${browserUseEnabled ? ' + browser-use MCP' : ''}...`);
  const args = [
    '--print',
    '--output-format', 'json',
    '--permission-mode', 'bypassPermissions',
    '--no-session-persistence',
    '--model', config.model,
    '--system-prompt', `${systemPrompt}${browserUsePrompt}\n\nReturn JSON only.`,
    '--json-schema', JSON.stringify(schema),
    userMessage,
  ];
  const result = await runCliCommand(runtime.binaryPath, args, { cwd: ROOT });
  const payload = parseJSON(result.stdout) || {};
  const structured = payload.structured_output || parseJSON(payload.result || '') || {};
  const raw = JSON.stringify(structured, null, 2);
  process.stdout.write(` done (${raw.length} chars)\n`);
  return {
    provider: config.provider,
    model: config.model,
    raw,
    parsed: structured,
    usage: payload.usage || {},
    meta: {
      authSummary: runtime.authSummary,
      binaryPath: runtime.binaryPath,
      browserUseEnabled,
    },
  };
}

function buildLeadSystemPrompt(options, availableProviders) {
  return `You are the lead planner for a hybrid Codex + Claude coding workflow.

Available specialist roles:
- frontend: pages/, app/, components/, CSS, UI polish, client-side flows
- backend: server.js, API routes, auth, integrations, request/response logic
- database: supabase/migrations/, schema, RLS policies, data shape changes
- research: repo investigation, implementation notes, file targeting, uncertainty reduction
- extrapolation: edge cases, missing states, rollout considerations, testing implications
- review: bug/risk review that checks the other agents' output

Available providers right now: ${availableProviders.join(', ')}
Requested routing profile: ${options.profile}
Collaboration mode: ${options.collaborationMode}

Routing heuristics:
- Prefer OpenAI/Codex for hands-on frontend/backend coding when available.
- Prefer Claude for research, extrapolation, and database reasoning when available.
- If the task involves navigating the local app, browser, or computer, prefer a Claude research/extrapolation pass when browser-use MCP is connected.
- Use "modelPreference" only when a role clearly benefits from one provider.
- Keep the plan lean. Use at most ${DEFAULTS.maxSubtasks} subtasks including review.
- Review should always be the final subtask and depend on every non-review subtask.

Return JSON only:
{
  "summary": "one-sentence summary",
  "assumptions": ["optional assumption"],
  "subtasks": [
    {
      "agent": "frontend" | "backend" | "database" | "research" | "extrapolation" | "review",
      "id": "short-kebab-id",
      "title": "short title",
      "description": "exactly what this specialist should produce",
      "files": ["repo-relative paths only"],
      "dependsOn": ["subtask ids"],
      "modelPreference": "openai" | "anthropic" | "either"
    }
  ]
}`;
}

function buildImplementationSchemaDoc() {
  return `Return JSON only:
{
  "summary": "what you changed",
  "files": [
    {
      "path": "repo-relative/path.ext",
      "action": "edit" | "create",
      "description": "why this file changes",
      "changes": [
        {
          "description": "what this replacement does",
          "find": "exact text to replace",
          "replace": "replacement text"
        }
      ],
      "fullContent": "complete file content for created files only"
    }
  ],
  "sharedContext": ["important facts for later agents"],
  "handoff": ["follow-up notes for downstream agents"],
  "notes": "anything that needs manual verification"
}

Rules:
- For edit actions, every "find" string must match the provided file content exactly.
- For create actions, include "fullContent" and omit "changes".
- Only reference files that exist in the repo unless you are creating a new one.
- Do not wrap the JSON in markdown fences.`;
}

function buildResearchSchemaDoc(role) {
  const roleSpecificField = role === 'research' ? 'findings' : 'risks';
  const itemShape = role === 'research'
    ? '{ "title": "finding", "detail": "what you learned", "impact": "why it matters" }'
    : '{ "title": "risk or extrapolated concern", "detail": "what could break or be missing", "mitigation": "how to reduce it" }';

  return `Return JSON only:
{
  "summary": "short overview",
  "${roleSpecificField}": [${itemShape}],
  "recommendations": ["next step or implementation advice"],
  "fileSuggestions": ["repo-relative file path"],
  "sharedContext": ["facts later agents should keep in mind"],
  "notes": "optional note"
}`;
}

function buildReviewSchemaDoc() {
  return `Return JSON only:
{
  "approved": true | false,
  "summary": "1-2 sentence assessment",
  "issues": [
    {
      "severity": "critical" | "warning" | "suggestion",
      "file": "repo-relative/path.ext or (general)",
      "description": "what is wrong or risky",
      "fix": "specific fix"
    }
  ],
  "sharedContext": ["important cross-model conclusions"]
}`;
}

function buildSystemPromptForRole(role) {
  if (role === 'frontend') {
    return `You are the frontend specialist for GP Link.

Constraints:
- Follow the repo's existing design patterns and vanilla HTML/JS conventions when working in /pages or /js.
- For React/Next files under /app or /components, preserve the established component style.
- Prefer precise, minimal edits over sweeping rewrites.
- Keep accessibility and mobile behavior in mind.

${buildImplementationSchemaDoc()}`;
  }

  if (role === 'backend') {
    return `You are the backend specialist for GP Link.

Constraints:
- server.js uses native Node.js HTTP routing, not Express.
- Protected routes must verify auth before reading or mutating user data.
- Always validate inputs server-side.
- Never log secrets or return stack traces to the client.
- If you touch integrations or auth flows, call out manual verification steps in notes.

${buildImplementationSchemaDoc()}`;
  }

  if (role === 'database') {
    return `You are the database specialist for GP Link.

Constraints:
- Supabase is the production database.
- Prefer additive migrations.
- Enable and maintain Row Level Security when creating or changing tables.
- If schema changes require corresponding backend updates, note that clearly in handoff.
- Do not invent tables or policies without grounding them in the task.

${buildImplementationSchemaDoc()}`;
  }

  if (role === 'research' || role === 'extrapolation') {
    return `You are the ${role} specialist for GP Link.

Constraints:
- Work from the repository context only.
- Be concrete about which files, flows, or interfaces are implicated.
- Flag uncertainty instead of pretending missing details are known.

${buildResearchSchemaDoc(role)}`;
  }

  return `You are the cross-model review specialist for GP Link.

Review focus:
- bugs, regressions, and broken assumptions
- auth, security, or data integrity gaps
- missing edge cases, tests, or rollout considerations
- inconsistencies between frontend, backend, and database workstreams

${buildReviewSchemaDoc()}`;
}

function formatSharedMemory(sharedMemoryItems) {
  const items = sharedMemoryItems.slice(0, DEFAULTS.maxSharedMemoryItems);
  if (!items.length) return 'No shared memory has been accumulated yet.';
  return items.map(item => `- ${item}`).join('\n');
}

function collectParsedInsights(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];

  const insights = [];
  if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
    insights.push(parsed.summary.trim());
  }
  if (Array.isArray(parsed.sharedContext)) {
    insights.push(...parsed.sharedContext.filter(value => typeof value === 'string'));
  }
  if (Array.isArray(parsed.handoff)) {
    insights.push(...parsed.handoff.filter(value => typeof value === 'string'));
  }
  if (Array.isArray(parsed.recommendations)) {
    insights.push(...parsed.recommendations.filter(value => typeof value === 'string').slice(0, 4));
  }
  if (Array.isArray(parsed.findings)) {
    insights.push(...parsed.findings.map(item => {
      if (!item || typeof item !== 'object') return '';
      return `${item.title || 'Finding'}: ${item.impact || item.detail || ''}`.trim();
    }));
  }
  if (Array.isArray(parsed.risks)) {
    insights.push(...parsed.risks.map(item => {
      if (!item || typeof item !== 'object') return '';
      return `${item.title || 'Risk'}: ${item.mitigation || item.detail || ''}`.trim();
    }));
  }
  if (Array.isArray(parsed.issues)) {
    insights.push(...parsed.issues.map(item => {
      if (!item || typeof item !== 'object') return '';
      return `${item.severity || 'issue'} - ${item.description || ''}`.trim();
    }));
  }

  return uniq(
    insights
      .map(item => String(item || '').trim())
      .filter(Boolean)
      .map(item => item.replace(/\s+/g, ' '))
  ).slice(0, 10);
}

function buildContextSummary(subtask, assignment, primaryResult, advisorResult) {
  const lines = [
    `[${subtask.id}] ${subtask.title}`,
    `Role: ${subtask.agent}`,
    `Primary: ${assignment.primary.label} (${assignment.primary.model})`,
  ];

  const primaryInsights = collectParsedInsights(primaryResult.parsed);
  if (primaryInsights.length) {
    lines.push('Primary insights:');
    lines.push(...primaryInsights.map(item => `- ${item}`));
  } else {
    lines.push(`Primary raw excerpt: ${truncateText(primaryResult.raw, 500)}`);
  }

  if (advisorResult) {
    lines.push(`Advisor: ${assignment.advisor.label} (${assignment.advisor.model})`);
    const advisorInsights = collectParsedInsights(advisorResult.parsed);
    if (advisorInsights.length) {
      lines.push('Advisor insights:');
      lines.push(...advisorInsights.map(item => `- ${item}`));
    } else {
      lines.push(`Advisor raw excerpt: ${truncateText(advisorResult.raw, 350)}`);
    }
  }

  return lines.join('\n');
}

function renderDependencyContext(dependencyRecords) {
  if (!dependencyRecords.length) return 'No dependency handoff context.';
  const joined = dependencyRecords.map(record => record.contextSummary).join('\n\n');
  return truncateText(joined, DEFAULTS.maxDependencyContextChars);
}

async function leadAgent(task, projectOverview, options, availableProviders) {
  const plannerProvider = resolveProviderForRole(
    'planner',
    'either',
    options.profile,
    availableProviders
  );
  const plannerConfig = buildProviderConfig(plannerProvider, 'planner', options.taskComplexity || 'standard');
  const systemPrompt = buildLeadSystemPrompt(options, availableProviders);
  const userMessage = [
    `Task: ${task}`,
    '',
    'Project overview:',
    projectOverview,
  ].join('\n');

  const result = await callProvider(plannerConfig, systemPrompt, userMessage, {
    label: 'Planner',
    maxTokens: 4096,
    schema: buildLeadSchema(),
    enableBrowserUseMcp: shouldUseClaudeBrowserMcp('planner', task),
  });

  const plan = normalizePlan(result.parsed, task);
  return { plan, plannerConfig, raw: result.raw };
}

function normalizePlan(parsedPlan, task) {
  const source = parsedPlan && typeof parsedPlan === 'object' ? parsedPlan : {};
  const summary = typeof source.summary === 'string' && source.summary.trim()
    ? source.summary.trim()
    : `Implement a hybrid agent workflow for: ${task}`;

  const assumptions = Array.isArray(source.assumptions)
    ? source.assumptions.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
    : [];

  const rawSubtasks = Array.isArray(source.subtasks) ? source.subtasks : [];
  const cleaned = rawSubtasks.map((subtask, index) => {
    if (!subtask || typeof subtask !== 'object') return null;
    const fallbackId = `step-${index + 1}`;
    const agent = ALLOWED_AGENTS.has(subtask.agent) ? subtask.agent : 'research';
    return {
      agent,
      id: slugify(subtask.id || subtask.title, fallbackId),
      title: String(subtask.title || `Step ${index + 1}`).trim(),
      description: String(subtask.description || subtask.title || `Handle ${agent} work`).trim(),
      files: uniq(Array.isArray(subtask.files) ? subtask.files.filter(isSafeRelativePath) : []),
      dependsOn: uniq(Array.isArray(subtask.dependsOn) ? subtask.dependsOn.map(item => slugify(item, '')).filter(Boolean) : []),
      modelPreference: ['openai', 'anthropic', 'either'].includes(subtask.modelPreference)
        ? subtask.modelPreference
        : 'either',
    };
  }).filter(Boolean);

  const dedupedById = [];
  const seenIds = new Set();
  for (const subtask of cleaned) {
    if (seenIds.has(subtask.id)) continue;
    seenIds.add(subtask.id);
    dedupedById.push(subtask);
  }

  const maxNonReview = Math.max(1, DEFAULTS.maxSubtasks - 1);
  const nonReview = dedupedById.filter(subtask => subtask.agent !== 'review').slice(0, maxNonReview);
  const validIds = new Set(nonReview.map(subtask => subtask.id));
  for (const subtask of nonReview) {
    subtask.dependsOn = subtask.dependsOn.filter(dep => dep !== subtask.id && validIds.has(dep));
  }

  let review = dedupedById.find(subtask => subtask.agent === 'review');
  if (!review) {
    review = {
      agent: 'review',
      id: 'cross-model-review',
      title: 'Cross-model review',
      description: 'Review all prior agent outputs for bugs, contradictions, security issues, and missing follow-up work.',
      files: [],
      dependsOn: [],
      modelPreference: 'either',
    };
  }

  review.dependsOn = nonReview.map(subtask => subtask.id);
  review.files = uniq(Array.isArray(review.files) ? review.files.filter(isSafeRelativePath) : []);
  review.modelPreference = ['openai', 'anthropic', 'either'].includes(review.modelPreference)
    ? review.modelPreference
    : 'either';

  const subtasks = nonReview.length ? [...nonReview, review] : [review];
  return { summary, assumptions, subtasks };
}

async function runSpecialist(subtask, assignment, projectOverview, sharedMemoryItems, dependencyRecords) {
  const systemPrompt = buildSystemPromptForRole(subtask.agent);
  const dependencyContext = renderDependencyContext(dependencyRecords);
  const fileContext = buildSubtaskContext(subtask);
  const browserUseContext = [
    subtask.title,
    subtask.description,
    subtask.files.join(' '),
  ].join('\n');
  const userMessage = [
    `Subtask: ${subtask.title}`,
    subtask.description,
    '',
    'Project overview:',
    projectOverview,
    '',
    'Shared memory from completed workstreams:',
    formatSharedMemory(sharedMemoryItems),
    '',
    'Dependency handoff context:',
    dependencyContext,
    '',
    `Files requested by the planner: ${subtask.files.length ? subtask.files.join(', ') : '(none specified)'}`,
    '',
    'Relevant file context:',
    fileContext,
  ].join('\n');

  return callProvider(assignment.primary, systemPrompt, userMessage, {
    label: `${subtask.agent}:${subtask.id}`,
    maxTokens: subtask.agent === 'review' ? 4096 : 8192,
    enableBrowserUseMcp: shouldUseClaudeBrowserMcp(subtask.agent, browserUseContext),
    schema: subtask.agent === 'review'
      ? buildReviewSchema()
      : subtask.agent === 'research' || subtask.agent === 'extrapolation'
        ? buildResearchSchema(subtask.agent)
        : buildImplementationSchema(),
  });
}

function buildAdvisorPrompt(subtask) {
  return `You are the counterpart advisor in a dual-model workflow.

Another model has already completed this subtask. Your job is to pressure-test it, not to rewrite it from scratch.

Review for:
- bad assumptions
- incorrect file targeting
- missing edge cases
- auth/security/data integrity gaps
- cross-model handoff notes the next agent should know

Return JSON only:
{
  "approved": true | false,
  "issues": [
    {
      "severity": "critical" | "warning" | "suggestion",
      "description": "what is risky or missing",
      "fix": "specific improvement"
    }
  ],
  "sharedContext": ["important insight for later agents"],
  "notes": "optional short note"
}`;
}

async function runAdvisor(subtask, assignment, primaryResult, projectOverview, sharedMemoryItems, dependencyRecords) {
  if (!assignment.advisor) return null;

  const dependencyContext = renderDependencyContext(dependencyRecords);
  const userMessage = [
    `Subtask: ${subtask.title}`,
    subtask.description,
    '',
    'Project overview:',
    truncateText(projectOverview, 10000),
    '',
    'Shared memory from completed workstreams:',
    formatSharedMemory(sharedMemoryItems),
    '',
    'Dependency handoff context:',
    dependencyContext,
    '',
    'Primary agent output to review:',
    primaryResult.raw,
  ].join('\n');

  return callProvider(assignment.advisor, buildAdvisorPrompt(subtask), userMessage, {
    label: `advisor:${subtask.id}`,
    maxTokens: 4096,
    enableBrowserUseMcp: shouldUseClaudeBrowserMcp('review', `${subtask.title}\n${subtask.description}`),
    schema: buildAdvisorSchema(),
  });
}

function saveRawOutput(outputDir, fileName, contents) {
  const absPath = path.join(outputDir, 'raw', fileName);
  ensureDir(path.dirname(absPath));
  fs.writeFileSync(absPath, contents, 'utf8');
}

function writeRunState(outputDir, state) {
  if (!outputDir) return;
  fs.writeFileSync(path.join(outputDir, 'run-state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function getModelPolicy(
  task = '',
  complexityMode = DEFAULTS.complexity,
  profile = DEFAULTS.profile,
  collaborationMode = DEFAULTS.collaborationMode
) {
  const normalizedComplexityMode = normalizeComplexityMode(complexityMode);
  const normalizedProfile = normalizeProfile(profile);
  const normalizedCollaborationMode = normalizeCollaborationMode(collaborationMode);
  const taskComplexity = resolveTaskComplexity(task, normalizedComplexityMode);
  const roleAssignments = buildRolePolicy(normalizedProfile, taskComplexity);
  const browserUseRecommended = inferBrowserUseNeed(task);

  const notes = [];
  if (taskComplexity === 'complex') {
    notes.push('Complex redesign, architecture, and research work escalates to GPT-5.4 and Opus-class routing.');
  } else if (taskComplexity === 'simple') {
    notes.push('Simple work stays on lighter models by default to save capacity while keeping review safety in place.');
  } else {
    notes.push('Standard work stays on the middle tier unless you force `--complexity complex`.');
  }
  if (normalizedCollaborationMode === 'paired') {
    notes.push('Paired mode adds a second-model advisor pass whenever both Codex and Claude are connected.');
  } else if (normalizedCollaborationMode === 'routed') {
    notes.push('Routed mode sends each subtask to the best-matched provider without a second-model critique pass.');
  } else {
    notes.push('Single mode keeps the workflow lean by skipping cross-model advisor passes.');
  }
  if (browserUseRecommended) {
    notes.push('This task looks like a browser/computer walkthrough, so Claude browser-use MCP should be preferred when connected.');
  }
  notes.push('Lower-tier defaults can be overridden with environment variables if you want stricter or cheaper routing.');

  return {
    profile: normalizedProfile,
    collaborationMode: normalizedCollaborationMode,
    complexityMode: normalizedComplexityMode,
    taskComplexity,
    capabilities: {
      browserUseRecommended,
      browserUseEnabled: DEFAULTS.enableClaudeBrowserUseMcp,
    },
    selected: {
      openaiPrimary: selectOpenAIModel('frontend', taskComplexity),
      openaiReview: selectOpenAIModel('review', taskComplexity),
      anthropicPrimary: selectAnthropicModel(taskComplexity),
    },
    openai: {
      complex: DEFAULTS.openaiComplexModel,
      standard: DEFAULTS.openaiStandardModel,
      simple: DEFAULTS.openaiSimpleModel,
    },
    anthropic: {
      complex: DEFAULTS.anthropicComplexModel,
      standard: DEFAULTS.anthropicStandardModel,
      simple: DEFAULTS.anthropicSimpleModel,
    },
    roleAssignments,
    notes,
  };
}

function summarizeProviderStates(providerStates) {
  return Object.values(providerStates).map(state => ({
    provider: state.provider,
    label: state.label,
    available: state.available,
    authSummary: state.authSummary,
    reason: state.reason,
    binaryPath: state.binaryPath,
    browserUse: state.browserUse || null,
  }));
}

function applyFileChanges(fileSpec, outputDir, apply) {
  if (!fileSpec || typeof fileSpec !== 'object' || !isSafeRelativePath(fileSpec.path)) {
    return { path: fileSpec && fileSpec.path ? fileSpec.path : '(invalid)', status: 'skipped', reason: 'invalid path' };
  }

  const sourcePath = path.join(ROOT, fileSpec.path);
  const artifactPath = path.join(outputDir, 'artifacts', fileSpec.path);
  ensureDir(path.dirname(artifactPath));

  if (fileSpec.action === 'create' && typeof fileSpec.fullContent === 'string') {
    fs.writeFileSync(`${artifactPath}.new`, fileSpec.fullContent, 'utf8');
    if (apply) {
      ensureDir(path.dirname(sourcePath));
      fs.writeFileSync(sourcePath, fileSpec.fullContent, 'utf8');
      return { path: fileSpec.path, status: 'created', reason: 'file written' };
    }
    return { path: fileSpec.path, status: 'staged', reason: 'review .new artifact before applying' };
  }

  if (fileSpec.action === 'edit' && Array.isArray(fileSpec.changes)) {
    const original = readFileSafe(sourcePath);
    if (original == null) {
      return { path: fileSpec.path, status: 'skipped', reason: 'source file not found' };
    }

    let updated = original;
    let matched = 0;
    for (const change of fileSpec.changes) {
      if (!change || typeof change.find !== 'string' || typeof change.replace !== 'string') continue;
      if (!updated.includes(change.find)) continue;
      updated = updated.replace(change.find, change.replace);
      matched++;
    }

    fs.writeFileSync(`${artifactPath}.patched`, updated, 'utf8');
    if (matched !== fileSpec.changes.length) {
      return {
        path: fileSpec.path,
        status: 'partial',
        reason: `${matched}/${fileSpec.changes.length} changes matched; patched artifact written for review`,
      };
    }

    if (apply) {
      fs.writeFileSync(sourcePath, updated, 'utf8');
      return { path: fileSpec.path, status: 'applied', reason: 'all changes matched and were written' };
    }

    return { path: fileSpec.path, status: 'staged', reason: 'patched artifact written' };
  }

  return { path: fileSpec.path, status: 'skipped', reason: 'unsupported file action' };
}

async function executeSubtask(subtask, assignment, projectOverview, sharedMemoryItems, dependencyRecords, outputDir, apply) {
  const primaryResult = await runSpecialist(subtask, assignment, projectOverview, sharedMemoryItems, dependencyRecords);
  saveRawOutput(outputDir, `${subtask.id}_${subtask.agent}_${assignment.primary.provider}.md`, primaryResult.raw);

  let advisorResult = null;
  if (assignment.advisor) {
    advisorResult = await runAdvisor(subtask, assignment, primaryResult, projectOverview, sharedMemoryItems, dependencyRecords);
    saveRawOutput(outputDir, `${subtask.id}_${subtask.agent}_${assignment.advisor.provider}_advisor.md`, advisorResult.raw);
  }

  const applyResults = [];
  if (primaryResult.parsed && Array.isArray(primaryResult.parsed.files)) {
    for (const fileSpec of primaryResult.parsed.files) {
      applyResults.push(applyFileChanges(fileSpec, outputDir, apply));
    }
  }

  return {
    primaryResult,
    advisorResult,
    applyResults,
    contextSummary: buildContextSummary(subtask, assignment, primaryResult, advisorResult),
  };
}

function printHelp() {
  console.log(`Hybrid GP Link agent orchestrator

Usage:
  node scripts/agents.js "your task"
  node scripts/agents.js --task "your task" --profile balanced --collaboration paired
  npm run agents -- "your task"

Flags:
  --task <text>              Task to execute
  --profile <name>           balanced | codex-heavy | claude-heavy
  --collaboration <mode>     single | routed | paired
  --complexity <mode>        auto | simple | standard | complex
  --run-id <id>              Optional explicit output folder name / run id
  --apply                    Write fully-matched edits back into the repo
  --help                     Show this message

Environment:
  CODEX_CLI_PATH             Optional absolute path to the codex CLI
  CLAUDE_CLI_PATH            Optional absolute path to the claude CLI
  OPENAI_COMPLEX_MODEL       Default: ${DEFAULTS.openaiComplexModel}
  OPENAI_STANDARD_MODEL      Default: ${DEFAULTS.openaiStandardModel}
  OPENAI_SIMPLE_MODEL        Default: ${DEFAULTS.openaiSimpleModel}
  ANTHROPIC_COMPLEX_MODEL    Default: ${DEFAULTS.anthropicComplexModel}
  ANTHROPIC_STANDARD_MODEL   Default: ${DEFAULTS.anthropicStandardModel}
  ANTHROPIC_SIMPLE_MODEL     Default: ${DEFAULTS.anthropicSimpleModel}
  AGENT_ENABLE_CLAUDE_BROWSER_USE_MCP  Default: ${DEFAULTS.enableClaudeBrowserUseMcp}
  CLAUDE_BROWSER_MCP_NAME   Default: ${DEFAULTS.claudeBrowserMcpName}
  AGENT_PROFILE              Default: ${DEFAULTS.profile}
  AGENT_COLLABORATION_MODE   Default: ${DEFAULTS.collaborationMode}
  AGENT_COMPLEXITY_MODE      Default: ${DEFAULTS.complexity}

Notes:
  This runner uses local subscription-backed CLIs, not direct API calls.
  It strips OPENAI_API_KEY and ANTHROPIC_API_KEY from child processes so
  Codex and Claude stay on ChatGPT / claude.ai login auth.
  When Claude browser-use MCP is configured and a task needs browser/computer
  navigation, the runner can let Claude use that MCP selectively.`);
}

async function run(task, options) {
  const taskComplexity = resolveTaskComplexity(task, options.complexity);
  options.taskComplexity = taskComplexity;
  const providerStates = await inspectProviders();
  const availableProviders = Object.values(providerStates)
    .filter(state => state.available)
    .map(state => state.provider);
  if (!availableProviders.length) {
    const details = Object.values(providerStates)
      .map(state => `- ${state.label}: ${state.reason || 'not available'}`)
      .join('\n');
    throw new Error(
      `No subscription-backed providers are available.\n${details}\n\n` +
      `Run \`codex login\` with your ChatGPT account and/or \`claude auth login\` with your claude.ai account.`
    );
  }

  if (options.collaborationMode === 'paired' && availableProviders.length < 2) {
    options.collaborationMode = 'routed';
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runId = options.runId || timestamp;
  const outputDir = path.join(ROOT, 'agents-output', runId);
  ensureDir(path.join(outputDir, 'raw'));
  ensureDir(path.join(outputDir, 'artifacts'));

  const baseRunState = {
    runId,
    task,
    profile: options.profile,
    collaborationMode: options.collaborationMode,
    complexityMode: options.complexity,
    taskComplexity,
    apply: options.apply,
    startedAt: new Date().toISOString(),
    providers: summarizeProviderStates(providerStates),
    status: 'starting',
    phase: 'bootstrap',
    currentSubtask: null,
    completedSubtasks: [],
    planSummary: '',
    outputDir: `agents-output/${runId}`,
    reportPath: `agents-output/${runId}/REPORT.md`,
    sharedMemory: [],
    error: '',
  };
  writeRunState(outputDir, baseRunState);

  console.log('');
  console.log('Hybrid GP Link Agent Orchestrator');
  console.log('='.repeat(60));
  console.log(`Task: ${task}`);
  console.log(`Profile: ${options.profile}`);
  console.log(`Collaboration: ${options.collaborationMode}`);
  console.log(`Complexity: ${taskComplexity}${options.complexity !== 'auto' ? ` (forced from ${options.complexity})` : ' (auto)'}`);
  console.log(`Providers: ${availableProviders.join(', ')}`);
  for (const state of Object.values(providerStates)) {
    console.log(`  - ${state.label}: ${state.available ? `ready (${state.authSummary})` : `unavailable (${state.reason})`}`);
  }
  console.log(`Apply mode: ${options.apply ? 'write matched edits' : 'artifact only'}`);
  console.log(`Output: agents-output/${runId}/`);
  console.log('='.repeat(60));
  console.log('');

  console.log('[context] Building project overview...');
  const projectOverview = readProjectOverview();
  writeRunState(outputDir, {
    ...baseRunState,
    status: 'running',
    phase: 'planning',
  });

  console.log('[plan] Generating plan...');
  const { plan, plannerConfig, raw: plannerRaw } = await leadAgent(task, projectOverview, options, availableProviders);
  saveRawOutput(outputDir, 'planner_raw.md', plannerRaw);

  const resolvedPlan = {
    summary: plan.summary,
    assumptions: plan.assumptions,
    planner: plannerConfig,
    subtasks: plan.subtasks.map(subtask => ({
      ...subtask,
      assignment: resolveAssignment(subtask, options, availableProviders),
    })),
  };

  fs.writeFileSync(path.join(outputDir, 'plan.json'), JSON.stringify(plan, null, 2));
  fs.writeFileSync(path.join(outputDir, 'resolved-plan.json'), JSON.stringify(resolvedPlan, null, 2));
  writeRunState(outputDir, {
    ...baseRunState,
    status: 'running',
    phase: 'planned',
    planner: plannerConfig,
    planSummary: resolvedPlan.summary,
    subtasks: resolvedPlan.subtasks.map(subtask => ({
      id: subtask.id,
      agent: subtask.agent,
      title: subtask.title,
      dependsOn: subtask.dependsOn,
      files: subtask.files,
      primary: {
        provider: subtask.assignment.primary.provider,
        model: subtask.assignment.primary.model,
      },
      advisor: subtask.assignment.advisor ? {
        provider: subtask.assignment.advisor.provider,
        model: subtask.assignment.advisor.model,
      } : null,
    })),
    currentSubtask: null,
  });

  console.log('');
  console.log(`[plan] ${resolvedPlan.summary}`);
  for (const subtask of resolvedPlan.subtasks) {
    console.log(
      `  - [${subtask.agent}] ${subtask.id}: ${subtask.title} ` +
      `=> ${subtask.assignment.primary.provider}/${subtask.assignment.primary.model}` +
      `${subtask.assignment.advisor ? ` + advisor ${subtask.assignment.advisor.provider}/${subtask.assignment.advisor.model}` : ''}`
    );
  }

  const completed = {};
  const sharedMemory = [];
  const remaining = [...resolvedPlan.subtasks];
  let safetyCounter = 0;

  while (remaining.length && safetyCounter < 20) {
    safetyCounter++;
    const ready = remaining.filter(subtask => subtask.dependsOn.every(dep => completed[dep]));
    if (!ready.length) {
      writeRunState(outputDir, {
        ...baseRunState,
        status: 'failed',
        phase: 'error',
        planner: plannerConfig,
        planSummary: resolvedPlan.summary,
        completedSubtasks: Object.values(completed).map(record => ({
          id: record.id,
          agent: record.agent,
          provider: record.provider,
          model: record.model,
        })),
        error: `Dependency deadlock. Remaining subtasks: ${remaining.map(subtask => subtask.id).join(', ')}`,
      });
      throw new Error(`Dependency deadlock. Remaining subtasks: ${remaining.map(subtask => subtask.id).join(', ')}`);
    }

    const sharedMemorySnapshot = [...sharedMemory];
    const batchResults = await Promise.all(ready.map(async subtask => {
      const dependencyRecords = subtask.dependsOn.map(dep => completed[dep]);
      console.log('');
      console.log('-'.repeat(60));
      console.log(`[run] ${subtask.id} (${subtask.agent})`);
      console.log(`      ${subtask.title}`);
      writeRunState(outputDir, {
        ...baseRunState,
        status: 'running',
        phase: 'executing',
        planner: plannerConfig,
        planSummary: resolvedPlan.summary,
        currentSubtask: {
          id: subtask.id,
          agent: subtask.agent,
          title: subtask.title,
          provider: subtask.assignment.primary.provider,
          model: subtask.assignment.primary.model,
        },
        completedSubtasks: Object.values(completed).map(record => ({
          id: record.id,
          agent: record.agent,
          provider: record.provider,
          model: record.model,
        })),
        sharedMemory: sharedMemorySnapshot.slice(0, DEFAULTS.maxSharedMemoryItems),
      });
      return {
        subtask,
        result: await executeSubtask(
          subtask,
          subtask.assignment,
          projectOverview,
          sharedMemorySnapshot,
          dependencyRecords,
          outputDir,
          options.apply
        ),
      };
    }));

    for (const { subtask, result } of batchResults) {
      remaining.splice(remaining.findIndex(item => item.id === subtask.id), 1);

      const insights = uniq([
        ...collectParsedInsights(result.primaryResult.parsed),
        ...collectParsedInsights(result.advisorResult && result.advisorResult.parsed),
      ]);
      for (const insight of insights) {
        if (!sharedMemory.includes(insight)) sharedMemory.push(insight);
      }

      completed[subtask.id] = {
        id: subtask.id,
        agent: subtask.agent,
        provider: subtask.assignment.primary.provider,
        model: subtask.assignment.primary.model,
        primary: result.primaryResult,
        advisor: result.advisorResult,
        applyResults: result.applyResults,
        contextSummary: result.contextSummary,
      };

      if (result.applyResults.length) {
        for (const applyResult of result.applyResults) {
          console.log(`  [file] ${applyResult.path}: ${applyResult.status} (${applyResult.reason})`);
        }
      } else {
        console.log('  [file] No file changes proposed');
      }

      writeRunState(outputDir, {
        ...baseRunState,
        status: 'running',
        phase: 'executing',
        planner: plannerConfig,
        planSummary: resolvedPlan.summary,
        currentSubtask: null,
        completedSubtasks: Object.values(completed).map(record => ({
          id: record.id,
          agent: record.agent,
          provider: record.provider,
          model: record.model,
        })),
        sharedMemory: sharedMemory.slice(0, DEFAULTS.maxSharedMemoryItems),
      });
    }
  }

  const sharedMemoryText = formatSharedMemory(sharedMemory);
  fs.writeFileSync(path.join(outputDir, 'shared-memory.md'), `${sharedMemoryText}\n`, 'utf8');

  const reportLines = [
    '# Hybrid Agent Report',
    '',
    `Task: ${task}`,
    `Date: ${new Date().toISOString()}`,
    `Profile: ${options.profile}`,
    `Collaboration: ${options.collaborationMode}`,
    `Providers available: ${availableProviders.join(', ')}`,
    '',
    '## Plan',
    resolvedPlan.summary,
    '',
    '## Assumptions',
    ...(resolvedPlan.assumptions.length ? resolvedPlan.assumptions.map(item => `- ${item}`) : ['- None recorded']),
    '',
    '## Subtasks',
    ...resolvedPlan.subtasks.flatMap(subtask => ([
      `### ${subtask.id} (${subtask.agent})`,
      `- Title: ${subtask.title}`,
      `- Primary: ${subtask.assignment.primary.provider}/${subtask.assignment.primary.model}`,
      `- Advisor: ${subtask.assignment.advisor ? `${subtask.assignment.advisor.provider}/${subtask.assignment.advisor.model}` : 'none'}`,
      `- Depends on: ${subtask.dependsOn.length ? subtask.dependsOn.join(', ') : '(none)'}`,
      `- Files: ${subtask.files.length ? subtask.files.join(', ') : '(none specified)'}`,
      '',
    ])),
    '## Shared Memory',
    sharedMemoryText,
    '',
    '## Outputs',
    '- Raw model outputs: `raw/`',
    '- Patched or created file artifacts: `artifacts/`',
    '- Planner and resolved plan JSON: `plan.json`, `resolved-plan.json`',
    '- Shared memory snapshot: `shared-memory.md`',
    '',
    '## File Results',
    ...Object.values(completed).flatMap(record => {
      if (!record.applyResults.length) {
        return [`- ${record.id}: no file artifacts`];
      }
      return record.applyResults.map(result => `- ${record.id}: ${result.path} -> ${result.status} (${result.reason})`);
    }),
  ];

  fs.writeFileSync(path.join(outputDir, 'REPORT.md'), reportLines.join('\n'), 'utf8');
  writeRunState(outputDir, {
    ...baseRunState,
    status: 'completed',
    phase: 'completed',
    planner: plannerConfig,
    planSummary: resolvedPlan.summary,
    currentSubtask: null,
    completedSubtasks: Object.values(completed).map(record => ({
      id: record.id,
      agent: record.agent,
      provider: record.provider,
      model: record.model,
    })),
    sharedMemory: sharedMemory.slice(0, DEFAULTS.maxSharedMemoryItems),
    finishedAt: new Date().toISOString(),
  });

  console.log('');
  console.log('='.repeat(60));
  console.log('Complete');
  console.log(`Output: agents-output/${runId}/`);
  console.log('Artifacts to review: raw/, artifacts/, REPORT.md');
  console.log('='.repeat(60));
  console.log('');
}

module.exports = {
  DEFAULTS,
  extractRelevantSections,
  getModelPolicy,
  inferBrowserUseNeed,
  inferTaskComplexity,
  inspectProviders,
  normalizePlan,
  parseClaudeAuthStatusOutput,
  parseClaudeMcpListOutput,
  parseCodexLoginStatusOutput,
  parseArgs,
  parseJSON,
  resolveTaskComplexity,
  resolveAssignment,
};

if (require.main === module) {
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

  if (!options.task) {
    printHelp();
    process.exit(1);
  }

  run(options.task, options).catch(error => {
    console.error('');
    console.error(`Agent system error: ${error.message}`);
    process.exit(1);
  });
}
