// Owner of "which revision this demand has published": a publication receipt is the
// block the submit gate writes into the submission receipt event, in the same
// transaction as the assessment_publish event it names. Readers never parse the tool
// response or the optional `published`/`publish_status`/`revision_id` fields; progress,
// spend settlement and repair authorization all read these receipts.
//
// A publishing seam result that cannot name its group/revision/event throws at the
// write site, so the submit transaction rolls back instead of committing a publication
// no reader can see.
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { event, question_revision } from '@/db/schema';

/** Submission receipt action; the publication block lives in this event's payload. */
export const DRAFT_SUBMIT_ACTION = 'experimental:question_draft_submit';

/** Seam statuses that write an assessment_publish event in the submit transaction. */
const PUBLISHING_STATUSES = ['published', 'admission_updated'] as const;

export const PublicationReceipt = z.object({
  version: z.literal(1),
  /** Demand that submitted the publication; null for a submission outside any demand. */
  demand_id: z.string().min(1).nullable(),
  group_id: z.string().min(1),
  revision_id: z.string().min(1),
  /** Assessment publish event written in the same transaction. Null only for receipts
   *  written before this owner (their event id was not recorded). */
  publication_event_id: z.string().min(1).nullable(),
  request_id: z.string().min(1),
  task_run_id: z.string().min(1).nullable(),
});
export type PublicationReceiptT = z.infer<typeof PublicationReceipt>;

export interface PublicationIdentity {
  demand_id?: string | null;
  request_id: string;
  task_run_id?: string | null;
}

/** Structural view of a submission receipt that can carry a publication. */
export interface PublicationCarrier {
  status?: string | null;
  publish_status?: string | null;
  group_id?: string | null;
  question_id?: string | null;
  revision_id?: string | null;
  publication_event_id?: string | null;
}

/**
 * Build the owner receipt for one committed submission, or null when the submission
 * wrote no publication event (`noop`/`withdrawn`/`conflict`/withheld). Publishing
 * statuses without full identity throw: the caller's transaction must roll back.
 */
export function publicationReceiptFromSubmit(
  receipt: PublicationCarrier,
  identity: PublicationIdentity,
): PublicationReceiptT | null {
  const status = receipt.publish_status;
  if (!PUBLISHING_STATUSES.includes(status as (typeof PUBLISHING_STATUSES)[number])) return null;
  const groupId = receipt.group_id ?? receipt.question_id ?? null;
  const revisionId = receipt.revision_id ?? null;
  const eventId = receipt.publication_event_id ?? null;
  if (groupId == null || revisionId == null || eventId == null) {
    throw new Error(
      `publication receipt is incomplete: status=${status} group=${groupId ?? 'none'} revision=${revisionId ?? 'none'} publication_event=${eventId ?? 'none'}`,
    );
  }
  return PublicationReceipt.parse({
    version: 1,
    demand_id: identity.demand_id ?? null,
    group_id: groupId,
    revision_id: revisionId,
    publication_event_id: eventId,
    request_id: identity.request_id,
    task_run_id: identity.task_run_id ?? null,
  });
}

function dedupe(receipts: readonly PublicationReceiptT[]): PublicationReceiptT[] {
  const byRevision = new Map<string, PublicationReceiptT>();
  for (const receipt of receipts) {
    if (!byRevision.has(receipt.revision_id)) byRevision.set(receipt.revision_id, receipt);
  }
  return [...byRevision.values()];
}

/** Receipts written before this owner did not carry the publication block. The legacy
 *  interpretation stays here only so pre-rollout rows remain readable; new writes never
 *  reach it. Missing revision identity on a legacy row stays unreadable — that is the
 *  historic defect this owner closes at the write site. */
function legacyReceipt(
  payload: Record<string, unknown>,
  taskRunId: string | null,
): PublicationReceiptT | null {
  const receipt = payload.receipt;
  if (receipt == null || typeof receipt !== 'object') return null;
  const record = receipt as Record<string, unknown>;
  const revisionId = record.revision_id;
  if (typeof revisionId !== 'string' || revisionId.length === 0) return null;
  const published =
    record.publish_status === 'published' || ('published' in record && record.published === true);
  if (!published) return null;
  const groupId =
    typeof record.group_id === 'string'
      ? record.group_id
      : typeof record.question_id === 'string'
        ? record.question_id
        : null;
  const requestId = typeof payload.request_id === 'string' ? payload.request_id : null;
  if (groupId == null || requestId == null) return null;
  return PublicationReceipt.parse({
    version: 1,
    demand_id: null,
    group_id: groupId,
    revision_id: revisionId,
    publication_event_id: null,
    request_id: requestId,
    task_run_id: taskRunId,
  });
}

function receiptsFromRows(
  rows: readonly { payload: unknown; taskRunId: string | null }[],
): PublicationReceiptT[] {
  const receipts: PublicationReceiptT[] = [];
  for (const row of rows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const block = payload.publication;
    if (block != null) {
      receipts.push(PublicationReceipt.parse(block));
      continue;
    }
    const legacy = legacyReceipt(payload, row.taskRunId);
    if (legacy != null) receipts.push(legacy);
  }
  return dedupe(receipts);
}

/** Publications produced by one preparer/worker segment. Spend settlement and
 *  continuation progress are segment-scoped: a prior segment's publication is not
 *  evidence that this segment published anything. */
export async function readTaskRunPublications(
  db: Db | Tx,
  taskRunId: string,
): Promise<readonly PublicationReceiptT[]> {
  const rows = await db
    .select({ payload: event.payload, taskRunId: event.task_run_id })
    .from(event)
    .where(
      and(
        eq(event.action, DRAFT_SUBMIT_ACTION),
        eq(event.outcome, 'success'),
        eq(event.task_run_id, taskRunId),
      ),
    )
    .orderBy(event.created_at, event.id);
  return receiptsFromRows(rows);
}

/**
 * Publications submitted under one demand, across routes. New receipts carry the demand
 * at write time. Legacy receipts have no demand binding; they are attributed only through
 * the preparer segments that wrote them, which is exactly the old run-scoped truth.
 */
export async function readDemandPublications(
  db: Db | Tx,
  demandId: string,
): Promise<readonly PublicationReceiptT[]> {
  const rows = await db
    .select({ payload: event.payload, taskRunId: event.task_run_id })
    .from(event)
    .where(
      and(
        eq(event.action, DRAFT_SUBMIT_ACTION),
        eq(event.outcome, 'success'),
        sql`(
          ${event.payload}->'publication'->>'demand_id' = ${demandId}
          OR (
            ${event.payload}->'publication' IS NULL
            AND ${event.task_run_id} IN (
              SELECT legacy.task_run_id FROM event legacy
              WHERE legacy.action = 'experimental:question_preparer'
                AND legacy.payload->'data'->'ticket'->>'demand_id' = ${demandId}
                AND legacy.task_run_id IS NOT NULL
            )
          )
        )`,
      ),
    )
    .orderBy(event.created_at, event.id);
  return receiptsFromRows(rows);
}

export interface DemandRepairTarget {
  question_id: string;
  revision_id: string;
  scoring_unit_id: string;
}

export type DemandRepairDecision =
  | { kind: 'permitted'; receipt: PublicationReceiptT }
  | { kind: 'refused'; reason: 'not_published_by_demand' | 'unit_not_in_revision' };

/**
 * Whether the demand may repair the target unit of the target revision. Reads the
 * demand's receipts and the revision inside the caller's transaction; takes no row
 * locks. A concurrent publication commits its event and receipt atomically, so it is
 * either wholly visible here or wholly absent; a later publication never invalidates a
 * permit issued against an earlier committed receipt.
 */
export async function authorizeDemandRepair(
  db: Db | Tx,
  demandId: string,
  target: DemandRepairTarget,
): Promise<DemandRepairDecision> {
  const receipts = await readDemandPublications(db, demandId);
  const receipt =
    receipts.find(
      (candidate) =>
        candidate.group_id === target.question_id && candidate.revision_id === target.revision_id,
    ) ?? null;
  if (receipt == null) return { kind: 'refused', reason: 'not_published_by_demand' };
  const [revision] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, target.revision_id))
    .limit(1);
  if (
    revision == null ||
    revision.group_id !== target.question_id ||
    !revision.scoring_basis.units.some((unit) => unit.scoring_unit_id === target.scoring_unit_id)
  )
    return { kind: 'refused', reason: 'unit_not_in_revision' };
  return { kind: 'permitted', receipt };
}
