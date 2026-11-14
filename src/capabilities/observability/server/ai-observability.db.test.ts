import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { ai_task_runs } from '@/db/schema';
import { writeAiTaskAttemptFinished } from '@/kernel/records/ai-attempt-facts';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { getAdminRunTimeline, listAdminRunsPage } from './ai-observability';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForBlockedDatabaseQuery(fragment: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const rows = await testDb().execute<{ blocked: number }>(sql`
      select count(*)::int as blocked
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and state = 'active'
        and wait_event_type = 'Lock'
        and query ilike ${`%${fragment}%`}
    `);
    if ((rows[0]?.blocked ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for blocked query containing ${fragment}`);
}

describe('admin run cost snapshot', () => {
  beforeEach(resetDb);

  // @invariant concurrency: a run projection cannot combine a pre-settlement run row with the settlement's ledger row.
  // @fails-if list/detail span snapshots and report a ledger event beside an empty cost projection.
  it.each([
    {
      surface: 'list',
      read: async (runId: string) => {
        const page = await listAdminRunsPage(testDb());
        return {
          run: page.rows.find((row) => row.id === runId),
          timelineCostEvents: [],
        };
      },
    },
    {
      surface: 'detail',
      read: async (runId: string) => {
        const detail = await getAdminRunTimeline(testDb(), runId);
        return {
          run: detail?.run,
          timelineCostEvents:
            detail?.timeline.filter((event) => event.type === 'cost_ledger') ?? [],
        };
      },
    },
  ])('$surface keeps run and ledger rows in one committed snapshot', async ({ read }) => {
    const db = testDb();
    const runId = 'admin-run-snapshot';
    const startedAt = new Date('2026-11-14T12:00:00Z');
    await db.insert(ai_task_runs).values({
      id: runId,
      task_kind: 'AdminCostSnapshotTask',
      provider: 'test',
      model: 'test-model',
      input_hash: 'input-hash',
      status: 'running',
      started_at: startedAt,
    });

    const blockerReady = deferred();
    const releaseBlocker = deferred();
    const blockerDone = db.transaction(async (blocker) => {
      await blocker.execute(sql`LOCK TABLE cost_ledger IN ACCESS EXCLUSIVE MODE`);
      blockerReady.resolve();
      await releaseBlocker.promise;
    });
    await blockerReady.promise;

    let writerDone: Promise<boolean> | undefined;
    let readDone:
      | Promise<{ run?: { ledger_rows: number }; timelineCostEvents: unknown[] }>
      | undefined;
    try {
      writerDone = writeAiTaskAttemptFinished(db, {
        id: runId,
        status: 'success',
        finish_reason: 'stop',
        usage: { inputTokens: 2, outputTokens: 3 },
        cost_truth: { basis: 'reported', amountUsd: 1.25, ref: 'provider-receipt:1' },
        outcome: 'success',
        finished_at: new Date('2026-11-14T12:00:01Z'),
      });
      await waitForBlockedDatabaseQuery('insert into "cost_ledger"');

      readDone = read(runId);
      await waitForBlockedDatabaseQuery('from "cost_ledger"');
      releaseBlocker.resolve();
      await blockerDone;
      await writerDone;
      const observed = await readDone;

      expect(observed.run).toMatchObject({
        status: 'running',
        cost_usd: null,
        cost_basis: null,
        cost_by_currency: [],
        ledger_rows: 0,
      });
      expect(observed.timelineCostEvents).toEqual([]);
    } finally {
      releaseBlocker.resolve();
      await blockerDone.catch(() => undefined);
      await writerDone?.catch(() => undefined);
      await readDone?.catch(() => undefined);
    }
  });
});
