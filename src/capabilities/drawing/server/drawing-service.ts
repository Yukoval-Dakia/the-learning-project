// YUK-1548 slice 1 — drawing record lifecycle. Admission binds the ledger's
// authoritative source set INSIDE the dispatch transaction (lock → re-check →
// freeze epochs → insert → boss.send); every later transition is a CAS fenced
// by `version`, so a cancel/retract racing a running Sol job cannot leak a
// state the learner cancelled.

import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';
import {
  DRAWING_LIVE_STATUSES,
  DRAWING_REDRAWABLE_STATUSES,
  type DrawingSourceEpoch,
  type DrawingStatus,
  drawing,
} from '@/db/schema';
import type { PurposeSource } from '@/kernel/read-models/usage-policy';
import {
  lockDerivationSources,
  readSourceUsageEpochs,
  sourceAllowsDerivation,
} from '@/kernel/read-models/usage-policy';
import type { DrawingBlockIssue, DrawingRequestOutcome } from '@/kernel/tools/drawing-request';
import type { TurnSourceLedger } from '@/kernel/tools/source-ledger';
import { getStartedBoss } from '@/server/boss/client';

export type { DrawingBlockIssue, DrawingRequestOutcome } from '@/kernel/tools/drawing-request';

export const DRAWING_JOB_NAME = 'drawing_generate';
/** Whole wait lifecycle is capped; claim and read both fence on it. */
const DRAWING_TTL_MS = 24 * 60 * 60 * 1000;
export const DRAWING_QUOTA_RETRY_MS = 15 * 60 * 1000;
export const DRAWING_LOGIN_RETRY_MS = 60 * 60 * 1000;

export type DrawingBoss = Pick<Awaited<ReturnType<typeof getStartedBoss>>, 'send' | 'getJobById'>;

const RESTRICTED_DETAIL =
  '这次请求读到的资料无法完整核验来源，或来源不允许派生绘图。已拒画——可以改成描述性的回答，或明确只用本轮消息本身的内容重新请求。';

export function drawingBossJobId(drawingId: string, version: number): string {
  // pgboss.job.id is uuid-typed: derive a stable name-based UUID the way
  // copilot's dispatch does — one deterministic id per (drawing, generation).
  const bytes = createHash('sha256')
    .update(`drwgen:${drawingId}:v${version}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function dedupeKey(sessionId: string, brief: string, alt: string, caption?: string): string {
  return createHash('sha256')
    .update(`${sessionId}${brief}${alt}${caption ?? ''}`)
    .digest('hex');
}

/** Exported for the job handler's pre-send re-check (same predicate, no cache). */
export async function recheckSources(
  db: Db | Tx,
  sources: readonly PurposeSource[],
): Promise<{ ok: boolean; denied: PurposeSource[] }> {
  const denied: PurposeSource[] = [];
  for (const source of sources) {
    if (!(await sourceAllowsDerivation(db, source))) denied.push(source);
  }
  return { ok: denied.length === 0, denied };
}

/**
 * Transactional send: same stable id per (drawing, dispatch generation), so a
 * repeated send inside one tx collapses and a null result is adopted only
 * when the existing job carries this drawing.
 */
async function sendDrawingJob(
  tx: Tx,
  boss: DrawingBoss,
  drawingId: string,
  version: number,
  startAfter?: Date,
): Promise<void> {
  const adapter = fromPgBossDrizzleTx(tx);
  const id = drawingBossJobId(drawingId, version);
  const sent = await boss.send(
    DRAWING_JOB_NAME,
    { drawing_id: drawingId },
    {
      id,
      db: adapter,
      ...(startAfter ? { startAfter } : {}),
    },
  );
  if (sent) return;
  const existing = await boss.getJobById(DRAWING_JOB_NAME, id, { db: adapter });
  const data = existing?.data as { drawing_id?: string } | undefined;
  if (data?.drawing_id !== drawingId) {
    throw new Error(`drawing ${drawingId} dispatch id ${id} collides with a foreign job`);
  }
}

/**
 * compose_block 'drawing' entry point. Refuses (typed restricted_source, no
 * row) when the turn's source set is not provably complete or any source
 * denies derivation. An empty set is admissible only because the ledger
 * itself is the completeness proof — no unbound context, no read tools.
 */
export async function requestDrawing(
  ctx: {
    db: Db;
    sessionId: string | undefined;
    taskRunId: string;
    causedByEventId?: string;
    actorRef: string;
    ledger?: TurnSourceLedger;
  },
  input: { brief: string; alt: string; caption?: string },
  deps: { boss?: () => Promise<DrawingBoss> } = {},
): Promise<DrawingRequestOutcome> {
  const snapshot = ctx.ledger?.snapshot();
  if (!ctx.sessionId || !snapshot?.complete) {
    return {
      status: 'unavailable',
      issues: [{ code: 'restricted_source', path: '/brief', detail: RESTRICTED_DETAIL }],
    };
  }
  // Hoisted: closure narrows do not survive into the transaction callback.
  const sessionId = ctx.sessionId;
  const boss = await (deps.boss ?? getStartedBoss)();
  const key = dedupeKey(sessionId, input.brief, input.alt, input.caption);
  return ctx.db.transaction(async (tx) => {
    // Lock source documents FOR SHARE, then re-derive authorization and freeze
    // epochs — the stored set is what the send gate re-checks, never model claims.
    for (const source of snapshot.sources) await lockDerivationSources(tx, source);
    const verdict = await recheckSources(tx, snapshot.sources);
    if (!verdict.ok) {
      return {
        status: 'unavailable',
        issues: [{ code: 'restricted_source', path: '/brief', detail: RESTRICTED_DETAIL }],
      };
    }
    const epochMap: Record<string, string> = {};
    for (const source of snapshot.sources)
      Object.assign(epochMap, await readSourceUsageEpochs(tx, source));
    const source_epochs: DrawingSourceEpoch[] = Object.entries(epochMap).map(
      ([document_id, usage_epoch]) => ({ document_id, usage_epoch: Number(usage_epoch) || 0 }),
    );

    // Same live drawing for the same content → dedupe onto it (idempotent by
    // content); a terminal row frees the key via the partial unique index.
    const [existing] = await tx
      .select({ id: drawing.id })
      .from(drawing)
      .where(and(eq(drawing.dedupe_key, key), inArray(drawing.status, [...DRAWING_LIVE_STATUSES])));
    if (existing) return { status: 'ready', drawing_id: existing.id };

    const id = `drw_${newId()}`;
    const expiresAt = new Date(Date.now() + DRAWING_TTL_MS);
    await tx.insert(drawing).values({
      id,
      session_id: sessionId,
      dedupe_key: key,
      status: 'queued',
      version: 1,
      attempt: 1,
      brief: input.brief,
      alt: input.alt,
      ...(input.caption !== undefined ? { caption: input.caption } : {}),
      sources: [...snapshot.sources],
      source_complete: true,
      source_epochs,
      copilot_task_run_id: ctx.taskRunId,
      ...(ctx.causedByEventId !== undefined ? { source_event_id: ctx.causedByEventId } : {}),
      expires_at: expiresAt,
    });
    await sendDrawingJob(tx, boss, id, 1);
    return { status: 'ready', drawing_id: id };
  });
}

export interface DrawingStatusView {
  drawing_id: string;
  status: DrawingStatus;
  alt: string;
  caption: string | null;
  asset: { asset_id: string; digest: string; mime_type: 'image/svg+xml' } | null;
  error: { kind: string; detail: string } | null;
  retry_at: string | null;
  attempt: number;
  version: number;
  expires_at: string;
}

type DrawingRow = typeof drawing.$inferSelect;

function project(row: DrawingRow): DrawingStatusView {
  const asset =
    row.last_ready_asset_id && row.last_ready_asset_digest && row.status !== 'expired'
      ? {
          asset_id: row.last_ready_asset_id,
          digest: row.last_ready_asset_digest,
          mime_type: 'image/svg+xml' as const,
        }
      : null;
  return {
    drawing_id: row.id,
    status: row.status,
    alt: row.alt,
    caption: row.caption,
    asset,
    error: row.error_kind != null ? { kind: row.error_kind, detail: row.error_detail ?? '' } : null,
    retry_at: row.retry_at?.toISOString() ?? null,
    attempt: row.attempt,
    version: row.version,
    expires_at: row.expires_at.toISOString(),
  };
}

async function loadOwned(db: Db, id: string, sessionId: string): Promise<DrawingRow | null> {
  const [row] = await db.select().from(drawing).where(eq(drawing.id, id));
  if (!row || row.session_id !== sessionId) return null;
  return row;
}

/** Flip a live row past its TTL; returns the row as the caller should see it. */
async function fenceExpiry(db: Db, row: DrawingRow): Promise<DrawingRow> {
  if (!(DRAWING_LIVE_STATUSES as readonly string[]).includes(row.status)) return row;
  if (row.expires_at.getTime() > Date.now()) return row;
  const [updated] = await db
    .update(drawing)
    .set({
      status: 'expired',
      version: row.version + 1,
      error_kind: 'expired',
      updated_at: new Date(),
    })
    .where(and(eq(drawing.id, row.id), eq(drawing.version, row.version)))
    .returning();
  return updated ?? { ...row, status: 'expired' };
}

/**
 * Owner-scoped status read. Retraction re-check happens here: any source that
 * stopped allowing derivation flips the row to expired, and the derived asset
 * is never served again.
 */
export async function readDrawingStatus(
  db: Db,
  id: string,
  sessionId: string,
): Promise<DrawingStatusView | null> {
  let row = await loadOwned(db, id, sessionId);
  if (!row) return null;
  row = await fenceExpiry(db, row);
  if (row.status !== 'expired' && row.sources.length > 0) {
    const verdict = await recheckSources(db, row.sources);
    if (!verdict.ok) {
      const [updated] = await db
        .update(drawing)
        .set({
          status: 'expired',
          version: row.version + 1,
          error_kind: 'retracted',
          error_detail: 'a bound source stopped allowing derivation',
          updated_at: new Date(),
        })
        .where(and(eq(drawing.id, row.id), eq(drawing.version, row.version)))
        .returning();
      row = updated ?? { ...row, status: 'expired', error_kind: 'retracted' };
    }
  }
  return project(row);
}

/** Idempotent cancel: live → cancelled; terminal rows return their state. */
export async function cancelDrawing(
  db: Db,
  id: string,
  sessionId: string,
): Promise<DrawingStatusView | null> {
  const row = await loadOwned(db, id, sessionId);
  if (!row) return null;
  if (!(DRAWING_LIVE_STATUSES as readonly string[]).includes(row.status)) return project(row);
  const [updated] = await db
    .update(drawing)
    .set({
      status: 'cancelled',
      version: row.version + 1,
      error_kind: 'cancelled',
      updated_at: new Date(),
    })
    .where(
      and(
        eq(drawing.id, row.id),
        eq(drawing.version, row.version),
        inArray(drawing.status, [...DRAWING_LIVE_STATUSES]),
      ),
    )
    .returning();
  // A concurrent transition won the CAS; re-read the winner's state.
  return project(updated ?? (await db.select().from(drawing).where(eq(drawing.id, id)))[0]);
}

/**
 * Manual redraw: terminal (ready/failed/cancelled/expired) → queued with a
 * bumped generation. Sources are re-verified first; last_ready_* survives
 * until a new success replaces it. Idempotent: a repeat call on a live row
 * returns the current state unchanged.
 */
export async function redrawDrawing(
  db: Db,
  id: string,
  sessionId: string,
  deps: { boss?: () => Promise<DrawingBoss> } = {},
): Promise<DrawingStatusView | { status: 'refused'; issues: DrawingBlockIssue[] } | null> {
  const row = await loadOwned(db, id, sessionId);
  if (!row) return null;
  if ((DRAWING_LIVE_STATUSES as readonly string[]).includes(row.status)) return project(row);
  const verdict = await recheckSources(db, row.sources);
  if (!verdict.ok) {
    return {
      status: 'refused',
      issues: [{ code: 'restricted_source', path: '', detail: RESTRICTED_DETAIL }],
    };
  }
  const boss = await (deps.boss ?? getStartedBoss)();
  return db.transaction(async (tx) => {
    const nextVersion = row.version + 1;
    const [updated] = await tx
      .update(drawing)
      .set({
        status: 'queued',
        version: nextVersion,
        attempt: row.attempt + 1,
        error_kind: null,
        error_detail: null,
        retry_at: null,
        sol_task_run_id: null,
        expires_at: new Date(Date.now() + DRAWING_TTL_MS),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(drawing.id, row.id),
          eq(drawing.version, row.version),
          inArray(drawing.status, [...DRAWING_REDRAWABLE_STATUSES]),
        ),
      )
      .returning();
    if (!updated) {
      const [current] = await tx.select().from(drawing).where(eq(drawing.id, row.id));
      return project(current);
    }
    await sendDrawingJob(tx, boss, id, nextVersion);
    return project(updated);
  });
}
