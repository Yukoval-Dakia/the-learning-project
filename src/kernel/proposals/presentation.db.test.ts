import { expect, it } from 'vitest';
import { AiProposalPayload, aiProposalKinds } from '@/core/schema/proposal';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  loadProposalPresentations,
  proposalChangeSummary,
  proposalDisplayTitle,
} from './presentation';

const longText = '  第一行：函数与图像\n第二行：保留条件和完整推导。'.repeat(5);
const fixtures: Array<[string, string, Record<string, unknown>]> = [
  [
    'knowledge_node',
    'knowledge',
    { mutation: 'propose_new', name: '二次函数', parent_id: 'kc-parent' },
  ],
  [
    'knowledge_edge',
    'knowledge_edge',
    {
      edge_op: 'supersede',
      from_knowledge_id: 'kc-a',
      to_knowledge_id: 'kc-b',
      relation_type: 'prerequisite',
      weight: 0.8,
    },
  ],
  [
    'knowledge_mutation',
    'knowledge',
    {
      mutation: 'split',
      from_id: 'kc-a',
      into: [
        { name: '定义域', parent_id: null },
        { name: '值域', parent_id: 'kc-parent' },
      ],
      expected_version: 3,
    },
  ],
  [
    'learning_item',
    'learning_item',
    {
      hub: { title: longText },
      atomics: [{ title: '概念辨析' }],
      longs: [{ title: '综合应用' }, { title: '复习' }],
    },
  ],
  [
    'note_update',
    'artifact',
    {
      patch: { ops: [{ op: 'replace_block' }, { op: 'append_block' }] },
      summary: { ops_count: 2, new_blocks: 1 },
    },
  ],
  [
    'variant_question',
    'question',
    { prompt_md: longText, difficulty: 4, variant_depth: 2, nested: { evidence: ['original'] } },
  ],
  [
    'completion',
    'learning_item',
    { triggering_signals: ['check_all_passed', 'no_recent_mistake'] },
  ],
  [
    'relearn',
    'learning_item',
    {
      days_since_done: 21,
      current_mastery: 0.41,
      peak_mastery: 0.92,
      nested: { note: '保留其他技术信息' },
    },
  ],
  ['defer', 'learning_item', { defer_until: '2026-10-08', reason: '先复习定义域，再做综合题。' }],
  ['record_links', 'record', { link_refs: [{ id: 'r-a' }, { id: 'r-b' }] }],
  [
    'record_promotion',
    'record',
    { target: 'artifact', draft: { title: '整理函数知识', prompt_md: '后备题面' } },
  ],
  ['archive', 'artifact', { archived_reason: '已有新版本', reason: '不应覆盖优先原因' }],
  ['judge_retraction', 'event', { reason_md: '原评估遗漏图片中的第二步。' }],
  [
    'goal_scope',
    'goal',
    { title: '复习函数', scope_knowledge_ids: ['kc-a', 'kc-b'], reasoning: '覆盖薄弱知识点。' },
  ],
  [
    'block_merge',
    'question_block',
    {
      primary_block_id: 'block-a',
      merge_block_ids: ['block-b', 'block-c'],
      ingestion_session_id: 'session-a',
      continuity_signal: 'page_edge',
      confidence: 0.87,
    },
  ],
  [
    'image_candidate',
    'source_asset',
    {
      source_url: 'https://example.com/exam',
      source_title: longText,
      summary_md: '图片中包含函数图像和条件。',
      requested_kind: 'short_answer',
      knowledge_ids: ['kc-a'],
    },
  ],
  [
    'question_draft',
    'question',
    {
      question_id: 'draft-a',
      kind: 'short_answer',
      difficulty: 5,
      knowledge_ids: ['kc-a'],
      seed_mode: 'knowledge',
      prompt_preview: longText,
    },
  ],
  [
    'question_edit',
    'question',
    {
      question_id: 'q-a',
      edit: {
        op: 'edit_reference',
        node_id: 'node-a',
        answers: ['x=2', 'x=-2'],
        analysis: '代回原式验证。',
      },
      node_preview: longText,
    },
  ],
  [
    'conjecture',
    'mind_model',
    {
      claim_md: '可能混淆定义域和值域',
      knowledge_id: 'kc-a',
      cause_category: 'concept_confusion',
      confidence: 0.83,
      recurrence_count: 3,
      probe_md: '给出图像并说明定义域。',
      probe_reference_md: '不可展示的判分参考',
      discriminating: true,
      predicted_p: 0.72,
      baseline_p_at_induction: 0.51,
    },
  ],
  [
    'cause_category',
    'subject_profile',
    {
      category_id: 'domain_confusion',
      label: '定义域混淆',
      description: '把自变量范围和函数值范围混淆。',
      source: 'owner',
    },
  ],
];

it('preserves all proposal kinds, summaries, truncation and redacted technical details', async () => {
  await resetDb();
  expect(fixtures.map(([kind]) => kind).sort()).toEqual([...aiProposalKinds].sort());
  const proposals = fixtures.map(([kind, subject_kind, proposed_change]) => ({
    id: kind,
    payload: AiProposalPayload.parse({
      kind,
      target: { subject_kind, subject_id: 'target-a' },
      proposed_change,
      reason_md: '依据已有学习记录提出建议。',
      evidence_refs: [],
    }),
  }));
  const presentations = await loadProposalPresentations(testDb(), proposals);
  expect(
    proposals.map(({ id, payload }) => ({
      kind: id,
      title: proposalDisplayTitle(payload),
      summary: proposalChangeSummary(payload),
      details: presentations.get(id)?.technical_details,
    })),
  ).toMatchSnapshot();
  expect(presentations.get('conjecture')?.technical_details).toBeNull();
  expect(presentations.get('question_draft')?.technical_details).not.toContain('"difficulty":');
  expect(presentations.get('relearn')?.technical_details).not.toContain('"current_mastery":');
});
