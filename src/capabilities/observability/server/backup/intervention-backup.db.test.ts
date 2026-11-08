import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { hydrateConfigFromDb } from '@/core/config/server/hydrate';
import { event, intervention } from '@/db/schema';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { memR2 } from '../../../../../tests/helpers/r2';
import {
  type RestoreFromArchiveOpts,
  buildBackupArchive,
  restoreFromArchive as restoreArchive,
} from './archive';

// Restores here re-read config through the same hydrator the API composition root injects.
const restoreFromArchive = (opts: Omit<RestoreFromArchiveOpts, 'hydrateConfig'>) =>
  restoreArchive({ ...opts, hydrateConfig: hydrateConfigFromDb });

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

  // @invariant data: same-database restore clears archived preparation job ids
  // inside the restore transaction so recovery re-enqueues fresh work
  // @fails-if the fence id survives restore — a stale engine row would block
  // redelivery — or the clear happens outside the restore transaction
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
      // Post-commit cleanup: by the time the retirer runs, the restore has
      // already landed the job-id fence (aggregate job id cleared) atomically.
      retireInterventionPreparationJobs: async (jobIds) => {
        const [stillCurrent] = await db
          .select({ preparation_job_id: intervention.preparation_job_id })
          .from(intervention)
          .where(eq(intervention.id, 'restore_intervention'));
        expect(stillCurrent?.preparation_job_id).toBeNull();
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
