import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { event, knowledge, placement_starter_claim } from '@/db/schema';
import { SupplyTraceV1 } from '@/kernel/supply-contracts';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { insertLegacyGoal as insertGoal } from '../../../../../tests/helpers/legacy-goal';
import { dispatchPlacementStarterClaimTx } from './placement-starter';
import { materializePlacementStartersForGoal } from './placement-starter-store';
import { SUPPLY_DELIVERY_INTENT_ACTION } from './supply-delivery-outbox';

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
  // @invariant concurrency: a new (sourcing_web) placement claim binds exactly one supply_execute delivery in its dispatch transaction, and a repeated dispatch binds nothing new
  // @fails-if new claims still bind quiz_gen, the claim goes queued without the complete job request persisted, or a second dispatch binds again; the intent count and payload assertions fail
  it('binds one supply_execute delivery with the queued claim and never binds twice', async () => {
    await seedGoal();
    const { identities } = await db.transaction((tx) =>
      materializePlacementStartersForGoal(tx, 'goal-1'),
    );
    const identity = identities[0];
    if (!identity) throw new Error('missing placement identity');

    const first = await db.transaction((tx) =>
      dispatchPlacementStarterClaimTx(tx, identity.claimId),
    );
    const second = await db.transaction((tx) =>
      dispatchPlacementStarterClaimTx(tx, identity.claimId),
    );
    expect(second).toBe(first);
    const intents = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.action, SUPPLY_DELIVERY_INTENT_ACTION));
    expect(intents).toHaveLength(1);
    const intent = intents[0]?.payload as {
      queue: string;
      job_id: string;
      data: Record<string, unknown>;
    };
    expect(intent).toMatchObject({ queue: 'supply_execute', job_id: first });
    expect(intent.data).toMatchObject({
      items: [{ count: 8, placement_claim_id: identity.claimId }],
    });
    const trace = SupplyTraceV1.parse(intent.data.supply_trace);
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
      pg_boss_job_id: first,
    });
  });
});
