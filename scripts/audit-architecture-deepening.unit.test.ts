import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type DomainToolOwnershipInput,
  type PublicReadCycleEdge,
  type QueueOwnershipInput,
  type TaskOwnerMapShape,
  auditArchitectureDeepening,
  buildOwnerGraph,
  collectIntraSccEdges,
  findUncataloguedReciprocalReads,
  scanCataloguedReads,
  scanCentralQueueLiterals,
  scanCentralRoots,
  scanDeepImports,
  scanDependencyCeilings,
  scanDomainToolOwnership,
  scanProposalLifecycle,
  scanProviderAttemptCensus,
  scanQueueOwnership,
  scanRecoveryConformance,
  scanTaskCensusConformance,
  scanTaskSpecOwnership,
} from './audit-architecture-deepening';

// YUK-886 (F4.1) — red fixtures for the consolidated architecture-deepening
// audit. Every category named by the issue must FAIL on a synthetic fixture
// and PASS on a clean one:
//   1. 50/52 tasks (census count drift)
//   2. missing CLI caller (ProfileCriticTask / compile-profile)
//   3. duplicate/missing owner (TaskSpec, tool, queue, proposal kind)
//   4. copied TaskDef (central registry copy / aliased definition)
//   5. runtime task locator/discovery (forbidden catalog patterns)
//   6. invalid/unvalidated tool (missing input/output Zod schema)
//   7. central queue literal (domain queue registered centrally)
//   8. proposal switch (central kind dispatch branch)
//   9. event query (central events read model)
//   10. hidden provider fetch/SDK call (attempt-truth wrapper drift)
//   11. unknown-as-zero (cost accounting)
//   12. baseline regression / dependency ceilings
//   13. deep import (central -> capability non-public module)
//   14. write cycle (catalogued read with write signatures)
//   15. uncatalogued read cycle
//   16. hidden write in a catalogued read

const fixtureRoot = mkdtempSync(join(tmpdir(), 'yuk-886-audit-'));

function fixture(path: string, code: string): { path: string; code: string } {
  const target = join(fixtureRoot, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, code);
  return { path, code };
}

afterAll(() => {
  // tmpdir is cleaned by the OS; nothing to assert here.
});

const ownedSpec = (kind: string) => ({
  ownership: 'owned',
  definition: { kind },
  parseText: (text: string) => text,
  outputSchema: { safeParse: (value: unknown) => ({ success: true, data: value }) },
});

const ownerMap = (owner: string, kinds: readonly string[]): TaskOwnerMapShape => ({
  owner,
  specs: Object.fromEntries(kinds.map((kind) => [kind, ownedSpec(kind)])),
});

// ---------------------------------------------------------------------------
// 1/2/3/4/5 — TaskSpec ownership census + census conformance.
// ---------------------------------------------------------------------------

describe('scanTaskSpecOwnership', () => {
  const options = { expectedCount: 4, requiredOwnerOfKind: { ProfileCriticTask: 'ingestion' } };

  it('passes exactly-one-owner maps at the expected count', () => {
    const maps = [
      ownerMap('ingestion', ['ProfileCriticTask', 'VisionExtractTask']),
      ownerMap('practice', ['QuizGenTask', 'NoteTaskX']),
    ];
    expect(scanTaskSpecOwnership(maps, options)).toEqual([]);
  });

  it.each([
    ['under count (50-task regression)', 3],
    ['over count (52-task regression)', 5],
  ])('fails the census on an %s', (_label, count) => {
    const maps = [
      ownerMap('ingestion', ['ProfileCriticTask', 'VisionExtractTask']),
      ownerMap(
        'practice',
        Array.from({ length: count - 2 }, (_, i) => `Task${i}`),
      ),
    ];
    const violations = scanTaskSpecOwnership(maps, options);
    expect(violations.some((violation) => violation.reason.includes('exactly 4'))).toBe(true);
  });

  it('fails a kind owned by two capabilities (duplicate owner)', () => {
    const maps = [
      ownerMap('ingestion', ['ProfileCriticTask', 'VisionExtractTask']),
      ownerMap('practice', ['QuizGenTask', 'VisionExtractTask']),
    ];
    const violations = scanTaskSpecOwnership(maps, options);
    expect(
      violations.some((violation) => violation.reason.includes('registered by 2 capabilities')),
    ).toBe(true);
  });

  it('fails a pinned kind with the wrong or missing owner', () => {
    const wrongOwner = scanTaskSpecOwnership(
      [ownerMap('practice', ['ProfileCriticTask']), ownerMap('ingestion', ['A', 'B', 'C'])],
      options,
    );
    expect(wrongOwner.some((violation) => violation.path === 'ProfileCriticTask')).toBe(true);

    const missing = scanTaskSpecOwnership([ownerMap('ingestion', ['A', 'B', 'C', 'D'])], options);
    expect(missing.some((violation) => violation.reason.includes("owned by 'ingestion'"))).toBe(
      true,
    );
  });

  it('fails a copied TaskDef — two entries sharing one definition object', () => {
    const shared = { kind: 'SharedTask' };
    const maps: TaskOwnerMapShape[] = [
      {
        owner: 'practice',
        specs: {
          RealTask: ownedSpec('RealTask'),
          CloneTask: {
            ownership: 'owned',
            definition: shared,
            parseText: String,
            outputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
          },
          SharedTask: {
            ownership: 'owned',
            definition: shared,
            parseText: String,
            outputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
          },
        },
      },
      { owner: 'ingestion', specs: { ProfileCriticTask: ownedSpec('ProfileCriticTask') } },
    ];
    const violations = scanTaskSpecOwnership(maps, { ...options, expectedCount: 4 });
    expect(violations.some((violation) => violation.reason.includes('copied TaskDef'))).toBe(true);
  });

  it('fails an incomplete owned spec (missing parseText/outputSchema/ownership)', () => {
    const maps: TaskOwnerMapShape[] = [
      {
        owner: 'ingestion',
        specs: {
          ProfileCriticTask: ownedSpec('ProfileCriticTask'),
          Broken: { ownership: 'transitional', definition: { kind: 'Broken' } },
          Fine: ownedSpec('Fine'),
          Also: ownedSpec('Also'),
        },
      },
    ];
    const violations = scanTaskSpecOwnership(maps, options);
    expect(violations.some((violation) => violation.path.includes('Broken'))).toBe(true);
  });
});

describe('scanTaskCensusConformance', () => {
  const clean = {
    catalogCount: 51,
    expectedCount: 51,
    errors: [],
    profileCriticCallerPresent: true,
    forbiddenPatternViolations: [],
  };

  it('passes a conforming census', () => {
    expect(scanTaskCensusConformance(clean)).toEqual([]);
  });

  it('fails the 50/52 census count drift', () => {
    const violations = scanTaskCensusConformance({ ...clean, catalogCount: 50 });
    expect(violations.some((violation) => violation.reason.includes('expected exactly 51'))).toBe(
      true,
    );
  });

  it('fails a missing ProfileCriticTask CLI caller', () => {
    const violations = scanTaskCensusConformance({
      ...clean,
      profileCriticCallerPresent: false,
    });
    expect(violations.some((violation) => violation.reason.includes('exact CLI caller'))).toBe(
      true,
    );
  });

  it('fails census errors (unknown/orphan/unresolved callers)', () => {
    const violations = scanTaskCensusConformance({
      ...clean,
      errors: ['Unknown task kind "GhostTask" at src/route.ts:1:9'],
    });
    expect(violations.some((violation) => violation.reason.includes('GhostTask'))).toBe(true);
  });

  it('fails runtime task locator/discovery patterns surfaced by the guard scan', () => {
    const violations = scanTaskCensusConformance({
      ...clean,
      forbiddenPatternViolations: ['src/ai/task-catalog.ts:9:1: mutable registration'],
    });
    expect(
      violations.some((violation) => violation.reason.includes('runtime task locator/discovery')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6 — DomainTool ownership.
// ---------------------------------------------------------------------------

describe('scanDomainToolOwnership', () => {
  const zod = (): { safeParse: (value: unknown) => { success: boolean; data: unknown } } => ({
    safeParse: (value: unknown) => ({ success: true, data: value }),
  });
  const cleanInput = (): DomainToolOwnershipInput => ({
    declarations: [
      { owner: 'practice', name: 'query_mistakes', hasLoad: true },
      { owner: 'knowledge', name: 'query_knowledge', hasLoad: true },
    ],
    loadedTools: [
      { name: 'query_mistakes', inputSchema: zod(), outputSchema: zod() },
      { name: 'query_knowledge', inputSchema: zod(), outputSchema: zod() },
    ],
    allowlistNames: ['query_mistakes', 'query_knowledge'],
    bridgeValidatesOutput: true,
  });

  it('passes a clean registry', () => {
    expect(scanDomainToolOwnership(cleanInput())).toEqual([]);
  });

  it('fails a tool declared by two owners (duplicate owner)', () => {
    const input: DomainToolOwnershipInput = {
      ...cleanInput(),
      declarations: [
        ...cleanInput().declarations,
        { owner: 'agency', name: 'query_mistakes', hasLoad: false },
      ],
    };
    expect(
      scanDomainToolOwnership(input).some((violation) =>
        violation.reason.includes('DomainTool declared by 2 capabilities'),
      ),
    ).toBe(true);
  });

  it('fails an unvalidated tool — missing output/input Zod schema', () => {
    const noInput: DomainToolOwnershipInput = {
      ...cleanInput(),
      loadedTools: [{ name: 'query_mistakes', inputSchema: null, outputSchema: zod() }],
    };
    expect(scanDomainToolOwnership(noInput).some((v) => v.reason.includes('inputSchema'))).toBe(
      true,
    );
    const noOutput: DomainToolOwnershipInput = {
      ...cleanInput(),
      loadedTools: [{ name: 'query_mistakes', inputSchema: zod(), outputSchema: {} }],
    };
    expect(
      scanDomainToolOwnership(noOutput).some((v) => v.reason.includes('unvalidated DomainTool')),
    ).toBe(true);
  });

  it('fails manifest/registry/allowlist disagreement', () => {
    const unregistered: DomainToolOwnershipInput = {
      ...cleanInput(),
      loadedTools: cleanInput().loadedTools.slice(0, 1),
    };
    expect(
      scanDomainToolOwnership(unregistered).some((v) =>
        v.reason.includes('did not produce a registered tool'),
      ),
    ).toBe(true);

    const unallowlisted: DomainToolOwnershipInput = {
      ...cleanInput(),
      declarations: [
        ...cleanInput().declarations,
        { owner: 'agency', name: 'rogue_tool', hasLoad: false },
      ],
    };
    expect(
      scanDomainToolOwnership(unallowlisted).some((v) => v.reason.includes('allowlist universe')),
    ).toBe(true);

    const orphanAllowlist: DomainToolOwnershipInput = {
      ...cleanInput(),
      allowlistNames: [...cleanInput().allowlistNames, 'ghost_tool'],
    };
    expect(
      scanDomainToolOwnership(orphanAllowlist).some((v) => v.reason.includes('no manifest owner')),
    ).toBe(true);
  });

  it('fails when the MCP bridge stops validating outputs', () => {
    const input: DomainToolOwnershipInput = { ...cleanInput(), bridgeValidatesOutput: false };
    expect(scanDomainToolOwnership(input).some((v) => v.reason.includes('YUK-862'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7 — pg-boss queue ownership.
// ---------------------------------------------------------------------------

describe('scanQueueOwnership', () => {
  const cleanInput = (): QueueOwnershipInput => ({
    declarations: [
      { owner: 'practice', name: 'judge_run', queueTier: 'llm', hasLoad: true },
      { owner: 'notes', name: 'note_generate', queueTier: 'agent', hasLoad: true },
    ],
    centralLiterals: [
      { path: 'src/server/boss/handlers.ts', api: 'work' as const, name: 'echo' },
      { path: 'src/server/boss/handlers.ts', api: 'work' as const, name: 'prune_job_events' },
    ],
    housekeepingQueues: ['echo', 'prune_job_events'],
    moduleOwnedQueues: ['memory_event_ingest'],
  });

  it('passes housekeeping-only central registrations', () => {
    expect(scanQueueOwnership(cleanInput())).toEqual([]);
  });

  it('fails a central queue literal for an undeclared domain queue (central semantic registration)', () => {
    const input: QueueOwnershipInput = {
      ...cleanInput(),
      centralLiterals: [
        ...cleanInput().centralLiterals,
        { path: 'src/server/boss/handlers.ts', api: 'work', name: 'dreaming_nightly' },
      ],
    };
    expect(
      scanQueueOwnership(input).some((v) =>
        v.reason.includes('central semantic queue registration'),
      ),
    ).toBe(true);
  });

  it('fails a central re-registration of a manifest-owned queue (metadata parity)', () => {
    const input: QueueOwnershipInput = {
      ...cleanInput(),
      centralLiterals: [
        { path: 'src/server/boss/handlers.ts', api: 'schedule', name: 'note_generate' },
      ],
    };
    expect(
      scanQueueOwnership(input).some((v) => v.reason.includes('exactly one registration site')),
    ).toBe(true);
  });

  it('fails a queue declared by two owners and invalid registration metadata', () => {
    const input: QueueOwnershipInput = {
      ...cleanInput(),
      declarations: [
        ...cleanInput().declarations,
        { owner: 'agency', name: 'judge_run', queueTier: 'llm', hasLoad: true },
        {
          owner: 'practice',
          name: 'bad_poll',
          queueTier: 'turbo',
          hasLoad: true,
          pollingIntervalSeconds: 0,
        },
      ],
    };
    const violations = scanQueueOwnership(input);
    expect(violations.some((v) => v.reason.includes('declared by 2 capabilities'))).toBe(true);
    expect(violations.some((v) => v.reason.includes('invalid queue tier'))).toBe(true);
    expect(violations.some((v) => v.reason.includes('pollingIntervalSeconds'))).toBe(true);
  });

  it('derives central literals from source code (scanCentralQueueLiterals)', () => {
    const sources = [
      fixture(
        'src/server/boss/handlers.ts',
        `await boss.work('echo', handler);\nawait boss.send('judge_run', {});\nawait createJobQueue(boss, 'note_generate', 1);\n`,
      ),
      fixture('src/server/boss/handlers/evil.test.ts', `await boss.work('test_only', h);\n`),
    ];
    const literals = scanCentralQueueLiterals(sources, ['src/server/boss/']);
    expect(literals.map((literal) => `${literal.api}:${literal.name}`).sort()).toEqual([
      'create:note_generate',
      'send:judge_run',
      'work:echo',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 9 — proposal lifecycle ownership.
// ---------------------------------------------------------------------------

describe('scanProposalLifecycle', () => {
  const cleanInput = () => ({
    declarations: [
      {
        owner: 'knowledge',
        kind: 'knowledge_edge',
        hasAccept: true,
        hasDismiss: true,
        hasRetract: false,
      },
      {
        owner: 'knowledge',
        kind: 'archive',
        hasAccept: false,
        hasDismiss: false,
        hasRetract: false,
      },
      {
        owner: 'practice',
        kind: 'variant_question',
        hasAccept: true,
        hasDismiss: true,
        hasRetract: true,
      },
    ],
    supportedKinds: ['knowledge_edge', 'archive', 'variant_question'],
    producerOnlyKinds: ['archive'],
  });

  it('passes a clean lifecycle', () => {
    expect(scanProposalLifecycle(cleanInput())).toEqual([]);
  });

  it('fails a supported kind without any owner (missing owner)', () => {
    const input = cleanInput();
    input.supportedKinds = [...input.supportedKinds, 'goal_scope'];
    expect(
      scanProposalLifecycle(input).some(
        (v) => v.path === 'goal_scope' && v.reason.includes('missing owner'),
      ),
    ).toBe(true);
  });

  it('fails a kind declared by two owners (duplicate owner)', () => {
    const input = cleanInput();
    input.declarations = [
      ...input.declarations,
      {
        owner: 'agency',
        kind: 'knowledge_edge',
        hasAccept: true,
        hasDismiss: false,
        hasRetract: false,
      },
    ];
    expect(
      scanProposalLifecycle(input).some((v) => v.reason.includes('declared by 2 capabilities')),
    ).toBe(true);
  });

  it('fails a decidable kind without an accept declaration (unsupported declaration)', () => {
    const input = cleanInput();
    input.declarations = input.declarations.map((declaration) =>
      declaration.kind === 'variant_question' ? { ...declaration, hasAccept: false } : declaration,
    );
    expect(scanProposalLifecycle(input).some((v) => v.reason.includes('accept applier'))).toBe(
      true,
    );
  });

  it('fails a phantom kind and a stale producer-only classification', () => {
    const input = cleanInput();
    input.declarations = [
      ...input.declarations,
      {
        owner: 'agency',
        kind: 'phantom_kind',
        hasAccept: true,
        hasDismiss: false,
        hasRetract: false,
      },
    ];
    input.producerOnlyKinds = ['archive', 'knowledge_edge'];
    const violations = scanProposalLifecycle(input);
    expect(violations.some((v) => v.reason.includes('phantom proposal kind'))).toBe(true);
    expect(violations.some((v) => v.reason.includes('stale producer-only'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10 — recovery conformance wiring.
// ---------------------------------------------------------------------------

describe('scanRecoveryConformance', () => {
  it('passes when every suite exists and fails each missing suite', () => {
    const all = [
      'src/capabilities/notes/server/note-handoff.db.test.ts',
      'src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts',
      'src/server/memory/memory-reconcile-handoff-recovery.db.test.ts',
      'src/server/memory/reconcile-handler.db.test.ts',
      'src/server/boss/verify-dispatch-outbox.db.test.ts',
    ];
    expect(scanRecoveryConformance(all)).toEqual([]);
    for (const dropped of all) {
      const remaining = all.filter((path) => path !== dropped);
      const violations = scanRecoveryConformance(remaining);
      expect(violations, dropped).toHaveLength(1);
      expect(violations[0]?.path).toBe(dropped);
    }
  });
});

// ---------------------------------------------------------------------------
// 11 — provider attempt census composition.
// ---------------------------------------------------------------------------

describe('scanProviderAttemptCensus', () => {
  const clean = {
    attemptTruthViolations: [],
    classifiedLaneFindings: 7,
    unclassifiedFindings: 0,
  };

  it('passes a fully classified census', () => {
    expect(scanProviderAttemptCensus(clean)).toEqual([]);
  });

  it('fails an unclassified provider wire (hidden provider fetch/SDK call)', () => {
    const violations = scanProviderAttemptCensus({
      ...clean,
      attemptTruthViolations: [
        {
          path: 'src/server/ai/embed.ts',
          rule: 'missing-attempt-wrapper',
          detail: 'missing executeDirectProviderAttempt',
        },
      ],
    });
    expect(violations.some((v) => v.reason.includes('executeDirectProviderAttempt'))).toBe(true);
  });

  it('fails unknown-as-zero accounting surfaced by the attempt-truth audit', () => {
    const violations = scanProviderAttemptCensus({
      ...clean,
      attemptTruthViolations: [
        {
          path: 'src/server/memory/triggers.ts',
          rule: 'zero-cost-accounting',
          detail: 'contains direct cost: 0',
        },
      ],
    });
    expect(violations.some((v) => v.reason.includes('contains direct cost: 0'))).toBe(true);
  });

  it('fails an unclassified wire census and an empty (zero) census', () => {
    expect(
      scanProviderAttemptCensus({ ...clean, unclassifiedFindings: 2 }).some((v) =>
        v.reason.includes('unclassified provider wire'),
      ),
    ).toBe(true);
    expect(
      scanProviderAttemptCensus({ ...clean, classifiedLaneFindings: 0 }).some((v) =>
        v.reason.includes('must enumerate the explicit direct lanes'),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12 — dependency ceilings + baseline regression.
// ---------------------------------------------------------------------------

describe('scanDependencyCeilings', () => {
  it('passes the audited totals strictly below 531/70/62 with zero deep buckets', () => {
    expect(
      scanDependencyCeilings({
        totals: { capabilityToServer: 461, serverToCapabilityDeep: 0, crossCapabilityValue: 48 },
        deepPairCounts: {},
      }),
    ).toEqual([]);
  });

  it('fails totals at or above the ceilings (baseline regression)', () => {
    const violations = scanDependencyCeilings({
      totals: { capabilityToServer: 531, serverToCapabilityDeep: 70, crossCapabilityValue: 62 },
      deepPairCounts: {},
    });
    expect(violations).toHaveLength(3);
    expect(violations.every((v) => v.reason.includes('not strictly below the ceiling'))).toBe(true);
  });

  it('fails any nonzero server->capability-deep owner bucket', () => {
    const violations = scanDependencyCeilings({
      totals: { capabilityToServer: 461, serverToCapabilityDeep: 2, crossCapabilityValue: 48 },
      deepPairCounts: { 'ai -> knowledge': 2 },
    });
    expect(violations.some((v) => v.reason.includes('targeted owner bucket must be zero'))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// 13/14/15/16 + 8/9 — the YUK-885 ownership families, consolidated.
// ---------------------------------------------------------------------------

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
        `const m = await import('@/capabilities/knowledge/server/tree');\n`,
      ),
      fixture(
        'src/server/mastery/deep-type.ts',
        `import type { KnowledgeNode } from '@/capabilities/knowledge/server/tree';\n`,
      ),
    ];
    const violations = scanDeepImports(sources);
    expect(violations.map((violation) => violation.path).sort()).toEqual([
      'src/server/events/deep-dynamic.ts',
      'src/server/mastery/deep-type.ts',
    ]);
  });

  it('passes public-port and ui-public imports and ignores non-capability imports and tests', () => {
    const sources = [
      fixture(
        'src/server/ai/tools/clean.ts',
        `import { applyQuestionEdit } from '@/capabilities/practice/public';\n`,
      ),
      fixture(
        'src/server/whatever.ts',
        `import type { NoteSummary } from '@/capabilities/notes/ui-public';\nimport { event } from '@/db/schema';\n`,
      ),
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

  it.each([
    ['drizzle insert (hidden write)', 'await tx.insert(event).values({});'],
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
  ])('fails a catalogued read containing a %s (write cycle)', (_label, code) => {
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

  it('fails a command file listed outside the entry files and a stale entry', () => {
    const stale: PublicReadCycleEdge = {
      ...entry,
      commandFiles: ['src/capabilities/agency/server/orphan-writer.ts'],
    };
    const sources = [
      fixture('src/capabilities/agency/server/meeting/director.ts', 'export const x = 1;\n'),
    ];
    const violations = scanCataloguedReads([stale], sources);
    expect(violations.some((v) => v.reason.includes('commandFiles'))).toBe(true);
    expect(violations.some((v) => v.reason.includes('no longer imports'))).toBe(true);
  });
});

describe('findUncataloguedReciprocalReads', () => {
  it('fails an intra-SCC edge direction missing from the catalog (uncatalogued read cycle)', () => {
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
  it('fails the presence of the legacy task quarry file (central semantic definition)', () => {
    const sources = [fixture('src/ai/legacy-task-definitions.ts', 'export const x = {};\n')];
    const violations = scanCentralRoots(sources);
    expect(violations.some((violation) => violation.reason.includes('quarry'))).toBe(true);
  });

  it('fails a copied TaskDef reintroduced into src/ai/registry.ts', () => {
    const sources = [
      fixture(
        'src/ai/registry.ts',
        `export const AttributionTask = {\n  kind: 'AttributionTask',\n  defaultProvider: 'xiaomi',\n  defaultModel: 'mimo-v2.5',\n  budget: { maxIterations: 6 },\n};\n`,
      ),
    ];
    const violations = scanCentralRoots(sources);
    expect(
      violations.some((violation) =>
        violation.reason.includes('pure static compatibility projection'),
      ),
    ).toBe(true);
  });

  it('fails proposal-kind dispatch branches in the central proposals action files (proposal switch)', () => {
    const sources = [
      fixture(
        'src/server/proposals/accept-action.ts',
        `switch (proposal.payload.kind) {\n  case 'knowledge_edge':\n    break;\n}\n`,
      ),
    ];
    const violations = scanCentralRoots(sources);
    expect(violations.some((violation) => violation.reason.includes('proposal-kind'))).toBe(true);
  });

  it('fails a domain queue registration in the central boss handlers file', () => {
    const sources = [
      fixture(
        'src/server/boss/handlers.ts',
        `import { buildJudgeRunHandler } from '@/capabilities/practice/jobs/judge_run';\nawait boss.work('judge_run', handler);\n`,
      ),
    ];
    const violations = scanCentralRoots(sources);
    expect(violations.some((violation) => violation.reason.includes('queue'))).toBe(true);
  });

  it('fails a reintroduced central event read model (event query)', () => {
    const sources = [
      fixture(
        'src/server/events/queries.ts',
        'export async function getFailureAttempts(db) { return []; }\n',
      ),
    ];
    const violations = scanCentralRoots(sources);
    expect(violations.some((violation) => violation.path === 'src/server/events/queries.ts')).toBe(
      true,
    );
  });

  it('passes the known central events transport files', () => {
    const sources = [
      fixture('src/server/events/writer.ts', 'export async function writeJobEvent() {}\n'),
      fixture('src/server/events/sse_router.ts', 'export function broadcast() {}\n'),
    ];
    expect(
      scanCentralRoots(sources).filter((violation) =>
        violation.path.startsWith('src/server/events'),
      ),
    ).toEqual([]);
  });

  it('fails a NEW central concrete tool file', () => {
    const sources = [
      fixture(
        'src/server/ai/tools/some-new-tool.ts',
        `export const someNewTool: DomainTool = { name: 'some_new_tool' };\n`,
      ),
    ];
    const violations = scanCentralRoots(sources);
    expect(violations.some((violation) => violation.reason.includes('central concrete tool'))).toBe(
      true,
    );
  });
});

// YUK-892 — the seven transitional central tool files are deleted and their
// tools live with their owning capabilities. Repo-state deletion test: fails
// while any central concrete tool file still exists on disk.
describe('central concrete tool deletion (repo state)', () => {
  const CENTRAL_CONCRETE_TOOL_PATHS = [
    'src/server/ai/tools/proposal-tools.ts',
    'src/server/ai/tools/context-readers.ts',
    'src/server/ai/tools/get-attempt-context.ts',
    'src/server/ai/tools/query-mistakes.ts',
    'src/server/ai/tools/query-questions.ts',
    'src/server/ai/tools/write-quiz.ts',
    'src/server/ai/tools/tool-quiz-core.ts',
  ] as const;

  it('deletes every transitional central tool file (tools live with their owners)', () => {
    const remaining = CENTRAL_CONCRETE_TOOL_PATHS.filter((path) => existsSync(path));
    expect(remaining).toEqual([]);
  });

  it('owns the migrated tools in their capability trees', () => {
    const OWNED_PATHS = [
      'src/capabilities/practice/server/tools/get-attempt-context.ts',
      'src/capabilities/practice/server/tools/query-mistakes.ts',
      'src/capabilities/practice/server/tools/query-questions.ts',
      'src/capabilities/practice/server/tools/write-quiz.ts',
      'src/capabilities/practice/server/tools/tool-quiz-core.ts',
      'src/capabilities/practice/server/tools/question-context.ts',
      'src/capabilities/practice/server/tools/proposal-tools.ts',
      'src/capabilities/practice/server/tools/question-author.ts',
      'src/capabilities/ingestion/server/tools/proposal-tools.ts',
      'src/capabilities/copilot/server/tools/memory-brief.ts',
    ] as const;
    const missing = OWNED_PATHS.filter((path) => !existsSync(path));
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Composed audit — one synthetic repo proving the composed result aggregates
// every family and the counts report reflects the facts.
// ---------------------------------------------------------------------------

describe('auditArchitectureDeepening (composed)', () => {
  it('aggregates every check family into one ok/fail verdict with counts', () => {
    // Isolated root: the composed audit rescans the whole project tree, so it
    // must not observe the red fixtures written by the per-family tests above.
    const composedRoot = mkdtempSync(join(tmpdir(), 'yuk-886-composed-'));
    const composedFixture = (path: string, code: string): void => {
      const target = join(composedRoot, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, code);
    };
    composedFixture('src/capabilities/agency/server/reader.ts', 'export const x = 1;\n');
    composedFixture('src/server/boss/handlers.ts', "await boss.work('echo', h);\n");
    composedFixture('src/ai/registry.ts', 'export const tasks = {};\n');
    const facts = {
      ownerMaps: [ownerMap('ingestion', ['ProfileCriticTask', 'A']), ownerMap('practice', ['B'])],
      expectedTaskCount: 3,
      taskCensus: {
        catalogCount: 3,
        expectedCount: 3,
        errors: [],
        profileCriticCallerPresent: true,
        forbiddenPatternViolations: [],
      },
      tools: {
        declarations: [{ owner: 'practice', name: 'query_mistakes', hasLoad: true }],
        loadedTools: [
          {
            name: 'query_mistakes',
            inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
            outputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
          },
        ],
        allowlistNames: ['query_mistakes'],
        bridgeValidatesOutput: true,
      },
      queues: {
        declarations: [
          { owner: 'notes', name: 'note_generate', queueTier: 'agent', hasLoad: true },
        ],
        centralLiterals: [
          { path: 'src/server/boss/handlers.ts', api: 'work' as const, name: 'echo' },
        ],
        housekeepingQueues: ['echo'],
        moduleOwnedQueues: [],
      },
      proposals: {
        declarations: [
          {
            owner: 'knowledge',
            kind: 'knowledge_edge',
            hasAccept: true,
            hasDismiss: true,
            hasRetract: false,
          },
        ],
        supportedKinds: ['knowledge_edge'],
        producerOnlyKinds: [],
      },
      recoverySuitePaths: [
        'src/capabilities/notes/server/note-handoff.db.test.ts',
        'src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts',
        'src/server/memory/memory-reconcile-handoff-recovery.db.test.ts',
        'src/server/memory/reconcile-handler.db.test.ts',
        'src/server/boss/verify-dispatch-outbox.db.test.ts',
      ],
      providerAttemptCensus: {
        attemptTruthViolations: [],
        classifiedLaneFindings: 7,
        unclassifiedFindings: 0,
      },
      dependency: {
        totals: { capabilityToServer: 461, serverToCapabilityDeep: 0, crossCapabilityValue: 48 },
        deepPairCounts: {},
        baselineViolations: [],
      },
    };

    const clean = auditArchitectureDeepening(composedRoot, [], facts);
    expect(clean.violations).toEqual([]);
    expect(clean.ok).toBe(true);
    expect(clean.counts.taskSpecs).toBe(3);
    expect(clean.counts.domainTools).toBe(1);
    expect(clean.counts.manifestQueues).toBe(1);
    expect(clean.counts.proposalKinds).toBe(1);
    expect(clean.counts.centralSemanticQueueRegistrations).toBe(0);
    expect(clean.counts.centralKindSwitches).toBe(0);

    const dirty = auditArchitectureDeepening(composedRoot, [], {
      ...facts,
      queues: {
        ...facts.queues,
        centralLiterals: [
          ...facts.queues.centralLiterals,
          { path: 'src/server/boss/handlers.ts', api: 'work' as const, name: 'note_generate' },
        ],
      },
      taskCensus: { ...facts.taskCensus, profileCriticCallerPresent: false },
    });
    expect(dirty.ok).toBe(false);
    expect(dirty.violations.some((v) => v.reason.includes('exactly one registration site'))).toBe(
      true,
    );
    expect(dirty.violations.some((v) => v.reason.includes('exact CLI caller'))).toBe(true);
    expect(dirty.counts.centralSemanticQueueRegistrations).toBe(0); // re-registration, not semantic
  });
});
