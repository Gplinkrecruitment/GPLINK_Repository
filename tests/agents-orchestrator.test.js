import { describe, expect, it } from 'vitest';
import * as agents from '../scripts/agents.js';

const {
  DEFAULTS,
  buildLearningCandidates,
  extractRelevantSections,
  formatMemoryRecall,
  getModelPolicy,
  inferBrowserUseNeed,
  inferTaskComplexity,
  markMemoryEntriesUsed,
  mergeLearningIntoMemoryStore,
  normalizePlan,
  parseClaudeAuthStatusOutput,
  parseClaudeMcpListOutput,
  parseCodexLoginStatusOutput,
  parseArgs,
  resolveAssignment,
  selectRelevantMemoryEntries,
} = agents;

describe('parseArgs', () => {
  it('parses the main orchestration flags', () => {
    const parsed = parseArgs([
      '--task', 'build dashboard',
      '--profile', 'codex-heavy',
      '--collaboration', 'paired',
      '--apply',
    ]);

    expect(parsed.task).toBe('build dashboard');
    expect(parsed.profile).toBe('codex-heavy');
    expect(parsed.collaborationMode).toBe('paired');
    expect(parsed.apply).toBe(true);
  });

  it('accepts explicit complexity overrides', () => {
    const parsed = parseArgs([
      '--task', 'fix a typo',
      '--complexity', 'simple',
    ]);

    expect(parsed.complexity).toBe('simple');
  });
});

describe('resolveAssignment', () => {
  it('routes frontend to OpenAI and adds a Claude advisor in balanced paired mode', () => {
    const assignment = resolveAssignment(
      { agent: 'frontend', modelPreference: 'either' },
      { profile: 'balanced', collaborationMode: 'paired' },
      ['openai', 'anthropic']
    );

    expect(assignment.primary.provider).toBe('openai');
    expect(assignment.advisor.provider).toBe('anthropic');
  });

  it('falls back to the available provider when only one provider exists', () => {
    const assignment = resolveAssignment(
      { agent: 'database', modelPreference: 'openai' },
      { profile: 'balanced', collaborationMode: 'paired' },
      ['anthropic']
    );

    expect(assignment.primary.provider).toBe('anthropic');
    expect(assignment.advisor).toBe(null);
  });
});

describe('provider auth parsing', () => {
  it('detects ChatGPT-backed Codex login', () => {
    const status = parseCodexLoginStatusOutput('Logged in using ChatGPT');

    expect(status.loggedIn).toBe(true);
    expect(status.usesSubscription).toBe(true);
  });

  it('detects claude.ai subscription auth', () => {
    const status = parseClaudeAuthStatusOutput(JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      subscriptionType: 'max',
    }));

    expect(status.loggedIn).toBe(true);
    expect(status.usesSubscription).toBe(true);
    expect(status.subscriptionType).toBe('max');
  });

  it('detects connected browser-use MCP on Claude', () => {
    const parsed = parseClaudeMcpListOutput([
      'Checking MCP server health...',
      'browser-use: /Users/test/.local/bin/uvx --mcp - ✓ Connected',
      'claude.ai Gmail: https://gmail.mcp.claude.com/mcp - ! Needs authentication',
    ].join('\n'));

    expect(parsed.browserUse?.available).toBe(true);
    expect(parsed.browserUse?.name).toBe('browser-use');
    expect(parsed.servers).toHaveLength(2);
  });
});

describe('complexity policy', () => {
  it('marks large redesign prompts as complex', () => {
    expect(inferTaskComplexity('Redesign the secure master admin dashboard, audit the workflow, and research the safest rollout plan end to end.')).toBe('complex');
  });

  it('builds a complex-tier policy with the strongest models', () => {
    const policy = getModelPolicy(
      'Redesign the admin app flow and research a secure rollout.',
      'auto',
      'balanced',
      'paired'
    );

    expect(policy.taskComplexity).toBe('complex');
    expect(policy.selected.openaiPrimary).toBe(DEFAULTS.openaiComplexModel);
    expect(policy.selected.anthropicPrimary).toBe(DEFAULTS.anthropicComplexModel);
    expect(policy.roleAssignments.find(item => item.role === 'research')?.provider).toBe('anthropic');
  });

  it('keeps small typo fixes on the lighter tier', () => {
    const policy = getModelPolicy('Fix one typo on the admin dashboard.', 'auto', 'balanced', 'paired');

    expect(policy.taskComplexity).toBe('simple');
    expect(policy.selected.openaiPrimary).toBe(DEFAULTS.openaiSimpleModel);
    expect(policy.selected.anthropicPrimary).toBe(DEFAULTS.anthropicSimpleModel);
  });

  it('flags browser walkthrough tasks for Claude MCP usage', () => {
    expect(inferBrowserUseNeed('Navigate through the app as a first-time GP and follow the process start to finish.')).toBe(true);

    const policy = getModelPolicy(
      'Navigate through the app as a first-time GP and inspect the flow from start to finish.',
      'auto',
      'balanced',
      'paired'
    );

    expect(policy.capabilities.browserUseRecommended).toBe(true);
  });
});

describe('normalizePlan', () => {
  it('ensures a final review step depends on all non-review work', () => {
    const normalized = normalizePlan({
      summary: 'Ship the feature',
      subtasks: [
        {
          agent: 'frontend',
          id: 'ui-pass',
          title: 'UI pass',
          description: 'Build the page',
          files: ['pages/account.html'],
          dependsOn: [],
          modelPreference: 'either',
        },
        {
          agent: 'backend',
          id: 'api-pass',
          title: 'API pass',
          description: 'Add the endpoint',
          files: ['server.js'],
          dependsOn: ['ui-pass'],
          modelPreference: 'either',
        },
      ],
    }, 'Ship the feature');

    expect(normalized.subtasks.at(-1).agent).toBe('review');
    expect(normalized.subtasks.at(-1).dependsOn).toEqual(['ui-pass', 'api-pass']);
  });
});

describe('extractRelevantSections', () => {
  it('keeps targeted snippets from larger files', () => {
    const content = [
      ...Array.from({ length: 80 }, (_, index) => `filler line ${index + 1}`),
      'special route /api/agents/hybrid',
      'advisorProvider = "anthropic";',
      ...Array.from({ length: 80 }, (_, index) => `tail line ${index + 1}`),
    ].join('\n');

    const extracted = extractRelevantSections(content, 'hybrid agents advisor anthropic api', 700);

    expect(extracted).toContain('/api/agents/hybrid');
    expect(extracted).toContain('advisorProvider');
  });
});

describe('persistent memory', () => {
  it('merges repeated learnings instead of duplicating them', () => {
    const firstPass = mergeLearningIntoMemoryStore({ entries: [] }, [{
      text: 'Use same-origin checks on the super-admin agent endpoints to reduce dashboard abuse risk.',
      role: 'backend',
      files: ['server.js'],
      kind: 'security',
      sources: [{ runId: 'run-1', subtaskId: 'api-pass', kind: 'security' }],
    }]);

    const secondPass = mergeLearningIntoMemoryStore(firstPass, [{
      text: 'Use same-origin checks on the super-admin agent endpoints to reduce dashboard abuse risk.',
      role: 'backend',
      files: ['server.js', 'pages/admin.html'],
      kind: 'security',
      sources: [{ runId: 'run-2', subtaskId: 'review-pass', kind: 'security' }],
    }]);

    expect(secondPass.entries).toHaveLength(1);
    expect(secondPass.entries[0].observationCount).toBe(2);
    expect(secondPass.entries[0].files).toEqual(expect.arrayContaining(['server.js', 'pages/admin.html']));
    expect(secondPass.entries[0].sources).toHaveLength(2);
  });

  it('recalls the most role and file-relevant memory first', () => {
    const store = mergeLearningIntoMemoryStore({ entries: [] }, [
      {
        text: 'On the admin dashboard, keep hybrid agent controls behind the super_admin gate in pages/admin.html.',
        role: 'frontend',
        files: ['pages/admin.html'],
        kind: 'ui',
        sources: [{ runId: 'run-1', subtaskId: 'agent-panel', kind: 'ui' }],
      },
      {
        text: 'Database changes should be reviewed with extra care for rollback safety.',
        role: 'database',
        files: ['supabase/migrations/20260401.sql'],
        kind: 'risk',
        sources: [{ runId: 'run-1', subtaskId: 'db-plan', kind: 'risk' }],
      },
    ]);

    const recalled = selectRelevantMemoryEntries(
      store,
      'Improve the hybrid agent controls on the admin dashboard.',
      { role: 'frontend', files: ['pages/admin.html'] }
    );

    expect(recalled[0]?.role).toBe('frontend');
    expect(recalled[0]?.files).toContain('pages/admin.html');

    const marked = markMemoryEntriesUsed(store, recalled);
    const usedEntry = marked.entries.find(entry => entry.id === recalled[0].id);
    expect(usedEntry?.useCount).toBeGreaterThanOrEqual(1);
    expect(formatMemoryRecall(recalled)).toContain('[frontend]');
  });

  it('extracts reusable learnings from primary and advisor results', () => {
    const subtask = {
      id: 'agent-control',
      agent: 'frontend',
      files: ['pages/admin.html'],
    };
    const assignment = {
      primary: { provider: 'openai', model: 'gpt-5.4' },
      advisor: { provider: 'anthropic', model: 'opus' },
    };
    const result = {
      primaryResult: {
        parsed: {
          summary: 'Add a secure control panel card to the master admin dashboard.',
          sharedContext: [
            'The new Agent tab should only render for super_admin users on pages/admin.html.',
          ],
        },
      },
      advisorResult: {
        parsed: {
          sharedContext: [
            'Mirror server-side auth checks so hidden controls are never the only gate.',
          ],
          issues: [
            {
              severity: 'critical',
              description: 'Do not trust client-only role checks for task launch endpoints.',
              fix: 'Enforce super-admin auth in server.js before dispatching runs.',
            },
          ],
        },
      },
    };

    const learned = buildLearningCandidates(subtask, assignment, result, 'run-77');

    expect(learned.length).toBeGreaterThanOrEqual(3);
    expect(learned.every(entry => entry.role === 'frontend')).toBe(true);
    expect(learned.some(entry => entry.text.includes('super_admin users'))).toBe(true);
    expect(learned.some(entry => entry.text.includes('Do not trust client-only role checks'))).toBe(true);
  });
});
