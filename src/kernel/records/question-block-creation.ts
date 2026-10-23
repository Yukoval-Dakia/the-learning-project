import { eq, sql } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { QuestionBlockRowSnapshotT } from '@/core/schema/event/genesis';
import type { QuestionDraftDocumentT } from '@/core/schema/question-draft';
import {
  type BBoxT,
  type FigureRefT,
  type StructuredQuestionT,
  structuredToPromptMarkdown,
} from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { question_block } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resolveSessionDerivationPolicy } from '@/kernel/read-models/usage-policy';
import { projectQuestionBlockGuarded } from './question-block-projection';

type QuestionBlockRow = typeof question_block.$inferSelect;
type PageSpan = { page_index: number; bbox: BBoxT; role?: string };

type OcrBlockCommand = {
  origin: 'ocr';
  blockId: string;
  sessionId: string;
  sourceDocumentId: string;
  ordinal: number;
  layoutQuality: 'structured' | 'partial' | 'text_only';
  structured: StructuredQuestionT;
  figures: FigureRefT[];
  sourceAssetIds: string[];
  pageSpans: PageSpan[];
  imageRefs: string[];
  extractionConfidence: number;
};

type RescueBlockCommand = {
  origin: 'rescue';
  blockId: string;
  structured: StructuredQuestionT;
  figures: FigureRefT[];
};

type DocxBlockCommand = {
  origin: 'docx';
  blockId: string;
  sessionId: string;
  sourceDocumentId: string;
  ordinal: number;
  structured: StructuredQuestionT;
  evidenceAssetIds: string[];
  imageRefs: string[];
};

type ImportBlockCommand = {
  origin: 'import';
  blockId: string;
  sessionId: string;
  sourceDocumentId: string;
  ordinal: number;
  visualComplexity: 'high' | 'medium' | 'low';
  pageSpans: PageSpan[];
  imageRefs: string[];
  sourceBlockIds: string[];
  finalPromptMd: string;
  finalReferenceMd: string | null;
  finalWrongAnswerMd: string;
};

type EditDraftBlockCommand = {
  origin: 'edit_draft';
  blockId: string;
  doc: QuestionDraftDocumentT;
  importedQuestionId: string | null;
  actorKind: 'agent' | 'user' | 'system';
  actorRef: string;
  version?: number;
};

type CapturedBlockCommand =
  | OcrBlockCommand
  | RescueBlockCommand
  | DocxBlockCommand
  | ImportBlockCommand
  | EditDraftBlockCommand;

const DRAFT_SESSION_PREFIX = 'draft:';

export function persistCapturedQuestionBlock(
  db: Db | Tx,
  command: EditDraftBlockCommand,
  now: Date,
): Promise<QuestionBlockRow>;
export function persistCapturedQuestionBlock(
  db: Db | Tx,
  command: OcrBlockCommand | RescueBlockCommand | DocxBlockCommand | ImportBlockCommand,
  now: Date,
): Promise<void>;
/**
 * Persist captured material and its canonical create snapshot on the supplied handle.
 * Session guards, source qualification, IDs and clocks belong to the caller. A Tx
 * keeps row/event/projection writes atomic; a bare Db retains its existing boundary.
 */
export async function persistCapturedQuestionBlock(
  db: Db | Tx,
  command: CapturedBlockCommand,
  now: Date,
): Promise<QuestionBlockRow | void> {
  switch (command.origin) {
    case 'ocr': {
      const [row] = await db
        .insert(question_block)
        .values({
          id: command.blockId,
          ingestion_session_id: command.sessionId,
          source_document_id: command.sourceDocumentId,
          source_asset_ids: command.sourceAssetIds,
          page_spans: command.pageSpans,
          // YUK-221 — true positional order = the extraction array index (0-based).
          ordinal: command.ordinal,
          structured: command.structured,
          figures: command.figures,
          layout_quality: command.layoutQuality,
          extracted_prompt_md: null,
          reference_md: null,
          wrong_answer_md: null,
          image_refs: command.imageRefs,
          crop_refs: command.figures.map((f) => f.asset_id),
          visual_complexity: 'medium',
          extraction_confidence: command.extractionConfidence,
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
      await writeQuestionBlockCreateEvent(db, {
        row,
        origin: 'ocr',
        actorKind: 'agent',
        actorRef: 'tencent_ocr',
        now,
      });
      return;
    }
    case 'rescue': {
      const [row] = await db
        .update(question_block)
        .set({
          structured: command.structured,
          figures: command.figures,
          // Replacing figures must replace crop_refs in the same after-row.
          crop_refs: command.figures.map((f) => f.asset_id),
          updated_at: now,
          version: sql<number>`${question_block.version} + 1`,
        })
        .where(eq(question_block.id, command.blockId))
        .returning();
      // A second full-snapshot create for this blockId preserves last-write-wins.
      await writeQuestionBlockCreateEvent(db, {
        row,
        origin: 'rescue',
        actorKind: 'agent',
        actorRef: 'vision_rescue',
        now,
      });
      return;
    }
    case 'docx': {
      // Evidence first; preserve duplicate embedded image refs on image_refs itself.
      const blockAssetIds = Array.from(new Set([...command.evidenceAssetIds, ...command.imageRefs]));
      const [row] = await db
        .insert(question_block)
        .values({
          id: command.blockId,
          ingestion_session_id: command.sessionId,
          source_document_id: command.sourceDocumentId,
          source_asset_ids: blockAssetIds,
          page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
          ordinal: command.ordinal,
          structured: command.structured,
          figures: [],
          layout_quality: 'structured',
          // VisionTab seeds its editable prompt here; structured remains truth.
          extracted_prompt_md: structuredToPromptMarkdown(command.structured),
          reference_md: null,
          wrong_answer_md: null,
          image_refs: command.imageRefs,
          crop_refs: [],
          visual_complexity: 'medium',
          extraction_confidence: 1,
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
      await writeQuestionBlockCreateEvent(db, {
        row,
        origin: 'docx',
        actorKind: 'agent',
        actorRef: 'docx_text',
        now,
      });
      return;
    }
    case 'import': {
      const [row] = await db
        .insert(question_block)
        .values({
          id: command.blockId,
          ingestion_session_id: command.sessionId,
          source_document_id: command.sourceDocumentId,
          source_asset_ids: command.imageRefs,
          page_spans: command.pageSpans,
          ordinal: command.ordinal,
          extracted_prompt_md: command.finalPromptMd,
          reference_md: command.finalReferenceMd,
          wrong_answer_md: command.finalWrongAnswerMd,
          image_refs: command.imageRefs,
          crop_refs: [],
          visual_complexity: command.visualComplexity,
          extraction_confidence: 1,
          status: 'imported',
          knowledge_hint: null,
          merged_from_block_ids: command.sourceBlockIds,
          imported_question_id: null,
          imported_attempt_event_id: null,
          created_at: now,
          updated_at: now,
          version: 0,
        })
        .returning();
      // Capture the actual DB defaults; final links belong to complete_import.
      await writeQuestionBlockCreateEvent(db, {
        row,
        origin: 'import',
        actorKind: 'user',
        actorRef: 'block_import',
        now,
      });
      return;
    }
    case 'edit_draft': {
      const [row] = await db
        .insert(question_block)
        .values({
          id: command.blockId,
          ingestion_session_id: `${DRAFT_SESSION_PREFIX}${command.actorRef}`,
          source_document_id: null,
          source_asset_ids: [],
          page_spans: [],
          ordinal: 0,
          // The JSONB column retains its legacy TS type; preserve the v2 adapter.
          structured: command.doc as unknown as StructuredQuestionT,
          figures: [],
          status: 'draft',
          imported_question_id: command.importedQuestionId,
          created_at: now,
          updated_at: now,
          version: command.version ?? 0,
        })
        .returning();
      await writeQuestionBlockCreateEvent(db, {
        row,
        origin: 'edit_draft',
        actorKind: command.actorKind === 'system' ? 'system' : command.actorKind,
        actorRef: command.actorRef,
        now,
      });
      await projectQuestionBlockGuarded(db, row.id);
      // Preserve the INSERT row as the caller's result, rather than reloading the fold.
      return row;
    }
  }
}

/** Exclude legacy prompt and positional metadata from the strict create snapshot. */
function questionBlockRowToSnapshot(row: QuestionBlockRow): QuestionBlockRowSnapshotT {
  const { extracted_prompt_md: _legacy, ordinal: _ordinal, ...snapshot } = row;
  return snapshot as unknown as QuestionBlockRowSnapshotT;
}

interface WriteQuestionBlockCreateEventParams {
  row: QuestionBlockRow;
  origin: 'ocr' | 'rescue' | 'docx' | 'import' | 'edit_draft';
  actorKind: 'agent' | 'user' | 'system';
  actorRef: string;
  now: Date;
  causedByEventId?: string | null;
}

async function writeQuestionBlockCreateEvent(
  tx: Db | Tx,
  params: WriteQuestionBlockCreateEventParams,
): Promise<void> {
  // The snapshot carries extracted document text, so the event inherits the session's
  // usage policy. 'answer_only' keeps it out of memory/brief reads; ingest_at already
  // opts the row out of the outbox.
  const derivationPolicy = params.row.ingestion_session_id
    ? await resolveSessionDerivationPolicy(tx, params.row.ingestion_session_id)
    : 'allow';
  await writeEvent(tx, {
    id: newId(),
    // Bind the event to the ingestion session so reads resolve the live usage policy;
    // consent withdrawal applies retroactively via the session→document join.
    session_id: params.row.ingestion_session_id,
    actor_kind: params.actorKind,
    actor_ref: params.actorRef,
    action: 'experimental:question_block_create',
    subject_kind: 'question_block',
    subject_id: params.row.id,
    outcome: 'success',
    payload: {
      row: questionBlockRowToSnapshot(params.row),
      origin: params.origin,
      ...(derivationPolicy === 'allow' ? {} : { derivation_policy: derivationPolicy }),
    },
    caused_by_event_id: params.causedByEventId ?? undefined,
    created_at: params.now,
    ingest_at: params.now,
  });
}
