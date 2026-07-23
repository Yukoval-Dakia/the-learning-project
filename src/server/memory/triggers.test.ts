import type { Job } from 'pg-boss';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryClientMock } from '../../../tests/helpers/memory-client-mock';
import { resolveQualifyingEventSubjects } from './active-subjects';
import {
  MAX_BRIEF_REGEN_SCOPES,
  MEMORY_BRIEF_REGEN_QUEUE,
  MEMORY_BRIEF_SWEEP_QUEUE,
  MEMORY_EVENT_INGEST_QUEUE,
  MEMORY_INGEST_OUTBOX_POLL_QUEUE,
  MEMORY_INGEST_OUTBOX_RECOVER_QUEUE,
  MEMORY_RECONCILE_QUEUE,
  buildMemoryEventIngestHandler,
  enqueueBriefRegen,
  enqueueMemoryReconcile,
  registerMemoryHandlers,
  shouldExtractToMemory,
} from './triggers';

// YUK-581 — the ingest handler's subject brief bridge calls
// resolveQualifyingEventSubjects (a DB-touching resolver). Mock ONLY that export
// (spread the rest — QUALIFYING_ACTIONS, listActiveSubjectsSinceRefresh, … stay
// real) so the ingest-handler logic is unit-testable without a live Postgres; the
// resolver's own DB contract is covered separately in active-subjects.db.test.ts.
// The default returns an empty Map so the pre-existing ingest tests (which drive
// qualifying `attempt` events) see no extra enqueue and their send counts hold.
vi.mock('./active-subjects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./active-subjects')>();
  return {
    ...actual,
    resolveQualifyingEventSubjects: vi.fn(async () => new Map<string, string>()),
  };
});

const mockResolve = vi.mocked(resolveQualifyingEventSubjects);

describe('enqueueBriefRegen', () => {
  it('uses a per-scope singleton key with a 6 minute anti-storm window', async () => {
    const boss = { send: vi.fn(async () => 'job-1') };

    await enqueueBriefRegen(boss, 'topic:k1');

    expect(boss.send).toHaveBeenCalledWith(
      MEMORY_BRIEF_REGEN_QUEUE,
      { scope_key: 'topic:k1' },
      {
        singletonKey: 'memory.regen.topic:k1',
        singletonSeconds: 360,
        singletonNextSlot: true,
      },
    );
  });
});

describe('enqueueMemoryReconcile', () => {
  it('uses a per-user singleton key with a 90s window', async () => {
    const boss = { send: vi.fn(async () => 'job-1') };

    const memories = [
      { id: 'mem1', text: 'prefers dark mode', created_ms: 1000, kind: 'preference' },
      { id: 'mem2', text: 'answered q1', created_ms: 2000, kind: 'event' },
    ];
    await enqueueMemoryReconcile(boss, memories, 'self');

    expect(boss.send).toHaveBeenCalledWith(
      MEMORY_RECONCILE_QUEUE,
      { memories, user_id: 'self' },
      {
        singletonKey: 'memory.reconcile.self',
        singletonSeconds: 90,
        singletonNextSlot: true,
        // pg-boss retry on transient failure (handler rethrows RetryableError).
        retryLimit: 3,
        retryDelay: 30,
        retryBackoff: true,
      },
    );
  });

  it('does not enqueue when memoryIds is empty', async () => {
    const boss = { send: vi.fn(async () => 'job-1') };

    await enqueueMemoryReconcile(boss, [], 'self');

    expect(boss.send).not.toHaveBeenCalled();
  });
});

describe('buildMemoryEventIngestHandler', () => {
  it('adds event memory, enqueues regen, and enqueues reconcile for new ids', async () => {
    const addEventMemory = vi.fn(async () => ({
      results: [
        { id: 'mem1', memory: 'User prefers concise feedback' },
        { id: 'mem2', memory: 'Question q1 was answered incorrectly' },
      ],
    }));
    const send = vi.fn(async (_name: string, _data: object, _opts?: object) => 'job-1');
    const boss = { send };
    const handler = buildMemoryEventIngestHandler({} as never, boss, {
      loadEvent: async () => ({
        id: 'evt_1',
        actor_kind: 'user',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q1',
        payload: {},
        affected_scopes: ['global', 'topic:k1'],
        created_at: new Date('2026-05-27T00:00:00Z'),
        kind: 'event',
      }),
      // YUK-557 (F7): ingest-handler tests never reach the reconcile apply path, so
      // only addEventMemory is load-bearing; the rest default to no-ops.
      memoryClient: memoryClientMock({ addEventMemory }),
    });

    await handler([{ data: { event_id: 'evt_1' } } as Job<{ event_id: string }>] as Job<{
      event_id: string;
    }>[]);

    expect(addEventMemory).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt_1' }));
    // 2 brief regen (global + topic:k1) + 1 reconcile
    expect(boss.send).toHaveBeenCalledTimes(3);
    // Verify reconcile was enqueued with correct ids
    const reconcileCall = send.mock.calls.find((call) => call[0] === MEMORY_RECONCILE_QUEUE);
    expect(reconcileCall).toBeDefined();
    const createdMs = new Date('2026-05-27T00:00:00Z').getTime();
    // Threads {id, text, created_ms, kind} — NOT bare ids (search-by-text fix).
    expect(reconcileCall?.[1]).toEqual({
      memories: [
        { id: 'mem1', text: 'User prefers concise feedback', created_ms: createdMs, kind: 'event' },
        {
          id: 'mem2',
          text: 'Question q1 was answered incorrectly',
          created_ms: createdMs,
          kind: 'event',
        },
      ],
      user_id: 'self',
    });
    expect(reconcileCall?.[2]).toMatchObject({
      singletonKey: 'memory.reconcile.self',
    });
  });

  it('stores an edited conjecture claim verbatim and suppresses generic inferred extraction', async () => {
    const addEventMemory = vi.fn(async () => ({ results: [] }));
    const addVerbatimOnce = vi.fn(async () => ({
      results: [{ id: 'mem_core_1', memory: '应先验证虚词语境判断' }],
    }));
    const send = vi.fn(async () => 'job-1');
    const db = {
      transaction: vi.fn(async (fn: (tx: { execute: () => Promise<void> }) => Promise<unknown>) =>
        fn({ execute: vi.fn(async () => {}) }),
      ),
    };
    const handler = buildMemoryEventIngestHandler(
      db as never,
      { send },
      {
        loadEvent: async () => ({
          id: 'rate_edited_1',
          actor_kind: 'user',
          action: 'rate',
          subject_kind: 'event',
          subject_id: 'conjecture_1',
          payload: {
            rating: 'accept',
            conjecture_id: 'conjecture_1',
            corrected_by_owner: true,
            corrected_claim_md: '应先验证虚词语境判断',
          },
          affected_scopes: ['global', 'topic:k1'],
          created_at: new Date('2026-07-23T00:00:00Z'),
          kind: 'preference',
        }),
        memoryClient: memoryClientMock({ addEventMemory, addVerbatimOnce }),
      },
    );

    await handler([{ data: { event_id: 'rate_edited_1' } } as Job<{ event_id: string }>]);

    expect(addEventMemory).not.toHaveBeenCalled();
    expect(addVerbatimOnce).toHaveBeenCalledWith(
      '应先验证虚词语境判断',
      {
        source: 'conjecture_edit',
        event_id: 'rate_edited_1',
        conjecture_id: 'conjecture_1',
        // codex P2 (PR #1039) — the event row's scopes must be threaded VERBATIM so
        // scoped search (scope_key → affected_scopes contains) can retrieve the edit.
        affected_scopes: ['global', 'topic:k1'],
        corrected_by_owner: true,
        created_at: '2026-07-23T00:00:00.000Z',
        created_ms: new Date('2026-07-23T00:00:00Z').getTime(),
        kind: 'weakness',
      },
      'conjecture-edit:rate_edited_1',
    );
    expect(send).toHaveBeenCalledWith(
      MEMORY_RECONCILE_QUEUE,
      {
        memories: [
          {
            id: 'mem_core_1',
            text: '应先验证虚词语境判断',
            created_ms: new Date('2026-07-23T00:00:00Z').getTime(),
            kind: 'weakness',
          },
        ],
        user_id: 'self',
      },
      expect.any(Object),
    );
  });

  it('does not enqueue reconcile when addEventMemory returns empty results (md5 dedup)', async () => {
    const addEventMemory = vi.fn(async () => ({ results: [] }));
    const boss = { send: vi.fn(async () => 'job-1') };
    const handler = buildMemoryEventIngestHandler({} as never, boss, {
      loadEvent: async () => ({
        id: 'evt_1',
        actor_kind: 'user',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q1',
        payload: {},
        affected_scopes: ['global'],
        created_at: new Date('2026-05-27T00:00:00Z'),
        kind: 'event',
      }),
      // YUK-557 (F7): ingest-handler tests never reach the reconcile apply path, so
      // only addEventMemory is load-bearing; the rest default to no-ops.
      memoryClient: memoryClientMock({ addEventMemory }),
    });

    await handler([{ data: { event_id: 'evt_1' } } as Job<{ event_id: string }>] as Job<{
      event_id: string;
    }>[]);

    // Only brief regen, no reconcile
    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.send).not.toHaveBeenCalledWith(
      MEMORY_RECONCILE_QUEUE,
      expect.anything(),
      expect.anything(),
    );
  });

  // P3 (YUK-351) extraction gate — ADR-0039 §决定 7 invariant (i) / Phase 2 §6.3
  // C3 / §7 H6: an agent-originated event must NEVER feed mem0 extraction (it
  // would close the confirmation loop: orchestrator output → event → mem0 extracts
  // a semantic-trait → fed back next turn). Agent events skip addEventMemory +
  // reconcile entirely, but STILL fan out brief regen (the brief NOTE layer reads
  // events directly from PG and legitimately summarizes agent activity too).
  it('GATES agent-originated events out of extraction (no add, no reconcile), still fans out brief regen', async () => {
    const addEventMemory = vi.fn(async () => ({ results: [{ id: 'm', memory: 'x' }] }));
    const send = vi.fn(async (_name: string, _data: object, _opts?: object) => 'job-1');
    const boss = { send };
    const handler = buildMemoryEventIngestHandler({} as never, boss, {
      loadEvent: async () => ({
        id: 'evt_agent',
        actor_kind: 'agent',
        action: 'generate',
        subject_kind: 'artifact',
        subject_id: 'a1',
        payload: {},
        affected_scopes: ['global', 'topic:k1'],
        created_at: new Date('2026-05-27T00:00:00Z'),
        kind: 'event',
      }),
      // YUK-557 (F7): ingest-handler tests never reach the reconcile apply path, so
      // only addEventMemory is load-bearing; the rest default to no-ops.
      memoryClient: memoryClientMock({ addEventMemory }),
    });

    await handler([{ data: { event_id: 'evt_agent' } } as Job<{ event_id: string }>]);

    // Extraction gated: addEventMemory NEVER called for an agent event.
    expect(addEventMemory).not.toHaveBeenCalled();
    // No reconcile enqueued (nothing was extracted).
    expect(send).not.toHaveBeenCalledWith(
      MEMORY_RECONCILE_QUEUE,
      expect.anything(),
      expect.anything(),
    );
    // Brief regen still fans out for both scopes (NOTE layer is orthogonal).
    const regenCalls = send.mock.calls.filter((c) => c[0] === MEMORY_BRIEF_REGEN_QUEUE);
    expect(regenCalls).toHaveLength(2);
  });

  it('ADMITS user-originated events into extraction (add + reconcile)', async () => {
    const addEventMemory = vi.fn(async () => ({ results: [{ id: 'm1', memory: 'fact' }] }));
    const send = vi.fn(async (_name: string, _data: object, _opts?: object) => 'job-1');
    const boss = { send };
    const handler = buildMemoryEventIngestHandler({} as never, boss, {
      loadEvent: async () => ({
        id: 'evt_user',
        actor_kind: 'user',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q1',
        payload: {},
        affected_scopes: ['global'],
        created_at: new Date('2026-05-27T00:00:00Z'),
        kind: 'event',
      }),
      // YUK-557 (F7): ingest-handler tests never reach the reconcile apply path, so
      // only addEventMemory is load-bearing; the rest default to no-ops.
      memoryClient: memoryClientMock({ addEventMemory }),
    });

    await handler([{ data: { event_id: 'evt_user' } } as Job<{ event_id: string }>]);

    expect(addEventMemory).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt_user' }));
    expect(send).toHaveBeenCalledWith(
      MEMORY_RECONCILE_QUEUE,
      expect.objectContaining({ user_id: 'self' }),
      expect.anything(),
    );
  });

  // YUK-729 — the PAID, non-idempotent addEventMemory runs before the
  // affected_scopes brief-regen fan-out and the reconcile enqueue. If either
  // enqueue rethrew out of the handler, pg-boss would redeliver and re-run the
  // extraction (duplicate cost + a persistent duplicate mem0 row). Both enqueues
  // must swallow+log a transient failure, degrading to the sweep backstop.
  it('YUK-729 — swallows an affected_scopes brief-regen enqueue failure (ingest resolves, extraction not retried)', async () => {
    const addEventMemory = vi.fn(async () => ({ results: [{ id: 'm1', memory: 'fact' }] }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // boss.send throws only for the brief-regen fan-out; reconcile still succeeds.
    const send = vi.fn(async (name: string) => {
      if (name === MEMORY_BRIEF_REGEN_QUEUE) throw new Error('regen send boom');
      return 'job-1';
    });
    const boss = { send };
    const handler = buildMemoryEventIngestHandler({} as never, boss, {
      loadEvent: async () => ({
        id: 'evt_1',
        actor_kind: 'user',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q1',
        payload: {},
        affected_scopes: ['global'],
        created_at: new Date('2026-05-27T00:00:00Z'),
        kind: 'event',
      }),
      memoryClient: memoryClientMock({ addEventMemory }),
    });

    // The throw must NOT reject the ingest job — a resolved handler is what
    // prevents redelivery and the re-paid extraction.
    await expect(
      handler([{ data: { event_id: 'evt_1' } } as Job<{ event_id: string }>]),
    ).resolves.toBeUndefined();

    expect(addEventMemory).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[memory_brief_bridge] affected_scopes brief regen enqueue failed'),
      // The warn now aggregates the per-scope rejection reasons into an array.
      expect.arrayContaining([expect.any(Error)]),
    );
    warnSpy.mockRestore();
  });

  it('YUK-729 — a first-scope brief-regen failure does not skip the remaining scopes (per-scope allSettled)', async () => {
    const addEventMemory = vi.fn(async () => ({ results: [{ id: 'm1', memory: 'fact' }] }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The FIRST affected scope's enqueue throws; the later scopes must still enqueue
    // (a sequential for-loop under one try/catch would have aborted after 'global').
    const send = vi.fn(async (name: string, data: { scope_key?: string }) => {
      if (name === MEMORY_BRIEF_REGEN_QUEUE && data.scope_key === 'global') {
        throw new Error('first scope boom');
      }
      return 'job-1';
    });
    const boss = { send };
    const handler = buildMemoryEventIngestHandler({} as never, boss, {
      loadEvent: async () => ({
        id: 'evt_1',
        actor_kind: 'user',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q1',
        payload: {},
        affected_scopes: ['global', 'topic:k1', 'topic:k2'],
        created_at: new Date('2026-05-27T00:00:00Z'),
        kind: 'event',
      }),
      memoryClient: memoryClientMock({ addEventMemory }),
    });

    await expect(
      handler([{ data: { event_id: 'evt_1' } } as Job<{ event_id: string }>]),
    ).resolves.toBeUndefined();

    // Both later scopes were still enqueued despite the first throwing.
    expect(send).toHaveBeenCalledWith(
      MEMORY_BRIEF_REGEN_QUEUE,
      { scope_key: 'topic:k1' },
      expect.anything(),
    );
    expect(send).toHaveBeenCalledWith(
      MEMORY_BRIEF_REGEN_QUEUE,
      { scope_key: 'topic:k2' },
      expect.anything(),
    );
    // Failure is still surfaced, naming the failed scope.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('global'),
      expect.arrayContaining([expect.any(Error)]),
    );
    warnSpy.mockRestore();
  });

  it('YUK-729 — swallows a reconcile enqueue failure, logging at ERROR with compensation context (ingest resolves, extraction not retried)', async () => {
    const addEventMemory = vi.fn(async () => ({ results: [{ id: 'm1', memory: 'fact' }] }));
    // Reconcile has NO cron backstop, so the drop is logged at console.error (not warn)
    // with enough context to reconcile the affected mem0 rows by hand.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // boss.send throws only for the reconcile enqueue; brief-regen still succeeds.
    const send = vi.fn(async (name: string) => {
      if (name === MEMORY_RECONCILE_QUEUE) throw new Error('reconcile send boom');
      return 'job-1';
    });
    const boss = { send };
    const handler = buildMemoryEventIngestHandler({} as never, boss, {
      loadEvent: async () => ({
        id: 'evt_1',
        actor_kind: 'user',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q1',
        payload: {},
        affected_scopes: ['global'],
        created_at: new Date('2026-05-27T00:00:00Z'),
        kind: 'event',
      }),
      memoryClient: memoryClientMock({ addEventMemory }),
    });

    await expect(
      handler([{ data: { event_id: 'evt_1' } } as Job<{ event_id: string }>]),
    ).resolves.toBeUndefined();

    expect(addEventMemory).toHaveBeenCalledTimes(1);
    // ERROR level + carries the event id and the un-reconciled memory id for manual
    // compensation.
    const errorArg = errorSpy.mock.calls[0]?.[0] as string;
    expect(errorArg).toContain('[memory_reconcile] reconcile enqueue FAILED');
    expect(errorArg).toContain('evt_1');
    expect(errorArg).toContain('m1');
    expect(errorSpy.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    errorSpy.mockRestore();
  });

  it('YUK-729 — caps the brief-regen fan-out at MAX_BRIEF_REGEN_SCOPES and isolates failures within the cap', async () => {
    // A bulk / import-style event carrying far more affected scopes than the cap.
    const scopeCount = MAX_BRIEF_REGEN_SCOPES + 50;
    const affected = Array.from({ length: scopeCount }, (_, i) => `topic:k${i}`);
    const addEventMemory = vi.fn(async () => ({ results: [{ id: 'm1', memory: 'fact' }] }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // One scope INSIDE the cap throws; it must not abort the remaining enqueues.
    const send = vi.fn(async (name: string, data: { scope_key?: string }) => {
      if (name === MEMORY_BRIEF_REGEN_QUEUE && data.scope_key === 'topic:k0') {
        throw new Error('one scope boom');
      }
      return 'job-1';
    });
    const boss = { send };
    const handler = buildMemoryEventIngestHandler({} as never, boss, {
      loadEvent: async () => ({
        id: 'evt_bulk',
        actor_kind: 'user',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q1',
        payload: {},
        affected_scopes: affected,
        created_at: new Date('2026-05-27T00:00:00Z'),
        kind: 'event',
      }),
      memoryClient: memoryClientMock({ addEventMemory }),
    });

    await expect(
      handler([{ data: { event_id: 'evt_bulk' } } as Job<{ event_id: string }>]),
    ).resolves.toBeUndefined();

    // Fan-out is capped: exactly MAX_BRIEF_REGEN_SCOPES brief-regen enqueues attempted
    // (not scopeCount) — the failing one still counts as an attempt.
    const regenSends = send.mock.calls.filter((c) => c[0] === MEMORY_BRIEF_REGEN_QUEUE);
    expect(regenSends.length).toBe(MAX_BRIEF_REGEN_SCOPES);
    // A scope beyond the cap was never touched.
    expect(send).not.toHaveBeenCalledWith(
      MEMORY_BRIEF_REGEN_QUEUE,
      { scope_key: `topic:k${MAX_BRIEF_REGEN_SCOPES}` },
      expect.anything(),
    );
    // Truncation surfaced; the in-cap failure did not abort the handler.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`capping brief regen fan-out at ${MAX_BRIEF_REGEN_SCOPES}`),
    );
    expect(addEventMemory).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

// YUK-581 — subject brief bridge inside the ingest handler. A qualifying learning
// event (attempt / review / record_capture) never tags a `subject:*` scope in its
// affected_scopes, so the affected_scopes fan-out can't refresh the per-subject
// brief. The bridge resolves the event → subject via the canonical resolver and
// enqueues its `subject:<id>` regen, moving subject-brief freshness from the
// next-day 03:00 sweep to ≤6min after the activity. It is best-effort: a resolver /
// enqueue failure is swallowed (the nightly sweep backstops dropped bridges), and
// non-qualifying actions never touch the resolver.
describe('buildMemoryEventIngestHandler — YUK-581 subject brief bridge', () => {
  beforeEach(() => {
    mockResolve.mockClear();
  });

  it('bridges a qualifying event to a subject:<id> brief regen (per-scope singleton)', async () => {
    mockResolve.mockResolvedValueOnce(new Map([['evt_q', 'math']]));
    const send = vi.fn(async (_name: string, _data: object, _opts?: object) => 'job-1');
    const boss = { send };
    const handler = buildMemoryEventIngestHandler({} as never, boss, {
      loadEvent: async () => ({
        id: 'evt_q',
        actor_kind: 'user',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q1',
        payload: { referenced_knowledge_ids: ['k-math'] },
        affected_scopes: ['global', 'topic:k-math'],
        created_at: new Date('2026-05-27T00:00:00Z'),
        kind: 'event',
      }),
      memoryClient: memoryClientMock(),
    });

    await handler([{ data: { event_id: 'evt_q' } } as Job<{ event_id: string }>]);

    // Resolver was fed a QualifyingEventRow carrying the event's id/action/payload
    // (outcome passed as null per the resolver contract).
    expect(mockResolve).toHaveBeenCalledWith({}, [
      expect.objectContaining({ id: 'evt_q', action: 'attempt', outcome: null }),
    ]);
    // The resolved subject → a subject:math regen with the shared 6-min singleton.
    expect(send).toHaveBeenCalledWith(
      MEMORY_BRIEF_REGEN_QUEUE,
      { scope_key: 'subject:math' },
      {
        singletonKey: 'memory.regen.subject:math',
        singletonSeconds: 360,
        singletonNextSlot: true,
      },
    );
  });

  it('does NOT bridge a non-qualifying action (resolver untouched, no subject:<id> enqueue)', async () => {
    const send = vi.fn(async (_name: string, _data: object, _opts?: object) => 'job-1');
    const boss = { send };
    const handler = buildMemoryEventIngestHandler({} as never, boss, {
      loadEvent: async () => ({
        id: 'evt_rate',
        actor_kind: 'user',
        action: 'rate', // not in QUALIFYING_ACTIONS
        subject_kind: 'event',
        subject_id: 'e1',
        payload: {},
        affected_scopes: ['global'],
        created_at: new Date('2026-05-27T00:00:00Z'),
        kind: 'preference',
      }),
      memoryClient: memoryClientMock(),
    });

    await handler([{ data: { event_id: 'evt_rate' } } as Job<{ event_id: string }>]);

    expect(mockResolve).not.toHaveBeenCalled();
    const subjectRegen = send.mock.calls.find(
      (c) =>
        c[0] === MEMORY_BRIEF_REGEN_QUEUE &&
        (c[1] as { scope_key: string }).scope_key.startsWith('subject:'),
    );
    expect(subjectRegen).toBeUndefined();
  });

  it('swallows a bridge failure (ingest completes, warns) and still fans out affected_scopes', async () => {
    mockResolve.mockRejectedValueOnce(new Error('resolve boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn(async (_name: string, _data: object, _opts?: object) => 'job-1');
    const boss = { send };
    const handler = buildMemoryEventIngestHandler({} as never, boss, {
      loadEvent: async () => ({
        id: 'evt_q',
        actor_kind: 'user',
        action: 'review',
        subject_kind: 'question',
        subject_id: 'q1',
        payload: { referenced_knowledge_ids: ['k-math'] },
        affected_scopes: ['global'],
        created_at: new Date('2026-05-27T00:00:00Z'),
        kind: 'event',
      }),
      memoryClient: memoryClientMock(),
    });

    // The bridge throw must NOT reject the ingest job (best-effort; sweep backstops).
    await expect(
      handler([{ data: { event_id: 'evt_q' } } as Job<{ event_id: string }>]),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[memory_brief_bridge]'),
      expect.any(Error),
    );
    // Bridge failure is isolated — the affected_scopes fan-out still ran.
    expect(send).toHaveBeenCalledWith(
      MEMORY_BRIEF_REGEN_QUEUE,
      { scope_key: 'global' },
      expect.anything(),
    );
    warnSpy.mockRestore();
  });
});

describe('shouldExtractToMemory (extraction gate invariant)', () => {
  // ADR-0039 §决定 7 (i) + Phase 2 §6.3 C3 / §7 H6: only user-answering /
  // user-statement events may feed mem0 extraction; the orchestrator's own output
  // (actor_kind='agent') must NEVER enter the extraction source.
  const baseEvent = {
    id: 'evt',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q1',
    payload: {},
    affected_scopes: ['global'],
    created_at: new Date('2026-05-27T00:00:00Z'),
    kind: 'event',
  };

  it('admits user-originated events', () => {
    expect(shouldExtractToMemory({ ...baseEvent, actor_kind: 'user' })).toBe(true);
  });

  it('rejects agent-originated events (confirmation-loop blocker)', () => {
    expect(shouldExtractToMemory({ ...baseEvent, actor_kind: 'agent' })).toBe(false);
  });

  it('fails closed on an unknown / missing actor_kind (defensive — never feed)', () => {
    expect(shouldExtractToMemory({ ...baseEvent, actor_kind: 'system' })).toBe(false);
    expect(shouldExtractToMemory({ ...baseEvent, actor_kind: '' })).toBe(false);
  });
});

describe('registerMemoryHandlers', () => {
  it('tunes all 6 memory queues and creates DLQs before paid-LLM queues (YUK-248)', async () => {
    const schedule = vi.fn(
      async (_name: string, _cron: string, _data: object, _opts: object) => undefined,
    );
    const createQueue = vi.fn(async (_name: string, _opts?: object) => undefined);
    const updateQueue = vi.fn(async (_name: string, _opts?: object) => undefined);
    const boss = {
      createQueue,
      updateQueue,
      work: vi.fn(async (..._args: unknown[]) => undefined),
      schedule,
      send: vi.fn(async (_name: string, _data: object, _opts?: object) => 'job-1'),
    };

    await registerMemoryHandlers(boss, {} as never, {
      memoryClient: memoryClientMock(),
      generateBrief: vi.fn(),
    });

    const fastOpts = {
      expireInSeconds: 3_600,
      retentionSeconds: 604_800,
    };
    const paidQueues = [
      MEMORY_EVENT_INGEST_QUEUE,
      MEMORY_BRIEF_REGEN_QUEUE,
      MEMORY_RECONCILE_QUEUE,
    ];
    const housekeepingQueues = [
      MEMORY_BRIEF_SWEEP_QUEUE,
      MEMORY_INGEST_OUTBOX_POLL_QUEUE,
      MEMORY_INGEST_OUTBOX_RECOVER_QUEUE,
    ];

    // Three paid queues each create a DLQ + main queue; three housekeeping
    // queues create only themselves. Every row is reconciled for existing DBs.
    expect(createQueue).toHaveBeenCalledTimes(9);
    expect(updateQueue).toHaveBeenCalledTimes(9);

    const created = createQueue.mock.calls.map(([name]) => name);
    for (const name of paidQueues) {
      const dlq = `${name}_dlq`;
      const mainOpts = {
        expireInSeconds: 3_600,
        retentionSeconds: 604_800,
        deadLetter: dlq,
        retryLimit: 2,
        retryDelay: 30,
        retryBackoff: true,
      };
      expect(createQueue).toHaveBeenCalledWith(dlq, fastOpts);
      expect(createQueue).toHaveBeenCalledWith(name, mainOpts);
      expect(updateQueue).toHaveBeenCalledWith(dlq, fastOpts);
      expect(updateQueue).toHaveBeenCalledWith(name, mainOpts);
      expect(created.indexOf(dlq)).toBeLessThan(created.indexOf(name));
    }

    for (const name of housekeepingQueues) {
      expect(createQueue).toHaveBeenCalledWith(name, fastOpts);
      expect(updateQueue).toHaveBeenCalledWith(name, fastOpts);
    }

    // 6 work calls
    expect(boss.work).toHaveBeenCalledTimes(6);

    // 3 schedule calls (sweep + outbox poll + outbox recover; reconcile has NO schedule)
    expect(boss.schedule).toHaveBeenCalledTimes(3);
    expect(boss.schedule).toHaveBeenCalledWith(
      'memory_brief_sweep',
      '0 3 * * *',
      {},
      { tz: 'Asia/Shanghai' },
    );
    // Verify reconcile queue has NO schedule
    const reconcileSchedule = schedule.mock.calls.find(
      (call) => call[0] === MEMORY_RECONCILE_QUEUE,
    );
    expect(reconcileSchedule).toBeUndefined();
  });
});
