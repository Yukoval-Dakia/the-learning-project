// pg-boss entry for Living Note refine. A trigger producer sends
// `{ artifact_id, trigger }`; the runner loads the artifact and knowledge
// context, calls NoteRefineTask for a NotePatch, then applies small patches or
// files larger ones as proposals for human approval.

import { createId } from '@paralleldrive/cuid2';
import { eq, inArray } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import { enqueueOrApplyNoteRefinePatch } from '@/capabilities/notes/server/artifacts/editing-session';
import { bodyBlocksToBlockSummaries } from '@/capabilities/notes/server/body-blocks';
import { recordMasteryRefineEffectResult } from '@/capabilities/notes/server/mastery-refine-effect';
import {
  checkAutoApplyBreaker,
  countRecentAutoApplies,
} from '@/capabilities/notes/server/note-refine-breaker';
import {
  decideNoteRefineMode,
  patchTouchesVerifiedBlock,
} from '@/capabilities/notes/server/note-refine-policy';
import { writeNoteRefineProposal } from '@/capabilities/notes/server/note-refine-proposals';
import {
  type ParsedNoteRefineOutput,
  parseNoteRefineOutput,
} from '@/capabilities/notes/tasks/note-refine';
import { filterMissingNotePatchTargets } from '@/core/blocks/apply-note-patch';
import { type NotePatchT, summarizeNotePatch } from '@/core/schema/note-patch';
import type { Db } from '@/db/client';
import { artifact, knowledge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { resolveNoteSkillDoc } from '@/subjects/note-skills';
import { resolveSubjectProfile } from '@/subjects/profile';

export { type ParsedNoteRefineOutput, parseNoteRefineOutput };

export type NoteRefineTriggerKind = 'mark_wrong' | 'mastery_change' | 'dreaming' | 'verify';

export interface NoteRefineJobData {
  artifact_id: string;
  /** Present when the job was dispatched by an event-subscription effect. */
  effect_id?: string;
  trigger: {
    kind: NoteRefineTriggerKind;
    context_md?: string;
    evidence_ids?: string[];
    // Chains the apply event's caused_by to the originating trigger.
    trigger_event_id?: string;
  };
}

export type RunTaskFn = TaskTextRunFn;

export type NoteRefineGate = (
  summary: ReturnType<typeof summarizeNotePatch>,
) => 'mutator' | 'propose';

type DepsOverride = {
  runTaskFn?: RunTaskFn;
  // Test seam: forces a decision instead of the count gate.
  gate?: NoteRefineGate;
  // Test seam for the propose writer; production lands a real inbox proposal.
  onPropose?: (input: {
    artifactId: string;
    patch: NotePatchT;
    summary: ReturnType<typeof summarizeNotePatch>;
    triggerEventId: string | null;
    // Distinguishes a rate-breaker fallback from a routine propose.
    breakerTripped: boolean;
  }) => Promise<void>;
  // Test seam for the breaker's window count.
  countRecentAutoApplies?: (input: { now: Date }) => Promise<number>;
};

export interface RunNoteRefineParams {
  db: Db;
  artifactId: string;
  trigger: NoteRefineJobData['trigger'];
  runTaskFn: RunTaskFn;
  gate?: NoteRefineGate;
  onPropose?: DepsOverride['onPropose'];
  countRecentAutoApplies?: DepsOverride['countRecentAutoApplies'];
  now?: Date;
}

export type RunNoteRefineResult =
  | {
      status: 'applied';
      ops_count: number;
      new_blocks: number;
      event_id: string;
      artifact_version: number;
      skipped_ops?: number;
    }
  | { status: 'proposed'; ops_count: number; new_blocks: number; skipped_ops?: number }
  // The rate breaker diverted a mutator-eligible patch to human review; kept
  // distinct from a routine propose so callers can tell them apart.
  | {
      status: 'proposed:breaker_tripped';
      ops_count: number;
      new_blocks: number;
      skipped_ops?: number;
    }
  | { status: 'deferred'; ops_count: number; new_blocks: number; skipped_ops?: number }
  | { status: 'skipped:empty_patch'; skipped_ops?: number }
  | { status: 'skipped:target_not_found'; skipped_ops: number }
  | { status: 'skipped:not_found'; skipped_ops?: number }
  | { status: 'skipped:no_body_blocks'; skipped_ops?: number }
  | { status: 'skipped:archived'; skipped_ops?: number }
  | { status: 'skipped:version_conflict'; skipped_ops?: number };

const defaultGate: NoteRefineGate = decideNoteRefineMode;

/**
 * Loads context, calls NoteRefineTask, and routes the patch to apply or propose.
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
    subjectProfile,
    piSkillDocs: await resolveNoteSkillDoc(subjectProfile.id),
  });
  const { patch: modelPatch } = parseNoteRefineOutput(taskResult.text);

  if (modelPatch.ops.length === 0) {
    return { status: 'skipped:empty_patch' };
  }

  // Drop ghost targets before the gate: a dead reference must not inflate the
  // count or poison independent ops. Persistence re-checks against the latest
  // snapshot for deferred edits.
  const filtered = filterMissingNotePatchTargets(row.body_blocks, modelPatch, {
    enforceUserVerifiedGuard: false,
  });
  if (filtered.patch.ops.length === 0) {
    return { status: 'skipped:target_not_found', skipped_ops: filtered.skipped_ops };
  }
  const patch = filtered.patch;
  const summary = summarizeNotePatch(patch);
  const skipped = filtered.skipped_ops > 0 ? { skipped_ops: filtered.skipped_ops } : {};

  const triggerEventId = trigger.trigger_event_id ?? null;

  // Both propose paths share one dispatcher; only the breaker stamp differs.
  const dispatchPropose = async (breakerTripped: boolean): Promise<void> => {
    if (onPropose) {
      await onPropose({ artifactId, patch, summary, triggerEventId, breakerTripped });
    } else {
      await writeNoteRefineProposal({
        db,
        artifactId,
        patch,
        summary,
        triggerEventId,
        taskResult,
        breakerTripped,
      });
    }
  };

  // A patch that would overwrite a user-verified block goes to the inbox rather
  // than applying silently. applyNotePatch's guard remains the cross-caller net.
  const decision =
    gate(summary) === 'propose' || patchTouchesVerifiedBlock(row.body_blocks, patch)
      ? 'propose'
      : 'mutator';

  if (decision === 'propose') {
    await dispatchPropose(false);
    return {
      status: 'proposed',
      ops_count: summary.ops_count,
      new_blocks: summary.new_blocks,
      ...skipped,
    };
  }

  // Rate breaker: warn still applies (observe only), trip files a proposal the
  // user can accept. It never blocks the change outright.
  const breakerNow = params.now ?? new Date();
  const recentCount = params.countRecentAutoApplies
    ? await params.countRecentAutoApplies({ now: breakerNow })
    : await countRecentAutoApplies(db, { now: breakerNow });
  const breaker = checkAutoApplyBreaker({ recentCount });

  if (breaker.status === 'tripped') {
    await dispatchPropose(true);
    return {
      status: 'proposed:breaker_tripped',
      ops_count: summary.ops_count,
      new_blocks: summary.new_blocks,
      ...skipped,
    };
  }

  if (breaker.status === 'warned') {
    // Observe-only: an event failure must never block the apply below.
    try {
      await writeEvent(db, {
        id: createId(),
        session_id: null,
        actor_kind: 'system',
        actor_ref: 'note_refine',
        action: 'experimental:note_refine_autoapply_warned',
        subject_kind: 'artifact',
        subject_id: artifactId,
        outcome: 'success',
        payload: {
          artifact_id: artifactId,
          recent_count: recentCount,
          ops_count: summary.ops_count,
          new_blocks: summary.new_blocks,
        },
        caused_by_event_id: triggerEventId ?? null,
        created_at: breakerNow,
      });
    } catch (err) {
      console.warn(
        `[note_refine] warn-event emit failed for ${artifactId} (observe-only, apply continues)`,
        err,
      );
    }
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
    return {
      status: 'deferred',
      ops_count: summary.ops_count,
      new_blocks: summary.new_blocks,
      ...skipped,
    };
  }

  if (applyResult.status !== 'applied') {
    if (applyResult.status === 'skipped:target_not_found') {
      return {
        status: applyResult.status,
        skipped_ops: filtered.skipped_ops + (applyResult.skipped_ops ?? 0),
      };
    }
    return { status: applyResult.status, ...skipped };
  }

  return {
    status: 'applied',
    ops_count: applyResult.ops_count ?? summary.ops_count,
    new_blocks: applyResult.new_blocks ?? summary.new_blocks,
    event_id: applyResult.event_id as string,
    artifact_version: applyResult.artifact_version as number,
    ...((applyResult.skipped_ops ?? 0) + filtered.skipped_ops > 0
      ? { skipped_ops: (applyResult.skipped_ops ?? 0) + filtered.skipped_ops }
      : {}),
  };
}

export function buildNoteRefineHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<NoteRefineJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? makeRunTaskFn(db);
  const gate = deps.gate ?? defaultGate;
  const onPropose = deps.onPropose;
  const countRecentAutoAppliesOverride = deps.countRecentAutoApplies;
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
          countRecentAutoApplies: countRecentAutoAppliesOverride,
        });
        if (data.effect_id) {
          try {
            await recordMasteryRefineEffectResult({
              db,
              effectId: data.effect_id,
              status: result.status,
            });
          } catch (err) {
            // A missing receipt blocks logical restore, but must not replay paid work.
            console.error(
              `[note_refine] result receipt failed for ${data.effect_id} (${result.status}); owner reconciliation required: docs/sub5-restore-cli.md`,
              err,
            );
          }
        }
        const skippedOps = 'skipped_ops' in result ? (result.skipped_ops ?? 0) : 0;
        console.log(
          `[note_refine] ${data.artifact_id} → ${result.status}${skippedOps > 0 ? ` (${skippedOps} ghost op(s) skipped)` : ''}`,
        );
      } catch (err) {
        console.error(
          `[note_refine] ${data.artifact_id} failed (effect ${data.effect_id ?? 'none'}); after retries, reconcile via docs/sub5-restore-cli.md`,
          err,
        );
        throw err;
      }
    }
  };
}
