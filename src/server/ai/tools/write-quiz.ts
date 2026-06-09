// ADR-0031 / YUK-304 (quiz C→A, lane B) — write_quiz: the copilot 组卷 write.
//
// The copilot (the orchestrator, 决定1) assembles questions it just authored
// (author_question knowledge|material → draft rows) and/or existing pool
// questions into ONE runnable tool_quiz paper + a /practice/<id> link it embeds
// in its reply. Pure local write — no LLM call.
//
// PRECONDITION CONTRAST (RP-2, docs/adr/0032-domaintool-surface-redesign.md:73):
// write_review_plan REJECTS draft questions (a nightly review paper must be
// runnable from the verified pool); write_quiz deliberately ALLOWS drafts — a
// question authored THIS TURN is still draft_status='draft' until the user
// accepts its question_draft proposal, yet the user asked for the paper NOW.
// The /practice runtime does not filter drafts, so the paper is fully runnable
// pre-accept; FSRS/pool entry still waits for the accept (决定5).
//
// Artifact provenance: intent_source='quiz_gen' + tool_kind='quiz_gen' — the
// quiz-skill precedent (§3 decision there): a first-class paper provenance
// already on BOTH practice whitelists (practice-read.ts intent_source gate +
// /api/practice route), so the paper is runnable with ZERO whitelist edits.
// attrs.origin='copilot_write_quiz' disambiguates copilot-origin papers.
//
// phase-deferred: NO per-run advisory lock / idempotency key (contrast
// write_review_plan's exactly-one-paper-per-run contract): a duplicate paper is
// non-destructive (two identical artifacts, no FSRS/pool side effects) and the
// copilot calls this once per user ask. Add a per-run guard only if real usage
// shows double-writes; context: YUK-304 + review-plan-tools.ts:754-794.

import { createId } from '@paralleldrive/cuid2';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';

import { question } from '@/db/schema';
import { writeToolQuizArtifact } from './tool-quiz-core';
import type { DomainTool, ToolContext } from './types';

const WriteQuizInputSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  // Practice order = array order. max 50 mirrors the practice-session scale.
  question_ids: z.array(z.string().min(1)).min(1).max(50),
});
type WriteQuizInput = z.input<typeof WriteQuizInputSchema>;

const WriteQuizOutputSchema = z.object({
  artifact_id: z.string(),
  question_count: z.number().int(),
  knowledge_ids: z.array(z.string()),
  /** Embed this link in the reply — it is the user's entry into the paper. */
  practice_path: z.string(),
});
type WriteQuizOutput = z.infer<typeof WriteQuizOutputSchema>;

async function executeWriteQuiz(
  ctx: ToolContext,
  rawInput: WriteQuizInput,
): Promise<WriteQuizOutput> {
  const input = WriteQuizInputSchema.parse(rawInput);
  const questionIds = input.question_ids;

  // Reject duplicates (write_review_plan discipline: a duplicate is a caller
  // mistake worth surfacing, not something to silently de-dup).
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const id of questionIds) {
    if (seen.has(id)) dups.add(id);
    else seen.add(id);
  }
  if (dups.size > 0) {
    throw new Error(`write_quiz: duplicate question_id(s): [${[...dups].join(',')}]`);
  }

  const rows = await ctx.db
    .select({
      id: question.id,
      knowledge_ids: question.knowledge_ids,
      draft_status: question.draft_status,
    })
    .from(question)
    .where(inArray(question.id, questionIds));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const missing = questionIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`write_quiz: question_id(s) do not exist: [${missing.join(',')}]`);
  }
  // NO draft gate here — see the RP-2 contrast in the header comment. (The
  // sibling write_review_plan throws on drafts; this tool's whole point is
  // running same-turn-authored drafts.)

  // Every question needs ≥1 knowledge id: ToolStateAssignment.primary_knowledge_id
  // is required (quiz-skill threw the same).
  const unlabeled = questionIds.filter((id) => (byId.get(id)?.knowledge_ids ?? []).length === 0);
  if (unlabeled.length > 0) {
    throw new Error(
      `write_quiz: question_id(s) have no knowledge_id (primary_knowledge_id would be undefined): [${unlabeled.join(',')}]`,
    );
  }

  const knowledgeFocus = new Set<string>();
  const assignments = questionIds.map((id) => {
    const knowledgeIds = byId.get(id)?.knowledge_ids ?? [];
    for (const k of knowledgeIds) knowledgeFocus.add(k);
    return {
      question_id: id,
      primary_knowledge_id: knowledgeIds[0],
      secondary_knowledge_ids: knowledgeIds.slice(1),
      selection_reason: 'copilot_write_quiz',
      review_profile_snapshot: {},
    };
  });

  const now = new Date();
  const artifactId = `art_${createId()}`;
  const knowledgeIds = [...knowledgeFocus];

  await ctx.db.transaction(async (tx) => {
    await writeToolQuizArtifact(tx, {
      artifactId,
      title: input.title ?? '练习卷',
      knowledgeIds,
      // Zero-whitelist runnability — see header comment (quiz-skill precedent).
      intentSource: 'quiz_gen',
      toolKind: 'quiz_gen',
      toolState: {
        question_ids: questionIds,
        sections: [
          {
            knowledge_focus: knowledgeIds,
            // Fixed 'immediate' (quiz-skill precedent): judgements are visible
            // as the user practices.
            feedback_policy: 'immediate',
            adaptation_policy: 'none',
            assignments,
          },
        ],
        session_meta: {
          origin: 'copilot_write_quiz',
          tool_context_task_run_id: ctx.taskRunId,
        },
      },
      attrs: { origin: 'copilot_write_quiz' },
      sourceRef: null,
      now,
    });
  });

  return {
    artifact_id: artifactId,
    question_count: questionIds.length,
    knowledge_ids: knowledgeIds,
    practice_path: `/practice/${artifactId}`,
  };
}

export const writeQuizTool: DomainTool<WriteQuizInput, WriteQuizOutput> = {
  name: 'write_quiz',
  description:
    'Assemble questions into ONE runnable tool_quiz practice paper and return a /practice/<id> link to embed in the reply. question_ids may include draft questions authored this turn via author_question (drafts are runnable in the paper pre-accept; pool/FSRS entry still waits for the proposal accept) as well as existing pool questions found via query_questions. Every question must carry at least one knowledge_id. Pure local write — call it once, after authoring/selecting all the questions for the paper.',
  effect: 'write',
  inputSchema: WriteQuizInputSchema,
  outputSchema: WriteQuizOutputSchema,
  costClass: 'local',
  // Copilot-initiated write — leave an event trail (evidence-first).
  mirrorEvent: 'when_causal',
  execute: executeWriteQuiz,
  summarize(_input, output) {
    return `write_quiz · ${output.question_count} questions · ${output.artifact_id}`;
  },
};
