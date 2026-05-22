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

import { JudgeKind, QuestionKind, Rubric } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { artifact, knowledge, question } from '@/db/schema';
import {
  type TaskTextResult,
  type TaskTextRunFn,
  aiAgentRef,
  costUsdToMicroUsd,
} from '@/server/ai/provenance';
import { writeEvent } from '@/server/events/queries';
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

const PROSE_KINDS = new Set(['short_answer', 'reading', 'translation', 'essay']);
const PENDING_STALE_MS = 30 * 60 * 1000;

function nonEmpty(values: string[] | undefined): string[] {
  return (values ?? []).map((v) => v.trim()).filter((v) => v.length > 0);
}

function defaultJudgeKindForQuestion(q: z.infer<typeof EmbeddedCheckQuestionSchema>) {
  if (q.judge_kind_override) return q.judge_kind_override;
  if (q.kind === 'choice' || q.kind === 'true_false') return 'exact';
  if (q.kind === 'fill_blank') {
    return nonEmpty(q.rubric_json?.keywords).length > 0 ? 'keyword' : 'exact';
  }
  if (q.kind === 'computation') {
    return nonEmpty(q.rubric_json?.keywords).length > 0 ? 'keyword' : 'semantic';
  }
  // M2.1 (2026-05-22): derivation must NEVER fall through to exact — step-by-step
  // answers cannot be graded by string equality. Embedded-check derivation runs
  // through semantic (required_points-driven); 'steps' route is reserved for
  // first-class math questions with reference_solution shape (see
  // src/core/capability/judges/steps.ts), not embedded checks. The
  // EmbeddedCheckGenerate prompt does not advertise 'derivation' as an option
  // (see canonicalKinds in src/ai/task-prompts.ts), but defense-in-depth covers
  // LLM hallucination + future prompt changes.
  if (q.kind === 'derivation') return 'semantic';
  return PROSE_KINDS.has(q.kind) ? 'semantic' : 'exact';
}

function assertGeneratedQuestionHasJudgeContract(
  q: z.infer<typeof EmbeddedCheckQuestionSchema>,
): void {
  const route = defaultJudgeKindForQuestion(q);
  if (route === 'keyword' && nonEmpty(q.rubric_json?.keywords).length === 0) {
    throw new Error(`embedded question '${q.prompt_md}' uses keyword judge without keywords`);
  }
  if (route === 'semantic' && nonEmpty(q.rubric_json?.required_points).length === 0) {
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
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`parseOutput: JSON.parse failed: ${(e as Error).message}`);
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
}

export async function runEmbeddedCheckGenerate(
  params: RunEmbeddedCheckGenerateParams,
): Promise<RunEmbeddedCheckGenerateResult> {
  const { db, artifactId, runTaskFn } = params;

  const rows = await db
    .select({
      id: artifact.id,
      title: artifact.title,
      knowledge_id: artifact.knowledge_id,
      sections: artifact.sections,
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

  const sections = (row.sections ?? []) as Array<{
    id: string;
    kind: string;
    embedded_check?: { question_ids: string[] } | null;
  }>;
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
  if (row.knowledge_id) {
    const kRows = await db
      .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
      .from(knowledge)
      .where(eq(knowledge.id, row.knowledge_id))
      .limit(1);
    kNode = kRows[0] ?? null;
  }
  const subjectProfile = resolveSubjectProfile(kNode?.domain);

  const input = {
    artifact_id: row.id,
    atomic_title: row.title,
    knowledge_node: kNode,
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
          knowledge_ids: row.knowledge_id ? [row.knowledge_id] : [],
          difficulty: 2,
          source_ref: row.id,
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

      const updatedSections = sections.map((s) =>
        s.id === checkSection.id ? { ...s, embedded_check: { question_ids: questionIds } } : s,
      );
      const finalUpdate = await tx
        .update(artifact)
        .set({
          sections: updatedSections as never,
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
      payload: { question_ids: questionIds, count: questionIds.length },
      caused_by_event_id: null,
      task_run_id: result.task_run_id ?? null,
      cost_micro_usd: costUsdToMicroUsd(result.cost_usd),
      created_at: new Date(),
    });

    return { status: 'ready', question_ids: questionIds };
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
