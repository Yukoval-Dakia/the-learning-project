import { beforeEach, describe, expect, it } from 'vitest';
import { job_events } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from './copilot-run-status';
import { countOutstandingDurableRuns } from './durable-backlog';

async function write(
  runId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await testDb().insert(job_events).values({
    business_table: COPILOT_RUN_TABLE,
    business_id: runId,
    event_type: eventType,
    payload,
  });
}

describe('countOutstandingDurableRuns (YUK-693)', () => {
  beforeEach(() => resetDb());

  it('counts retry frames as outstanding; only successful or deliberate failure terminals release capacity', async () => {
    await write('run_queued', COPILOT_RUN_EVENTS.QUEUED);
    await write('run_started', COPILOT_RUN_EVENTS.QUEUED);
    await write('run_started', COPILOT_RUN_EVENTS.STARTED);
    await write('run_retrying_cross_subject_audit', COPILOT_RUN_EVENTS.QUEUED);
    await write('run_retrying_cross_subject_audit', COPILOT_RUN_EVENTS.STARTED);
    await write('run_retrying_cross_subject_audit', COPILOT_RUN_EVENTS.FAILED, {
      reason: 'error',
      error: 'gateway reset after validating 31 of 48 answers, 4 of 6 probes, and 5 of 9 variants',
    });
    await write('run_done', COPILOT_RUN_EVENTS.QUEUED);
    await write('run_done', COPILOT_RUN_EVENTS.DONE);
    await write('run_failed', COPILOT_RUN_EVENTS.QUEUED);
    await write('run_failed', COPILOT_RUN_EVENTS.FAILED, { reason: 'exhausted' });
    await testDb().insert(job_events).values({
      business_table: 'other_job',
      business_id: 'other_queued',
      event_type: COPILOT_RUN_EVENTS.QUEUED,
      payload: {},
    });

    expect(await countOutstandingDurableRuns(testDb())).toBe(3);

    await write('run_retrying_cross_subject_audit', COPILOT_RUN_EVENTS.FAILED, {
      reason: 'pre_execution_lost',
      error: 'queue delivery disappeared before model/tool execution',
    });
    expect(await countOutstandingDurableRuns(testDb())).toBe(2);
  });
});
