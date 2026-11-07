/**
 * Block-capture owner: the single question-row write for a captured block and the single
 * enroll → block-transition step. Native capture, auto-enroll and import completion call
 * these inside their own transaction; nothing here opens a transaction or takes a lock.
 * Revert relies on the `ingestion_session_id` / `question_block_id` metadata keys and the
 * block's import links, so both are written only here.
 */
import { eq, inArray } from 'drizzle-orm';
import {
  type FigureRefT,
  type StructuredQuestionT,
  structuredToPromptMarkdown,
} from '@/core/schema/structured_question';
import type { Tx } from '@/db/client';
import { question, type question_block, source_asset } from '@/db/schema';
import { withAnswerClass } from '@/kernel/records/answer-class-write';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
import { applyQuestionBlockTransition } from '@/kernel/records/question-block-transitions';
import {
  type EnrollCapturedBlockInput,
  type EnrollCapturedBlockResult,
  enrollCapturedBlock,
} from '../enroll';
import { figuresForQuestion } from '../figure_attach';

type Block = typeof question_block.$inferSelect;

export function capturedQuestionShape(structured: StructuredQuestionT | null) {
  const choices = structured?.options?.map((option) => option.text) ?? [];
  return {
    kind:
      structured?.kind ??
      (choices.length > 0 ? 'choice' : structured?.role === 'stem' ? 'reading' : 'short_answer'),
    choices_md: choices.length > 0 ? choices : null,
  };
}

export type CapturedQuestionContent =
  /** Straight off the extracted block: prompt derives from the tree, figures only from verified crops. */
  | {
      from: 'block';
      block: Pick<
        Block,
        | 'structured'
        | 'extracted_prompt_md'
        | 'reference_md'
        | 'figures'
        | 'source_asset_ids'
        | 'image_refs'
      >;
    }
  /** What the learner confirmed at import, taken as given. */
  | {
      from: 'review';
      promptMd: string;
      referenceMd: string | null;
      structured: StructuredQuestionT | null;
      figures: FigureRefT[];
      imageRefs: string[];
    };

export interface CapturedQuestionInput {
  questionId: string;
  sessionId: string;
  blockId: string;
  sourceDocumentId: string | null;
  /** learning_session.entrypoint of the capture. */
  source: string;
  content: CapturedQuestionContent;
  /** Defaults to the kind derived from the structured tree. */
  kind?: (typeof question.$inferInsert)['kind'];
  knowledgeIds: string[];
  difficulty: number;
  draftStatus: 'draft' | 'active' | null;
  visualComplexity?: string | null;
  extraMetadata?: Record<string, unknown>;
  /**
   * Import only: a pending captured original whose content already matches is relinked
   * (lifecycle + metadata) instead of inserted again; its revision already exists.
   */
  reuse?: { metadata: Record<string, unknown> | null };
  /** Publication actor of the first revision. */
  actorRef: string;
  now: Date;
}

export async function recordCapturedQuestion(tx: Tx, input: CapturedQuestionInput): Promise<void> {
  const metadata = {
    ...(input.reuse?.metadata ?? {}),
    ...input.extraMetadata,
    // A block's image_refs are the photographed source pages, not this question's
    // picture. Keep them as machine prompt input but keep them off learner reads.
    ...(input.content.from === 'block' ? { prompt_images_are_source_pages: true } : {}),
    source_document_id: input.sourceDocumentId,
    ingestion_session_id: input.sessionId,
    question_block_id: input.blockId,
  };
  if (input.reuse) {
    await tx
      .update(question)
      .set({ draft_status: input.draftStatus, metadata, updated_at: input.now })
      .where(eq(question.id, input.questionId));
    return;
  }
  const content = await resolveContent(tx, input.content);
  const shape = capturedQuestionShape(content.structured);
  await tx.insert(question).values(
    withAnswerClass({
      id: input.questionId,
      kind: input.kind ?? shape.kind,
      choices_md: shape.choices_md,
      prompt_md: content.promptMd,
      reference_md: content.referenceMd,
      structured: content.structured,
      figures: content.figures,
      image_refs: content.imageRefs,
      knowledge_ids: input.knowledgeIds,
      difficulty: input.difficulty,
      ...(input.visualComplexity !== undefined
        ? { visual_complexity: input.visualComplexity }
        : {}),
      source: input.source,
      variant_depth: 0,
      draft_status: input.draftStatus,
      metadata,
      created_at: input.now,
      updated_at: input.now,
      version: 0,
    }),
  );
  // First revision in the same transaction; admission state is the publisher's call.
  await publishQuestionGroupFromRow(tx, {
    rootId: input.questionId,
    actorRef: input.actorRef,
    now: input.now,
  });
}

async function resolveContent(tx: Tx, content: CapturedQuestionContent) {
  if (content.from === 'review') return content;
  const { block } = content;
  const figureAssets = block.figures.length
    ? await tx
        .select({
          id: source_asset.id,
          storage_key: source_asset.storage_key,
          sha256: source_asset.sha256,
        })
        .from(source_asset)
        .where(
          inArray(
            source_asset.id,
            block.figures.map((figure) => figure.asset_id),
          ),
        )
    : [];
  return {
    promptMd: block.structured
      ? structuredToPromptMarkdown(block.structured)
      : (block.extracted_prompt_md ?? ''),
    referenceMd: block.reference_md ?? null,
    structured: block.structured ?? null,
    figures: figuresForQuestion(block.structured, block.figures, {
      sourceAssetIds: block.source_asset_ids,
      assets: figureAssets,
    }),
    // Whole source pages stay machine prompt input (vision solving/grading read them);
    // learner reads drop them via the metadata marker written in recordCapturedQuestion.
    imageRefs: block.image_refs,
  };
}

/**
 * How the caller keeps a concurrent capture of the same block out: native capture CASes on
 * the version it activated against; auto-enroll holds the block row lock from its draft
 * re-read; import holds the session lock with every source block checked draft.
 */
export type CapturedBlockGuard =
  | { kind: 'version_cas'; version: number }
  | { kind: 'row_locked' }
  | { kind: 'session_locked' };

export async function settleCapturedBlock(
  tx: Tx,
  input: {
    transition: 'auto_enroll' | 'complete_import';
    blockId: string;
    guard: CapturedBlockGuard;
    enroll: EnrollCapturedBlockInput;
  },
): Promise<EnrollCapturedBlockResult> {
  const enrolled = await enrollCapturedBlock(tx, input.enroll);
  await applyQuestionBlockTransition(
    tx,
    {
      kind: input.transition,
      blockId: input.blockId,
      questionId: input.enroll.questionId,
      attemptEventId: enrolled.attemptEventId,
      ...(input.guard.kind === 'version_cas' ? { expectedVersion: input.guard.version } : {}),
    },
    input.enroll.now,
  );
  return enrolled;
}
