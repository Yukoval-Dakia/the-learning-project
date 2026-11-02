/**
 * Owner service for `question_part`.
 *
 * A part is a `question` row linked to its parent via `parent_question_id` and
 * ordered by `part_index`; that FK — not the display-only `kind='question_part'`
 * label — is the sole part-ness authority. Parts therefore get their own FSRS
 * state through the normal question path. This module is the sole INSERT writer
 * for the composition link; auto-splitting a source into parts is deferred.
 */
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';

import type { DifficultyEvidenceT } from '@/core/schema/difficulty-evidence';
import type { QuizGenMetadataT, QuizGenQuestionT } from '@/core/schema/quiz_gen';
import {
  type FigureRefT,
  type StructuredQuestionT,
  structuredToPromptMarkdown,
  structuredToReferenceMarkdown,
} from '@/core/schema/structured_question';
import type { Tx } from '@/db/client';
import { question } from '@/db/schema';
import { withAnswerClass } from '@/kernel/records/answer-class-write';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
import type { SupplyTraceV1T } from './question-supply/evidence-demand';

/** Matches the `question.metadata` jsonb column shape (Record<string, unknown>). */
type JsonObject = Record<string, unknown>;

/** Display label stamped on part rows; part-ness itself is read from `parent_question_id`. */
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
  /** Provenance source for the NOT-NULL `question.source` column. */
  source: string;
  /** Optional structured tree for the part. */
  structured?: StructuredQuestionT | null;
  /**
   * Option bodies for a choice part (renderers add A/B/C labels by index).
   * Non-empty choices keep route-resolve on the deterministic 'exact' judge.
   */
  choicesMd?: string[] | null;
  /** Optional figures for the part. */
  figures?: FigureRefT[];
  /** Optional image refs for the part. */
  imageRefs?: string[];
  /** Provenance metadata; `created_by` stays NULL and the owner stamps the parent link. */
  metadata?: JsonObject;
  /** Explicit draft status for generated parts; absent keeps the active default. */
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
  // Lock root → child: the INSERT's FK check takes KEY SHARE on the parent, so
  // locking the root first preserves the writer-wide lock order.
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
      choices_md: input.choicesMd ?? null,
      knowledge_ids: input.knowledgeIds ?? [],
      difficulty: input.difficulty ?? 3,
      source: input.source,
      variant_depth: 0,
      parent_question_id: input.parentQuestionId,
      part_index: input.partIndex,
      draft_status: input.draftStatus,
      figures: input.figures ?? [],
      image_refs: input.imageRefs ?? [],
      structured: input.structured ?? null,
      metadata: {
        ...(input.metadata ?? {}),
        part_of_question_id: input.parentQuestionId,
        part_index: input.partIndex,
      },
      created_at: input.now,
      updated_at: input.now,
      version: 0,
    }),
  );
  // The new part joins the group, so republish the parent revision in this transaction.
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
 * Represent a multi-part question as an existing parent plus N ordered parts.
 * The caller owns parent creation; auto-splitting a raw source is deferred.
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

export interface MaterializeGeneratedQuestionPartsInput {
  parentQuestionId: string;
  structured: StructuredQuestionT;
  /** The exact knowledge labels persisted on the generated parent. */
  knowledgeIds: string[];
  difficulty: QuizGenQuestionT['difficulty'];
  quizGenMetadata: QuizGenMetadataT;
  difficultyEvidence: DifficultyEvidenceT;
  supplyTrace?: SupplyTraceV1T;
  now: Date;
}

/**
 * Materialize a fresh generated parent's ordered child rows in its existing Tx.
 * Own the child render/choice projection and metadata together with part insertion
 * and per-part group publication. Parent dedup, eligibility and verification stay
 * with the generation operation; an existing or merged parent never enters here.
 */
export async function materializeGeneratedQuestionParts(
  tx: Tx,
  input: MaterializeGeneratedQuestionPartsInput,
): Promise<number> {
  const {
    parentQuestionId: id,
    structured,
    knowledgeIds: duplicateKnowledgeIds,
    difficulty,
    quizGenMetadata: metaQuizGen,
    difficultyEvidence,
    supplyTrace: questionSupplyTrace,
    now,
  } = input;
  const subs = structured.sub_questions ?? [];
  for (const [partIndex, sub] of subs.entries()) {
    const narrowed: StructuredQuestionT = {
      ...structured,
      sub_questions: [sub],
    };
    // YUK-1011 codex P2 — when the sub's options persist separately as
    // choices_md (below), derive the child prompt WITHOUT the inline
    // option list: renderers (PfSolo/PfPaper) paint persisted choices as
    // buttons, so keeping them in prompt_md too would show every choice
    // twice. The `structured` tree keeps the options — only the derived
    // prompt view drops them.
    const { options: subOptions, ...subSansOptions } = sub;
    const hasOptions = subOptions != null && subOptions.length > 0;
    const promptTree: StructuredQuestionT = hasOptions
      ? { ...narrowed, sub_questions: [subSansOptions] }
      : narrowed;
    await createQuestionPart(tx, {
      parentQuestionId: id,
      partIndex,
      promptMd: structuredToPromptMarkdown(promptTree),
      referenceMd: structuredToReferenceMarkdown(narrowed),
      // ADR-0028 (U0 A2, recorded on ADR-0014 §12): a generated part
      // inherits its parent's PERSISTED knowledge labels at write time —
      // an unlabeled part would be invisible to the KC-keyed pool fetch,
      // attempts on it would update no KC theta/mastery, and the verify
      // cascade could only enroll it under the legacy question-level
      // fallback. duplicateKnowledgeIds is the exact set the parent row
      // persists (target KCs first, then model attribution).
      knowledgeIds: duplicateKnowledgeIds,
      // YUK-1011 codex P1 — an objective sub (options) must persist its
      // option bodies so the row keeps the deterministic 'exact' judge
      // contract (route-resolve: choices_md.length > 0 → 'exact');
      // otherwise PfSolo renders free-text and grading degrades to
      // semantic. Bodies only — renderers own the letter labels
      // (YUK-609), the exact judge resolves letters↔indices itself.
      choicesMd: hasOptions ? subOptions.map((o) => o.text) : null,
      difficulty,
      source: 'quiz_gen',
      structured: narrowed,
      draftStatus: 'draft',
      metadata: {
        quiz_gen: metaQuizGen,
        difficulty_evidence: difficultyEvidence,
        ...(questionSupplyTrace ? { supply_trace: questionSupplyTrace } : {}),
        // The normalized sub-node id — the part_ref coordinate the judge
        // narrowing / UI use to address this part inside the parent tree.
        part_ref: sub.id,
      },
      now,
    });
  }
  return subs.length;
}
