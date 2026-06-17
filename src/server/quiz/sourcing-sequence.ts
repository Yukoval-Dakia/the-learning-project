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

import { and, eq, isNull } from 'drizzle-orm';

import { compareBySourceTierThenWhitelist, deriveSourceTier } from '@/core/schema/provenance';
import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { buildTavilyMcpServer } from '@/server/ai/mcp/tavily';
import { poolFetch } from '@/server/quiz/pool-fetch';
import { resolveSubjectProfile } from '@/subjects/profile';
import type { SubjectProfile, SubjectQuestionKind } from '@/subjects/profile-schema';
import { kindsMatch, questionKindToSkillKind } from '@/subjects/question-kind';

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

// OF-2 (plan §12) — read metadata.web_sourced.whitelist_match for the within-tier-2
// demotion comparator. Returns null for non-web_sourced rows (no whitelist semantics).
// Mirrors context-readers' readWhitelistMatch predicate verbatim; the ORDER logic
// itself is the shared compareBySourceTierThenWhitelist comparator (合约五), so only
// this tiny jsonb read is local — the sort semantics are not re-implemented.
function readWhitelistMatch(metadata: Record<string, unknown> | null): boolean | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const webSourced = (metadata as Record<string, unknown>).web_sourced;
  if (!webSourced || typeof webSourced !== 'object') return null;
  const match = (webSourced as Record<string, unknown>).whitelist_match;
  return typeof match === 'boolean' ? match : null;
}

// Pull the ACTIVE (non-draft) questions attached to a knowledge node, ordered by
// source tier (high tier = low number first), then OF-2 whitelist demotion, then创建
// 顺序. Mirrors the candidate SELECT widening from slice 5a (projects source +
// metadata so deriveSourceTier can run) and the non-draft filter used by
// context-readers / due-list (drafts never enter the pool — Gate-B先例).
async function queryExistingPool(
  db: Db,
  knowledgeId: string,
  limit: number,
  // YUK-226 S2-5b (验证轮 A2) — when the sequence targets a specific 题型, the
  // existing pool must be filtered by that kind so a node full of `reading`
  // questions does NOT short-circuit a `computation` request. The compare runs in
  // canonical space (kindsMatch), so a `reading_comprehension` request matches
  // `reading` rows and `calculation` matches `computation` — no vocabulary
  // mismatch silently dropping hits. null kind → no filter (whole active pool).
  kind: string | null,
  // YUK-275 — free-text 求卷扩两个维度过滤:
  //   difficultyMin: only count questions whose difficulty >= n (null → no filter).
  //   unit='篇' : only count COMPOSITE parent questions (a parent that itself is not a
  //     part AND has ≥1 child part). 'unit'='题'/null → no composite filter (whole pool).
  // Both default to null on every existing caller (5b 调用方字节级不变).
  difficultyMin: number | null,
  unit: '题' | '篇' | null,
): Promise<ExistingPoolHit[]> {
  // F2 (PR #318 round-1): tier is a DERIVED (metadata-driven) value, not a column, so
  // it cannot be expressed in SQL ORDER BY. The previous code截断 to limit×4 in SQL
  // BEFORE the in-memory tier sort, which could drop a newer high-tier row in favour of
  // older low-tier ones (the truncation키ed off created_at, not tier). We instead fetch
  // the FULL candidate set for this one knowledge node and rank entirely in memory.
  // 量级论证: candidates are scoped to a SINGLE knowledge node (knowledge_ids @> [id])
  // and exclude drafts — a node's active question pool is bounded (tens, not millions);
  // there is no unbounded-table scan here. created_at asc gives a stable base order so
  // the comparator below is a stable secondary sort within equal (tier, demotion).
  //
  // YUK-398 inc-2 — the raw scalar pool query is now the unified poolFetch operator
  // (pool-fetch.ts). The WHERE clause is byte-identical (poolFetch covers all four
  // predicates: KC containment / draft exclusion via activeOnly default true /
  // difficultyMin floor / unit='篇' composite parent) and the non-vector ORDER is the
  // same asc(created_at), asc(id). CRITICAL: limit is NOT passed to poolFetch — slicing
  // in SQL would truncate by created_at BEFORE the in-memory tier sort below (the F2
  // regression). poolFetch returns the FULL single-KC candidate set; the kind filter,
  // 合约五 tier/whitelist sort, and limit slice all stay app-layer (unchanged).
  const rows = await poolFetch(db, {
    knowledgeId,
    activeOnly: true,
    difficultyMin,
    compositeParentOnly: unit === '篇',
    // no limit — slice AFTER the in-memory tier sort (F2).
  });

  const hits = rows
    // A2 — kind filter in canonical space (no-op when kind is null). A row whose
    // persisted kind doesn't normalize-match the requested kind is excluded so the
    // pool count reflects only on-target questions.
    .filter((r) => kind === null || kindsMatch(r.kind, kind))
    .map((r) => ({
      question_id: r.id,
      source: r.source,
      tier: deriveSourceTier({ source: r.source, metadata: r.metadata ?? null }).tier,
      whitelistMatch: readWhitelistMatch((r.metadata ?? null) as Record<string, unknown> | null),
    }));
  // 合约五 shared comparator: high tier first (1 authentic → 4 generated), then OF-2
  // within-tier demotion (off-whitelist behind on-whitelist). Same comparator slice 5a
  // uses — the created_at base order from SQL stays stable within equal keys.
  hits.sort(compareBySourceTierThenWhitelist);
  return hits
    .slice(0, limit)
    .map(({ question_id, source, tier }) => ({ question_id, source, tier }));
}

// YUK-226 S2-5b (验证轮 B) — resolve the knowledge node ONCE: whether it exists as a
// LIVE (non-archived) node, plus its domain (F5: subject for the route preference when
// the caller omits `domain`). The orchestrator must NOT enqueue background production
// for a missing/archived node — that produces a need[] marker that can never resolve
// (the worker-side anchor guard at quiz_gen.ts:326 / sourcing.ts rejects archived
// anchors with isNull(archived_at), so the enqueued job would just fail). This single
// pre-enqueue check aligns the API surface with that worker guard.
async function resolveLiveKnowledgeNode(
  db: Db,
  knowledgeId: string,
): Promise<{ exists: boolean; domain: string | null }> {
  const rows = await db
    .select({ domain: knowledge.domain })
    .from(knowledge)
    .where(and(eq(knowledge.id, knowledgeId), isNull(knowledge.archived_at)))
    .limit(1);
  const row = rows[0];
  return { exists: row !== undefined, domain: row?.domain ?? null };
}

// ── Profile route preference (S2-4 adds the field) ────────────────────────────

// F1 (PR #320 round-4): the profile's `sourcingRoutePreference` is keyed in PROFILE
// tokens (SubjectProfileSchema:89 — `sourced | material | closed_book | variant`), but
// the orchestrator drives SEQUENCE STEPS (`external_sourcing | material_grounded |
// closed_book`). The old code filtered profile values against the sequence-step name
// set, so every token that didn't happen to share a name with a step (`sourced`,
// `material`, `variant`) was silently dropped — wenyan reading collapsed to just
// `closed_book` and math/physics skipped external sourcing entirely. We translate via
// a single explicit token→step map instead.
//
// Mapping derives directly from spec §3.2 (四线 ↔ 找题次序, design doc lines 60-76):
//   `sourced`     → external_sourcing  (tier 2「在线检索线」/ SourcingTask)
//   `material`    → material_grounded  (tier 3「素材生成线」)
//   `closed_book` → closed_book        (tier 4「闭卷兜底」)
//   `variant`     → closed_book        (tier 4: spec §3.2 lines 65/75 bind「闭卷/variant
//                   线」into the SAME tier-4 fallback; the sequence enum has no separate
//                   variant_gen step, so the profile's `variant` token routes through the
//                   tier-4 closed_book line. Adjacent duplicates are deduped below so a
//                   route like `['closed_book','variant']` enqueues closed_book once.)
const PROFILE_TOKEN_TO_STEP: Record<string, SourcingSequenceStep> = {
  sourced: 'external_sourcing',
  material: 'material_grounded',
  closed_book: 'closed_book',
  variant: 'closed_book',
};

// Read the subject profile's per-题型 找题次序偏好 (§3.2 / plan row 4.x
// `sourcingRoutePreference`). When the field is absent (or holds no usable preference for
// this 题型) this resolves to the default次序 — the容错 form the task spec calls for
// ("若 profile 有偏好则用、无则默认次序"). Profile tokens are translated to sequence steps
// via PROFILE_TOKEN_TO_STEP; an unknown token is skipped with a (non-silent) warning so a
// future profile typo surfaces instead of quietly shrinking the route.
export function resolveRoutePreference(
  profile: SubjectProfile,
  kind: string | null,
): readonly SourcingSequenceStep[] {
  const raw = (profile as { sourcingRoutePreference?: unknown }).sourcingRoutePreference;
  if (!raw || typeof raw !== 'object') return DEFAULT_SOURCING_ROUTE;
  // Shape: a map from 题型 key → ordered profile-token list. The map is keyed by the
  // profile SubjectQuestionKind ('reading_comprehension' / 'calculation'), but `kind`
  // arrives in canonical persisted form ('reading' / 'computation'). Translate to the
  // profile key (验证轮 A4: same single mapping) before the lookup so a canonical kind
  // resolves the profile's per-题型 route. Fall back to a '*' default entry, then the
  // hard-coded default.
  const byKind = raw as Record<string, unknown>;
  const profileKey: SubjectQuestionKind | null = kind ? questionKindToSkillKind(kind) : null;
  const candidate = (profileKey && byKind[profileKey]) || byKind['*'];
  if (!Array.isArray(candidate)) return DEFAULT_SOURCING_ROUTE;
  const steps: SourcingSequenceStep[] = [];
  for (const token of candidate) {
    if (typeof token !== 'string') continue;
    const step = PROFILE_TOKEN_TO_STEP[token];
    if (step === undefined) {
      console.warn(
        '[sourcing-sequence] unknown sourcingRoutePreference token; skipping',
        token,
        'for kind',
        kind ?? '(none)',
      );
      continue;
    }
    // Dedup adjacent duplicates (e.g. closed_book + variant both → closed_book) so the
    // tier-4 fallback isn't enqueued twice for one route.
    if (steps[steps.length - 1] !== step) steps.push(step);
  }
  return steps.length > 0 ? steps : DEFAULT_SOURCING_ROUTE;
}

// ── Async enqueue seam (DB-test injectable) ──────────────────────────────────

// The orchestrator enqueues background production jobs but never waits for them to
// ingest (B2). The default impl sends to the existing pg-boss queues (slice 2/3):
//   external_sourcing → 'sourcing'  (SourcingTask, tier 2)
//   material_grounded → 'quiz_gen'  (QuizGenTask PINNED to material_grounded, tier 3)
//   closed_book       → 'quiz_gen'  (QuizGenTask PINNED to closed_book, tier 4)
// F1 (PR #318 round-1): material_grounded vs closed_book both ride the quiz_gen queue,
// but the quiz_gen payload now carries an EXPLICIT generation_method so the worker
// knows WHICH of the two tiers the次序 asked for. Without it the agent free-chose the
// method (Tavily availability + prompt) and the次序's step 3 vs step 4 distinction was
// never actually executed. The orchestrator pins the method per step below.
export type EnqueueSequenceJobFn = (
  step: SourcingSequenceStep,
  data: {
    trigger: SourcingTrigger;
    ref_id: string;
    count?: number;
    // F1 — pinned generation_method for quiz_gen steps (material_grounded /
    // closed_book). Absent for external_sourcing (the sourcing queue has no method axis).
    generation_method?: 'material_grounded' | 'closed_book';
    // F3 — the knowledge node this need keys to. Forwarded so a manual trigger with a
    // free-form ref_id still attributes produced questions to the right node.
    knowledge_id?: string;
    // F4 (PR #318 round-4) — the 题型 hint this次序 selected. The route was chosen with
    // `kind` (resolveRoutePreference) but `kind` was then dropped; forward it so each
    // produced job (sourcing / quiz_gen) can target the题型. Additive — absent → no hint.
    kind?: string;
  },
) => Promise<void>;

// F1 — map a quiz_gen step to the generation_method it must pin. external_sourcing has
// no method axis (it rides the sourcing queue), so it maps to undefined.
function methodForStep(
  step: SourcingSequenceStep,
): 'material_grounded' | 'closed_book' | undefined {
  if (step === 'material_grounded') return 'material_grounded';
  if (step === 'closed_book') return 'closed_book';
  return undefined;
}

// Mirror the quiz_gen / sourcing trigger surface (knowledge / learning_item /
// manual). Kept local to avoid importing a handler module into core orchestration.
export const SOURCING_TRIGGERS = ['knowledge', 'learning_item', 'manual'] as const;
export type SourcingTrigger = (typeof SOURCING_TRIGGERS)[number];

function queueForStep(step: SourcingSequenceStep): 'sourcing' | 'quiz_gen' {
  return step === 'external_sourcing' ? 'sourcing' : 'quiz_gen';
}

async function defaultEnqueueSequenceJob(
  step: SourcingSequenceStep,
  data: {
    trigger: SourcingTrigger;
    ref_id: string;
    count?: number;
    generation_method?: 'material_grounded' | 'closed_book';
    knowledge_id?: string;
    kind?: string;
  },
): Promise<void> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  await boss.send(queueForStep(step), {
    trigger: data.trigger,
    ref_id: data.ref_id,
    ...(data.count !== undefined ? { count: data.count } : {}),
    // F1 — only quiz_gen steps carry a pinned method; the sourcing queue ignores it.
    ...(data.generation_method !== undefined ? { generation_method: data.generation_method } : {}),
    // F3 — forward the knowledge node for attribution (quiz_gen reads it for manual triggers).
    ...(data.knowledge_id !== undefined ? { knowledge_id: data.knowledge_id } : {}),
    // F4 — forward the 题型 hint so the produced job can target it (sourcing→kinds,
    // quiz_gen→kind). Both queue handlers read it additively.
    ...(data.kind !== undefined ? { kind: data.kind } : {}),
  });
}

// ── 验证轮 C: Tavily availability + route degradation ─────────────────────────

// The web-grounded steps: external_sourcing (tier 2, SourcingTask web search) and
// material_grounded (tier 3, must拉真原文 via tavily_extract). Both no-op without Tavily.
const TAVILY_DEPENDENT_STEPS: ReadonlySet<SourcingSequenceStep> = new Set([
  'external_sourcing',
  'material_grounded',
]);

// Reuse the worker's availability判定 verbatim: buildTavilyMcpServer() returns a config
// iff TAVILY_API_KEY is set (graceful no-op otherwise). Same single source the quiz_gen /
// sourcing handlers gate on — no second copy of the env logic here.
function defaultTavilyAvailable(): boolean {
  return buildTavilyMcpServer() !== null;
}

// Does the base route include any Tavily-dependent line? (drives the need[] annotation).
function routeUsesTavily(route: readonly SourcingSequenceStep[]): boolean {
  return route.some((step) => TAVILY_DEPENDENT_STEPS.has(step));
}

// Drop the Tavily-dependent steps; if that leaves the route empty (it wanted ONLY web
// lines), degrade to the tier-4 closed_book fallback (which needs no web fetch). Preserves
// any closed_book the base route already had, deduped.
function degradeRouteWithoutTavily(
  route: readonly SourcingSequenceStep[],
): readonly SourcingSequenceStep[] {
  const kept = route.filter((step) => !TAVILY_DEPENDENT_STEPS.has(step));
  return kept.length > 0 ? kept : ['closed_book'];
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
  // YUK-275 — free-text 求卷扩两个池查询维度. Both filter step-1 (existing pool) only;
  // they do NOT influence the background production route. Default null = 字节级不变.
  //   difficultyMin: only count questions whose difficulty >= n.
  //   unit='篇': only count composite parent questions (篇 = a multi-part 阅读 paper).
  difficultyMin?: number | null;
  unit?: '题' | '篇' | null;
  // Subject domain → resolves the profile (route preference + future whitelist).
  // When absent, resolveSubjectProfile falls back to the default subject.
  domain?: string | null;
  // DB-test seam.
  enqueueSequenceJob?: EnqueueSequenceJobFn;
  // 验证轮 C — test seam for the Tavily availability判定. Defaults to the SAME
  // buildTavilyMcpServer()-backed predicate the workers use (single judgment, no copy).
  tavilyAvailable?: () => boolean;
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
  // YUK-226 S2-5b (验证轮 B) — true when the knowledge node does not exist or is
  // archived. The orchestrator enqueued NOTHING and returns empty existing/needs; the
  // HTTP caller maps this to a 4xx (the route does), other consumers treat it as「no
  // questions, nothing in flight」. Absent/false on the normal path.
  knowledgeNodeMissing?: boolean;
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
  const kind = params.kind ?? null;
  // YUK-275 — the two free-text 求卷 pool-filter dimensions; default null (字节级不变).
  const difficultyMin = params.difficultyMin ?? null;
  const unit = params.unit ?? null;
  const enqueue = params.enqueueSequenceJob ?? defaultEnqueueSequenceJob;
  const isTavilyAvailable = params.tavilyAvailable ?? defaultTavilyAvailable;

  // 验证轮 B — pre-enqueue guard: resolve the node ONCE (existence + archive + domain).
  // A missing/archived node must not enqueue (the produced need would never resolve —
  // the worker-side anchor guard rejects archived anchors). Return empty + the
  // discriminator so the HTTP caller can 4xx and other consumers see「nothing found,
  // nothing in flight」.
  const node = await resolveLiveKnowledgeNode(db, knowledgeId);
  if (!node.exists) {
    return {
      existing: [],
      satisfiedFromPool: false,
      enqueued: [],
      needs: [],
      knowledgeNodeMissing: true,
    };
  }

  // Step 1 — synchronous existing-pool query (high tier first), kind-filtered (A2),
  // plus the YUK-275 difficulty-floor + 篇=composite-parent filters (default null = no-op).
  const existing = await queryExistingPool(db, knowledgeId, count, kind, difficultyMin, unit);
  if (existing.length >= count) {
    return { existing, satisfiedFromPool: true, enqueued: [], needs: [] };
  }

  // Steps 2-4 — enqueue background production in the profile's preference order.
  // F5 (PR #318 round-1): when the caller omits `domain`, resolve the subject from the
  // knowledge node's own domain instead of silently falling back to the default
  // subject. A 'knowledge' trigger keys off a real node, so its domain is the
  // authoritative subject for the route preference (a math node must not route through
  // the wenyan default profile). domain wins when explicitly passed.
  const resolvedDomain = params.domain ?? node.domain;
  const profile = resolveSubjectProfile(resolvedDomain);
  const baseRoute = resolveRoutePreference(profile, kind);

  // 验证轮 C — Tavily awareness: external_sourcing (tier 2) AND material_grounded (tier 3)
  // both lean on web fetch (SourcingTask searches the web; material_grounded must拉真原文).
  // When Tavily is unconfigured the worker-side buildTavilyMcpServer() returns null and
  // those steps degrade to closed_book ANYWAY — but enqueuing them first wastes a job and
  // produces a misleading need[]. Reuse the SAME availability判定 the worker uses (no
  // second copy) to skip them up front and degrade to a single closed_book line, recording
  // the degradation reason in the need[] for evidence留痕.
  const tavilyDown = !isTavilyAvailable();
  const route: readonly SourcingSequenceStep[] = tavilyDown
    ? degradeRouteWithoutTavily(baseRoute)
    : baseRoute;

  const enqueued: SourcingSequenceStep[] = [];
  const needs: SourcingNeed[] = [];
  for (const step of route) {
    await enqueue(step, {
      trigger,
      ref_id: refId,
      count,
      // F1 — pin the generation_method for quiz_gen steps so the worker executes the
      // requested tier (material_grounded vs closed_book) rather than free-choosing.
      ...(methodForStep(step) !== undefined ? { generation_method: methodForStep(step) } : {}),
      // F3 — forward the knowledge node so produced questions attribute to it even when
      // the trigger is manual with a free-form ref_id.
      knowledge_id: knowledgeId,
      // F4 — forward the 题型 hint that selected this route so the produced job can target
      // it. The route was chosen with this same kind; threading it through closes the gap
      // where kind drove选路 then vanished. Absent → no hint (agent free-targets).
      ...(kind ? { kind } : {}),
    });
    enqueued.push(step);
    needs.push({
      kind: 'question_generation',
      knowledge_id: knowledgeId,
      source: step,
      // 验证轮 C — the degradation suffix records WHY external/material lines were skipped
      // (evidence留痕). Only present when the route was actually degraded (Tavily down AND
      // the base route wanted a web line).
      reason: `existing pool had ${existing.length}/${count} active questions; enqueued ${step}${
        tavilyDown && routeUsesTavily(baseRoute)
          ? ' (Tavily unavailable: external_sourcing/material_grounded degraded to closed_book)'
          : ''
      }`,
    });
  }

  return { existing, satisfiedFromPool: false, enqueued, needs };
}
