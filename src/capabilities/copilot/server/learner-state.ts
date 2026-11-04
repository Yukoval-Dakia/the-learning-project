// Copilot learner-state header (session-anchored, assemble-once).
//
// The startup segment itself is assembled by the unified Context module
// (agency/context, reached through the kernel learner-context port) — this file
// keeps only the Copilot-side session-anchored delivery: validity watermarks,
// cache row read/write, and degrade policy.
//
// OWNER HARD CONSTRAINT (never regress): NO per-turn 装配注入. Assemble once per
// validity window, cache session-anchored, re-assemble only on cross-day, new
// attempt, overnight dreaming, proposal decision (accept/dismiss), or a Steering
// (goal) change; the proposal_feedback digest folds into the same block.
//
// 防循环: it is a code read, never orchestrator output, and its cache event opts
// out of the mem0 outbox (the projection reads mem0-derived signals, so
// ingesting it back would be circular).

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { type WriteEventInput, writeEvent } from '@/kernel/events';
import { HostOperationNotInstalledError } from '@/kernel/host-operation';
import {
  type ProposalFeedbackCell,
  getProposalFeedbackDigest,
} from '@/kernel/proposals/adaptive-bias';
import { LEARNER_ANSWER_ACTIONS } from '@/kernel/read-models/learner-activity';
import { loadLearnerContext } from '@/kernel/read-models/learner-context';
import { PURPOSE_CHANGE_ACTION } from '@/kernel/read-models/purpose-change';
import { PROPOSAL_FEEDBACK_BUDGET } from '@/kernel/tools/budgets';

type DbLike = Db | Tx;

// The session-anchored cache uses the same ExperimentalEvent escape hatch as
// other Copilot turn-state rows (no new schema). turns.ts replay only reads
// ask/chip/reply actions, so this action never pollutes the drawer.
export const LEARNER_STATE_HEADER_ACTION = 'experimental:copilot_learner_state_header';

// ── Types ───────────────────────────────────────────────────────────────────

/** The cheap invalidation watermarks (ISO strings, null when the category has no
 *  events yet). Compared cached-vs-current to decide staleness. */
export interface LearnerStateWatermarks {
  attempt_at: string | null;
  /** Latest `experimental:dreaming_scan` (outcome='success') created_at. */
  dreaming_at: string | null;
  /** Latest `rate` event (proposal accept/dismiss decision) created_at. */
  proposal_decision_at: string | null;
  /** Latest goal write (genesis/status/scope) created_at — steering changes
   * refresh the header's steering lines the next turn (YUK-1770). */
  goal_at: string | null;
  /** Latest source-purpose change: a withdrawn source must leave a cached header next turn. */
  purpose_change_at: string | null;
}

/** The already-scoped proposal-feedback digest carried in the header block. */
export type ScopedProposalFeedbackCell = Pick<
  ProposalFeedbackCell,
  'kind' | 'relation' | 'acceptance_rate' | 'top_dismiss_reasons' | 'top_rubric_gates'
>;

/** 启动段裁剪遥测：只有单元名与 token 数，不记内容。 */
export interface StartupTrimRecord {
  dropped_units: string[];
  tokens_before: number;
  tokens_after: number;
}

/** The cached block (persisted in the header cache event payload). */
export interface LearnerStateHeaderCache {
  header_md: string;
  proposal_feedback: ScopedProposalFeedbackCell[];
  assembled_at: string;
  day_bucket: string;
  watermarks: LearnerStateWatermarks;
  /** 本次装配的裁剪遥测（无裁剪时 dropped_units 为空数组，如实记录）。 */
  startup_trim?: StartupTrimRecord;
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
 * any watermark advanced (new attempt / dreaming ran / proposal decision /
 * Steering change).
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
    ) ||
    watermarkAdvanced(cached.watermarks.goal_at, current.watermarks.goal_at) ||
    watermarkAdvanced(cached.watermarks.purpose_change_at, current.watermarks.purpose_change_at)
  );
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

// ── Cache + watermark reads (IO) ─────────────────────────────────────────────

// Pick whichever ISO timestamp is more recent; null is "no signal" and loses to
// any real timestamp. Both inputs are 'Z'-suffixed UTC ISO strings, so
// lexicographic comparison agrees with chronological order.
function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

// "New practice activity" for header invalidation: any learner answer, plus the
// native grading lifecycle and corrections, all folded into attempt_at.
const PRACTICE_WATERMARK_ACTIONS = [
  ...LEARNER_ANSWER_ACTIONS,
  'experimental:assessment_activation',
  'experimental:assessment_settlement',
  'correct',
] as const;

// YUK-1770 — goal writes that refresh the header (steering create/revise/end;
// ordinary goal writes also advance the watermark, which is harmless: the
// projection only re-assembles and renders the same lines).
const GOAL_WRITE_WATERMARK_ACTIONS = [
  'experimental:genesis',
  'experimental:goal_status_update',
  'experimental:goal_scope_update',
] as const;

/** One grouped MAX(created_at) query for the three invalidation categories. */
export async function readLearnerStateWatermarks(db: DbLike): Promise<LearnerStateWatermarks> {
  const rows = await db
    .select({
      action: event.action,
      max_at: sql<Date>`max(${event.created_at})`,
    })
    .from(event)
    .where(
      or(
        inArray(event.action, [...PRACTICE_WATERMARK_ACTIONS]),
        and(eq(event.action, 'experimental:dreaming_scan'), eq(event.outcome, 'success')),
        eq(event.action, 'rate'),
        eq(event.action, 'experimental:context_change'),
        eq(event.action, PURPOSE_CHANGE_ACTION),
        and(
          inArray(event.action, [...GOAL_WRITE_WATERMARK_ACTIONS]),
          eq(event.subject_kind, 'goal'),
        ),
      ),
    )
    .groupBy(event.action);
  const byAction = new Map(rows.map((r) => [r.action, r.max_at]));
  const iso = (action: string): string | null => {
    const at = byAction.get(action);
    return at ? new Date(at).toISOString() : null;
  };
  return {
    attempt_at: PRACTICE_WATERMARK_ACTIONS.reduce<string | null>(
      (latest, action) => maxIso(latest, iso(action)),
      null,
    ),
    dreaming_at: maxIso(iso('experimental:dreaming_scan'), iso('experimental:context_change')),
    proposal_decision_at: iso('rate'),
    goal_at: GOAL_WRITE_WATERMARK_ACTIONS.reduce<string | null>(
      (latest, action) => maxIso(latest, iso(action)),
      null,
    ),
    purpose_change_at: iso(PURPOSE_CHANGE_ACTION),
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
      // Caches written before YUK-1770 lack the key → null → the next read sees
      // goal_at advance and re-assembles once. Intended.
      goal_at: wmField('goal_at'),
      purpose_change_at: wmField('purpose_change_at'),
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
      // 裁剪遥测：只记单元名 + token 数（受限内容进不来）。
      ...(cache.startup_trim ? { startup_trim: cache.startup_trim } : {}),
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
  /** Startup-segment assembler; defaults to the Context module via the kernel port. */
  assembleHeaderFn?: (
    db: DbLike,
    now: Date,
  ) => Promise<{ header_md: string; startup_trim?: StartupTrimRecord }>;
  loadProposalFeedbackFn?: (db: DbLike) => Promise<ProposalFeedbackCell[]>;
  writeCacheFn?: (db: DbLike, cache: PersistedLearnerStateHeaderCache) => Promise<void>;
  now?: () => Date;
}

const EMPTY_HEADER: LearnerStateHeader = { header_md: '', proposal_feedback: [] };

/**
 * Resolve the session-anchored learner-state header: read the cache and current
 * watermarks (cheap), reuse a fresh cache with NO reassembly (the owner's hard
 * constraint), else load the Context startup segment + scoped digest, persist a
 * new cache row, and return it. Any read failure degrades to a stale cache (if
 * any) or an empty header, never crashing the chat; a never-installed host port
 * is a wiring defect and propagates instead of degrading.
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
  const assembleHeader =
    deps.assembleHeaderFn ??
    (async (d: DbLike, at: Date) => {
      const ctx = await loadLearnerContext(d, { view: 'companion', now: at });
      return {
        header_md: ctx.markdown,
        ...(ctx.startupTrim
          ? {
              startup_trim: {
                dropped_units: [...ctx.startupTrim.droppedUnits],
                tokens_before: ctx.startupTrim.tokensBeforeTrim,
                tokens_after: ctx.estimatedTokens,
              } satisfies StartupTrimRecord,
            }
          : {}),
      };
    });
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
    const [assembled, rawFeedback] = await Promise.all([assembleHeader(db, now), loadFeedback(db)]);
    const proposal_feedback = scopeCopilotProposalFeedback(rawFeedback);
    const header_md = assembled.header_md;
    const persisted: PersistedLearnerStateHeaderCache = {
      session_id: sessionId,
      header_md,
      proposal_feedback,
      assembled_at: now.toISOString(),
      day_bucket: dayBucketNow,
      watermarks: currentWatermarks,
      ...(assembled.startup_trim ? { startup_trim: assembled.startup_trim } : {}),
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
    if (err instanceof HostOperationNotInstalledError) throw err;
    console.error('[resolveLearnerStateHeader] assembly failed; degrading', {
      session_id: sessionId,
      err,
    });
    return cached
      ? { header_md: cached.header_md, proposal_feedback: cached.proposal_feedback }
      : EMPTY_HEADER;
  }
}
