import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { taskCatalog } from '../src/ai/task-catalog';
import { auditTaskCensus } from './audit-task-census';
import { scanForbiddenTaskCatalogPatterns } from './lib/task-census-guards';
import {
  collectRegistrationEvidence,
  hasCapabilityJobRegistrationPath,
  inspectRunLogContract,
} from './lib/task-census-infrastructure';

const sandboxes: string[] = [];

function createSourceFixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'task-census-'));
  sandboxes.push(root);
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, source);
  }
  return root;
}

function auditFixture(catalogKinds: readonly string[], files: Readonly<Record<string, string>>) {
  const root = createSourceFixture(files);
  return auditTaskCensus({ catalogKinds, sourceRoot: root, validateInfrastructure: false });
}

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

describe('auditTaskCensus source discovery', () => {
  it('discovers a new literal caller and de-duplicates repeated calls by kind', () => {
    const result = auditFixture(['NewTask'], {
      'src/route.ts': `
        runTask('NewTask', input, ctx);
        runTask('NewTask', otherInput, ctx);
      `,
    });

    expect(result.ok).toBe(true);
    expect(result.discoveredKinds).toEqual(['NewTask']);
    expect(result.callersByKind.NewTask).toHaveLength(2);
  });

  it('fails with location evidence when a caller invokes an unknown kind', () => {
    const result = auditFixture(['KnownTask'], {
      'src/route.ts': `runTask('UnknownTask', input, ctx);`,
    });

    expect(result.ok).toBe(false);
    expect(result.unknownCallers).toEqual([
      expect.objectContaining({ kind: 'UnknownTask', file: 'src/route.ts', line: 1 }),
    ]);
  });

  it('fails when a catalog kind has no production caller', () => {
    const result = auditFixture(['CalledTask', 'OrphanTask'], {
      'src/route.ts': `runTask('CalledTask', input, ctx);`,
    });

    expect(result.ok).toBe(false);
    expect(result.orphanKinds).toEqual(['OrphanTask']);
  });

  it('permits one explicitly justified non-live catalog kind', () => {
    const root = createSourceFixture({
      'src/route.ts': `runTask('CalledTask', input, ctx);`,
    });
    const result = auditTaskCensus({
      catalogKinds: ['CalledTask', 'CompatibilityTask'],
      sourceRoot: root,
      validateInfrastructure: false,
      nonLiveClassifications: {
        CompatibilityTask: 'Retained for compatibility with persisted task-run history.',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.orphanKinds).toEqual([]);
  });

  it('fails a non-live classification once a production caller exists', () => {
    const root = createSourceFixture({
      'src/route.ts': `runTask('CompatibilityTask', input, ctx);`,
    });
    const result = auditTaskCensus({
      catalogKinds: ['CompatibilityTask'],
      sourceRoot: root,
      validateInfrastructure: false,
      nonLiveClassifications: { CompatibilityTask: 'No current entrypoint.' },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'Non-live classification "CompatibilityTask" is stale because production callers exist',
    );
  });

  it('discovers a CLI caller under scripts', () => {
    const result = auditFixture(['ProfileCriticTask'], {
      'scripts/compile-profile.ts': `
        const result = await runAgentTask('ProfileCriticTask', { draft }, ctx);
      `,
    });

    expect(result.ok).toBe(true);
    expect(result.callersByKind.ProfileCriticTask).toEqual([
      expect.objectContaining({ file: 'scripts/compile-profile.ts', line: 2 }),
    ]);
  });

  it('covers injected aliases and statically resolves local const unions', () => {
    const result = auditFixture(['LightTask', 'HeavyTask', 'StreamedTask'], {
      'src/service.ts': `
        const selectedTask = heavy ? 'HeavyTask' : 'LightTask';
        await params.runTaskFn(selectedTask, input, ctx);
        await deps.runAgentTaskFn('LightTask', input, ctx);
        await streamTaskCollecting('StreamedTask', input, ctx, onText);
      `,
    });

    expect(result.ok).toBe(true);
    expect(result.discoveredKinds).toEqual(['HeavyTask', 'LightTask', 'StreamedTask']);
  });

  it('fails closed when an invocation first argument cannot be resolved', () => {
    const result = auditFixture(['KnownTask'], {
      'src/service.ts': 'await runTaskFn(resolveTaskKind(input), input, ctx);',
    });

    expect(result.ok).toBe(false);
    expect(result.unresolvedCallers).toEqual([
      expect.objectContaining({
        file: 'src/service.ts',
        line: 1,
        expression: 'resolveTaskKind(input)',
      }),
    ]);
  });

  it('ignores tests, comments, strings, and the runner implementation alias delegation', () => {
    const result = auditFixture(['LiveTask'], {
      'src/live.ts': `runTask('LiveTask', input, ctx);`,
      'src/live.test.ts': `runTask('TestOnlyTask', input, ctx);`,
      'src/noise.ts': `
        // runTask('CommentTask', input, ctx)
        const example = "runTask('StringTask', input, ctx)";
      `,
      'src/server/ai/runner.ts': `
        export function runAgentTask(kind: string, input: unknown, ctx: unknown) {
          return runTask(kind, input, ctx);
        }
      `,
    });

    expect(result.ok).toBe(true);
    expect(result.discoveredKinds).toEqual(['LiveTask']);
  });

  it('does not count arbitrary ledger task_kind strings as invocations', () => {
    const result = auditFixture(['LiveTask'], {
      'src/live.ts': `
        runTask('LiveTask', input, ctx);
        writeCostLedger(db, { task_kind: 'LedgerOnlyTask', cost: 1 });
      `,
    });

    expect(result.ok).toBe(true);
    expect(result.discoveredKinds).toEqual(['LiveTask']);
    expect(result.callersByKind.LedgerOnlyTask).toBeUndefined();
  });

  it('does not count developer-only script probes as production invocations', () => {
    const result = auditFixture(['LiveTask'], {
      'src/live.ts': `runTask('LiveTask', input, ctx);`,
      'scripts/dev/probe.ts': `runTask('DeveloperProbeTask', input, ctx);`,
    });

    expect(result.ok).toBe(true);
    expect(result.discoveredKinds).toEqual(['LiveTask']);
  });

  it('ignores a transparent runner adapter while retaining its literal product caller', () => {
    const result = auditFixture(['WrappedTask'], {
      'src/service.ts': `
        const observedRunTaskFn = (kind: string, input: unknown, ctx: unknown) =>
          deps.runTaskFn(kind, input, ctx);
        await executeFeature({ runTaskFn: observedRunTaskFn });
        await runTaskFn('WrappedTask', input, ctx);
      `,
    });

    expect(result.ok).toBe(true);
    expect(result.callersByKind.WrappedTask).toHaveLength(1);
  });
});

describe('task catalog executable-pattern guard', () => {
  it.each([
    ['mutable registration', `registerTask('Task', spec);`],
    ['mutable setter', `registry.setTask('Task', spec);`],
    ['filesystem discovery import', `import { readdirSync } from 'node:fs'; readdirSync('.')`],
    ['glob discovery import', `import fg from 'fast-glob'; fg.sync('**/*.ts')`],
    ['filesystem discovery use', `readdirSync('.')`],
    ['glob discovery use', `globSync('**/*.ts')`],
    ['dynamic task import', `const task = await import('./tasks/' + name);`],
    ['environment owner selection', 'const owner = process.env.TASK_OWNER;'],
    ['fallback owner precedence', 'const selectedOwner = ownerOverride ?? fallbackOwner;'],
    [
      'fallback owner conditional',
      'const selectedOwner = useOverride ? ownerOverride : fallbackOwner;',
    ],
  ])('rejects executable %s', (_label, executable) => {
    const root = createSourceFixture({
      'src/ai/task-catalog.ts': executable,
      'src/ai/owned-task-specs.ts': '',
      'src/capabilities/practice/tasks/index.ts': '',
      'src/capabilities/notes/tasks/index.ts': '',
      'src/capabilities/ingestion/tasks/index.ts': '',
      'src/capabilities/knowledge/tasks/index.ts': '',
      'src/capabilities/agency/tasks/index.ts': '',
      'src/capabilities/copilot/tasks/index.ts': '',
    });
    expect(scanForbiddenTaskCatalogPatterns(root).length).toBeGreaterThan(0);
  });

  it('allows forbidden words in comments and strings', () => {
    const root = createSourceFixture({
      'src/ai/task-catalog.ts': `
        // registerTask, setTask, process.env, import(), fast-glob, fallbackOwner
        export const guidance = "registerTask process.env import('task') fallbackOwner";
      `,
      'src/ai/owned-task-specs.ts': '',
      'src/capabilities/practice/tasks/index.ts': '',
      'src/capabilities/notes/tasks/index.ts': '',
      'src/capabilities/ingestion/tasks/index.ts': '',
      'src/capabilities/knowledge/tasks/index.ts': '',
      'src/capabilities/agency/tasks/index.ts': '',
      'src/capabilities/copilot/tasks/index.ts': '',
    });
    expect(scanForbiddenTaskCatalogPatterns(root)).toEqual([]);
  });

  it('does not inspect registry Copilot prepare imports outside the guarded composition files', () => {
    const root = createSourceFixture({
      'src/ai/task-catalog.ts': '',
      'src/ai/owned-task-specs.ts': '',
      'src/ai/registry.ts': `
        const prepare = () => import('@/capabilities/agency/server/goals/scope');
      `,
      'src/capabilities/practice/tasks/index.ts': '',
      'src/capabilities/notes/tasks/index.ts': '',
      'src/capabilities/ingestion/tasks/index.ts': '',
      'src/capabilities/knowledge/tasks/index.ts': '',
      'src/capabilities/agency/tasks/index.ts': '',
      'src/capabilities/copilot/tasks/index.ts': '',
    });
    expect(scanForbiddenTaskCatalogPatterns(root)).toEqual([]);
  });
});

describe('registered infrastructure evidence', () => {
  it('does not treat a manifest job name as handler reachability', () => {
    const root = createSourceFixture({
      'src/capabilities/index.ts': `
        import { notesCapability } from './notes/manifest';
        export const capabilities = [notesCapability];
      `,
      'src/capabilities/notes/manifest.ts': `
        export const notesCapability = {
          jobs: { handlers: [{
            name: 'note_generate',
            queue: 'agent',
            load: () => import('./jobs/note_generate'),
          }] },
        };
      `,
      'src/capabilities/notes/jobs/note_generate.ts': `
        export const jobName = 'NoteGenerateTask';
      `,
      'src/unregistered.ts': `runTask('NoteGenerateTask', input, ctx);`,
    });

    expect(
      collectRegistrationEvidence(root, {
        NoteGenerateTask: [
          {
            kind: 'NoteGenerateTask',
            file: 'src/unregistered.ts',
            line: 1,
            column: 1,
            callee: 'runTask',
          },
        ],
      }),
    ).toEqual([]);
  });

  it('rejects run-log contract fragments hidden in comments and strings', () => {
    const root = createSourceFixture({
      'src/db/schema.ts': `
        // pgTable(\n  'ai_task_runs'
        const schemaNoise = "task_kind: text('task_kind').notNull()";
      `,
      'src/server/ai/runner.ts': `
        // if (!isKnownTask(kind))
        // const def = tasks[kind]
        // createRunLifecycle<RunTaskResult>({
        // kind,
      `,
      'src/server/ai/run-lifecycle.ts': `
        // kind: TaskKind;
        // this.kind = config.kind;
        // await writeAiTaskRunStarted(this.config.db, {
        // task_kind: this.kind,
      `,
      'src/server/ai/log.ts': `
        // export async function writeAiTaskRunStarted
        // db.insert(ai_task_runs).values({
        // task_kind: entry.task_kind,
      `,
    });

    expect(inspectRunLogContract(root)).toEqual({
      schemaTaskKindColumn: false,
      runnerCatalogGuard: false,
      lifecycleTaskKind: false,
      startWriterTaskKind: false,
    });
  });

  it('rejects capability registration fragments hidden in comments and strings', () => {
    const root = createSourceFixture({
      'src/capabilities/index.ts': `
        import { notesCapability } from './notes/manifest';
        export const capabilities = [notesCapability];
      `,
      'src/capabilities/notes/manifest.ts': 'export const notesCapability = {};',
      'src/server/boss/start-worker.ts': `
        // registerCapabilityJobs
        const noise = 'registerCapabilityJobs(boss, db, capabilities)';
      `,
      'src/server/boss/register-capability-jobs.ts': `
        // cap.jobs?.handlers
        // await decl.load()
        const noise = 'await boss.work(decl.name';
      `,
    });

    expect(hasCapabilityJobRegistrationPath(root)).toBe(false);
  });
});

describe('live taskCatalog census', () => {
  it('derives the catalog census from the frozen live composition root', () => {
    expect(Object.keys(taskCatalog)).toHaveLength(51);
    expect(Object.isFrozen(taskCatalog)).toBe(true);
  });

  it('proves registered handler reachability and the authoritative run-log contract', () => {
    const sourceRoot = path.resolve(import.meta.dirname, '..');
    const result = auditTaskCensus({
      catalogKinds: Object.keys(taskCatalog),
      sourceRoot,
      nonLiveClassifications: {
        AttributionTask: 'Registered compatibility task; production invokes AttributionRerankTask.',
      },
    });

    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.discoveredKinds).toHaveLength(50);
    expect(result.registrationEvidence.some((item) => item.registration === 'manifest-job')).toBe(
      true,
    );
    // YUK-868 — the verify handlers were the last task-invoking legacy central
    // registrations; they are Practice-owned manifest jobs now, so the census no
    // longer requires a legacy-handler link. Pin the three verify jobs as
    // manifest-registered instead (the forward invariant).
    const manifestNames = new Set(
      result.registrationEvidence
        .filter((item) => item.registration === 'manifest-job')
        .map((item) => item.registrationName),
    );
    for (const name of ['quiz_verify', 'source_verify', 'variant_verify']) {
      expect(manifestNames, name).toContain(name);
    }
    expect(result.registrationEvidence.every((item) => item.kind.length > 0)).toBe(true);
    expect(result.runLogContract).toEqual({
      schemaTaskKindColumn: true,
      runnerCatalogGuard: true,
      lifecycleTaskKind: true,
      startWriterTaskKind: true,
    });
    expect(result.profileCriticCaller).toEqual(
      expect.objectContaining({
        kind: 'ProfileCriticTask',
        file: 'scripts/compile-profile.ts',
        callee: 'runAgentTask',
      }),
    );
  });
});
