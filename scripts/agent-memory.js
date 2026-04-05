#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MEMORY_ROOT = path.join(ROOT, 'agents-output', 'memory');
const MEMORY_JSON_PATH = path.join(MEMORY_ROOT, 'knowledge-base.json');
const MEMORY_MARKDOWN_PATH = path.join(MEMORY_ROOT, 'knowledge-base.md');
const MEMORY_LATEST_SESSION_PATH = path.join(MEMORY_ROOT, 'latest-session.md');

const {
  loadPersistentMemoryStore,
  mergeLearningIntoMemoryStore,
  renderPersistentMemoryMarkdown,
} = require('./agents.js');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function splitList(value) {
  return String(value || '')
    .split(/[,\n]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index++;
  }
  return args;
}

function printHelp() {
  console.log(`GP Link shared agent memory helper

Usage:
  node scripts/agent-memory.js handoff --source codex --task "task" --summary "summary" --files "a,b" --next "next step"
  node scripts/agent-memory.js learn --source claude --role backend --text "durable learning" --files "server.js,supabase/migrations/..."

Commands:
  handoff   Update agents-output/memory/latest-session.md for Codex <-> Claude handoff
  learn     Add a durable learning entry to agents-output/memory/knowledge-base.json and .md
`);
}

function writeLatestSession(args) {
  ensureDir(MEMORY_ROOT);
  const files = splitList(args.files);
  const lines = [
    '# Latest GP Link Agent Session',
    '',
    `Updated: ${new Date().toISOString()}`,
    `Source: ${args.source || 'manual'}`,
    `Task: ${args.task || '(not provided)'}`,
    '',
    '## Summary',
    '',
    args.summary || 'No summary provided.',
    '',
    '## Files Touched',
    '',
    ...(files.length ? files.map(file => `- ${file}`) : ['- None recorded']),
    '',
    '## Risks / Security Notes',
    '',
    args.risks || 'None recorded.',
    '',
    '## Next Handoff',
    '',
    args.next || 'No next step recorded.',
    '',
    '## Notes',
    '',
    args.notes || 'No additional notes recorded.',
    '',
  ];
  fs.writeFileSync(MEMORY_LATEST_SESSION_PATH, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Updated ${path.relative(ROOT, MEMORY_LATEST_SESSION_PATH)}`);
}

function saveStore(store) {
  ensureDir(MEMORY_ROOT);
  fs.writeFileSync(MEMORY_JSON_PATH, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.writeFileSync(MEMORY_MARKDOWN_PATH, `${renderPersistentMemoryMarkdown(store)}\n`, 'utf8');
}

function addLearning(args) {
  const text = String(args.text || '').trim();
  if (!text) {
    throw new Error('The learn command requires --text.');
  }

  const role = String(args.role || 'alignment').trim();
  const files = splitList(args.files);
  const source = String(args.source || 'manual').trim();
  const task = String(args.task || '').trim();
  const kind = String(args.kind || 'manual-learning').trim();
  const runId = `manual-${source}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

  const merged = mergeLearningIntoMemoryStore(loadPersistentMemoryStore(), [{
    text,
    role,
    kind,
    files,
    sources: [{
      runId,
      subtaskId: task || source || 'manual',
      role,
      provider: source === 'codex' ? 'openai' : source === 'claude' ? 'anthropic' : '',
      model: '',
      kind,
      at: new Date().toISOString(),
    }],
  }]);

  saveStore(merged);
  console.log(`Updated ${path.relative(ROOT, MEMORY_JSON_PATH)} and ${path.relative(ROOT, MEMORY_MARKDOWN_PATH)}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'handoff') {
    writeLatestSession(args);
    return;
  }

  if (command === 'learn') {
    addLearning(args);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

try {
  main();
} catch (error) {
  console.error(`Agent memory error: ${error.message}`);
  process.exit(1);
}
