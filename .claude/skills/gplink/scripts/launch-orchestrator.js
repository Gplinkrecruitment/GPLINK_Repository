#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..');
const ROOT = path.resolve(SKILL_DIR, '../../..');
const MEMORY_DIR = path.join(ROOT, 'agents-output', 'memory');
const LATEST_SESSION_PATH = path.join(MEMORY_DIR, 'latest-session.md');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--status') {
      args.status = true;
      continue;
    }
    if (arg === '--stdin') {
      args.stdin = true;
      continue;
    }
    if (arg === '--task-file') {
      args.taskFile = argv[index + 1] || '';
      index++;
      continue;
    }
    if (arg === '--task') {
      args.task = argv[index + 1] || '';
      index++;
      continue;
    }
  }
  return args;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function trimTask(value) {
  return String(value || '').replace(/^\s+|\s+$/g, '');
}

function resolveBinary(name, candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  const result = spawnSync('bash', ['-lc', `command -v ${name}`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return '';
}

function renderStatus() {
  ensureDir(MEMORY_DIR);
  const lines = [
    'GP Link wrapper status',
    `Project root: ${ROOT}`,
    `Latest session memory: ${LATEST_SESSION_PATH}`,
    '',
  ];

  if (fs.existsSync(LATEST_SESSION_PATH)) {
    lines.push('Current shared memory snapshot:');
    lines.push(readFileSafe(LATEST_SESSION_PATH).split('\n').slice(0, 80).join('\n'));
  } else {
    lines.push('No shared memory file exists yet.');
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

function runCommand(binary, args, options = {}) {
  return spawnSync(binary, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    ...options,
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const task = trimTask(
    args.task
      || (args.taskFile ? readFileSafe(args.taskFile) : '')
      || (args.stdin ? readStdin() : '')
  );
  if (args.status || !task) {
    renderStatus();
    return;
  }

  const nodeBin = resolveBinary('node', [
    '/usr/local/Cellar/node@18/18.20.8/bin/node',
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
  ]);

  if (!nodeBin) {
    throw new Error('could not find a usable node binary');
  }

  const npmBin = resolveBinary('npm', [
    '/usr/local/Cellar/node@18/18.20.8/bin/npm',
    '/usr/local/bin/npm',
    '/opt/homebrew/bin/npm',
  ]);

  const runId = `claude-skill-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const reportPath = path.join(ROOT, 'agents-output', runId, 'REPORT.md');

  ensureDir(MEMORY_DIR);

  runCommand(nodeBin, [
    path.join(ROOT, 'scripts', 'agent-memory.js'),
    'handoff',
    '--source', 'claude',
    '--task', task,
    '--summary', 'Claude /gplink launched the GP Link hybrid orchestrator for this task.',
    '--files', '(orchestrator launch)',
    '--next', `Inspect agents-output/${runId}/REPORT.md, latest-session.md, and knowledge-base.md after the run completes.`,
    '--notes', `Run id: ${runId}`,
  ]);

  process.stdout.write(
    [
      'GP Link wrapper',
      `Task: ${task}`,
      `Run ID: ${runId}`,
      'Shared memory seeded: agents-output/memory/latest-session.md',
      npmBin
        ? `Launch mode: npm run gplink -- --task "<task>" --run-id "${runId}"`
        : 'Launch mode: direct node fallback via scripts/agents.js (npm not found in PATH)',
      '',
      'Starting hybrid orchestrator...',
      '',
    ].join('\n')
  );

  const launchResult = npmBin
    ? runCommand(npmBin, ['run', 'gplink', '--', '--task', task, '--run-id', runId])
    : runCommand(nodeBin, ['scripts/agents.js', '--task', task, '--run-id', runId]);

  process.stdout.write('\n');

  if (launchResult.status === 0) {
    process.stdout.write(
      [
        'Hybrid orchestrator completed successfully.',
        `Report: ${reportPath}`,
        `Latest session memory: ${LATEST_SESSION_PATH}`,
        `Durable memory: ${path.join(MEMORY_DIR, 'knowledge-base.md')}`,
        '',
      ].join('\n')
    );

    if (fs.existsSync(reportPath)) {
      process.stdout.write(`Report preview:\n${readFileSafe(reportPath).split('\n').slice(0, 60).join('\n')}\n`);
    }
    return;
  }

  runCommand(nodeBin, [
    path.join(ROOT, 'scripts', 'agent-memory.js'),
    'handoff',
    '--source', 'claude',
    '--task', task,
    '--summary', 'Claude /gplink attempted to launch the GP Link hybrid orchestrator, but the run failed.',
    '--files', '(orchestrator launch)',
    '--risks', `The orchestrator exited with code ${launchResult.status}.`,
    '--next', 'Inspect the terminal output and rerun the task after fixing the blocker.',
    '--notes', `Failed run id: ${runId}`,
  ]);

  throw new Error(`hybrid orchestrator failed with exit code ${launchResult.status}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`GP Link wrapper error: ${error.message}\n`);
  process.exit(1);
}
