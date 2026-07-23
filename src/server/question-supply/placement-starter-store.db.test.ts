import { insertGoal } from '@/capabilities/agency/server/goals/queries';
import { selectNextPlacementItem } from '@/capabilities/practice/server/placement-select';
import {
  event,
  goal,
  knowledge,
  materialized_id_index,
  placement_starter_attempt,
  placement_starter_attempt_question,
  placement_starter_claim,
  placement_starter_cost_component,
  question,
} from '@/db/schema';
import type { QuizGenJobData } from '@/server/boss/handlers/quiz_gen';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { dispatchSupplyTarget } from './dispatcher';
import { SupplyTraceV1 } from './evidence-demand';
import { buildPlacementStarterTarget, dispatchPlacementStarterClaimTx } from './placement-starter';
import {
  materializePlacementStartersForGoal,
  resolvePlacementStarterGoalAuthority,
} from './placement-starter-store';
import { lockPlacementSupplyScopes } from './placement-supply-lock';

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
  it('creates one projection-safe content KC and claim and updates explicit scope through an event', async () => {
    await seedGoal();
    const first = await db.transaction(async (tx) => {
      const { identities } = await materializePlacementStartersForGoal(tx, 'goal-1');
      return (
        identities[0] ??
        (() => {
          throw new Error('missing placement identity');
        })()
      );
    });
    const second = await db.transaction(async (tx) => {
      const { identities } = await materializePlacementStartersForGoal(tx, 'goal-1');
      return (
        identities[0] ??
        (() => {
          throw new Error('missing placement identity');
        })()
      );
    });

    expect(second).toEqual(first);
    expect((await db.select().from(placement_starter_claim)).length).toBe(1);
    expect(
      (await db.select().from(materialized_id_index)).find(
        (row) => row.materialized_id === first.knowledgeId,
      )?.anchor_event_id,
    ).toBe(first.genesisEventId);
    const [updatedGoal] = await db.select().from(goal);
    expect(updatedGoal.scope_knowledge_ids).toEqual(['kc-explicit', first.knowledgeId]);
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

  it.each([
    ['missing', async () => db.delete(knowledge)],
    [
      'archived',
      async () =>
        db
          .update(knowledge)
          .set({ archived_at: new Date() })
          .where(eq(knowledge.id, 'seed:yuwen:root')),
    ],
    [
      'wrong-domain',
      async () =>
        db.update(knowledge).set({ domain: 'wrong' }).where(eq(knowledge.id, 'seed:yuwen:root')),
    ],
  ])('rejects a %s structural root before creating paid work', async (_kind, corrupt) => {
    await seedGoal();
    await corrupt();
    await expect(
      db.transaction((tx) => materializePlacementStartersForGoal(tx, 'goal-1')),
    ).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(placement_starter_claim)).toHaveLength(0);
  });

  it('rejects malformed statuses, component kinds, and cross-claim attempt tuples', async () => {
    await seedGoal();
    const { identities } = await db.transaction((tx) =>
      materializePlacementStartersForGoal(tx, 'goal-1'),
    );
    const [claim] = await db.select().from(placement_starter_claim);
    if (!claim) throw new Error('missing placement claim');
    const identity = identities[0];
    if (!identity) throw new Error('missing placement identity');
    const now = new Date();
    await expect(
      db.execute(sql`update placement_starter_claim set status = 'bogus' where id = ${claim.id}`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`insert into placement_starter_attempt
        (id, claim_id, pg_boss_job_id, delivery_no, fencing_token, status, created_at, updated_at)
        values ('bad-attempt', ${claim.id}, 'job-bad', 1, gen_random_uuid(), 'bogus', ${now}, ${now})`),
    ).rejects.toThrow();

    await db.insert(placement_starter_claim).values({
      ...claim,
      id: 'claim-2',
      fingerprint: 'fp-2',
      semantic_goal_revision_id: 'revision-2',
      demand_id: 'demand-2',
      target_id: 'target-2',
      pg_boss_job_id: null,
    });
    await db.insert(placement_starter_attempt).values({
      id: 'attempt-1',
      claim_id: claim.id,
      pg_boss_job_id: 'job-1',
      delivery_no: 1,
      fencing_token: crypto.randomUUID(),
      status: 'running',
      created_at: now,
      updated_at: now,
    });
    await db.insert(question).values({
      id: 'question-1',
      kind: 'short_answer',
      prompt_md: 'p',
      knowledge_ids: [identity.knowledgeId],
      difficulty: 3,
      source: 'manual',
      draft_status: 'active',
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await expect(
      db.insert(placement_starter_attempt_question).values({
        attempt_id: 'attempt-1',
        claim_id: 'claim-2',
        question_id: 'question-1',
        canonical_hash: 'hash-1',
        verification_authority_epoch: crypto.randomUUID(),
        verification_status: 'authorized',
        created_at: now,
      }),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`insert into placement_starter_attempt_question
        (attempt_id, claim_id, question_id, canonical_hash, verification_authority_epoch, verification_status, created_at)
        values ('attempt-1', ${claim.id}, 'question-1', 'hash-bad-status', gen_random_uuid(), 'bogus', ${now})`),
    ).rejects.toThrow();
    await expect(
      db.insert(placement_starter_cost_component).values({
        id: 'cost-cross',
        claim_id: 'claim-2',
        attempt_id: 'attempt-1',
        component_kind: 'quiz_gen',
        provider_task_run_id: 'run-cross',
        cost_micro_usd: 1,
        created_at: now,
      }),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`insert into placement_starter_cost_component
        (id, claim_id, attempt_id, component_kind, provider_task_run_id, cost_micro_usd, created_at)
        values ('cost-bad', ${claim.id}, 'attempt-1', 'bogus', 'run-bad', 1, ${now})`),
    ).rejects.toThrow();
  });

  it('ignores sequence-only goal updates when deriving semantic identity', async () => {
    await seedGoal();
    const before = await resolvePlacementStarterGoalAuthority(db, 'goal-1');
    await db.insert(event).values({
      id: 'goal-sequence-only',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:goal_scope_update',
      subject_kind: 'goal',
      subject_id: 'goal-1',
      outcome: 'success',
      payload: { sequence_hint: 1, version: 1, updated_at: new Date() },
      created_at: new Date('2026-07-23T01:00:00Z'),
    });
    const after = await resolvePlacementStarterGoalAuthority(db, 'goal-1');
    expect(after.semanticGoalRevisionId).toBe(before.semanticGoalRevisionId);
  });

  it('fails closed when an existing deterministic KC has a mismatched genesis anchor', async () => {
    await seedGoal();
    const { identities } = await db.transaction((tx) =>
      materializePlacementStartersForGoal(tx, 'goal-1'),
    );
    const identity = identities[0];
    if (!identity) throw new Error('missing placement identity');
    await db.insert(event).values({
      id: 'wrong-anchor',
      actor_kind: 'system',
      actor_ref: 'test',
      action: 'experimental:genesis',
      subject_kind: 'knowledge',
      subject_id: identity.knowledgeId,
      outcome: 'success',
      payload: {
        row: (await db.select().from(knowledge).where(eq(knowledge.id, identity.knowledgeId)))[0],
      },
      created_at: new Date(),
    });
    await db
      .update(materialized_id_index)
      .set({ anchor_event_id: 'wrong-anchor' })
      .where(eq(materialized_id_index.materialized_id, identity.knowledgeId));
    await expect(
      db.transaction((tx) => materializePlacementStartersForGoal(tx, 'goal-1')),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rolls back KC, claim, and scope when Transaction A aborts', async () => {
    await seedGoal();
    await expect(
      db.transaction(async (tx) => {
        await materializePlacementStartersForGoal(tx, 'goal-1');
        throw new Error('session materialization failed');
      }),
    ).rejects.toThrow('session materialization failed');
    expect(await db.select().from(placement_starter_claim)).toHaveLength(0);
    expect((await db.select().from(goal))[0]?.scope_knowledge_ids).toEqual(['kc-explicit']);
  });

  it('suppresses enqueue when final admission finds a promoted question', async () => {
    await seedGoal();
    const { identities } = await db.transaction((tx) =>
      materializePlacementStartersForGoal(tx, 'goal-1'),
    );
    const identity = identities[0];
    if (!identity) throw new Error('missing placement identity');
    let sends = 0;
    const result = await db.transaction((tx) =>
      dispatchPlacementStarterClaimTx(
        tx,
        identity.claimId,
        async () => {
          sends += 1;
          return 'must-not-send';
        },
        async () => false,
      ),
    );
    expect(result).toBeNull();
    expect(sends).toBe(0);
    expect((await db.select().from(placement_starter_claim))[0]?.status).toBe('pending_dispatch');
  });

  it('serializes promotion against final admission so warm and paid cannot both win', async () => {
    await seedGoal();
    const { identities } = await db.transaction((tx) =>
      materializePlacementStartersForGoal(tx, 'goal-1'),
    );
    const identity = identities[0];
    if (!identity) throw new Error('missing placement identity');
    const now = new Date();
    await db.insert(question).values({
      id: 'question-race',
      kind: 'short_answer',
      prompt_md: 'race',
      knowledge_ids: [identity.knowledgeId],
      difficulty: 3,
      source: 'quiz_gen',
      draft_status: 'draft',
      created_at: now,
      updated_at: now,
      version: 0,
    });

    let releasePromotion!: () => void;
    const promotionLocked = new Promise<void>((resolve) => {
      releasePromotion = resolve;
    });
    const promotion = db.transaction(async (tx) => {
      await lockPlacementSupplyScopes(tx, [identity.knowledgeId]);
      releasePromotion();
      await tx
        .update(question)
        .set({ draft_status: 'active', updated_at: new Date() })
        .where(eq(question.id, 'question-race'));
    });
    await promotionLocked;

    let sends = 0;
    const admission = db.transaction((tx) =>
      dispatchPlacementStarterClaimTx(
        tx,
        identity.claimId,
        async () => {
          sends += 1;
          return 'paid-job';
        },
        async (lockedTx) => {
          await lockPlacementSupplyScopes(lockedTx, [identity.knowledgeId]);
          return (
            (await selectNextPlacementItem(lockedTx, {
              knowledgeIds: [identity.knowledgeId],
              preferKnowledgeIds: [],
            })) === null
          );
        },
      ),
    );
    await Promise.all([promotion, admission]);
    expect(sends).toBe(0);
    expect(
      await selectNextPlacementItem(db, {
        knowledgeIds: [identity.knowledgeId],
        preferKnowledgeIds: [],
      }),
    ).not.toBeNull();
  });

  it('rejects a malformed fully augmented placement supply trace before enqueue', async () => {
    await seedGoal();
    const { identities } = await db.transaction((tx) =>
      materializePlacementStartersForGoal(tx, 'goal-1'),
    );
    const identity = identities[0];
    if (!identity) throw new Error('missing placement identity');
    const [claim] = await db.select().from(placement_starter_claim);
    if (!claim) throw new Error('missing placement claim');
    let sends = 0;
    await expect(
      db.transaction((tx) =>
        dispatchSupplyTarget(tx, buildPlacementStarterTarget(claim), {
          atomic: true,
          cooldownDays: 0,
          tavilyAvailable: () => true,
          transformSupplyTrace: (trace) => ({ ...trace, claim_id: '' }),
          enqueueQuizGen: async () => {
            sends += 1;
            return 'must-not-send';
          },
        }),
      ),
    ).rejects.toThrow();
    expect(sends).toBe(0);
  });

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
    expect((await db.select().from(placement_starter_claim))[0]).toMatchObject({
      status: 'queued',
      pg_boss_job_id: 'job-1',
    });
  });
});
