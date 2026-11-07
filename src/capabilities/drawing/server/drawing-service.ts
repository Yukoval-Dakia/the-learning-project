// YUK-1548 slice 1 — drawing record lifecycle. Admission binds the ledger's
// authoritative source set INSIDE the dispatch transaction (lock → re-check →
// freeze epochs → insert → boss.send); every later transition is a CAS fenced
// by `version`, so a cancel/retract racing a running Sol job cannot leak a
// state the learner cancelled.

import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';
import { type DrawingSourceEpoch, type DrawingStatus, drawing, source_asset } from '@/db/schema';
import {
  type PurposeSource,
  anyRestrictedLearnerSource,
  lockDerivationSources,
  readSourceUsageEpochs,
  sourceAllowsDerivation,
} from '@/kernel/read-models/usage-policy';
import type { DrawingBlockIssue, DrawingRequestOutcome } from '@/kernel/tools/drawing-request';
import type { TurnSourceLedger } from '@/kernel/tools/source-ledger';
import { getStartedBoss } from '@/server/boss/client';
import {
  DRAWING_EXPIRABLE_STATUSES,
  DRAWING_LIVE_STATUSES,
  DRAWING_REDRAWABLE_STATUSES,
} from './drawing-state';

export type { DrawingBlockIssue, DrawingRequestOutcome } from '@/kernel/tools/drawing-request';

export const DRAWING_JOB_NAME = 'drawing_generate';
/** Whole wait lifecycle is capped; claim and read both fence on it. `ready`
 * is excluded — a served drawing only ends through retraction or action. */
const DRAWING_TTL_MS = 24 * 60 * 60 * 1000;
export const DRAWING_QUOTA_RETRY_MS = 15 * 60 * 1000;
export const DRAWING_LOGIN_RETRY_MS = 60 * 60 * 1000;

export type DrawingBoss = Pick<Awaited<ReturnType<typeof getStartedBoss>>, 'send' | 'getJobById'>;

const RESTRICTED_DETAIL =
  '这次请求读到的资料无法完整核验来源，或来源不允许派生绘图。已拒画——可以改成描述性的回答，或明确只用本轮消息本身的内容重新请求。';
const UNJUDGED_DETAIL =
  '这次绘图涉及的题目还没有判定结果，图上不能带未判定的答案。先作答并完成判定，或改用不含答案的描述重新请求。';

/** Stable learner-facing detail per error_kind; raw diagnostics stay DB-side. */
const ERROR_DETAILS: Record<string, string> = {
  restricted_source: RESTRICTED_DETAIL,
  unjudged_source: UNJUDGED_DETAIL,
  quota: '绘图额度暂时用尽，正在等待恢复；恢复后自动继续，不需要重新请求。',
  login: '绘图服务登录失效，正在等待重新登录；恢复后自动继续，不需要重新请求。',
  provider: '绘图服务暂时不可用，这次生成没有成功。可以手动重画。',
  config: '绘图服务配置不正确，这次生成没有执行。请等待修复后重画。',
  output: '绘图服务的返回无法解析成可用的图，这次生成没有成功。可以手动重画。',
  asset: '绘制完成的图在保存时失败了，这次生成没有完成。可以手动重画。',
  cancelled: '已取消。',
  retracted: '相关来源已被撤回，这张图不再可用。',
  expired: '这次绘图请求已过期。',
  timeout: '绘图超时没有完成。',
};

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
  // \x00 separators keep concatenated fields unambiguous across boundary shifts.
  return createHash('sha256')
    .update(`${sessionId}\x00${brief}\x00${alt}\x00${caption ?? ''}`)
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
 * Frozen-epoch fence: every document epoch bound at admission must still read
 * the same string. A changed epoch means the source's usage generation moved —
 * treat exactly like retraction (the frozen set no longer describes it).
 */
export async function sourceEpochsIntact(
  db: Db | Tx,
  frozen: readonly DrawingSourceEpoch[],
): Promise<boolean> {
  for (const entry of frozen) {
    const current = await readSourceUsageEpochs(db, { kind: 'document', id: entry.document_id });
    if (current[entry.document_id] !== entry.usage_epoch) return false;
  }
  return true;
}

/**
 * Answer-layer gate: a bound question the learner has not been judged on may
 * not drive a drawing — the model could leak its answer into brief/alt/caption.
 * `answerOnly` turns are the post-judgment reveal surface and skip this gate.
 */
async function unjudgedQuestionIds(
  db: Db | Tx,
  sources: readonly PurposeSource[],
): Promise<string[]> {
  const questionIds = sources.filter((s) => s.kind === 'question').map((s) => s.id as string);
  if (questionIds.length === 0) return [];
  const rows = await db.execute<{ id: string }>(sql`
    SELECT q.id FROM question q WHERE q.id IN (${sql.join(
      questionIds.map((id) => sql`${id}`),
      sql`, `,
    )}) AND NOT EXISTS (
      SELECT 1 FROM event e WHERE e.subject_kind = 'question' AND e.subject_id = q.id
        AND (e.action = 'judge' OR (e.action = 'attempt' AND e.payload->>'outcome' IS NOT NULL))
    )`);
  return rows.map((row) => row.id);
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

function restrictedOutcome(): DrawingRequestOutcome {
  return {
    status: 'unavailable',
    issues: [{ code: 'restricted_source', path: '/brief', detail: RESTRICTED_DETAIL }],
  };
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
    answerOnly?: boolean;
  },
  input: { brief: string; alt: string; caption?: string },
  deps: { boss?: () => Promise<DrawingBoss> } = {},
): Promise<DrawingRequestOutcome> {
  const snapshot = ctx.ledger?.snapshot();
  if (!ctx.sessionId || !snapshot?.complete) return restrictedOutcome();
  // Hoisted: closure narrows do not survive into the transaction callback.
  const sessionId = ctx.sessionId;
  const boss = await (deps.boss ?? getStartedBoss)();
  const key = dedupeKey(sessionId, input.brief, input.alt, input.caption);
  return ctx.db.transaction(async (tx) => {
    // Lock source documents FOR SHARE, then re-derive authorization and freeze
    // epochs — the stored set is what the send gate re-checks, never model claims.
    for (const source of snapshot.sources) await lockDerivationSources(tx, source);
    const verdict = await recheckSources(tx, snapshot.sources);
    if (!verdict.ok) return restrictedOutcome();
    // Scoped projections (learner-state header, proposal feedback) verify
    // against the global veto set instead of an enumerable row list.
    if (snapshot.scoped.length > 0 && (await anyRestrictedLearnerSource(tx))) {
      return restrictedOutcome();
    }
    const epochMap: Record<string, string> = {};
    for (const source of snapshot.sources)
      Object.assign(epochMap, await readSourceUsageEpochs(tx, source));
    const source_epochs: DrawingSourceEpoch[] = Object.entries(epochMap).map(
      ([document_id, usage_epoch]) => ({ document_id, usage_epoch }),
    );

    // Answer-layer gate: outside the restricted answer-reveal surface, a bound
    // question with no judged attempt may not drive a drawing.
    if (!ctx.answerOnly) {
      const unjudged = await unjudgedQuestionIds(tx, snapshot.sources);
      if (unjudged.length > 0) {
        return {
          status: 'unavailable',
          issues: [{ code: 'unjudged_source', path: '/brief', detail: UNJUDGED_DETAIL }],
        };
      }
    }

    // Same live drawing for the same content → dedupe onto it (idempotent by
    // content); a terminal or past-TTL row frees the key.
    const [existing] = await tx
      .select({ id: drawing.id })
      .from(drawing)
      .where(
        and(
          eq(drawing.dedupe_key, key),
          inArray(drawing.status, [...DRAWING_LIVE_STATUSES]),
          sql`${drawing.expires_at} > now()`,
        ),
      );
    if (existing) return { status: 'ready', drawing_id: existing.id };

    const id = `drw_${newId()}`;
    const expiresAt = new Date(Date.now() + DRAWING_TTL_MS);
    try {
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
    } catch (error) {
      // Concurrent same-content request won the partial unique index — adopt it.
      if ((error as { code?: string }).code !== '23505') throw error;
      const [winner] = await tx
        .select({ id: drawing.id })
        .from(drawing)
        .where(
          and(
            eq(drawing.dedupe_key, key),
            inArray(drawing.status, [...DRAWING_LIVE_STATUSES]),
            sql`${drawing.expires_at} > now()`,
          ),
        );
      if (!winner) throw error;
      return { status: 'ready', drawing_id: winner.id };
    }
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
    error:
      row.error_kind != null
        ? {
            kind: row.error_kind,
            detail: ERROR_DETAILS[row.error_kind] ?? '这次绘图没有完成。',
          }
        : null,
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

/**
 * Fence a wait-lifecycle row past its TTL. `ready` is NOT expirable on the
 * clock — only retraction ends it. A lost CAS re-reads the winner's row; it
 * never fabricates a state.
 */
async function fenceExpiry(db: Db, row: DrawingRow): Promise<DrawingRow> {
  if (!(DRAWING_EXPIRABLE_STATUSES as readonly string[]).includes(row.status)) return row;
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
  if (updated) return updated;
  const [current] = await db.select().from(drawing).where(eq(drawing.id, row.id));
  return current ?? row;
}

/**
 * Retraction + epoch fence shared by every learner-facing read/serve: a bound
 * source that stopped allowing derivation — or whose usage epoch moved — ends
 * the row and the asset is never served again. Returns the row to serve.
 */
async function fenceSourceAndEpoch(db: Db, row: DrawingRow): Promise<DrawingRow> {
  if (row.status === 'expired') return row;
  const sourceDenied = row.sources.length > 0 && !(await recheckSources(db, row.sources)).ok;
  const epochMoved =
    row.source_epochs.length > 0 && !(await sourceEpochsIntact(db, row.source_epochs));
  if (!sourceDenied && !epochMoved) return row;
  const [updated] = await db
    .update(drawing)
    .set({
      status: 'expired',
      version: row.version + 1,
      error_kind: 'retracted',
      error_detail: 'a bound source stopped allowing derivation or changed usage epoch',
      updated_at: new Date(),
    })
    .where(and(eq(drawing.id, row.id), eq(drawing.version, row.version)))
    .returning();
  if (updated) return updated;
  const [current] = await db.select().from(drawing).where(eq(drawing.id, row.id));
  return current ?? { ...row, status: 'expired' as const };
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
  row = await fenceSourceAndEpoch(db, row);
  return project(row);
}

export interface DrawingAssetView {
  asset_id: string;
  storage_key: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
}

/**
 * Owner-scoped asset authorization: the SAME checks as the status read —
 * ownership, expiry fence, retraction/epoch recheck — before any bytes or 304
 * leave the server. The generic /api/assets content route refuses
 * drawing-owned assets outright, so this is the only serving path.
 */
export async function readDrawingAsset(
  db: Db,
  id: string,
  sessionId: string,
): Promise<DrawingAssetView | null> {
  let row = await loadOwned(db, id, sessionId);
  if (!row) return null;
  row = await fenceExpiry(db, row);
  row = await fenceSourceAndEpoch(db, row);
  if (row.status !== 'ready' || !row.last_ready_asset_id) return null;
  const [asset] = await db
    .select({
      asset_id: source_asset.id,
      storage_key: source_asset.storage_key,
      mime_type: source_asset.mime_type,
      byte_size: source_asset.byte_size,
      sha256: source_asset.sha256,
    })
    .from(source_asset)
    .where(eq(source_asset.id, row.last_ready_asset_id))
    .limit(1);
  return asset ?? null;
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
 * bumped generation. Sources and frozen epochs are re-verified first;
 * last_ready_* survives until a new success replaces it. Idempotent: a repeat
 * call on a non-redrawable live row returns the current state unchanged.
 */
export async function redrawDrawing(
  db: Db,
  id: string,
  sessionId: string,
  deps: { boss?: () => Promise<DrawingBoss> } = {},
): Promise<DrawingStatusView | { status: 'refused'; issues: DrawingBlockIssue[] } | null> {
  const row = await loadOwned(db, id, sessionId);
  if (!row) return null;
  if (!(DRAWING_REDRAWABLE_STATUSES as readonly string[]).includes(row.status)) {
    return project(row);
  }
  if (
    !(await recheckSources(db, row.sources)).ok ||
    !(await sourceEpochsIntact(db, row.source_epochs))
  ) {
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
