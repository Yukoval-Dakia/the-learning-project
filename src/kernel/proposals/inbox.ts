import {
  type SQL,
  type SQLWrapper,
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  not,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import {
  type AiProposalKindT,
  type AiProposalPayloadT,
  aiProposalKindStrength,
  parseAiProposalPayload,
} from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { event, proposal_signals } from '@/db/schema';
import { getCorrectionStatuses } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { batchConfirmEligibleKind } from '@/kernel/proposals/batch-confirm';
import {
  type BlockMergeIneligibilityReason,
  blockMergeAdmissionInputFromPayload,
  evaluateBlockMergeAdmission,
  loadBlockMergeAdmissionContext,
} from '@/kernel/proposals/block-merge-admission';
import { legacyKnowledgeProposalForLearner } from '@/kernel/proposals/learner-read';
import {
  type ProposalPresentation,
  loadProposalPresentations,
} from '@/kernel/proposals/presentation';
import {
  type ProposalSignalSnapshot,
  loadProposalSignalsForRows,
} from '@/kernel/proposals/signals';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

// Terminal derived status for propose events a fold rejected (rubric or topology).
// Not 'pending', so pending dedup and cooldown queries exclude it and a better
// attempt may re-propose.
export type ProposalStatus = 'pending' | 'accepted' | 'dismissed' | 'stale' | 'rubric_rejected';

export interface ProposalInboxRow {
  id: string;
  kind: AiProposalPayloadT['kind'];
  target: AiProposalPayloadT['target'];
  payload: AiProposalPayloadT;
  status: ProposalStatus;
  proposed_at: Date;
  decided_at: Date | null;
  actor_ref: string;
  task_run_id: string | null;
  cost_micro_usd: number | null;
  source_action: string;
  source_subject_kind: string;
  /**
   * Pending block_merge rows carry the admission proof's ineligibility code when
   * stored facts cannot currently prove the merge. accept is still hard-blocked
   * on the same proof; this field only explains why the card cannot be accepted.
   */
  not_acceptable_reason: BlockMergeIneligibilityReason | null;
  /**
   * Server-derived: this pending row may join a batch confirmation. Only true
   * for B-strength kinds with an owner retract path; the UI must not keep its
   * own whitelist.
   */
  batch_confirm_eligible: boolean;
  signals: ProposalSignalSnapshot | null;
  presentation: ProposalPresentation | null;
}

export interface ListProposalInboxOpts {
  status?: ProposalStatus;
  // Filtered in the projection layer because legacy kinds derive from
  // action/subject_kind and SQL cannot see them. The pagination loop refills, so
  // cursor semantics stay correct.
  kind?: AiProposalPayloadT['kind'];
  // decision excludes C-strength observe-only rows, so an observation backlog
  // cannot hide actionable rows behind the page boundary.
  lane?: ProposalInboxLane;
  // Projection-layer filter, refilled by the pagination loop so `limit` still means
  // matching rows.
  actorRef?: string;
  /**
   * Historical replay: only proposals, terminal rates and corrections created
   * before this instant count. Admission checks still read current rows.
   */
  asOf?: Date;
  /** Only rows created at or after this instant (the drawer's recent preview window). */
  createdAfter?: Date;
  /**
   * Preview-only ordering: these kinds sort before everything else. The cursor
   * encodes the full rank, so combining this with `cursor` would silently skip
   * rows; callers that page must not set it.
   */
  kindFirst?: readonly AiProposalKindT[];
  limit?: number;
  cursor?: string;
}

export type ProposalInboxLane = 'decision' | 'observation';

export interface LegacyKnowledgeProposalRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  reasoning: string;
  status: ProposalStatus;
  proposed_at: Date;
  decided_at: Date | null;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const terminalRateStatus = {
  accept: 'accepted',
  reverse: 'accepted',
  change_type: 'accepted',
  dismiss: 'dismissed',
  rollback: 'stale',
} as const satisfies Record<string, ProposalStatus>;

type TerminalRating = keyof typeof terminalRateStatus;
const terminalRatings = Object.keys(terminalRateStatus) as TerminalRating[];

function isTerminalRating(value: unknown): value is TerminalRating {
  return typeof value === 'string' && Object.hasOwn(terminalRateStatus, value);
}

function rateStatus(rate: EventRow | undefined): ProposalStatus {
  if (!rate) return 'pending';
  const payload = toRecord(rate.payload);
  return isTerminalRating(payload.rating) ? terminalRateStatus[payload.rating] : 'pending';
}

/**
 * SQL form of rateStatus: true when the proposal's latest chained rate (same
 * created_at/id order as loadLatestRateByProposal) carries a terminal rating.
 * `proposalId` must reference an outer table other than the inner aliases.
 */
export function proposalLatestRateTerminalSql(proposalId: SQLWrapper): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${event} AS latest_rate
    WHERE latest_rate.action = 'rate'
      AND latest_rate.caused_by_event_id = ${proposalId}
      AND latest_rate.payload->>'rating' IN (${sql.join(
        terminalRatings.map((rating) => sql`${rating}`),
        sql`, `,
      )})
      AND NOT EXISTS (
        SELECT 1 FROM ${event} AS newer_rate
        WHERE newer_rate.action = 'rate'
          AND newer_rate.caused_by_event_id = ${proposalId}
          AND (newer_rate.created_at > latest_rate.created_at
            OR (newer_rate.created_at = latest_rate.created_at AND newer_rate.id > latest_rate.id))
      )
  )`;
}

// Shared guard for terminal fold markers (rubric_verdict / topology_verdict).
function hasVerdictMarker(
  row: EventRow,
  key: string,
  predicate: (verdict: Record<string, unknown>) => boolean,
): boolean {
  const verdict = toRecord(row.payload)[key];
  return (
    verdict !== null && typeof verdict === 'object' && predicate(verdict as Record<string, unknown>)
  );
}

// A rubric-rejected propose event has no chained rate; without the marker it would
// derive pending and re-occupy its (kind, cooldown_key) against live-pending dedup.
function isRubricRejected(row: EventRow): boolean {
  return hasVerdictMarker(row, 'rubric_verdict', (v) => v.ok === false);
}

// A topology-rejected propose event is folded like a rubric reject: visible for
// audit, not pending, no rate. It shares the rubric_rejected bucket so the public
// ProposalStatus enum does not widen.
function isTopologyRejected(row: EventRow): boolean {
  return hasVerdictMarker(row, 'topology_verdict', (v) => v.status === 'reject');
}

// A correction takes priority over a fold marker: a retracted folded proposal must
// not stay rubric_rejected forever. Shared by list and single-row projections so
// bucketing is uniform.
function deriveProposalStatus(
  row: EventRow,
  correction: ProposalCorrectionDecision | undefined,
  rate: EventRow | undefined,
): ProposalStatus {
  if (correction) return correction.status;
  if (isRubricRejected(row)) return 'rubric_rejected';
  // Same terminal bucket as a rubric reject.
  if (isTopologyRejected(row)) return 'rubric_rejected';
  return rateStatus(rate);
}

interface ProposalCorrectionDecision {
  status: ProposalStatus;
  decided_at: Date | null;
}

interface ProposalCursor {
  created_at: Date;
  id: string;
  cooldown_active: number;
  acceptance_rate: number;
  /** Rank of the row's kind under the caller's kindFirst order; 0 when unsorted. */
  kind_priority: number;
}

interface LoadedProposalEvent {
  row: EventRow;
  cursor: ProposalCursor;
}

export interface ProposalInboxPage {
  rows: ProposalInboxRow[];
  next_cursor: string | null;
}

function proposalWhere() {
  return or(
    and(eq(event.action, 'propose'), inArray(event.subject_kind, ['knowledge', 'knowledge_edge'])),
    like(event.action, 'experimental:knowledge_%'),
    eq(event.action, 'experimental:proposal'),
    // Legacy learning-intent proposals also surface in the unified inbox.
    eq(event.action, 'experimental:propose_learning_intent'),
  );
}

const observationProposalKinds = Object.entries(aiProposalKindStrength)
  .filter(([, strength]) => strength === 'C')
  .map(([kind]) => kind as AiProposalKindT);

/**
 * Push the inbox lane split into the ranked query. Modern proposals have a canonical
 * kind; the older experimental:knowledge_* form has none, so its mutation mapping
 * mirrors deriveLegacyAiProposal just far enough to identify the C-strength archive
 * fallback. Zod validation still runs in projection, so this can retain malformed
 * candidates but never promote one.
 */
function proposalLaneWhere(lane: ProposalInboxLane | undefined): SQL | undefined {
  if (!lane) return undefined;
  const payloadKind = sql<string | null>`CASE
    WHEN jsonb_typeof(${event.payload}->'ai_proposal') = 'object'
      THEN ${event.payload}->'ai_proposal'->>'kind'
    WHEN ${event.action} = 'experimental:proposal'
      THEN ${event.payload}->>'kind'
    ELSE NULL
  END`;
  const observationKind = inArray(payloadKind, observationProposalKinds);
  const legacyKnowledgeMutation = sql<string>`COALESCE(
    NULLIF(${event.payload}->>'mutation', ''),
    regexp_replace(${event.action}, '^experimental:knowledge_', '')
  )`;
  const legacyKnowledgeObservation = sql<boolean>`(
    ${isNull(payloadKind)}
    AND ${like(event.action, 'experimental:knowledge_%')}
    AND ${eq(event.subject_kind, 'knowledge')}
    AND ${notInArray(legacyKnowledgeMutation, [
      'propose',
      'propose_new',
      'reparent',
      'merge',
      'split',
    ])}
  )`;

  if (lane === 'decision') {
    return or(
      and(isNotNull(payloadKind), notInArray(payloadKind, observationProposalKinds)),
      and(isNull(payloadKind), not(legacyKnowledgeObservation)),
    );
  }

  return or(observationKind, legacyKnowledgeObservation);
}

/**
 * Count pending rows by kind without loading ranked pages. SQL only drops proposals
 * whose latest rate is terminal; payload shape, corrections, verdicts, and legacy
 * derivation stay on the same TypeScript/Zod path as the inbox.
 *
 * hasMore means the batch ceiling was hit, so byKind is a lower bound.
 */
export interface PendingProposalCountResult {
  byKind: Partial<Record<AiProposalKindT, number>>;
  hasMore: boolean;
}

export const PENDING_PROPOSAL_COUNT_BATCH_SIZE = 5_000;
export const PENDING_PROPOSAL_COUNT_MAX_BATCHES = 10;

export async function countPendingProposalInboxByKind(
  db: DbLike,
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<PendingProposalCountResult> {
  const counts: Partial<Record<AiProposalKindT, number>> = {};
  const batchSize = options.batchSize ?? PENDING_PROPOSAL_COUNT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? PENDING_PROPOSAL_COUNT_MAX_BATCHES;
  let after: Pick<EventRow, 'created_at' | 'id'> | null = null;
  let batchCount = 0;

  while (true) {
    const afterWhere: SQL | undefined = after
      ? or(
          gt(event.created_at, after.created_at),
          and(eq(event.created_at, after.created_at), gt(event.id, after.id)),
        )
      : undefined;
    const loadedRows: EventRow[] = await db
      .select()
      .from(event)
      .where(and(proposalWhere(), not(proposalLatestRateTerminalSql(event.id)), afterWhere))
      .orderBy(asc(event.created_at), asc(event.id))
      .limit(batchSize + 1);
    const hasMore = loadedRows.length > batchSize;
    const candidateRows = loadedRows.slice(0, batchSize);
    if (candidateRows.length === 0) break;
    batchCount += 1;

    // Counts need only active-vs-corrected state, not the decided-at lookup rows use.
    const correctionStatuses = await getCorrectionStatuses(
      db,
      candidateRows.map((row) => row.id),
    );
    const pendingPayloads: AiProposalPayloadT[] = [];
    for (const row of candidateRows) {
      if (correctionStatuses.get(row.id)?.state !== 'active') continue;
      if (deriveProposalStatus(row, undefined, undefined) !== 'pending') {
        continue;
      }
      const payload = safeDeriveLegacyAiProposal(row);
      if (!payload) continue;
      pendingPayloads.push(payload);
    }

    // Same learner-visibility rule as the list: nothing is dropped, so every
    // pending payload counts — including inadmissible block_merge rows, which
    // stay visible carrying `not_acceptable_reason`.
    for (const payload of pendingPayloads) {
      counts[payload.kind] = (counts[payload.kind] ?? 0) + 1;
    }

    const last: EventRow | undefined = candidateRows.at(-1);
    if (!last || !hasMore) break;
    if (batchCount >= maxBatches) {
      return { byKind: counts, hasMore: true };
    }
    after = { created_at: last.created_at, id: last.id };
  }

  return { byKind: counts, hasMore: false };
}

// Windowed count for the overnight digest. Lives next to proposalWhere so the
// proposal-event predicate has one owner; conjectures is the subset written via the
// default experimental:proposal branch, which the caller subtracts.
export async function countProposalsInWindow(
  db: DbLike,
  window: { from: Date; to: Date },
): Promise<{ total: number; conjectures: number }> {
  const [row] = await db
    .select({
      total: count(),
      conjectures: sql<number>`cast(count(*) filter (
        where ${event.action} = 'experimental:proposal'
        and (${event.payload}->'ai_proposal'->>'kind') = 'conjecture'
      ) as int)`,
    })
    .from(event)
    .where(
      and(proposalWhere(), gte(event.created_at, window.from), lt(event.created_at, window.to)),
    );
  return { total: row?.total ?? 0, conjectures: Number(row?.conjectures ?? 0) };
}

function encodeProposalCursor(row: ProposalCursor): string {
  return Buffer.from(
    JSON.stringify({
      acceptance_rate: row.acceptance_rate,
      cooldown_active: row.cooldown_active,
      created_at: row.created_at.toISOString(),
      id: row.id,
      kind_priority: row.kind_priority,
    }),
  ).toString('base64url');
}

function decodeProposalCursor(cursor: string): ProposalCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      acceptance_rate?: unknown;
      cooldown_active?: unknown;
      created_at?: unknown;
      id?: unknown;
      kind_priority?: unknown;
    };
    if (typeof parsed.id !== 'string' || typeof parsed.created_at !== 'string') {
      throw new Error('missing id or created_at');
    }
    const createdAt = new Date(parsed.created_at);
    if (Number.isNaN(createdAt.getTime())) {
      throw new Error('invalid created_at');
    }
    const cooldownActive =
      typeof parsed.cooldown_active === 'number' && Number.isFinite(parsed.cooldown_active)
        ? parsed.cooldown_active
        : 0;
    const acceptanceRate =
      typeof parsed.acceptance_rate === 'number' && Number.isFinite(parsed.acceptance_rate)
        ? parsed.acceptance_rate
        : 0.5;
    // Cursors minted before the kind rank existed only served the unsorted order.
    const kindPriority =
      typeof parsed.kind_priority === 'number' && Number.isFinite(parsed.kind_priority)
        ? parsed.kind_priority
        : 0;
    return {
      acceptance_rate: acceptanceRate,
      cooldown_active: cooldownActive,
      created_at: createdAt,
      id: parsed.id,
      kind_priority: kindPriority,
    };
  } catch (err) {
    throw new ApiError(
      'validation_error',
      `invalid proposal cursor: ${(err as Error).message}`,
      400,
    );
  }
}

function proposalPayloadKindExpr() {
  return sql<string>`(${event.payload}->'ai_proposal'->>'kind')`;
}

function proposalPayloadCooldownKeyExpr() {
  return sql<string>`(${event.payload}->'ai_proposal'->>'cooldown_key')`;
}

/** Exact all-status lookup used by durable producer idempotency guards. */
export async function hasProposalWithCooldownKey(
  db: DbLike,
  kind: AiProposalPayloadT['kind'],
  cooldownKey: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        proposalWhere(),
        eq(proposalPayloadKindExpr(), kind),
        eq(proposalPayloadCooldownKeyExpr(), cooldownKey),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

function proposalCooldownActiveExpr(nowIso: string) {
  return sql<number>`CASE
    WHEN ${proposal_signals.cooldown_until} IS NOT NULL
      AND ${proposal_signals.cooldown_until} > ${nowIso}::timestamptz
    THEN 1
    ELSE 0
  END`;
}

function proposalAcceptanceRateExpr() {
  return sql<number>`COALESCE(${proposal_signals.acceptance_rate}, 0.5)`;
}

function proposalKindFirstExpr(kinds: readonly AiProposalKindT[]) {
  const list = sql.join(
    kinds.map((kind) => sql`${kind}`),
    sql`, `,
  );
  return sql<number>`CASE WHEN ${proposalPayloadKindExpr()} IN (${list}) THEN 0 ELSE 1 END`;
}

function proposalCursorWhere(cursor: ProposalCursor, nowIso: string, kindPriority: SQL<number>) {
  const cooldownActive = proposalCooldownActiveExpr(nowIso);
  const acceptanceRate = proposalAcceptanceRateExpr();
  const cursorCreatedAtIso = cursor.created_at.toISOString();
  return sql`
    (
      ${kindPriority} > ${cursor.kind_priority}
      OR (
        ${kindPriority} = ${cursor.kind_priority}
        AND (
          ${cooldownActive} > ${cursor.cooldown_active}
          OR (
            ${cooldownActive} = ${cursor.cooldown_active}
            AND ${acceptanceRate} < ${cursor.acceptance_rate}
          )
          OR (
            ${cooldownActive} = ${cursor.cooldown_active}
            AND ${acceptanceRate} = ${cursor.acceptance_rate}
            AND ${event.created_at} < ${cursorCreatedAtIso}::timestamptz
          )
          OR (
            ${cooldownActive} = ${cursor.cooldown_active}
            AND ${acceptanceRate} = ${cursor.acceptance_rate}
            AND ${event.created_at} = ${cursorCreatedAtIso}::timestamptz
            AND ${event.id} < ${cursor.id}
          )
        )
      )
    )
  `;
}

async function loadProposalEvents(
  db: DbLike,
  opts: Pick<
    ListProposalInboxOpts,
    'limit' | 'cursor' | 'lane' | 'asOf' | 'createdAfter' | 'kindFirst'
  > & {
    nowIso?: string;
  } = {},
): Promise<LoadedProposalEvent[]> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const cursor = opts.cursor ? decodeProposalCursor(opts.cursor) : null;
  const cooldownActive = proposalCooldownActiveExpr(nowIso);
  const acceptanceRate = proposalAcceptanceRateExpr();
  const asOfWhere = opts.asOf ? lt(event.created_at, opts.asOf) : undefined;
  const createdAfterWhere = opts.createdAfter
    ? gte(event.created_at, opts.createdAfter)
    : undefined;
  // The rank is part of the ordering, so refill cursors must carry it too. Without a
  // kindFirst order every row ranks 0 and the predicate reduces to the previous one.
  const kindPriority = opts.kindFirst?.length
    ? proposalKindFirstExpr(opts.kindFirst)
    : sql<number>`0`;
  const where = cursor
    ? and(
        proposalWhere(),
        proposalLaneWhere(opts.lane),
        proposalCursorWhere(cursor, nowIso, kindPriority),
        asOfWhere,
        createdAfterWhere,
      )
    : and(proposalWhere(), proposalLaneWhere(opts.lane), asOfWhere, createdAfterWhere);
  const rank = opts.kindFirst?.length ? [kindPriority] : [];
  const query = db
    .select({
      acceptance_rate: acceptanceRate,
      cooldown_active: cooldownActive,
      kind_priority: kindPriority,
      row: event,
    })
    .from(event)
    .leftJoin(
      proposal_signals,
      and(
        eq(proposal_signals.kind, proposalPayloadKindExpr()),
        eq(proposal_signals.cooldown_key, proposalPayloadCooldownKeyExpr()),
      ),
    )
    .where(where)
    .orderBy(...rank, cooldownActive, desc(acceptanceRate), desc(event.created_at), desc(event.id));
  const rows = opts.limit === undefined ? await query : await query.limit(opts.limit);
  return rows.map((loaded) => ({
    row: loaded.row,
    cursor: {
      acceptance_rate: loaded.acceptance_rate,
      cooldown_active: loaded.cooldown_active,
      created_at: loaded.row.created_at,
      id: loaded.row.id,
      kind_priority: loaded.kind_priority,
    },
  }));
}

async function loadProposalEventById(db: DbLike, proposalId: string): Promise<EventRow | null> {
  const rows = await db
    .select()
    .from(event)
    .where(and(eq(event.id, proposalId), proposalWhere()))
    .limit(1);
  return rows[0] ?? null;
}

async function loadLatestRateByProposal(
  db: DbLike,
  proposalIds: string[],
  asOf?: Date,
): Promise<Map<string, EventRow>> {
  if (proposalIds.length === 0) return new Map();
  const rateRows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'rate'),
        inArray(event.caused_by_event_id, proposalIds),
        isNotNull(event.caused_by_event_id),
        asOf ? lt(event.created_at, asOf) : undefined,
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id));

  const latest = new Map<string, EventRow>();
  for (const row of rateRows) {
    const proposalId = row.caused_by_event_id;
    if (proposalId && !latest.has(proposalId)) latest.set(proposalId, row);
  }
  return latest;
}

async function loadCorrectionDecisionByProposal(
  db: DbLike,
  proposalIds: string[],
  asOf?: Date,
): Promise<Map<string, ProposalCorrectionDecision>> {
  if (proposalIds.length === 0) return new Map();
  const correctionStatuses = await getCorrectionStatuses(
    db,
    proposalIds,
    asOf ? { createdBefore: asOf } : undefined,
  );
  const correctionIds = [...correctionStatuses.values()]
    .map((status) => status.correction_event_id)
    .filter((id): id is string => Boolean(id));
  const correctionRows =
    correctionIds.length === 0
      ? []
      : await db
          .select({ id: event.id, created_at: event.created_at })
          .from(event)
          .where(inArray(event.id, correctionIds));
  const correctionCreatedById = new Map(correctionRows.map((row) => [row.id, row.created_at]));

  const out = new Map<string, ProposalCorrectionDecision>();
  for (const proposalId of proposalIds) {
    const status = correctionStatuses.get(proposalId);
    if (!status || status.state === 'active') continue;
    out.set(proposalId, {
      status: 'stale',
      decided_at: correctionCreatedById.get(status.correction_event_id) ?? null,
    });
  }
  return out;
}

function deriveLegacyAiProposal(row: EventRow): AiProposalPayloadT | null {
  const payload = toRecord(row.payload);
  if (payload.ai_proposal !== undefined) {
    return parseAiProposalPayload(payload.ai_proposal);
  }
  if (row.action === 'experimental:proposal') {
    return parseAiProposalPayload(payload);
  }
  if (row.action.startsWith('experimental:knowledge_') && row.subject_kind === 'knowledge') {
    const mutation = String(payload.mutation ?? row.action.replace(/^experimental:knowledge_/, ''));
    if (mutation === 'propose' || mutation === 'propose_new') {
      return parseAiProposalPayload({
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: row.subject_id },
        reason_md: String(payload.reasoning ?? 'Legacy knowledge proposal'),
        evidence_refs: [],
        proposed_change: {
          mutation: 'propose_new',
          name: String(payload.name ?? ''),
          parent_id: String(payload.parent_id ?? ''),
        },
      });
    }
    const {
      ai_proposal: _aiProposal,
      reasoning,
      evidence_refs: _evidenceRefs,
      ...proposedChange
    } = payload;
    void _aiProposal;
    void _evidenceRefs;
    if (mutation === 'reparent' || mutation === 'merge' || mutation === 'split') {
      return parseAiProposalPayload({
        kind: 'knowledge_mutation',
        target: { subject_kind: 'knowledge', subject_id: row.subject_id },
        reason_md: String(reasoning ?? `Legacy knowledge ${mutation} proposal`),
        evidence_refs: [],
        proposed_change: {
          mutation,
          ...proposedChange,
        },
        cooldown_key: `legacy_knowledge:${mutation}:${row.subject_id ?? row.id}`,
      });
    }
    return parseAiProposalPayload({
      kind: 'archive',
      target: { subject_kind: 'knowledge', subject_id: row.subject_id },
      reason_md: String(reasoning ?? `Legacy knowledge ${mutation} proposal`),
      evidence_refs: [],
      proposed_change: {
        mutation,
        ...proposedChange,
      },
      cooldown_key: `legacy_knowledge:${mutation}:${row.subject_id ?? row.id}`,
    });
  }
  if (row.action === 'propose' && row.subject_kind === 'knowledge') {
    return parseAiProposalPayload({
      kind: 'knowledge_node',
      target: { subject_kind: 'knowledge', subject_id: row.subject_id },
      reason_md: String(payload.reasoning ?? ''),
      evidence_refs: [],
      proposed_change: {
        mutation: 'propose_new',
        name: String(payload.name ?? ''),
        // Root proposals carry null plus an anchoring domain; legacy events always
        // had a string parent.
        parent_id: payload.parent_id == null ? null : String(payload.parent_id),
        ...(typeof payload.domain === 'string' && payload.domain.length > 0
          ? { domain: payload.domain }
          : {}),
      },
    });
  }
  if (row.action === 'propose' && row.subject_kind === 'knowledge_edge') {
    // Carry edge_op and the archive target so an archive proposal renders as archive.
    // Absent edge_op (pre-D4-E1 events) defaults to create in the schema parse.
    const edgeOp =
      payload.edge_op === 'archive' || payload.edge_op === 'supersede' ? payload.edge_op : 'create';
    return parseAiProposalPayload({
      kind: 'knowledge_edge',
      target: { subject_kind: 'knowledge_edge', subject_id: row.subject_id },
      reason_md: String(payload.reasoning ?? ''),
      evidence_refs: [],
      proposed_change: {
        edge_op: edgeOp,
        from_knowledge_id: String(payload.from_knowledge_id ?? ''),
        to_knowledge_id: String(payload.to_knowledge_id ?? ''),
        relation_type: String(payload.relation_type ?? ''),
        weight:
          typeof payload.weight === 'number' && Number.isFinite(payload.weight)
            ? payload.weight
            : undefined,
        ...(edgeOp !== 'create' && typeof payload.archive_edge_id === 'string'
          ? { archive_edge_id: payload.archive_edge_id }
          : {}),
        ...(edgeOp === 'supersede' && typeof payload.supersede_confidence === 'number'
          ? { supersede_confidence: payload.supersede_confidence }
          : {}),
        ...(edgeOp === 'supersede' && 'supersede_neighbor_index' in payload
          ? { supersede_neighbor_index: payload.supersede_neighbor_index }
          : {}),
        ...(edgeOp === 'supersede' && Array.isArray(payload.supersede_affected_refs)
          ? { supersede_affected_refs: payload.supersede_affected_refs }
          : {}),
      },
    });
  }
  return null;
}

function safeDeriveLegacyAiProposal(row: EventRow): AiProposalPayloadT | null {
  try {
    return deriveLegacyAiProposal(row);
  } catch (err) {
    console.warn(`[listProposalInboxRows] skipping invalid proposal event ${row.id}`, err);
    return null;
  }
}

export async function listProposalInboxRows(
  db: DbLike,
  opts: ListProposalInboxOpts = {},
): Promise<ProposalInboxRow[]> {
  return (await listProposalInboxPage(db, opts)).rows;
}

// One batched admission proof per projected batch, run before signals/presentation.
// Rows are never dropped: an inadmissible pending block_merge stays visible and
// carries the proof's reason in `not_acceptable_reason`; accept re-runs the same
// proof as a hard block. The not_draft arm is the exception — accept answers it
// as a soft stale success, so it is not marked unacceptable.
async function annotateBlockMergeAdmission(db: DbLike, rows: ProposalInboxRow[]): Promise<void> {
  const candidates = rows.filter((row) => row.kind === 'block_merge' && row.status === 'pending');
  if (candidates.length === 0) return;
  const blockIds = new Set<string>();
  for (const row of candidates) {
    const input = blockMergeAdmissionInputFromPayload(row.payload);
    if (!input) continue;
    blockIds.add(input.primaryBlockId);
    for (const id of input.mergeBlockIds) blockIds.add(id);
  }
  const ctx = await loadBlockMergeAdmissionContext(db, [...blockIds]);
  for (const row of candidates) {
    const input = blockMergeAdmissionInputFromPayload(row.payload);
    const verdict = input ? evaluateBlockMergeAdmission(input, ctx) : null;
    if (!verdict?.eligible && verdict?.reason !== 'not_draft') {
      row.not_acceptable_reason = verdict?.reason ?? 'blocks_missing';
    }
  }
}

async function projectLoadedProposalRows(
  db: DbLike,
  loadedProposalRows: LoadedProposalEvent[],
  filters: Pick<ListProposalInboxOpts, 'status' | 'kind' | 'lane' | 'actorRef' | 'asOf'> = {},
): Promise<ProposalInboxRow[]> {
  const { status, kind, lane, actorRef, asOf } = filters;
  const proposalRows = loadedProposalRows.map((loaded) => loaded.row);
  const latestRateByProposal = await loadLatestRateByProposal(
    db,
    proposalRows.map((row) => row.id),
    asOf,
  );
  const correctionDecisionByProposal = await loadCorrectionDecisionByProposal(
    db,
    proposalRows.map((row) => row.id),
    asOf,
  );

  const out: ProposalInboxRow[] = [];
  for (const row of proposalRows) {
    const rate = latestRateByProposal.get(row.id);
    const correction = correctionDecisionByProposal.get(row.id);
    const rowStatus = deriveProposalStatus(row, correction, rate);
    if (status && rowStatus !== status) continue;
    if (actorRef && row.actor_ref !== actorRef) continue;
    const payload = safeDeriveLegacyAiProposal(row);
    if (!payload) continue;
    if (kind && payload.kind !== kind) continue;
    const observation = aiProposalKindStrength[payload.kind] === 'C';
    if (lane === 'decision' && observation) continue;
    if (lane === 'observation' && !observation) continue;
    out.push({
      id: row.id,
      kind: payload.kind,
      target: payload.target,
      payload,
      status: rowStatus,
      proposed_at: row.created_at,
      decided_at: correction?.decided_at ?? rate?.created_at ?? null,
      actor_ref: row.actor_ref,
      task_run_id: row.task_run_id,
      cost_micro_usd: row.cost_micro_usd,
      source_action: row.action,
      source_subject_kind: row.subject_kind,
      not_acceptable_reason: null,
      batch_confirm_eligible: rowStatus === 'pending' && batchConfirmEligibleKind(payload.kind),
      signals: null,
      presentation: null,
    });
  }

  await annotateBlockMergeAdmission(db, out);

  // Presentation may isolate optional reads in a savepoint on this same Tx.
  const signalsByProposalId = await loadProposalSignalsForRows(db, out);
  const presentationByProposalId = await loadProposalPresentations(db, out);
  for (const row of out) {
    row.signals = signalsByProposalId.get(row.id) ?? null;
    row.presentation = presentationByProposalId.get(row.id) ?? null;
  }
  return out;
}

export async function listProposalInboxPage(
  db: DbLike,
  opts: ListProposalInboxOpts = {},
): Promise<ProposalInboxPage> {
  if (opts.kindFirst?.length && opts.cursor) {
    throw new ApiError(
      'validation_error',
      'kindFirst changes the rank order and cannot be combined with a cursor',
    );
  }
  const rankingNowIso = new Date().toISOString();
  const pageLimit = opts.limit;
  if (pageLimit === undefined) {
    const loadedProposalRows = await loadProposalEvents(db, {
      cursor: opts.cursor,
      lane: opts.lane,
      asOf: opts.asOf,
      createdAfter: opts.createdAfter,
      kindFirst: opts.kindFirst,
      nowIso: rankingNowIso,
    });
    return {
      rows: await projectLoadedProposalRows(db, loadedProposalRows, opts),
      next_cursor: null,
    };
  }

  const cursorById = new Map<string, ProposalCursor>();
  const out: ProposalInboxRow[] = [];
  const targetRows = pageLimit + 1;
  const batchLimit = Math.max(targetRows, 50);
  let cursor = opts.cursor;

  while (out.length < targetRows) {
    const loadedProposalRows = await loadProposalEvents(db, {
      cursor,
      lane: opts.lane,
      asOf: opts.asOf,
      createdAfter: opts.createdAfter,
      kindFirst: opts.kindFirst,
      limit: batchLimit,
      nowIso: rankingNowIso,
    });
    if (loadedProposalRows.length === 0) break;
    for (const loaded of loadedProposalRows) {
      cursorById.set(loaded.row.id, loaded.cursor);
    }
    out.push(...(await projectLoadedProposalRows(db, loadedProposalRows, opts)));
    if (loadedProposalRows.length < batchLimit) break;
    cursor = encodeProposalCursor(loadedProposalRows[loadedProposalRows.length - 1].cursor);
  }

  const hasMore = out.length > pageLimit;
  const pageRows = hasMore ? out.slice(0, pageLimit) : out;
  const nextCursorRow = hasMore ? pageRows.at(-1) : null;
  const nextCursor = nextCursorRow ? cursorById.get(nextCursorRow.id) : null;
  return {
    rows: pageRows,
    next_cursor: nextCursor ? encodeProposalCursor(nextCursor) : null,
  };
}

export async function getProposalInboxRow(
  db: DbLike,
  proposalId: string,
): Promise<ProposalInboxRow | null> {
  const proposalRow = await loadProposalEventById(db, proposalId);
  if (!proposalRow) return null;
  const latestRateByProposal = await loadLatestRateByProposal(db, [proposalId]);
  const correctionDecisionByProposal = await loadCorrectionDecisionByProposal(db, [proposalId]);
  const rate = latestRateByProposal.get(proposalId);
  const correction = correctionDecisionByProposal.get(proposalId);
  const payload = safeDeriveLegacyAiProposal(proposalRow);
  if (!payload) return null;
  const status = deriveProposalStatus(proposalRow, correction, rate);
  const row: ProposalInboxRow = {
    id: proposalRow.id,
    kind: payload.kind,
    target: payload.target,
    payload,
    status,
    proposed_at: proposalRow.created_at,
    decided_at: correction?.decided_at ?? rate?.created_at ?? null,
    actor_ref: proposalRow.actor_ref,
    task_run_id: proposalRow.task_run_id,
    cost_micro_usd: proposalRow.cost_micro_usd,
    source_action: proposalRow.action,
    source_subject_kind: proposalRow.subject_kind,
    not_acceptable_reason: null,
    batch_confirm_eligible: status === 'pending' && batchConfirmEligibleKind(payload.kind),
    signals: null,
    presentation: null,
  };
  await annotateBlockMergeAdmission(db, [row]);
  // Finish the presentation savepoint before another read uses this Tx.
  const presentationByProposalId = await loadProposalPresentations(db, [row]);
  const signalsByProposalId = await loadProposalSignalsForRows(db, [row]);
  row.presentation = presentationByProposalId.get(row.id) ?? null;
  row.signals = signalsByProposalId.get(row.id) ?? null;
  return row;
}

function legacyPayloadFor(row: EventRow): { payload: Record<string, unknown>; reasoning: string } {
  const payload = toRecord(row.payload);
  if (row.subject_kind === 'knowledge_edge') {
    // Carry edge_op and archive target so the legacy consumer can distinguish
    // archive from create. Absent edge_op defaults to create downstream.
    return {
      payload: {
        mutation: 'propose_knowledge_edge',
        edge_op:
          payload.edge_op === 'archive' || payload.edge_op === 'supersede'
            ? payload.edge_op
            : 'create',
        from_knowledge_id: payload.from_knowledge_id,
        to_knowledge_id: payload.to_knowledge_id,
        relation_type: payload.relation_type,
        weight: payload.weight,
        ...(typeof payload.archive_edge_id === 'string'
          ? { archive_edge_id: payload.archive_edge_id }
          : {}),
        ...(typeof payload.supersede_confidence === 'number'
          ? { supersede_confidence: payload.supersede_confidence }
          : {}),
        ...('supersede_neighbor_index' in payload
          ? { supersede_neighbor_index: payload.supersede_neighbor_index }
          : {}),
        ...(Array.isArray(payload.supersede_affected_refs)
          ? { supersede_affected_refs: payload.supersede_affected_refs }
          : {}),
      },
      reasoning: String(payload.reasoning ?? ''),
    };
  }
  if (row.action === 'propose') {
    return {
      payload: {
        mutation: 'propose_new',
        name: payload.name,
        parent_id: payload.parent_id,
        ...(typeof payload.domain === 'string' && payload.domain.length > 0
          ? { domain: payload.domain }
          : {}),
      },
      reasoning: String(payload.reasoning ?? ''),
    };
  }
  const { reasoning, ...rest } = payload;
  return {
    payload: {
      mutation: row.action.replace(/^experimental:knowledge_/, ''),
      ...rest,
    },
    reasoning: String(reasoning ?? ''),
  };
}

export async function listLegacyKnowledgeProposals(
  db: DbLike,
  opts: ListProposalInboxOpts = {},
): Promise<LegacyKnowledgeProposalRow[]> {
  const proposalRows = (await loadProposalEvents(db))
    .map((loaded) => loaded.row)
    .filter(
      (row) =>
        (row.subject_kind === 'knowledge' &&
          (row.action === 'propose' || row.action.startsWith('experimental:knowledge_'))) ||
        (row.subject_kind === 'knowledge_edge' && row.action === 'propose'),
    );
  const latestRateByProposal = await loadLatestRateByProposal(
    db,
    proposalRows.map((row) => row.id),
  );
  const correctionDecisionByProposal = await loadCorrectionDecisionByProposal(
    db,
    proposalRows.map((row) => row.id),
  );

  const out: LegacyKnowledgeProposalRow[] = [];
  for (const row of proposalRows) {
    const rate = latestRateByProposal.get(row.id);
    const correction = correctionDecisionByProposal.get(row.id);
    const status = deriveProposalStatus(row, correction, rate);
    if (opts.status && status !== opts.status) continue;
    const projected = legacyPayloadFor(row);
    out.push(
      legacyKnowledgeProposalForLearner({
        id: row.id,
        kind: row.subject_kind,
        payload: projected.payload,
        reasoning: projected.reasoning,
        status,
        proposed_at: row.created_at,
        decided_at: correction?.decided_at ?? rate?.created_at ?? null,
      }),
    );
    if (opts.limit !== undefined && out.length >= opts.limit) break;
  }
  return out;
}

/**
 * Shared cooldown dedup for capability-owned proposal tools. This is a read: callers
 * that need atomic "check pending then write" must lock the same cooldown key inside
 * their write transaction.
 */
export async function pendingProposalWithCooldown(
  db: DbLike,
  kind: string,
  cooldownKey: string,
): Promise<boolean> {
  // Dedup sees every stored pending row: an inadmissible block_merge still
  // occupies its cooldown slot, so the producer cannot re-propose it forever.
  const rows = await listProposalInboxRows(db, {
    status: 'pending',
  });
  return rows.some((row) => row.kind === kind && row.payload.cooldown_key === cooldownKey);
}
