// YUK-1548 slice 1 — drawing record lifecycle. Admission binds the ledger's
// authoritative source set INSIDE the dispatch transaction (lock → re-check →
// freeze epochs → insert → boss.send); every later transition is a CAS fenced
// by `version`, so a cancel/retract racing a running Sol job cannot leak a
// state the learner cancelled.

import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { newId } from '@/core/ids';
import { canonicalHash } from '@/core/migration/canonical';
import type { Db, Tx } from '@/db/client';
import { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';
import {
  type DrawingSourceEpoch,
  type DrawingStatus,
  assessment_issuance,
  assessment_submission,
  drawing,
  event,
  question,
  question_revision,
  source_asset,
} from '@/db/schema';
import {
  nativeAttemptOutcome,
  resolveVerdictsForAttempts,
  resolveVerdictsForNativeAttempts,
} from '@/kernel/read-models/assessment-verdict';
import {
  type PurposeSource,
  anyRestrictedLearnerSource,
  lineageQuestionIds,
  lockDerivationSources,
  readSourceUsageEpochs,
  sourceAllowsDerivation,
} from '@/kernel/read-models/usage-policy';
import { recordStudyAssistanceExposure } from '@/kernel/records/study-reference';
import type { DrawingBlockIssue, DrawingRequestOutcome } from '@/kernel/tools/drawing-request';
import type { TurnSourceLedger } from '@/kernel/tools/source-ledger';
import { getStartedBoss } from '@/server/boss/client';
import {
  DrawingImageInputError,
  loadDrawingImageBytes,
  readDrawingImageManifest,
} from './drawing-image-input';
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
  '这次绘图请求带上了未判定题目的答案内容，图上不能泄露它。改成只画题设本身的描述重新请求，或先作答并完成判定。';

/** Stable learner-facing detail per error_kind; raw diagnostics stay DB-side. */
const ERROR_DETAILS: Record<string, string> = {
  restricted_source: RESTRICTED_DETAIL,
  unjudged_source: UNJUDGED_DETAIL,
  source_image_unavailable: '原题图片的版本、公开范围或内容无法核验，这次绘图没有执行。',
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

function dedupeKey(
  sessionId: string,
  brief: string,
  alt: string,
  caption?: string,
  images = '',
): string {
  // \x00 separators keep concatenated fields unambiguous across boundary shifts.
  return createHash('sha256')
    .update(
      `${sessionId}\x00${brief}\x00${alt}\x00${caption ?? ''}${images ? `\x00${images}` : ''}`,
    )
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
 * The single authorization gate every post-admission path runs: concrete
 * sources re-checked, frozen usage epochs compared verbatim, and — when the
 * turn carried scoped projections — the whole-learner veto. Admission,
 * pre-send, publish, status reads, asset reads and redraw all funnel here so
 * no path can drift from the others.
 */
export async function drawingSourcesAuthorized(
  db: Db | Tx,
  row: Pick<
    DrawingRow,
    'sources' | 'source_epochs' | 'source_scoped' | 'session_id' | 'source_event_id'
  >,
  options: {
    lockSources?: boolean;
    requireCurrentDraft?: boolean;
    verifyImageBytes?: (
      manifest: Awaited<ReturnType<typeof readDrawingImageManifest>>,
    ) => Promise<unknown>;
  } = {},
): Promise<boolean> {
  try {
    // Study's root/source/issuance locks precede additional turn-ledger locks.
    const manifest = await readDrawingImageManifest(db, row, options.requireCurrentDraft ?? true);
    if (options.lockSources) {
      await db.transaction(async (tx) => {
        for (const source of row.sources) await lockDerivationSources(tx, source);
      });
    }
    if (row.sources.length > 0 && !(await recheckSources(db, row.sources)).ok) return false;
    if (row.source_epochs.length > 0 && !(await sourceEpochsIntact(db, row.source_epochs))) {
      return false;
    }
    if (row.source_scoped.length > 0 && (await anyRestrictedLearnerSource(db))) return false;
    await options.verifyImageBytes?.(manifest);
  } catch (error) {
    if (error instanceof DrawingImageInputError) return false;
    throw error;
  }
  return true;
}

/** Publish-time authorization failed inside the asset+ready transaction. */
export class DrawingAuthorizationError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'DrawingAuthorizationError';
  }
}

/**
 * Answer-leak gate: a question the learner has no committed judgment on may
 * not drive a drawing — brief/alt/caption could carry its answer. The question
 * set follows the provenance closure of every bound source, not only top-level
 * question nodes. Judged means: a real attempt event (`outcome` column set)
 * whose judgment survives — an effective (or execution-embedded) judge event
 * anchored by subject_id/caused_by_event_id — or a native
 * `experimental:assessment_attempt` whose group head projects an effective
 * verdict. `answerOnly` marks the turn itself as answer-bound (the reply is
 * already on the answer surface), so the gate would only re-derive it.
 */
async function unjudgedQuestionIds(
  db: Db | Tx,
  sources: readonly PurposeSource[],
): Promise<string[]> {
  const questionIds = await lineageQuestionIds(db, sources);
  if (questionIds.length === 0) return [];
  const judged = new Set<string>();
  const CHUNK = 64;
  for (let i = 0; i < questionIds.length; i += CHUNK) {
    const ids = questionIds.slice(i, i + CHUNK);
    const attempts = await db
      .select({ id: event.id, subject_id: event.subject_id })
      .from(event)
      .where(
        and(
          eq(event.action, 'attempt'),
          eq(event.subject_kind, 'question'),
          inArray(event.subject_id, ids),
          isNotNull(event.outcome),
        ),
      );
    const verdicts = await resolveVerdictsForAttempts(
      db,
      attempts.map((a) => a.id),
    );
    for (const attempt of attempts) {
      if (attempt.subject_id === null) continue;
      const verdict = verdicts.get(attempt.id);
      if (verdict?.effective !== null && verdict?.effective !== undefined) {
        judged.add(attempt.subject_id);
      } else if (verdict?.embedded !== null && verdict?.embedded !== undefined) {
        judged.add(attempt.subject_id);
      }
    }
    const native = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:assessment_attempt'),
          eq(event.subject_kind, 'question'),
          inArray(event.subject_id, ids),
        ),
      );
    const nativeVerdicts = await resolveVerdictsForNativeAttempts(db, native);
    for (const row of native) {
      if (row.subject_id === null) continue;
      const outcome = nativeAttemptOutcome(nativeVerdicts.get(row.id));
      if (outcome === 'success' || outcome === 'failure' || outcome === 'partial') {
        judged.add(row.subject_id);
      }
    }
  }
  return questionIds.filter((id) => !judged.has(id));
}

/**
 * Answer-content gate: a brief/alt/caption that quotes the reference answer of
 * an unjudged lineage question would leak it onto the figure, so it refuses.
 * Only a stored answer text anchors the comparison — a clean stem-only request
 * has no answer material to collide with and proceeds.
 */
async function carriesReferenceAnswer(
  db: Db | Tx,
  unjudged: readonly string[],
  input: { brief: string; alt: string; caption?: string },
): Promise<boolean> {
  if (unjudged.length === 0) return false;
  const requestText = `${input.brief}\n${input.alt}\n${input.caption ?? ''}`
    .toLowerCase()
    .replace(/\s+/g, '');
  if (requestText.length === 0) return false;
  const rows = await db
    .select({ reference_md: question.reference_md })
    .from(question)
    .where(inArray(question.id, [...unjudged]));
  for (const row of rows) {
    const answer = (row.reference_md ?? '').toLowerCase().replace(/\s+/g, '');
    // A substantive answer fragment — not a one-character coincidence — is a leak.
    if (answer.length >= 8 && requestText.includes(answer)) return true;
  }
  return false;
}

/**
 * The uniquely-open issuance covering an unjudged lineage question — the same
 * group/part coordinate resolution reveal_answer uses. Returns the issuance id
 * only when exactly one open issuance resolves; zero, multiple, or
 * all-submitted coordinates return undefined so the drawing proceeds and only
 * the exposure record is skipped (never fabricated).
 */
async function uniqueOpenIssuanceForQuestion(
  db: Db | Tx,
  questionId: string,
): Promise<{ issuance_id: string; question_id: string } | undefined> {
  const issuances = await db
    .select({
      issuance_id: assessment_issuance.issuance_id,
      issued_at: assessment_issuance.issued_at,
    })
    .from(assessment_issuance)
    .innerJoin(
      question_revision,
      eq(assessment_issuance.revision_id, question_revision.revision_id),
    )
    .where(
      sql`(${question_revision.group_id} = ${questionId} or ${assessment_issuance.part_ids} ? ${questionId})`,
    )
    .orderBy(desc(assessment_issuance.issued_at));
  if (issuances.length === 0) return undefined;
  const submitted = new Set(
    (
      await db
        .select({ issuance_id: assessment_submission.issuance_id })
        .from(assessment_submission)
        .where(
          inArray(
            assessment_submission.issuance_id,
            issuances.map((row) => row.issuance_id),
          ),
        )
    ).map((row) => row.issuance_id),
  );
  const open = issuances.filter((row) => !submitted.has(row.issuance_id));
  if (open.length !== 1) return undefined;
  return { issuance_id: open[0].issuance_id, question_id: questionId };
}

/**
 * Transactional send: same stable id per (drawing, dispatch generation), so a
 * repeated send inside one tx collapses and a null result is adopted only
 * when the existing job carries this drawing.
 */
export async function sendDrawingJob(
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
  return ctx.db.transaction(async (tx) => {
    let imageManifest: Awaited<ReturnType<typeof readDrawingImageManifest>>;
    try {
      imageManifest = await readDrawingImageManifest(tx, {
        session_id: sessionId,
        sources: [...snapshot.sources],
        source_event_id: ctx.causedByEventId ?? null,
      });
    } catch (error) {
      if (!(error instanceof DrawingImageInputError)) throw error;
      return {
        status: 'unavailable',
        issues: [{ code: error.code, path: '/brief', detail: error.message }],
      };
    }
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

    // Answer-content gate: outside the restricted answer-reveal surface, an
    // unjudged bound question may still drive a drawing — but only when the
    // requested brief/alt/caption carries none of its reference answer. An
    // answer-bearing request keeps the typed refusal. On a clean admission the
    // drawing counts as one study assistance against the uniquely-open
    // issuance; zero/multiple/all-submitted coordinates skip only the record.
    let assistanceIssuance: { issuance_id: string; question_id: string } | undefined;
    if (!ctx.answerOnly) {
      const unjudged = await unjudgedQuestionIds(tx, snapshot.sources);
      if (unjudged.length > 0) {
        if (await carriesReferenceAnswer(tx, unjudged, input)) {
          return {
            status: 'unavailable',
            issues: [{ code: 'unjudged_source', path: '/brief', detail: UNJUDGED_DETAIL }],
          };
        }
        // Only a single unjudged question yields a single recording coordinate;
        // a multi-question unjudged set has no unique "question being drawn".
        assistanceIssuance =
          unjudged.length === 1 ? await uniqueOpenIssuanceForQuestion(tx, unjudged[0]) : undefined;
      }
    }

    // Record the single study-assistance exposure for this admitted request
    // before the drawing insert, atomically inside the dispatch transaction.
    if (assistanceIssuance) {
      await recordStudyAssistanceExposure(tx, {
        issuanceId: assistanceIssuance.issuance_id,
        questionId: assistanceIssuance.question_id,
        kind: 'chat_context',
        impact: 'unknown',
        actorRef: ctx.actorRef,
        contentDigest: `sha256:${canonicalHash({
          brief: input.brief,
          alt: input.alt,
          caption: input.caption ?? null,
        })}`,
      });
    }

    const key = dedupeKey(
      sessionId,
      input.brief,
      input.alt,
      input.caption,
      imageManifest.length ? JSON.stringify(imageManifest) : '',
    );

    // Same-content dedupe: a `ready` row holds the key without a TTL (it is
    // served, not waited on); an expired wait row still occupies the partial
    // unique index, so it is flipped to `expired` in the same atomic pass —
    // after which the index slot is free for this insert.
    await tx.execute(sql`
      UPDATE drawing SET status = 'expired', version = version + 1,
        error_kind = 'expired', updated_at = now()
      WHERE dedupe_key = ${key}
        AND status IN ('queued', 'running', 'waiting_quota', 'waiting_login')
        AND expires_at <= now()`);
    const id = `drw_${newId()}`;
    const expiresAt = new Date(Date.now() + DRAWING_TTL_MS);
    const [inserted] = await tx
      .insert(drawing)
      .values({
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
        source_scoped: [...snapshot.scoped],
        source_epochs,
        copilot_task_run_id: ctx.taskRunId,
        ...(ctx.causedByEventId !== undefined ? { source_event_id: ctx.causedByEventId } : {}),
        expires_at: expiresAt,
      })
      .onConflictDoNothing({
        target: drawing.dedupe_key,
        where: sql`${drawing.status} IN ('queued','running','ready','waiting_quota','waiting_login')`,
      })
      .returning({ id: drawing.id });
    if (!inserted) {
      // A concurrent same-content request (or a live ready row past its wait
      // TTL) won the dedupe index — adopt that winner, no failure-path read.
      const [winner] = await tx
        .select({ id: drawing.id })
        .from(drawing)
        .where(
          and(eq(drawing.dedupe_key, key), inArray(drawing.status, [...DRAWING_LIVE_STATUSES])),
        );
      if (!winner) throw new Error('drawing dedupe conflict resolved to no live row');
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
 * Authorization fence shared by every learner-facing read/serve — the same
 * `drawingSourcesAuthorized` gate as admission/publish (sources + epochs +
 * scoped veto). A deny ends the row and the asset is never served again.
 */
async function fenceSourceAndEpoch(db: Db, row: DrawingRow): Promise<DrawingRow> {
  if (row.status === 'expired') return row;
  if (
    await drawingSourcesAuthorized(db, row, {
      requireCurrentDraft: false,
      verifyImageBytes: async (manifest) => {
        if (row.status === 'ready') await loadDrawingImageBytes(db, manifest);
      },
    })
  ) {
    return row;
  }
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
  if (!(await drawingSourcesAuthorized(db, row))) {
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
