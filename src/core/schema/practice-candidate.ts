// YUK-1790 LIGHT — practice candidate read contract shared by the human-facing read
// (scheduling owner) and the Coach DomainTool. Rows carry ONLY typed facts: every signal
// is a KnowledgeSignal envelope, and a missing reading stays unknown with its reason —
// never a zero and never a low-mastery claim (design 2026-11-07-yuk1790-coach-queue.md D2).
//
// Role vocabulary is the union the design binds; a question may carry several roles at
// once (a due question that is also an active variant keeps BOTH facts). Rows dedupe by
// refKind + refId + revision, so `roles` is multi-valued while identity stays single.
import { z } from 'zod';
import { A5_BANDS } from '@/core/mastery-band';
import type { MasteryDecayBucket } from '@/core/mastery-freshness';

/** Design D2 candidate roles. `intervention`/`paper` carry container identity. */
export const PRACTICE_CANDIDATE_ROLES = [
  'due',
  'variant',
  'new_check',
  'frontier',
  'unattempted',
  'intervention',
  'paper',
] as const;
export type PracticeCandidateRole = (typeof PRACTICE_CANDIDATE_ROLES)[number];

export const PRACTICE_CANDIDATE_CONTAINERS = ['question', 'intervention', 'paper'] as const;
export type PracticeCandidateContainer = (typeof PRACTICE_CANDIDATE_CONTAINERS)[number];

/** One deterministic page. First page must cover a planning turn; paging is the overflow path. */
export const PRACTICE_CANDIDATE_PAGE_SIZE = 30;

/**
 * Candidate scope. `all` applies no knowledge restriction; `knowledge` is a hard membership
 * set (explicit ids, no descendant expansion); `goal` reads that goal's resolved scope from
 * the goal owner (subject_live goals re-derive at read time — never the frozen column).
 */
export const PracticeCandidateScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all') }),
  z.strictObject({
    kind: z.literal('knowledge'),
    knowledgeIds: z.array(z.string().trim().min(1)).min(1).max(40),
  }),
  z.strictObject({ kind: z.literal('goal'), goalId: z.string().trim().min(1) }),
]);
export type PracticeCandidateScope = z.infer<typeof PracticeCandidateScopeSchema>;

export const PracticeCandidateQuerySchema = z.strictObject({
  scope: PracticeCandidateScopeSchema,
  /** Opaque page token returned by a previous read; requires the matching snapshotId. */
  cursor: z.string().min(1).nullish(),
  /** Set identity every page must share; a changed set returns status='snapshot_changed'. */
  snapshotId: z.string().min(1).nullish(),
});
export type PracticeCandidateQuery = z.infer<typeof PracticeCandidateQuerySchema>;

export type CandidateMasteryBand = (typeof A5_BANDS)[number];
export type CandidateDecayBand = Exclude<MasteryDecayBucket, 'unknown'>;

/** Structural twin of kernel/read-models/cause-judgment TopCause (core cannot import kernel). */
export type CandidateTopCause = {
  category: string;
  label: string | null;
  count: number;
  last_at: string;
};

/**
 * Signal envelope shared with YUK-1969 (`core/schema/knowledge-signal`). `known:false` means
 * the read did not produce a value and `missingReason` says why; `known:true, value:null` is a
 * real absence (e.g. no due card, recall-locked MFI). Zero is only ever a measured zero.
 */
export function knowledgeSignalSchema<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    value: value.nullable(),
    known: z.boolean(),
    source: z.string(),
    asOf: z.string(),
    missingReason: z.string().nullable(),
  });
}

const MasteryBandSchema = z.enum(A5_BANDS);
const DecayBandSchema = z.enum(['untrained', 'fresh', 'mild', 'stale']);

export const CandidateKnowledgeSignalSchema = z.object({
  knowledge_id: z.string(),
  name: z.string().nullable(),
  /** YUK-1969 mastery band (p(L)); unknown keeps its reason and never becomes a low band. */
  mastery: knowledgeSignalSchema(MasteryBandSchema),
  evidence_count: knowledgeSignalSchema(z.number()),
  /** YUK-1969 retention (FSRS retrievability at asOf). */
  retention: knowledgeSignalSchema(z.number()),
  due_at: knowledgeSignalSchema(z.string()),
  decay: knowledgeSignalSchema(DecayBandSchema),
  /** YUK-1970 owns streak/cause recurrence; absent today → known:false with its reason. */
  consecutive_errors: knowledgeSignalSchema(z.number()),
  top_causes: knowledgeSignalSchema(
    z.array(
      z.object({
        category: z.string(),
        label: z.string().nullable(),
        count: z.number(),
        last_at: z.string(),
      }),
    ),
  ),
});

export const CandidateRevisionSchema = z.object({
  known: z.boolean(),
  revision_id: z.string().nullable(),
  /** Published question integrity digest / null when the owner exposes none. */
  digest: z.string().nullable(),
  /** Artifact version for paper containers. */
  version: z.number().nullable(),
  missing_reason: z.string().nullable(),
});

export const CandidateAttemptWindowSchema = z.object({
  count: knowledgeSignalSchema(z.number()),
  outcomes: z.object({
    success: z.number(),
    partial: z.number(),
    failure: z.number(),
  }),
  last_at: z.string().nullable(),
  last_outcome: z.enum(['success', 'partial', 'failure', 'pending', 'unsupported']).nullable(),
  /** How many newest attempt rows per question were scanned for the window above. */
  window: z.number(),
  /** False when the question had more attempts than the window: count is a floor, not a total. */
  window_complete: z.boolean(),
});

export const CandidateDueFactSchema = z.object({
  /** KC whose due card selected this candidate; null = question-level legacy card. */
  knowledge_id: z.string().nullable(),
  due_at: knowledgeSignalSchema(z.string()),
  overdue_hours: z.number().nullable(),
  retention: knowledgeSignalSchema(z.number()),
});

export const CandidateServingSchema = z.object({
  servable: z.boolean(),
  source: z.string(),
  checked_at: z.string(),
  admission_status: z.enum(['pending', 'admitted', 'failed', 'undecided']).nullable(),
  admission_reason: z.string().nullable(),
  hold_reason: z.string().nullable(),
});

export const PracticeCandidateRowSchema = z.object({
  ref_kind: z.enum(['question', 'paper']),
  ref_id: z.string(),
  container: z.enum(PRACTICE_CANDIDATE_CONTAINERS),
  roles: z.array(z.enum(PRACTICE_CANDIDATE_ROLES)).min(1),
  revision: CandidateRevisionSchema,
  /** Prompt excerpt (never the answer key). Truncated explicitly; null for papers. */
  prompt: z
    .object({
      text: z.string(),
      chars: z.number(),
      truncated: z.boolean(),
      source: z.string(),
    })
    .nullable(),
  knowledge_ids: z.array(z.string()),
  knowledge: z.array(CandidateKnowledgeSignalSchema),
  question: z
    .object({
      kind: knowledgeSignalSchema(z.string()),
      difficulty: knowledgeSignalSchema(z.number()),
      difficulty_b: knowledgeSignalSchema(z.number()),
      b_source: z.enum(['item_calibration', 'difficulty_proxy', 'none']),
      estimated_minutes: knowledgeSignalSchema(z.number()),
    })
    .nullable(),
  serving: CandidateServingSchema,
  recent_attempts: CandidateAttemptWindowSchema,
  due: z.array(CandidateDueFactSchema),
  /** Steering exam pressure from the existing selection reader (1 in scope, 0.5 prereq). */
  exam_relevance: knowledgeSignalSchema(z.number()),
  /** YUK-1970 misconception recurrence; absent today → known:false, never zero. */
  cause_recurrence: knowledgeSignalSchema(z.number()),
  mfi: z.object({
    value: z.number().nullable(),
    known: z.boolean(),
    score_kind: z.enum(['mfi', 'klp', 'klp_grid']).nullable(),
    recall_locked: z.boolean(),
    source: z.string(),
    as_of: z.string(),
    missing_reason: z.string().nullable(),
  }),
  paper: z
    .object({
      title: z.string(),
      source: z.string(),
      intent_source: z.string(),
      generation_status: z.string(),
      total_slots: z.number(),
    })
    .nullable(),
});

export const CandidateGapSchema = z.object({
  scope_kind: z.enum(['all', 'knowledge', 'goal']),
  /** Knowledge ids the empty pool covers (bounded; empty for whole-scope gaps). */
  knowledge_ids: z.array(z.string()),
  reason: z.enum([
    'no_servable_candidate',
    'not_admitted',
    'frontier_sparse',
    'frontier_overflow',
    'scope_unresolved',
    'due_pool_empty',
    'snapshot_changed',
  ]),
  /** Deterministic explanation of the empty pool. */
  detail: z.string(),
  /** Demand contract the preparer's existing async entry files against. */
  demand_version: z.string(),
});

export const CandidateExclusionSchema = z.object({
  reason: z.enum([
    'out_of_scope',
    'not_admitted',
    'draft_or_suspended',
    'steering_deferred',
    'untracked_knowledge',
    'already_attempted',
    'duplicate_ref',
    'page_overflow',
    'cap_reached',
  ]),
  roles: z.array(z.enum(PRACTICE_CANDIDATE_ROLES)),
  count: z.number(),
  /** A bounded sample so the reader can audit the count without a full dump. */
  ref_ids: z.array(z.string()),
});

export const PracticeCandidateReadSchema = z.object({
  /** 'snapshot_changed' means the candidate set moved; no rows are returned for that page. */
  status: z.enum(['ok', 'snapshot_changed']),
  snapshot_id: z.string(),
  as_of: z.string(),
  /** Set on 'snapshot_changed' only: the page the caller was continuing. */
  expected_snapshot_id: z.string().nullable(),
  scope: z.object({
    kind: z.enum(['all', 'knowledge', 'goal']),
    knowledge_ids: z.array(z.string()),
    goal_ids: z.array(z.string()),
    /** True when `all` left the unattempted scan unbounded in scope (bounded by cap only). */
    unscoped: z.boolean(),
  }),
  versions: z.object({
    /** goal.version is the durable row CAS counter. */
    goals: z.array(
      z.object({
        goal_id: z.string(),
        version: z.number().nullable(),
        updated_at: z.string().nullable(),
      }),
    ),
    /** Content digest of the canonical scope set (not a stored version). */
    scope_digest: z.string(),
    steering: z.object({
      known: z.boolean(),
      value: z.null(),
      source: z.string(),
      asOf: z.string(),
      missingReason: z.string().nullable(),
    }),
  }),
  counts: z.object({
    total_before_dedup: z.number(),
    total_after_dedup: z.number(),
    returned: z.number(),
    by_role: z.record(z.enum(PRACTICE_CANDIDATE_ROLES), z.number()),
    by_container: z.record(z.enum(PRACTICE_CANDIDATE_CONTAINERS), z.number()),
    /** Per-source cap facts so truncation is explicit, never a silent omission. */
    source_caps: z.array(
      z.object({
        source: z.string(),
        cap: z.number(),
        observed: z.number(),
        hit: z.boolean(),
      }),
    ),
  }),
  page: z.object({
    cursor: z.string().nullable(),
    next_cursor: z.string().nullable(),
    page_size: z.number(),
    has_more: z.boolean(),
  }),
  candidates: z.array(PracticeCandidateRowSchema),
  gaps: z.array(CandidateGapSchema),
  exclusions: z.array(CandidateExclusionSchema),
});

export type CandidateKnowledgeSignal = z.infer<typeof CandidateKnowledgeSignalSchema>;
export type CandidateRevision = z.infer<typeof CandidateRevisionSchema>;
export type CandidateAttemptWindow = z.infer<typeof CandidateAttemptWindowSchema>;
export type CandidateDueFact = z.infer<typeof CandidateDueFactSchema>;
export type CandidateServing = z.infer<typeof CandidateServingSchema>;
export type PracticeCandidateRow = z.infer<typeof PracticeCandidateRowSchema>;
export type CandidateGap = z.infer<typeof CandidateGapSchema>;
export type CandidateExclusion = z.infer<typeof CandidateExclusionSchema>;
export type PracticeCandidateRead = z.infer<typeof PracticeCandidateReadSchema>;
