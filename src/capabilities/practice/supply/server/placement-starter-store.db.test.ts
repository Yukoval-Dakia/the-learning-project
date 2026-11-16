import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { event, knowledge, placement_starter_claim } from '@/db/schema';
import { SupplyTraceV1 } from '@/kernel/supply-contracts';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { insertLegacyGoal as insertGoal } from '../../../../../tests/helpers/legacy-goal';
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
  // @invariant concurrency/idempotency: a new (sourcing_web) placement claim binds exactly one durable supply_execute delivery (stable id + complete payload on the dispatch event), a failed bind rolls the claim back to pending, and a second dispatch binds nothing new
  // @fails-if new claims still send inside the transaction, a failed bind leaves the claim queued, the delivery payload is missing or rebuilt, or a second dispatch rebinds; the pending/queued status and bound-id assertions fail
  it('atomically binds one delivery and rolls back when the bind fails', async () => {
    await seedGoal();
    const { identities } = await db.transaction((tx) =>
      materializePlacementStartersForGoal(tx, 'goal-1'),
    );
    const identity = identities[0];
    if (!identity) throw new Error('missing placement identity');

    await expect(
      db.transaction((tx) =>
        dispatchPlacementStarterClaimTx(tx, identity.claimId, async () => {
          throw new Error('bind failed');
        }),
      ),
    ).rejects.toThrow('bind failed');
    expect((await db.select().from(placement_starter_claim))[0]?.status).toBe('pending_dispatch');

    const boundJobId = await db.transaction((tx) =>
      dispatchPlacementStarterClaimTx(tx, identity.claimId),
    );
    expect(boundJobId).toBeTruthy();
    const second = await db.transaction((tx) =>
      dispatchPlacementStarterClaimTx(tx, identity.claimId),
    );
    expect(second).toBe(boundJobId);

    const [dispatchEvent] = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.subject_id, identity.targetId));
    const delivery = dispatchEvent?.payload.delivery as
      | { queue: string; job_data: Record<string, unknown> }
      | undefined;
    expect(dispatchEvent?.payload.job_id).toBe(boundJobId);
    expect(delivery?.queue).toBe('supply_execute');
    expect(delivery?.job_data).toMatchObject({
      items: [{ count: 8, placement_claim_id: identity.claimId }],
    });
    const trace = SupplyTraceV1.parse(delivery?.job_data.supply_trace);
    expect(trace.claim_id).toBe(identity.claimId);
    expect(trace.allowed_uses).toEqual(['placement', 'diagnostic']);
    expect(dispatchEvent?.payload.supply_trace).toEqual(trace);
    expect(dispatchEvent?.payload.supply_trace).toMatchObject({
      claim_id: identity.claimId,
      semantic_goal_revision_id: 'goal-genesis-1',
    });
    expect((await db.select().from(placement_starter_claim))[0]).toMatchObject({
      status: 'queued',
      pg_boss_job_id: boundJobId,
    });
  });
});
