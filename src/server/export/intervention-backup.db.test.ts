import { event, intervention } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memR2 } from '../../../tests/helpers/r2';
import { buildBackupArchive, restoreFromArchive } from './archive';

async function buildZipBytes(): Promise<Uint8Array> {
  const { stream } = await buildBackupArchive({
    db: testDb(),
    r2: memR2(),
    includeAssets: false,
  });
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('intervention backup operational reset', () => {
  beforeEach(resetDb);
  afterAll(resetDb);

  it('clears archived job ids so same-database restore re-enqueues fresh work', async () => {
    const db = testDb();
    const archivedJobId = '79100000-0000-4000-8000-000000000001';
    await db.insert(event).values([
      {
        id: 'restore_probe_result',
        actor_kind: 'system',
        actor_ref: 'restore_fixture',
        action: 'experimental:probe_result',
        subject_kind: 'question',
        subject_id: 'restore_probe',
        outcome: 'failure',
        payload: {},
      },
      {
        id: 'restore_conjecture',
        actor_kind: 'system',
        actor_ref: 'restore_fixture',
        action: 'experimental:proposal',
        subject_kind: 'mind_model',
        subject_id: 'restore_kc',
        outcome: 'partial',
        payload: {},
      },
    ]);
    await db.insert(intervention).values({
      id: 'restore_intervention',
      version: 1,
      source_probe_result_event_id: 'restore_probe_result',
      conjecture_event_id: 'restore_conjecture',
      status: 'preparing',
      delivery_mode: 'shadow',
      idempotency_key: 'restore_intervention_v1',
      preparation_job_id: archivedJobId,
      snapshot_json: {},
    });

    const bytes = await buildZipBytes();
    const retired: string[][] = [];
    const restored = await restoreFromArchive({
      db,
      r2: memR2(),
      bytes,
      retireInterventionPreparationJobs: async (tx, jobIds) => {
        const [stillCurrent] = await tx
          .select({ preparation_job_id: intervention.preparation_job_id })
          .from(intervention)
          .where(eq(intervention.id, 'restore_intervention'));
        expect(stillCurrent?.preparation_job_id).toBe(archivedJobId);
        retired.push(jobIds);
      },
    });
    expect(restored.status).toBe(200);
    expect(retired).toEqual([[archivedJobId]]);

    const [row] = await db
      .select({ preparation_job_id: intervention.preparation_job_id })
      .from(intervention)
      .where(eq(intervention.id, 'restore_intervention'));
    expect(row?.preparation_job_id).toBeNull();

    // Grounding inspect/shadow restores into a newly-created disposable DB,
    // where archived-runtime pg-boss rows cannot exist. That caller must opt in
    // explicitly rather than supplying a fake live-database cancellation.
    const disposable = await restoreFromArchive({
      db,
      r2: memR2(),
      bytes,
      operationalRestoreTarget: 'fresh_disposable',
    });
    expect(disposable.status).toBe(200);
  });
});
