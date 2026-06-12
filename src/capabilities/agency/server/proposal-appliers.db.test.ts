// M4-T4 (YUK-319) — learning_item proposal lifecycle 测试，从 dispatch 壳的
// actions.test.ts @ src/server/proposals 等价平移（搬迁不改逻辑）。测试继续从
// 公共 API（acceptAiProposal / dismissAiProposal / retractAiProposal）进入，
// 以覆盖「壳路由 → 包 applier」整条链。

import { artifact, event, knowledge, learning_item, proposal_signals } from '@/db/schema';
import { planLearningIntent } from '@/server/orchestrator/learning_intent';
import { acceptAiProposal, dismissAiProposal, retractAiProposal } from '@/server/proposals/actions';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

// YUK-19 — learning_item lifecycle integration.
//
// learning_item proposals are produced by planLearningIntent (the
// "我想学 X" flow). Acceptance materializes 1 hub + N atomic learning_items
// plus paired note artifact stubs through the existing acceptLearningIntent
// owner service. Retract after accept tombstones the materialized rows so
// the L3 correction outweighs any downstream evidence.
describe('learning_item proposal lifecycle', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function seedLearningItemProposal(opts: { withLong?: boolean } = {}): Promise<{
    proposalId: string;
  }> {
    const db = testDb();
    // Seed wenyan topic graph: hub `k_hub_xc` 虚词 + two children for atomic outline.
    await db.insert(knowledge).values([
      {
        id: 'k_hub_xc',
        name: '虚词',
        domain: 'wenyan',
        parent_id: null,
        merged_from: [],
        proposed_by_ai: false,
        approval_status: 'approved',
        created_at: new Date(),
        updated_at: new Date(),
        version: 0,
      },
      {
        id: 'k_zhi_xc',
        name: '之',
        domain: 'wenyan',
        parent_id: 'k_hub_xc',
        merged_from: [],
        proposed_by_ai: false,
        approval_status: 'approved',
        created_at: new Date(),
        updated_at: new Date(),
        version: 0,
      },
      {
        id: 'k_qi_xc',
        name: '其',
        domain: 'wenyan',
        parent_id: 'k_hub_xc',
        merged_from: [],
        proposed_by_ai: false,
        approval_status: 'approved',
        created_at: new Date(),
        updated_at: new Date(),
        version: 0,
      },
    ]);

    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        hub: { title: '虚词总览', summary_md: '虚词概览。' },
        atomics: [
          { knowledge_id: 'k_zhi_xc', title: '之', one_line_intent: '区分「之」用法' },
          { knowledge_id: 'k_qi_xc', title: '其', one_line_intent: '区分「其」用法' },
        ],
        longs: opts.withLong
          ? [
              {
                knowledge_ids: ['k_zhi_xc', 'k_qi_xc'],
                title: '之其综合',
                one_line_intent: '能在同一段文言翻译里区分「之」「其」。',
              },
            ]
          : [],
      }),
    }));
    const proposal = await planLearningIntent({ db, topic: '虚词', runTaskFn });
    return { proposalId: proposal.proposal_id };
  }

  it('accept materializes 1 hub + N atomic learning_items via acceptLearningIntent and records a single rate event', async () => {
    const { proposalId } = await seedLearningItemProposal();
    const result = await acceptAiProposal(testDb(), proposalId);
    expect(result.kind).toBe('learning_item');
    if (result.kind !== 'learning_item') throw new Error('unexpected result kind');
    expect(result.hub_learning_item_id).toBeTruthy();
    expect(result.atomic_learning_item_ids).toHaveLength(2);
    expect(result.long_learning_item_ids).toEqual([]);
    expect(result.hub_artifact_id).toBeTruthy();
    expect(result.atomic_artifact_ids).toHaveLength(2);
    expect(result.long_artifact_ids).toEqual([]);

    const lis = await testDb()
      .select()
      .from(learning_item)
      .where(eq(learning_item.source_ref, proposalId));
    expect(lis).toHaveLength(3);
    const hub = lis.find((row) => row.id === result.hub_learning_item_id);
    expect(hub?.parent_learning_item_id).toBeNull();
    expect(hub?.source).toBe('learning_intent');
    expect(hub?.archived_at).toBeNull();
    const atomics = lis.filter((row) => row.id !== result.hub_learning_item_id);
    for (const atomic of atomics) {
      expect(atomic.parent_learning_item_id).toBe(result.hub_learning_item_id);
      expect(atomic.archived_at).toBeNull();
    }

    // acceptLearningIntent owns rate-event writing inside its own transaction;
    // acceptAiProposal must NOT write a second rate event.
    const rateRows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)));
    expect(rateRows).toHaveLength(1);
    expect(rateRows[0].payload).toMatchObject({ rating: 'accept' });

    // Signal still records (cooldown / acceptance-rate stay in sync with other kinds).
    const signals = await testDb()
      .select()
      .from(proposal_signals)
      .where(eq(proposal_signals.kind, 'learning_item'));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ accept_count: 1, dismiss_count: 0 });
  });

  it('accept returns long note materialization ids for learning_item proposals', async () => {
    const { proposalId } = await seedLearningItemProposal({ withLong: true });
    const result = await acceptAiProposal(testDb(), proposalId);
    expect(result.kind).toBe('learning_item');
    if (result.kind !== 'learning_item') throw new Error('unexpected result kind');

    expect(result.atomic_artifact_ids).toHaveLength(2);
    expect(result.long_learning_item_ids).toHaveLength(1);
    expect(result.long_artifact_ids).toHaveLength(1);

    const second = await acceptAiProposal(testDb(), proposalId);
    expect(second).toMatchObject({
      kind: 'learning_item',
      idempotent: true,
      long_learning_item_ids: result.long_learning_item_ids,
      long_artifact_ids: result.long_artifact_ids,
    });
  });

  it('dismiss writes a generic rate event without materializing learning_items', async () => {
    const { proposalId } = await seedLearningItemProposal();
    const result = await dismissAiProposal(testDb(), proposalId, { user_note: 'changed mind' });
    expect(result.kind).toBe('dismissed');

    const lis = await testDb()
      .select()
      .from(learning_item)
      .where(eq(learning_item.source_ref, proposalId));
    expect(lis).toHaveLength(0);

    const rateRows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)));
    expect(rateRows).toHaveLength(1);
    expect(rateRows[0].payload).toMatchObject({ rating: 'dismiss', user_note: 'changed mind' });

    const signals = await testDb()
      .select()
      .from(proposal_signals)
      .where(eq(proposal_signals.kind, 'learning_item'));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ dismiss_count: 1, accept_count: 0 });
  });

  it('retract before accept writes only the correction event; nothing to tombstone', async () => {
    const { proposalId } = await seedLearningItemProposal();
    const result = await retractAiProposal(testDb(), proposalId, { reason_md: 'noise' });
    expect(result.kind).toBe('retracted');

    const lis = await testDb()
      .select()
      .from(learning_item)
      .where(eq(learning_item.source_ref, proposalId));
    expect(lis).toHaveLength(0);
  });

  it('retract after accept tombstones hub + atomic + long learning_items and all proposal-sourced artifacts', async () => {
    const { proposalId } = await seedLearningItemProposal({ withLong: true });
    const accepted = await acceptAiProposal(testDb(), proposalId);
    if (accepted.kind !== 'learning_item') throw new Error('expected learning_item accept');
    const sourceAtomicArtifactId = accepted.atomic_artifact_ids[0];
    if (!sourceAtomicArtifactId) throw new Error('expected atomic artifact id');
    const quizArtifactId = 'quiz_retract_1';
    const now = new Date();
    await testDb()
      .insert(artifact)
      .values({
        id: quizArtifactId,
        type: 'tool_quiz',
        title: '之的用法 自检',
        parent_artifact_id: null,
        knowledge_ids: ['k_zhi_xc'],
        intent_source: 'embedded_check',
        source: 'ai_generated',
        source_ref: proposalId,
        body_blocks: null,
        attrs: {
          embedded_for_artifact_id: sourceAtomicArtifactId,
          check_block_id: 's_check',
        } as never,
        tool_kind: 'embedded_check',
        tool_state: {
          question_ids: [],
          session_meta: {
            source_artifact_id: sourceAtomicArtifactId,
            check_block_id: 's_check',
          },
        } as never,
        generation_status: 'ready',
        verification_status: 'not_required',
        generated_by: null,
        history: [],
        created_at: now,
        updated_at: now,
        version: 0,
      });

    const retracted = await retractAiProposal(testDb(), proposalId, { reason_md: 'rewrite' });
    expect(retracted.kind).toBe('retracted');

    const liRows = await testDb()
      .select()
      .from(learning_item)
      .where(eq(learning_item.source_ref, proposalId));
    expect(liRows).toHaveLength(4);
    for (const li of liRows) {
      expect(li.archived_at).not.toBeNull();
      expect(li.archived_reason).toBe('proposal_retracted');
    }

    const artifactIds = [
      accepted.hub_artifact_id,
      ...accepted.atomic_artifact_ids,
      ...accepted.long_artifact_ids,
      quizArtifactId,
    ];
    const artifactRows = await testDb()
      .select()
      .from(artifact)
      .where(eq(artifact.source_ref, proposalId));
    expect(new Set(artifactRows.map((row) => row.id))).toEqual(new Set(artifactIds));
    for (const art of artifactRows) {
      expect(art.archived_at).not.toBeNull();
    }
  });

  it('accept idempotent: second accept returns the existing materialization after the first writes a rate event', async () => {
    const { proposalId } = await seedLearningItemProposal();
    const first = await acceptAiProposal(testDb(), proposalId);
    if (first.kind !== 'learning_item') throw new Error('expected learning_item');

    const second = await acceptAiProposal(testDb(), proposalId);
    expect(second).toMatchObject({
      kind: 'learning_item',
      idempotent: true,
      hub_learning_item_id: first.hub_learning_item_id,
      atomic_learning_item_ids: first.atomic_learning_item_ids,
      long_learning_item_ids: first.long_learning_item_ids,
      hub_artifact_id: first.hub_artifact_id,
      atomic_artifact_ids: first.atomic_artifact_ids,
      long_artifact_ids: first.long_artifact_ids,
    });

    // Hub + atomics still exist exactly once.
    const liRows = await testDb()
      .select()
      .from(learning_item)
      .where(eq(learning_item.source_ref, proposalId));
    expect(liRows).toHaveLength(3);
  });

  it('retract already-archived rows is idempotent — second retract leaves rows alone', async () => {
    const { proposalId } = await seedLearningItemProposal();
    await acceptAiProposal(testDb(), proposalId);
    await retractAiProposal(testDb(), proposalId, { reason_md: 'first' });

    // orderBy 钉行序：proposal 落 3 行 learning_item，无序 select 两次可能拿到
    // 不同首行，比较 [0] 即假阳性（coderabbit minor）。
    const firstSnapshot = await testDb()
      .select()
      .from(learning_item)
      .where(eq(learning_item.source_ref, proposalId))
      .orderBy(learning_item.id);
    const firstArchivedAt = firstSnapshot[0].archived_at;
    const firstVersion = firstSnapshot[0].version;

    await retractAiProposal(testDb(), proposalId, { reason_md: 'second' });

    const secondSnapshot = await testDb()
      .select()
      .from(learning_item)
      .where(eq(learning_item.source_ref, proposalId))
      .orderBy(learning_item.id);
    // archived_at + version should not change because we only tombstone rows
    // that are not already archived.
    expect(secondSnapshot[0].archived_at).toEqual(firstArchivedAt);
    expect(secondSnapshot[0].version).toBe(firstVersion);
  });
});
