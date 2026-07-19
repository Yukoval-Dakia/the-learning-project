import { type AiProposalPayloadT, resolveSuggestionKind } from '@/core/schema/proposal';
import { event, question, question_block } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { listProposalInboxRows } from './inbox';
import { proposalChangeSummary, proposalDisplayTitle } from './presentation';
import {
  writeArchiveProposal,
  writeBlockMergeProposal,
  writeCompletionProposal,
  writeJudgeRetractionProposal,
  writeLearningItemProposal,
  writeRelearnProposal,
  writeVariantQuestionProposal,
} from './producers';

describe('proposal producer helpers', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes the remaining six producer-backed proposal kinds through the shared inbox reader', async () => {
    const db = testDb();
    const now = new Date('2026-07-19T08:00:00.000Z');
    await db.insert(question).values({
      id: 'q1',
      kind: 'short_answer',
      prompt_md: '解释「之」在句中的作用。',
      source: 'test',
      created_at: now,
      updated_at: now,
    });
    await writeVariantQuestionProposal(db, {
      source_question_id: 'q1',
      source_attempt_event_id: 'attempt_1',
      prompt_md: 'variant prompt',
      reference_md: 'variant reference',
      difficulty: 3,
      knowledge_ids: ['k1'],
      parent_variant_id: 'q1',
      root_question_id: 'q1',
      variant_depth: 1,
      reason_md: 'targets the same cause',
    });
    // YUK-358 决定7 — writeNoteUpdateProposal (patch-less note_verify producer)
    // was deleted; the note_update proposal KIND is still produced (with a patch)
    // by writeNoteRefineProposal, exercised in the note-refine tests.
    await writeLearningItemProposal(db, {
      topic: '虚词',
      knowledge_node: { id: 'k1', name: '虚词' },
      hub: { title: '虚词总览', summary_md: 'overview' },
      atomics: [{ knowledge_id: 'k1', title: '之', one_line_intent: 'distinguish usages' }],
      reason_md: 'user asked to learn this topic',
    });
    await writeCompletionProposal(db, {
      learning_item_id: 'li_done',
      triggering_signals: ['check_all_passed'],
      reason_md: 'all checks passed',
    });
    await writeRelearnProposal(db, {
      learning_item_id: 'li_relearn',
      current_mastery: 0.42,
      peak_mastery: 0.91,
      days_since_done: 21,
      reason_md: 'mastery decayed after completion',
    });
    await writeArchiveProposal(db, {
      target_subject_kind: 'learning_item',
      target_subject_id: 'li_archive',
      proposed_change: { status: 'archived', archived_reason: 'maintenance' },
      reason_md: 'stale item should leave the active queue',
    });
    await db.insert(event).values({
      id: 'judge_1',
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'judge_runner',
      action: 'judge',
      subject_kind: 'event',
      subject_id: 'attempt_1',
      outcome: 'success',
      payload: { coarse_outcome: 'partial' },
      caused_by_event_id: 'attempt_1',
      created_at: new Date(),
    });
    await writeJudgeRetractionProposal(db, {
      judge_event_id: 'judge_1',
      appeal_event_id: 'appeal_1',
      reason_md: 'learner appeal shows the judge was wrong',
    });

    const rows = await listProposalInboxRows(db, { status: 'pending' });
    expect(rows.map((row) => row.kind).sort()).toEqual(
      [
        'archive',
        'completion',
        'judge_retraction',
        'learning_item',
        'relearn',
        'variant_question',
      ].sort(),
    );
    expect(rows.every((row) => row.payload.cooldown_key)).toBe(true);
    const variant = rows.find((row) => row.kind === 'variant_question');
    expect(variant?.presentation?.evidence_labels['question:q1']).toBe(
      '题目 · 解释「之」在句中的作用。',
    );
  });

  it('rejects judge_retraction evidence refs that do not point to judge events', async () => {
    const db = testDb();
    await db.insert(event).values({
      id: 'attempt_1',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'partial',
      payload: { answer: 'x' },
      caused_by_event_id: null,
      created_at: new Date(),
    });

    await expect(
      writeJudgeRetractionProposal(db, {
        judge_event_id: 'attempt_1',
        reason_md: 'attempt is not a judge event',
      }),
    ).rejects.toMatchObject({
      code: 'evidence_ref_must_be_judge_event',
      status: 422,
    });
  });

  it('preserves the learning intent legacy action when requested', async () => {
    const db = testDb();
    const id = await writeLearningItemProposal(db, {
      topic: '虚词',
      knowledge_node: { id: 'k1', name: '虚词' },
      hub: { title: '虚词总览', summary_md: 'overview' },
      atomics: [{ knowledge_id: 'k1', title: '之', one_line_intent: 'distinguish usages' }],
      reason_md: 'user asked to learn this topic',
      legacy_subject_id: 'artifact_synthetic',
      legacy_event_payload: {
        topic: '虚词',
        knowledge_node_id: 'k1',
        knowledge_node: { id: 'k1', name: '虚词', domain: 'yuwen' },
        hub: { title: '虚词总览', summary_md: 'overview' },
        atomics: [{ knowledge_id: 'k1', title: '之', one_line_intent: 'distinguish usages' }],
      },
    });

    const row = (await db.select().from(event).where(eq(event.id, id)))[0];
    expect(row.action).toBe('experimental:propose_learning_intent');
    expect(row.subject_kind).toBe('artifact');
    expect((row.payload as { ai_proposal?: { kind?: string } }).ai_proposal?.kind).toBe(
      'learning_item',
    );
  });

  // YUK-202 / BlockAssembly path-B (design 2026-06-02 §1.C + §5) — the
  // writeBlockMergeProposal producer writes a `block_merge` proposal event that
  // flows through the default writer branch (action='experimental:proposal',
  // subject_kind='question_block') and is therefore selectable by proposalWhere()
  // — i.e. it lands in the shared inbox reader. AI never auto-merges; this
  // producer only proposes (S2's acceptBlockMergeProposal runs mergeQuestions on
  // user accept).
  it('writeBlockMergeProposal lands a block_merge proposal in the inbox with the typed change read back', async () => {
    const db = testDb();
    const now = new Date('2026-07-19T08:00:00.000Z');
    await db.insert(question_block).values([
      {
        id: 'block_a',
        ingestion_session_id: 'sess_1',
        ordinal: 0,
        page_spans: [{ page_index: 0, bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.2 } }],
        structured: {
          id: 'sq_a',
          role: 'standalone',
          question_no: '12',
          prompt_text: '已知函数 f(x) 在区间上连续，',
        },
        created_at: now,
        updated_at: now,
      },
      {
        id: 'block_b',
        ingestion_session_id: 'sess_1',
        ordinal: 1,
        page_spans: [{ page_index: 0, bbox: { x: 0.1, y: 0.35, width: 0.8, height: 0.2 } }],
        structured: {
          id: 'sq_b',
          role: 'standalone',
          question_no: '12',
          prompt_text: '并满足 f(0)=1，求函数的最小值。',
        },
        created_at: now,
        updated_at: now,
      },
      {
        id: 'block_c',
        ingestion_session_id: 'sess_1',
        ordinal: 2,
        page_spans: [{ page_index: 1, bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.2 } }],
        structured: {
          id: 'sq_c',
          role: 'standalone',
          question_no: '12',
          prompt_text: '请写出完整推导过程。',
        },
        created_at: now,
        updated_at: now,
      },
    ]);
    const id = await writeBlockMergeProposal(db, {
      ingestion_session_id: 'sess_1',
      primary_block_id: 'block_a',
      merge_block_ids: ['block_b', 'block_c'],
      confidence: 0.82,
      continuity_signal: 'numbering',
      reason_md: 'question_no continuity: block_b/block_c continue block_a numbering',
    });

    const rows = await listProposalInboxRows(db, { status: 'pending' });
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error('expected the block_merge proposal in the inbox');

    expect(row.kind).toBe('block_merge');
    // Default writer branch (no event_override) → experimental:proposal / question_block.
    expect(row.source_action).toBe('experimental:proposal');
    expect(row.target.subject_kind).toBe('question_block');
    expect(row.target.subject_id).toBe('block_a');
    expect(row.actor_ref).toBe('block_assembly');

    if (row.payload.kind !== 'block_merge') throw new Error('expected block_merge payload');
    expect(row.payload.proposed_change).toEqual({
      primary_block_id: 'block_a',
      merge_block_ids: ['block_b', 'block_c'],
      ingestion_session_id: 'sess_1',
      continuity_signal: 'numbering',
      // YUK-202 fork 4a — confidence is persisted for the redraw inbox to sort by.
      confidence: 0.82,
    });
    // §1.C — primary + each merge candidate is an evidence ref for the inbox preview.
    expect(row.payload.evidence_refs).toEqual([
      { kind: 'question', id: 'block_a' },
      { kind: 'question', id: 'block_b' },
      { kind: 'question', id: 'block_c' },
    ]);
    expect(row.payload.cooldown_key).toBe('block_merge:sess_1:block_a:block_b,block_c');
    // YUK-202 — block_merge is a PROACTIVE structural suggestion, NOT a failure-retry
    // (variant_question is the only corrective kind, SK-3). It must NOT carry
    // suggestion_kind:'corrective', else signals.ts early-returns on accept and drops
    // the proposal_signals row / accept_count / cooldown clear for a real production
    // proposal. Guard the resolved kind, not just the absent field.
    expect(row.payload.suggestion_kind).toBeUndefined();
    expect(resolveSuggestionKind(row.payload)).toBe('proactive');
    expect(row.presentation).toMatchObject({
      title: '合并 3 个被切断的题块',
      change_summary: [{ label: '动作', value: '保留 1 块，并入 2 块' }],
      evidence_labels: {
        'question:block_a': '第 1 块 · 题号 12 · 第 1 页 · 已知函数 f(x) 在区间上连续，',
        'question:block_b': '第 2 块 · 题号 12 · 第 1 页 · 并满足 f(0)=1，求函数的最小值。',
        'question:block_c': '第 3 块 · 题号 12 · 第 2 页 · 请写出完整推导过程。',
      },
      block_merge: {
        primary: {
          id: 'block_a',
          label: '第 1 块 · 题号 12 · 第 1 页',
          excerpt: '已知函数 f(x) 在区间上连续，',
        },
        merged: [
          {
            id: 'block_b',
            label: '第 2 块 · 题号 12 · 第 1 页',
            excerpt: '并满足 f(0)=1，求函数的最小值。',
          },
          {
            id: 'block_c',
            label: '第 3 块 · 题号 12 · 第 2 页',
            excerpt: '请写出完整推导过程。',
          },
        ],
        continuity_label: '题号连续',
      },
    });
    expect(JSON.parse(row.presentation?.technical_details ?? 'null')).toEqual(
      row.payload.proposed_change,
    );
  });

  it('derives a meaningful title from every proposal kind without using opaque ids', () => {
    const payload = (kind: string, proposed_change: Record<string, unknown>) =>
      ({ kind, proposed_change }) as unknown as AiProposalPayloadT;
    const cases: Array<[AiProposalPayloadT, string]> = [
      [payload('knowledge_node', { name: '二次函数' }), '新知识点：二次函数'],
      [payload('knowledge_edge', {}), '调整知识关系'],
      [payload('knowledge_mutation', { mutation: 'split' }), '拆分知识点'],
      [
        payload('learning_item', { topic: '虚词', hub: { title: '虚词总览' } }),
        '建立学习主线：虚词总览',
      ],
      [payload('note_update', { summary: '补充易错点' }), '更新学习笔记：补充易错点'],
      [payload('variant_question', { prompt_md: '求函数最值' }), '生成变式练习：求函数最值'],
      [payload('record_promotion', {}), '整理学习记录'],
      [payload('record_links', {}), '补充记录关联'],
      [payload('completion', {}), '确认学习项已完成'],
      [payload('relearn', {}), '重新巩固学习项'],
      [payload('goal_scope', { title: '本周复习函数' }), '确认目标范围：本周复习函数'],
      [payload('block_merge', { merge_block_ids: ['b', 'c'] }), '合并 3 个被切断的题块'],
      [payload('defer', {}), '调整学习安排'],
      [payload('archive', {}), '归档学习内容'],
      [payload('judge_retraction', {}), '复核一次 AI 判定'],
      [payload('image_candidate', { source_title: '函数图像' }), '图题来源：函数图像'],
      [payload('question_draft', { prompt_preview: '证明两角相等' }), '审核新题：证明两角相等'],
      [payload('question_edit', { node_preview: '原题面摘要' }), '修订一道题目：原题面摘要'],
      [
        payload('conjecture', { claim_md: '你可能混淆了两个定义' }),
        '验证诊断推测：你可能混淆了两个定义',
      ],
    ];

    expect(cases.map(([candidate]) => proposalDisplayTitle(candidate))).toEqual(
      cases.map(([, expected]) => expected),
    );
  });

  it('keeps AI estimates qualitative and maps record/question edits to their real fields', () => {
    const payload = (kind: string, proposed_change: Record<string, unknown>) =>
      ({ kind, proposed_change }) as unknown as AiProposalPayloadT;

    expect(
      proposalChangeSummary(
        payload('question_draft', {
          prompt_preview: '证明两角相等',
          kind: 'short_answer',
          difficulty: 5,
        }),
      ),
    ).toEqual([
      { label: '题面', value: '证明两角相等' },
      { label: '题型', value: '简答题' },
      { label: 'AI 估计难度', value: '偏高（AI 估计，仅供参考）' },
    ]);
    expect(
      proposalChangeSummary(payload('relearn', { current_mastery: 0.41, peak_mastery: 0.92 })),
    ).toEqual([
      {
        label: 'AI 估计掌握趋势',
        value: '较历史高点明显回落（AI 估计，仅供参考）',
      },
    ]);

    expect(
      proposalChangeSummary(
        payload('record_promotion', {
          target: 'learning_item',
          draft: { title: '虚词辨析计划' },
        }),
      ),
    ).toEqual([
      { label: '目标', value: '整理为学习项' },
      { label: '草稿标题或题面', value: '虚词辨析计划' },
    ]);

    expect(
      proposalChangeSummary(
        payload('question_edit', {
          node_preview: '选择正确解释',
          edit: {
            op: 'set_choice',
            node_id: 'node_1',
            options: [
              { label: 'A', text: '代词' },
              { label: 'B', text: '助词' },
            ],
          },
        }),
      ),
    ).toEqual([
      { label: '修改', value: '更新选项' },
      { label: '题面定位', value: '选择正确解释' },
      { label: '新选项', value: 'A. 代词；B. 助词' },
    ]);
    expect(
      proposalChangeSummary(
        payload('question_edit', {
          node_preview: '解释句意',
          edit: {
            op: 'edit_reference',
            node_id: 'node_2',
            answers: ['取消句子独立性'],
          },
        }),
      ),
    ).toEqual([
      { label: '修改', value: '修改答案或解析' },
      { label: '题面定位', value: '解释句意' },
      { label: '新答案', value: '取消句子独立性' },
    ]);
    expect(
      proposalChangeSummary(
        payload('question_edit', {
          node_preview: '判断下列说法',
          edit: { op: 'set_node_kind', node_id: 'node_3', kind: 'true_false' },
        }),
      ),
    ).toContainEqual({ label: '新题型', value: '判断题' });

    expect(
      proposalChangeSummary(payload('note_update', { summary: { ops_count: 2, new_blocks: 1 } })),
    ).toEqual([
      { label: '修改', value: '2 处内容调整' },
      { label: '说明', value: '2 处内容调整，其中新增 1 块' },
    ]);
  });

  it('does not present missing or cross-session merge blocks as valid candidates', async () => {
    const db = testDb();
    const now = new Date('2026-07-19T08:00:00.000Z');
    await db.insert(question_block).values([
      {
        id: 'primary_live',
        ingestion_session_id: 'sess_expected',
        ordinal: 0,
        structured: { id: 'primary', role: 'standalone', prompt_text: '保留题面' },
        created_at: now,
        updated_at: now,
      },
      {
        id: 'foreign_block',
        ingestion_session_id: 'sess_other',
        ordinal: 1,
        structured: { id: 'foreign', role: 'standalone', prompt_text: '不应展示的题面' },
        created_at: now,
        updated_at: now,
      },
    ]);
    const id = await writeBlockMergeProposal(db, {
      ingestion_session_id: 'sess_expected',
      primary_block_id: 'primary_live',
      merge_block_ids: ['foreign_block', 'missing_block'],
      confidence: 0.6,
      continuity_signal: 'carryover',
      reason_md: '候选题块可能已经变化',
    });

    const row = (await listProposalInboxRows(db, { status: 'pending' })).find(
      (candidate) => candidate.id === id,
    );
    expect(row?.presentation).toMatchObject({
      title: '检查被切断的题块',
      change_summary: [{ label: '动作', value: '候选题块已变化，请重新检查' }],
      evidence_labels: {
        'question:primary_live': '第 1 块 · 保留题面',
      },
      block_merge: {
        primary: { id: 'primary_live', excerpt: '保留题面' },
        merged: [],
      },
    });
    expect(row?.presentation?.evidence_labels).not.toHaveProperty('question:foreign_block');
    expect(row?.presentation?.evidence_labels).not.toHaveProperty('question:missing_block');
  });

  // §5 dedup (1) — the cooldown_key is derived from the SORTED merge ids, so a
  // duplicate candidate for the same block set (regardless of merge-id ordering)
  // produces the SAME (kind, cooldown_key). writeAiProposal does not hard-suppress
  // a second write (the proposal_signals aggregate keys on (kind, cooldown_key) and
  // intentionally aggregates sibling proposals — signals.ts), so both events land;
  // the shared cooldown_key is what folds them in the inbox cooldown signal.
  it('writeBlockMergeProposal derives a stable cooldown_key from sorted merge ids (dedup key)', async () => {
    const db = testDb();
    const first = await writeBlockMergeProposal(db, {
      ingestion_session_id: 'sess_1',
      primary_block_id: 'block_a',
      merge_block_ids: ['block_b', 'block_c'],
      confidence: 0.7,
      continuity_signal: 'carryover',
      reason_md: 'carryover cue from block_a',
    });
    // Same block set, merge ids in a different order → must collapse to one key.
    const second = await writeBlockMergeProposal(db, {
      ingestion_session_id: 'sess_1',
      primary_block_id: 'block_a',
      merge_block_ids: ['block_c', 'block_b'],
      confidence: 0.7,
      continuity_signal: 'carryover',
      reason_md: 'carryover cue from block_a (re-proposed)',
    });

    const rows = await listProposalInboxRows(db, { status: 'pending' });
    const firstRow = rows.find((r) => r.id === first);
    const secondRow = rows.find((r) => r.id === second);
    if (!firstRow || !secondRow) throw new Error('expected both block_merge proposals');

    expect(firstRow.payload.cooldown_key).toBe('block_merge:sess_1:block_a:block_b,block_c');
    expect(secondRow.payload.cooldown_key).toBe(firstRow.payload.cooldown_key);
  });

  // P5.6 / YUK-178 (AC-2, SK-3) — the variant_question producer is the only
  // structurally-corrective proposal kind: it fires ONLY after a failed attempt,
  // so it hard-sets suggestion_kind:'corrective'. Other producers leave it absent
  // (→ proactive), proving the default-to-proactive contract (ND-SK-1).
  it('variant_question producer hard-sets suggestion_kind:corrective; siblings stay proactive', async () => {
    const db = testDb();
    await writeVariantQuestionProposal(db, {
      source_question_id: 'q1',
      source_attempt_event_id: 'attempt_1',
      prompt_md: 'variant prompt',
      reference_md: 'variant reference',
      difficulty: 3,
      knowledge_ids: ['k1'],
      parent_variant_id: 'q1',
      root_question_id: 'q1',
      variant_depth: 1,
      reason_md: 'targets the same cause',
    });
    await writeCompletionProposal(db, {
      learning_item_id: 'li_done',
      triggering_signals: ['check_all_passed'],
      reason_md: 'all checks passed',
    });

    const rows = await listProposalInboxRows(db, { status: 'pending' });
    const variant = rows.find((row) => row.kind === 'variant_question');
    const completion = rows.find((row) => row.kind === 'completion');
    if (!variant || !completion) throw new Error('expected variant + completion proposals');

    expect(variant.payload.suggestion_kind).toBe('corrective');
    expect(resolveSuggestionKind(variant.payload)).toBe('corrective');

    // Audited always-proactive maintenance kind — field absent, reader proactive.
    expect(completion.payload.suggestion_kind).toBeUndefined();
    expect(resolveSuggestionKind(completion.payload)).toBe('proactive');
  });
});
