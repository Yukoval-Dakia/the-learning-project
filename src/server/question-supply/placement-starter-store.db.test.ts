import { insertGoal } from '@/capabilities/agency/server/goals/queries';
import {
  event,
  goal,
  knowledge,
  materialized_id_index,
  placement_starter_claim,
} from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { dispatchPlacementStarterClaimTx } from './placement-starter';
import {
  addPlacementStarterKnowledgeToExplicitGoal,
  ensurePlacementStarterKnowledgeAndClaim,
  resolvePlacementStarterGoalAuthority,
} from './placement-starter-store';

const db = testDb();

beforeEach(() => resetDb());

async function seedGoal(): Promise<void> {
  const now = new Date('2026-07-23T00:00:00Z');
  await db.insert(knowledge).values([
    {
      id: 'seed:yuwen:root',
      name: '语文',
      domain: 'yuwen',
      parent_id: null,
      created_at: now,
      updated_at: now,
    },
    {
      id: 'kc-explicit',
      name: '文言实词',
      domain: null,
      parent_id: 'seed:yuwen:root',
      created_at: now,
      updated_at: now,
    },
  ]);
  await insertGoal(db, {
    id: 'goal-1',
    title: '读懂古文',
    subject_id: null,
    scope_knowledge_ids: ['kc-explicit'],
    scope_mode: 'explicit',
    sequence_hint: 0,
    source: 'manual',
    now,
  });
  await db.insert(event).values({
    id: 'goal-genesis-1',
    actor_kind: 'system',
    actor_ref: 'goal-create',
    action: 'experimental:genesis',
    subject_kind: 'goal',
    subject_id: 'goal-1',
    outcome: 'success',
    payload: {
      row: {
        id: 'goal-1',
        title: '读懂古文',
        subject_id: null,
        scope_knowledge_ids: ['kc-explicit'],
        scope_mode: 'explicit',
        sequence_hint: 0,
        status: 'active',
        source: 'manual',
        source_ref: null,
        created_at: now,
        updated_at: now,
        version: 0,
      },
    },
    created_at: now,
  });
}

describe('placement starter store', () => {
  it('creates one projection-safe content KC and claim and updates explicit scope through an event', async () => {
    await seedGoal();
    const authority = await resolvePlacementStarterGoalAuthority(db, 'goal-1');
    const first = await db.transaction(async (tx) => {
      const result = await ensurePlacementStarterKnowledgeAndClaim(tx, authority, 'yuwen');
      await addPlacementStarterKnowledgeToExplicitGoal(tx, authority, [
        result.identity.knowledgeId,
      ]);
      return result;
    });
    const second = await db.transaction((tx) =>
      ensurePlacementStarterKnowledgeAndClaim(tx, authority, 'yuwen'),
    );

    expect(second.identity).toEqual(first.identity);
    expect((await db.select().from(placement_starter_claim)).length).toBe(1);
    expect(
      (await db.select().from(materialized_id_index)).find(
        (row) => row.materialized_id === first.identity.knowledgeId,
      )?.anchor_event_id,
    ).toBe(first.identity.genesisEventId);
    const [updatedGoal] = await db.select().from(goal);
    expect(updatedGoal.scope_knowledge_ids).toEqual(['kc-explicit', first.identity.knowledgeId]);
    const scopeEvents = (await db.select().from(event)).filter(
      (row) => row.action === 'experimental:goal_scope_update',
    );
    expect(scopeEvents).toHaveLength(1);
    expect(scopeEvents[0]?.actor_ref).toBe('placement_starter');
  });

  it('does not authorize roots or global fallback', async () => {
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'seed:yuwen:root',
      name: '语文',
      domain: 'yuwen',
      parent_id: null,
      created_at: now,
      updated_at: now,
    });
    await insertGoal(db, {
      id: 'goal-empty',
      title: '跨科目标',
      scope_knowledge_ids: ['seed:yuwen:root'],
      scope_mode: 'explicit',
      sequence_hint: 0,
      source: 'manual',
    });
    await expect(resolvePlacementStarterGoalAuthority(db, 'goal-empty')).rejects.toMatchObject({
      status: 422,
    });
    expect(await db.select().from(placement_starter_claim)).toHaveLength(0);
  });

  it('atomically records one job and rolls back when send fails', async () => {
    await seedGoal();
    const authority = await resolvePlacementStarterGoalAuthority(db, 'goal-1');
    const { identity } = await db.transaction((tx) =>
      ensurePlacementStarterKnowledgeAndClaim(tx, authority, 'yuwen'),
    );

    await expect(
      db.transaction((tx) =>
        dispatchPlacementStarterClaimTx(tx, identity.claimId, async () => {
          throw new Error('send failed');
        }),
      ),
    ).rejects.toThrow('send failed');
    expect((await db.select().from(placement_starter_claim))[0]?.status).toBe('pending_dispatch');

    const sent: Record<string, unknown>[] = [];
    await db.transaction((tx) =>
      dispatchPlacementStarterClaimTx(tx, identity.claimId, async (_queue, data) => {
        sent.push(data);
        return 'job-1';
      }),
    );
    await db.transaction((tx) =>
      dispatchPlacementStarterClaimTx(tx, identity.claimId, async () => {
        throw new Error('must not send again');
      }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ count: 8, exact_count: 8 });
    expect((sent[0]?.supply_trace as { allowed_uses: string[] }).allowed_uses).toEqual([
      'placement',
      'diagnostic',
    ]);
    expect((await db.select().from(placement_starter_claim))[0]).toMatchObject({
      status: 'queued',
      pg_boss_job_id: 'job-1',
    });
  });
});
