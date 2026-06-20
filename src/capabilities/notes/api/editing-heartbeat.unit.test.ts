import { beforeEach, describe, expect, it, vi } from 'vitest';

// YUK-358 决定6 (ADR-0040) — the dwell note_refine trigger is RETIRED. This route
// is now a pure presence write: POST heartbeat records editing/idle presence and
// must NOT enqueue any note_refine job. Unit test mocks the presence primitive +
// the trigger producer so the route is exercised in isolation (presence write
// happens, no dwell enqueue path). recordEditingHeartbeat itself is DB-tested in
// src/server/artifacts/editing-session.test.ts.
//
// RED before 决定6: the route fired enqueueDwellNoteRefine on status==="editing",
// so enqueueDwell would be called once. After retiring the trigger the producer is
// deleted and the route never enqueues — proving the dwell path is gone.
vi.mock('@/db/client', () => ({ db: {} }));

const recordEditingHeartbeat = vi.fn();
vi.mock('@/server/artifacts/editing-session', () => ({
  recordEditingHeartbeat: (...args: unknown[]) => recordEditingHeartbeat(...args),
}));

// Spy on every producer this module COULD enqueue, including the soon-deleted
// dwell producer, so the assertion stays meaningful through the deletion. The
// real triggers module is unit/db-tested in note-refine-triggers.unit.test.ts.
const enqueueDwellNoteRefine = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('@/capabilities/notes/server/note-refine-triggers', () => ({
  enqueueDwellNoteRefine: (...args: unknown[]) => enqueueDwellNoteRefine(...args),
}));

import { POST } from './editing-heartbeat';

function req(body: unknown): Request {
  return new Request('http://t/api/editing-session/heartbeat', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/editing-session/heartbeat (决定6 dwell retired)', () => {
  beforeEach(() => {
    recordEditingHeartbeat.mockReset();
    enqueueDwellNoteRefine.mockReset();
  });

  it('records the presence heartbeat on status="editing" and does NOT enqueue a dwell note_refine', async () => {
    const res = await POST(req({ artifact_id: 'art_1', status: 'editing' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(recordEditingHeartbeat).toHaveBeenCalledTimes(1);
    expect(recordEditingHeartbeat).toHaveBeenCalledWith({
      artifactId: 'art_1',
      status: 'editing',
    });
    // 决定6 red line: the dwell trigger is gone — editing presence must never
    // fire a background note_refine job.
    expect(enqueueDwellNoteRefine).not.toHaveBeenCalled();
  });

  it('records the presence heartbeat on status="idle" without enqueueing note_refine', async () => {
    const res = await POST(req({ artifact_id: 'art_1', status: 'idle' }));

    expect(res.status).toBe(200);
    expect(recordEditingHeartbeat).toHaveBeenCalledWith({
      artifactId: 'art_1',
      status: 'idle',
    });
    expect(enqueueDwellNoteRefine).not.toHaveBeenCalled();
  });

  it('rejects a body without artifact_id (400)', async () => {
    const res = await POST(req({ status: 'editing' }));
    expect(res.status).toBe(400);
    expect(recordEditingHeartbeat).not.toHaveBeenCalled();
    expect(enqueueDwellNoteRefine).not.toHaveBeenCalled();
  });
});
