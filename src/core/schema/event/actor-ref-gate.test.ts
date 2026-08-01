import { describe, expect, it } from 'vitest';
import {
  AcceptSuggestionChip,
  AttemptOnQuestion,
  CorrectArtifactEvent,
  CorrectEvent,
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
  SuppressArtifactLink,
  ToolUseQuery,
  parseEvent,
} from './index';

const fsrsAfter = {
  due: '2026-08-05T09:30:00.000Z',
  stability: 4.72,
  difficulty: 6.15,
  elapsed_days: 3,
  scheduled_days: 4,
  learning_steps: 0,
  reps: 7,
  lapses: 1,
  state: 'review',
  last_review: '2026-08-01T09:30:00.000Z',
};

const userKindFixtures = [
  {
    kind: 'AttemptOnQuestion',
    schema: AttemptOnQuestion,
    event: {
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q_classical_chinese_pronoun_017',
      outcome: 'partial',
      payload: {
        answer_md: '“之”在这里指代前文的百姓，但我不确定主语。',
        answer_image_refs: ['r2://answers/2026-08-01/page-03-crop-02.webp'],
        duration_ms: 83_420,
        referenced_knowledge_ids: ['kc_classical_pronoun_zhi', 'kc_ellipsis_subject'],
        hints_used: 2,
        final_hint_level: 1,
        reconstruction_signal: 'retrieved',
        reasoning_trace: '先找谓语，再回看最近一个可作宾语的名词。',
      },
    },
  },
  {
    kind: 'ReviewOnQuestion',
    schema: ReviewOnQuestion,
    event: {
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q_function_word_contrast_029',
      outcome: 'success',
      payload: {
        fsrs_rating: 'hard',
        fsrs_state_after: fsrsAfter,
        user_response_md: '“乃”表承接，“则”更偏条件后的结果。',
        answer_image_refs: ['r2://answers/2026-08-01/notebook-page-11.webp'],
        referenced_knowledge_ids: ['kc_function_word_nai', 'kc_function_word_ze'],
        duration_ms: 64_008,
        stream_item_id: 'stream_item_weekly_review_029',
        reconstruction_signal: 'reconstructed_from_parents',
        reasoning_trace: '逐句替换成现代汉语后比较逻辑连接。',
        self_confidence: 3,
      },
    },
  },
  {
    kind: 'RateEvent',
    schema: RateEvent,
    event: {
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: 'evt_propose_learning_item_4a92',
      outcome: 'success',
      payload: {
        rating: 'accept',
        user_note: '保留这条复习任务，但把顺序放到宾语代词之后。',
        materialized_learning_item_id: 'li_function_words_sequence_08',
        materialized_prior_status: 'pending',
        materialized_prior_completed_at: null,
        materialized_ids: {
          knowledge: ['kc_function_word_sequence'],
          knowledge_edge: ['ke_zhi_before_nai'],
        },
      },
    },
  },
  {
    kind: 'GenerateKnowledgeEdge',
    schema: GenerateKnowledgeEdge,
    event: {
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'generate',
      subject_kind: 'knowledge_edge',
      subject_id: 'ke_zhi_contrasts_structure_particle',
      outcome: 'success',
      payload: {
        from_knowledge_id: 'kc_zhi_pronoun',
        to_knowledge_id: 'kc_zhi_structural_particle',
        relation_type: 'contrasts_with',
        weight: 0.88,
        reasoning: '同形但句法位置和翻译方式相反，需并列辨析。',
        propose_event_id: 'evt_edge_proposal_81c4',
      },
    },
  },
  {
    kind: 'CorrectEvent',
    schema: CorrectEvent,
    event: {
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'evt_judge_open_answer_117',
      outcome: 'success',
      payload: {
        correction_kind: 'supersede',
        replacement_event_id: 'evt_judge_open_answer_117_rejudge',
        reason_md: '原判词忽略了省略主语，重判证据包含完整上下文与手写推导。',
        affected_refs: [
          { kind: 'question', id: 'q_open_translation_117' },
          { kind: 'practice_log', id: 'practice_20260801_morning' },
        ],
      },
    },
  },
  {
    kind: 'CorrectArtifactEvent',
    schema: CorrectArtifactEvent,
    event: {
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'artifact',
      subject_id: 'artifact_atomic_zhi_rule_42',
      outcome: 'success',
      payload: {
        correction_kind: 'supersede',
        block_id: 'block_counterexample_negation',
        replacement_artifact_id: 'artifact_atomic_zhi_rule_43',
        reason_md: '反例漏掉否定句条件，替换为包含宾语前置约束的版本。',
      },
    },
  },
  {
    kind: 'SuppressArtifactLink',
    schema: SuppressArtifactLink,
    event: {
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'suppress',
      subject_kind: 'artifact',
      subject_id: 'artifact_hub_classical_chinese',
      outcome: 'success',
      payload: {
        suppressed_artifact_id: 'artifact_atomic_sentence_patterns',
        relation: 'contrasts_with',
      },
    },
  },
  {
    kind: 'AcceptSuggestionChip',
    schema: AcceptSuggestionChip,
    event: {
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'accept_suggestion',
      subject_kind: 'chip',
      subject_id: 'chip_variant_drill_zhi_003',
      outcome: 'success',
      payload: {
        suggestion_kind: 'corrective',
        chip_label: '用三道变式区分“之”的三种用法',
        target_tool: 'propose_variant',
        target_args: {
          source_question_id: 'q_classical_chinese_pronoun_017',
          count: 3,
          preserve_difficulty: true,
          contrast_knowledge_ids: ['kc_zhi_pronoun', 'kc_zhi_structural_particle'],
        },
        source_event_id: 'evt_explain_attempt_017',
      },
    },
  },
  {
    kind: 'RateKnowledgeEdge',
    schema: RateKnowledgeEdge,
    event: {
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'knowledge_edge',
      subject_id: 'evt_propose_edge_zhi_translation',
      outcome: 'success',
      payload: {
        rating: 'change_type',
        new_relation_type: 'prerequisite',
        user_note: '这里不是一般相关：先识别词性，才能稳定翻译。',
      },
    },
  },
] as const;

describe('KnownEvent actor_ref gate', () => {
  it.each(userKindFixtures)('accepts the canonical self ref for $kind', ({ event, schema }) => {
    expect(schema.safeParse(event).success).toBe(true);
    expect(KnownEvent.safeParse(event).success).toBe(true);
  });

  it.each(userKindFixtures)(
    'rejects a non-self user ref through the public $kind parser and union',
    ({ event, schema }) => {
      const invalidEvent = { ...event, actor_ref: 'learner:tenant-42' };
      const memberResult = schema.safeParse(invalidEvent);
      const unionResult = KnownEvent.safeParse(invalidEvent);

      expect(memberResult.success).toBe(false);
      expect(unionResult.success).toBe(false);
      if (!memberResult.success) {
        expect(memberResult.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['actor_ref'],
            message: "actor_ref must be 'self' when actor_kind='user'",
          }),
        );
      }
      if (!unionResult.success) {
        expect(unionResult.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['actor_ref'],
            message: "actor_ref must be 'self' when actor_kind='user'",
          }),
        );
      }
    },
  );

  it('is enforced through the canonical parseEvent boundary', () => {
    expect(() =>
      parseEvent({ ...userKindFixtures[0].event, actor_ref: 'learner:tenant-42' }),
    ).toThrowError(/actor_ref must be 'self'/);
  });

  it.each([
    {
      lane: 'agent attempt replay',
      schema: AttemptOnQuestion,
      event: {
        ...userKindFixtures[0].event,
        actor_kind: 'agent',
        actor_ref: 'attempt_replay:v2',
        outcome: 'success',
      },
    },
    {
      lane: 'agent-generated knowledge edge',
      schema: GenerateKnowledgeEdge,
      event: {
        ...userKindFixtures[3].event,
        actor_kind: 'agent',
        actor_ref: 'knowledge_edge_maintenance:nightly',
        payload: {
          ...userKindFixtures[3].event.payload,
          reasoning: '最近 30 天的错答序列显示：未识别“之”的词性时，翻译错误率显著上升。',
        },
      },
    },
    {
      lane: 'agent correction',
      schema: CorrectEvent,
      event: {
        ...userKindFixtures[4].event,
        actor_kind: 'agent',
        actor_ref: 'dreaming:edge_reconcile',
        payload: {
          ...userKindFixtures[4].event.payload,
          reason_md: '夜间证据对账发现旧判词与后续三次人工复核冲突，自动挂接重判结果。',
        },
      },
    },
    {
      lane: 'agent-only judge attribution',
      schema: JudgeOnEvent,
      event: {
        actor_kind: 'agent',
        actor_ref: 'judge:classical_chinese:v3',
        action: 'judge',
        subject_kind: 'event',
        subject_id: 'evt_attempt_open_answer_117',
        outcome: 'success',
        payload: {
          cause: {
            primary_category: 'concept',
            secondary_categories: ['misread_condition', 'ellipsis_subject'],
            analysis_md: '学习者识别了代词所指，但把否定条件句中的省略主语错误地延续到下一分句。',
            confidence: 0.91,
          },
          referenced_knowledge_ids: [
            'kc_classical_pronoun_zhi',
            'kc_ellipsis_subject',
            'kc_negation_condition',
          ],
          execution_provenance: {
            version: 1,
            kind: 'deterministic',
            prompt_fingerprint: '9'.repeat(64),
            prompt_template_revision: 'judge-classical-chinese-v3',
          },
        },
      },
    },
    {
      lane: 'agent-only knowledge proposal',
      schema: ProposeKnowledge,
      event: {
        actor_kind: 'agent',
        actor_ref: 'knowledge_curator:classical_chinese',
        action: 'propose',
        subject_kind: 'knowledge',
        subject_id: 'kc_ellipsis_subject_in_negation',
        outcome: 'success',
        payload: {
          name: '否定条件句中的省略主语',
          parent_id: 'kc_classical_chinese_ellipsis',
          reasoning: '三次错答均同时涉及否定标记、主语省略与跨分句指代，值得拆成可独立复习的节点。',
        },
      },
    },
    {
      lane: 'agent-only knowledge-edge proposal',
      schema: ProposeKnowledgeEdge,
      event: {
        actor_kind: 'agent',
        actor_ref: 'knowledge_graph_curator:nightly',
        action: 'propose',
        subject_kind: 'knowledge_edge',
        subject_id: 'ke_proposal_ellipsis_before_translation',
        outcome: 'success',
        payload: {
          from_knowledge_id: 'kc_ellipsis_subject_in_negation',
          to_knowledge_id: 'kc_translate_compound_sentence',
          relation_type: 'prerequisite',
          weight: 0.84,
          reasoning: '若未先还原省略主语，后续分句关系与代词落点都会系统性偏移。',
        },
      },
    },
    {
      lane: 'agent-only artifact generation',
      schema: GenerateArtifact,
      event: {
        actor_kind: 'agent',
        actor_ref: 'artifact_generator:error_cluster:v2',
        action: 'generate',
        subject_kind: 'artifact',
        subject_id: 'artifact_summary_ellipsis_cluster_20260801',
        outcome: 'success',
        payload: {
          artifact_kind: 'summary',
          title: '省略主语与“之”指代：本周错因簇',
          body_md: '先圈出否定词和谓语，再逐分句补主语；最后检查“之”在句法上能否承接最近的名词。',
          referenced_event_ids: [
            'evt_attempt_open_answer_117',
            'evt_judge_open_answer_117',
            'evt_attempt_variant_119',
          ],
        },
      },
    },
    {
      lane: 'agent-only source extraction',
      schema: ExtractSourceDocument,
      event: {
        actor_kind: 'agent',
        actor_ref: 'ocr_layout:tencent:v4',
        action: 'extract',
        subject_kind: 'source_document',
        subject_id: 'source_exam_classical_chinese_2026_midterm',
        outcome: 'partial',
        payload: {
          structured_block_ids: [
            'qb_midterm_page3_translation_1',
            'qb_midterm_page3_function_words_2',
            'qb_midterm_page4_reading_1',
          ],
          layout_quality: 'partial',
          warnings: ['第 4 页批注与正文重叠，保留 OCR 文本并标记人工复核。'],
        },
      },
    },
    {
      lane: 'agent-only tool use',
      schema: ToolUseQuery,
      event: {
        actor_kind: 'agent',
        actor_ref: 'copilot:classical_chinese_tutor',
        action: 'tool_use',
        subject_kind: 'query',
        subject_id: 'tool_use_query_attempt_context_117',
        outcome: 'success',
        payload: {
          tool_name: 'get_attempt_context',
          args: {
            attempt_event_id: 'evt_attempt_open_answer_117',
            include_question_snapshot: true,
            include_prior_judges: true,
          },
          result_summary: 'Loaded immutable prompt, learner answer, and two prior judge events.',
          result_count: 3,
        },
      },
    },
  ])('leaves $lane unchanged through its public parser and union', ({ event, schema }) => {
    expect(schema.safeParse(event).success).toBe(true);
    expect(KnownEvent.safeParse(event).success).toBe(true);
  });

  // D7 is the stable KnownEvent seam. Experimental actor refs still carry
  // workflow/source provenance in current persisted rows, so tightening them
  // requires its own migration and is deliberately not smuggled into YUK-772.
  it.each([
    {
      exception: 'typed subject-control provenance',
      event: {
        actor_kind: 'user',
        actor_ref: 'owner',
        action: 'experimental:subject_root_name_update',
        subject_kind: 'knowledge',
        subject_id: 'seed:yuwen:root',
        outcome: 'success',
        payload: {
          control_action: 'rename',
          subject_id: 'yuwen',
          previous_name: '语文',
          next_name: '古文精读',
          previous_version: 8,
          next_version: 9,
        },
      },
    },
    {
      exception: 'generic copilot provenance',
      event: {
        actor_kind: 'user',
        actor_ref: 'user:self',
        action: 'experimental:copilot_user_ask',
        subject_kind: 'query',
        subject_id: 'copilot_user_ask_turn_284',
        outcome: null,
        payload: {
          surface: 'copilot',
          user_message: '比较“而”“则”“乃”在这三段里的承接关系。',
          session_id: 'conversation_classical_chinese_20260801',
        },
      },
    },
  ])('preserves the audited $exception outside KnownEvent', ({ event }) => {
    expect(() => parseEvent(event)).not.toThrow();
  });
});
