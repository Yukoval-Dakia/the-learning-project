// YUK-226 S2 slice 5b — unified 找题次序 orchestration (spec §3.2 B+).
//
// docs/superpowers/specs/2026-06-05-question-source-expansion-design.md §3.2
// docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §6.1 (B2 裁决)
//
// spec §3.2 defines a SINGLE 找题次序 every "需要知识点 X 的题" consumer (组卷 /
// 弱点专项 / QuizGen 触发 / 复习池补题) must follow:
//
//   1. 先查已入库   question 表既有题（任意 tier，优先高 tier）        ← SYNC
//   2. 外部检索     SourcingTask 找现成题 → 自动入库 draft → 验证门    ← ASYNC enqueue
//   3. 素材生成     material_grounded → 验证门                          ← ASYNC enqueue
//   4. 闭卷兜底     closed_book / variant_gen → 验证门（最重）          ← ASYNC enqueue
//
// B2 裁决（plan §6.1, BLOCKER）: the four steps are NOT串完 in one call. Step 1 is a
// synchronous query against the existing pool (so组卷 can use a hit immediately);
// steps 2-4 are "trigger background production + mark a need" — the next组卷 round
// sees the newly-ingested questions (spec §3.2「题库是用出来的，不是囤出来的」—— the
// sequence is memory-ful: 今天检索入库，明天第 1 步命中).
//
// This module does NOT touch the ReviewPlanTask needs[] path: ReviewPlanTask's
// "only declare needs[], never CRUD" is a systemPrompt + write-tool boundary
// constraint (review-plan-tools.ts). The consumer-SIDE wiring (a缺题 entry like
// /api/questions/quiz-gen) calls THIS orchestrator instead of enqueuing quiz_gen
// directly, so step 1 + the tiered次序 run before any自产.
//
// 边界 (spec §3.2): step 1「已入库」含 owner 做过的真题; this次序 serves the
// "要新题/扩充练习" scenario and does NOT绕过错题本 (the orchestrator only READS the
// active pool and ENQUEUES production — it never touches mistakes / review state).

import { and, asc, sql } from 'drizzle-orm';

import { deriveSourceTier } from '@/core/schema/provenance';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { resolveSubjectProfile } from '@/subjects/profile';
import type { SubjectProfile } from '@/subjects/profile-schema';

// The downstream production steps, in default order. Step 1 (existing pool) is the
// synchronous query below and is NOT part of this enum (it never enqueues).
export const SOURCING_SEQUENCE_STEPS = [
  'external_sourcing',
  'material_grounded',
  'closed_book',
] as const;
export type SourcingSequenceStep = (typeof SOURCING_SEQUENCE_STEPS)[number];

// Default后台 production次序 when the profile declares no per-题型 preference.
// Mirrors spec §3.2 steps 2→3→4 verbatim.
export const DEFAULT_SOURCING_ROUTE: readonly SourcingSequenceStep[] = SOURCING_SEQUENCE_STEPS;

// How many existing-pool hits make step 1 "sufficient" by default — caller can
// override via `count`. Default mirrors the quiz_gen / sourcing handler default (3).
export const SOURCING_DEFAULT_COUNT = 3;

// ── Step 1: synchronous existing-pool query ───────────────────────────────────

export interface ExistingPoolHit {
  question_id: string;
  source: string;
  tier: number;
}

// Pull the ACTIVE (non-draft) questions attached to a knowledge node, ordered by
// source tier (high tier = low number first), then创建顺序. Mirrors the candidate
// SELECT widening from slice 5a (projects source + metadata so deriveSourceTier can
// run) and the non-draft filter used by context-readers / due-list (drafts never
// enter the pool — Gate-B先例).
async function queryExistingPool(
  db: Db,
  knowledgeId: string,
  limit: number,
): Promise<ExistingPoolHit[]> {
  const rows = await db
    .select({
      id: question.id,
      source: question.source,
      metadata: question.metadata,
    })
    .from(question)
    .where(
      and(
        sql`${question.knowledge_ids} @> ${JSON.stringify([knowledgeId])}::jsonb`,
        // Drafts never enter the pool (mirror context-readers:797 / due-list Gate-B).
        sql`(${question.draft_status} IS NULL OR ${question.draft_status} <> 'draft')`,
      ),
    )
    // Stable secondary order; the tier sort below is applied in-memory because tier is
    // a derived (metadata-driven) value, not a column.
    .orderBy(asc(question.created_at), asc(question.id))
    // Over-fetch a little so the tier sort has room, then trim to `limit`.
    .limit(Math.max(limit * 4, limit));

  const hits = rows.map((r) => ({
    question_id: r.id,
    source: r.source,
    tier: deriveSourceTier({ source: r.source, metadata: r.metadata ?? null }).tier,
  }));
  // High tier first (1 authentic → 4 generated); created_at order already stable from
  // the SQL, so this is a stable secondary sort within the same tier.
  hits.sort((a, b) => a.tier - b.tier);
  return hits.slice(0, limit);
}

// ── Profile route preference (defensive — S2-4 adds the field) ────────────────

// Read the subject profile's per-题型 找题次序偏好 (§3.2 / plan row 4.x
// `sourcingRoutePreference`). The field is added by S2-4 (profile-schema.ts);
// until then it is absent on every profile, so this resolves to the default次序
// — the容错 form the task spec calls for ("若 profile 有偏好则用、无则默认次序").
// When S2-4 merges and populates the field, it takes effect with no change here.
export function resolveRoutePreference(
  profile: SubjectProfile,
  kind: string | null,
): readonly SourcingSequenceStep[] {
  const raw = (profile as { sourcingRoutePreference?: unknown }).sourcingRoutePreference;
  if (!raw || typeof raw !== 'object') return DEFAULT_SOURCING_ROUTE;
  // Shape (forward-compatible with S2-4): a map from 题型 key → ordered step list.
  // Fall back to a '*' default entry, then the hard-coded default.
  const byKind = raw as Record<string, unknown>;
  const candidate = (kind && byKind[kind]) || byKind['*'];
  if (!Array.isArray(candidate)) return DEFAULT_SOURCING_ROUTE;
  const steps = candidate.filter(
    (s): s is SourcingSequenceStep =>
      typeof s === 'string' && (SOURCING_SEQUENCE_STEPS as readonly string[]).includes(s),
  );
  return steps.length > 0 ? steps : DEFAULT_SOURCING_ROUTE;
}

// ── Async enqueue seam (DB-test injectable) ──────────────────────────────────

// The orchestrator enqueues background production jobs but never waits for them to
// ingest (B2). The default impl sends to the existing pg-boss queues (slice 2/3):
//   external_sourcing → 'sourcing'  (SourcingTask, tier 2)
//   material_grounded → 'quiz_gen'  (QuizGenTask picks material_grounded, tier 3)
//   closed_book       → 'quiz_gen'  (QuizGenTask falls back to closed_book, tier 4)
// material_grounded vs closed_book both ride the quiz_gen queue — the QuizGenTask
// agent picks the generation_method at run time (Tavily availability + prompt);
// the orchestrator's job is only to drive the次序, not the method选择.
export type EnqueueSequenceJobFn = (
  step: SourcingSequenceStep,
  data: { trigger: SourcingTrigger; ref_id: string; count?: number },
) => Promise<void>;

// Mirror the quiz_gen / sourcing trigger surface (knowledge / learning_item /
// manual). Kept local to avoid importing a handler module into core orchestration.
export const SOURCING_TRIGGERS = ['knowledge', 'learning_item', 'manual'] as const;
export type SourcingTrigger = (typeof SOURCING_TRIGGERS)[number];

function queueForStep(step: SourcingSequenceStep): 'sourcing' | 'quiz_gen' {
  return step === 'external_sourcing' ? 'sourcing' : 'quiz_gen';
}

async function defaultEnqueueSequenceJob(
  step: SourcingSequenceStep,
  data: { trigger: SourcingTrigger; ref_id: string; count?: number },
): Promise<void> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  await boss.send(queueForStep(step), {
    trigger: data.trigger,
    ref_id: data.ref_id,
    ...(data.count !== undefined ? { count: data.count } : {}),
  });
}

// ── needs[] markers ───────────────────────────────────────────────────────────

// Reuse the ReviewPlanNeedSchema `question_generation` 先例 shape (plan §6.1(b):
// 枚举不动、payload 加性). We add a `source` discriminator to distinguish which
// of the four lines was triggered, mirroring the S1 `unsupported_judge` additive-
// optional-flag手法. This is NOT the same object instance as ReviewPlanNeedSchema
// (that lives behind the ReviewPlanTask write-tool boundary) — it is the
// consumer-side marker the orchestrator returns so the caller knows what background
// production is in flight.
export interface SourcingNeed {
  kind: 'question_generation';
  knowledge_id: string;
  // additive discriminator: which找题线 was enqueued for this need.
  source: SourcingSequenceStep;
  reason: string;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export interface SourcingSequenceParams {
  db: Db;
  // The knowledge node the consumer needs questions for.
  knowledgeId: string;
  // The trigger surface forwarded to background jobs (defaults to 'knowledge').
  trigger?: SourcingTrigger;
  // ref_id forwarded to background jobs (defaults to knowledgeId — the quiz_gen /
  // sourcing handlers resolve a knowledge node from it).
  refId?: string;
  // How many existing-pool hits count as "sufficient" (step 1 short-circuit).
  count?: number;
  // 题型 hint for the profile route preference (§3.2 per-题型偏好). Optional.
  kind?: string | null;
  // Subject domain → resolves the profile (route preference + future whitelist).
  // When absent, resolveSubjectProfile falls back to the default subject.
  domain?: string | null;
  // DB-test seam.
  enqueueSequenceJob?: EnqueueSequenceJobFn;
}

export interface SourcingSequenceResult {
  // Step 1 hits that组卷 can use IMMEDIATELY (high tier first).
  existing: ExistingPoolHit[];
  // true when step 1 satisfied `count` and no background production was triggered.
  satisfiedFromPool: boolean;
  // Background production steps enqueued (in preference order) when step 1 was short.
  enqueued: SourcingSequenceStep[];
  // Consumer-side need markers for the in-flight background production.
  needs: SourcingNeed[];
}

/**
 * Run the unified §3.2 找题次序 for one knowledge node.
 *
 * Step 1 (existing pool) is synchronous: if it yields ≥ `count` active questions the
 * orchestrator returns immediately and enqueues NOTHING (题库是用出来的 —
 * already-built supply is preferred over自产). Otherwise it enqueues the background
 * production次序 (step 2/3/4) in the profile's per-题型 preference order and returns
 * needs[] markers — WITHOUT waiting for those jobs to ingest (B2 async boundary).
 */
export async function runSourcingSequence(
  params: SourcingSequenceParams,
): Promise<SourcingSequenceResult> {
  const { db, knowledgeId } = params;
  const count = params.count ?? SOURCING_DEFAULT_COUNT;
  const trigger = params.trigger ?? 'knowledge';
  const refId = params.refId ?? knowledgeId;
  const enqueue = params.enqueueSequenceJob ?? defaultEnqueueSequenceJob;

  // Step 1 — synchronous existing-pool query (high tier first).
  const existing = await queryExistingPool(db, knowledgeId, count);
  if (existing.length >= count) {
    return { existing, satisfiedFromPool: true, enqueued: [], needs: [] };
  }

  // Steps 2-4 — enqueue background production in the profile's preference order.
  const profile = resolveSubjectProfile(params.domain ?? null);
  const route = resolveRoutePreference(profile, params.kind ?? null);

  const enqueued: SourcingSequenceStep[] = [];
  const needs: SourcingNeed[] = [];
  for (const step of route) {
    await enqueue(step, { trigger, ref_id: refId, count });
    enqueued.push(step);
    needs.push({
      kind: 'question_generation',
      knowledge_id: knowledgeId,
      source: step,
      reason: `existing pool had ${existing.length}/${count} active questions; enqueued ${step}`,
    });
  }

  return { existing, satisfiedFromPool: false, enqueued, needs };
}
