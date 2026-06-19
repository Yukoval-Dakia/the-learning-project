import type { Job } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';
import {
  MEMORY_BRIEF_REGEN_QUEUE,
  MEMORY_EVENT_INGEST_QUEUE,
  MEMORY_RECONCILE_QUEUE,
  buildMemoryEventIngestHandler,
  enqueueBriefRegen,
  enqueueMemoryReconcile,
  registerMemoryHandlers,
  shouldExtractToMemory,
} from './triggers';

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
      memoryClient: { addEventMemory, search: vi.fn() },
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
      memoryClient: { addEventMemory, search: vi.fn() },
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
      memoryClient: { addEventMemory, search: vi.fn() },
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
      memoryClient: { addEventMemory, search: vi.fn() },
    });

    await handler([{ data: { event_id: 'evt_user' } } as Job<{ event_id: string }>]);

    expect(addEventMemory).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt_user' }));
    expect(send).toHaveBeenCalledWith(
      MEMORY_RECONCILE_QUEUE,
      expect.objectContaining({ user_id: 'self' }),
      expect.anything(),
    );
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
  it('registers 6 queues (event ingest, brief regen, sweep, outbox poll, outbox recover, reconcile) with 3 schedules', async () => {
    const schedule = vi.fn(
      async (_name: string, _cron: string, _data: object, _opts: object) => undefined,
    );
    const boss = {
      createQueue: vi.fn(async (_name: string) => undefined),
      work: vi.fn(async (..._args: unknown[]) => undefined),
      schedule,
      send: vi.fn(async (_name: string, _data: object, _opts?: object) => 'job-1'),
    };

    await registerMemoryHandlers(boss, {} as never, {
      memoryClient: { addEventMemory: vi.fn(), search: vi.fn() },
      generateBrief: vi.fn(),
    });

    // 6 createQueue calls
    expect(boss.createQueue).toHaveBeenCalledTimes(6);
    expect(boss.createQueue).toHaveBeenCalledWith(MEMORY_EVENT_INGEST_QUEUE);
    expect(boss.createQueue).toHaveBeenCalledWith(MEMORY_BRIEF_REGEN_QUEUE);
    expect(boss.createQueue).toHaveBeenCalledWith('memory_brief_sweep');
    expect(boss.createQueue).toHaveBeenCalledWith('memory_ingest_outbox_poll');
    expect(boss.createQueue).toHaveBeenCalledWith('memory_ingest_outbox_recover');
    expect(boss.createQueue).toHaveBeenCalledWith(MEMORY_RECONCILE_QUEUE);

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
