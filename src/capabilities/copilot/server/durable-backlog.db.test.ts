import { job_events } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from './copilot-run-status';
import { countOutstandingDurableRuns } from './durable-backlog';

async function write(runId: string, eventType: string): Promise<void> {
  await testDb().insert(job_events).values({
    business_table: COPILOT_RUN_TABLE,
    business_id: runId,
    event_type: eventType,
    payload: {},
  });
}

describe('countOutstandingDurableRuns (YUK-693)', () => {
  beforeEach(() => resetDb());

  it('counts distinct queued runs without DONE/FAILED and ignores other job families', async () => {
    await write('run_queued', COPILOT_RUN_EVENTS.QUEUED);
    await write('run_started', COPILOT_RUN_EVENTS.QUEUED);
    await write('run_started', COPILOT_RUN_EVENTS.STARTED);
    await write('run_done', COPILOT_RUN_EVENTS.QUEUED);
    await write('run_done', COPILOT_RUN_EVENTS.DONE);
    await write('run_failed', COPILOT_RUN_EVENTS.QUEUED);
    await write('run_failed', COPILOT_RUN_EVENTS.FAILED);
    await testDb().insert(job_events).values({
      business_table: 'other_job',
      business_id: 'other_queued',
      event_type: COPILOT_RUN_EVENTS.QUEUED,
      payload: {},
    });

    expect(await countOutstandingDurableRuns(testDb())).toBe(2);
  });
});
