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
// YUK-308 — the draft allowance is NARROW, code-enforced: a draft row is
// admitted only when it is a still-live copilot draft, i.e. EITHER
// source='copilot_authored' (author_question's marker — the same-turn write
// path that pairs the row with a question_draft proposal in one tx) OR a
// pending question_draft proposal exists for the row (the explicit spec
// branch; today only author_question writes that kind, so this is the same
// set — kept as a real check so a future question_draft producer stays
// admissible), AND it is not tombstoned (metadata.dismissed_at set by the
// question_draft dismiss applier, or metadata.archived_at set by
// archiveQuestion's soft-delete re-draft). Draft rows from every other
// pipeline (quiz_gen verify-failed, web_sourced source_verify-failed, …) are
// REJECTED: their promotion is gated behind their own verify/owner flow, and
// silently running them in a paper would bypass it.
//
// Artifact provenance: intent_source='quiz_gen' + tool_kind='quiz_gen' — the
// quiz-skill precedent (§3 decision there): a first-class paper provenance
// already on BOTH practice whitelists (practice-read.ts intent_source gate +
// /api/practice route), so the paper is runnable with ZERO whitelist edits.
// attrs.origin='copilot_write_quiz' disambiguates copilot-origin papers.
//
// YUK-308 — per-run idempotency guard (the deferred item, now landed with the
// same shape as retired write_review_plan's exactly-one-paper-per-run
// contract): one tx holds `pg_advisory_xact_lock(write_quiz:<taskRunId>)` while
// it checks for an existing copilot_write_quiz artifact stamped with this
// tool_context_task_run_id; a second call in the same run throws instead of
// persisting a duplicate paper (the signal the deferral note asked for:
// review_plan's twin guard exists precisely because the model DID double-write
// — codex PR #298). No UNIQUE index → no migration; the advisory lock closes
// the check-then-insert TOCTOU the same way.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { artifact, question } from '@/db/schema';
import { listProposalInboxRows } from '@/kernel/proposals/inbox';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { writeToolQuizArtifact } from './tool-quiz-core';

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
      source: question.source,
      metadata: question.metadata,
    })
    .from(question)
    .where(inArray(question.id, questionIds));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const missing = questionIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`write_quiz: question_id(s) do not exist: [${missing.join(',')}]`);
  }

  // YUK-308 — the RP-2 draft allowance is NARROW (header comment): a
  // draft_status='draft' row is admitted only when it is a same-turn
  // author_question product — source='copilot_authored' — that is still a live
  // draft (no dismissed_at tombstone written by the question_draft dismiss
  // applier, no archived_at soft-delete marker). Drafts from other pipelines
  // (quiz_gen / web_sourced / teaching_check / …) are gated behind their own
  // verify/owner promote flows and must NOT be smuggled into a runnable paper.
  const draftIds = questionIds.filter((id) => byId.get(id)?.draft_status === 'draft');
  // One batched read of pending question_draft proposals (the spec's second
  // admission branch). pendingProposalWithCooldown exists but keys on
  // cooldown_key, not the target question — the inbox list + proposed_change
  // question_id set is the equivalent-pending check.
  const pendingDraftTargets = new Set<string>();
  if (draftIds.some((id) => byId.get(id)?.source !== 'copilot_authored')) {
    const pending = await listProposalInboxRows(ctx.db, { status: 'pending' });
    for (const p of pending) {
      if (p.kind !== 'question_draft') continue;
      const change = p.payload.proposed_change;
      const qid =
        change && typeof change === 'object' && !Array.isArray(change)
          ? (change as Record<string, unknown>).question_id
          : undefined;
      if (typeof qid === 'string') pendingDraftTargets.add(qid);
    }
  }
  const nonCopilotDrafts = draftIds.filter((id) => {
    const row = byId.get(id);
    if (row?.source === 'copilot_authored') return false;
    return !pendingDraftTargets.has(id);
  });
  if (nonCopilotDrafts.length > 0) {
    throw new Error(
      `write_quiz: draft question_id(s) are neither copilot-authored drafts nor covered by a pending question_draft proposal (only author_question drafts may enter a paper pre-accept): [${nonCopilotDrafts.join(',')}]`,
    );
  }
  const tombstonedDrafts = questionIds.filter((id) => {
    const row = byId.get(id);
    if (row?.draft_status !== 'draft') return false;
    const meta = row.metadata as Record<string, unknown> | null;
    return meta?.dismissed_at != null || meta?.archived_at != null;
  });
  if (tombstonedDrafts.length > 0) {
    throw new Error(
      `write_quiz: draft question_id(s) are dismissed/archived (their proposal was rejected or the row was soft-deleted): [${tombstonedDrafts.join(',')}]`,
    );
  }

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
    // YUK-308 — exactly-one-paper-per-run (retired write_review_plan's contract,
    // codex PR #298): serialize same-run callers on an advisory xact lock, then
    // refuse the second write. A duplicate paper is non-destructive but leaks
    // two /practice links into one reply — the model DID double-write this
    // pattern before, so the guard is code, not convention. No UNIQUE index →
    // no migration; the lock closes the check-then-insert TOCTOU.
    if (ctx.taskRunId) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`write_quiz:${ctx.taskRunId}`}, 0))`,
      );
      const [existing] = await tx
        .select({ id: artifact.id })
        .from(artifact)
        .where(
          and(
            eq(artifact.tool_kind, 'quiz_gen'),
            sql`${artifact.attrs}->>'origin' = 'copilot_write_quiz'`,
            sql`${artifact.tool_state}->'session_meta'->>'tool_context_task_run_id' = ${ctx.taskRunId}`,
          ),
        )
        .limit(1);
      if (existing) {
        throw new Error(
          `write_quiz: a quiz paper already exists for this run (tool_context_task_run_id=${ctx.taskRunId}, artifact=${existing.id}) — only one paper may be written per run`,
        );
      }
    }
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
      // YUK-471 W3-C1β — chain the same-tx artifact_create to the copilot turn's causing event.
      causedByEventId: ctx.causedByEventId ?? null,
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
    'Assemble questions into ONE runnable tool_quiz practice paper and return a /practice/<id> link to embed in the reply. question_ids may include draft questions authored this turn via author_question (drafts are runnable in the paper pre-accept; pool/FSRS entry still waits for the proposal accept) as well as existing pool questions found via query_questions. Only author_question drafts are admitted — drafts from other pipelines, or ones whose proposal was dismissed, are rejected. Every question must carry at least one knowledge_id. Pure local write — call it once, after authoring/selecting all the questions for the paper (a second call in the same run is refused).',
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
