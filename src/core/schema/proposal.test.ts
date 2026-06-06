import { describe, expect, it } from 'vitest';
import { aiProposalKinds, parseAiProposalPayload, resolveSuggestionKind } from './proposal';

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
      knowledge_mutation: {
        ...base,
        kind: 'knowledge_mutation',
        target: { subject_kind: 'knowledge', subject_id: 'k2' },
        proposed_change: {
          mutation: 'merge',
          from_ids: ['k1'],
          into_id: 'k2',
          expected_versions: { k1: 0 },
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
      defer: {
        ...base,
        kind: 'defer',
        target: { subject_kind: 'learning_item', subject_id: 'item_2' },
        proposed_change: {
          learning_item_id: 'item_2',
          defer_until: '2026-06-15T00:00:00.000Z',
          reason: 'low energy this week',
        },
      },
      record_links: {
        ...base,
        kind: 'record_links',
        target: { subject_kind: 'record', subject_id: 'record_1' },
        proposed_change: {
          record_id: 'record_1',
          links: [{ target_kind: 'knowledge', target_id: 'k1', relation: 'about' }],
        },
      },
      record_promotion: {
        ...base,
        kind: 'record_promotion',
        target: { subject_kind: 'record', subject_id: 'record_1' },
        proposed_change: {
          record_id: 'record_1',
          target: 'learning_item',
          draft: { title: 'Turn the open question into a study item' },
        },
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
      // YUK-143 / ADR-0025 — North-Star goal_scope proposal.
      goal_scope: {
        ...base,
        kind: 'goal_scope',
        target: { subject_kind: 'goal', subject_id: 'goal_1' },
        proposed_change: {
          title: '能流畅读《史记》',
          subject_id: 'wenyan',
          scope_knowledge_ids: ['k1', 'k2'],
          sequence_hint: 0,
          reasoning: 'k1 是 k2 的 prerequisite，两者共同构成该目标的覆盖范围。',
        },
      },
      // YUK-202 / BlockAssembly path-B (design 2026-06-02 §1) — block_merge.
      block_merge: {
        ...base,
        kind: 'block_merge',
        target: { subject_kind: 'question_block', subject_id: 'block_1' },
        proposed_change: {
          primary_block_id: 'block_1',
          merge_block_ids: ['block_2'],
          ingestion_session_id: 'session_1',
          continuity_signal: 'numbering',
        },
      },
      // YUK-227 S3 Slice C (ADR-0002 / FIX-3) — image_candidate carries the
      // sourcing-resolved knowledge_ids so accept can attribute the materialized
      // question (the text path stamps these too).
      image_candidate: {
        ...base,
        kind: 'image_candidate',
        target: { subject_kind: 'source_asset', subject_id: null },
        proposed_change: {
          source_url: 'https://example.edu/wenyan/scan.png',
          source_title: '论语·学而 扫描卷',
          summary_md: 'tavily_extract 返回空文本；搜索结果显示该页含题目图片。',
          knowledge_ids: ['k1'],
        },
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

  // YUK-227 S3 Slice C (FIX-3) — image_candidate knowledge_ids attribution channel.
  it('round-trips image_candidate.knowledge_ids and defaults a missing field to []', () => {
    const withIds = parseAiProposalPayload({
      ...base,
      kind: 'image_candidate',
      target: { subject_kind: 'source_asset', subject_id: null },
      proposed_change: {
        source_url: 'https://example.edu/wenyan/scan.png',
        source_title: '扫描卷',
        summary_md: '图片型源',
        knowledge_ids: ['k1', 'k2'],
      },
    });
    if (withIds.kind !== 'image_candidate') throw new Error('unreachable');
    expect(withIds.proposed_change.knowledge_ids).toEqual(['k1', 'k2']);

    // A legacy proposal written before FIX-3 (no knowledge_ids) still parses; the
    // field defaults to [] so accept inserts an empty attribution exactly as before.
    const legacy = parseAiProposalPayload({
      ...base,
      kind: 'image_candidate',
      target: { subject_kind: 'source_asset', subject_id: null },
      proposed_change: {
        source_url: 'https://example.edu/wenyan/scan.png',
        source_title: '扫描卷',
        summary_md: '图片型源',
      },
    });
    if (legacy.kind !== 'image_candidate') throw new Error('unreachable');
    expect(legacy.proposed_change.knowledge_ids).toEqual([]);
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

  // YUK-202 / BlockAssembly path-B (design 2026-06-02 §1).
  it('accepts a valid block_merge proposal', () => {
    const parsed = parseAiProposalPayload({
      ...base,
      kind: 'block_merge',
      target: { subject_kind: 'question_block', subject_id: 'block_1' },
      proposed_change: {
        primary_block_id: 'block_1',
        merge_block_ids: ['block_2', 'block_3'],
        ingestion_session_id: 'session_1',
        continuity_signal: 'stem_answer_split',
      },
    });
    expect(parsed.kind).toBe('block_merge');
    expect(parsed.target.subject_kind).toBe('question_block');
    if (parsed.kind === 'block_merge') {
      expect(parsed.proposed_change.primary_block_id).toBe('block_1');
      expect(parsed.proposed_change.merge_block_ids).toEqual(['block_2', 'block_3']);
      expect(parsed.proposed_change.ingestion_session_id).toBe('session_1');
      expect(parsed.proposed_change.continuity_signal).toBe('stem_answer_split');
    }
  });

  it('rejects a block_merge proposal with empty merge_block_ids', () => {
    expect(() =>
      parseAiProposalPayload({
        ...base,
        kind: 'block_merge',
        target: { subject_kind: 'question_block', subject_id: 'block_1' },
        proposed_change: {
          primary_block_id: 'block_1',
          merge_block_ids: [],
          ingestion_session_id: 'session_1',
        },
      }),
    ).toThrow();
  });

  it('rejects a block_merge proposal with the wrong target.subject_kind', () => {
    expect(() =>
      parseAiProposalPayload({
        ...base,
        kind: 'block_merge',
        target: { subject_kind: 'question', subject_id: 'block_1' },
        proposed_change: {
          primary_block_id: 'block_1',
          merge_block_ids: ['block_2'],
          ingestion_session_id: 'session_1',
        },
      }),
    ).toThrow();
  });
});

// P5.6 / YUK-178 — suggestion_kind discriminator (AC-2 schema scope, ND-SK-1).
describe('suggestion_kind (P5.6 / YUK-178)', () => {
  it('is optional on every proposal kind — a payload without it parses and reads proactive', () => {
    const sampleByKind: Record<string, Record<string, unknown>> = {
      knowledge_node: {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        proposed_change: { mutation: 'propose_new', name: 'n', parent_id: 'p' },
      },
      knowledge_edge: {
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: null },
        proposed_change: {
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k2',
          relation_type: 'prerequisite',
          weight: 1,
        },
      },
      knowledge_mutation: {
        kind: 'knowledge_mutation',
        target: { subject_kind: 'knowledge', subject_id: 'k2' },
        proposed_change: {
          mutation: 'merge',
          from_ids: ['k1'],
          into_id: 'k2',
          expected_versions: { k1: 0 },
        },
      },
      learning_item: {
        kind: 'learning_item',
        target: { subject_kind: 'learning_item', subject_id: null },
        proposed_change: { topic: 't' },
      },
      note_update: {
        kind: 'note_update',
        target: { subject_kind: 'artifact', subject_id: 'a1' },
        proposed_change: { artifact_id: 'a1' },
      },
      variant_question: {
        kind: 'variant_question',
        target: { subject_kind: 'question', subject_id: 'q1' },
        proposed_change: { source_question_id: 'q1' },
      },
      completion: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'i1' },
        proposed_change: { learning_item_id: 'i1' },
      },
      relearn: {
        kind: 'relearn',
        target: { subject_kind: 'knowledge', subject_id: 'k1' },
        proposed_change: { knowledge_id: 'k1' },
      },
      defer: {
        kind: 'defer',
        target: { subject_kind: 'learning_item', subject_id: 'i2' },
        proposed_change: { learning_item_id: 'i2' },
      },
      record_links: {
        kind: 'record_links',
        target: { subject_kind: 'record', subject_id: 'r1' },
        proposed_change: { record_id: 'r1' },
      },
      record_promotion: {
        kind: 'record_promotion',
        target: { subject_kind: 'record', subject_id: 'r1' },
        proposed_change: { record_id: 'r1', target: 'learning_item' },
      },
      archive: {
        kind: 'archive',
        target: { subject_kind: 'knowledge', subject_id: 'k1' },
        proposed_change: { subject_kind: 'knowledge', subject_id: 'k1' },
      },
      judge_retraction: {
        kind: 'judge_retraction',
        target: { subject_kind: 'event', subject_id: 'j1' },
        proposed_change: { judge_event_id: 'j1' },
      },
      goal_scope: {
        kind: 'goal_scope',
        target: { subject_kind: 'goal', subject_id: 'g1' },
        proposed_change: {
          title: 't',
          scope_knowledge_ids: [],
          sequence_hint: 0,
          reasoning: 'r',
        },
      },
      block_merge: {
        kind: 'block_merge',
        target: { subject_kind: 'question_block', subject_id: 'b1' },
        proposed_change: {
          primary_block_id: 'b1',
          merge_block_ids: ['b2'],
          ingestion_session_id: 's1',
        },
      },
      image_candidate: {
        kind: 'image_candidate',
        target: { subject_kind: 'source_asset', subject_id: null },
        proposed_change: {
          source_url: 'https://example.edu/scan.png',
          source_title: '扫描卷',
          summary_md: '图片型源',
        },
      },
    };
    // Audit-coverage guard (AC-2): the sample map covers every AiProposalKind, so
    // a future kind addition that forgets the optional-field check is caught.
    expect(Object.keys(sampleByKind).sort()).toEqual([...aiProposalKinds].sort());

    for (const sample of Object.values(sampleByKind)) {
      const parsed = parseAiProposalPayload({ ...base, ...sample });
      // Field-absent → undefined on the payload, proactive via the reader.
      expect(parsed.suggestion_kind).toBeUndefined();
      expect(resolveSuggestionKind(parsed)).toBe('proactive');
    }
  });

  it("round-trips an explicit suggestion_kind:'corrective' on a knowledge_edge", () => {
    const parsed = parseAiProposalPayload({
      ...base,
      kind: 'knowledge_edge',
      target: { subject_kind: 'knowledge_edge', subject_id: null },
      proposed_change: {
        from_knowledge_id: 'k1',
        to_knowledge_id: 'k2',
        relation_type: 'prerequisite',
        weight: 1,
      },
      suggestion_kind: 'corrective',
    });
    expect(parsed.suggestion_kind).toBe('corrective');
    expect(resolveSuggestionKind(parsed)).toBe('corrective');
  });

  it('rejects an out-of-enum suggestion_kind', () => {
    expect(() =>
      parseAiProposalPayload({
        ...base,
        kind: 'variant_question',
        target: { subject_kind: 'question', subject_id: 'q1' },
        proposed_change: { source_question_id: 'q1' },
        suggestion_kind: 'maintenance',
      }),
    ).toThrow();
  });

  it('resolveSuggestionKind defaults absence to proactive', () => {
    expect(resolveSuggestionKind({})).toBe('proactive');
    expect(resolveSuggestionKind({ suggestion_kind: undefined })).toBe('proactive');
    expect(resolveSuggestionKind({ suggestion_kind: 'corrective' })).toBe('corrective');
    expect(resolveSuggestionKind({ suggestion_kind: 'proactive' })).toBe('proactive');
  });

  // §3.1 per-kind audit classification table (AC-2). Pins which kinds are
  // structurally corrective-CAPABLE so a future producer change that flips a kind
  // is caught. Only variant_question is always-corrective; every other proposal
  // kind is audited always-proactive.
  it('pins the §3.1 corrective-possible classification per kind', () => {
    const correctivePossibleByKind: Record<(typeof aiProposalKinds)[number], boolean> = {
      knowledge_node: false,
      knowledge_edge: false,
      knowledge_mutation: false,
      learning_item: false,
      note_update: false,
      variant_question: true,
      completion: false,
      relearn: false,
      defer: false,
      record_links: false,
      record_promotion: false,
      archive: false,
      judge_retraction: false,
      goal_scope: false,
      block_merge: false,
      // YUK-227 S3 Slice C — image_candidate is a proactive source-expansion proposal
      // (the agent surfaces a reachable image-type source); it is not corrective.
      image_candidate: false,
    };
    // Every kind classified; exactly one structurally-corrective kind.
    expect(Object.keys(correctivePossibleByKind).sort()).toEqual([...aiProposalKinds].sort());
    const correctiveKinds = Object.entries(correctivePossibleByKind)
      .filter(([, v]) => v)
      .map(([k]) => k);
    expect(correctiveKinds).toEqual(['variant_question']);
  });
});
