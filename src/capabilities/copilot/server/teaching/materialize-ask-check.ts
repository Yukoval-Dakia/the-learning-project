// AF S4 / YUK-203 U6 (OQ7, R2) — the narrow ask_check question INSERT, extracted
// from app/api/teaching-sessions/[id]/turn/route.ts:99-128 so BOTH the legacy
// teaching route and the Copilot teaching-skill share ONE impl.
//
// This stays a SERVICE-layer DB write reachable only through the teaching-skill's
// TeachingTurnTask composition — it is NEVER registered as a DomainTool and NEVER
// added to COPILOT_TOOLS (R2: raw DB mutation is an AF §1.2 non-capability). The
// caller decides the transaction; this fn only runs the INSERT + its
// learning_item.knowledge_ids lookup (the clean just-the-INSERT span — the
// corrective-failure counting via getActiveQuestionState is a post-commit read
// OUTSIDE this fn, §10 weakest-spot #2).
//
// SINGLE-SESSION note (Cross-统合 §4.2): when called from the teaching-skill,
// `sessionId` is the COPILOT session id, so metadata.session_id points at the
// Copilot session — exactly what getActiveQuestionState queries (active-question.ts
// metadata->>'session_id' = sessionId), so active-question resolution works
// against the Copilot session with zero change to that reader.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { learning_item, question } from '@/db/schema';
import type { TeachingStructuredQuestionT } from '@/server/orchestrator/teaching';

export interface MaterializeAskCheckParams {
  structured_question: TeachingStructuredQuestionT;
  learningItemId: string;
  /**
   * The conversation session this question belongs to. Legacy route → the
   * teaching session id; Copilot teaching-skill → the Copilot session id.
   * Stamped on metadata.session_id (the active-question reader's key).
   */
  sessionId: string;
  /**
   * The agent message event id this question was created alongside. Stored as
   * question.source_ref so the question is traceable to its turn.
   */
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
 * Insert the `teaching_check` question carried by an ask_check turn. Behavior is
 * byte-for-byte identical to the legacy inline INSERT (turn/route.ts) — a
 * regression test asserts the legacy route still produces an equivalent row.
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
  await tx.insert(question).values({
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
    metadata: {
      learning_item_id: learningItemId,
      session_id: sessionId,
    },
    created_at: new Date(),
    updated_at: new Date(),
  });
  return {
    id: qId,
    kind: structured.kind,
    prompt_md: promptMd,
    choices_md: choicesMd,
  };
}
