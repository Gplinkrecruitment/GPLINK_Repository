import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as wrapper from '../.claude/skills/gplink/scripts/launch-orchestrator.js';

const tempPaths = [];

afterEach(() => {
  while (tempPaths.length) {
    const tempPath = tempPaths.pop();
    try {
      fs.rmSync(tempPath, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup.
    }
  }
});

function makeTempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gplink-wrapper-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  tempPaths.push(dir);
  return filePath;
}

describe('gplink wrapper local reference ingestion', () => {
  it('finds absolute local file references in quoted and unquoted form', () => {
    const first = makeTempFile('first-note.txt', 'alpha');
    const second = makeTempFile('second-note.txt', 'beta');
    const task = `Review "${first}" and also ${second} before planning.`;

    const found = wrapper.extractLocalReferences(task);

    expect(found).toEqual([first, second]);
  });

  it('enriches the task with extracted text from local text files', () => {
    const ref = makeTempFile('flow-notes.txt', 'MyIntealth blockers\nAMC follow-up\nWhatsApp nudge for Hazel');
    const task = `Use "${ref}" as a reference for the GP Link rewrite.`;

    const enriched = wrapper.enrichTaskWithReferences(task, process.env);

    expect(enriched.records).toHaveLength(1);
    expect(enriched.records[0].type).toBe('text');
    expect(enriched.attachmentSection).toContain(ref);
    expect(enriched.attachmentSection).toContain('MyIntealth blockers');
    expect(enriched.task).toContain('Local reference attachments detected by the /gplink wrapper');
  });

  it('builds a direct-node orchestrator launch plan instead of relying on npm', () => {
    const launch = wrapper.buildLaunchPlan('/opt/node/bin/node', 'Rewrite the GP flow', 'claude-skill-123');

    expect(launch.binary).toBe('/opt/node/bin/node');
    expect(launch.label).toBe('direct node via scripts/agents.js');
    expect(launch.args[0]).toMatch(/scripts\/agents\.js$/);
    expect(launch.args.slice(1)).toEqual(['--task', 'Rewrite the GP flow', '--run-id', 'claude-skill-123']);
  });
});
