// Phase 2B — async per-atomic note generation.
//
// Enqueued by /api/learning-intents/[id]/accept (one job per atomic artifact).
// Picks up { artifact_id }, loads context (artifact row + parent hub +
// knowledge node), calls NoteGenerateTask, parses 5 sections, UPDATEs the
// artifact row to generation_status='ready' + sections=[].
//
// Failures: mark artifact.generation_status='failed' so the UI can surface
// the broken state instead of stuck-pending. pg-boss retries on throw per
// queue policy.

import { type SQL, and, eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { z } from 'zod';

import { NoteSection } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { artifact, knowledge } from '@/db/schema';

export interface NoteGenerateJobData {
  artifact_id: string;
}

export type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;

type DepsOverride = {
  runTaskFn?: RunTaskFn;
};

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
}

const SectionsOutputSchema = z.object({
  sections: z.array(NoteSection).min(1).max(10),
});

function parseSectionsOutput(text: string): z.infer<typeof SectionsOutputSchema> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseSectionsOutput: no JSON object found in text');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`parseSectionsOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  const parsed = SectionsOutputSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `parseSectionsOutput: schema invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed.data;
}

export interface RunNoteGenerateParams {
  db: Db;
  artifactId: string;
  runTaskFn: RunTaskFn;
}

export interface RunNoteGenerateResult {
  status: 'ready' | 'skipped:not_pending' | 'skipped:not_found' | 'failed';
  sections_count?: number;
}

/**
 * Pure runner — extracted so unit tests can call without pg-boss.
 *
 * Loads the atomic artifact + its parent hub artifact + the knowledge node
 * for context, runs NoteGenerateTask, persists sections to the artifact row.
 * Idempotent: returns 'skipped:not_pending' if generation_status !== 'pending'.
 */
export async function runNoteGenerate(
  params: RunNoteGenerateParams,
): Promise<RunNoteGenerateResult> {
  const { db, artifactId, runTaskFn } = params;

  const rows = await db
    .select({
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      knowledge_id: artifact.knowledge_id,
      parent_artifact_id: artifact.parent_artifact_id,
      outline_json: artifact.outline_json,
      generation_status: artifact.generation_status,
    })
    .from(artifact)
    .where(eq(artifact.id, artifactId))
    .limit(1);
  const row = rows[0];
  if (!row) return { status: 'skipped:not_found' };
  if (row.generation_status !== 'pending') return { status: 'skipped:not_pending' };

  // Load parent hub (for context)
  let parentHub: { title: string; outline_json: unknown } | null = null;
  if (row.parent_artifact_id) {
    const parentRows = await db
      .select({
        title: artifact.title,
        outline_json: artifact.outline_json,
      })
      .from(artifact)
      .where(eq(artifact.id, row.parent_artifact_id))
      .limit(1);
    parentHub = parentRows[0] ?? null;
  }

  // Load knowledge node for context
  let kNode: { id: string; name: string; domain: string | null } | null = null;
  if (row.knowledge_id) {
    const kRows = await db
      .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
      .from(knowledge)
      .where(eq(knowledge.id, row.knowledge_id))
      .limit(1);
    kNode = kRows[0] ?? null;
  }

  const oneLine =
    (row.outline_json as { one_line_intent?: string } | null)?.one_line_intent ?? null;
  const parentSummary =
    (parentHub?.outline_json as { summary_md?: string } | null)?.summary_md ?? null;

  const input = {
    atomic_title: row.title,
    one_line_intent: oneLine,
    knowledge_node: kNode,
    parent_hub: parentHub ? { title: parentHub.title, summary_md: parentSummary } : null,
    related_knowledge_ids: [] as string[], // Phase 2.5: mesh-walk for related nodes
  };

  try {
    const result = await runTaskFn('NoteGenerateTask', input, { db });
    const parsed = parseSectionsOutput(result.text);

    await db
      .update(artifact)
      .set({
        sections: parsed.sections,
        generation_status: 'ready',
        generated_by: {
          by: 'ai',
          task_kind: 'NoteGenerateTask',
        } as never,
        updated_at: new Date(),
      })
      .where(and(eq(artifact.id, artifactId), eq(artifact.generation_status, 'pending')));

    return { status: 'ready', sections_count: parsed.sections.length };
  } catch (err) {
    // Mark failed so UI doesn't sit on "pending" forever; pg-boss will still
    // retry per policy because we rethrow.
    await db
      .update(artifact)
      .set({ generation_status: 'failed', updated_at: new Date() })
      .where(eq(artifact.id, artifactId));
    throw err;
  }
}

export function buildNoteGenerateHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<NoteGenerateJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
  return async (jobs) => {
    for (const job of jobs) {
      const artifactId = job.data?.artifact_id;
      if (!artifactId) {
        console.warn('[note_generate] job missing artifact_id', job.id);
        continue;
      }
      try {
        const result = await runNoteGenerate({ db, artifactId, runTaskFn });
        console.log(`[note_generate] ${artifactId} → ${result.status}`);
      } catch (err) {
        console.error(`[note_generate] ${artifactId} failed`, err);
        throw err;
      }
    }
  };
}

// suppress unused
void (null as SQL | null);
