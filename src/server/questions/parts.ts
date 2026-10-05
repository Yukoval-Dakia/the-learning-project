/**
 * T-QP (YUK-165, ADR-0014 §1) — owner service for `question_part`.
 *
 * A part is NOT a separate table — it is a `question` row linked to its parent
 * via `parent_question_id` (ordered by `part_index`). YUK-388/YUK-386:
 * `parent_question_id IS NOT NULL` is the SOLE authority for part-ness — every
 * read/cascade path derives it from the FK alone. The `kind='question_part'`
 * label is still stamped on insert as a display hint but is never consulted for
 * behavior (kind is a free-form label, not a behavioral enum). Because a part IS
 * a question, it gets FSRS state and
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
import { eq } from 'drizzle-orm';

import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import type { Tx } from '@/db/client';
import { question } from '@/db/schema';
import { withAnswerClass } from '@/server/questions/answer-class-write';
import { publishQuestionGroupFromRow } from '@/server/questions/publisher';

/** Matches the `question.metadata` jsonb column shape (Record<string, unknown>). */
type JsonObject = Record<string, unknown>;

/**
 * The display label stamped on part rows at insert time. NOT the part-ness
 * authority — readers/cascades detect parts via `parent_question_id` (YUK-388);
 * this label exists so a part row renders sensibly in kind-label surfaces.
 */
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
  /**
   * YUK-1011 — option BODIES for an objective (choice) part (the YUK-609
   * convention: renderers own the A/B/C labels by array index, so callers pass
   * `sub.options.map(o => o.text)`, never "A. …" prefixed text). Persisting it
   * keeps the runtime judge contract deterministic: route-resolve short-circuits
   * `choices_md.length > 0` → 'exact', and `withAnswerClass` derives
   * answer_class='exact' on write. Absent ⇒ NULL (a free-response part falls
   * through to the semantic route via its label's answer class — the
   * 'question_part' label itself classifies as semantic).
   */
  choicesMd?: string[] | null;
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
  /**
   * YUK-1011 — explicit draft_status for generated parts. Absent ⇒ the column
   * keeps its default (NULL ≡ active, the paper/import convention this owner was
   * allowlisted for). quiz_gen composite children pass 'draft' so the Option-B
   * gate (no pool membership before quiz_verify promotes the parent — which
   * cascades to its parts) holds for generated groups too.
   */
  draftStatus?: 'draft';
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
  // P1-1（第二轮复审）—— 锁序统一 root→child：先锁父组根再 INSERT 子行。
  //（INSERT 的外键检查会对父行取 KEY SHARE 锁，与根 FOR UPDATE 互斥 ——
  // 不预先显式锁根会与「先锁根再改子行」的事务形成锁序倒置。）
  const [rootLock] = await tx
    .select({ id: question.id })
    .from(question)
    .where(eq(question.id, input.parentQuestionId))
    .for('update')
    .limit(1);
  if (!rootLock) {
    throw new Error(`createQuestionPart: parent question '${input.parentQuestionId}' not found`);
  }
  await tx.insert(question).values(
    withAnswerClass({
      id: questionId,
      kind: QUESTION_PART_KIND,
      prompt_md: input.promptMd,
      reference_md: input.referenceMd ?? null,
      // YUK-1011 — objective parts persist their option bodies so route-resolve
      // short-circuits to the deterministic 'exact' judge instead of degrading a
      // choice sub to semantic grading.
      choices_md: input.choicesMd ?? null,
      knowledge_ids: input.knowledgeIds ?? [],
      difficulty: input.difficulty ?? 3,
      source: input.source,
      variant_depth: 0,
      // T-QP: the composition link + ordering — the columns this owner exists to write.
      parent_question_id: input.parentQuestionId,
      part_index: input.partIndex,
      // YUK-1011 — explicit when a caller drafts a part (quiz_gen composite
      // children); omitted ⇒ NULL ≡ active (legacy paper/import convention).
      draft_status: input.draftStatus,
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
  // YUK-1043 — 统一发布链：新 part 进入组 ⇒ 同事务重发父组 revision
  //（part 身份 = 子行 id；组契约含全部子 part，见 contract-normalizer）。
  await publishQuestionGroupFromRow(tx, {
    rootId: input.parentQuestionId,
    actorRef: `question-part:${input.source}`,
    now: input.now,
  });
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
