import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createMigrationFixture } from './migration-fixture';

const fixture = createMigrationFixture('legacy');
const { families, reset, worker, nextId, evidence, verifiedArtifact } = fixture;
beforeAll(fixture.setup, 60000);
beforeEach(fixture.beforeCase);
afterEach(fixture.afterCase);
afterAll(fixture.teardown);

// @invariant data: old prune and review partial receipts survive both new-family admissions
// @fails-if native family admission changes retained old-family receipts or repeats an already committed old effect
it('recovers genuine old prune and review partial ledgers before and after both new-family admissions', async () => {
  const { runSessionOrphanTick } = await import('@/server/durable/session-orphan-family');

  fixture.selectedFamily = families[0];
  const pruneArtifact = await verifiedArtifact('prune'),
    reviewArtifact = await verifiedArtifact('review');
  for (const kind of ['prune', 'review'] as const)
    for (const admitted of [false, true]) {
      await reset();
      const id = `${kind}-genuine-${randomUUID()}`;
      if (kind === 'prune') {
        await fixture.db`update prune_job_events_control set phase = 'dbos'`;
        await fixture.db`insert into job_events (business_table,business_id,event_type,payload,occurred_at) values ('echo_jobs','old','echo.queued','{}','2026-01-01T00:00:00Z')`;
      } else {
        await fixture.db`update review_orphan_control set phase = 'dbos'`;
        for (const sessionId of ['review-old-a', 'review-old-b'])
          await fixture.db`insert into learning_session (id,type,status,started_at) values (${sessionId},'review','started','2026-10-08T12:00:00Z')`;
      }
      const old = worker({
        oldBundle: kind === 'prune' ? pruneArtifact : reviewArtifact,
        pruneId: kind === 'prune' ? id : undefined,
        reviewId: kind === 'review' ? id : undefined,
      });
      await old.wait('ready');
      await old.wait('boundary');
      await old.kill();
      const before =
        kind === 'prune'
          ? await fixture.db`select * from prune_job_events_receipt where workflow_id = ${id}`
          : await fixture.db`select * from review_orphan_receipt where tick_id = ${id} order by session_id`;
      expect(before).toHaveLength(1);
      if (admitted)
        for (const family of families) {
          fixture.selectedFamily = family;
          const nativeId = nextId();
          // Actual bounded runner with a valid scheduled identity. No SDK enqueue exists while old code runs.
          await runSessionOrphanTick(fixture.appDb, {
            family,
            source: {
              kind: 'dbos',
              workflowId: nativeId,
              scheduledAt: new Date(nativeId.slice(`sched-${family}-`.length)),
            },
          });
        }
      const current = worker();
      await current.wait('ready');
      await expect
        .poll(
          async () =>
            (
              await fixture.db`select status from tlp_dbos.workflow_status where workflow_uuid = ${id}`
            )[0]?.status,
          { timeout: 30000 },
        )
        .toBe('SUCCESS');
      const after =
        kind === 'prune'
          ? await fixture.db`select * from prune_job_events_receipt where workflow_id = ${id}`
          : await fixture.db`select * from review_orphan_receipt where tick_id = ${id} order by session_id`;
      if (kind === 'prune') expect(after).toEqual(before);
      else {
        expect(after).toHaveLength(2);
        expect(after[0]).toEqual(before[0]);
        expect(
          await fixture.db`select * from job_events where event_type = 'review.abandoned'`,
        ).toHaveLength(2);
      }
      const step = kind === 'prune' ? 'prune-business-commit' : 'review-orphan-sweep-v1';
      expect(
        await fixture.db`select function_name from tlp_dbos.operation_outputs where workflow_uuid = ${id} and function_name = ${step}`,
      ).toHaveLength(1);
      evidence.push({ kind, admitted, id, oldPid: old.child.pid, before, after, step });
      await current.stop();
    }
}, 240000);
