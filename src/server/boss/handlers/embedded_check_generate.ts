// Product Track 1 — generate inline self-test questions for atomic notes.
//
// Enqueued after note_verify marks an atomic artifact verified. Runs separately
// from note_verify: embedded check is about quizzing the learner, verify is about
// checking the writer. The generated questions are real question rows
// (source='embedded') so the existing attempt/mistake/attribution pipelines just
// work; only the scheduling axis (FSRS) is bypassed because embedded check is not
// a spaced-rep surface.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { z } from 'zod';

import { QuestionKind } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { artifact, knowledge, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { resolveSubjectProfile } from '@/subjects/profile';

export interface EmbeddedCheckGenerateJobData {
  artifact_id: string;
}

export type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;

type DepsOverride = { runTaskFn?: RunTaskFn };

const EmbeddedCheckQuestionSchema = z.object({
  kind: QuestionKind,
  prompt_md: z.string().min(1).max(400),
  reference_md: z.string().min(1).max(500),
  choices_md: z.array(z.string().min(1)).max(6).nullable().optional(),
});

const EmbeddedCheckOutputSchema = z.object({
  questions: z.array(EmbeddedCheckQuestionSchema).min(1).max(3),
});

type EmbeddedCheckOutput = z.infer<typeof EmbeddedCheckOutputSchema>;

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
  return parsed.data;
}

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
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
  | 'skipped:already_ready';

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
    })
    .from(artifact)
    .where(eq(artifact.id, artifactId))
    .limit(1);
  const row = rows[0];
  if (!row) return { status: 'skipped:not_found' };
  if (row.generation_status !== 'ready') return { status: 'skipped:not_ready' };
  if (row.embedded_check_status === 'ready') return { status: 'skipped:already_ready' };

  const sections = (row.sections ?? []) as Array<{
    id: string;
    kind: string;
    embedded_check?: { question_ids: string[] } | null;
  }>;
  const checkSection = sections.find((s) => s.kind === 'check');
  if (!checkSection) return { status: 'skipped:no_check_section' };

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

  // Mark pending so the UI shows "正在生成..." while AI runs
  await db
    .update(artifact)
    .set({ embedded_check_status: 'pending', updated_at: new Date() })
    .where(eq(artifact.id, artifactId));

  const input = {
    artifact_id: row.id,
    atomic_title: row.title,
    knowledge_node: kNode,
    sections,
  };

  try {
    const result = await runTaskFn('EmbeddedCheckGenerateTask', input, {
      db,
      subjectProfile,
    });
    const parsed = parseOutput(result.text);

    // Insert question rows in a single transaction, then update artifact
    const questionIds: string[] = [];
    await db.transaction(async (tx) => {
      for (const q of parsed.questions) {
        const id = createId();
        await tx.insert(question).values({
          id,
          kind: q.kind,
          source: 'embedded',
          prompt_md: q.prompt_md,
          reference_md: q.reference_md,
          choices_md: q.choices_md ?? null,
          knowledge_ids: row.knowledge_id ? [row.knowledge_id] : [],
          difficulty: 2,
          source_ref: row.id,
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
      await tx
        .update(artifact)
        .set({
          sections: updatedSections as never,
          embedded_check_status: 'ready',
          updated_at: new Date(),
        })
        .where(eq(artifact.id, artifactId));
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
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });

    return { status: 'ready', question_ids: questionIds };
  } catch (err) {
    await db
      .update(artifact)
      .set({ embedded_check_status: 'failed', updated_at: new Date() })
      .where(eq(artifact.id, artifactId));
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
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });
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
