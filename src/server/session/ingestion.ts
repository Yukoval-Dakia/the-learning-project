import { createId } from '@paralleldrive/cuid2';
import { type SQL, and, asc, eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import type { BBoxT, FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { learning_session, question_block } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { USAGE_POLICY_PROVENANCE_KEY } from '@/kernel/read-models/usage-policy';
import { acquireLearningStateWriteLock } from '@/server/advisory-locks';
import { writeJobEvent } from '@/server/events/writer';
import { writeQuestionBlockCreateEvent } from '@/server/projections/question_block-create-event';
import { type DocxExternalRefOmissionFacts, EXTERNAL_REF_OMISSION_NOTICE } from './docx-omission';
import { assertFromState } from './guards';

// LearningSession.Ingestion.* — Phase 1c.1 Step 5 evolution of the ADR-0005
// single-owner ingestion-session module. Writes to `learning_session(type='ingestion')`
// (NOT legacy `ingestion_session`). All status transitions go through this module.
//
// State machine (unchanged from ADR-0005):
//   uploaded → queued → extracting → extracted | partial | failed
//   extracted / partial → reviewed → imported (terminal)
//   failed → retry → queued
//
// Each transition writes a `job_events` row (Sub 0c pg-boss SSE plumbing).
// Extract-flavored transitions additionally write a domain `event` row via
// `writeSessionEvent` (Step 5 / ADR-0006 v2). State-only transitions
// (initiateUpload / enqueueExtraction / markExtractionStarted / markReviewed /
// commitImport) write NO domain event — reconsider in Phase 1d.

const SESSION_TABLE = 'ingestion_session' as const;
export const IMPORTABLE_SESSION_STATUSES = ['extracted', 'reviewed'] as const;
const OPERATION_DISPATCH_SINGLETON_SECONDS = 24 * 60 * 60;

// job_events business_table label kept as 'ingestion_session' for SSE replay
// continuity (old job_events rows already carry that label). Renaming would
// require migration; deferred to Phase 1d if/when a session-type-agnostic
// SSE channel is needed.

import { writeSessionEvent } from './events';

// ---------- Load helpers ----------
//
// Filters by `type='ingestion'` so a row of another type can NEVER be loaded by
// an ingestion transition. This is the structural invariant that lets
// learning_session host multiple session types without cross-type mutation.

async function loadSessionForUpdate(
  tx: Db | Tx,
  sessionId: string,
): Promise<{ status: string; warnings: string[]; source_document_id: string | null } | null> {
  const rows = await tx.execute<{
    status: string;
    warnings: string[] | null;
    source_document_id: string | null;
  }>(
    sql`SELECT status, warnings, source_document_id FROM learning_session WHERE id = ${sessionId} AND type = 'ingestion' FOR UPDATE`,
  );
  // postgres-js returns array of objects
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status,
    warnings: row.warnings ?? [],
    source_document_id: row.source_document_id,
  };
}

// ---------- enqueueExtraction ----------

export type EnqueueExtractionParams = {
  db: Db;
  boss: PgBoss;
  sessionId: string;
  /** Canonical ingestion operation handle; legacy callers omit it unchanged. */
  operationId?: string;
  /**
   * YUK-1522 budget gate — optional in-tx hook invoked by `enqueueAgentRun`
   * as the FIRST step of the dispatch transaction (before the row lock and
   * the from-state assert). It must run first so its global advisory lock is
   * acquired before any learning_session row lock — keeping a single lock
   * order (budget lock → session rows) and preventing cross-session
   * deadlocks when the gate lazily settles other sessions' grants. Throwing
   * aborts the whole dispatch (no flip, no job); its writes commit
   * atomically with the flip. `enqueueExtraction` does not invoke it
   * (OCR lane is ungated).
   */
  beforeTransition?: (tx: Tx) => Promise<void>;
};

/**
 * uploaded | failed → queued. Posts a `tencent_ocr_extract` pg-boss job.
 *
 * **Ghost-job risk** (PR #30 review #2, preserved):
 * `boss.send` uses pg-boss's own connection pool, writing to `pgboss.*` tables
 * outside our drizzle tx. If boss.send succeeds but our tx commit fails (rare:
 * network blip), we get an "enqueued job but session.status not flipped to queued"
 * orphan.
 *
 * Recovery: when the handler later calls `markExtractionStarted`, it sees the
 * session is not 'queued' and throws ApiError(409). The handler's internal
 * markFailedAndLogCost catches, writes a cost_ledger failure, and rethrows —
 * pg-boss archives the job. No data corruption; one archived ghost job remains.
 *
 * Accepted trade-off: moving boss.send outside the tx would eliminate ghosts but
 * introduce "session=queued but no job" (also requires cleanup). The inside-tx +
 * ghost-tolerant handler is the simpler complexity.
 */
export async function enqueueExtraction(
  params: EnqueueExtractionParams,
): Promise<{ jobId: string | null }> {
  return params.db.transaction(async (tx) => {
    const current = await loadSessionForUpdate(tx, params.sessionId);
    if (!current) {
      throw new ApiError('not_found', `learning_session ${params.sessionId} not found`, 404);
    }
    assertFromState(
      current.status,
      ['uploaded', 'failed'] as const,
      params.sessionId,
      'Ingestion.enqueueExtraction',
    );

    await tx
      .update(learning_session)
      .set({ status: 'queued', updated_at: new Date() })
      .where(eq(learning_session.id, params.sessionId));

    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: params.sessionId,
      event_type: 'ingestion.queued',
      payload: { from: current.status },
    });

    // boss.send within tx is fine; pg-boss writes to pgboss.* tables which
    // commit atomically with our INSERT.
    const jobId = params.operationId
      ? await params.boss.send(
          'tencent_ocr_extract',
          { sessionId: params.sessionId, operationId: params.operationId },
          {
            // pg-boss standard queues only dedupe singletonKey when a throttle
            // window is present. This closes the operation-reservation → send
            // crash gap without changing legacy extraction dispatches.
            singletonKey: params.operationId,
            singletonSeconds: OPERATION_DISPATCH_SINGLETON_SECONDS,
          },
        )
      : await params.boss.send('tencent_ocr_extract', { sessionId: params.sessionId });
    if (!jobId && !params.operationId) {
      throw new Error('Ingestion.enqueueExtraction: boss.send returned no jobId');
    }
    // Canonical operation crash-recovery may replay the same singleton dispatch.
    // pg-boss returns null when that operation job already exists in the throttle
    // window; commit `queued` so the existing job (or its delayed retry) can run.
    return { jobId };
  });
}

// ---------- enqueueAgentRun (YUK-1522 R8) ----------

export const INGESTION_AGENT_RUN_QUEUE = 'ingestion_agent_run' as const;

/**
 * uploaded | failed → queued. Posts an `ingestion_agent_run` pg-boss job for the
 * R8 agent lane (whole-package agentic ingestion). Same tx/ghost-job semantics
 * as enqueueExtraction; the only differences are the queue name and the lane
 * marker on the `ingestion.queued` payload.
 */
export async function enqueueAgentRun(
  params: EnqueueExtractionParams,
): Promise<{ jobId: string | null }> {
  return params.db.transaction(async (tx) => {
    // YUK-1522 — the budget gate runs FIRST inside this dispatch transaction
    // so the global budget advisory lock precedes the session row lock (one
    // lock order for all start decisions), and so the durable grant, the
    // `queued` flip and the job send commit (or roll back) atomically.
    if (params.beforeTransition) await params.beforeTransition(tx);

    const current = await loadSessionForUpdate(tx, params.sessionId);
    if (!current) {
      throw new ApiError('not_found', `learning_session ${params.sessionId} not found`, 404);
    }
    assertFromState(
      current.status,
      ['uploaded', 'failed'] as const,
      params.sessionId,
      'Ingestion.enqueueAgentRun',
    );

    await tx
      .update(learning_session)
      .set({ status: 'queued', updated_at: new Date() })
      .where(eq(learning_session.id, params.sessionId));

    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: params.sessionId,
      event_type: 'ingestion.queued',
      payload: { from: current.status, lane: 'agent' },
    });

    const jobId = params.operationId
      ? await params.boss.send(
          INGESTION_AGENT_RUN_QUEUE,
          { sessionId: params.sessionId, operationId: params.operationId, trigger: 'start' },
          {
            singletonKey: params.operationId,
            singletonSeconds: OPERATION_DISPATCH_SINGLETON_SECONDS,
          },
        )
      : await params.boss.send(INGESTION_AGENT_RUN_QUEUE, {
          sessionId: params.sessionId,
          trigger: 'start',
        });
    if (!jobId && !params.operationId) {
      throw new Error('Ingestion.enqueueAgentRun: boss.send returned no jobId');
    }
    return { jobId };
  });
}

// ---------- markExtractionStarted ----------

/**
 * queued → extracting. Called inside the handler's transaction when picking up
 * a pg-boss job.
 *
 * State-only — no domain event (pg-boss internal handoff; job_events covers it).
 */
export async function markExtractionStarted(tx: Db | Tx, sessionId: string): Promise<void> {
  const current = await loadSessionForUpdate(tx, sessionId);
  if (!current) {
    throw new ApiError('not_found', `learning_session ${sessionId} not found`, 404);
  }
  if (current.status === 'extracting') return;
  assertFromState(
    current.status,
    ['queued'] as const,
    sessionId,
    'Ingestion.markExtractionStarted',
  );

  await tx
    .update(learning_session)
    .set({ status: 'extracting', updated_at: new Date() })
    .where(eq(learning_session.id, sessionId));

  await writeJobEvent(tx, {
    business_table: SESSION_TABLE,
    business_id: sessionId,
    event_type: 'ingestion.extracting',
    payload: {},
  });
}

// ---------- applyExtractionResult ----------

export type ExtractionBlockInput = {
  /** Structured tree from Tencent Mark Agent parser */
  structured: StructuredQuestionT;
  /** Figure refs assigned to this block (already cropped + attached) */
  figures: FigureRefT[];
  /** Page indices/spans this block covers. bbox matches question_block.page_spans. */
  page_spans: Array<{ page_index: number; bbox: BBoxT; role?: string }>;
  /** Source asset ids used to extract this block */
  source_asset_ids: string[];
  /** image refs (usually same as source_asset_ids) */
  image_refs: string[];
  /** Provider-reported confidence in the extracted structure, in [0, 1]. */
  extraction_confidence: number;
};

export type ApplyExtractionResultParams = {
  sessionId: string;
  blocks: ExtractionBlockInput[];
  layoutQuality: 'structured' | 'partial' | 'text_only';
  warnings: string[];
  sourceDocumentId: string;
};

/**
 * extracting → extracted | partial. INSERT N × question_block(status='draft').
 *
 * - layoutQuality='structured' → status='extracted'
 * - layoutQuality='partial' | 'text_only' → status='partial'
 * - blocks=[] is rejected; use markExtractionFailed
 *
 * Writes a domain `event(action='extract', subject_kind='source_document',
 * outcome='success' | 'partial')` chained to the session via session_id.
 */
export async function applyExtractionResult(
  tx: Db | Tx,
  params: ApplyExtractionResultParams,
): Promise<{ status: 'extracted' | 'partial' }> {
  if (params.blocks.length === 0) {
    throw new ApiError(
      'validation_error',
      'Ingestion.applyExtractionResult: empty blocks; use markExtractionFailed instead',
      400,
    );
  }

  // Validate the complete batch before locking the session or writing any block.
  // This service also accepts a bare Db (not only a transaction), so validating
  // inside the insert loop could otherwise leave a valid prefix partially persisted.
  for (const blk of params.blocks) {
    if (
      !Number.isFinite(blk.extraction_confidence) ||
      blk.extraction_confidence < 0 ||
      blk.extraction_confidence > 1
    ) {
      throw new ApiError(
        'validation_error',
        'Ingestion.applyExtractionResult: extraction_confidence must be within [0, 1]',
        400,
      );
    }
  }

  const current = await loadSessionForUpdate(tx, params.sessionId);
  if (!current) {
    throw new ApiError('not_found', `learning_session ${params.sessionId} not found`, 404);
  }
  assertFromState(
    current.status,
    ['extracting'] as const,
    params.sessionId,
    'Ingestion.applyExtractionResult',
  );

  const nextStatus: 'extracted' | 'partial' =
    params.layoutQuality === 'structured' ? 'extracted' : 'partial';
  // Outcome semantics: 'structured' is a full success; 'partial' / 'text_only'
  // produced blocks (else we'd be on the markExtractionFailed path) but the
  // layout is degraded, so we report 'partial' on the event log.
  const eventOutcome: 'success' | 'partial' =
    params.layoutQuality === 'structured' ? 'success' : 'partial';

  const now = new Date();
  const insertedBlockIds: string[] = [];
  for (const [ordinal, blk] of params.blocks.entries()) {
    const blockId = createId();
    insertedBlockIds.push(blockId);
    const [insertedRow] = await tx
      .insert(question_block)
      .values({
        id: blockId,
        ingestion_session_id: params.sessionId,
        source_document_id: params.sourceDocumentId,
        source_asset_ids: blk.source_asset_ids,
        page_spans: blk.page_spans,
        // YUK-221 — true positional order = the extraction array index (0-based).
        ordinal,
        // new schema fields
        structured: blk.structured,
        figures: blk.figures,
        layout_quality: params.layoutQuality,
        // legacy nullable
        extracted_prompt_md: null,
        reference_md: null,
        wrong_answer_md: null,
        image_refs: blk.image_refs,
        crop_refs: blk.figures.map((f) => f.asset_id),
        visual_complexity: 'medium',
        extraction_confidence: blk.extraction_confidence,
        status: 'draft',
        knowledge_hint: null,
        merged_from_block_ids: [],
        imported_question_id: null,
        imported_attempt_event_id: null,
        created_at: now,
        updated_at: now,
        version: 0,
      })
      .returning();
    // YUK-471 W3-C1δ — canonical create event (additive; flag OFF). Built from the `.returning()`
    // row so the snapshot is byte-faithful to what landed (incl. crop_refs = figures' asset_ids).
    await writeQuestionBlockCreateEvent(tx, {
      row: insertedRow,
      origin: 'ocr',
      actorKind: 'agent',
      actorRef: 'tencent_ocr',
      now,
    });
  }

  const updatedWarnings = [...current.warnings, ...params.warnings];
  await tx
    .update(learning_session)
    .set({ status: nextStatus, warnings: updatedWarnings, updated_at: now })
    .where(eq(learning_session.id, params.sessionId));

  await writeJobEvent(tx, {
    business_table: SESSION_TABLE,
    business_id: params.sessionId,
    event_type: 'ingestion.extraction_completed',
    payload: {
      block_count: params.blocks.length,
      layout_quality: params.layoutQuality,
      warnings: params.warnings,
    },
  });

  // Domain event: ExtractSourceDocument (Lane B). Chained to the session via
  // session_id so any future timeline UI can walk the chain.
  await writeSessionEvent(tx, {
    session_id: params.sessionId,
    action: 'extract',
    subject_kind: 'source_document',
    subject_id: params.sourceDocumentId,
    actor_kind: 'agent',
    actor_ref: 'tencent_ocr',
    outcome: eventOutcome,
    payload: {
      structured_block_ids: insertedBlockIds,
      layout_quality: params.layoutQuality,
      warnings: params.warnings,
    },
    created_at: now,
  });

  return { status: nextStatus };
}

// ---------- markExtractionFailed ----------

/**
 * extracting | queued → failed.
 *
 * Accepts queued-origin failures (rare but possible: rejected immediately after
 * enqueue).
 *
 * Writes a domain `event(action='extract', outcome='failure')` so the failure
 * is visible on the event log. structured_block_ids=[], warnings=[errorMessage].
 */
export async function markExtractionFailed(
  tx: Db | Tx,
  sessionId: string,
  errorMessage: string,
): Promise<void> {
  const current = await loadSessionForUpdate(tx, sessionId);
  if (!current) {
    throw new ApiError('not_found', `learning_session ${sessionId} not found`, 404);
  }
  assertFromState(
    current.status,
    ['queued', 'extracting'] as const,
    sessionId,
    'Ingestion.markExtractionFailed',
  );

  const now = new Date();
  await tx
    .update(learning_session)
    .set({ status: 'failed', error_message: errorMessage, updated_at: now })
    .where(eq(learning_session.id, sessionId));

  await writeJobEvent(tx, {
    business_table: SESSION_TABLE,
    business_id: sessionId,
    event_type: 'ingestion.extraction_failed',
    payload: { error_message: errorMessage },
  });

  // Domain event: extract failure. Lane B's ExtractSourceDocument carries the
  // error message in `warnings` (no dedicated `error_message` field) — this is
  // the cleanest fit without an experimental:* escape. Skipped if source_document_id
  // is null (degenerate, shouldn't happen post-Step 3 migration; subject_id must
  // be a real string per Lane B).
  if (current.source_document_id) {
    await writeSessionEvent(tx, {
      session_id: sessionId,
      action: 'extract',
      subject_kind: 'source_document',
      subject_id: current.source_document_id,
      actor_kind: 'agent',
      actor_ref: 'tencent_ocr',
      outcome: 'failure',
      payload: {
        structured_block_ids: [],
        layout_quality: 'text_only',
        warnings: [errorMessage],
      },
      created_at: now,
    });
  }
}

// ---------- markAgentRunCompleted (YUK-1522 R8) ----------

export type AgentRunCompletion = {
  /** Emitted ingestion_agent.item rows that reached a terminal status. */
  items_terminal: number;
  /** Terminal items whose last status is 'failed'. */
  items_failed: number;
};

/**
 * extracting → extracted | partial | failed — terminal status for the R8 agent
 * lane. The agent writes question drafts / submitted questions via the
 * edit/submit canonical paths, not question_block rows, so completion is
 * item-ledger based rather than block based:
 *   - no terminal items at all            → 'failed'
 *   - every terminal item failed          → 'failed'
 *   - some terminal items failed          → 'partial'
 *   - all terminal items withheld/admitted → 'extracted'
 * A run suspended on open asks stays 'extracting' (honest in-progress) and is
 * resumed by the ask answer / timeout lane, so this guard is only called on a
 * real terminal outcome.
 */
export async function markAgentRunCompleted(
  tx: Db | Tx,
  params: { sessionId: string; completion: AgentRunCompletion },
): Promise<{ status: 'extracted' | 'partial' | 'failed' }> {
  const current = await loadSessionForUpdate(tx, params.sessionId);
  if (!current) {
    throw new ApiError('not_found', `learning_session ${params.sessionId} not found`, 404);
  }
  assertFromState(
    current.status,
    ['extracting'] as const,
    params.sessionId,
    'Ingestion.markAgentRunCompleted',
  );

  const { items_terminal: total, items_failed: failed } = params.completion;
  const succeeded = total - failed;
  const nextStatus: 'extracted' | 'partial' | 'failed' =
    succeeded <= 0 ? 'failed' : failed > 0 ? 'partial' : 'extracted';

  const now = new Date();
  await tx
    .update(learning_session)
    .set({
      status: nextStatus,
      ...(nextStatus === 'failed'
        ? { error_message: 'ingestion agent produced no usable items' }
        : {}),
      updated_at: now,
    })
    .where(eq(learning_session.id, params.sessionId));

  await writeJobEvent(tx, {
    business_table: SESSION_TABLE,
    business_id: params.sessionId,
    event_type: 'ingestion.agent_run_completed',
    payload: {
      status: nextStatus,
      items_terminal: total,
      items_failed: failed,
      lane: 'agent',
    },
  });
  return { status: nextStatus };
}

// ---------- applyRescue ----------

export type ApplyRescueParams = {
  sessionId: string;
  blockId: string;
  structured: StructuredQuestionT;
  figures: FigureRefT[];
};

/** Shared by paid-call preflight and the locked write; preflight does not reserve the session. */
export function assertRescuableSessionStatus(status: string, sessionId: string): void {
  assertFromState(status, ['partial', 'extracted'] as const, sessionId, 'Ingestion.applyRescue');
}

/**
 * partial / extracted: user-driven manual rescue. Replaces the block's
 * structured content and bumps version; session status unchanged.
 *
 * Writes a domain `event(action='extract', outcome='success', actor_ref='vision_rescue')`
 * to capture provenance of the rescue. structured_block_ids=[blockId].
 */
export async function applyRescue(tx: Db | Tx, params: ApplyRescueParams): Promise<void> {
  const current = await loadSessionForUpdate(tx, params.sessionId);
  if (!current) {
    throw new ApiError('not_found', `learning_session ${params.sessionId} not found`, 404);
  }
  assertRescuableSessionStatus(current.status, params.sessionId);

  const now = new Date();
  const blockExists = await tx
    .select({ id: question_block.id, version: question_block.version })
    .from(question_block)
    .where(
      and(
        eq(question_block.id, params.blockId),
        eq(question_block.ingestion_session_id, params.sessionId),
      ),
    );
  if (blockExists.length === 0) {
    throw new ApiError(
      'not_found',
      `question_block ${params.blockId} not found in session ${params.sessionId}`,
      404,
    );
  }

  const [rescuedRow] = await tx
    .update(question_block)
    .set({
      structured: params.structured,
      figures: params.figures,
      // F5 (YUK-471 W3 §9 #3) — the rescue overwrites `figures` but historically OMITTED `crop_refs`,
      // leaving it STALE vs the new figures. Re-derive it the same way applyExtractionResult does
      // (crop_refs = figures' asset_ids) so the row + the create-event snapshot stay consistent.
      crop_refs: params.figures.map((f) => f.asset_id),
      updated_at: now,
      version: sql`${question_block.version} + 1` as unknown as SQL<number>,
    })
    .where(eq(question_block.id, params.blockId))
    .returning();

  // YUK-471 W3-C1δ — canonical create event (origin='rescue'): a SECOND full-snapshot create for the
  // SAME blockId that the fold applies last-write-wins (design §5.2). Built from the `.returning()`
  // after-row so it carries the new structured/figures/crop_refs (F5) + the bumped version.
  await writeQuestionBlockCreateEvent(tx, {
    row: rescuedRow,
    origin: 'rescue',
    actorKind: 'agent',
    actorRef: 'vision_rescue',
    now,
  });

  await writeJobEvent(tx, {
    business_table: SESSION_TABLE,
    business_id: params.sessionId,
    event_type: 'ingestion.rescued',
    payload: { block_id: params.blockId },
  });

  // Domain event: rescue produces a fresh structured block — modeled as an
  // extract success authored by 'vision_rescue' (vs 'tencent_ocr' for the
  // original extraction). layout_quality reflects the session's current state
  // (rescue happens on partial / extracted sessions, doesn't transition them).
  if (current.source_document_id) {
    await writeSessionEvent(tx, {
      session_id: params.sessionId,
      action: 'extract',
      subject_kind: 'source_document',
      subject_id: current.source_document_id,
      actor_kind: 'agent',
      actor_ref: 'vision_rescue',
      outcome: 'success',
      payload: {
        structured_block_ids: [params.blockId],
        layout_quality: current.status === 'extracted' ? 'structured' : 'partial',
        warnings: [],
      },
      created_at: now,
    });
  }
}

// ---------- markReviewed ----------

/**
 * extracted | partial → reviewed. User-driven "I've reviewed" UI action.
 *
 * State-only — no domain event written. (Reviewing the extraction result is
 * a UX checkpoint; per-question review events come later via FSRS flow.)
 */
export async function markReviewed(db: Db, sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await loadSessionForUpdate(tx, sessionId);
    if (!current) {
      throw new ApiError('not_found', `learning_session ${sessionId} not found`, 404);
    }
    assertFromState(
      current.status,
      ['extracted', 'partial'] as const,
      sessionId,
      'Ingestion.markReviewed',
    );

    await tx
      .update(learning_session)
      .set({ status: 'reviewed', updated_at: new Date() })
      .where(eq(learning_session.id, sessionId));

    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'ingestion.reviewed',
      payload: {},
    });
  });
}

// ---------- assertSessionAvailableForImport ----------

/**
 * Acquires `SELECT … FOR UPDATE` lock on the session row and asserts it is in
 * an importable state. Must be called at the start of an import transaction
 * (Codex P1-A): otherwise the route's INSERTs run outside any concurrency
 * guard, and two simultaneous POSTs both pass the status check, both write
 * question / mistake / question_block rows, then race in commitImport — the
 * loser throws 409 *after* its writes have already committed.
 *
 * Held until the surrounding transaction commits or rolls back. Concurrent
 * callers serialise on the row lock; the second to acquire sees `imported`
 * and throws.
 */
export async function assertSessionAvailableForImport(
  tx: Tx,
  sessionId: string,
): Promise<{ source_document_id: string | null }> {
  // Auto-enrollment claims G then its block, without a session lock. Import must
  // follow G -> session -> sorted blocks, including the later draft-ignore sweep.
  await acquireLearningStateWriteLock(tx);
  const current = await loadSessionForUpdate(tx, sessionId);
  if (!current) {
    throw new ApiError('not_found', `learning_session ${sessionId} not found`, 404);
  }
  assertFromState(
    current.status,
    IMPORTABLE_SESSION_STATUSES,
    sessionId,
    'Ingestion.assertSessionAvailableForImport',
  );
  await tx
    .select({ id: question_block.id })
    .from(question_block)
    .where(eq(question_block.ingestion_session_id, sessionId))
    .orderBy(asc(question_block.id))
    .for('update');
  return { source_document_id: current.source_document_id };
}

// ---------- commitImport ----------

/**
 * extracted | reviewed → imported. State-only transition — the actual question /
 * mistake / question_block INSERTs happen in the route handler (legacy import
 * route is the single-call-site for now; Phase 1d may invert this).
 *
 * Sets ended_at = now (terminal state). No domain event in Phase 1c.1 —
 * KnownEvent has no 'import' action; the user-facing "I imported these"
 * footprint is the attempt events the route already writes per-block. Reconsider
 * a session-level 'import' event in Phase 1d if the timeline UI surfaces a need.
 *
 * **Concurrency** (Codex P1-A): callers MUST run this inside a transaction
 * that already holds the session lock via `assertSessionAvailableForImport`
 * (or accept that a fresh load + lock here is the only guard — the route uses
 * the first pattern so writes ride the same lock).
 */
export async function commitImport(tx: Db | Tx, sessionId: string): Promise<void> {
  const current = await loadSessionForUpdate(tx, sessionId);
  if (!current) {
    throw new ApiError('not_found', `learning_session ${sessionId} not found`, 404);
  }
  assertFromState(current.status, IMPORTABLE_SESSION_STATUSES, sessionId, 'Ingestion.commitImport');

  const now = new Date();
  await tx
    .update(learning_session)
    .set({
      status: 'imported',
      updated_at: now,
      ended_at: now,
      version: sql`${learning_session.version} + 1`,
    })
    .where(eq(learning_session.id, sessionId));

  await writeJobEvent(tx, {
    business_table: SESSION_TABLE,
    business_id: sessionId,
    event_type: 'ingestion.imported',
    payload: {},
  });
}

// ---------- initiateUpload ----------

export type InitiateUploadParams = {
  assetIds: string[];
  // YUK-258: 'docx' — the visual line feeds docx page images through this same
  // upload+extract path (text line uses the dedicated docx-ingestion owner).
  entrypoint: 'vision_single' | 'vision_paper' | 'docx';
  // YUK-1404 — canonical learner-selected upload subject, already resolved and
  // validated against the selectable registry by the caller (API route).
  // null / omitted = no explicit signal: provenance keeps only `entrypoint`, so
  // those sessions read exactly like legacy ones (derived notation fallback
  // stays available). Persisted INSIDE this transaction on the session-bound
  // source_document.provenance.learner_selected_subject_id — never a
  // learning_session column, never scope_knowledge_ids.
  learnerSelectedSubjectId?: string | null;
  /**
   * YUK-1476 (R1 P1-2) — docx visual line: honest external-ref omission audit.
   * Same facts object / provenance key / warnings wording as the text-line
   * owner (docx-ingestion.ts) so BOTH lines emit the identical receipt; absent
   * for every other entrypoint. No new store/schema — provenance + the existing
   * learning_session.warnings field.
   */
  externalRefOmission?: DocxExternalRefOmissionFacts;
  /**
   * YUK-1408 — the learner's consented usage for this document
   * ('allow' derivations vs 'answer_only'). Omitted / null = legacy default
   * 'allow'; an explicit value is persisted verbatim on
   * `source_document.provenance.usage_policy` and inherited by every
   * ingestion-derived event written for this session.
   */
  derivationPolicy?: DerivationPolicyT | null;
};

/**
 * Creates a source_document + learning_session(type='ingestion', status='uploaded').
 * Callers must pre-validate that assetIds exist in source_asset.
 *
 * State-only — no domain event ("user picked file" isn't an extract action yet).
 */
export async function initiateUpload(
  db: Db,
  params: InitiateUploadParams,
): Promise<{ sessionId: string; sourceDocumentId: string }> {
  return db.transaction(async (tx) => {
    const sourceDocumentId = createId();
    const sessionId = createId();
    const now = new Date();
    // dynamic import to avoid circular dep at module load time
    const { source_document } = await import('@/db/schema');
    const omission = params.externalRefOmission;
    const omissionWarnings = omission ? [EXTERNAL_REF_OMISSION_NOTICE] : [];
    await tx.insert(source_document).values({
      id: sourceDocumentId,
      title: null,
      source_asset_ids: params.assetIds,
      body_md: null,
      // YUK-1404 — the explicit upload subject rides the open provenance record
      // (no new column). Key presence = explicit learner choice (canonical id);
      // key absence = unknown (omitted/null request OR legacy session). Only a
      // non-null resolved id writes the key, so absent and explicit-unknown stay
      // indistinguishable-by-design from legacy rows on purpose: the derived
      // fallback remains available for both, while a stored id that later stops
      // resolving pins notation to null (never a guessed subject).
      provenance: {
        entrypoint: params.entrypoint,
        ...(params.learnerSelectedSubjectId
          ? { learner_selected_subject_id: params.learnerSelectedSubjectId }
          : {}),
        // YUK-1408 — explicit consent signal rides the same open provenance
        // record; absence = default 'allow'.
        ...(params.derivationPolicy
          ? {
              [USAGE_POLICY_PROVENANCE_KEY]: {
                derivation_policy: params.derivationPolicy,
              },
            }
          : {}),
        // YUK-1476 — identical provenance shape to the text-line owner
        // (docx-ingestion.ts) so audits read uniformly across both docx lines.
        ...(omission
          ? {
              docx_external_ref_omission: {
                input_sha256: omission.inputSha256,
                converter_input_sha256: omission.converterInputSha256,
                omitted: omission.omissions,
                learner_notice: EXTERNAL_REF_OMISSION_NOTICE,
              },
            }
          : {}),
      } as Record<string, unknown>,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await tx.insert(learning_session).values({
      id: sessionId,
      type: 'ingestion',
      source_document_id: sourceDocumentId,
      source_asset_ids: params.assetIds,
      status: 'uploaded',
      entrypoint: params.entrypoint,
      error_message: null,
      warnings: omissionWarnings,
      started_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'ingestion.uploaded',
      payload: { asset_count: params.assetIds.length, entrypoint: params.entrypoint },
    });

    return { sessionId, sourceDocumentId };
  });
}
