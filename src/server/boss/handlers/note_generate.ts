// Phase 2B — async per generated note artifact.
//
// Enqueued by /api/learning-intents/[id]/accept (one job per atomic/long artifact).
// Picks up { artifact_id }, loads context (artifact row + parent hub +
// knowledge node), calls NoteGenerateTask, parses 5 semantic sections, UPDATEs
// the artifact row to generation_status='ready' + body_blocks.
//
// Failures: mark artifact.generation_status='failed' so the UI can surface
// the broken state instead of stuck-pending. pg-boss retries on throw per
// queue policy.

import { type SQL, and, eq, inArray } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { z } from 'zod';

import { ArtifactBodyBlocks, NoteSection } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { artifact, knowledge } from '@/db/schema';
import { type TaskTextRunFn, aiAgentRef } from '@/server/ai/provenance';
import { bodyBlocksToNoteSections, noteSectionsToBodyBlocks } from '@/server/artifacts/body-blocks';
import { resolveSubjectProfile } from '@/subjects/profile';

export interface NoteGenerateJobData {
  artifact_id: string;
}

export type RunTaskFn = TaskTextRunFn;

type DepsOverride = {
  runTaskFn?: RunTaskFn;
  onReady?: (artifactId: string) => Promise<void>;
};

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<Awaited<ReturnType<RunTaskFn>>> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return result;
}

const SectionsOutputSchema = z.object({
  sections: z.array(NoteSection).min(1).max(10),
});
const BodyBlocksOutputSchema = z.object({
  body_blocks: ArtifactBodyBlocks,
});

function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseNoteGenerateOutput: no JSON object found in text');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`parseNoteGenerateOutput: JSON.parse failed: ${(e as Error).message}`);
  }
}

export interface ParsedNoteGenerateOutput {
  body_blocks: z.infer<typeof ArtifactBodyBlocks>;
  blocks_count: number;
  sections_count: number;
}

export function parseNoteGenerateOutput(text: string): ParsedNoteGenerateOutput {
  const json = parseJsonObject(text);

  const bodyBlocksParsed = BodyBlocksOutputSchema.safeParse(json);
  if (bodyBlocksParsed.success) {
    const bodyBlocks = bodyBlocksParsed.data.body_blocks;
    return {
      body_blocks: bodyBlocks,
      blocks_count: bodyBlocks.content.length,
      sections_count: bodyBlocksToNoteSections(bodyBlocks).length,
    };
  }

  const sectionsParsed = SectionsOutputSchema.safeParse(json);
  if (sectionsParsed.success) {
    const bodyBlocks = noteSectionsToBodyBlocks(sectionsParsed.data.sections);
    return {
      body_blocks: bodyBlocks,
      blocks_count: bodyBlocks.content.length,
      sections_count: sectionsParsed.data.sections.length,
    };
  }

  throw new Error(
    `parseNoteGenerateOutput: schema invalid: body_blocks=${bodyBlocksParsed.error.issues
      .map((i) => i.message)
      .join('; ')}; parseSectionsOutput=${sectionsParsed.error.issues
      .map((i) => i.message)
      .join('; ')}`,
  );
}

export interface RunNoteGenerateParams {
  db: Db;
  artifactId: string;
  runTaskFn: RunTaskFn;
}

export interface RunNoteGenerateResult {
  status: 'ready' | 'skipped:not_pending' | 'skipped:not_found' | 'failed';
  sections_count?: number;
  blocks_count?: number;
}

/**
 * Pure runner — extracted so unit tests can call without pg-boss.
 *
 * Loads the atomic artifact + its parent hub artifact + the knowledge node
 * for context, runs NoteGenerateTask, persists semantic blocks to the artifact row.
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
      knowledge_ids: artifact.knowledge_ids,
      parent_artifact_id: artifact.parent_artifact_id,
      attrs: artifact.attrs,
      generation_status: artifact.generation_status,
    })
    .from(artifact)
    .where(eq(artifact.id, artifactId))
    .limit(1);
  const row = rows[0];
  if (!row) return { status: 'skipped:not_found' };
  if (row.generation_status !== 'pending') return { status: 'skipped:not_pending' };

  // Load parent hub (for context)
  let parentHub: { title: string; attrs: unknown } | null = null;
  if (row.parent_artifact_id) {
    const parentRows = await db
      .select({
        title: artifact.title,
        attrs: artifact.attrs,
      })
      .from(artifact)
      .where(eq(artifact.id, row.parent_artifact_id))
      .limit(1);
    parentHub = parentRows[0] ?? null;
  }

  // Load knowledge node for context
  let kNode: { id: string; name: string; domain: string | null } | null = null;
  let kNodes: Array<{ id: string; name: string; domain: string | null }> = [];
  if (row.knowledge_ids.length > 0) {
    const kRows = await db
      .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
      .from(knowledge)
      .where(inArray(knowledge.id, row.knowledge_ids));
    const byId = new Map(kRows.map((node) => [node.id, node]));
    kNodes = row.knowledge_ids.map((id) => byId.get(id)).filter((node) => node !== undefined);
    kNode = kNodes[0] ?? null;
  }

  const oneLine = (row.attrs as { one_line_intent?: string } | null)?.one_line_intent ?? null;
  const parentSummary = (parentHub?.attrs as { summary_md?: string } | null)?.summary_md ?? null;

  const input = {
    artifact_id: row.id,
    artifact_type: row.type,
    atomic_title: row.title,
    title: row.title,
    one_line_intent: oneLine,
    knowledge_node: kNode,
    knowledge_nodes: kNodes,
    parent_hub: parentHub ? { title: parentHub.title, summary_md: parentSummary } : null,
    related_knowledge_ids: row.knowledge_ids.slice(1), // Phase 2.5: mesh-walk for related nodes
  };

  try {
    const result = await runTaskFn('NoteGenerateTask', input, {
      db,
      subjectProfile: resolveSubjectProfile(kNode?.domain),
    });
    const parsed = parseNoteGenerateOutput(result.text);

    await db
      .update(artifact)
      .set({
        body_blocks: parsed.body_blocks as never,
        generation_status: 'ready',
        verification_status: 'queued',
        generated_by: {
          ...aiAgentRef('NoteGenerateTask', result),
        } as never,
        updated_at: new Date(),
      })
      .where(and(eq(artifact.id, artifactId), eq(artifact.generation_status, 'pending')));

    return {
      status: 'ready',
      sections_count: parsed.sections_count,
      blocks_count: parsed.blocks_count,
    };
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
  const onReady = deps.onReady;
  return async (jobs) => {
    for (const job of jobs) {
      const artifactId = job.data?.artifact_id;
      if (!artifactId) {
        console.warn('[note_generate] job missing artifact_id', job.id);
        continue;
      }
      try {
        const result = await runNoteGenerate({ db, artifactId, runTaskFn });
        if (result.status === 'ready') {
          await onReady?.(artifactId);
        }
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
