import { describe, expect, it } from 'vitest';
import { aiProposalKinds, parseAiProposalPayload } from './proposal';

const base = {
  target: { subject_kind: 'event', subject_id: 'target_1' },
  reason_md: 'Evidence shows this proposal should be reviewed.',
  evidence_refs: [{ kind: 'event', id: 'event_1' }],
  proposed_change: { value: 'change' },
  rollback_plan: { action: 'write correction event' },
  cooldown_key: 'proposal:test',
} as const;

describe('AiProposalPayload', () => {
  it('round-trips all proposal kinds through the union', () => {
    const samples = {
      knowledge_node: {
        ...base,
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        proposed_change: {
          mutation: 'propose_new',
          name: '通假字',
          parent_id: 'seed:wenyan:shici',
        },
      },
      knowledge_edge: {
        ...base,
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: null },
        proposed_change: {
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k2',
          relation_type: 'prerequisite',
          weight: 0.7,
        },
      },
      learning_item: {
        ...base,
        kind: 'learning_item',
        target: { subject_kind: 'learning_item', subject_id: null },
        proposed_change: { title: '虚词复习路径', knowledge_ids: ['k1'] },
      },
      note_update: {
        ...base,
        kind: 'note_update',
        target: { subject_kind: 'artifact', subject_id: 'artifact_1' },
        proposed_change: { artifact_id: 'artifact_1', patch_md: 'Add contrast section.' },
      },
      variant_question: {
        ...base,
        kind: 'variant_question',
        target: { subject_kind: 'question', subject_id: 'question_1' },
        proposed_change: { source_question_id: 'question_1', prompt_md: 'Variant prompt' },
      },
      completion: {
        ...base,
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'item_1' },
        proposed_change: { completed_at: '2026-05-23T00:00:00.000Z' },
      },
      relearn: {
        ...base,
        kind: 'relearn',
        target: { subject_kind: 'knowledge', subject_id: 'k1' },
        proposed_change: { knowledge_id: 'k1', priority: 'high' },
      },
      archive: {
        ...base,
        kind: 'archive',
        target: { subject_kind: 'knowledge', subject_id: 'k1' },
        proposed_change: { subject_kind: 'knowledge', subject_id: 'k1', reason_md: 'Duplicate' },
      },
      judge_retraction: {
        ...base,
        kind: 'judge_retraction',
        target: { subject_kind: 'event', subject_id: 'judge_1' },
        proposed_change: { judge_event_id: 'judge_1', reason_md: 'User correction superseded it.' },
      },
    } as const;

    expect(Object.keys(samples).sort()).toEqual([...aiProposalKinds].sort());
    for (const sample of Object.values(samples)) {
      const parsed = parseAiProposalPayload(sample);
      expect(parsed.kind).toBe(sample.kind);
      expect(parsed.target.subject_kind).toBe(sample.target.subject_kind);
      expect(parsed.reason_md).toBe(sample.reason_md);
      expect(parsed.evidence_refs[0]).toEqual({ kind: 'event', id: 'event_1' });
    }
  });

  it('rejects a knowledge_node proposal without current producer fields', () => {
    expect(() =>
      parseAiProposalPayload({
        ...base,
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        proposed_change: { name: '缺 parent' },
      }),
    ).toThrow();
  });

  it('rejects a knowledge_edge proposal with an unknown relation type', () => {
    expect(() =>
      parseAiProposalPayload({
        ...base,
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: null },
        proposed_change: {
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k2',
          relation_type: 'made_up',
          weight: 0.7,
        },
      }),
    ).toThrow();
  });
});
