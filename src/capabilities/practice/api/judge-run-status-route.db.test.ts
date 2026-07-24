// YUK-594 (W1) — GET /api/jobs/judge_run/[id]/status (poll tier).
// Covers: unknown run_id → 404 (not a dishonest 200 queued, #7); a queued run → 200
// queued; a done run → 200 done with the structured verdict payload (#11).

import { newId } from '@/core/ids';
import { writeJobEvent } from '@/server/events/writer';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { JUDGE_RUN_EVENTS, JUDGE_RUN_TABLE } from '../server/judge-run-status';
import { GET } from './judge-run-status-route';

describe('GET /api/jobs/judge_run/[id]/status', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('unknown run_id → 404 (not 200 queued)', async () => {
    const res = await GET(new Request('http://localhost'), { id: newId() });
    expect(res.status).toBe(404);
  });

  it('queued run → 200 queued, result null', async () => {
    const runId = newId();
    await writeJobEvent(testDb(), {
      business_table: JUDGE_RUN_TABLE,
      business_id: runId,
      event_type: JUDGE_RUN_EVENTS.QUEUED,
      payload: { caller: 'submit' },
    });
    const res = await GET(new Request('http://localhost'), { id: runId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; result: unknown };
    expect(body.status).toBe('queued');
    expect(body.result).toBeNull();
  });

  it('done run → 200 done with the structured verdict payload', async () => {
    const runId = newId();
    await writeJobEvent(testDb(), {
      business_table: JUDGE_RUN_TABLE,
      business_id: runId,
      event_type: JUDGE_RUN_EVENTS.STARTED,
      payload: { caller: 'submit' },
    });
    await writeJobEvent(testDb(), {
      business_table: JUDGE_RUN_TABLE,
      business_id: runId,
      event_type: JUDGE_RUN_EVENTS.DONE,
      payload: {
        attempt_event_id: runId,
        coarse_outcome: 'correct',
        score: 1,
        feedback_md: 'ok',
        capability_ref: { id: 'semantic', version: '1.0.0' },
      },
    });
    const res = await GET(new Request('http://localhost'), { id: runId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      result: { coarse_outcome?: string; capability_ref?: { id: string } } | null;
    };
    expect(body.status).toBe('done');
    expect(body.result?.coarse_outcome).toBe('correct');
    expect(body.result?.capability_ref?.id).toBe('semantic');
  });
});
