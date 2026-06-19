/**
 * T-QP (YUK-165, ADR-0014 §1) — owner service for `question_part`.
 *
 * A part is NOT a separate table — it is a `question` row tagged
 * `kind='question_part'` and linked to its parent via `parent_question_id`
 * (ordered by `part_index`). Because a part IS a question, it gets FSRS state and
 * flows through the existing `fsrs_question` review/due path UNCHANGED, with its
 * own question id and `subject_kind='question'`. Independent scheduling falls out
 * of parts being independent question rows; no new scheduling algorithm exists.
 *
 * This module is the INSERT write path for `question.parent_question_id` and
 * `question.part_index` (so `pnpm audit:schema` sees a real write path — no
 * allowlist entry needed). It mirrors how questions are created inline in the
 * ingestion owners (`src/capabilities/ingestion/api/import.ts`,
 * `src/server/ingestion/auto-enroll.ts`): `created_by` stays NULL by design —
 * provenance is carried by `metadata` + the event log, per ADR-0006 v2.
 *
 * Auto-splitting a multi-part SOURCE into parts is DEFERRED to T-OC. This module
 * only makes a multi-part question REPRESENTABLE as parent + ordered parts
 * (`representMultiPartQuestion`). See the lane plan §DEFERRED.
 */
import { createId } from '@paralleldrive/cuid2';

import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import type { Tx } from '@/db/client';
import { question } from '@/db/schema';
import { withAnswerClass } from '@/server/questions/answer-class-write';

/** Matches the `question.metadata` jsonb column shape (Record<string, unknown>). */
type JsonObject = Record<string, unknown>;

/** The `kind` tag that marks a question row as a part. */
export const QUESTION_PART_KIND = 'question_part' as const;

export interface CreateQuestionPartInput {
  /** The parent question this part belongs to. Must already exist. */
  parentQuestionId: string;
  /** 0-based position of this part within the parent. */
  partIndex: number;
  /** The part's own prompt. */
  promptMd: string;
  /** Optional reference answer for the part. */
  referenceMd?: string | null;
  /** Knowledge ids for the part (defaults to []). */
  knowledgeIds?: string[];
  /** 1-5 difficulty (defaults to the question default of 3 when omitted). */
  difficulty?: number;
  /**
   * Provenance source string for the `question.source` NOT-NULL column (e.g. the
   * ingestion session entrypoint). Mirrors how the question owners set `source`.
   */
  source: string;
  /** Optional structured tree for the part. */
  structured?: StructuredQuestionT | null;
  /** Optional figures for the part. */
  figures?: FigureRefT[];
  /** Optional image refs for the part. */
  imageRefs?: string[];
  /**
   * Optional provenance metadata. `created_by` stays NULL by design (ADR-0006 v2);
   * traceability rides metadata + events. The owner always stamps
   * `part_of_question_id` so the part is traceable to its parent in metadata too.
   */
  metadata?: JsonObject;
  /** Wall-clock timestamp shared with the caller's batch. */
  now: Date;
  /** Optional explicit id (defaults to a fresh cuid2). */
  id?: string;
}

export interface CreatedQuestionPart {
  /** The part's own question id — its FSRS / review / activity identity. */
  questionId: string;
  partIndex: number;
}

/**
 * Insert one part question row under a parent. Must run inside the caller's
 * transaction so it commits atomically with the parent question + any enrollment.
 */
export async function createQuestionPart(
  tx: Tx,
  input: CreateQuestionPartInput,
): Promise<CreatedQuestionPart> {
  const questionId = input.id ?? createId();
  await tx.insert(question).values(
    withAnswerClass({
      id: questionId,
      kind: QUESTION_PART_KIND,
      prompt_md: input.promptMd,
      reference_md: input.referenceMd ?? null,
      knowledge_ids: input.knowledgeIds ?? [],
      difficulty: input.difficulty ?? 3,
      source: input.source,
      variant_depth: 0,
      // T-QP: the composition link + ordering — the columns this owner exists to write.
      parent_question_id: input.parentQuestionId,
      part_index: input.partIndex,
      figures: input.figures ?? [],
      image_refs: input.imageRefs ?? [],
      structured: input.structured ?? null,
      metadata: {
        ...(input.metadata ?? {}),
        // Always traceable to the parent in metadata (mirrors the ingestion
        // metadata-provenance convention). `created_by` stays NULL by design.
        part_of_question_id: input.parentQuestionId,
        part_index: input.partIndex,
      },
      created_at: input.now,
      updated_at: input.now,
      version: 0,
    }),
  );
  return { questionId, partIndex: input.partIndex };
}

export interface RepresentMultiPartInput {
  /** The parent (umbrella) question id. Must already exist as a question row. */
  parentQuestionId: string;
  /** Ordered parts. `part_index` is assigned by array order (0-based). */
  parts: Array<Omit<CreateQuestionPartInput, 'parentQuestionId' | 'partIndex' | 'now' | 'source'>>;
  /** Shared `source` for all parts. */
  source: string;
  /** Wall-clock timestamp. */
  now: Date;
}

/**
 * Represent a multi-part question as its (already-created) parent plus N ordered
 * parts. Does NOT create the parent — the caller owns that via the existing
 * question-creation paths; this composes the parts under it. Auto-splitting a raw
 * source into these parts is DEFERRED to T-OC.
 */
export async function representMultiPartQuestion(
  tx: Tx,
  input: RepresentMultiPartInput,
): Promise<CreatedQuestionPart[]> {
  const created: CreatedQuestionPart[] = [];
  for (let i = 0; i < input.parts.length; i++) {
    const part = input.parts[i];
    created.push(
      await createQuestionPart(tx, {
        ...part,
        parentQuestionId: input.parentQuestionId,
        partIndex: i,
        source: input.source,
        now: input.now,
      }),
    );
  }
  return created;
}
