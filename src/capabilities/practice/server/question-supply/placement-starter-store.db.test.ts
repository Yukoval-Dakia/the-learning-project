import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { event, knowledge, placement_starter_claim } from '@/db/schema';
import type { QuizGenJobData } from '@/kernel/quiz-gen-contract';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { insertLegacyGoal as insertGoal } from '../../../../../tests/helpers/legacy-goal';
import { SupplyTraceV1 } from './evidence-demand';
import { dispatchPlacementStarterClaimTx } from './placement-starter';
import { materializePlacementStartersForGoal } from './placement-starter-store';

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
    subject_id: 'yuwen',
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
        subject_id: 'yuwen',
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
  it('atomically records one job and rolls back when send fails', async () => {
    await seedGoal();
    const { identities } = await db.transaction((tx) =>
      materializePlacementStartersForGoal(tx, 'goal-1'),
    );
    const identity = identities[0];
    if (!identity) throw new Error('missing placement identity');

    await expect(
      db.transaction((tx) =>
        dispatchPlacementStarterClaimTx(tx, identity.claimId, async () => {
          throw new Error('send failed');
        }),
      ),
    ).rejects.toThrow('send failed');
    expect((await db.select().from(placement_starter_claim))[0]?.status).toBe('pending_dispatch');

    const sent: QuizGenJobData[] = [];
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
    expect(sent[0]).toMatchObject({
      count: 8,
      exact_count: 8,
      placement_starter_claim_id: identity.claimId,
      semantic_goal_revision_id: 'goal-genesis-1',
    });
    const trace = SupplyTraceV1.parse(sent[0]?.supply_trace);
    expect(trace.claim_id).toBe(identity.claimId);
    expect(trace.allowed_uses).toEqual(['placement', 'diagnostic']);
    const [dispatchEvent] = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.subject_id, identity.targetId));
    expect(dispatchEvent?.payload.supply_trace).toEqual(trace);
    expect(dispatchEvent?.payload.supply_trace).toMatchObject({
      claim_id: identity.claimId,
      semantic_goal_revision_id: 'goal-genesis-1',
    });
    expect((await db.select().from(placement_starter_claim))[0]).toMatchObject({
      status: 'queued',
      pg_boss_job_id: 'job-1',
    });
  });
});
