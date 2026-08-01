import { job_events } from '@/db/schema';
import * as sseReplay from '@/server/events/sse_replay';
import { _clearSubscribersForTests, broadcast } from '@/server/events/sse_router';
import { writeJobEvent } from '@/server/events/writer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { JobEventStreamResponseSchema } from './event-contracts';
import { GET, JOB_EVENT_HEARTBEAT_MS } from './job-events';

// Parsed SSE frame: `id: N\ndata: {...}\n\n`.
type Frame = { id: number; data: { event_id: number; event_type: string; payload: unknown } };

function parseFrames(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of text.split('\n\n')) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const idLine = trimmed.split('\n').find((l) => l.startsWith('id: '));
    const dataLine = trimmed.split('\n').find((l) => l.startsWith('data: '));
    if (!idLine || !dataLine) continue;
    frames.push({
      id: Number.parseInt(idLine.slice('id: '.length), 10),
      data: JSON.parse(dataLine.slice('data: '.length)),
    });
  }
  return frames;
}

/**
 * Drive GET, read the SSE stream until `expectAtLeast` frames have arrived (or the
 * stream closes), then abort to tear down the subscription. The route emits replay
 * synchronously in start(), so a bounded read with an abort is deterministic.
 */
async function collectFrames(
  kind: string,
  id: string,
  opts: { lastEventId?: number; expectAtLeast?: number; drive?: () => Promise<void> } = {},
): Promise<Frame[]> {
  const controller = new AbortController();
  const headers: Record<string, string> = {};
  if (opts.lastEventId !== undefined) headers['Last-Event-ID'] = String(opts.lastEventId);
  const req = new Request(`http://localhost/api/jobs/${kind}/${id}/events`, {
    headers,
    signal: controller.signal,
  });
  const res = await GET(req, { kind, id });
  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Type')).toBe('text/event-stream');

  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Read until the buffer holds at least `target` frames (or the stream closes).
  const pumpUntil = async (target: number) => {
    while (parseFrames(buffer).length < target) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
  };

  // Pump replay first.
  await pumpUntil(opts.expectAtLeast ?? 0);

  // Optionally trigger a live broadcast, then pump again to capture the new
  // frame — target one MORE than the replay count so the loop actually reads.
  if (opts.drive) {
    const before = parseFrames(buffer).length;
    await opts.drive();
    await pumpUntil(before + 1);
  }

  controller.abort();
  try {
    await reader.cancel();
  } catch {
    // already torn down
  }
  expect(() => JobEventStreamResponseSchema.parse(buffer)).not.toThrow();
  return parseFrames(buffer);
}

async function seedEvent(
  kind: string,
  id: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const rows = await testDb()
    .insert(job_events)
    .values({
      business_table: kind,
      business_id: id,
      event_type: eventType,
      payload,
      occurred_at: new Date(),
    })
    .returning({ id: job_events.id });
  return rows[0].id;
}

describe('GET /api/jobs/[kind]/[id]/events', () => {
  beforeEach(async () => {
    await resetDb();
    _clearSubscribersForTests();
  });

  afterEach(() => {
    _clearSubscribersForTests();
    vi.restoreAllMocks();
  });

  it('full replay: no Last-Event-ID returns all seeded frames in id order', async () => {
    const id1 = await seedEvent('copilot_run', 'run_X', 'started', { step: 1 });
    const id2 = await seedEvent('copilot_run', 'run_X', 'progress', { step: 2 });
    const id3 = await seedEvent('copilot_run', 'run_X', 'done', { step: 3 });

    const frames = await collectFrames('copilot_run', 'run_X', { expectAtLeast: 3 });

    expect(frames.map((f) => f.id)).toEqual([id1, id2, id3]);
    expect(frames.map((f) => f.data.event_type)).toEqual(['started', 'progress', 'done']);
    // non-vacuous: payload round-trips through the frame
    expect(frames[1].data.payload).toEqual({ step: 2 });
    expect(frames[2].data.event_id).toBe(id3);
  });

  it('since-id replay: Last-Event-ID=k returns only events with id > k', async () => {
    await seedEvent('copilot_run', 'run_Y', 'started', { step: 1 });
    const id2 = await seedEvent('copilot_run', 'run_Y', 'progress', { step: 2 });
    const id3 = await seedEvent('copilot_run', 'run_Y', 'done', { step: 3 });

    const frames = await collectFrames('copilot_run', 'run_Y', {
      lastEventId: id2,
      expectAtLeast: 1,
    });

    expect(frames.map((f) => f.id)).toEqual([id3]);
    // non-vacuous: the pre-cursor event was actually excluded (3 exist, only 1 returned)
    expect(frames).toHaveLength(1);
  });

  it('live broadcast: a writeJobEvent after subscribe is delivered as a new frame', async () => {
    await seedEvent('copilot_run', 'run_Z', 'started', { step: 1 });

    const frames = await collectFrames('copilot_run', 'run_Z', {
      expectAtLeast: 1,
      drive: async () => {
        // Write a new event, then simulate the listen-loop NOTIFY fan-out by
        // broadcasting on the in-memory router (the route subscribed in start()).
        const newId = await writeJobEvent(testDb(), {
          business_table: 'copilot_run',
          business_id: 'run_Z',
          event_type: 'progress',
          payload: { step: 2 },
        });
        broadcast({ event_id: newId, business_table: 'copilot_run', business_id: 'run_Z' });
        // give the async subscribe handler a tick to query + emit
        await new Promise((r) => setTimeout(r, 50));
      },
    });

    expect(frames.map((f) => f.data.event_type)).toContain('progress');
    // non-vacuous: both the replayed and the live frame are present (2 total)
    expect(frames.map((f) => f.data.event_type)).toEqual(['started', 'progress']);
  });

  it('emits id-free keepalive comments and clears the heartbeat when the client disconnects', async () => {
    let emitHeartbeat: (() => void) | undefined;
    const intervalToken = { kind: 'job-event-heartbeat' } as unknown as ReturnType<
      typeof setInterval
    >;
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation((handler, timeout) => {
        expect(timeout).toBe(JOB_EVENT_HEARTBEAT_MS);
        emitHeartbeat = handler as () => void;
        return intervalToken;
      });
    const clearIntervalSpy = vi
      .spyOn(globalThis, 'clearInterval')
      .mockImplementation(() => undefined);
    const controller = new AbortController();
    const response = await GET(
      new Request('http://localhost/api/jobs/copilot_run/run_heartbeat/events', {
        signal: controller.signal,
      }),
      { kind: 'copilot_run', id: 'run_heartbeat' },
    );
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(emitHeartbeat).toBeTypeOf('function');
    emitHeartbeat?.();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);

    expect(text).toBe(': keepalive\n\n');
    expect(parseFrames(text)).toEqual([]);

    controller.abort();
    await reader.cancel().catch(() => {});
    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalToken);
  });

  it('does not subscribe after a disconnect that lands while initial replay is in flight', async () => {
    let releaseReplay: ((events: []) => void) | undefined;
    const replayPending = new Promise<[]>((resolve) => {
      releaseReplay = resolve;
    });
    const replaySpy = vi
      .spyOn(sseReplay, 'computeReplay')
      .mockImplementationOnce(async () => await replayPending)
      .mockResolvedValue([]);
    const controller = new AbortController();
    const response = await GET(
      new Request('http://localhost/api/jobs/copilot_run/run_abort_during_replay/events', {
        signal: controller.signal,
      }),
      { kind: 'copilot_run', id: 'run_abort_during_replay' },
    );

    await vi.waitFor(() => expect(replaySpy).toHaveBeenCalledTimes(1));
    controller.abort();
    releaseReplay?.([]);
    await Promise.resolve();
    await Promise.resolve();

    broadcast({
      event_id: 9_001,
      business_table: 'copilot_run',
      business_id: 'run_abort_during_replay',
    });
    await Promise.resolve();

    expect(replaySpy).toHaveBeenCalledTimes(1);
    await (response.body as ReadableStream<Uint8Array>).cancel().catch(() => {});
  });

  it('catches an event committed between initial replay and subscribe without reordering live replay', async () => {
    type ReplayResult = Awaited<ReturnType<typeof sseReplay.computeReplay>>;
    let releaseInitial: ((events: ReplayResult) => void) | undefined;
    let releaseCatchUp: ((events: ReplayResult) => void) | undefined;
    const initialPending = new Promise<ReplayResult>((resolve) => {
      releaseInitial = resolve;
    });
    const catchUpPending = new Promise<ReplayResult>((resolve) => {
      releaseCatchUp = resolve;
    });
    const terminal = {
      id: 7_021,
      business_table: 'copilot_run',
      business_id: 'run_replay_subscribe_gap',
      event_type: 'copilot_run.done',
      payload: { task_run_id: 'task_replay_subscribe_gap' },
      occurred_at: new Date('2026-08-01T08:00:00.000Z'),
    };
    const replaySpy = vi
      .spyOn(sseReplay, 'computeReplay')
      .mockImplementationOnce(async () => await initialPending)
      .mockImplementationOnce(async () => await catchUpPending)
      .mockResolvedValue([]);
    const controller = new AbortController();
    const response = await GET(
      new Request('http://localhost/api/jobs/copilot_run/run_replay_subscribe_gap/events', {
        signal: controller.signal,
      }),
      { kind: 'copilot_run', id: 'run_replay_subscribe_gap' },
    );
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();

    await vi.waitFor(() => expect(replaySpy).toHaveBeenCalledTimes(1));
    // This notification lands before subscribe and is intentionally lost. The
    // post-subscribe catch-up must still recover its durable row.
    broadcast({
      event_id: terminal.id,
      business_table: terminal.business_table,
      business_id: terminal.business_id,
    });
    releaseInitial?.([]);

    await vi.waitFor(() => expect(replaySpy).toHaveBeenCalledTimes(2));
    // A second notification while catch-up is pending must queue behind it,
    // not start a concurrent replay that can advance past the gap event.
    broadcast({
      event_id: terminal.id,
      business_table: terminal.business_table,
      business_id: terminal.business_id,
    });
    releaseCatchUp?.([terminal]);

    const firstChunk = await reader.read();
    const frames = parseFrames(new TextDecoder().decode(firstChunk.value));
    expect(frames).toEqual([
      {
        id: terminal.id,
        data: {
          event_id: terminal.id,
          event_type: terminal.event_type,
          payload: terminal.payload,
        },
      },
    ]);
    await vi.waitFor(() => expect(replaySpy).toHaveBeenCalledTimes(3));
    expect(replaySpy.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({ lastEventId: terminal.id }),
    );

    controller.abort();
    await reader.cancel().catch(() => {});
  });

  it('400 on empty kind or empty id', async () => {
    const resNoKind = await GET(new Request('http://localhost/api/jobs//run_X/events'), {
      kind: '',
      id: 'run_X',
    });
    expect(resNoKind.status).toBe(400);

    const resNoId = await GET(new Request('http://localhost/api/jobs/copilot_run//events'), {
      kind: 'copilot_run',
      id: '',
    });
    expect(resNoId.status).toBe(400);

    // non-vacuous: a valid pair does NOT 400
    const ok = await GET(
      new Request('http://localhost/api/jobs/copilot_run/run_X/events', {
        signal: new AbortController().signal,
      }),
      { kind: 'copilot_run', id: 'run_X' },
    );
    expect(ok.status).toBe(200);
    await (ok.body as ReadableStream).cancel();
  });

  it('NaN cursor: a non-numeric Last-Event-ID falls back to full replay (not empty)', async () => {
    // F1: Number.parseInt('abc', 10) === NaN; without a guard it flows into
    // gt(id, NaN) → unpredictable (Postgres: id > NaN is NULL → zero rows).
    const id1 = await seedEvent('copilot_run', 'run_NaN', 'started', { step: 1 });
    const id2 = await seedEvent('copilot_run', 'run_NaN', 'done', { step: 2 });

    const controller = new AbortController();
    const req = new Request('http://localhost/api/jobs/copilot_run/run_NaN/events', {
      headers: { 'Last-Event-ID': 'not-a-number' },
      signal: controller.signal,
    });
    const res = await GET(req, { kind: 'copilot_run', id: 'run_NaN' });
    expect(res.status).toBe(200);

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (parseFrames(buffer).length < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    controller.abort();
    await reader.cancel().catch(() => {});

    const frames = parseFrames(buffer);
    // Malformed cursor must degrade to "no cursor" → all rows replayed.
    expect(frames.map((f) => f.id)).toEqual([id1, id2]);
  });

  it('thrown computeReplay: emits an SSE error event and closes the stream (does not hang)', async () => {
    // F2: if computeReplay rejects (DB/connection error), the async start callback
    // must not silently hang — it should surface an error frame and close.
    await seedEvent('copilot_run', 'run_err', 'started', { step: 1 });
    vi.spyOn(sseReplay, 'computeReplay').mockRejectedValue(new Error('boom'));

    const controller = new AbortController();
    const req = new Request('http://localhost/api/jobs/copilot_run/run_err/events', {
      signal: controller.signal,
    });
    const res = await GET(req, { kind: 'copilot_run', id: 'run_err' });
    expect(res.status).toBe(200);

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    // The stream must terminate on its own (done === true) within a bounded read —
    // a hang would loop here forever (the test runner timeout would catch it, but
    // the assertion below proves the stream actually closed).
    while (!done) {
      const r = await reader.read();
      if (r.value) buffer += decoder.decode(r.value, { stream: true });
      done = r.done;
    }
    controller.abort();

    // An error event frame was emitted before close.
    expect(buffer).toContain('event: error');
  });

  it('unknown kind: a business_table not in the allowlist returns 400', async () => {
    // F3: kind is user-supplied; only known job tables may be subscribed to.
    const res = await GET(new Request('http://localhost/api/jobs/secret_table/run_X/events'), {
      kind: 'secret_table',
      id: 'run_X',
    });
    expect(res.status).toBe(400);

    // non-vacuous: a known kind is NOT rejected.
    const ok = await GET(
      new Request('http://localhost/api/jobs/copilot_run/run_X/events', {
        signal: new AbortController().signal,
      }),
      { kind: 'copilot_run', id: 'run_X' },
    );
    expect(ok.status).toBe(200);
    await (ok.body as ReadableStream).cancel();
  });

  it('cross-kind isolation: events for (ingestion_session, X) are not returned for (copilot_run, X)', async () => {
    // Same business_id "X" under two different kinds.
    await seedEvent('ingestion_session', 'X', 'ingest_started', { a: 1 });
    await seedEvent('ingestion_session', 'X', 'ingest_done', { a: 2 });
    const copilotId = await seedEvent('copilot_run', 'X', 'started', { b: 1 });

    const frames = await collectFrames('copilot_run', 'X', { expectAtLeast: 1 });

    // Only the copilot_run event surfaces; the two ingestion_session rows are filtered out.
    expect(frames.map((f) => f.id)).toEqual([copilotId]);
    expect(frames.map((f) => f.data.event_type)).toEqual(['started']);
    expect(frames).toHaveLength(1);
  });
});
