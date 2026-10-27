// Copilot learner-state header (session-anchored, assemble-once).
//
// Deterministic (no-LLM) code-read projection — 今日 due count, 活跃 goal, top-2
// 误区, θ̂/mastery band, 昨夜交班摘要 — hard-capped at
// LEARNER_STATE_HEADER_BUDGET.maxChars (a char cap, not tokens; CJK near the ceiling
// can run ~400-1000 tokens).
//
// OWNER HARD CONSTRAINT (never regress): NO per-turn 装配注入. Assemble once per
// validity window, cache session-anchored, re-assemble only on cross-day, new
// attempt, overnight dreaming, or a proposal decision (accept/dismiss); the
// proposal_feedback digest folds into the same block.
//
// 防循环: it is a code read, never orchestrator output, and its cache event opts
// out of the mem0 outbox (the projection reads mem0-derived signals, so
// ingesting it back would be circular).

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { A5_BANDS, masteryBandView } from '@/core/mastery-band';
import type { LearnerJudgmentBatch } from '@/core/schema/learner-judgment';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { type WriteEventInput, writeEvent } from '@/kernel/events';
import {
  type ProposalFeedbackCell,
  getProposalFeedbackDigest,
} from '@/kernel/proposals/adaptive-bias';
import { listActiveGoalsWithResolvedScope } from '@/kernel/read-models/active-goal-scope';
import { effectiveCauseCategoryForFailureAttempt } from '@/kernel/read-models/cause-policy';
import type { FailureAttempt } from '@/kernel/read-models/failure-attempts';
import { getFailureAttempts } from '@/kernel/read-models/failure-attempts';
import { readLearnerJudgments } from '@/kernel/read-models/learner-judgment';
import type { MasteryProjection } from '@/kernel/read-models/mastery-projection';
import {
  LEARNER_STATE_HEADER_BUDGET,
  type LearnerStateHeaderBudget,
  PROPOSAL_FEEDBACK_BUDGET,
} from '@/kernel/tools/budgets';
import { type CopilotSummary, loadCopilotSummary } from './copilot-summary';
import { type LoadTodayOvernightDigest, readOvernightHandoffSentence } from './overnight-handoff';

type DbLike = Db | Tx;

// The session-anchored cache uses the same ExperimentalEvent escape hatch as
// other Copilot turn-state rows (no new schema). turns.ts replay only reads
// ask/chip/reply actions, so this action never pollutes the drawer.
export const LEARNER_STATE_HEADER_ACTION = 'experimental:copilot_learner_state_header';

// Recent failure attempts scanned when ranking the top-2 误区. Bounded — this only
// runs on (re)assembly, not per turn.
const FAILURE_SCAN_LIMIT = 40;

// ── Types ───────────────────────────────────────────────────────────────────

/** The cheap invalidation watermarks (ISO strings, null when the category has no
 *  events yet). Compared cached-vs-current to decide staleness. */
export interface LearnerStateWatermarks {
  attempt_at: string | null;
  /** Latest `experimental:dreaming_scan` (outcome='success') created_at. */
  dreaming_at: string | null;
  /** Latest `rate` event (proposal accept/dismiss decision) created_at. */
  proposal_decision_at: string | null;
}

/** The already-scoped proposal-feedback digest carried in the header block. */
export type ScopedProposalFeedbackCell = Pick<
  ProposalFeedbackCell,
  'kind' | 'relation' | 'acceptance_rate' | 'top_dismiss_reasons' | 'top_rubric_gates'
>;

export interface LearnerStateProjection {
  reviewDueCount: number;
  activeGoalTitle: string | null;
  topCauseCategories: string[];
  masterySummary: string | null;
  meanTheta: number | null;
  judgmentSentence?: string | null;
  overnightSentence: string | null;
}

/** The cached block (persisted in the header cache event payload). */
export interface LearnerStateHeaderCache {
  header_md: string;
  proposal_feedback: ScopedProposalFeedbackCell[];
  assembled_at: string;
  day_bucket: string;
  watermarks: LearnerStateWatermarks;
}

export type PersistedLearnerStateHeaderCache = LearnerStateHeaderCache & { session_id: string };

export interface LearnerStateHeader {
  header_md: string;
  proposal_feedback: ScopedProposalFeedbackCell[];
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

// The house cron domain (dreaming/coach) runs Asia/Shanghai; bucketing by UTC
// calendar day would fire the cross-day invalidation at Beijing 08:00 instead of
// local midnight. `en-CA` formats as YYYY-MM-DD.
const SHANGHAI_DAY_BUCKET_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Asia/Shanghai calendar-day bucket (YYYY-MM-DD) used for cross-day invalidation. */
export function dayBucket(d: Date): string {
  return SHANGHAI_DAY_BUCKET_FORMATTER.format(d);
}

// Is `current` strictly newer than `cached`? A null current means "no read" and
// never stales; a null cached with a real current means something appeared.
function watermarkAdvanced(cached: string | null, current: string | null): boolean {
  if (current === null) return false;
  if (cached === null) return true;
  return current > cached;
}

/**
 * Cheap invalidation predicate. The header is stale when the day rolled over OR
 * any watermark advanced (new attempt / dreaming ran / proposal decision).
 */
export function isLearnerStateHeaderStale(
  cached: { day_bucket: string; watermarks: LearnerStateWatermarks },
  current: { day_bucket: string; watermarks: LearnerStateWatermarks },
): boolean {
  if (cached.day_bucket !== current.day_bucket) return true;
  return (
    watermarkAdvanced(cached.watermarks.attempt_at, current.watermarks.attempt_at) ||
    watermarkAdvanced(cached.watermarks.dreaming_at, current.watermarks.dreaming_at) ||
    watermarkAdvanced(
      cached.watermarks.proposal_decision_at,
      current.watermarks.proposal_decision_at,
    )
  );
}

/**
 * Deterministic projection → header prose, hard-truncated to the size budget.
 * The due line is always present; the goal / 误区 / mastery / 交班 lines render
 * only when their data exists (cold start → a minimal, non-blank header).
 */
export function assembleLearnerStateHeaderMd(
  p: LearnerStateProjection,
  budget: LearnerStateHeaderBudget = LEARNER_STATE_HEADER_BUDGET,
): string {
  const lines: string[] = [`今日待复习 ${p.reviewDueCount} 项`];
  if (p.activeGoalTitle) lines.push(`当前目标：${p.activeGoalTitle}`);
  if (p.topCauseCategories.length > 0) {
    lines.push(`近期高频误区：${p.topCauseCategories.slice(0, 2).join('、')}`);
  }
  if (p.masterySummary) {
    const theta = p.meanTheta === null ? '' : `（θ̂≈${p.meanTheta.toFixed(1)}）`;
    lines.push(`掌握度：${p.masterySummary}${theta}`);
  }
  if (p.judgmentSentence) lines.push(p.judgmentSentence);
  if (p.overnightSentence) lines.push(`昨夜交班：${p.overnightSentence}`);
  const md = lines.join('\n');
  return md.length > budget.maxChars ? md.slice(0, budget.maxChars) : md;
}

// Copilot proposes ONLY knowledge_edge, so the digest is edge-scoped:
// reason-bearing cells first (they carry the failure mode Copilot learns most
// from; the digest is sorted acceptance DESC, so a naive tail-drop would discard
// them), then the serialized field is truncated to the whole-digest cap by
// dropping the least-actionable tail.
export function scopeCopilotProposalFeedback(
  digest: ProposalFeedbackCell[],
): ScopedProposalFeedbackCell[] {
  const edgeCells = digest
    .filter((cell) => cell.kind === 'knowledge_edge')
    .map((cell) => ({
      kind: cell.kind,
      relation: cell.relation,
      acceptance_rate: cell.acceptance_rate,
      top_dismiss_reasons: cell.top_dismiss_reasons,
      top_rubric_gates: cell.top_rubric_gates,
    }));
  const hasReasonContent = (c: (typeof edgeCells)[number]) =>
    c.top_dismiss_reasons.length > 0 || c.top_rubric_gates.length > 0;
  const ordered = [
    ...edgeCells.filter(hasReasonContent),
    ...edgeCells.filter((c) => !hasReasonContent(c)),
  ];
  const scoped = [...ordered];
  while (
    scoped.length > 0 &&
    JSON.stringify(scoped).length > PROPOSAL_FEEDBACK_BUDGET.maxSerializedChars
  ) {
    scoped.pop();
  }
  return scoped;
}

// ── Projection reads (IO; only run on (re)assembly) ──────────────────────────

function rankTopCauseCategories(failures: FailureAttempt[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const fa of failures) {
    const cause = effectiveCauseCategoryForFailureAttempt(fa);
    if (!cause) continue;
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([cause]) => cause);
}

function summarizeMastery(proj: Map<string, MasteryProjection>): {
  masterySummary: string | null;
  meanTheta: number | null;
} {
  const bandCounts = [0, 0, 0, 0];
  const thetas: number[] = [];
  for (const entry of proj.values()) {
    const view = masteryBandView(entry);
    if (view.unknown) continue;
    bandCounts[view.band] = (bandCounts[view.band] ?? 0) + 1;
    thetas.push(entry.theta_hat);
  }
  if (thetas.length === 0) return { masterySummary: null, meanTheta: null };
  // High → low band so the strongest mastery reads first.
  const parts: string[] = [];
  for (let b = A5_BANDS.length - 1; b >= 0; b -= 1) {
    if ((bandCounts[b] ?? 0) > 0) parts.push(`${A5_BANDS[b]}${bandCounts[b]}`);
  }
  const meanTheta = thetas.reduce((s, t) => s + t, 0) / thetas.length;
  return { masterySummary: parts.join(' '), meanTheta };
}

function summarizeJudgment(batch: LearnerJudgmentBatch): {
  masterySummary: string | null;
  meanTheta: number | null;
  judgmentSentence: string;
} {
  const observed = new Map<string, MasteryProjection>();
  let unknownAbility = false;
  let unknownRetention = false;
  const readingEngines = new Set<string>();
  for (const item of batch.items) {
    if (item.ability.kind === 'available' && item.p_correct_now.kind === 'incumbent_pfa') {
      observed.set(item.knowledge_id, item.ability.reading);
    } else {
      unknownAbility = true;
    }
    if (
      item.retention.kind === 'unknown' ||
      (typeof item.retention.reading !== 'number' && item.retention.reading.kind === 'unknown')
    ) {
      unknownRetention = true;
    }
    if (item.retention.kind === 'available') readingEngines.add(item.retention.engine);
  }
  const engineName =
    readingEngines.size !== 1 || readingEngines.has('unknown')
      ? '实际引擎混合或未知'
      : readingEngines.has('fsrs')
        ? 'FSRS'
        : '候选遗忘引擎';
  return {
    ...summarizeMastery(observed),
    judgmentSentence: [
      `共用判断 ${batch.version}：尚未个人校准。`,
      unknownAbility ? '部分掌握状态未知；关联推断不算本人作答证据。' : '',
      unknownRetention
        ? `保持：同范围存在未知项（${engineName}），不能据此断言记得或忘了。`
        : `保持：同范围现役读数可用（${engineName}），尚不能据此声称已校准或保持良好。`,
      '只作文字解读，不向学习者新增预测数字。',
    ].join(''),
  };
}

/** IO dependencies for the projection read. */
export interface ReadProjectionDeps {
  loadCopilotSummaryFn?: (db: DbLike) => Promise<CopilotSummary>;
  loadOvernightDigestFn?: LoadTodayOvernightDigest;
  listActiveGoalsFn?: (db: DbLike) => Promise<{ title: string; scope_knowledge_ids: string[] }[]>;
  getFailureAttemptsFn?: (db: DbLike) => Promise<FailureAttempt[]>;
  getMasteryProjectionFn?: (db: DbLike, ids: string[]) => Promise<Map<string, MasteryProjection>>;
}

export async function readLearnerStateProjection(
  db: DbLike,
  deps: ReadProjectionDeps = {},
): Promise<LearnerStateProjection> {
  const loadSummary = deps.loadCopilotSummaryFn ?? ((d: DbLike) => loadCopilotSummary(d));
  const loadOvernightDigest = deps.loadOvernightDigestFn;
  // Resolved read: the default is only invoked with the outer Db (call site below);
  // the DbLike dep shape stays for fakes, hence the narrow cast.
  const loadGoals =
    deps.listActiveGoalsFn ?? ((d: DbLike) => listActiveGoalsWithResolvedScope(d as Db));
  const loadFailures =
    deps.getFailureAttemptsFn ??
    ((d: DbLike) => getFailureAttempts(d, { limit: FAILURE_SCAN_LIMIT }));

  const overnightSentencePromise = readOvernightHandoffSentence(db, loadOvernightDigest);
  const [summary, goals, failures, overnightSentence] = await Promise.all([
    loadSummary(db),
    loadGoals(db),
    loadFailures(db),
    overnightSentencePromise,
  ]);
  const activeGoal = goals[0] ?? null;
  const topCauseCategories = rankTopCauseCategories(failures, 2);

  const scopeKcs = activeGoal?.scope_knowledge_ids ?? [];
  let masterySummary: string | null = null;
  let meanTheta: number | null = null;
  let judgmentSentence: string | null = null;
  if (scopeKcs.length > 0) {
    const judgment = await readLearnerJudgments(
      db,
      { knowledge_ids: scopeKcs, context: 'any', as_of: new Date() },
      { getMasteryProjectionFn: deps.getMasteryProjectionFn },
    );
    ({ masterySummary, meanTheta, judgmentSentence } = summarizeJudgment(judgment));
  }

  return {
    reviewDueCount: summary.review_due_count,
    activeGoalTitle: activeGoal?.title ?? null,
    topCauseCategories,
    masterySummary,
    meanTheta,
    judgmentSentence,
    overnightSentence,
  };
}

// ── Cache + watermark reads (IO) ─────────────────────────────────────────────

// Pick whichever ISO timestamp is more recent; null is "no signal" and loses to
// any real timestamp. Both inputs are 'Z'-suffixed UTC ISO strings, so
// lexicographic comparison agrees with chronological order.
function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/** One grouped MAX(created_at) query for the four invalidation categories
 *  (attempt + review folded together — see readLearnerStateWatermarks). */
export async function readLearnerStateWatermarks(db: DbLike): Promise<LearnerStateWatermarks> {
  const rows = await db
    .select({
      action: event.action,
      max_at: sql<Date>`max(${event.created_at})`,
    })
    .from(event)
    .where(
      or(
        eq(event.action, 'attempt'),
        eq(event.action, 'experimental:assessment_attempt'),
        eq(event.action, 'experimental:assessment_activation'),
        eq(event.action, 'experimental:assessment_settlement'),
        eq(event.action, 'correct'),
        // The FSRS review-queue clearing write (src/capabilities/practice/api/submit.ts)
        // uses a DISTINCT action='review', not 'attempt'. It directly moves
        // review_due_count (the header's "今日待复习" headline), so a pure-review
        // session with no fresh 'attempt' rows must still trip the invalidation —
        // folded into attempt_at below.
        eq(event.action, 'review'),
        and(eq(event.action, 'experimental:dreaming_scan'), eq(event.outcome, 'success')),
        eq(event.action, 'rate'),
      ),
    )
    .groupBy(event.action);
  const byAction = new Map(rows.map((r) => [r.action, r.max_at]));
  const iso = (action: string): string | null => {
    const at = byAction.get(action);
    return at ? new Date(at).toISOString() : null;
  };
  return {
    // Fold 'review' into attempt_at: "new attempt event" invalidation means "new
    // practice activity", and FSRS review is practice activity (distinct action,
    // same intent). Folding keeps the three-field watermark shape; this is a
    // same-intent union, not a new invalidation category.
    attempt_at: [
      'attempt',
      'review',
      'experimental:assessment_attempt',
      'experimental:assessment_activation',
      'experimental:assessment_settlement',
      'correct',
    ].reduce<string | null>((latest, action) => maxIso(latest, iso(action)), null),
    dreaming_at: iso('experimental:dreaming_scan'),
    proposal_decision_at: iso('rate'),
  };
}

// Persisted cache rows may predate a schema shift or be corrupt; a blind cast
// would let a malformed cell crash a downstream `.top_dismiss_reasons.length`
// read. Filter bad cells per cell — one corrupt cell must not sink the whole
// cached digest.
function isValidScopedProposalFeedbackCell(v: unknown): v is ScopedProposalFeedbackCell {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.kind === 'string' &&
    (c.relation === null || typeof c.relation === 'string') &&
    typeof c.acceptance_rate === 'number' &&
    Array.isArray(c.top_dismiss_reasons) &&
    c.top_dismiss_reasons.every((r) => typeof r === 'string') &&
    Array.isArray(c.top_rubric_gates) &&
    c.top_rubric_gates.every((g) => typeof g === 'string')
  );
}

function parseCache(payload: Record<string, unknown>): LearnerStateHeaderCache | null {
  const headerMd = payload.header_md;
  const dayBucketVal = payload.day_bucket;
  const assembledAt = payload.assembled_at;
  const wmRaw = payload.watermarks as Record<string, unknown> | undefined;
  if (typeof headerMd !== 'string' || typeof dayBucketVal !== 'string') return null;
  if (typeof assembledAt !== 'string' || !wmRaw || typeof wmRaw !== 'object') return null;
  const wmField = (k: string): string | null =>
    typeof wmRaw[k] === 'string' ? (wmRaw[k] as string) : null;
  const pf = Array.isArray(payload.proposal_feedback)
    ? payload.proposal_feedback.filter(isValidScopedProposalFeedbackCell)
    : [];
  return {
    header_md: headerMd,
    proposal_feedback: pf,
    assembled_at: assembledAt,
    day_bucket: dayBucketVal,
    watermarks: {
      attempt_at: wmField('attempt_at'),
      dreaming_at: wmField('dreaming_at'),
      proposal_decision_at: wmField('proposal_decision_at'),
    },
  };
}

/** Latest header cache row for the session (newest wins); null when none. */
export async function readLatestLearnerStateHeaderCache(
  db: DbLike,
  sessionId: string,
): Promise<LearnerStateHeaderCache | null> {
  const rows = await db
    .select({ payload: event.payload, id: event.id, created_at: event.created_at })
    .from(event)
    .where(and(eq(event.session_id, sessionId), eq(event.action, LEARNER_STATE_HEADER_ACTION)))
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return parseCache((row.payload ?? {}) as Record<string, unknown>);
}

/** Persist a (re)assembled cache row. `ingest_at` opt-out keeps it out of mem0. */
export async function writeLearnerStateHeaderCache(
  db: DbLike,
  cache: PersistedLearnerStateHeaderCache,
  now: Date,
  writeFn: (db: DbLike, input: WriteEventInput) => Promise<string> = writeEvent,
): Promise<void> {
  const id = `copilot_learner_state_${createId()}`;
  await writeFn(db, {
    id,
    session_id: cache.session_id,
    actor_kind: 'system',
    actor_ref: 'system:copilot_learner_state',
    action: LEARNER_STATE_HEADER_ACTION,
    subject_kind: 'query',
    subject_id: id,
    outcome: null,
    payload: {
      session_id: cache.session_id,
      header_md: cache.header_md,
      proposal_feedback: cache.proposal_feedback,
      assembled_at: cache.assembled_at,
      day_bucket: cache.day_bucket,
      watermarks: cache.watermarks,
    },
    // Opt out of the mem0 outbox — the header is a deterministic projection
    // DERIVED FROM mem0 signals, so ingesting it would be circular.
    ingest_at: now,
    created_at: now,
  });
}

// ── Resolver (orchestration; injectable sub-seams) ──────────────────────────

export interface ResolveLearnerStateHeaderDeps {
  readCacheFn?: (db: DbLike, sessionId: string) => Promise<LearnerStateHeaderCache | null>;
  readWatermarksFn?: (db: DbLike) => Promise<LearnerStateWatermarks>;
  readProjectionFn?: (db: DbLike) => Promise<LearnerStateProjection>;
  loadProposalFeedbackFn?: (db: DbLike) => Promise<ProposalFeedbackCell[]>;
  writeCacheFn?: (db: DbLike, cache: PersistedLearnerStateHeaderCache) => Promise<void>;
  now?: () => Date;
}

const EMPTY_HEADER: LearnerStateHeader = { header_md: '', proposal_feedback: [] };

/**
 * Resolve the session-anchored learner-state header: read the cache and current
 * watermarks (cheap), reuse a fresh cache with NO reassembly (the owner's hard
 * constraint), else (re)assemble the projection + scoped digest, persist a new
 * cache row, and return it. Any read failure degrades to a stale cache (if any)
 * or an empty header, never crashing the chat.
 *
 * Cache and watermark reads degrade independently:
 *   - cache read fails → treated as `cached=null`; the flow continues with a full
 *     reassembly using whatever watermarks it got.
 *   - watermark read fails → staleness cannot be judged, so return
 *     `cached ?? EMPTY_HEADER` immediately (a stale cache beats no cache).
 */
export async function resolveLearnerStateHeader(
  db: DbLike,
  sessionId: string,
  deps: ResolveLearnerStateHeaderDeps = {},
): Promise<LearnerStateHeader> {
  const now = deps.now?.() ?? new Date();
  const readCache = deps.readCacheFn ?? readLatestLearnerStateHeaderCache;
  const readWatermarks = deps.readWatermarksFn ?? readLearnerStateWatermarks;
  const readProjection = deps.readProjectionFn ?? readLearnerStateProjection;
  const loadFeedback =
    deps.loadProposalFeedbackFn ??
    ((d: DbLike) => getProposalFeedbackDigest(d, PROPOSAL_FEEDBACK_BUDGET));
  const writeCache =
    deps.writeCacheFn ??
    ((d: DbLike, cache: PersistedLearnerStateHeaderCache) =>
      writeLearnerStateHeaderCache(d, cache, now));

  const dayBucketNow = dayBucket(now);

  // Independent settle, not a shared try/catch: one read failing must not discard
  // the other's already-resolved result.
  const [cacheResult, watermarksResult] = await Promise.allSettled([
    readCache(db, sessionId),
    readWatermarks(db),
  ]);

  let cached: LearnerStateHeaderCache | null = null;
  if (cacheResult.status === 'fulfilled') {
    cached = cacheResult.value;
  } else {
    console.error('[resolveLearnerStateHeader] cache read failed; degrading to no cache', {
      session_id: sessionId,
      err: cacheResult.reason,
    });
  }

  if (watermarksResult.status === 'rejected') {
    console.error(
      '[resolveLearnerStateHeader] watermark read failed; degrading to cached (if any)',
      { session_id: sessionId, err: watermarksResult.reason },
    );
    return cached
      ? { header_md: cached.header_md, proposal_feedback: cached.proposal_feedback }
      : EMPTY_HEADER;
  }
  const currentWatermarks = watermarksResult.value;

  if (
    cached &&
    !isLearnerStateHeaderStale(
      { day_bucket: cached.day_bucket, watermarks: cached.watermarks },
      { day_bucket: dayBucketNow, watermarks: currentWatermarks },
    )
  ) {
    return { header_md: cached.header_md, proposal_feedback: cached.proposal_feedback };
  }

  try {
    const [projection, rawFeedback] = await Promise.all([readProjection(db), loadFeedback(db)]);
    const proposal_feedback = scopeCopilotProposalFeedback(rawFeedback);
    const header_md = assembleLearnerStateHeaderMd(projection);
    const persisted: PersistedLearnerStateHeaderCache = {
      session_id: sessionId,
      header_md,
      proposal_feedback,
      assembled_at: now.toISOString(),
      day_bucket: dayBucketNow,
      watermarks: currentWatermarks,
    };
    try {
      await writeCache(db, persisted);
    } catch (err) {
      console.error('[resolveLearnerStateHeader] cache write failed; using fresh header anyway', {
        session_id: sessionId,
        err,
      });
    }
    return { header_md, proposal_feedback };
  } catch (err) {
    console.error('[resolveLearnerStateHeader] assembly failed; degrading', {
      session_id: sessionId,
      err,
    });
    return cached
      ? { header_md: cached.header_md, proposal_feedback: cached.proposal_feedback }
      : EMPTY_HEADER;
  }
}
