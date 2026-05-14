import { createId } from '@paralleldrive/cuid2';
import { type SQL, and, eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import type {
  BBoxT,
  FigureRefT,
  StructuredQuestionT,
} from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { ingestion_session, question_block } from '@/db/schema';
import { writeJobEvent } from '@/server/events/writer';
import { ApiError } from '@/server/http/errors';

// IngestionSession state-machine module —— ADR-0005 single-owner invariant。
//
// 所有 ingestion_session.status / question_block.status 的写入都必须走这里。
// route / handler 不允许直接 db.update(ingestion_session).status = ...。
//
// 状态机 (CONTEXT.md "录入会话"词条)：
//   uploaded → queued → extracting → extracted | partial | failed
//   extracted / partial → reviewed → imported (终态)
//   failed → retry → queued
//
// 每个 transition 同事务写 job_events('ingestion.<transition>.success' / .failed)。

const SESSION_TABLE = 'ingestion_session' as const;

// ---------- Guard ----------

type IngestionStatus =
  | 'uploaded'
  | 'queued'
  | 'extracting'
  | 'extracted'
  | 'partial'
  | 'failed'
  | 'reviewed'
  | 'imported';

function assertFromState(
  current: string,
  allowed: IngestionStatus[],
  sessionId: string,
  transition: string,
): asserts current is IngestionStatus {
  if (!(allowed as string[]).includes(current)) {
    throw new ApiError(
      'conflict',
      `IngestionSession.${transition}: session ${sessionId} is in status '${current}', expected one of [${allowed.join(', ')}]`,
      409,
    );
  }
}

// ---------- Load helpers ----------

async function loadSessionForUpdate(
  tx: Db | Tx,
  sessionId: string,
): Promise<{ status: string; warnings: string[] } | null> {
  const rows = await tx.execute(
    sql`SELECT status, warnings FROM ingestion_session WHERE id = ${sessionId} FOR UPDATE`,
  );
  // postgres-js returns array of objects
  const arr = rows as unknown as Array<{ status: string; warnings: string[] | null }>;
  const row = arr[0];
  if (!row) return null;
  return { status: row.status, warnings: row.warnings ?? [] };
}

// ---------- enqueueExtraction ----------

export type EnqueueExtractionParams = {
  db: Db;
  boss: PgBoss;
  sessionId: string;
};

/**
 * uploaded | failed → queued。投递 pg-boss tencent_ocr_extract job。
 */
export async function enqueueExtraction(
  params: EnqueueExtractionParams,
): Promise<{ jobId: string }> {
  return params.db.transaction(async (tx) => {
    const current = await loadSessionForUpdate(tx, params.sessionId);
    if (!current) {
      throw new ApiError('not_found', `ingestion_session ${params.sessionId} not found`, 404);
    }
    assertFromState(current.status, ['uploaded', 'failed'], params.sessionId, 'enqueueExtraction');

    await tx
      .update(ingestion_session)
      .set({ status: 'queued', updated_at: new Date() })
      .where(eq(ingestion_session.id, params.sessionId));

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
      throw new Error('enqueueExtraction: boss.send returned no jobId');
    }
    return { jobId };
  });
}

// ---------- markExtractionStarted ----------

/**
 * queued → extracting。handler 拿到 job 开始干活时调（事务内）。
 */
export async function markExtractionStarted(tx: Db | Tx, sessionId: string): Promise<void> {
  const current = await loadSessionForUpdate(tx, sessionId);
  if (!current) {
    throw new ApiError('not_found', `ingestion_session ${sessionId} not found`, 404);
  }
  assertFromState(current.status, ['queued'], sessionId, 'markExtractionStarted');

  await tx
    .update(ingestion_session)
    .set({ status: 'extracting', updated_at: new Date() })
    .where(eq(ingestion_session.id, sessionId));

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
  /** Page indices/spans this block covers. bbox 与 question_block.page_spans 类型一致。 */
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
 * extracting → extracted | partial。INSERT N × question_block(status='draft')。
 *
 * - layoutQuality='structured' → status='extracted'
 * - layoutQuality='partial' | 'text_only' → status='partial'
 * - blocks=[] 不走此函数；走 markExtractionFailed
 */
export async function applyExtractionResult(
  tx: Db | Tx,
  params: ApplyExtractionResultParams,
): Promise<{ status: 'extracted' | 'partial' }> {
  if (params.blocks.length === 0) {
    throw new ApiError(
      'validation_error',
      'applyExtractionResult: empty blocks; use markExtractionFailed instead',
      400,
    );
  }

  const current = await loadSessionForUpdate(tx, params.sessionId);
  if (!current) {
    throw new ApiError('not_found', `ingestion_session ${params.sessionId} not found`, 404);
  }
  assertFromState(current.status, ['extracting'], params.sessionId, 'applyExtractionResult');

  const nextStatus: 'extracted' | 'partial' =
    params.layoutQuality === 'structured' ? 'extracted' : 'partial';

  const now = new Date();
  for (const blk of params.blocks) {
    await tx.insert(question_block).values({
      id: createId(),
      ingestion_session_id: params.sessionId,
      source_document_id: params.sourceDocumentId,
      source_asset_ids: blk.source_asset_ids,
      page_spans: blk.page_spans,
      // new schema fields
      structured: blk.structured as unknown as Record<string, unknown>,
      figures: blk.figures as unknown as Record<string, unknown>[],
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
    .update(ingestion_session)
    .set({ status: nextStatus, warnings: updatedWarnings, updated_at: now })
    .where(eq(ingestion_session.id, params.sessionId));

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

  return { status: nextStatus };
}

// ---------- markExtractionFailed ----------

/**
 * extracting | queued → failed。
 *
 * 接受 queued 起点也允许 failed（少见但可能 enqueue 后立即拒绝）。
 */
export async function markExtractionFailed(
  tx: Db | Tx,
  sessionId: string,
  errorMessage: string,
): Promise<void> {
  const current = await loadSessionForUpdate(tx, sessionId);
  if (!current) {
    throw new ApiError('not_found', `ingestion_session ${sessionId} not found`, 404);
  }
  assertFromState(current.status, ['queued', 'extracting'], sessionId, 'markExtractionFailed');

  await tx
    .update(ingestion_session)
    .set({ status: 'failed', error_message: errorMessage, updated_at: new Date() })
    .where(eq(ingestion_session.id, sessionId));

  await writeJobEvent(tx, {
    business_table: SESSION_TABLE,
    business_id: sessionId,
    event_type: 'ingestion.extraction_failed',
    payload: { error_message: errorMessage },
  });
}

// ---------- applyRescue ----------

export type ApplyRescueParams = {
  sessionId: string;
  blockId: string;
  structured: StructuredQuestionT;
  figures: FigureRefT[];
};

/**
 * partial 状态下用户手动救援。替换块内容 + bump version。session 状态不变。
 */
export async function applyRescue(tx: Db | Tx, params: ApplyRescueParams): Promise<void> {
  const current = await loadSessionForUpdate(tx, params.sessionId);
  if (!current) {
    throw new ApiError('not_found', `ingestion_session ${params.sessionId} not found`, 404);
  }
  assertFromState(current.status, ['partial', 'extracted'], params.sessionId, 'applyRescue');

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
      structured: params.structured as unknown as Record<string, unknown>,
      figures: params.figures as unknown as Record<string, unknown>[],
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
}

// ---------- markReviewed ----------

/**
 * extracted | partial → reviewed。用户在 UI 显式点 "已审阅"。
 */
export async function markReviewed(db: Db, sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await loadSessionForUpdate(tx, sessionId);
    if (!current) {
      throw new ApiError('not_found', `ingestion_session ${sessionId} not found`, 404);
    }
    assertFromState(current.status, ['extracted', 'partial'], sessionId, 'markReviewed');

    await tx
      .update(ingestion_session)
      .set({ status: 'reviewed', updated_at: new Date() })
      .where(eq(ingestion_session.id, sessionId));

    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'ingestion.reviewed',
      payload: {},
    });
  });
}

// initiateUpload + commitImport 留给 Step 11.5（迁老 route 时实现）。
