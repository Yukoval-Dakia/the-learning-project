import { type AiProposalPayloadT, parseAiProposalPayload } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { event, proposal_signals } from '@/db/schema';
import { getCorrectionStatuses } from '@/server/events/corrections';
import { ApiError } from '@/server/http/errors';
import {
  type ProposalSignalSnapshot,
  loadProposalSignalsForRows,
} from '@/server/proposals/signals';
import { and, desc, eq, inArray, isNotNull, like, or, sql } from 'drizzle-orm';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

// P5.4 / YUK-143 (RB-7 / RB-8) — 'rubric_rejected' is a TERMINAL derived status
// for propose events the Layer-1 rubric folded (carrying a `rubric_verdict`
// marker on the event payload). It is NOT 'pending', so live-pending dedup /
// cooldown queries that key on status:'pending' exclude it (the rejected edge
// can be re-proposed later by a better attempt). It is the folded / low-
// visibility bucket the inbox exposes (RB-8); no UI in P5.4.
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
  signals: ProposalSignalSnapshot | null;
}

export interface ListProposalInboxOpts {
  status?: ProposalStatus;
  // M4 review fix (YUK-318/YUK-319) — kind 在投影层过滤（与 status 同位）：
  // legacy 事件的 kind 由 deriveLegacyAiProposal 从 action/subject_kind 派生，
  // SQL 层的 payload->'ai_proposal'->>'kind' 表达式覆盖不了 legacy 形态。
  // 投影层过滤吃到 listProposalInboxPage 的补批 loop，跨页分页语义正确
  // （之前在路由层做页内 post-filter，next_cursor 指向未过滤流——codex P2 /
  // coderabbit major）。
  kind?: AiProposalPayloadT['kind'];
  limit?: number;
  cursor?: string;
}

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

function rateStatus(rate: EventRow | undefined): ProposalStatus {
  if (!rate) return 'pending';
  const payload = toRecord(rate.payload);
  switch (payload.rating) {
    case 'accept':
    case 'reverse':
    case 'change_type':
      return 'accepted';
    case 'dismiss':
      return 'dismissed';
    case 'rollback':
      return 'stale';
    default:
      return 'pending';
  }
}

// P5.4 / YUK-143 (RB-6 / RB-7) — a propose event the Layer-1 rubric folded
// carries a `rubric_verdict` marker (sibling of ai_proposal in the event
// payload). Read it from the propose event row so the derived status becomes
// terminal 'rubric_rejected' BEFORE the rate-based derivation runs. A
// rubric-rejected event has no chained rate, so without this it would derive
// 'pending' and re-occupy the (kind, cooldown_key) for live-pending dedup —
// the exact lockout RB-7 forbids.
function isRubricRejected(row: EventRow): boolean {
  const payload = toRecord(row.payload);
  const verdict = payload.rubric_verdict;
  return (
    verdict !== null &&
    typeof verdict === 'object' &&
    (verdict as Record<string, unknown>).ok === false
  );
}

// Resolve the terminal status for a propose event. A non-active correction
// (stale) takes PRIORITY over the rubric_rejected marker: a folded edge that is
// later retracted/corrected (a `correct` event chained off it via
// retractAiProposal) must clear the folded `?status=rubric_rejected` bucket and
// derive 'stale' — otherwise it would stay pinned as rubric_rejected forever and
// could never be cleared (codex r4 P2 #2). The rubric_rejected marker only wins
// when there is no correction. `stale` is ALSO non-pending, so the live-pending
// dedup / cooldown queries (RB-7, in propose_edge.ts + review.ts) still exclude
// a stale-from-correction proposal — those queries key on the correction state +
// the `rubric_verdict` marker directly, not on this derived enum. The pure
// (uncorrected) folded proposal still derives 'rubric_rejected'. Shared by the
// list + single-row projections so the bucketing is uniform.
function deriveProposalStatus(
  row: EventRow,
  correction: ProposalCorrectionDecision | undefined,
  rate: EventRow | undefined,
): ProposalStatus {
  if (correction) return correction.status;
  if (isRubricRejected(row)) return 'rubric_rejected';
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
    // YUK-19 — planLearningIntent writes proposals with the legacy
    // `experimental:propose_learning_intent` action via event_override (see
    // writeLearningItemProposal in src/server/proposals/producers.ts).
    // Surface them in the unified inbox so the rollback / accept UI sees them.
    eq(event.action, 'experimental:propose_learning_intent'),
  );
}

function encodeProposalCursor(row: ProposalCursor): string {
  return Buffer.from(
    JSON.stringify({
      acceptance_rate: row.acceptance_rate,
      cooldown_active: row.cooldown_active,
      created_at: row.created_at.toISOString(),
      id: row.id,
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
    return {
      acceptance_rate: acceptanceRate,
      cooldown_active: cooldownActive,
      created_at: createdAt,
      id: parsed.id,
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

function proposalCursorWhere(cursor: ProposalCursor, nowIso: string) {
  const cooldownActive = proposalCooldownActiveExpr(nowIso);
  const acceptanceRate = proposalAcceptanceRateExpr();
  const cursorCreatedAtIso = cursor.created_at.toISOString();
  return sql`
    (
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
  `;
}

async function loadProposalEvents(
  db: DbLike,
  opts: Pick<ListProposalInboxOpts, 'limit' | 'cursor'> & { nowIso?: string } = {},
): Promise<LoadedProposalEvent[]> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const cursor = opts.cursor ? decodeProposalCursor(opts.cursor) : null;
  const cooldownActive = proposalCooldownActiveExpr(nowIso);
  const acceptanceRate = proposalAcceptanceRateExpr();
  const where = cursor
    ? and(proposalWhere(), proposalCursorWhere(cursor, nowIso))
    : proposalWhere();
  const query = db
    .select({
      acceptance_rate: acceptanceRate,
      cooldown_active: cooldownActive,
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
    .orderBy(cooldownActive, desc(acceptanceRate), desc(event.created_at), desc(event.id));
  const rows = opts.limit === undefined ? await query : await query.limit(opts.limit);
  return rows.map((loaded) => ({
    row: loaded.row,
    cursor: {
      acceptance_rate: loaded.acceptance_rate,
      cooldown_active: loaded.cooldown_active,
      created_at: loaded.row.created_at,
      id: loaded.row.id,
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
): Promise<Map<string, ProposalCorrectionDecision>> {
  if (proposalIds.length === 0) return new Map();
  const correctionStatuses = await getCorrectionStatuses(db, proposalIds);
  const correctionIds = [...correctionStatuses.values()]
    .map((status) => status.correction_event_id)
    .filter((id): id is string => Boolean(id));
  const correctionRows =
    correctionIds.length === 0
      ? []
      : await db.select().from(event).where(inArray(event.id, correctionIds));
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
        parent_id: String(payload.parent_id ?? ''),
      },
    });
  }
  if (row.action === 'propose' && row.subject_kind === 'knowledge_edge') {
    return parseAiProposalPayload({
      kind: 'knowledge_edge',
      target: { subject_kind: 'knowledge_edge', subject_id: row.subject_id },
      reason_md: String(payload.reasoning ?? ''),
      evidence_refs: [],
      proposed_change: {
        from_knowledge_id: String(payload.from_knowledge_id ?? ''),
        to_knowledge_id: String(payload.to_knowledge_id ?? ''),
        relation_type: String(payload.relation_type ?? ''),
        weight:
          typeof payload.weight === 'number' && Number.isFinite(payload.weight)
            ? payload.weight
            : undefined,
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

async function projectLoadedProposalRows(
  db: DbLike,
  loadedProposalRows: LoadedProposalEvent[],
  filters: Pick<ListProposalInboxOpts, 'status' | 'kind'> = {},
): Promise<ProposalInboxRow[]> {
  const { status, kind } = filters;
  const proposalRows = loadedProposalRows.map((loaded) => loaded.row);
  const latestRateByProposal = await loadLatestRateByProposal(
    db,
    proposalRows.map((row) => row.id),
  );
  const correctionDecisionByProposal = await loadCorrectionDecisionByProposal(
    db,
    proposalRows.map((row) => row.id),
  );

  const out: ProposalInboxRow[] = [];
  for (const row of proposalRows) {
    const rate = latestRateByProposal.get(row.id);
    const correction = correctionDecisionByProposal.get(row.id);
    const rowStatus = deriveProposalStatus(row, correction, rate);
    if (status && rowStatus !== status) continue;
    const payload = safeDeriveLegacyAiProposal(row);
    if (!payload) continue;
    if (kind && payload.kind !== kind) continue;
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
      signals: null,
    });
  }

  const signalsByProposalId = await loadProposalSignalsForRows(db, out);
  for (const row of out) {
    row.signals = signalsByProposalId.get(row.id) ?? null;
  }
  return out;
}

export async function listProposalInboxPage(
  db: DbLike,
  opts: ListProposalInboxOpts = {},
): Promise<ProposalInboxPage> {
  const rankingNowIso = new Date().toISOString();
  const pageLimit = opts.limit;
  if (pageLimit === undefined) {
    const loadedProposalRows = await loadProposalEvents(db, {
      cursor: opts.cursor,
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
  const row: ProposalInboxRow = {
    id: proposalRow.id,
    kind: payload.kind,
    target: payload.target,
    payload,
    status: deriveProposalStatus(proposalRow, correction, rate),
    proposed_at: proposalRow.created_at,
    decided_at: correction?.decided_at ?? rate?.created_at ?? null,
    actor_ref: proposalRow.actor_ref,
    task_run_id: proposalRow.task_run_id,
    cost_micro_usd: proposalRow.cost_micro_usd,
    source_action: proposalRow.action,
    source_subject_kind: proposalRow.subject_kind,
    signals: null,
  };
  const signalsByProposalId = await loadProposalSignalsForRows(db, [row]);
  row.signals = signalsByProposalId.get(row.id) ?? null;
  return row;
}

function legacyPayloadFor(row: EventRow): { payload: Record<string, unknown>; reasoning: string } {
  const payload = toRecord(row.payload);
  if (row.subject_kind === 'knowledge_edge') {
    return {
      payload: {
        mutation: 'propose_knowledge_edge',
        from_knowledge_id: payload.from_knowledge_id,
        to_knowledge_id: payload.to_knowledge_id,
        relation_type: payload.relation_type,
        weight: payload.weight,
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
    out.push({
      id: row.id,
      kind: row.subject_kind,
      payload: projected.payload,
      reasoning: projected.reasoning,
      status,
      proposed_at: row.created_at,
      decided_at: correction?.decided_at ?? rate?.created_at ?? null,
    });
    if (opts.limit !== undefined && out.length >= opts.limit) break;
  }
  return out;
}
