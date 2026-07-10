// YUK-574 — Copilot learner-state header (session-anchored, assemble-once).
//
// The Copilot free-form run input carries a learner-state HEADER: a deterministic
// (no-LLM) code-read projection of the learner's current state — 今日 due count +
// 活跃 goal + top-2 误区 + θ̂/mastery band 一行 + 昨夜交班一句话摘要. Depth is left
// to the model's DomainTools; the header is a short teaser, hard-capped at
// LEARNER_STATE_HEADER_BUDGET.maxChars (400 chars — a char cap, not a token count;
// CJK content near that ceiling runs ~400-1000 tokens for Claude-family
// tokenizers, though the typical 5-line snapshot sits well below the cap).
//
// OWNER HARD CONSTRAINT (never regress): NO per-turn 装配注入. The real cost of
// re-projecting every turn = 注意力污染 + 天级数据被 turn 级重发. So the header is
// ASSEMBLED ONCE per validity window and cached session-anchored; subsequent turns
// reuse the cached bytes (they ride pinned in conversation_history, which is
// re-sent in full anyway). Re-assembly happens ONLY on a cheap invalidation:
// cross-day, a new attempt event, dreaming ran overnight, or a proposal decision
// (accept/dismiss). The invalidation check is a cheap timestamp-comparison query.
//
// Facet A (YUK-174) migration: the per-turn `proposal_feedback` digest folds into
// THIS session-anchored block under the SAME invalidation rules (proposal decision
// events are its dedicated refresh trigger). Its in-context-learning semantics are
// unchanged (same scoped cell shape) — only the injection CADENCE moves from
// per-turn to session-anchored, which is byte-identical between proposal decisions.
//
// 防循环 red line (ADR-0039 / YUK-267): the header is a deterministic code read,
// never orchestrator output, and its cache event is written with `ingest_at` set
// so the mem0 outbox NEVER ingests it — the projection reads mem0-derived signals
// (the memory brief), so ingesting the header back would be circular injection.

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, or, sql } from 'drizzle-orm';

import { listActiveGoalsWithResolvedScope } from '@/capabilities/agency/server/goals/queries';
// PR #717 round-2 CodeRabbit fix #2 (YUK-574) — imports from src/core/ (RELOCATED
// from knowledge/ui/mastery-band.ts; see the provenance note in that file). Pure
// dependency-free band-derivation helpers, no cross-capability / cross-layer reach.
import { A5_BANDS, masteryBandView } from '@/core/mastery-band';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import {
  LEARNER_STATE_HEADER_BUDGET,
  type LearnerStateHeaderBudget,
  PROPOSAL_FEEDBACK_BUDGET,
} from '@/server/ai/tools/budgets';
import { effectiveCauseCategoryForFailureAttempt } from '@/server/events/cause-policy';
import {
  type FailureAttempt,
  type WriteEventInput,
  getFailureAttempts,
  writeEvent,
} from '@/server/events/queries';
import { type MasteryProjection, getMasteryProjection } from '@/server/mastery/state';
import {
  type ProposalFeedbackCell,
  getProposalFeedbackDigest,
} from '@/server/proposals/adaptive-bias';
import { type CopilotSummary, loadCopilotSummary } from '@/server/today/copilot-summary';

type DbLike = Db | Tx;

// The session-anchored cache is persisted via the SAME ExperimentalEvent escape
// hatch every other Copilot turn-state row uses (no new schema). turns.ts replay
// only reads ask/chip/reply actions, so this action never pollutes the drawer.
export const LEARNER_STATE_HEADER_ACTION = 'experimental:copilot_learner_state_header';

// How many recent failure attempts to scan when ranking the top-2 误区. Bounded —
// this only runs on (re)assembly, not per turn.
const FAILURE_SCAN_LIMIT = 40;

// ── Types ───────────────────────────────────────────────────────────────────

/** The cheap invalidation watermarks (ISO strings, null when the category has no
 *  events yet). Compared cached-vs-current to decide staleness. */
export interface LearnerStateWatermarks {
  /** Latest `attempt` event created_at. */
  attempt_at: string | null;
  /** Latest `experimental:dreaming_scan` (outcome='success') created_at. */
  dreaming_at: string | null;
  /** Latest `rate` event (proposal accept/dismiss decision) created_at. */
  proposal_decision_at: string | null;
}

/** The already-scoped Facet A digest shape carried in the header block. */
export type ScopedProposalFeedbackCell = Pick<
  ProposalFeedbackCell,
  'kind' | 'relation' | 'acceptance_rate' | 'top_dismiss_reasons' | 'top_rubric_gates'
>;

/** The deterministic projection inputs assembled from the read sources. */
export interface LearnerStateProjection {
  reviewDueCount: number;
  activeGoalTitle: string | null;
  topCauseCategories: string[];
  masterySummary: string | null;
  meanTheta: number | null;
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

/** Persisted form: the cache + its owning conversation session id. */
export type PersistedLearnerStateHeaderCache = LearnerStateHeaderCache & { session_id: string };

/** What the resolver hands back to the run-input assembly. */
export interface LearnerStateHeader {
  header_md: string;
  proposal_feedback: ScopedProposalFeedbackCell[];
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

// Review-verdict fix #2 (MINOR) — the house cron domain (dreaming/coach) runs
// Asia/Shanghai; bucketing by UTC calendar day fires the cross-day invalidation
// at Beijing 08:00 instead of local midnight. `en-CA` formats as YYYY-MM-DD.
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

// Is `current` strictly newer than `cached`? Null cached + non-null current =
// newer (something appeared). A watermark going null→ (or set→null) never stales
// (events do not vanish; a null current just means "no read" and is ignored).
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

/** First sentence (up to the first 。/！/？/newline) of a markdown blob, trimmed. */
function firstSentence(md: string | null, maxLen: number): string | null {
  if (!md) return null;
  const flat = md.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  const cut = flat.search(/[。！？\n]/);
  const sentence = cut >= 0 ? flat.slice(0, cut + 1) : flat;
  return sentence.slice(0, maxLen).trim() || null;
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
  if (p.overnightSentence) lines.push(`昨夜交班：${p.overnightSentence}`);
  const md = lines.join('\n');
  return md.length > budget.maxChars ? md.slice(0, budget.maxChars) : md;
}

// P5.4-L2 / YUK-174 (Facet A) — Copilot proposes ONLY knowledge_edge, so the
// digest is edge-scoped: reason-bearing cells FIRST (they carry the failure mode
// Copilot learns most from; the digest is sorted acceptance DESC so a naive
// tail-drop would discard them), then the SERIALIZED field is truncated to the
// whole-digest cap by dropping the least-actionable tail. Moved here from chat.ts
// so the header assembly owns the migrated per-turn digest (folded into the same
// session-anchored block).
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

/** IO dependencies for the projection read (injected in tests). */
export interface ReadProjectionDeps {
  loadCopilotSummaryFn?: (db: DbLike) => Promise<CopilotSummary>;
  listActiveGoalsFn?: (db: DbLike) => Promise<{ title: string; scope_knowledge_ids: string[] }[]>;
  getFailureAttemptsFn?: (db: DbLike) => Promise<FailureAttempt[]>;
  getMasteryProjectionFn?: (db: DbLike, ids: string[]) => Promise<Map<string, MasteryProjection>>;
}

export async function readLearnerStateProjection(
  db: DbLike,
  deps: ReadProjectionDeps = {},
): Promise<LearnerStateProjection> {
  const loadSummary = deps.loadCopilotSummaryFn ?? ((d: DbLike) => loadCopilotSummary(d));
  // YUK-603 — resolved read. The default is only ever invoked with the outer Db (call site
  // below); the DbLike dep shape stays for test fakes, hence the narrow cast.
  const loadGoals =
    deps.listActiveGoalsFn ?? ((d: DbLike) => listActiveGoalsWithResolvedScope(d as Db));
  const loadFailures =
    deps.getFailureAttemptsFn ??
    ((d: DbLike) => getFailureAttempts(d, { limit: FAILURE_SCAN_LIMIT }));
  const loadMastery =
    deps.getMasteryProjectionFn ??
    ((d: DbLike, ids: string[]) => getMasteryProjection(d as Db, ids));

  const [summary, goals, failures] = await Promise.all([
    loadSummary(db),
    loadGoals(db),
    loadFailures(db),
  ]);
  const activeGoal = goals[0] ?? null;
  const topCauseCategories = rankTopCauseCategories(failures, 2);

  const scopeKcs = activeGoal?.scope_knowledge_ids ?? [];
  let masterySummary: string | null = null;
  let meanTheta: number | null = null;
  if (scopeKcs.length > 0) {
    const proj = await loadMastery(db, scopeKcs);
    ({ masterySummary, meanTheta } = summarizeMastery(proj));
  }

  // No dedicated YUK-520 "交班缕" read point exists yet; the global memory-brief
  // gestalt (which dreaming/coach feed nightly) is the closest overnight digest.
  // Gate on dreaming having run so the sentence reads as a genuine 交班. (Follow-up:
  // a dedicated dreaming 交班 read point when YUK-520 lands one.)
  const overnightSentence = summary.dreaming_last_run_at
    ? firstSentence(summary.brief_global_md, 120)
    : null;

  return {
    reviewDueCount: summary.review_due_count,
    activeGoalTitle: activeGoal?.title ?? null,
    topCauseCategories,
    masterySummary,
    meanTheta,
    overnightSentence,
  };
}

// ── Cache + watermark reads (IO) ─────────────────────────────────────────────

// Review-verdict fix #1 (MAJOR) — pick whichever ISO timestamp is more recent;
// null is "no signal" and loses to any real timestamp. Both inputs are ISO
// strings from the SAME `new Date().toISOString()` format (always 'Z'-suffixed
// UTC), so lexicographic string comparison agrees with chronological order.
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
        // Review-verdict fix #1 (MAJOR) — the FSRS review-queue clearing write
        // (src/capabilities/practice/api/submit.ts) uses a DISTINCT action='review',
        // NOT 'attempt'. It directly moves review_due_count (the header's "今日
        // 待复习" headline), so a pure-review session (no fresh 'attempt' rows)
        // must still trip the invalidation — folded into attempt_at below.
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
    // Fold 'review' into attempt_at: the issue's "new attempt event" invalidation
    // intent means "new practice activity", and FSRS review IS practice activity
    // (a distinct action, same intent) — folding (vs. a 5th named watermark) keeps
    // the invalidation-category shape unchanged (still 3 named fields) since this
    // is a same-intent union, not a new invalidation category.
    attempt_at: maxIso(iso('attempt'), iso('review')),
    dreaming_at: iso('experimental:dreaming_scan'),
    proposal_decision_at: iso('rate'),
  };
}

// PR #717 bot review fix #2 (MINOR) — a persisted cache row may predate a
// schema shift (or otherwise be corrupt); a blind cast let a malformed cell
// through and would crash a downstream `.top_dismiss_reasons.length` read.
// Per-cell type guard: FILTER bad cells out rather than rejecting the whole
// payload (one corrupt cell must not sink the entire cached digest).
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
    // ADR-0039 / YUK-267 red line: opt out of the mem0 outbox — the header is a
    // deterministic projection DERIVED FROM mem0 signals; ingesting it is circular.
    ingest_at: now,
    created_at: now,
  });
}

// ── Resolver (orchestration; injectable sub-seams for unit tests) ────────────

export interface ResolveLearnerStateHeaderDeps {
  readCacheFn?: (db: DbLike, sessionId: string) => Promise<LearnerStateHeaderCache | null>;
  // PR #717 bot review fix #3 (MINOR) — the real readLearnerStateWatermarks(db)
  // takes only `db`; a `now` second parameter here was misleading (silently
  // dropped at every call site). dayBucket(now) is computed separately by the
  // resolver itself, not through this seam.
  readWatermarksFn?: (db: DbLike) => Promise<LearnerStateWatermarks>;
  // PR #717 round-2 OCR fix #3 (MINOR) — same phantom-parameter shape as fix #3
  // above: readLearnerStateProjection(db) takes only `db` (its projection reads —
  // due count / goal / mistakes / mastery / overnight — are not time-parameterized
  // themselves; `now` only matters for the resolver's OWN dayBucket/cache-timestamp
  // bookkeeping, done separately). `now` here was silently dropped at the call site.
  readProjectionFn?: (db: DbLike) => Promise<LearnerStateProjection>;
  loadProposalFeedbackFn?: (db: DbLike) => Promise<ProposalFeedbackCell[]>;
  writeCacheFn?: (db: DbLike, cache: PersistedLearnerStateHeaderCache) => Promise<void>;
  now?: () => Date;
}

const EMPTY_HEADER: LearnerStateHeader = { header_md: '', proposal_feedback: [] };

/**
 * Resolve the session-anchored learner-state header: read the cache + current
 * watermarks (cheap), reuse the cache when fresh (NO reassembly — the owner's
 * hard constraint), else (re)assemble the projection + scoped digest, persist a
 * new cache row, and return it. Additive-input red line: any read failure
 * degrades to a stale cache (if any) or an empty header, never crashing the chat.
 *
 * PR #717 bot review fix #1 (MAJOR) — the cache read and the watermark read
 * degrade INDEPENDENTLY (they used to be coupled in one Promise.all, so a
 * watermark-read failure discarded an already-resolved cache and returned
 * EMPTY_HEADER even when a perfectly good cache existed):
 *   - cache read fails  → treated as `cached=null` (cold-start shape); the flow
 *     CONTINUES and attempts a full reassembly using whatever watermarks it did get.
 *   - watermark read fails → we cannot judge staleness at all, so we return
 *     `cached ?? EMPTY_HEADER` immediately (stale cache beats no cache).
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

  // Independent settle (NOT a shared try/catch) — one read failing must not
  // discard the other's already-resolved result (the coupling bug fixed here).
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
