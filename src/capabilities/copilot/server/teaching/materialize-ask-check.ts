// Narrow ask_check INSERT reachable only through the teaching-skill's
// TeachingTurnTask composition.
//
// Service-layer DB write only: never a DomainTool, never in COPILOT_TOOLS. The
// caller owns the transaction; this fn runs just the INSERT plus the
// learning_item.knowledge_ids lookup.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { learning_item, question } from '@/db/schema';
import { withAnswerClass } from '@/kernel/records/answer-class-write';
import type { TeachingStructuredQuestionT } from '../../tasks/teaching-turn';

export interface MaterializeAskCheckParams {
  structured_question: TeachingStructuredQuestionT;
  learningItemId: string;
  /** Session id stamped on metadata.session_id as question provenance. */
  sessionId: string;
  /** Agent message event id stored as question.source_ref. */
  sourceRef: string;
  /** Fallback prompt when the structured question omits prompt_md. */
  fallbackPromptMd: string;
}

export interface MaterializedAskCheckQuestion {
  id: string;
  kind: string;
  prompt_md: string;
  choices_md: string[] | null;
}

/**
 * Insert the `teaching_check` question carried by an ask_check turn.
 *
 * CONTAINER-ONLY: the row lands draft_status='draft' so it belongs to its teaching
 * session (metadata.session_id provenance, source='teaching_check') and is never
 * selected by the general review pool (every pool path excludes draft; NULL≡active
 * would have made it ambiguously poolable). There is no promote path by design.
 * Any future teaching_check writer MUST set draft_status='draft' — enforced by
 * `pnpm audit:draft-status`.
 */
export async function materializeAskCheckQuestion(
  tx: Tx,
  params: MaterializeAskCheckParams,
): Promise<MaterializedAskCheckQuestion> {
  const { structured_question: structured, learningItemId, sessionId, sourceRef } = params;
  const qId = createId();
  const liRows = await tx
    .select({ knowledge_ids: learning_item.knowledge_ids })
    .from(learning_item)
    .where(eq(learning_item.id, learningItemId))
    .limit(1);
  const knowledgeIds = liRows[0]?.knowledge_ids ?? [];
  const promptMd = structured.prompt_md ?? params.fallbackPromptMd;
  const choicesMd = structured.choices_md ?? null;
  await tx.insert(question).values(
    withAnswerClass({
      id: qId,
      kind: structured.kind,
      prompt_md: promptMd,
      reference_md: structured.reference_md,
      rubric_json: structured.rubric_json ?? null,
      choices_md: choicesMd,
      judge_kind_override: structured.judge_kind_override ?? null,
      knowledge_ids: knowledgeIds,
      difficulty: 2,
      source: 'teaching_check',
      source_ref: sourceRef,
      // Container-only: draft so it never enters the general pool.
      draft_status: 'draft',
      metadata: {
        learning_item_id: learningItemId,
        session_id: sessionId,
      },
      created_at: new Date(),
      updated_at: new Date(),
    }),
  );
  return {
    id: qId,
    kind: structured.kind,
    prompt_md: promptMd,
    choices_md: choicesMd,
  };
}
