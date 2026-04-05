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
const OCR_SCRIPT_PATH = path.join(SCRIPT_DIR, 'ocr-image.swift');
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.html', '.css', '.scss', '.sql', '.yml', '.yaml', '.csv', '.log', '.env', '.xml',
]);
const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.heif',
]);
const DOCUMENT_EXTENSIONS = new Set([
  '.pdf', '.rtf',
]);
const MAX_REFERENCES = 6;
const MAX_TEXT_CHARS = 12000;
const MAX_IMAGE_TEXT_CHARS = 6000;
const MAX_DOCUMENT_TEXT_CHARS = 8000;

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

function truncateText(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20))}\n\n[truncated]`;
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

function runCommandCapture(binary, args, options = {}) {
  return spawnSync(binary, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    ...options,
  });
}

function normalizePathCandidate(rawPath) {
  const trimmed = String(rawPath || '').trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed || !path.isAbsolute(trimmed)) return '';
  return path.normalize(trimmed);
}

function extractLocalReferences(task) {
  const text = String(task || '');
  const paths = [];
  const seen = new Set();
  const pushIfValid = (candidate) => {
    const normalized = normalizePathCandidate(candidate);
    if (!normalized || seen.has(normalized)) return;
    if (!fs.existsSync(normalized)) return;
    seen.add(normalized);
    paths.push(normalized);
  };

  const quotedPattern = /(["'])(\/[^"'`\n]+?)\1/g;
  let match;
  while ((match = quotedPattern.exec(text)) !== null) {
    pushIfValid(match[2]);
  }

  const absolutePattern = /(^|[\s(])((\/[^\s"'`<>]+))/g;
  while ((match = absolutePattern.exec(text)) !== null) {
    pushIfValid(match[2]);
  }

  return paths.slice(0, MAX_REFERENCES);
}

function classifyReference(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  return 'binary';
}

function readTextReference(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.includes('\u0000')) return '';
    return truncateText(content, MAX_TEXT_CHARS);
  } catch {
    return '';
  }
}

function extractDocumentText(filePath, env) {
  const mdls = resolveBinary('mdls', ['/usr/bin/mdls']);
  if (!mdls) return '';
  const result = runCommandCapture(mdls, ['-raw', '-name', 'kMDItemTextContent', filePath], { env });
  if (result.status !== 0) return '';
  const text = String(result.stdout || '').trim();
  if (!text || text === '(null)') return '';
  return truncateText(text, MAX_DOCUMENT_TEXT_CHARS);
}

function extractImageMetadata(filePath, env) {
  const sips = resolveBinary('sips', ['/usr/bin/sips']);
  if (!sips) return '';
  const result = runCommandCapture(sips, ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath], { env });
  if (result.status !== 0) return '';
  const widthMatch = result.stdout.match(/pixelWidth:\s*(\d+)/);
  const heightMatch = result.stdout.match(/pixelHeight:\s*(\d+)/);
  if (!widthMatch && !heightMatch) return '';
  return [widthMatch ? `width ${widthMatch[1]}` : '', heightMatch ? `height ${heightMatch[1]}` : '']
    .filter(Boolean)
    .join(', ');
}

function extractImageText(filePath, env) {
  const swift = resolveBinary('swift', ['/usr/bin/swift']);
  if (!swift || !fs.existsSync(OCR_SCRIPT_PATH)) {
    return { text: '', metadata: extractImageMetadata(filePath, env) };
  }

  const result = runCommandCapture(swift, [OCR_SCRIPT_PATH, filePath], { env });
  if (result.status !== 0) {
    return { text: '', metadata: extractImageMetadata(filePath, env) };
  }

  try {
    const parsed = JSON.parse(String(result.stdout || '{}'));
    return {
      text: truncateText(parsed.text || '', MAX_IMAGE_TEXT_CHARS),
      metadata: parsed.metadata || extractImageMetadata(filePath, env),
    };
  } catch {
    return { text: '', metadata: extractImageMetadata(filePath, env) };
  }
}

function buildAttachmentRecord(filePath, env) {
  const type = classifyReference(filePath);
  const size = (() => {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  })();

  if (type === 'text') {
    const content = readTextReference(filePath);
    return {
      path: filePath,
      type,
      size,
      summary: content ? 'Text content extracted.' : 'Could not extract text content.',
      content,
    };
  }

  if (type === 'document') {
    const content = extractDocumentText(filePath, env);
    return {
      path: filePath,
      type,
      size,
      summary: content ? 'Document text extracted via Spotlight metadata.' : 'Document detected, but no text could be extracted automatically.',
      content,
    };
  }

  if (type === 'image') {
    const image = extractImageText(filePath, env);
    return {
      path: filePath,
      type,
      size,
      summary: image.text
        ? `Image OCR extracted text${image.metadata ? ` (${image.metadata})` : ''}.`
        : `Image detected${image.metadata ? ` (${image.metadata})` : ''}, but OCR returned little or no text.`,
      content: image.text,
    };
  }

  return {
    path: filePath,
    type,
    size,
    summary: 'Binary or unsupported file type detected. Metadata only; no inline content extracted.',
    content: '',
  };
}

function formatAttachmentSection(records) {
  if (!records.length) return '';
  const lines = [
    'Local reference attachments detected by the /gplink wrapper:',
    'Use these as grounded external references in addition to the repository context.',
    '',
  ];

  records.forEach((record, index) => {
    lines.push(`### Attachment ${index + 1}`);
    lines.push(`- Path: ${record.path}`);
    lines.push(`- Type: ${record.type}`);
    lines.push(`- Size: ${record.size} bytes`);
    lines.push(`- Extraction summary: ${record.summary}`);
    if (record.content) {
      lines.push('- Extracted content:');
      lines.push('```text');
      lines.push(record.content);
      lines.push('```');
    }
    lines.push('');
  });

  return lines.join('\n').trim();
}

function enrichTaskWithReferences(task, env) {
  const references = extractLocalReferences(task);
  if (!references.length) {
    return {
      task,
      attachmentSection: '',
      records: [],
    };
  }

  const records = references.map(filePath => buildAttachmentRecord(filePath, env));
  const attachmentSection = formatAttachmentSection(records);
  return {
    task: `${task}\n\n${attachmentSection}`.trim(),
    attachmentSection,
    records,
  };
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

function buildLaunchEnv(nodeBin) {
  const pathParts = [
    path.dirname(nodeBin),
    process.env.PATH || '',
  ].filter(Boolean);

  return {
    ...process.env,
    PATH: Array.from(new Set(pathParts.join(':').split(':').filter(Boolean))).join(':'),
  };
}

function buildLaunchPlan(nodeBin, task, runId) {
  return {
    binary: nodeBin,
    args: [
      path.join(ROOT, 'scripts', 'agents.js'),
      '--task',
      task,
      '--run-id',
      runId,
    ],
    label: 'direct node via scripts/agents.js',
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const originalTask = trimTask(
    args.task
      || (args.taskFile ? readFileSafe(args.taskFile) : '')
      || (args.stdin ? readStdin() : '')
  );
  if (args.status || !originalTask) {
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

  const runId = `claude-skill-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const reportPath = path.join(ROOT, 'agents-output', runId, 'REPORT.md');
  const launchEnv = buildLaunchEnv(nodeBin);
  const enriched = enrichTaskWithReferences(originalTask, launchEnv);
  const task = enriched.task;
  const attachmentReportPath = path.join(ROOT, 'agents-output', runId, 'local-references.md');
  const launchPlan = buildLaunchPlan(nodeBin, task, runId);

  ensureDir(MEMORY_DIR);
  ensureDir(path.dirname(attachmentReportPath));
  if (enriched.attachmentSection) {
    fs.writeFileSync(attachmentReportPath, `${enriched.attachmentSection}\n`, 'utf8');
  }

  runCommand(nodeBin, [
    path.join(ROOT, 'scripts', 'agent-memory.js'),
    'handoff',
    '--source', 'claude',
    '--task', originalTask,
    '--summary', 'Claude /gplink launched the GP Link hybrid orchestrator for this task.',
    '--files', enriched.records.length ? enriched.records.map(record => record.path).join(',') : '(orchestrator launch)',
    '--next', `Inspect agents-output/${runId}/REPORT.md, latest-session.md, and knowledge-base.md after the run completes.`,
    '--notes', `Run id: ${runId}${enriched.records.length ? `; local references: ${enriched.records.length}` : ''}`,
  ], { env: launchEnv });

  process.stdout.write(
    [
      'GP Link wrapper',
      `Task: ${originalTask}`,
      `Run ID: ${runId}`,
      'Shared memory seeded: agents-output/memory/latest-session.md',
      enriched.records.length ? `Local references ingested: ${enriched.records.length}` : 'Local references ingested: 0',
      `Launch mode: ${launchPlan.label}`,
      enriched.records.length ? `Attachment context: ${attachmentReportPath}` : '',
      '',
      'Starting hybrid orchestrator...',
      '',
    ].join('\n')
  );

  const launchResult = runCommand(launchPlan.binary, launchPlan.args, { env: launchEnv });

  process.stdout.write('\n');

  if (launchResult.status === 0) {
    process.stdout.write(
      [
        'Hybrid orchestrator completed successfully.',
        `Report: ${reportPath}`,
        `Latest session memory: ${LATEST_SESSION_PATH}`,
        `Durable memory: ${path.join(MEMORY_DIR, 'knowledge-base.md')}`,
        enriched.records.length ? `Attachment context: ${attachmentReportPath}` : '',
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
    '--task', originalTask,
    '--summary', 'Claude /gplink attempted to launch the GP Link hybrid orchestrator, but the run failed.',
    '--files', enriched.records.length ? enriched.records.map(record => record.path).join(',') : '(orchestrator launch)',
    '--risks', `The orchestrator exited with code ${launchResult.status}.`,
    '--next', 'Inspect the terminal output and rerun the task after fixing the blocker.',
    '--notes', `Failed run id: ${runId}${enriched.records.length ? `; local references: ${enriched.records.length}` : ''}`,
  ], { env: launchEnv });

  throw new Error(`hybrid orchestrator failed with exit code ${launchResult.status}`);
}

module.exports = {
  buildAttachmentRecord,
  classifyReference,
  enrichTaskWithReferences,
  extractLocalReferences,
  formatAttachmentSection,
  buildLaunchEnv,
  buildLaunchPlan,
  parseArgs,
  trimTask,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`GP Link wrapper error: ${error.message}\n`);
    process.exit(1);
  }
}
