import { db } from '@/db/client';
import { event, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../../tests/helpers/db';
import {
  compareInventoryShadow,
  loadInventoryProjectionInput,
  projectEvidenceInventory,
  writeInventoryShadowComparisonEvents,
} from './inventory-projection';

describe('inventory projection DB loader', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('loads active/draft/exposure state and unfulfilled dispatch commitments separately', async () => {
    const now = new Date('2026-07-19T00:00:00.000Z');
    await db.insert(question).values([
      {
        id: 'q-ready',
        kind: 'short_answer',
        prompt_md: 'ready',
        source: 'manual',
        draft_status: 'active',
        knowledge_ids: ['kc-1'],
        created_at: now,
        updated_at: now,
      },
      {
        id: 'q-draft',
        kind: 'short_answer',
        prompt_md: 'draft',
        source: 'quiz_gen',
        draft_status: 'draft',
        knowledge_ids: ['kc-1'],
        created_at: now,
        updated_at: now,
      },
      {
        id: 'q-exposure',
        kind: 'short_answer',
        prompt_md: 'exposure',
        source: 'manual',
        draft_status: null,
        knowledge_ids: ['kc-1'],
        metadata: { exposure_blocked: true },
        created_at: now,
        updated_at: now,
      },
    ]);
    await writeEvent(db, {
      id: createId(),
      actor_kind: 'system',
      actor_ref: 'question_supply',
      action: 'experimental:question_supply',
      subject_kind: 'query',
      subject_id: 'target-1',
      outcome: 'success',
      payload: {
        status: 'dispatched',
        fingerprint: 'fp-live',
        subject_id: 'math',
        knowledge_ids: ['kc-1'],
        desired_count: 2,
      },
      affected_scopes: [],
      ingest_at: now,
      created_at: new Date('2026-07-18T00:00:00.000Z'),
    });

    const loaded = await loadInventoryProjectionInput(db, {
      subjectId: 'math',
      knowledgeId: 'kc-1',
      eligibleGoal: 3,
      now,
    });
    const projected = projectEvidenceInventory(loaded);

    expect(projected).toMatchObject({
      ready: 2,
      eligibleOnHand: 1,
      quarantined: 1,
      exposureBlocked: 1,
      pipelineCommitments: 2,
      deficit: 2,
      uncoveredDeficitAfterPipeline: 0,
      recommendation: 'wait',
    });
  });

  it('closes a commitment when a produced question carries the same supply trace', async () => {
    const now = new Date('2026-07-19T00:00:00.000Z');
    await db.insert(question).values({
      id: 'q-produced',
      kind: 'short_answer',
      prompt_md: 'produced',
      source: 'quiz_gen',
      draft_status: 'draft',
      knowledge_ids: ['kc-1'],
      metadata: { supply_trace: { target_fingerprint: 'fp-fulfilled' } },
      created_at: now,
      updated_at: now,
    });
    await writeEvent(db, {
      id: createId(),
      actor_kind: 'system',
      actor_ref: 'question_supply',
      action: 'experimental:question_supply',
      subject_kind: 'query',
      subject_id: 'target-fulfilled',
      outcome: 'success',
      payload: {
        status: 'dispatched',
        fingerprint: 'fp-fulfilled',
        subject_id: 'math',
        knowledge_ids: ['kc-1'],
      },
      ingest_at: now,
      created_at: new Date('2026-07-18T00:00:00.000Z'),
    });

    const loaded = await loadInventoryProjectionInput(db, {
      subjectId: 'math',
      knowledgeId: 'kc-1',
      eligibleGoal: 1,
      now,
    });

    expect(loaded.commitments).toEqual([]);
    expect(projectEvidenceInventory(loaded)).toMatchObject({
      eligibleOnHand: 0,
      quarantined: 1,
      recommendation: 'produce',
    });
  });

  it('writes dual-read disagreement as an observe-only event', async () => {
    const now = new Date('2026-07-19T00:00:00.000Z');
    const projection = projectEvidenceInventory({
      subjectId: 'math',
      knowledgeId: 'kc-1',
      eligibleGoal: 1,
      now,
      questions: [],
      commitments: [{ id: 'fp-live', expiresAt: new Date('2026-07-20T00:00:00.000Z') }],
    });
    const comparisons = compareInventoryShadow(
      [
        {
          id: 'target-1',
          fingerprint: 'fp-live',
          gapKind: 'frontier_zero',
          subjectId: 'math',
          knowledgeIds: ['kc-1'],
          kind: 'any',
          difficultyBand: 'near',
          desiredCount: 1,
          minSourceTier: 2,
          routePreference: ['quiz_gen'],
          priority: 1,
          reason: 'current scanner deficit',
          constraints: {},
        },
      ],
      [projection],
    );

    await writeInventoryShadowComparisonEvents(db, comparisons, now);

    const rows = await db
      .select({ payload: event.payload, ingest_at: event.ingest_at })
      .from(event)
      .where(eq(event.action, 'experimental:supply_inventory_shadow'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({
      currentRecommendation: 'produce',
      shadowRecommendation: 'wait',
      agrees: false,
    });
    expect(rows[0]?.ingest_at).toEqual(now);
  });
});
