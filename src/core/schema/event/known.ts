import { z } from 'zod';
import { DerivationPolicy } from '@/core/schema/derivation-policy';
import { REASONING_TRACE_MAX_LEN } from '../../limits';
import { ActivityRef } from '../activity';
import { AttemptPayload } from '../attempt-payload';
import { JudgeKind, LearningItemStatus } from '../business';
import { CapabilityRef, JudgeResultV2 } from '../capability';
import { AttemptQuestionSnapshot } from '../question-evidence-snapshot';
import { CauseSchema, FsrsStateSchema, RelationTypeSchema } from './blocks';

// REASONING_TRACE_MAX_LEN 的真源在 core/limits.ts（纯模块）：这里只 import 给 payload 的
// .max() 用，**不再 re-export**——经本文件取会把整套 event schema 拖进调用方的 bundle 图。
// 消费方一律走 @/kernel/limits。

// 所有 event 分支共有的可选 envelope 字段；action/subject_kind/outcome/payload 由各分支锁。

const baseOptionalFields = {
  caused_by_event_id: z.string().optional(),
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
} as const;

type StableActorAttribution = { actor_kind: unknown; actor_ref: unknown };
const STABLE_USER_ACTOR_REF_MESSAGE = "actor_ref must be 'self' when actor_kind='user'";

function stableActorRefAllowed(actorKind: unknown, actorRef: unknown): boolean {
  return actorKind !== 'user' || actorRef === 'self';
}

const StableUserActorRef = z.custom<'self'>((actorRef) => stableActorRefAllowed('user', actorRef), {
  message: STABLE_USER_ACTOR_REF_MESSAGE,
  abort: false,
});

// One policy function protects both the KnownEvent union and the public member
// schemas that projections parse directly. Stable user events represent the sole
// current owner, so every user lane is `self`; multi-user work changes this
// policy once instead of every event kind.
function enforceStableUserActorRef(data: StableActorAttribution, ctx: z.RefinementCtx): void {
  if (!stableActorRefAllowed(data.actor_kind, data.actor_ref)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: STABLE_USER_ACTOR_REF_MESSAGE,
      path: ['actor_ref'],
    });
  }
}

/**
 * Escalating-hint ceiling: an index spans 0..20, but a client that traverses
 * every level can report 21 requests, so the count bound is index + 1.
 */
export const MAX_HINT_INDEX = 20;
export const MAX_HINT_COUNT = MAX_HINT_INDEX + 1;

// Was this answer DERIVED from the node's parent derivation path, or RETRIEVED
// from memory? Logged as an optional payload field so a future reconstruction
// method can backfill which derivation paths are reconstructable without
// re-deriving history. Stamped 'unknown' at the live write sites today; optional
// + non-strict payload ⇒ historical events parse byte-for-byte unchanged.
export const ReconstructionSignal = z.enum(['reconstructed_from_parents', 'retrieved', 'unknown']);
export type ReconstructionSignalT = z.infer<typeof ReconstructionSignal>;

// ====================================================================
// ADR-0006 v2 原 7 个 KnownEvent
// ====================================================================

const AttemptOnQuestionSchema = z.object({
  actor_kind: z.enum(['user', 'agent']),
  actor_ref: z.string(),
  action: z.literal('attempt'),
  subject_kind: z.literal('question'),
  subject_id: z.string(),
  outcome: z.enum(['success', 'failure', 'partial']),
  payload: z.object({
    // 承载 source document 的用途策略：缺省 === 'allow'（legacy 默认）；
    // 'answer_only' 经共享过滤把 payload 挡在 memory/brief 派生通道外。
    derivation_policy: DerivationPolicy.optional(),
    answer_md: z.string().nullable(),
    answer_image_refs: z.array(z.string()),
    duration_ms: z.number().int().optional(),
    // feeds knowledge_mastery view (ADR-0012): which knowledge nodes this attempt exercises
    referenced_knowledge_ids: z.array(z.string()).default([]),
    // Photo-only answer on a text-only judge route: the answer IS captured but NOT
    // judged (no judge event, FSRS skipped). `outcome` is structurally required but
    // semantically "un-judged", NOT wrong — read-layer right/wrong summaries MUST
    // skip these slots. This explicit flag is the "un-judged" source of truth (chosen
    // over adding an outcome enum value: avoids a schema/FSRS/mastery ripple).
    // Optional + absent for every normal attempt → no read-shape change.
    unsupported_judge: z.boolean().optional(),
    // hint 留痕「先攒数据」：hints_used = 本次作答前请求过的提示数，final_hint_level =
    // 触达的最高提示档。仅 tutor-solve 提交路径携带，当前为 CLIENT-REPORTED 计数，
    // server-authoritative 计数是后续硬化。OPTIONAL → 既有 attempt 读路径逐字不变。
    // hint-discounted accuracy 是 ADR-0035 的后续，不在本字段。
    //
    // CLIENT-REPORTED 值须封上界：hint_index 是 0-based 索引、hints_used 是请求计数，
    // 遍历 0..MAX_HINT_INDEX 会产生 MAX_HINT_COUNT 次请求，分开封顶既挡失真大数、也不
    // 拒绝最后一级提示后的合法提交。
    //
    // 跨字段不变式（final_hint_level ≤ hints_used 等）当前**有意不强制**——「先攒数据」
    // 阶段不假设派生语义，历史行不保证该不变式；进算法消费时再 firm-up。
    hints_used: z.number().int().nonnegative().max(MAX_HINT_COUNT).optional(),
    final_hint_level: z.number().int().nonnegative().max(MAX_HINT_INDEX).optional(),
    // see ReconstructionSignal — stamped 'unknown' at the live attempt write sites.
    reconstruction_signal: ReconstructionSignal.optional(),
    // Structured attempt-payload carrier（客观题型结构化作答）。OPTIONAL slot：live
    // writer 尚未接通，历史 attempt event byte-identical；判分今天仍读 answer_md。
    // NOTE: 本 slot 校验的是 FULL AttemptPayload union——event schema 没有 QuestionKind
    // 在手，不守 archetype↔question-kind 一致性；write 点必须调
    // parseAttemptPayloadForKind(kind, …)，不能靠这里拒绝 mistyped archetype。
    attempt_payload: AttemptPayload.optional(),
    // 学生自述的解题思路 / 过程文本（区别于 answer_md 的最终答案）。OPTIONAL →
    // 无过程文本的路径恒缺省，既有读路径逐字不变；attribution_followup 从此字段读入。
    // REASONING_TRACE_MAX_LEN 封上界挡失真大文本。engagement 红线 = 字段 optional。
    reasoning_trace: z.string().max(REASONING_TRACE_MAX_LEN).optional(),
    // 学生在看到判定前对本作答的主观把握（1–5 整数）。**observe-only**：仅作分析采集，
    // 绝不进 θ̂ / FSRS / 判分（语义与 review 侧 self_confidence 对齐）。OPTIONAL →
    // 无自评 / 历史 attempt 恒缺省，既有读路径逐字不变。
    self_confidence: z.number().int().min(1).max(5).optional(),
    // Immutable question evidence at answer time. Optional only for historical
    // events; every live attempt writer must stamp it. The snapshot includes the
    // shared parent stem, so later edits cannot pair a new prompt with an old answer.
    question_snapshot: AttemptQuestionSnapshot.optional(),
  }),
  ...baseOptionalFields,
});
export const AttemptOnQuestion = AttemptOnQuestionSchema.superRefine(enforceStableUserActorRef);
export type AttemptOnQuestionT = z.infer<typeof AttemptOnQuestion>;

// 2. JudgeOnEvent — outcome='success' 表示批改动作本身成功；答案对错在 payload.cause。

const PromptIdentity = z.object({
  prompt_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  prompt_template_revision: z.string().min(1),
});
const TrustedModelExecution = PromptIdentity.extend({
  version: z.literal(1),
  task_run_id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
});
const UntrustedExecution = PromptIdentity.extend({
  version: z.literal(1),
  task_run_id: z.never().optional(),
  provider: z.never().optional(),
  model: z.never().optional(),
});

export const JudgeExecutionProvenance = z.discriminatedUnion('kind', [
  TrustedModelExecution.extend({ kind: z.literal('invoked') }),
  TrustedModelExecution.extend({ kind: z.literal('supplied_verified') }),
  UntrustedExecution.extend({ kind: z.literal('supplied_unverified') }),
  UntrustedExecution.extend({ kind: z.literal('deterministic') }),
  UntrustedExecution.extend({ kind: z.literal('historical_unknown') }),
]);
export type JudgeExecutionProvenanceT = z.infer<typeof JudgeExecutionProvenance>;

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
    // Judge-event version pinning: 三个字段都 optional，使 union 仍能解析全部历史
    // judge event（不 backfill、不改写旧结果——rejudge = 新 event）。取值来自
    // SubjectProfile.version（invoker/attribution 层），不是模块级 '1.0.0' 常量：
    //   - profile_version: 判分时生效的 SubjectProfile.version
    //   - capability_ref:  被路由到的 judge capability（纯 attribution 路径未路由 → undefined）
    //   - judge_route:     实际运行的 JudgeKind（attribution → undefined）
    profile_version: z.string().optional(),
    capability_ref: CapabilityRef.optional(),
    judge_route: JudgeKind.optional(),
    // Newly written judge events must stamp versioned provenance; optional only
    // for historical compatibility. Provider/model are allowed only when copied
    // from an authoritative task run.
    execution_provenance: JudgeExecutionProvenance.optional(),
    // Paper-path visibility gate: independent paper judge sets `false` for
    // judge-now/show-later slots（feedback 缓冲到整卷完成）；omitted/true → 立即可见。
    // 可见性在读取时派生：可见 = visible_to_user !== false || session completed。
    // 单题 /api/review/submit embed 路径永不设置。
    visible_to_user: z.boolean().optional(),
    // Paper judge result stored in payload so the read layer can reconstruct
    // coarse_outcome / score on page reload without re-running the judge.
    // Optional so pre-U5 + single-question embed-path events still parse.
    coarse_outcome: z.string().optional(),
    score: z.number().optional(),
    // Paper placeholder judge sets this true so the attribution pipeline can
    // distinguish "already attributed" from "pending real cause"; the skip
    // condition checks `!attribution_pending`. Defaults false, no backfill.
    attribution_pending: z.boolean().optional(),
    // StructuredQuestion.id of the sub this verdict targets; ABSENT for atomic
    // verdicts (conditional-spread keeps the key absent, not null — historical
    // events parse byte-identically). Observability/addressability ONLY — does
    // NOT drive mastery fan-out (stays per-KC); this is the structured-jsonb
    // axis id, NOT a question_part id.
    sub_ref: z.string().optional(),
  }),
  ...baseOptionalFields,
});
export type JudgeOnEventT = z.infer<typeof JudgeOnEvent>;

// 3. ReviewOnQuestion — outcome 由 fsrs_rating 派生（见下方 superRefine）。

export const ReviewOnQuestion = z
  .object({
    actor_kind: z.literal('user'),
    actor_ref: StableUserActorRef,
    action: z.literal('review'),
    subject_kind: z.literal('question'),
    subject_id: z.string(),
    outcome: z.enum(['success', 'failure']),
    payload: z.object({
      fsrs_rating: z.enum(['again', 'hard', 'good']),
      fsrs_state_after: FsrsStateSchema,
      // Live multi-subject FSRS provenance. Practice submit has written these
      // keys since the knowledge-card rollout; keeping them optional preserves
      // historical rows while preventing the union parse from stripping the only
      // evidence of which cards this review advanced.
      fsrs_subject_kind: z.enum(['question', 'knowledge']).optional(),
      fsrs_subject_ids: z.array(z.string().min(1)).optional(),
      fsrs_state_after_by_subject: z
        .array(
          z.object({
            subject_kind: z.enum(['question', 'knowledge']),
            subject_id: z.string().min(1),
            state: FsrsStateSchema,
            due_at: z.coerce.date(),
          }),
        )
        .optional(),
      user_response_md: z.string().nullable(),
      // Handwriting-photo answer refs frozen onto the review event as the
      // judge's evidence trail. Without this field the union parse stripped
      // them on read so the refs vanished through the event API. Optional so
      // pre-image review events still parse.
      answer_image_refs: z.array(z.string()).optional(),
      // feeds knowledge_mastery view (ADR-0012)
      referenced_knowledge_ids: z.array(z.string()).default([]),
      // Optional because legacy events (pre-2026-05-17) don't have it.
      duration_ms: z.number().int().nonnegative().optional(),
      // Exact correlation back to the practice stream slot that produced this
      // review. The stream read model consults this before its conservative
      // legacy fallback, so a repeated review cannot lend its verdict to the
      // wrong row.
      stream_item_id: z.string().min(1).optional(),
      // see ReconstructionSignal — reserved for symmetry; no live review site
      // stamps it yet.
      reconstruction_signal: ReconstructionSignal.optional(),
      // 学生自述的解题思路（区别于 user_response_md 的最终作答）。OPTIONAL →
      // 非采集面 / 历史 review 恒缺省，既有读路径逐字不变；与 attempt 侧同风格封上界。
      reasoning_trace: z.string().max(REASONING_TRACE_MAX_LEN).optional(),
      // 学生在看到判定前对本次作答的主观把握（1-5 整数），判定揭晓前的 interstitial
      // 采集。**observe-only**：仅落 payload 供分析，绝不进 θ̂ / FSRS / 判分。命名用
      // self_confidence——confidence 已被 judge 置信度占用。OPTIONAL → 跳过 / 客观题
      // auto-commit / 历史 review 恒缺省，既有读路径逐字不变。
      self_confidence: z.number().int().min(1).max(5).optional(),
      // Diagnostic settlement uses judge correctness rather than the
      // learner-controlled FSRS rating/outcome.
      judge: JudgeResultV2.optional(),
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

// 4. ProposeKnowledge — parent_id=null 表示提议新学科/domain 根节点（此时 domain
// 必填，由业务层守门）。

export const ProposeKnowledge = z.object({
  actor_kind: z.literal('agent'),
  actor_ref: z.string(),
  action: z.literal('propose'),
  subject_kind: z.literal('knowledge'),
  subject_id: z.string(),
  outcome: z.enum(['success', 'partial']),
  payload: z.object({
    name: z.string(),
    parent_id: z.string().nullable(),
    domain: z.string().optional(),
    reasoning: z.string(),
  }),
  ...baseOptionalFields,
});
export type ProposeKnowledgeT = z.infer<typeof ProposeKnowledge>;

// 5. GenerateArtifact — payload.artifact_kind 区分子类型；referenced_event_ids
// 记录 artifact 派生自哪些 prior events。

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

// Merge-repair breadcrumb: a FORENSIC AUDIT TRAIL of what applyMerge touched —
// NOT a reversibility guarantee (sequential θ̂/FSRS fits are not decomposable).
// One entry per absorbed from_id, in payload.from_ids array order. Widened
// explicitly here rather than left to RateEvent.payload's non-strict passthrough.
export const MergeRepairEntry = z
  .object({
    from_id: z.string(),
    question_ids_rewritten: z.array(z.string()),
    learning_item_ids_rewritten: z.array(z.string()),
    goal_ids_rewritten: z.array(z.string()),
    // Per-edge forensic outcome. `new_edge_id` is non-null for 'rewired' (fresh
    // edge created) and 'reactivated' (an archived tombstone holding the
    // rewritten UNIQUE key was un-archived); null for the archive-only outcomes:
    // 'collapsed_self_loop' (both endpoints map to into_id), 'archived_duplicate'
    // (a LIVE edge already holds the rewritten key), 'archived_dangling' (the
    // non-into endpoint is archived/missing). The outcome↔new_edge_id coupling is
    // ENFORCED by the superRefine below, not just documented.
    edges_rewired: z.array(
      z
        .object({
          old_edge_id: z.string(),
          new_edge_id: z.string().nullable(),
          outcome: z.enum([
            'rewired',
            'reactivated',
            'collapsed_self_loop',
            'archived_duplicate',
            'archived_dangling',
          ]),
        })
        // .strict() — forensic data: a typo'd key must fail loudly, never be
        // silently stripped (matches the materialized_ids precedent below).
        .strict()
        .superRefine((entry, ctx) => {
          const wantsEdge = entry.outcome === 'rewired' || entry.outcome === 'reactivated';
          if (wantsEdge !== (entry.new_edge_id !== null)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `edges_rewired: outcome '${entry.outcome}' requires new_edge_id ${
                wantsEdge ? 'non-null' : 'null'
              }`,
              path: ['new_edge_id'],
            });
          }
        }),
    ),
    mastery_state: z.enum(['noop', 'renamed', 'frozen']),
    fsrs_state: z.enum(['noop', 'renamed', 'frozen']),
    axis_state: z.enum(['noop', 'renamed', 'frozen']),
    kc_typed_state: z.enum(['noop', 'renamed', 'frozen']),
    misconception_edges_rewritten: z.array(z.string()),
  })
  // .strict() — same rationale as the element object + materialized_ids.
  .strict();
export type MergeRepairEntryT = z.infer<typeof MergeRepairEntry>;

// 6. RateEvent — 用户对 prior event 投票 accept / dismiss / rollback。

export const RateEvent = z.object({
  actor_kind: z.literal('user'),
  actor_ref: StableUserActorRef,
  action: z.literal('rate'),
  subject_kind: z.literal('event'),
  subject_id: z.string(),
  outcome: z.literal('success'),
  payload: z.object({
    rating: z.enum(['accept', 'dismiss', 'rollback']),
    user_note: z.string().optional(),
    // When this rate event ACCEPTS a completion/relearn proposal it pins the
    // learning_item it materialized so retract can find the row to reverse
    // without re-reading the proposal. Only completion/relearn accepts set it.
    materialized_learning_item_id: z.string().optional(),
    // PRIOR-STATE CAPTURE: completion/relearn accepts overwrite status
    // (+ completed_at); the pre-accept values are otherwise UNRECOVERABLE, and a
    // wrong retract guess corrupts a `resting` item into `done` with a fabricated
    // completed_at. The accept pins the exact prior state so retract restores it
    // byte-for-byte. `null` means the prior completed_at was NULL. Reuses the
    // shared LearningItemStatus enum — the DB column has no constraint, so this
    // parse barrier is the only gate against restoring an invalid state.
    materialized_prior_status: LearningItemStatus.optional(),
    materialized_prior_completed_at: z.string().nullable().optional(),
    // When this rate event ACCEPTS a structural proposal, it pins the ids the
    // accept path minted so the fold can REPRODUCE the same knowledge.id /
    // knowledge_edge.id on replay (deterministic projection). MUST be optional:
    // dismiss/rollback mint nothing, and an accept may touch only nodes or only
    // edges.
    materialized_ids: z
      .object({
        knowledge: z.array(z.string()).optional(),
        knowledge_edge: z.array(z.string()).optional(),
      })
      // .strict() — reject unknown keys so a typo (e.g. `knowledge_edges`)
      // fails loudly at the parse barrier instead of silently dropping the
      // minted ids, which would break the fold's deterministic replay.
      .strict()
      .optional(),
    // The merge-repair forensic breadcrumb (see MergeRepairEntry above).
    // Only merge accepts set it.
    merge_repair: z.array(MergeRepairEntry).optional(),
  }),
  ...baseOptionalFields,
});
export type RateEventT = z.infer<typeof RateEvent>;

// 6b. CorrectEvent — first-class semantic correction for append-only history
// (supersede/retract/mark_wrong/restore), unlike RateEvent rating='rollback'.
//
// ATTRIBUTION: authored by the user lane (actor_kind='user', actor_ref='self')
// or the agent lane (e.g. the nightly edge reconcile SUPERSEDE auto-archives a
// contradicted live edge with no human in the loop). The branch keeps the
// independent agent half (`agent` MUST NOT be `self`) so an autonomous supersede
// is never mis-recorded as a user correction; consumers read only
// correction_kind + replacement_event_id, so they are attribution-agnostic.

export const CorrectionKind = z.enum(['supersede', 'retract', 'mark_wrong', 'restore']);
export type CorrectionKindT = z.infer<typeof CorrectionKind>;

export const CorrectEvent = z
  .object({
    actor_kind: z.enum(['user', 'agent']),
    actor_ref: z.string().min(1),
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
    // CorrectEvent keeps the agent-specific half of its attribution pairing here.
    if (data.actor_kind === 'agent' && data.actor_ref === 'self') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "actor_ref must be a non-'self' agent ref when actor_kind='agent'",
        path: ['actor_ref'],
      });
    }
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
  })
  .superRefine(enforceStableUserActorRef);
export type CorrectEventT = z.infer<typeof CorrectEvent>;

// 6c. CorrectArtifactEvent — block-grained correction for note artifacts.
// Kept a separate schema (not a union variant of CorrectEvent) because the
// payload shape differs: artifact targets have no natural `affected_refs`, and
// supersede replacement is an artifact_id, not an event_id. `block_id` omitted →
// whole-artifact correction; present → one body_blocks node id (ADR-0020 block
// anchors). getCorrectionStatuses filters on subject_kind='event' and does NOT
// see these rows; artifact-scoped composition lives in
// src/capabilities/notes/server/artifact-corrections.ts.

export const CorrectArtifactPayload = z
  .object({
    correction_kind: CorrectionKind,
    // block_id min(1): an empty string would create a nonsense `''` bucket in
    // the per-block projection Map — reject at the schema boundary.
    block_id: z.string().min(1).optional(),
    reason_md: z.string().min(1).max(2000),
    replacement_artifact_id: z.string().optional(),
  })
  .strict();

export const CorrectArtifactEvent = z
  .object({
    actor_kind: z.literal('user'),
    actor_ref: StableUserActorRef,
    action: z.literal('correct'),
    subject_kind: z.literal('artifact'),
    subject_id: z.string(),
    outcome: z.literal('success'),
    payload: CorrectArtifactPayload,
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

// 6d. SuppressArtifactLink — the user hides one system-maintained auto-link
// from a hub. Dismiss is an event (traceable + reversible), not a silent attrs
// mutation: the write path also appends the target to
// `artifact.attrs.suppressed_block_refs[]`, which the nightly hub sync skips.
// `subject_id` is the HUB artifact_id; `payload.suppressed_artifact_id` is the
// TARGET atomic whose crossLinkBlock is dismissed; `relation` is optional
// provenance for audit display.

export const SuppressArtifactLink = z.object({
  actor_kind: z.literal('user'),
  actor_ref: StableUserActorRef,
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

// 7. ExtractSourceDocument — OCR 抽取 source_document → question_block。

export const ExtractSourceDocument = z.object({
  actor_kind: z.literal('agent'),
  actor_ref: z.string(),
  action: z.literal('extract'),
  subject_kind: z.literal('source_document'),
  subject_id: z.string(),
  outcome: z.enum(['success', 'partial', 'failure']),
  payload: z.object({
    // 继承文档用途策略：缺省 === 'allow'（legacy 默认）。
    derivation_policy: DerivationPolicy.optional(),
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

export const SuggestionKind = z.enum(['proactive', 'corrective']);
export type SuggestionKindT = z.infer<typeof SuggestionKind>;

export const AcceptSuggestionChip = z.object({
  actor_kind: z.literal('user'),
  actor_ref: StableUserActorRef,
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

// 9. ProposeKnowledgeEdge — dry-run：需用户 rate=accept 后才晋升到 knowledge_edge 表。

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

// 10. GenerateKnowledgeEdge — 直接落库一条 knowledge_edge（maintenance agent
// 自动建或用户手加）。reasoning 在 agent 时必填、user 时可省——Zod 静态 schema
// 表达不了条件性必填，留给下方 superRefine。

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
      // Accept `null` (not just absent) so the event payload encodes an
      // explicitly-absent reasoning the SAME way the ROW does (`reasoning ?? null`).
      // The edge fold is then lossless and needs no `'' → null` coercion workaround;
      // user-actor events may carry null, agent-actor is still rejected by the
      // superRefine below (null is falsy).
      reasoning: z.string().nullable().optional(),
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
  })
  .superRefine(enforceStableUserActorRef);
export type GenerateKnowledgeEdgeT = z.infer<typeof GenerateKnowledgeEdge>;

// 12. ToolUseQuery — copilot tool-use path: agent invokes a registered
// DomainTool, the bridge mirrors the call into `event` when `mirrorEvent`
// policy fires. `subject_id` is self-identifying (`'tool_use_<cuid>'`).

export const ToolUseQuery = z
  .object({
    actor_kind: z.literal('agent'),
    actor_ref: z.string(),
    action: z.literal('tool_use'),
    subject_kind: z.literal('query'),
    subject_id: z.string(),
    outcome: z.enum(['success', 'failure']),
    payload: z.object({
      derivation_policy: DerivationPolicy.optional(),
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

const TOOL_OPERATION_EVENT_NAME_MAX_CHARS = 256;
const TOOL_OPERATION_EVENT_ERROR_CODE_MAX_CHARS = 100;
const TOOL_OPERATION_EVENT_ERROR_MESSAGE_MAX_CHARS = 4_000;

export const ToolOperationYielded = z.object({
  actor_kind: z.literal('system'),
  actor_ref: z.literal('tool_operations'),
  action: z.literal('tool_operation_yielded'),
  subject_kind: z.literal('tool_operation'),
  subject_id: z.string(),
  outcome: z.null(),
  payload: z.object({
    tool_name: z.string().min(1).max(TOOL_OPERATION_EVENT_NAME_MAX_CHARS),
    effect: z.enum(['read', 'propose', 'write']),
    process_id: z.string().min(1).max(TOOL_OPERATION_EVENT_NAME_MAX_CHARS),
  }),
  ...baseOptionalFields,
});
export type ToolOperationYieldedT = z.infer<typeof ToolOperationYielded>;

export const ToolOperationSettled = z
  .object({
    actor_kind: z.literal('system'),
    actor_ref: z.literal('tool_operations'),
    action: z.literal('tool_operation_settled'),
    subject_kind: z.literal('tool_operation'),
    subject_id: z.string(),
    outcome: z.enum(['success', 'failure']),
    payload: z.object({
      state: z.enum(['succeeded', 'failed', 'cancelled', 'lost']),
      side_effect_risk: z.enum(['none', 'possible']).optional(),
      error: z
        .object({
          code: z.string().min(1).max(TOOL_OPERATION_EVENT_ERROR_CODE_MAX_CHARS),
          message: z.string().min(1).max(TOOL_OPERATION_EVENT_ERROR_MESSAGE_MAX_CHARS),
        })
        .optional(),
      terminal_tool_call_log_id: z
        .string()
        .min(1)
        .max(TOOL_OPERATION_EVENT_NAME_MAX_CHARS)
        .optional(),
    }),
    ...baseOptionalFields,
  })
  .superRefine((data, ctx) => {
    const isSucceeded = data.payload.state === 'succeeded';
    if ((data.outcome === 'success') !== isSucceeded) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'outcome must match the terminal state',
        path: ['outcome'],
      });
    }
    if (isSucceeded && (data.payload.error || data.payload.side_effect_risk)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'succeeded operations cannot carry error or side-effect risk',
        path: ['payload'],
      });
    }
    if (!isSucceeded && !data.payload.error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'non-success terminal states require an error',
        path: ['payload', 'error'],
      });
    }
    if ((data.payload.state === 'lost') !== Boolean(data.payload.side_effect_risk)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'side-effect risk is required only for lost operations',
        path: ['payload', 'side_effect_risk'],
      });
    }
  });
export type ToolOperationSettledT = z.infer<typeof ToolOperationSettled>;

// 11. RateKnowledgeEdge — 用户对 propose / generate 的 edge 投票（change_type /
// reverse 的附加字段要求由下方 superRefine 守门）。

export const RateKnowledgeEdge = z
  .object({
    actor_kind: z.literal('user'),
    actor_ref: StableUserActorRef,
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
// z.union 而非 discriminatedUnion：后者只支持单键判别且要求每个分支 literal 唯一，
// 而这里有 5 组 action×subject_kind 重复（'propose'×{knowledge, knowledge_edge}、
// 'generate'×{artifact, knowledge_edge}、'rate'×{event, knowledge_edge}、
// 'correct'×{event, artifact}、'suppress'×{artifact}）。每个 schema 用 z.literal()
// 锁 (action, subject_kind) 组合，parse 仍单义解析（Zod 按 union 顺序取第一个
// matching schema；相同 action 的分支按 subject_kind 字母序排列以稳定顺序）。

export const KnownEvent = z
  .union([
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
    ToolOperationYielded,
    ToolOperationSettled,
  ])
  .superRefine(enforceStableUserActorRef);
export type KnownEventT = z.infer<typeof KnownEvent>;
