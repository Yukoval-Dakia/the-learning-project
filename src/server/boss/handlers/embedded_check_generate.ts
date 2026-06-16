// Product Track 1 — generate inline self-test questions for atomic notes.
//
// Enqueued after note_verify marks an atomic artifact verified. Runs separately
// from note_verify: embedded check is about quizzing the learner, verify is about
// checking the writer. The generated questions are real question rows
// (source='embedded') so the existing attempt/mistake/attribution pipelines just
// work; only the scheduling axis (FSRS) is bypassed because embedded check is not
// a spaced-rep surface.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { z } from 'zod';

import {
  bodyBlocksToBlockSummaries,
  bodyBlocksToNoteSections,
  setNoteSectionEmbeddedCheckArtifactRef,
} from '@/capabilities/notes/server/body-blocks';
import { JudgeKind, QuestionKind, Rubric } from '@/core/schema/business';
import {
  PROSE_KINDS,
  defaultJudgeKindForQuestion,
  nonEmptyStrings,
} from '@/core/schema/judge-routing';
import type { Db } from '@/db/client';
import { artifact, artifact_block_ref, knowledge, question } from '@/db/schema';
import {
  type TaskTextResult,
  type TaskTextRunFn,
  aiAgentRef,
  costUsdToMicroUsd,
} from '@/server/ai/provenance';
import { writeEvent } from '@/server/events/queries';
import { sanitizeJsonStringLiterals } from '@/server/orchestrator/json-sanitize';
import { resolveSubjectProfile } from '@/subjects/profile';

export interface EmbeddedCheckGenerateJobData {
  artifact_id: string;
}

export type RunTaskFn = TaskTextRunFn;

type DepsOverride = { runTaskFn?: RunTaskFn };

const EmbeddedCheckQuestionSchema = z.object({
  kind: QuestionKind,
  prompt_md: z.string().min(1).max(400),
  reference_md: z.string().min(1).max(500),
  choices_md: z.array(z.string().min(1)).max(6).nullable().optional(),
  judge_kind_override: JudgeKind.nullable().optional(),
  rubric_json: Rubric.nullable().optional(),
});

const EmbeddedCheckOutputSchema = z.object({
  questions: z.array(EmbeddedCheckQuestionSchema).min(1).max(3),
});

type EmbeddedCheckOutput = z.infer<typeof EmbeddedCheckOutputSchema>;

const PENDING_STALE_MS = 30 * 60 * 1000;

// defaultJudgeKindForQuestion / nonEmptyStrings / PROSE_KINDS now live in the
// shared @/core/schema/judge-routing util (Q1 of the search-grounded QuizGen
// wave) so QuizGen and EmbeddedCheckGenerate share one routing rule. The
// EmbeddedCheckQuestionSchema is structurally compatible with JudgeRoutableQuestion.

function assertGeneratedQuestionHasJudgeContract(
  q: z.infer<typeof EmbeddedCheckQuestionSchema>,
): void {
  const route = defaultJudgeKindForQuestion(q);
  if (route === 'keyword' && nonEmptyStrings(q.rubric_json?.keywords).length === 0) {
    throw new Error(`embedded question '${q.prompt_md}' uses keyword judge without keywords`);
  }
  if (route === 'semantic' && nonEmptyStrings(q.rubric_json?.required_points).length === 0) {
    throw new Error(
      `embedded question '${q.prompt_md}' uses semantic judge without required_points`,
    );
  }
  if ((PROSE_KINDS.has(q.kind) || q.kind === 'derivation') && route === 'exact') {
    // M2.1: derivation joins prose in the exact-forbidden set — graded step-by-step,
    // not by string equality. judge_kind_override='exact' on derivation is rejected
    // even if the LLM provides one (defense against LLM hallucination).
    throw new Error(`embedded ${q.kind} question '${q.prompt_md}' cannot use exact judge`);
  }
}

function parseOutput(text: string): EmbeddedCheckOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseOutput: no JSON object found in text');
  }
  const slice = text.slice(start, end + 1);
  let json: unknown;
  try {
    json = JSON.parse(slice);
  } catch (firstErr) {
    // LLM outputs sometimes embed bare control characters (newline/tab) inside
    // JSON string literals instead of their escape sequences, which JSON.parse
    // rejects. Retry once with the shared control-char sanitizer before giving
    // up. Structurally-broken (non-control-char) JSON still falls through to the
    // failed path with the ORIGINAL parse error message preserved so the
    // `parseOutput: JSON.parse failed:` contract (and existing assertions) hold.
    console.warn(
      '[embedded_check_generate] parseOutput: JSON.parse failed, retrying with control-char sanitizer:',
      (firstErr as Error).message,
    );
    try {
      json = JSON.parse(sanitizeJsonStringLiterals(slice));
    } catch {
      throw new Error(`parseOutput: JSON.parse failed: ${(firstErr as Error).message}`);
    }
  }
  const parsed = EmbeddedCheckOutputSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `parseOutput: schema invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  for (const question of parsed.data.questions) {
    assertGeneratedQuestionHasJudgeContract(question);
  }
  return parsed.data;
}

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<Awaited<ReturnType<RunTaskFn>>> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return result;
}

export interface RunEmbeddedCheckGenerateParams {
  db: Db;
  artifactId: string;
  runTaskFn: RunTaskFn;
}

export type RunEmbeddedCheckGenerateStatus =
  | 'ready'
  | 'failed'
  | 'skipped:not_found'
  | 'skipped:not_ready'
  | 'skipped:no_check_section'
  | 'skipped:already_ready'
  | 'skipped:already_in_progress';

export interface RunEmbeddedCheckGenerateResult {
  status: RunEmbeddedCheckGenerateStatus;
  question_ids?: string[];
  tool_quiz_artifact_id?: string;
}

export async function runEmbeddedCheckGenerate(
  params: RunEmbeddedCheckGenerateParams,
): Promise<RunEmbeddedCheckGenerateResult> {
  const { db, artifactId, runTaskFn } = params;

  const rows = await db
    .select({
      id: artifact.id,
      title: artifact.title,
      knowledge_ids: artifact.knowledge_ids,
      body_blocks: artifact.body_blocks,
      source_ref: artifact.source_ref,
      generation_status: artifact.generation_status,
      embedded_check_status: artifact.embedded_check_status,
      updated_at: artifact.updated_at,
    })
    .from(artifact)
    .where(eq(artifact.id, artifactId))
    .limit(1);
  const row = rows[0];
  if (!row) return { status: 'skipped:not_found' };
  if (row.generation_status !== 'ready') return { status: 'skipped:not_ready' };

  const sections = bodyBlocksToNoteSections(row.body_blocks);
  const checkSection = sections.find((s) => s.kind === 'check');
  if (!checkSection) return { status: 'skipped:no_check_section' };

  // Atomically claim the artifact only if status is in a re-runnable state.
  // 'not_required' = first attempt; 'failed' = retry after prior failure.
  // A pending claim older than 30 minutes is considered stale and can be
  // reclaimed; fresh pending still prevents duplicate work on pg-boss re-delivery.
  const pendingIsStale =
    row.embedded_check_status === 'pending' &&
    Date.now() - row.updated_at.getTime() > PENDING_STALE_MS;
  const claimableStatuses = pendingIsStale
    ? (['not_required', 'failed', 'pending'] as const)
    : (['not_required', 'failed'] as const);
  const claim = await db
    .update(artifact)
    .set({ embedded_check_status: 'pending', updated_at: new Date() })
    .where(
      and(
        eq(artifact.id, artifactId),
        inArray(artifact.embedded_check_status, [...claimableStatuses]),
      ),
    )
    .returning({ id: artifact.id, updated_at: artifact.updated_at });
  if (claim.length === 0) return { status: 'skipped:already_in_progress' };
  // Capture the claim's updated_at; the final UPDATE + catch-block UPDATE
  // both gate on this so that if another (stale-pending reclaim) handler
  // takes over while this one is mid-LLM-call, we don't stomp the reclaim
  // and we don't leave orphan question rows behind.
  const claimedUpdatedAt = claim[0].updated_at;

  // Resolve subject profile for prompt
  let kNode: { id: string; name: string; domain: string | null } | null = null;
  const primaryKnowledgeId = row.knowledge_ids[0] ?? null;
  if (primaryKnowledgeId) {
    const kRows = await db
      .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
      .from(knowledge)
      .where(eq(knowledge.id, primaryKnowledgeId))
      .limit(1);
    kNode = kRows[0] ?? null;
  }
  const subjectProfile = resolveSubjectProfile(kNode?.domain);

  const input = {
    artifact_id: row.id,
    atomic_title: row.title,
    knowledge_node: kNode,
    body_blocks: row.body_blocks,
    block_summaries: bodyBlocksToBlockSummaries(row.body_blocks),
    sections,
  };

  let taskResult: TaskTextResult | null = null;

  try {
    const result = await runTaskFn('EmbeddedCheckGenerateTask', input, {
      db,
      subjectProfile,
    });
    taskResult = result;
    const parsed = parseOutput(result.text);

    // Insert question rows in a single transaction, then update artifact
    const questionIds: string[] = [];
    const toolQuizArtifactId = createId();
    const proposalSourceRef =
      typeof row.source_ref === 'string' && row.source_ref.length > 0 ? row.source_ref : row.id;
    await db.transaction(async (tx) => {
      for (const q of parsed.questions) {
        const id = createId();
        const judgeKind = defaultJudgeKindForQuestion(q);
        await tx.insert(question).values({
          id,
          kind: q.kind,
          source: 'embedded',
          prompt_md: q.prompt_md,
          reference_md: q.reference_md,
          rubric_json: q.rubric_json ?? null,
          choices_md: q.choices_md ?? null,
          judge_kind_override: judgeKind,
          knowledge_ids: row.knowledge_ids,
          difficulty: 2,
          source_ref: row.id,
          // YUK-350 (L2, RL2) — land embedded checks as draft_status='draft'. An
          // embedded check is CONTAINER-ONLY by design: it is read solely by its
          // owning artifact via question_ids (note-page.ts inArray, no draft filter),
          // and must NEVER leak into the general review pool (every pool selection path
          // excludes draft: variant-rotation, due-list, review-session, etc.). There is
          // NO promote path and that is intentional — an embedded check is not a pool
          // candidate, so it stays draft for its whole life. Previously these rows had
          // a NULL draft_status, which the pool treats as active (NULL≡active), so they
          // were ambiguously poolable; 'draft' makes the container-only contract
          // explicit and pool-safe.
          draft_status: 'draft',
          created_by: aiAgentRef('EmbeddedCheckGenerateTask', result) as never,
          // FSRS isn't initialised here — embedded check questions don't
          // enter the spaced-rep surface unless the user later actively
          // promotes them. The first FSRS write happens lazily if/when
          // /api/review/submit ever sees this question_id.
          created_at: new Date(),
          updated_at: new Date(),
        });
        questionIds.push(id);
      }

      await tx.insert(artifact).values({
        id: toolQuizArtifactId,
        type: 'tool_quiz',
        title: `${row.title} 自检`,
        parent_artifact_id: null,
        knowledge_ids: row.knowledge_ids,
        intent_source: 'embedded_check',
        source: 'ai_generated',
        source_ref: proposalSourceRef,
        body_blocks: null,
        attrs: {
          embedded_for_artifact_id: row.id,
          source_artifact_id: row.id,
          check_block_id: checkSection.id,
        } as never,
        tool_kind: 'embedded_check',
        tool_state: {
          question_ids: questionIds,
          session_meta: { source_artifact_id: row.id, check_block_id: checkSection.id },
        } as never,
        generation_status: 'ready',
        verification_status: 'not_required',
        generated_by: aiAgentRef('EmbeddedCheckGenerateTask', result) as never,
        history: [],
        created_at: new Date(),
        updated_at: new Date(),
        version: 0,
      });

      await tx.insert(artifact_block_ref).values({
        from_artifact_id: row.id,
        from_block_id: checkSection.id,
        to_artifact_id: toolQuizArtifactId,
        to_block_id: null,
        // YUK-95 P5 (Wave 7 D4): tag the quiz ref so the generic cross_link
        // write-through (`syncBlockRefsForArtifact`) never recomputes it away.
        ref_kind: 'embedded_check',
      });

      const finalUpdate = await tx
        .update(artifact)
        .set({
          body_blocks: setNoteSectionEmbeddedCheckArtifactRef(
            row.body_blocks,
            checkSection.id,
            toolQuizArtifactId,
            questionIds,
          ) as never,
          embedded_check_status: 'ready',
          updated_at: new Date(),
        })
        .where(and(eq(artifact.id, artifactId), eq(artifact.updated_at, claimedUpdatedAt)))
        .returning({ id: artifact.id });
      if (finalUpdate.length === 0) {
        // Another handler (stale-pending reclaim) moved updated_at forward
        // between our claim and our commit. Throw to abort the transaction
        // and roll back the question INSERTs above.
        throw new Error(
          `embedded_check_generate: artifact ${artifactId} was reclaimed by another handler; rolling back`,
        );
      }
    });

    await writeEvent(db, {
      id: createId(),
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'embedded_check_generate',
      action: 'experimental:embedded_check_generate',
      subject_kind: 'artifact',
      subject_id: artifactId,
      outcome: 'success',
      payload: {
        question_ids: questionIds,
        tool_quiz_artifact_id: toolQuizArtifactId,
        count: questionIds.length,
      },
      caused_by_event_id: null,
      task_run_id: result.task_run_id ?? null,
      cost_micro_usd: costUsdToMicroUsd(result.cost_usd),
      created_at: new Date(),
    });

    return {
      status: 'ready',
      question_ids: questionIds,
      tool_quiz_artifact_id: toolQuizArtifactId,
    };
  } catch (err) {
    try {
      // Gate the 'failed' write on the claim timestamp so that if a reclaim
      // handler successfully moved the artifact to 'ready' (or to its own
      // 'pending'), our catch path doesn't stomp it back to 'failed'.
      await db
        .update(artifact)
        .set({ embedded_check_status: 'failed', updated_at: new Date() })
        .where(and(eq(artifact.id, artifactId), eq(artifact.updated_at, claimedUpdatedAt)));
      await writeEvent(db, {
        id: createId(),
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'embedded_check_generate',
        action: 'experimental:embedded_check_generate',
        subject_kind: 'artifact',
        subject_id: artifactId,
        outcome: 'failure',
        payload: { error: String((err as Error).message ?? err) },
        caused_by_event_id: null,
        task_run_id: taskResult?.task_run_id ?? null,
        cost_micro_usd: costUsdToMicroUsd(taskResult?.cost_usd),
        created_at: new Date(),
      });
    } catch (cleanupErr) {
      console.error(
        '[embedded_check_generate] catch-block cleanup failed for',
        artifactId,
        cleanupErr,
      );
    }
    throw err;
  }
}

export function buildEmbeddedCheckGenerateHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<EmbeddedCheckGenerateJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
  return async (jobs) => {
    for (const job of jobs) {
      const artifactId = job.data?.artifact_id;
      if (!artifactId) {
        console.warn('[embedded_check_generate] job missing artifact_id', job.id);
        continue;
      }
      const result = await runEmbeddedCheckGenerate({ db, artifactId, runTaskFn });
      console.log(`[embedded_check_generate] ${artifactId} -> ${result.status}`);
    }
  };
}
