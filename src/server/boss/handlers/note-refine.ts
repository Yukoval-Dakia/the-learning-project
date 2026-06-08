// YUK-127 / T-88 P4-A — pg-boss handler for NoteRefineTask.
//
// Wave 6 Living Note v0 pipeline entrypoint. A trigger producer (P4-E) sends
// `{ artifact_id, trigger: { kind, context_md, evidence_ids? } }` onto the
// `note_refine` queue; this handler loads the artifact + knowledge context,
// calls `NoteRefineTask` for a NotePatch, then routes to apply (mutator) or
// proposal (propose).
//
// P4-A scope: queue plumbing, loading context, parsing NotePatch, calling
// `persistNoteRefineApply`. P4-B owns the mutator-vs-propose runtime gate
// (locked threshold `≤ 3 patch ops AND ≤ 2 new blocks → mutator`). Until
// P4-B lands we ALWAYS apply (mutator-only path); the gate hook is wired
// via `deps.gate?.(summary) => 'mutator' | 'propose'` so P4-B can swap in
// real gating without re-shaping the handler.
//
// PHASE-DEFERRED (P4-B): the default gate returns 'mutator' to keep P4-A
// scope minimal — P4-B replaces this with the real threshold + editing-
// session-aware logic. P4-C wires editing-session deferral; P4-D handles
// undo UI; P4-E adds the trigger producers. See
// `docs/superpowers/plans/2026-05-26-yuk88-block-tree-rebuild-phase.md` §P4.

import { eq, inArray } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import { NotePatch, type NotePatchT, summarizeNotePatch } from '@/core/schema/note-patch';
import type { Db } from '@/db/client';
import { artifact, knowledge } from '@/db/schema';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { bodyBlocksToBlockSummaries } from '@/server/artifacts/body-blocks';
import { enqueueOrApplyNoteRefinePatch } from '@/server/artifacts/editing-session';
import { decideNoteRefineMode } from '@/server/artifacts/note-refine-policy';
import { writeNoteRefineProposal } from '@/server/artifacts/note-refine-proposals';
import { resolveNoteSkill } from '@/subjects/note-skills';
import { resolveSubjectProfile } from '@/subjects/profile';

export type NoteRefineTriggerKind =
  | 'mark_wrong'
  | 'mastery_change'
  | 'error_rate'
  | 'dwell'
  | 'dreaming';

export interface NoteRefineJobData {
  artifact_id: string;
  trigger: {
    kind: NoteRefineTriggerKind;
    context_md?: string;
    evidence_ids?: string[];
    // P4-E producers may attach a trigger event id so the apply event can
    // chain caused_by to the trigger (mark_wrong attempt event, mastery
    // delta event, etc.).
    trigger_event_id?: string;
  };
}

export type RunTaskFn = TaskTextRunFn;

export type NoteRefineGate = (
  summary: ReturnType<typeof summarizeNotePatch>,
) => 'mutator' | 'propose';

type DepsOverride = {
  runTaskFn?: RunTaskFn;
  // PHASE-DEFERRED (P4-B): real gate goes here. P4-A default returns
  // 'mutator' unconditionally so the apply path is exercised end-to-end.
  gate?: NoteRefineGate;
  // Hook so P4-B's propose path can plug in its proposal writer without
  // forcing P4-A to wire that yet. Default is a no-op that returns the
  // patch summary verbatim so callers can still observe what would have
  // been proposed.
  onPropose?: (input: {
    artifactId: string;
    patch: NotePatchT;
    summary: ReturnType<typeof summarizeNotePatch>;
    triggerEventId: string | null;
  }) => Promise<void>;
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

export interface ParsedNoteRefineOutput {
  patch: NotePatchT;
}

export function parseNoteRefineOutput(text: string): ParsedNoteRefineOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseNoteRefineOutput: no JSON object found in text');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`parseNoteRefineOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  const parsed = NotePatch.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `parseNoteRefineOutput: schema invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return { patch: parsed.data };
}

export interface RunNoteRefineParams {
  db: Db;
  artifactId: string;
  trigger: NoteRefineJobData['trigger'];
  runTaskFn: RunTaskFn;
  gate?: NoteRefineGate;
  onPropose?: DepsOverride['onPropose'];
  now?: Date;
}

export type RunNoteRefineResult =
  | {
      status: 'applied';
      ops_count: number;
      new_blocks: number;
      event_id: string;
      artifact_version: number;
    }
  | { status: 'proposed'; ops_count: number; new_blocks: number }
  | { status: 'deferred'; ops_count: number; new_blocks: number }
  | { status: 'skipped:empty_patch' }
  | { status: 'skipped:not_found' }
  | { status: 'skipped:no_body_blocks' }
  | { status: 'skipped:archived' }
  | { status: 'skipped:version_conflict' };

const defaultGate: NoteRefineGate = decideNoteRefineMode;

/**
 * Pure runner — extracted so unit tests can call without pg-boss. Loads the
 * artifact + knowledge context, calls NoteRefineTask, parses the NotePatch,
 * then routes to apply (mutator) or proposal (propose) per the gate.
 */
export async function runNoteRefine(params: RunNoteRefineParams): Promise<RunNoteRefineResult> {
  const { db, artifactId, trigger, runTaskFn } = params;
  const gate = params.gate ?? defaultGate;
  const onPropose = params.onPropose;

  const rows = await db
    .select({
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      knowledge_ids: artifact.knowledge_ids,
      body_blocks: artifact.body_blocks,
      archived_at: artifact.archived_at,
    })
    .from(artifact)
    .where(eq(artifact.id, artifactId))
    .limit(1);
  const row = rows[0];
  if (!row) return { status: 'skipped:not_found' };
  if (row.archived_at) return { status: 'skipped:archived' };
  if (!row.body_blocks) return { status: 'skipped:no_body_blocks' };

  let kNode: { id: string; name: string; domain: string | null } | null = null;
  const primaryKnowledgeId = row.knowledge_ids[0] ?? null;
  if (primaryKnowledgeId && row.knowledge_ids.length > 0) {
    const kRows = await db
      .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
      .from(knowledge)
      .where(inArray(knowledge.id, row.knowledge_ids));
    kNode = kRows.find((node) => node.id === primaryKnowledgeId) ?? null;
  }

  const blockSummaries = bodyBlocksToBlockSummaries(row.body_blocks);

  const input = {
    artifact_id: row.id,
    artifact_type: row.type,
    title: row.title,
    knowledge_node: kNode,
    body_blocks: row.body_blocks,
    block_summaries: blockSummaries,
    trigger: {
      kind: trigger.kind,
      context_md: trigger.context_md ?? '',
      evidence_ids: trigger.evidence_ids ?? [],
    },
  };

  const subjectProfile = resolveSubjectProfile(kNode?.domain);
  const taskResult = await runTaskFn('NoteRefineTask', input, {
    db,
    subjectProfile,
    skills: await resolveNoteSkill(subjectProfile.id),
  });
  const { patch } = parseNoteRefineOutput(taskResult.text);
  const summary = summarizeNotePatch(patch);

  if (patch.ops.length === 0) {
    return { status: 'skipped:empty_patch' };
  }

  const triggerEventId = trigger.trigger_event_id ?? null;
  const decision = gate(summary);

  if (decision === 'propose') {
    if (onPropose) {
      await onPropose({
        artifactId,
        patch,
        summary,
        triggerEventId,
      });
    } else {
      await writeNoteRefineProposal({
        db,
        artifactId,
        patch,
        summary,
        triggerEventId,
        taskResult,
      });
    }
    return { status: 'proposed', ops_count: summary.ops_count, new_blocks: summary.new_blocks };
  }

  const applyResult = await enqueueOrApplyNoteRefinePatch({
    db,
    artifactId,
    patch,
    taskResult,
    triggerEventId,
    now: params.now,
  });

  if (applyResult.status === 'deferred') {
    return { status: 'deferred', ops_count: summary.ops_count, new_blocks: summary.new_blocks };
  }

  if (applyResult.status !== 'applied') {
    return { status: applyResult.status };
  }

  return {
    status: 'applied',
    ops_count: applyResult.ops_count ?? summary.ops_count,
    new_blocks: applyResult.new_blocks ?? summary.new_blocks,
    event_id: applyResult.event_id as string,
    artifact_version: applyResult.artifact_version as number,
  };
}

export function buildNoteRefineHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<NoteRefineJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
  const gate = deps.gate ?? defaultGate;
  const onPropose = deps.onPropose;
  return async (jobs) => {
    for (const job of jobs) {
      const data = job.data;
      if (!data?.artifact_id || !data?.trigger?.kind) {
        console.warn('[note_refine] job missing artifact_id/trigger.kind', job.id);
        continue;
      }
      try {
        const result = await runNoteRefine({
          db,
          artifactId: data.artifact_id,
          trigger: data.trigger,
          runTaskFn,
          gate,
          onPropose,
        });
        console.log(`[note_refine] ${data.artifact_id} → ${result.status}`);
      } catch (err) {
        console.error(`[note_refine] ${data.artifact_id} failed`, err);
        throw err;
      }
    }
  };
}
