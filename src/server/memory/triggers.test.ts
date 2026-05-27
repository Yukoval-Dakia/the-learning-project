import type { Job } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';
import {
  MEMORY_BRIEF_REGEN_QUEUE,
  MEMORY_EVENT_INGEST_QUEUE,
  buildMemoryEventIngestHandler,
  enqueueBriefRegen,
  registerMemoryHandlers,
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

describe('buildMemoryEventIngestHandler', () => {
  it('adds event memory and enqueues regen for each affected scope', async () => {
    const addEventMemory = vi.fn(async () => ({ results: [] }));
    const boss = { send: vi.fn(async () => 'job-1') };
    const handler = buildMemoryEventIngestHandler({} as never, boss, {
      loadEvent: async () => ({
        id: 'evt_1',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q1',
        payload: {},
        affected_scopes: ['global', 'topic:k1'],
        created_at: new Date('2026-05-27T00:00:00Z'),
      }),
      memoryClient: { addEventMemory, search: vi.fn() },
    });

    await handler([{ data: { event_id: 'evt_1' } } as Job<{ event_id: string }>] as Job<{
      event_id: string;
    }>[]);

    expect(addEventMemory).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt_1' }));
    expect(boss.send).toHaveBeenCalledTimes(2);
  });
});

describe('registerMemoryHandlers', () => {
  it('registers event ingest, brief regen, and daily sweep queues', async () => {
    const boss = {
      createQueue: vi.fn(async () => undefined),
      work: vi.fn(async () => undefined),
      schedule: vi.fn(async () => undefined),
      send: vi.fn(async () => 'job-1'),
    };

    await registerMemoryHandlers(boss, {} as never, {
      memoryClient: { addEventMemory: vi.fn(), search: vi.fn() },
      generateBrief: vi.fn(),
    });

    expect(boss.createQueue).toHaveBeenCalledWith(MEMORY_EVENT_INGEST_QUEUE);
    expect(boss.createQueue).toHaveBeenCalledWith(MEMORY_BRIEF_REGEN_QUEUE);
    expect(boss.createQueue).toHaveBeenCalledWith('memory_brief_sweep');
    expect(boss.schedule).toHaveBeenCalledWith(
      'memory_brief_sweep',
      '0 3 * * *',
      {},
      { tz: 'Asia/Shanghai' },
    );
  });
});
