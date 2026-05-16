import {
  AcceptSuggestionChip,
  AttemptOnQuestion,
  Event,
  ExperimentalEvent,
  ExtractSourceDocument,
  GenerateArtifact,
  GenerateKnowledgeEdge,
  JudgeOnEvent,
  KnownEvent,
  ProposeKnowledge,
  ProposeKnowledgeEdge,
  RateEvent,
  RateKnowledgeEdge,
  ReviewOnQuestion,
  ToolUseExperimental,
  UserCauseExperimental,
  parseEvent,
} from '@/core/schema/event';
import { describe, expect, it } from 'vitest';

// ====================================================================
// 1. AttemptOnQuestion
// ====================================================================

describe('AttemptOnQuestion', () => {
  it('accepts valid user attempt with failure outcome', () => {
    const result = AttemptOnQuestion.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q_1',
      outcome: 'failure',
      payload: {
        answer_md: '代词指代',
        answer_image_refs: ['asset_1'],
        duration_ms: 4500,
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid agent attempt (replay scenario)', () => {
    const result = AttemptOnQuestion.safeParse({
      actor_kind: 'agent',
      actor_ref: 'evaluator',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q_1',
      outcome: 'success',
      payload: { answer_md: 'ans', answer_image_refs: [] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects action=attempt with subject_kind=knowledge_edge (not in union)', () => {
    const result = KnownEvent.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'knowledge_edge',
      subject_id: 'ke_1',
      outcome: 'failure',
      payload: { answer_md: null, answer_image_refs: [] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects actor_kind=cron on attempt (only user/agent allowed)', () => {
    const result = AttemptOnQuestion.safeParse({
      actor_kind: 'cron',
      actor_ref: 'nightly',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q_1',
      outcome: 'failure',
      payload: { answer_md: null, answer_image_refs: [] },
    });
    expect(result.success).toBe(false);
  });

  it('accepts payload.referenced_knowledge_ids (mastery view feed)', () => {
    const result = AttemptOnQuestion.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q_1',
      outcome: 'failure',
      payload: {
        answer_md: '错',
        answer_image_refs: [],
        referenced_knowledge_ids: ['k_xuci_zhi', 'k_dingyu_biaozhi'],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payload.referenced_knowledge_ids).toEqual([
        'k_xuci_zhi',
        'k_dingyu_biaozhi',
      ]);
    }
  });

  it('defaults referenced_knowledge_ids to empty array when omitted', () => {
    const result = AttemptOnQuestion.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q_1',
      outcome: 'failure',
      payload: { answer_md: null, answer_image_refs: [] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payload.referenced_knowledge_ids).toEqual([]);
    }
  });
});

// ====================================================================
// 2. JudgeOnEvent
// ====================================================================

describe('JudgeOnEvent', () => {
  it('accepts agent judgment on prior attempt event', () => {
    const result = JudgeOnEvent.safeParse({
      actor_kind: 'agent',
      actor_ref: 'attribution',
      action: 'judge',
      subject_kind: 'event',
      subject_id: 'e_1',
      outcome: 'success',
      payload: {
        cause: {
          primary_category: 'concept',
          secondary_categories: [],
          analysis_md: '理解偏差：把"之"当代词',
          confidence: 0.87,
        },
        referenced_knowledge_ids: ['k_xuci_zhi'],
      },
      caused_by_event_id: 'e_attempt_1',
      task_run_id: 't_run_1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects judge with subject_kind=question (must be event)', () => {
    const result = JudgeOnEvent.safeParse({
      actor_kind: 'agent',
      actor_ref: 'attribution',
      action: 'judge',
      subject_kind: 'question',
      subject_id: 'q_1',
      outcome: 'success',
      payload: {
        cause: {
          primary_category: 'concept',
          secondary_categories: [],
          analysis_md: 'x',
          confidence: 0.5,
        },
        referenced_knowledge_ids: [],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects cause.confidence > 1', () => {
    const result = JudgeOnEvent.safeParse({
      actor_kind: 'agent',
      actor_ref: 'attribution',
      action: 'judge',
      subject_kind: 'event',
      subject_id: 'e_1',
      outcome: 'success',
      payload: {
        cause: {
          primary_category: 'concept',
          secondary_categories: [],
          analysis_md: 'x',
          confidence: 1.5,
        },
        referenced_knowledge_ids: [],
      },
    });
    expect(result.success).toBe(false);
  });
});

// ====================================================================
// 3. ReviewOnQuestion
// ====================================================================

describe('ReviewOnQuestion', () => {
  it('accepts valid review with good rating', () => {
    const result = ReviewOnQuestion.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q_1',
      outcome: 'success',
      payload: {
        fsrs_rating: 'good',
        fsrs_state_after: {
          due: '2026-05-20T00:00:00.000Z',
          stability: 1.5,
          difficulty: 5.0,
          elapsed_days: 0,
          scheduled_days: 4,
          learning_steps: 0,
          reps: 2,
          lapses: 0,
          state: 'review',
          last_review: '2026-05-16T00:00:00.000Z',
        },
        user_response_md: '终于记住了',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown fsrs_rating', () => {
    const result = ReviewOnQuestion.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q_1',
      outcome: 'success',
      payload: {
        fsrs_rating: 'easy',
        fsrs_state_after: {
          due: new Date(),
          stability: 1,
          difficulty: 5,
          scheduled_days: 1,
          learning_steps: 0,
          reps: 1,
          lapses: 0,
          state: 'learning',
          last_review: null,
        },
        user_response_md: null,
      },
    });
    expect(result.success).toBe(false);
  });

  const baseFsrsState = {
    due: '2026-05-20T00:00:00.000Z',
    stability: 1.5,
    difficulty: 5.0,
    elapsed_days: 0,
    scheduled_days: 4,
    learning_steps: 0,
    reps: 2,
    lapses: 0,
    state: 'review' as const,
    last_review: '2026-05-16T00:00:00.000Z',
  };

  it('accepts payload.referenced_knowledge_ids (mastery view feed)', () => {
    const result = ReviewOnQuestion.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q_1',
      outcome: 'success',
      payload: {
        fsrs_rating: 'good',
        fsrs_state_after: baseFsrsState,
        user_response_md: null,
        referenced_knowledge_ids: ['k_zhi'],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects fsrs_rating='again' with outcome='success' (superRefine invariant)", () => {
    const result = ReviewOnQuestion.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q_1',
      outcome: 'success',
      payload: {
        fsrs_rating: 'again',
        fsrs_state_after: baseFsrsState,
        user_response_md: null,
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/outcome must be 'failure'/);
    }
  });

  it("rejects fsrs_rating='good' with outcome='failure' (superRefine invariant)", () => {
    const result = ReviewOnQuestion.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q_1',
      outcome: 'failure',
      payload: {
        fsrs_rating: 'good',
        fsrs_state_after: baseFsrsState,
        user_response_md: null,
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/outcome must be 'success'/);
    }
  });

  it("accepts fsrs_rating='again' with outcome='failure' (consistent)", () => {
    const result = ReviewOnQuestion.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q_1',
      outcome: 'failure',
      payload: {
        fsrs_rating: 'again',
        fsrs_state_after: baseFsrsState,
        user_response_md: null,
      },
    });
    expect(result.success).toBe(true);
  });
});

// ====================================================================
// 4. ProposeKnowledge
// ====================================================================

describe('ProposeKnowledge', () => {
  it('accepts valid agent propose with parent_id', () => {
    const result = ProposeKnowledge.safeParse({
      actor_kind: 'agent',
      actor_ref: 'review',
      action: 'propose',
      subject_kind: 'knowledge',
      subject_id: 'k_pending_xyz',
      outcome: 'success',
      payload: {
        name: '之-定语标志',
        parent_id: 'k_xuci',
        reasoning: '错题归因揭示新虚词子类',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects propose with subject_kind=knowledge_edge through ProposeKnowledge schema', () => {
    const result = ProposeKnowledge.safeParse({
      actor_kind: 'agent',
      actor_ref: 'review',
      action: 'propose',
      subject_kind: 'knowledge_edge',
      subject_id: 'ke_1',
      outcome: 'success',
      payload: {
        from_knowledge_id: 'k_1',
        to_knowledge_id: 'k_2',
        relation_type: 'prerequisite',
        weight: 1,
        reasoning: 'r',
      },
    });
    expect(result.success).toBe(false);
  });
});

// ====================================================================
// 5. GenerateArtifact
// ====================================================================

describe('GenerateArtifact', () => {
  it('accepts agent-generated note with referenced_event_ids', () => {
    const result = GenerateArtifact.safeParse({
      actor_kind: 'agent',
      actor_ref: 'note_gen',
      action: 'generate',
      subject_kind: 'artifact',
      subject_id: 'a_1',
      outcome: 'success',
      payload: {
        artifact_kind: 'note',
        title: '之-用法小结',
        body_md: '## 用法\n1. 代词\n2. 助词',
        referenced_event_ids: ['e_attempt_1', 'e_judge_2'],
      },
      caused_by_event_id: 'e_judge_2',
      task_run_id: 't_run_5',
      cost_micro_usd: 250,
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown artifact_kind', () => {
    const result = GenerateArtifact.safeParse({
      actor_kind: 'agent',
      actor_ref: 'note_gen',
      action: 'generate',
      subject_kind: 'artifact',
      subject_id: 'a_1',
      outcome: 'success',
      payload: {
        artifact_kind: 'mindmap',
        title: 't',
        body_md: 'b',
      },
    });
    expect(result.success).toBe(false);
  });
});

// ====================================================================
// 6. RateEvent
// ====================================================================

describe('RateEvent', () => {
  it('accepts user accept on prior agent proposal event', () => {
    const result = RateEvent.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: 'e_propose_1',
      outcome: 'success',
      payload: {
        rating: 'accept',
        user_note: '提议得不错',
      },
      caused_by_event_id: 'e_propose_1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects outcome=failure on rate (only success allowed)', () => {
    const result = RateEvent.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: 'e_propose_1',
      outcome: 'failure',
      payload: { rating: 'dismiss' },
    });
    expect(result.success).toBe(false);
  });
});

// ====================================================================
// 7. ExtractSourceDocument
// ====================================================================

describe('ExtractSourceDocument', () => {
  it('accepts valid agent extract with partial outcome', () => {
    const result = ExtractSourceDocument.safeParse({
      actor_kind: 'agent',
      actor_ref: 'tencent_mark',
      action: 'extract',
      subject_kind: 'source_document',
      subject_id: 'sd_1',
      outcome: 'partial',
      payload: {
        structured_block_ids: ['qb_1', 'qb_2'],
        layout_quality: 'partial',
        warnings: ['page 3 OCR confidence < 0.5'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown layout_quality value', () => {
    const result = ExtractSourceDocument.safeParse({
      actor_kind: 'agent',
      actor_ref: 'tencent_mark',
      action: 'extract',
      subject_kind: 'source_document',
      subject_id: 'sd_1',
      outcome: 'success',
      payload: {
        structured_block_ids: [],
        layout_quality: 'fuzzy',
        warnings: [],
      },
    });
    expect(result.success).toBe(false);
  });
});

// ====================================================================
// 8. AcceptSuggestionChip (ADR-0011 v2 §2.1 suggestion_kind discriminator)
// ====================================================================

describe('AcceptSuggestionChip', () => {
  it('accepts proactive suggestion_kind', () => {
    const result = AcceptSuggestionChip.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'accept_suggestion',
      subject_kind: 'chip',
      subject_id: 'chip_abc',
      outcome: 'success',
      payload: {
        suggestion_kind: 'proactive',
        chip_label: '出 3 道变式',
        target_tool: 'propose_variant',
        target_args: { source_question_id: 'q_1', count: 3 },
        source_event_id: 'e_explain_5',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts corrective suggestion_kind', () => {
    const result = AcceptSuggestionChip.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'accept_suggestion',
      subject_kind: 'chip',
      subject_id: 'chip_xyz',
      outcome: 'success',
      payload: {
        suggestion_kind: 'corrective',
        chip_label: '重做这道题',
        source_event_id: 'e_attempt_failed',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing suggestion_kind', () => {
    const result = AcceptSuggestionChip.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'accept_suggestion',
      subject_kind: 'chip',
      subject_id: 'chip_abc',
      outcome: 'success',
      payload: {
        chip_label: '出变式',
        source_event_id: 'e_5',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid suggestion_kind value', () => {
    const result = AcceptSuggestionChip.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'accept_suggestion',
      subject_kind: 'chip',
      subject_id: 'chip_abc',
      outcome: 'success',
      payload: {
        suggestion_kind: 'reactive',
        chip_label: '出变式',
        source_event_id: 'e_5',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing source_event_id (chip always derives from an explain event)', () => {
    const result = AcceptSuggestionChip.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'accept_suggestion',
      subject_kind: 'chip',
      subject_id: 'chip_abc',
      outcome: 'success',
      payload: {
        suggestion_kind: 'proactive',
        chip_label: '出变式',
      },
    });
    expect(result.success).toBe(false);
  });
});

// ====================================================================
// 9. ProposeKnowledgeEdge
// ====================================================================

describe('ProposeKnowledgeEdge', () => {
  it('accepts propose with core relation_type prerequisite', () => {
    const result = ProposeKnowledgeEdge.safeParse({
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'propose',
      subject_kind: 'knowledge_edge',
      subject_id: 'ke_pending_1',
      outcome: 'success',
      payload: {
        from_knowledge_id: 'k_xuci_zhi',
        to_knowledge_id: 'k_translation',
        relation_type: 'prerequisite',
        weight: 0.8,
        reasoning: '理解虚词是翻译前置',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts propose with experimental:dual relation_type', () => {
    const result = ProposeKnowledgeEdge.safeParse({
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'propose',
      subject_kind: 'knowledge_edge',
      subject_id: 'ke_pending_2',
      outcome: 'success',
      payload: {
        from_knowledge_id: 'k_a',
        to_knowledge_id: 'k_b',
        relation_type: 'experimental:dual',
        weight: 0.5,
        reasoning: '探索性双向关系',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects propose × knowledge_edge with relation_type not in enum and not experimental:*', () => {
    const result = ProposeKnowledgeEdge.safeParse({
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'propose',
      subject_kind: 'knowledge_edge',
      subject_id: 'ke_pending_3',
      outcome: 'success',
      payload: {
        from_knowledge_id: 'k_a',
        to_knowledge_id: 'k_b',
        relation_type: 'not_in_enum',
        weight: 0.5,
        reasoning: 'bad',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects propose with missing reasoning (required for agent proposal)', () => {
    const result = ProposeKnowledgeEdge.safeParse({
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'propose',
      subject_kind: 'knowledge_edge',
      subject_id: 'ke_pending_4',
      outcome: 'success',
      payload: {
        from_knowledge_id: 'k_a',
        to_knowledge_id: 'k_b',
        relation_type: 'prerequisite',
        weight: 1,
      },
    });
    expect(result.success).toBe(false);
  });
});

// ====================================================================
// 10. GenerateKnowledgeEdge
// ====================================================================

describe('GenerateKnowledgeEdge', () => {
  it('accepts agent-generated edge with reasoning and propose_event_id', () => {
    const result = GenerateKnowledgeEdge.safeParse({
      actor_kind: 'agent',
      actor_ref: 'maintenance',
      action: 'generate',
      subject_kind: 'knowledge_edge',
      subject_id: 'ke_1',
      outcome: 'success',
      payload: {
        from_knowledge_id: 'k_a',
        to_knowledge_id: 'k_b',
        relation_type: 'related_to',
        weight: 1,
        reasoning: '维护期合并',
        propose_event_id: 'e_propose_5',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts user-generated edge (reasoning optional)', () => {
    const result = GenerateKnowledgeEdge.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'generate',
      subject_kind: 'knowledge_edge',
      subject_id: 'ke_2',
      outcome: 'success',
      payload: {
        from_knowledge_id: 'k_a',
        to_knowledge_id: 'k_b',
        relation_type: 'contrasts_with',
        weight: 1,
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects actor_kind=cron on generate edge', () => {
    const result = GenerateKnowledgeEdge.safeParse({
      actor_kind: 'cron',
      actor_ref: 'nightly',
      action: 'generate',
      subject_kind: 'knowledge_edge',
      subject_id: 'ke_3',
      outcome: 'success',
      payload: {
        from_knowledge_id: 'k_a',
        to_knowledge_id: 'k_b',
        relation_type: 'related_to',
        weight: 1,
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects agent-generated edge missing reasoning (superRefine invariant)', () => {
    const result = GenerateKnowledgeEdge.safeParse({
      actor_kind: 'agent',
      actor_ref: 'maintenance',
      action: 'generate',
      subject_kind: 'knowledge_edge',
      subject_id: 'ke_4',
      outcome: 'success',
      payload: {
        from_knowledge_id: 'k_a',
        to_knowledge_id: 'k_b',
        relation_type: 'related_to',
        weight: 1,
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(
        /reasoning is required when actor_kind=agent/,
      );
    }
  });

  it('rejects agent-generated edge with empty-string reasoning', () => {
    const result = GenerateKnowledgeEdge.safeParse({
      actor_kind: 'agent',
      actor_ref: 'maintenance',
      action: 'generate',
      subject_kind: 'knowledge_edge',
      subject_id: 'ke_5',
      outcome: 'success',
      payload: {
        from_knowledge_id: 'k_a',
        to_knowledge_id: 'k_b',
        relation_type: 'related_to',
        weight: 1,
        reasoning: '',
      },
    });
    expect(result.success).toBe(false);
  });
});

// ====================================================================
// 11. RateKnowledgeEdge
// ====================================================================

describe('RateKnowledgeEdge', () => {
  it('accepts user accept on proposed edge', () => {
    const result = RateKnowledgeEdge.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'knowledge_edge',
      subject_id: 'e_propose_edge_1',
      outcome: 'success',
      payload: { rating: 'accept' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts change_type rating with new_relation_type', () => {
    const result = RateKnowledgeEdge.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'knowledge_edge',
      subject_id: 'e_propose_edge_2',
      outcome: 'success',
      payload: {
        rating: 'change_type',
        new_relation_type: 'contrasts_with',
        user_note: '反着说更准',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects rating outside of accept/dismiss/reverse/change_type/rollback', () => {
    const result = RateKnowledgeEdge.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'knowledge_edge',
      subject_id: 'e_1',
      outcome: 'success',
      payload: { rating: 'maybe' },
    });
    expect(result.success).toBe(false);
  });

  it("rejects rating='change_type' without new_relation_type (superRefine)", () => {
    const result = RateKnowledgeEdge.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'knowledge_edge',
      subject_id: 'e_2',
      outcome: 'success',
      payload: { rating: 'change_type' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/new_relation_type is required/);
    }
  });

  it("rejects rating='reverse' without new_direction_reversed=true (superRefine)", () => {
    const result = RateKnowledgeEdge.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'knowledge_edge',
      subject_id: 'e_3',
      outcome: 'success',
      payload: { rating: 'reverse' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/new_direction_reversed must be true/);
    }
  });

  it("rejects rating='reverse' with new_direction_reversed=false", () => {
    const result = RateKnowledgeEdge.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'knowledge_edge',
      subject_id: 'e_4',
      outcome: 'success',
      payload: { rating: 'reverse', new_direction_reversed: false },
    });
    expect(result.success).toBe(false);
  });

  it("accepts rating='reverse' with new_direction_reversed=true", () => {
    const result = RateKnowledgeEdge.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'knowledge_edge',
      subject_id: 'e_5',
      outcome: 'success',
      payload: { rating: 'reverse', new_direction_reversed: true },
    });
    expect(result.success).toBe(true);
  });
});

// ====================================================================
// ExperimentalEvent
// ====================================================================

describe('ExperimentalEvent', () => {
  it('accepts action starting with experimental:', () => {
    const result = ExperimentalEvent.safeParse({
      action: 'experimental:ask_copilot',
      payload: { text: '为什么？' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects action without experimental: prefix', () => {
    const result = ExperimentalEvent.safeParse({
      action: 'attempt',
      payload: { x: 1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects action with experimental but no colon', () => {
    const result = ExperimentalEvent.safeParse({
      action: 'experimental_tool',
      payload: { x: 1 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects reserved action 'experimental:tool_use' (must use ToolUseExperimental)", () => {
    const result = ExperimentalEvent.safeParse({
      action: 'experimental:tool_use',
      payload: { tool_name: 'x', args: {} },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/reserved experimental action/);
    }
  });
});

// ====================================================================
// ToolUseExperimental
// ====================================================================

describe('ToolUseExperimental', () => {
  it('accepts success outcome with result_summary', () => {
    const result = ToolUseExperimental.safeParse({
      actor_kind: 'agent',
      actor_ref: 'copilot',
      action: 'experimental:tool_use',
      subject_kind: 'query',
      subject_id: 'tool_use_abc',
      outcome: 'success',
      payload: {
        tool_name: 'query_mistakes',
        args: { domain: 'wenyan', limit: 10 },
        result_summary: '3 events found',
        result_count: 3,
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts various args records', () => {
    const result = ToolUseExperimental.safeParse({
      actor_kind: 'agent',
      actor_ref: 'copilot',
      action: 'experimental:tool_use',
      subject_kind: 'query',
      subject_id: 'tool_use_def',
      outcome: 'success',
      payload: {
        tool_name: 'fetch_knowledge',
        args: {
          nested: { deep: { value: 42 } },
          arr: [1, 2, 3],
          flag: true,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts failure outcome with error_reason', () => {
    const result = ToolUseExperimental.safeParse({
      actor_kind: 'agent',
      actor_ref: 'copilot',
      action: 'experimental:tool_use',
      subject_kind: 'query',
      subject_id: 'tool_use_ghi',
      outcome: 'failure',
      payload: {
        tool_name: 'query_events',
        args: {},
        error_reason: 'rate_limit',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing payload.tool_name', () => {
    const result = ToolUseExperimental.safeParse({
      actor_kind: 'agent',
      actor_ref: 'copilot',
      action: 'experimental:tool_use',
      subject_kind: 'query',
      subject_id: 'tool_use_jkl',
      outcome: 'success',
      payload: {
        args: { x: 1 },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects subject_kind other than query', () => {
    const result = ToolUseExperimental.safeParse({
      actor_kind: 'agent',
      actor_ref: 'copilot',
      action: 'experimental:tool_use',
      subject_kind: 'question',
      subject_id: 'tool_use_mno',
      outcome: 'success',
      payload: { tool_name: 't', args: {} },
    });
    expect(result.success).toBe(false);
  });
});

// ====================================================================
// UserCauseExperimental
// ====================================================================

describe('UserCauseExperimental', () => {
  it('accepts a minimal user-supplied cause', () => {
    const result = UserCauseExperimental.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:user_cause',
      subject_kind: 'event',
      subject_id: 'attempt_evt_1',
      payload: { primary_category: 'carelessness' },
      caused_by_event_id: 'attempt_evt_1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional user_notes (string or null)', () => {
    const a = UserCauseExperimental.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:user_cause',
      subject_kind: 'event',
      subject_id: 'a1',
      payload: { primary_category: 'concept', user_notes: '看错题号了' },
      caused_by_event_id: 'a1',
    });
    expect(a.success).toBe(true);
    const b = UserCauseExperimental.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:user_cause',
      subject_kind: 'event',
      subject_id: 'a2',
      payload: { primary_category: 'memory', user_notes: null },
      caused_by_event_id: 'a2',
    });
    expect(b.success).toBe(true);
  });

  it('rejects unknown primary_category', () => {
    const result = UserCauseExperimental.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:user_cause',
      subject_kind: 'event',
      subject_id: 'a3',
      payload: { primary_category: 'not_a_real_category' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects actor_kind=agent (user_cause is user-only)', () => {
    const result = UserCauseExperimental.safeParse({
      actor_kind: 'agent',
      actor_ref: 'attribution',
      action: 'experimental:user_cause',
      subject_kind: 'event',
      subject_id: 'a4',
      payload: { primary_category: 'concept' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects subject_kind other than event', () => {
    const result = UserCauseExperimental.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:user_cause',
      subject_kind: 'question',
      subject_id: 'q_1',
      payload: { primary_category: 'concept' },
    });
    expect(result.success).toBe(false);
  });

  it('generic ExperimentalEvent rejects experimental:user_cause (reserved)', () => {
    const result = ExperimentalEvent.safeParse({
      action: 'experimental:user_cause',
      payload: { primary_category: 'concept' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/reserved experimental action/);
    }
  });
});

// ====================================================================
// Top-level Event union + parseEvent
// ====================================================================

describe('Event (top-level union) + parseEvent', () => {
  it('parses an AttemptOnQuestion through top-level Event', () => {
    const parsed = parseEvent({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q_1',
      outcome: 'failure',
      payload: { answer_md: null, answer_image_refs: [] },
    });
    // Type narrow via shape inspection
    expect(parsed.action).toBe('attempt');
  });

  it('parses ToolUseExperimental through top-level Event (ahead of ExperimentalEvent generic)', () => {
    const parsed = parseEvent({
      actor_kind: 'agent',
      actor_ref: 'copilot',
      action: 'experimental:tool_use',
      subject_kind: 'query',
      subject_id: 'tu_1',
      outcome: 'success',
      payload: { tool_name: 'q', args: {} },
    });
    // ToolUseExperimental has subject_kind, ExperimentalEvent does not — verify which schema matched
    expect('subject_kind' in parsed).toBe(true);
  });

  it('falls back to generic ExperimentalEvent for unknown experimental action', () => {
    const parsed = parseEvent({
      action: 'experimental:novel_action',
      payload: { whatever: 'goes' },
    });
    expect(parsed.action).toBe('experimental:novel_action');
  });

  it('rejects entirely unknown action through top-level Event', () => {
    const result = Event.safeParse({
      actor_kind: 'user',
      action: 'totally_made_up',
      subject_kind: 'question',
      subject_id: 'q_1',
      outcome: 'success',
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed experimental:tool_use (missing tool_name) — must not fall through to generic ExperimentalEvent', () => {
    // ToolUseExperimental requires payload.tool_name; generic ExperimentalEvent would
    // otherwise accept this with arbitrary payload. The RESERVED_EXPERIMENTAL_ACTIONS
    // guard in experimental.ts blocks that fallback.
    const result = Event.safeParse({
      action: 'experimental:tool_use',
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed experimental:tool_use even with extra envelope fields', () => {
    const result = Event.safeParse({
      actor_kind: 'agent',
      actor_ref: 'copilot',
      action: 'experimental:tool_use',
      subject_kind: 'query',
      subject_id: 'tu_x',
      outcome: 'success',
      payload: { args: { x: 1 } }, // missing tool_name
    });
    expect(result.success).toBe(false);
  });

  it('parses UserCauseExperimental through top-level Event', () => {
    const parsed = parseEvent({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:user_cause',
      subject_kind: 'event',
      subject_id: 'uc_attempt_1',
      payload: { primary_category: 'carelessness', user_notes: 'misread' },
      caused_by_event_id: 'uc_attempt_1',
    });
    expect('subject_kind' in parsed).toBe(true);
    expect(parsed.action).toBe('experimental:user_cause');
  });

  it('rejects malformed experimental:user_cause (unknown primary_category) — does not fall through to generic', () => {
    const result = Event.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:user_cause',
      subject_kind: 'event',
      subject_id: 'uc_bad',
      payload: { primary_category: 'made_up' },
    });
    expect(result.success).toBe(false);
  });
});
