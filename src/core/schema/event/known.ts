import { z } from 'zod';
import { ActivityRef } from '../activity';
import { JudgeKind } from '../business';
import { CapabilityRef } from '../capability';
import { CauseSchema, FsrsStateSchema, RelationTypeSchema } from './blocks';

// ---------- 通用 envelope 字段 ----------
//
// 所有 event 行都有的字段（除 action / subject_kind / outcome / payload 由各分支 lock）。
// 单独 spread 一次省重复。

const baseOptionalFields = {
  caused_by_event_id: z.string().optional(),
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
} as const;

// ====================================================================
// ADR-0006 v2 原 7 个 KnownEvent
// ====================================================================

// 1. AttemptOnQuestion — actor=user|agent / action='attempt' / subject='question'
//
// 用户或 agent 尝试回答一道题。outcome 表对错（success / failure / partial）。
// payload 含 answer 内容 + 可选 duration。

export const AttemptOnQuestion = z.object({
  actor_kind: z.enum(['user', 'agent']),
  actor_ref: z.string(),
  action: z.literal('attempt'),
  subject_kind: z.literal('question'),
  subject_id: z.string(),
  outcome: z.enum(['success', 'failure', 'partial']),
  payload: z.object({
    answer_md: z.string().nullable(),
    answer_image_refs: z.array(z.string()),
    duration_ms: z.number().int().optional(),
    // feeds knowledge_mastery view (ADR-0012): which knowledge nodes this attempt exercises
    referenced_knowledge_ids: z.array(z.string()).default([]),
  }),
  ...baseOptionalFields,
});
export type AttemptOnQuestionT = z.infer<typeof AttemptOnQuestion>;

// 2. JudgeOnEvent — actor=agent / action='judge' / subject='event'
//
// AI 归因 / 批改一个 prior event（通常是 attempt event）。outcome='success' —— 批改
// 行为本身成功；判分结果在 payload.cause。referenced_knowledge_ids 指批改时引用的
// knowledge。

export const JudgeOnEvent = z.object({
  actor_kind: z.literal('agent'),
  actor_ref: z.string(),
  action: z.literal('judge'),
  subject_kind: z.literal('event'),
  subject_id: z.string(),
  outcome: z.literal('success'),
  payload: z.object({
    cause: CauseSchema,
    referenced_knowledge_ids: z.array(z.string()),
    // D6 (U4 L-stamp, 2026-06-04): judge-event version pinning. All three are
    // optional so the union still parses every historical judge event in the
    // 25-event scan window (no backfill, no rewrite of old results — rejudge =
    // new event per D6). Sourced from SubjectProfile.version at the invoker /
    // attribution layer, NOT from the 8 module-level '1.0.0' capability-id
    // constants. See docs/design/2026-06-04-u0-decisions.md D6.
    //   - profile_version: the SubjectProfile.version active when judged
    //   - capability_ref:  the routed judge capability (id + resolved version);
    //                      undefined for the pure-attribution path (not routed)
    //   - judge_route:     which JudgeKind ran; undefined for attribution
    profile_version: z.string().optional(),
    capability_ref: CapabilityRef.optional(),
    judge_route: JudgeKind.optional(),
    // U5 (YUK-203, F1/Q1) — paper-path visibility gate. The independent paper
    // judge event sets `false` for judge-now/show-later slots (feedback buffered
    // until the paper completes); omitted/true → immediately visible. Optional so
    // every historical judge event still parses (no backfill). Visibility is
    // DERIVED at read time: 可见 = visible_to_user !== false || session completed.
    // The single-question /api/review/submit embed path never sets this.
    visible_to_user: z.boolean().optional(),
    // U5 (YUK-203) — paper judge result stored in payload so the read layer
    // (paper-detail.ts) can reconstruct the coarse_outcome / score on page reload
    // without re-running the judge. Optional so every historical judge event
    // (pre-U5 + the single-question /api/review/submit embed path) still parses.
    // coarse_outcome is the judge's verdict ('correct'/'partial'/'incorrect'/
    // 'unsupported'); score is [0,1] or null.
    coarse_outcome: z.string().optional(),
    score: z.number().optional(),
  }),
  ...baseOptionalFields,
});
export type JudgeOnEventT = z.infer<typeof JudgeOnEvent>;

// 3. ReviewOnQuestion — actor=user / action='review' / subject='question'
//
// 用户 FSRS 复习一道题。outcome 来自 fsrs_rating 派生（again→failure, hard/good→success）。
// fsrs_state_after 为复习后的 ts-fsrs Card dump。

export const ReviewOnQuestion = z
  .object({
    actor_kind: z.literal('user'),
    actor_ref: z.string(),
    action: z.literal('review'),
    subject_kind: z.literal('question'),
    subject_id: z.string(),
    outcome: z.enum(['success', 'failure']),
    payload: z.object({
      fsrs_rating: z.enum(['again', 'hard', 'good']),
      fsrs_state_after: FsrsStateSchema,
      user_response_md: z.string().nullable(),
      // feeds knowledge_mastery view (ADR-0012)
      referenced_knowledge_ids: z.array(z.string()).default([]),
      // Wall-clock time from when the question was first shown to when the
      // user rated. Optional because legacy events (pre-2026-05-17) don't
      // have it and we don't want to break the discriminated union.
      duration_ms: z.number().int().nonnegative().optional(),
    }),
    ...baseOptionalFields,
  })
  // fsrs_rating ↔ outcome invariant: again→failure, hard/good→success
  .superRefine((data, ctx) => {
    const expected = data.payload.fsrs_rating === 'again' ? 'failure' : 'success';
    if (data.outcome !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `outcome must be '${expected}' when fsrs_rating='${data.payload.fsrs_rating}'`,
        path: ['outcome'],
      });
    }
  });
export type ReviewOnQuestionT = z.infer<typeof ReviewOnQuestion>;

// 4. ProposeKnowledge — actor=agent / action='propose' / subject='knowledge'
//
// AI 提议新增一个 knowledge 节点。outcome='success' 或 'partial'（部分理由不齐时）。
// payload 含 name / parent_id（挂哪个 tree node）/ reasoning（必填，AI 解释为啥提议）。

export const ProposeKnowledge = z.object({
  actor_kind: z.literal('agent'),
  actor_ref: z.string(),
  action: z.literal('propose'),
  subject_kind: z.literal('knowledge'),
  subject_id: z.string(),
  outcome: z.enum(['success', 'partial']),
  payload: z.object({
    name: z.string(),
    parent_id: z.string(),
    reasoning: z.string(),
  }),
  ...baseOptionalFields,
});
export type ProposeKnowledgeT = z.infer<typeof ProposeKnowledge>;

// 5. GenerateArtifact — actor=agent / action='generate' / subject='artifact'
//
// AI 产出一个 artifact（note / quiz / variant / summary）。outcome='success' 或 'failure'。
// payload.artifact_kind 区分子类型；referenced_event_ids 是 artifact 派生自哪些 prior
// events（如变式题 derive 自原错题 attempt event）。

export const GenerateArtifact = z.object({
  actor_kind: z.literal('agent'),
  actor_ref: z.string(),
  action: z.literal('generate'),
  subject_kind: z.literal('artifact'),
  subject_id: z.string(),
  outcome: z.enum(['success', 'failure']),
  payload: z.object({
    artifact_kind: z.enum(['note', 'quiz', 'variant', 'summary']),
    title: z.string(),
    body_md: z.string(),
    referenced_event_ids: z.array(z.string()).optional(),
  }),
  ...baseOptionalFields,
});
export type GenerateArtifactT = z.infer<typeof GenerateArtifact>;

// 6. RateEvent — actor=user / action='rate' / subject='event'
//
// 用户对一个 prior event（通常 agent 提议 / 生成）投票 accept / dismiss / rollback。
// outcome 固定为 'success' —— rate 行为本身没有失败。

export const RateEvent = z.object({
  actor_kind: z.literal('user'),
  actor_ref: z.string(),
  action: z.literal('rate'),
  subject_kind: z.literal('event'),
  subject_id: z.string(),
  outcome: z.literal('success'),
  payload: z.object({
    rating: z.enum(['accept', 'dismiss', 'rollback']),
    user_note: z.string().optional(),
  }),
  ...baseOptionalFields,
});
export type RateEventT = z.infer<typeof RateEvent>;

// 6b. CorrectEvent — actor=user / action='correct' / subject='event'
//
// First-class semantic correction for append-only event history. Unlike
// RateEvent.rating='rollback', this says how projections should treat a prior
// event: superseded, retracted, marked wrong, or restored.

export const CorrectionKind = z.enum(['supersede', 'retract', 'mark_wrong', 'restore']);
export type CorrectionKindT = z.infer<typeof CorrectionKind>;

export const CorrectEvent = z
  .object({
    actor_kind: z.literal('user'),
    actor_ref: z.literal('self'),
    action: z.literal('correct'),
    subject_kind: z.literal('event'),
    subject_id: z.string(),
    outcome: z.literal('success'),
    payload: z.object({
      correction_kind: CorrectionKind,
      replacement_event_id: z.string().optional(),
      reason_md: z.string().min(1).max(2000),
      affected_refs: z.array(ActivityRef).min(1),
    }),
    ...baseOptionalFields,
  })
  .superRefine((data, ctx) => {
    if (data.payload.correction_kind === 'supersede' && !data.payload.replacement_event_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "replacement_event_id is required when correction_kind='supersede'",
        path: ['payload', 'replacement_event_id'],
      });
    }
    if (data.payload.correction_kind !== 'supersede' && data.payload.replacement_event_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "replacement_event_id is only allowed when correction_kind='supersede'",
        path: ['payload', 'replacement_event_id'],
      });
    }
  });
export type CorrectEventT = z.infer<typeof CorrectEvent>;

// 6c. CorrectArtifactEvent — actor=user / action='correct' / subject='artifact'
//
// Block-grained correction for note artifacts. Parallel to CorrectEvent;
// kept as a separate schema (not a union variant of CorrectEvent) because the
// payload shape differs — artifact targets have no natural `affected_refs`
// (those live on activity refs, not artifacts) and supersede replacement is an
// artifact_id, not an event_id.
//
// `block_id` is optional:
//   - omitted → correction applies to the whole atomic artifact
//   - present → correction applies to a single body_blocks node id
//
// See ADR-0020 — ADR-0019 section anchors are superseded by block anchors.
//
// `corrections.ts:getCorrectionStatuses` filters on subject_kind='event' and
// does NOT see these rows. Artifact-scoped composition lives in a sibling
// module (src/server/events/artifact-corrections.ts).

export const CorrectArtifactEvent = z
  .object({
    actor_kind: z.literal('user'),
    actor_ref: z.literal('self'),
    action: z.literal('correct'),
    subject_kind: z.literal('artifact'),
    subject_id: z.string(),
    outcome: z.literal('success'),
    payload: z
      .object({
        correction_kind: CorrectionKind,
        // block_id min(1): empty string would create a nonsense `''` bucket in
        // the per-block projection Map (distinguishable from `undefined`
        // whole-artifact corrections) — reject at the schema boundary.
        block_id: z.string().min(1).optional(),
        reason_md: z.string().min(1).max(2000),
        replacement_artifact_id: z.string().optional(),
      })
      .strict(),
    ...baseOptionalFields,
  })
  .superRefine((data, ctx) => {
    if (data.payload.correction_kind === 'supersede' && !data.payload.replacement_artifact_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "replacement_artifact_id is required when correction_kind='supersede'",
        path: ['payload', 'replacement_artifact_id'],
      });
    }
    if (data.payload.correction_kind !== 'supersede' && data.payload.replacement_artifact_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "replacement_artifact_id is only allowed when correction_kind='supersede'",
        path: ['payload', 'replacement_artifact_id'],
      });
    }
  });
export type CorrectArtifactEventT = z.infer<typeof CorrectArtifactEvent>;

// 6d. SuppressArtifactLink — actor=user / action='suppress' / subject='artifact'
//
// YUK-95 P5 Lane-D (Wave 7), ADR-0020 §9 dismiss. The user hides one
// system-maintained auto-link from a hub's `AutoLinksContainer`. The dismiss
// write path (POST /api/hubs/[id]/dismiss-link) appends the dismissed target to
// `artifact.attrs.suppressed_block_refs[]` AND writes this event so the action
// is traceable + reversible (XC-5 event-driven: dismiss is an event, not a
// silent attrs mutation). The nightly `hub_auto_sync_nightly` worker reads
// `suppressed_block_refs` and skips the suppressed atomic on the next run.
//
// `subject_id` is the HUB artifact_id (the artifact whose auto-zone is being
// pruned). `payload.suppressed_artifact_id` is the TARGET atomic whose
// crossLinkBlock is dismissed. `relation` is optional provenance (the chip's
// relation at dismiss time) for audit display.

export const SuppressArtifactLink = z.object({
  actor_kind: z.literal('user'),
  actor_ref: z.literal('self'),
  action: z.literal('suppress'),
  subject_kind: z.literal('artifact'),
  subject_id: z.string(),
  outcome: z.literal('success'),
  payload: z
    .object({
      suppressed_artifact_id: z.string().min(1),
      relation: z.enum(['subtopic', 'prerequisite', 'derived_from', 'contrasts_with']).optional(),
    })
    .strict(),
  ...baseOptionalFields,
});
export type SuppressArtifactLinkT = z.infer<typeof SuppressArtifactLink>;

// 7. ExtractSourceDocument — actor=agent / action='extract' / subject='source_document'
//
// Tencent OCR 抽取一份 source_document → 一组 question_block。outcome='success'（全成功）/
// 'partial'（部分页/题失败）/ 'failure'（整文档失败）。

export const ExtractSourceDocument = z.object({
  actor_kind: z.literal('agent'),
  actor_ref: z.string(),
  action: z.literal('extract'),
  subject_kind: z.literal('source_document'),
  subject_id: z.string(),
  outcome: z.enum(['success', 'partial', 'failure']),
  payload: z.object({
    structured_block_ids: z.array(z.string()),
    layout_quality: z.enum(['structured', 'partial', 'text_only']),
    warnings: z.array(z.string()),
  }),
  ...baseOptionalFields,
});
export type ExtractSourceDocumentT = z.infer<typeof ExtractSourceDocument>;

// ====================================================================
// ADR-0011 新 4 个 KnownEvent（stable，已 promote 出 experimental:）
// ====================================================================

// 8. AcceptSuggestionChip — actor=user / action='accept_suggestion' / subject='chip'
//
// 用户接受 agent 提议的结构化动作（chip）。区分 'proactive'（agent 主动提议）vs
// 'corrective'（用户错答后系统提议改正）—— payload.suggestion_kind 必填，ADR-0011 v2 §2.1。
// source_event_id 必填 —— chip 出自哪个 agent explain event。target_tool / target_args
// 可选（chip 可只是"我看见了"，不一定触发新 tool）。

export const SuggestionKind = z.enum(['proactive', 'corrective']);
export type SuggestionKindT = z.infer<typeof SuggestionKind>;

export const AcceptSuggestionChip = z.object({
  actor_kind: z.literal('user'),
  actor_ref: z.literal('self'),
  action: z.literal('accept_suggestion'),
  subject_kind: z.literal('chip'),
  subject_id: z.string(),
  outcome: z.literal('success'),
  payload: z.object({
    suggestion_kind: SuggestionKind,
    chip_label: z.string(),
    target_tool: z.string().optional(),
    target_args: z.record(z.string(), z.unknown()).optional(),
    source_event_id: z.string(),
  }),
  ...baseOptionalFields,
});
export type AcceptSuggestionChipT = z.infer<typeof AcceptSuggestionChip>;

// 9. ProposeKnowledgeEdge — actor=agent / action='propose' / subject='knowledge_edge'
//
// AI 提议加一条新 edge（dry-run，需用户 rate=accept 后才晋升到 knowledge_edge 表）。
// payload.relation_type 是 ADR-0010 5 个核心 enum 或 experimental:* 命名空间。

export const ProposeKnowledgeEdge = z.object({
  actor_kind: z.literal('agent'),
  actor_ref: z.string(),
  action: z.literal('propose'),
  subject_kind: z.literal('knowledge_edge'),
  subject_id: z.string(),
  outcome: z.enum(['success', 'partial']),
  payload: z.object({
    from_knowledge_id: z.string(),
    to_knowledge_id: z.string(),
    relation_type: RelationTypeSchema,
    weight: z.number().min(0).max(1).default(1),
    reasoning: z.string(),
  }),
  ...baseOptionalFields,
});
export type ProposeKnowledgeEdgeT = z.infer<typeof ProposeKnowledgeEdge>;

// 10. GenerateKnowledgeEdge — actor=agent|user / action='generate' / subject='knowledge_edge'
//
// 直接落库一条 knowledge_edge：maintenance agent 自动建（actor='agent'）或用户手加
// （actor='user'）。reasoning 在 agent 时必填、user 时可省 —— 用 superRefine 加守门
// （Zod 静态 schema 不直接表达条件性必填，留给业务层校验或 refine）。
//
// 注意 actor_kind 是 enum 而非 literal —— 但仍唯一锁住 (action, subject_kind) 组合。

export const GenerateKnowledgeEdge = z
  .object({
    actor_kind: z.enum(['agent', 'user']),
    actor_ref: z.string(),
    action: z.literal('generate'),
    subject_kind: z.literal('knowledge_edge'),
    subject_id: z.string(),
    outcome: z.enum(['success', 'failure']),
    payload: z.object({
      from_knowledge_id: z.string(),
      to_knowledge_id: z.string(),
      relation_type: RelationTypeSchema,
      weight: z.number().min(0).max(1).default(1),
      reasoning: z.string().optional(),
      propose_event_id: z.string().optional(),
    }),
    ...baseOptionalFields,
  })
  // actor=agent requires non-empty reasoning (audit trail); user may omit
  .superRefine((data, ctx) => {
    if (
      data.actor_kind === 'agent' &&
      (!data.payload.reasoning || data.payload.reasoning.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'reasoning is required when actor_kind=agent',
        path: ['payload', 'reasoning'],
      });
    }
  });
export type GenerateKnowledgeEdgeT = z.infer<typeof GenerateKnowledgeEdge>;

// 12. ToolUseQuery — actor=agent / action='tool_use' / subject='query'
//
// Promoted out of `experimental:tool_use` per ADR-0011 §1.1 (T-D7 / YUK-126,
// 2026-05-28). Copilot tool-use path: agent invokes a registered DomainTool,
// the bridge mirrors the call into `event` (when `mirrorEvent` policy fires)
// with payload `{ tool_name, args, result_summary?, result_count?, error_reason? }`.
// `subject_id` is self-identifying (`'tool_use_<cuid>'`); `outcome='failure'`
// requires `error_reason` to be populated (enforced via superRefine below) so
// failure mirrors always carry diagnostic information.

export const ToolUseQuery = z
  .object({
    actor_kind: z.literal('agent'),
    actor_ref: z.string(),
    action: z.literal('tool_use'),
    subject_kind: z.literal('query'),
    subject_id: z.string(),
    outcome: z.enum(['success', 'failure']),
    payload: z.object({
      tool_name: z.string(),
      args: z.record(z.string(), z.unknown()),
      result_summary: z.string().optional(),
      result_count: z.number().int().optional(),
      error_reason: z.string().optional(),
    }),
    ...baseOptionalFields,
  })
  // outcome='failure' must carry a non-empty error_reason for diagnostic value
  .superRefine((data, ctx) => {
    if (
      data.outcome === 'failure' &&
      (!data.payload.error_reason || data.payload.error_reason.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "error_reason is required when outcome='failure'",
        path: ['payload', 'error_reason'],
      });
    }
  });
export type ToolUseQueryT = z.infer<typeof ToolUseQuery>;

// 11. RateKnowledgeEdge — actor=user / action='rate' / subject='knowledge_edge'
//
// 用户对 propose / generate 的 edge 投票。rating='change_type' 时 new_relation_type 必填、
// rating='reverse' 时 new_direction_reversed 应为 true —— 业务层校验。Zod 这里只锁 rating
// enum，semantics 在 handler 守门。

export const RateKnowledgeEdge = z
  .object({
    actor_kind: z.literal('user'),
    actor_ref: z.literal('self'),
    action: z.literal('rate'),
    subject_kind: z.literal('knowledge_edge'),
    subject_id: z.string(),
    outcome: z.literal('success'),
    payload: z.object({
      rating: z.enum(['accept', 'dismiss', 'reverse', 'change_type', 'rollback']),
      new_relation_type: RelationTypeSchema.optional(),
      new_direction_reversed: z.boolean().optional(),
      user_note: z.string().optional(),
    }),
    ...baseOptionalFields,
  })
  // rating-dependent payload requirements (ADR-0011 §5)
  .superRefine((data, ctx) => {
    if (data.payload.rating === 'change_type' && !data.payload.new_relation_type) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "new_relation_type is required when rating='change_type'",
        path: ['payload', 'new_relation_type'],
      });
    }
    if (data.payload.rating === 'reverse' && data.payload.new_direction_reversed !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "new_direction_reversed must be true when rating='reverse'",
        path: ['payload', 'new_direction_reversed'],
      });
    }
  });
export type RateKnowledgeEdgeT = z.infer<typeof RateKnowledgeEdge>;

// ====================================================================
// KnownEvent union
// ====================================================================
//
// Zod discriminatedUnion 只支持单键判别，且要求每个分支 literal 唯一。union 里有 4 个
// action 重复（'propose' × {knowledge, knowledge_edge}、'generate' × {artifact,
// knowledge_edge}、'rate' × {event, knowledge_edge}、'correct' × {event, artifact}），
// 加上新增的 'suppress' × {artifact}（与 correct/artifact 同 subject 但 action 不同），
// 所以**用 z.union**。
//
// 每个 schema 用 z.literal() 锁 (action, subject_kind) 组合，因此 parse 时仍单义解析 ——
// Zod 会按 union 顺序尝试，第一个 matching schema 胜出。
//
// 顺序经过设计：相同 action 的分支按 subject_kind 字母序排列（艺术层面无意义，但稳定
// parse 顺序避免误匹配）。每个 schema 用 .strict() 是不必要的，因为 z.literal() 已经
// 保证不会跨匹配。

export const KnownEvent = z.union([
  AttemptOnQuestion,
  JudgeOnEvent,
  ReviewOnQuestion,
  ProposeKnowledge,
  ProposeKnowledgeEdge,
  GenerateArtifact,
  GenerateKnowledgeEdge,
  CorrectEvent,
  CorrectArtifactEvent,
  SuppressArtifactLink,
  RateEvent,
  RateKnowledgeEdge,
  AcceptSuggestionChip,
  ExtractSourceDocument,
  ToolUseQuery,
]);
export type KnownEventT = z.infer<typeof KnownEvent>;
