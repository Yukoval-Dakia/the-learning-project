import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type PublicReadCycleEdge,
  buildOwnerGraph,
  collectIntraSccEdges,
  findUncataloguedReciprocalReads,
  scanCataloguedReads,
  scanCentralRoots,
  scanDeepImports,
} from './audit-architecture-ownership';

// YUK-885 (F3.11) — red fixtures for the architecture-ownership audit. Every
// category named by the issue must FAIL on a synthetic fixture and PASS on a
// clean one:
//   1. deep imports (central -> capability non-public module)
//   2. semantic/write cycles (a catalogued "read" file that secretly writes)
//   3. directed command cycles (a catalogued read consuming a command symbol)
//   4. uncatalogued reciprocal reads (an intra-SCC edge missing from the catalog)
//   5. catalogued "reads" containing the issue's forbidden write signatures
//      (Drizzle insert/update/delete/transaction, boss.send/work/schedule,
//      proposal/event writers, provider calls, write/propose tools)

const fixtureRoot = mkdtempSync(join(tmpdir(), 'yuk-885-audit-'));

function fixture(path: string, code: string): { path: string; code: string } {
  const target = join(fixtureRoot, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, code);
  return { path, code };
}

afterAll(() => {
  // tmpdir is cleaned by the OS; nothing to assert here.
});

describe('scanDeepImports', () => {
  it('fails a deep central import of a capability server module', () => {
    const sources = [
      fixture(
        'src/server/ai/tools/evil.ts',
        `import { applyQuestionEdit } from '@/capabilities/practice/server/proposal-appliers';\n`,
      ),
    ];
    const violations = scanDeepImports(sources);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain('deep');
    expect(violations[0]?.source).toBe('@/capabilities/practice/server/proposal-appliers');
  });

  it('fails a deep dynamic import and a deep type-only import', () => {
    const sources = [
      fixture(
        'src/server/events/deep-dynamic.ts',
        `const m = await import('@/capabilities/knowledge/server/domain');\n`,
      ),
      fixture(
        'src/server/mastery/deep-type.ts',
        `import type { Domain } from '@/capabilities/knowledge/server/domain';\n`,
      ),
    ];
    const violations = scanDeepImports(sources);
    expect(violations.map((violation) => violation.path).sort()).toEqual([
      'src/server/events/deep-dynamic.ts',
      'src/server/mastery/deep-type.ts',
    ]);
  });

  it('passes public-port and ui-public imports and ignores non-capability imports', () => {
    const sources = [
      fixture(
        'src/server/ai/tools/clean.ts',
        `import { applyQuestionEdit } from '@/capabilities/practice/public';\n`,
      ),
      fixture(
        'src/server/whatever.ts',
        `import type { NoteSummary } from '@/capabilities/notes/ui-public';\nimport { event } from '@/db/schema';\n`,
      ),
    ];
    expect(scanDeepImports(sources)).toEqual([]);
  });

  it('ignores test files', () => {
    const sources = [
      fixture(
        'src/server/ai/tools/evil.test.ts',
        `import { x } from '@/capabilities/practice/server/deep';\n`,
      ),
    ];
    expect(scanDeepImports(sources)).toEqual([]);
  });
});

describe('scanCataloguedReads', () => {
  const entry: PublicReadCycleEdge = {
    owner: 'knowledge',
    consumer: 'agency',
    files: ['src/capabilities/agency/server/meeting/director.ts'],
    symbols: ['getFailureAttempts'],
    dto: 'FailureAttempt[]',
    justification: '例会 director grounds claims in first-hand failure evidence.',
    reviewIssue: 'YUK-885',
    commandFiles: [],
  };

  it('fails a catalogued read file containing a Drizzle insert (hidden write)', () => {
    const sources = [
      fixture(
        'src/capabilities/agency/server/meeting/director.ts',
        `import { getFailureAttempts } from '@/capabilities/knowledge/public';\nawait db.insert(event).values({});\n`,
      ),
    ];
    const violations = scanCataloguedReads([entry], sources);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain('write');
  });

  it.each([
    ['drizzle insert', 'await tx.insert(event).values({});'],
    ['drizzle update', 'await db.update(goal).set({});'],
    ['drizzle delete', 'await db.delete(event).where(x);'],
    ['drizzle transaction', 'await db.transaction(async () => {});'],
    ['boss.send', `await boss.send('note_verify', {});`],
    ['boss.work', `await boss.work('note_verify', handler);`],
    ['boss.schedule', `await boss.schedule('prune', '* * * * *');`],
    ['event writer', 'await writeEvent(db, payload);'],
    ['proposal writer', 'await writeAiProposal(db, input);'],
    ['provider call', `await runTask({ kind: 'AttributionTask' });`],
    ['provider stream call', `await streamTask({ kind: 'CopilotTask' });`],
    ['write tool', `export const tool = { name: 't', effect: 'write' };`],
    ['propose tool', `export const tool = { name: 't', effect: 'propose' };`],
  ])('fails a catalogued read containing a %s', (_label, code) => {
    const sources = [
      fixture(
        'src/capabilities/agency/server/meeting/director.ts',
        `import { getFailureAttempts } from '@/capabilities/knowledge/public';\n${code}\n`,
      ),
    ];
    expect(scanCataloguedReads([entry], sources)).toHaveLength(1);
  });

  it('fails a catalogued read consuming a command symbol from the port (directed command cycle)', () => {
    const sources = [
      fixture(
        'src/capabilities/agency/server/meeting/director.ts',
        `import { applyArchive } from '@/capabilities/knowledge/public';\nexport const marker = 1;\n`,
      ),
    ];
    const violations = scanCataloguedReads([entry], sources);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain('command');
  });

  it('passes a pure read consumer and a declared command file', () => {
    const sources = [
      fixture(
        'src/capabilities/agency/server/meeting/director.ts',
        `import { getFailureAttempts } from '@/capabilities/knowledge/public';\n`,
      ),
      fixture(
        'src/capabilities/agency/server/goals/queries.ts',
        `import { resolveSubjectKnowledgeIds } from '@/capabilities/knowledge/public';\nawait db.insert(goal).values({});\n`,
      ),
    ];
    const withCommand: PublicReadCycleEdge = {
      ...entry,
      files: [...entry.files, 'src/capabilities/agency/server/goals/queries.ts'],
      symbols: [...entry.symbols, 'resolveSubjectKnowledgeIds'],
      commandFiles: ['src/capabilities/agency/server/goals/queries.ts'],
    };
    expect(scanCataloguedReads([withCommand], sources)).toEqual([]);
  });

  it('fails a command file listed outside the entry files (stale command classification)', () => {
    const sources = [
      fixture(
        'src/capabilities/agency/server/meeting/director.ts',
        `import { getFailureAttempts } from '@/capabilities/knowledge/public';\n`,
      ),
      fixture(
        'src/capabilities/agency/server/orphan-writer.ts',
        'await db.insert(event).values({});\n',
      ),
    ];
    const stale: PublicReadCycleEdge = {
      ...entry,
      commandFiles: ['src/capabilities/agency/server/orphan-writer.ts'],
    };
    const violations = scanCataloguedReads([stale], sources);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain('commandFiles');
  });

  it('fails a catalog entry naming a file that no longer imports the port (stale entry)', () => {
    const sources = [
      fixture(
        'src/capabilities/agency/server/meeting/director.ts',
        'export const unrelated = 1;\n',
      ),
    ];
    const violations = scanCataloguedReads([entry], sources);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain('no longer imports');
  });
});

describe('findUncataloguedReciprocalReads', () => {
  it('fails an intra-SCC edge direction missing from the catalog', () => {
    const edges = [
      { from: 'agency', to: 'knowledge', file: 'src/capabilities/agency/jobs/nightly.ts' },
      { from: 'knowledge', to: 'agency', file: 'src/capabilities/knowledge/server/review.ts' },
    ];
    const violations = findUncataloguedReciprocalReads(edges, []);
    expect(violations).toHaveLength(2);
    expect(violations[0]?.reason).toContain('uncatalogued');
  });

  it('passes when every intra-SCC direction is catalogued and ignores non-cycle edges', () => {
    const edges = [
      { from: 'agency', to: 'knowledge', file: 'src/capabilities/agency/jobs/nightly.ts' },
      { from: 'knowledge', to: 'agency', file: 'src/capabilities/knowledge/server/review.ts' },
      { from: 'observability', to: 'practice', file: 'src/capabilities/observability/api/x.ts' },
    ];
    const catalog: PublicReadCycleEdge[] = [
      {
        owner: 'knowledge',
        consumer: 'agency',
        files: ['src/capabilities/agency/jobs/nightly.ts'],
        symbols: ['loadTreeSnapshot'],
        dto: 'TreeSnapshot',
        justification: 'nightly frontier grounds on the tree snapshot',
        reviewIssue: 'YUK-885',
        commandFiles: [],
      },
      {
        owner: 'agency',
        consumer: 'knowledge',
        files: ['src/capabilities/knowledge/server/review.ts'],
        symbols: ['readAgentNotes'],
        dto: 'AgentNote[]',
        justification: 'knowledge review reads agency notes for grounding',
        reviewIssue: 'YUK-885',
        commandFiles: ['src/capabilities/knowledge/server/review.ts'],
      },
    ];
    expect(findUncataloguedReciprocalReads(edges, catalog)).toEqual([]);
  });

  it('collectIntraSccEdges returns only edges inside a multi-owner SCC', () => {
    const edges = [
      { from: 'a', to: 'b', file: 'f1' },
      { from: 'b', to: 'a', file: 'f2' },
      { from: 'b', to: 'c', file: 'f3' },
      { from: 'c', to: 'c2', file: 'f4' },
    ];
    expect(collectIntraSccEdges(edges)).toEqual([
      { from: 'a', to: 'b', file: 'f1' },
      { from: 'b', to: 'a', file: 'f2' },
    ]);
  });

  it('buildOwnerGraph derives value edges from real import statements', () => {
    const graph = buildOwnerGraph([
      {
        path: 'src/capabilities/agency/server/x.ts',
        code: `import { loadTreeSnapshot } from '@/capabilities/knowledge/public';\nimport type { Foo } from '@/capabilities/notes/public';\nimport { helper } from '../same-owner-file';\n`,
      },
    ]);
    expect(graph).toEqual([
      { from: 'agency', to: 'knowledge', file: 'src/capabilities/agency/server/x.ts' },
    ]);
  });
});

describe('scanCentralRoots', () => {
  it('fails the presence of the legacy task quarry file', () => {
    const sources = [fixture('src/ai/legacy-task-definitions.ts', 'export const x = {};\n')];
    const violations = scanCentralRoots(sources, []);
    expect(violations.some((violation) => violation.reason.includes('quarry'))).toBe(true);
  });

  it('fails semantic definitions reintroduced into src/ai/registry.ts', () => {
    const sources = [
      fixture(
        'src/ai/registry.ts',
        'function buildAttributionPrompt(profile) { return profile; }\nexport const tasks = {};\n',
      ),
    ];
    const violations = scanCentralRoots(sources, []);
    expect(violations.some((violation) => violation.reason.includes('registry'))).toBe(true);
  });

  it('fails proposal-kind dispatch branches in the central proposals action files', () => {
    const sources = [
      fixture(
        'src/server/proposals/accept-action.ts',
        `switch (proposal.payload.kind) {\n  case 'knowledge_edge':\n    break;\n}\n`,
      ),
    ];
    const violations = scanCentralRoots(sources, []);
    expect(violations.some((violation) => violation.reason.includes('proposal-kind'))).toBe(true);
  });

  it('fails a domain queue registration in the central boss handlers file', () => {
    const sources = [
      fixture(
        'src/server/boss/handlers.ts',
        `import { buildJudgeRunHandler } from '@/capabilities/practice/jobs/judge_run';\nawait boss.work('judge_run', handler);\n`,
      ),
    ];
    const violations = scanCentralRoots(sources, []);
    expect(violations.some((violation) => violation.reason.includes('queue'))).toBe(true);
  });

  it('fails a domain read model exported from the central events transport', () => {
    const sources = [
      fixture(
        'src/server/events/queries.ts',
        'export async function getFailureAttempts(db) { return []; }\n',
      ),
    ];
    const violations = scanCentralRoots(sources, []);
    expect(violations.some((violation) => violation.reason.includes('read model'))).toBe(true);
  });

  it('fails a NEW central concrete tool file outside the transitional allowlist', () => {
    const sources = [
      fixture(
        'src/server/ai/tools/some-new-tool.ts',
        `export const someNewTool: DomainTool = { name: 'some_new_tool' };\n`,
      ),
    ];
    const violations = scanCentralRoots(sources, []);
    expect(violations.some((violation) => violation.reason.includes('central concrete tool'))).toBe(
      true,
    );
  });

  it('passes an allowlisted transitional central tool file', () => {
    const sources = [
      fixture('src/server/ai/tools/proposal-tools.ts', 'export const authorQuestionTool = {};\n'),
    ];
    const violations = scanCentralRoots(sources, ['src/server/ai/tools/proposal-tools.ts']);
    expect(
      violations.filter((violation) => violation.reason.includes('central concrete tool')),
    ).toEqual([]);
  });
});
