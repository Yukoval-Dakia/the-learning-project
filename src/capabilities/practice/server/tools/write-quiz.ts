// write_quiz: copilot paper assembly.
// The copilot combines questions it just authored and/or pool questions into one runnable
// tool_quiz paper plus a /practice/<id> link. Pure local write, no LLM call.
// Unlike write_review_plan, drafts are allowed: a question authored this turn is still
// draft until the user accepts its question_draft proposal, but the user asked for the
// paper now. The allowance is narrow: the row must be a live copilot draft
// (source='copilot_authored' or a pending question_draft proposal) and not tombstoned
// (metadata.dismissed_at / archived_at). Drafts from other pipelines are rejected because
// their promotion is gated by their own verify/owner flow.
// Admission reads run outside the artifact transaction, so the transaction re-reads every
// referenced question under FOR UPDATE in id order and re-checks the full invariant.
// Pending proposal ids take the shared proposal_decision advisory lock before row locks
// (decision -> row order) and are re-folded inside the tx. This closes dismiss, archive, and
// retract races without deadlocks.
// Provenance: intent_source='quiz_gen', tool_kind='quiz_gen', attrs.origin=
// 'copilot_write_quiz'. A per-run advisory lock on the task run id prevents a duplicate
// paper within one run.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db, Tx } from '@/db/client';
import { artifact, question } from '@/db/schema';
import { acquireProposalDecisionLock } from '@/kernel/proposals/applier-helpers';
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

/** Fold the pending inbox into [covered question_id, proposal_id] pairs for
 * question_draft proposals. Called pre-check AND inside the artifact tx
 * (post-decision-lock) — the two folds must share one extraction so the
 * in-tx re-check observes the same coverage semantics. */
async function pendingQuestionDraftTargets(db: Db | Tx): Promise<Array<[string, string]>> {
  const pending = await listProposalInboxRows(db, { status: 'pending' });
  const pairs: Array<[string, string]> = [];
  for (const p of pending) {
    if (p.kind !== 'question_draft') continue;
    const change = p.payload.proposed_change;
    const qid =
      change && typeof change === 'object' && !Array.isArray(change)
        ? (change as Record<string, unknown>).question_id
        : undefined;
    if (typeof qid === 'string') pairs.push([qid, p.id]);
  }
  return pairs;
}

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

  // the RP-2 draft allowance is NARROW (header comment): a
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
  // question_id set is the equivalent-pending check. The proposal ids covering
  // OUR drafts are captured alongside: the artifact tx re-locks them on the
  // shared proposal_decision advisory lock before re-folding ((b)).
  const pendingDraftTargets = new Set<string>();
  const reliedProposalIds = new Set<string>();
  if (draftIds.some((id) => byId.get(id)?.source !== 'copilot_authored')) {
    const pending = await pendingQuestionDraftTargets(ctx.db);
    for (const [qid, pid] of pending) {
      pendingDraftTargets.add(qid);
      if (byId.has(qid) && draftIds.includes(qid)) reliedProposalIds.add(pid);
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
    // exactly-one-paper-per-run (retired write_review_plan's contract,
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

    //in-tx admission re-check under locks (see header comment).
    // Lock order: write_quiz advisory → proposal_decision (sorted) → question
    // rows (sorted). Lifecycle paths (accept/dismiss/retract) take the decision
    // lock FIRST then update question rows — matching that prefix order keeps
    // this tx out of any lock cycle.
    if (reliedProposalIds.size > 0) {
      for (const pid of [...reliedProposalIds].sort()) {
        await acquireProposalDecisionLock(tx, pid);
      }
    }
    // Re-fold pending coverage post-lock: a retract that committed (or was
    // mid-flight) before our decision-lock grant is now visible; a retract
    // arriving later queues behind this tx — sequential-equivalent to landing
    // after the paper was written.
    const lockedDraftCoverage = new Set<string>();
    if (reliedProposalIds.size > 0) {
      for (const [qid] of await pendingQuestionDraftTargets(tx)) {
        lockedDraftCoverage.add(qid);
      }
    }

    // Lock ALL referenced ids — not just pre-check drafts ((a)): an
    // active row can be re-drafted + archived_at-tombstoned by archiveQuestion
    // in the same check-then-act gap.
    const racedTombstoned: string[] = [];
    const racedUncovered: string[] = [];
    for (const id of [...questionIds].sort()) {
      const locked = (
        await tx
          .select({
            draft_status: question.draft_status,
            source: question.source,
            metadata: question.metadata,
          })
          .from(question)
          .where(eq(question.id, id))
          .for('update')
          .limit(1)
      )[0];
      if (!locked) {
        // No hard-delete path exists today — fail closed anyway if a future
        // one removes the row between the pre-check and this lock.
        throw new Error(`write_quiz: question_id no longer exists (removed concurrently): [${id}]`);
      }
      // A row promoted draft→active by a racing accept is now a normal
      // pooled question — admissible as-is. Only a STILL-draft row can
      // carry the dismiss/archived tombstone or lose proposal coverage.
      if (locked.draft_status !== 'draft') continue;
      const meta = locked.metadata as Record<string, unknown> | null;
      if (meta?.dismissed_at != null || meta?.archived_at != null) {
        racedTombstoned.push(id);
      } else if (locked.source !== 'copilot_authored' && !lockedDraftCoverage.has(id)) {
        racedUncovered.push(id);
      }
    }
    // Same deterministic contracts as the pre-tx gates, same check order.
    if (racedTombstoned.length > 0) {
      throw new Error(
        `write_quiz: draft question_id(s) are dismissed/archived (their proposal was rejected or the row was soft-deleted): [${racedTombstoned.join(',')}]`,
      );
    }
    if (racedUncovered.length > 0) {
      throw new Error(
        `write_quiz: draft question_id(s) are neither copilot-authored drafts nor covered by a pending question_draft proposal (only author_question drafts may enter a paper pre-accept): [${racedUncovered.join(',')}]`,
      );
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
      // W3-C1β — chain the same-tx artifact_create to the copilot turn's causing event.
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
    'Assemble questions into ONE runnable tool_quiz practice paper and return a /practice/<id> link to embed in the reply. question_ids may include draft questions authored this turn via author_question (drafts are runnable in the paper pre-accept; pool/FSRS entry still waits for the proposal accept) as well as existing pool questions found via search_bank. Only author_question drafts are admitted — drafts from other pipelines, or ones whose proposal was dismissed, are rejected. Every question must carry at least one knowledge_id. Pure local write — call it once, after authoring/selecting all the questions for the paper (a second call in the same run is refused).',
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
