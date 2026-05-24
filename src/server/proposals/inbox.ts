import { type AiProposalPayloadT, parseAiProposalPayload } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { getCorrectionStatuses } from '@/server/events/corrections';
import { ApiError } from '@/server/http/errors';
import {
  type ProposalSignalSnapshot,
  loadProposalSignalsForRows,
} from '@/server/proposals/signals';
import { and, desc, eq, inArray, isNotNull, like, lt, or } from 'drizzle-orm';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

export type ProposalStatus = 'pending' | 'accepted' | 'dismissed' | 'stale';

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

interface ProposalCorrectionDecision {
  status: ProposalStatus;
  decided_at: Date | null;
}

interface ProposalCursor {
  created_at: Date;
  id: string;
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

function encodeProposalCursor(row: Pick<EventRow, 'created_at' | 'id'>): string {
  return Buffer.from(
    JSON.stringify({ created_at: row.created_at.toISOString(), id: row.id }),
  ).toString('base64url');
}

function decodeProposalCursor(cursor: string): ProposalCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
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
    return { created_at: createdAt, id: parsed.id };
  } catch (err) {
    throw new ApiError(
      'validation_error',
      `invalid proposal cursor: ${(err as Error).message}`,
      400,
    );
  }
}

async function loadProposalEvents(
  db: DbLike,
  opts: Pick<ListProposalInboxOpts, 'limit' | 'cursor'> = {},
): Promise<EventRow[]> {
  const cursor = opts.cursor ? decodeProposalCursor(opts.cursor) : null;
  const where = cursor
    ? and(
        proposalWhere(),
        or(
          lt(event.created_at, cursor.created_at),
          and(eq(event.created_at, cursor.created_at), lt(event.id, cursor.id)),
        ),
      )
    : proposalWhere();
  const query = db
    .select()
    .from(event)
    .where(where)
    .orderBy(desc(event.created_at), desc(event.id));
  return opts.limit === undefined ? await query : await query.limit(opts.limit);
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
    const { ai_proposal: _aiProposal, reasoning, ...proposedChange } = payload;
    void _aiProposal;
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

function sortProposalRowsBySignals(rows: ProposalInboxRow[]): void {
  const now = new Date();
  rows.sort((a, b) => {
    const aCooldown = Number(Boolean(a.signals?.cooldown_until && a.signals.cooldown_until > now));
    const bCooldown = Number(Boolean(b.signals?.cooldown_until && b.signals.cooldown_until > now));
    if (aCooldown !== bCooldown) return aCooldown - bCooldown;

    const aRate = a.signals?.acceptance_rate ?? 0.5;
    const bRate = b.signals?.acceptance_rate ?? 0.5;
    if (aRate !== bRate) return bRate - aRate;

    const proposedAtDelta = b.proposed_at.getTime() - a.proposed_at.getTime();
    if (proposedAtDelta !== 0) return proposedAtDelta;
    return b.id.localeCompare(a.id);
  });
}

export async function listProposalInboxRows(
  db: DbLike,
  opts: ListProposalInboxOpts = {},
): Promise<ProposalInboxRow[]> {
  return (await listProposalInboxPage(db, opts)).rows;
}

export async function listProposalInboxPage(
  db: DbLike,
  opts: ListProposalInboxOpts = {},
): Promise<ProposalInboxPage> {
  const rawLimit = opts.limit === undefined ? undefined : opts.limit + 1;
  const loadedRows = await loadProposalEvents(db, { limit: rawLimit, cursor: opts.cursor });
  const hasMore = opts.limit !== undefined && loadedRows.length > opts.limit;
  const proposalRows = hasMore ? loadedRows.slice(0, opts.limit) : loadedRows;
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
    const status = correction?.status ?? rateStatus(rate);
    if (opts.status && status !== opts.status) continue;
    const payload = safeDeriveLegacyAiProposal(row);
    if (!payload) continue;
    out.push({
      id: row.id,
      kind: payload.kind,
      target: payload.target,
      payload,
      status,
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
  sortProposalRowsBySignals(out);
  return {
    rows: out,
    next_cursor: hasMore ? encodeProposalCursor(proposalRows[proposalRows.length - 1]) : null,
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
    status: correction?.status ?? rateStatus(rate),
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
  const proposalRows = (await loadProposalEvents(db)).filter(
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
    const status = correction?.status ?? rateStatus(rate);
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
