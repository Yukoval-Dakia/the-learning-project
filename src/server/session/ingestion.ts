import { createId } from '@paralleldrive/cuid2';
import { type SQL, and, eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import type { BBoxT, FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { learning_session, question_block } from '@/db/schema';
import { writeJobEvent } from '@/server/events/writer';
import { ApiError } from '@/server/http/errors';

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
  const rows = await tx.execute(
    sql`SELECT status, warnings, source_document_id FROM learning_session WHERE id = ${sessionId} AND type = 'ingestion' FOR UPDATE`,
  );
  // postgres-js returns array of objects
  const arr = rows as unknown as Array<{
    status: string;
    warnings: string[] | null;
    source_document_id: string | null;
  }>;
  const row = arr[0];
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
): Promise<{ jobId: string }> {
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
    const jobId = await params.boss.send('tencent_ocr_extract', {
      sessionId: params.sessionId,
    });
    if (!jobId) {
      throw new Error('Ingestion.enqueueExtraction: boss.send returned no jobId');
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
  for (const blk of params.blocks) {
    const blockId = createId();
    insertedBlockIds.push(blockId);
    await tx.insert(question_block).values({
      id: blockId,
      ingestion_session_id: params.sessionId,
      source_document_id: params.sourceDocumentId,
      source_asset_ids: blk.source_asset_ids,
      page_spans: blk.page_spans,
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
      extraction_confidence: 1,
      status: 'draft',
      knowledge_hint: null,
      merged_from_block_ids: [],
      imported_question_id: null,
      imported_mistake_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
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

// ---------- applyRescue ----------

export type ApplyRescueParams = {
  sessionId: string;
  blockId: string;
  structured: StructuredQuestionT;
  figures: FigureRefT[];
};

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
  assertFromState(
    current.status,
    ['partial', 'extracted'] as const,
    params.sessionId,
    'Ingestion.applyRescue',
  );

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

  await tx
    .update(question_block)
    .set({
      structured: params.structured,
      figures: params.figures,
      updated_at: now,
      version: sql`${question_block.version} + 1` as unknown as SQL<number>,
    })
    .where(eq(question_block.id, params.blockId));

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
 */
export async function commitImport(tx: Db | Tx, sessionId: string): Promise<void> {
  const current = await loadSessionForUpdate(tx, sessionId);
  if (!current) {
    throw new ApiError('not_found', `learning_session ${sessionId} not found`, 404);
  }
  assertFromState(
    current.status,
    ['extracted', 'reviewed'] as const,
    sessionId,
    'Ingestion.commitImport',
  );

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
  entrypoint: 'vision_single' | 'vision_paper';
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
    await tx.insert(source_document).values({
      id: sourceDocumentId,
      title: null,
      source_asset_ids: params.assetIds,
      body_md: null,
      provenance: { entrypoint: params.entrypoint } as Record<string, unknown>,
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
      warnings: [],
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
