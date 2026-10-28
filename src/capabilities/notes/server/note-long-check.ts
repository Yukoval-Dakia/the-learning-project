// YUK-1642 — long-note check-and-revise round on top of the existing judge
// (NoteVerifyTask). When the first check flags a note_long with error-severity
// issues, exactly one revision runs through NoteGenerateTask and one recheck
// through the same verification claim machine. The marker under
// attrs.note_long_check keeps the loop states separate:
//   passed           — first check passed
//   revising         — revision round claimed (base_version pinned)
//   revised          — revision ran, recheck passed
//   still_failing    — revision ran, recheck still flags issues (未通过核对)
//   check_failed     — the judge itself could not complete this epoch
//   revision_failed  — the revision round failed; the original body stays
// Every failure path keeps the original body and never claims verified.
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { type TaskTextResult, aiAgentRef } from '@/ai/task-result';
import {
  emitArtifactBodyBlocksEditEvent,
  emitArtifactLifecycleEvent,
} from '@/capabilities/notes/server/artifacts/mutation-events';
import { syncBlockRefsForArtifact } from '@/capabilities/notes/server/block-refs';
import {
  type NoteGenerateSourceRow,
  loadNoteGenerateTaskInput,
} from '@/capabilities/notes/server/note-generation-input';
import {
  type NoteGenerationReference,
  assertNoteGenerationReferences,
  lockCurrentNoteGenerationReferences,
} from '@/capabilities/notes/server/note-generation-references';
import {
  type RunTaskFn,
  runNoteVerify,
} from '@/capabilities/notes/server/note-verify-durable-operation';
import { parseNoteGenerateOutput } from '@/capabilities/notes/tasks/note-tasks';
import type {
  ArtifactBodyBlocksT,
  ArtifactHistoryEntryT,
  NoteVerificationResultT,
} from '@/core/schema/business';
import type { Db, Tx } from '@/db/client';
import { artifact } from '@/db/schema';
import { costUsdToMicroUsd } from '@/kernel/cost';
import { resolveNoteSkillDoc } from '@/subjects/note-skills';
import { resolveSubjectProfile } from '@/subjects/profile';

export const NOTE_LONG_CHECK_ATTR = 'note_long_check';
export const NOTE_LONG_CHECK_ACTOR_REF = 'note_long_check';
export const NOTE_LONG_CHECK_DETAIL_MAX = 500;

const MarkerBase = {
  at: z.string().min(1),
  task_run_id: z.string().min(1).nullable().optional(),
};

export const NoteLongCheckSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('passed'), ...MarkerBase }),
  z.object({
    status: z.literal('revising'),
    base_version: z.number().int().nonnegative(),
    revised_version: z.number().int().nonnegative().optional(),
    ...MarkerBase,
  }),
  z.object({
    status: z.literal('revised'),
    base_version: z.number().int().nonnegative(),
    ...MarkerBase,
  }),
  z.object({
    status: z.literal('still_failing'),
    base_version: z.number().int().nonnegative(),
    ...MarkerBase,
  }),
  z.object({
    status: z.literal('check_failed'),
    detail: z.string().max(NOTE_LONG_CHECK_DETAIL_MAX),
    ...MarkerBase,
  }),
  z.object({
    status: z.literal('revision_failed'),
    detail: z.string().max(NOTE_LONG_CHECK_DETAIL_MAX),
    ...MarkerBase,
  }),
]);

export type NoteLongCheck = z.infer<typeof NoteLongCheckSchema>;

function attrsRecord(attrs: unknown): Record<string, unknown> {
  if (attrs !== null && typeof attrs === 'object' && !Array.isArray(attrs)) {
    return { ...(attrs as Record<string, unknown>) };
  }
  return {};
}

export function readNoteLongCheck(attrs: unknown): NoteLongCheck | null {
  const parsed = NoteLongCheckSchema.safeParse(attrsRecord(attrs)[NOTE_LONG_CHECK_ATTR]);
  return parsed.success ? parsed.data : null;
}

function attrsWithNoteLongCheck(attrs: unknown, check: NoteLongCheck): Record<string, unknown> {
  return { ...attrsRecord(attrs), [NOTE_LONG_CHECK_ATTR]: check };
}

/** A fresh generation epoch starts the check cycle from scratch. */
export function attrsClearingNoteLongCheck(attrs: unknown): {
  attrs: Record<string, unknown>;
  cleared: boolean;
} {
  const next = attrsRecord(attrs);
  if (!Object.hasOwn(next, NOTE_LONG_CHECK_ATTR)) return { attrs: next, cleared: false };
  delete next[NOTE_LONG_CHECK_ATTR];
  return { attrs: next, cleared: true };
}

type LongNoteCheckRow = {
  type: string;
  generation_status: string;
  verification_status: string;
  verification_summary: NoteVerificationResultT | null;
  attrs: unknown;
  version: number;
  archived_at: Date | null;
};

type LongNoteCheckDecision =
  | { kind: 'none' }
  | { kind: 'finalize' }
  | { kind: 'revise' }
  | { kind: 'recheck' };

function longNoteCheckIssuesHaveErrors(summary: NoteVerificationResultT | null): boolean {
  return (summary?.issues ?? []).some((issue) => issue.severity === 'error');
}

function decideLongNoteCheck(row: LongNoteCheckRow): LongNoteCheckDecision {
  const marker = readNoteLongCheck(row.attrs);
  switch (row.verification_status) {
    case 'verified':
      if (!marker || marker.status === 'revising') return { kind: 'finalize' };
      return { kind: 'none' };
    case 'needs_review':
      if (!marker) {
        return longNoteCheckIssuesHaveErrors(row.verification_summary)
          ? { kind: 'revise' }
          : { kind: 'none' };
      }
      // 'revising' under needs_review is terminal only through finalize: the
      // version bump inside the revision write is what proves the round ran.
      if (marker.status === 'revising') return { kind: 'finalize' };
      return { kind: 'none' };
    case 'failed':
      if (!marker || marker.status === 'revising') return { kind: 'finalize' };
      return { kind: 'none' };
    case 'queued':
      if (marker?.status === 'revising' && marker.revised_version !== undefined) {
        return { kind: 'recheck' };
      }
      return { kind: 'none' };
    default:
      return { kind: 'none' };
  }
}

function nextFinalizedLongNoteCheck(row: {
  verification_status: string;
  attrs: unknown;
}): NoteLongCheck | null {
  const marker = readNoteLongCheck(row.attrs);
  const at = new Date().toISOString();
  switch (row.verification_status) {
    case 'verified':
      if (!marker) return { status: 'passed', at };
      if (marker.status === 'revising') {
        return {
          status: 'revised',
          base_version: marker.base_version,
          task_run_id: marker.task_run_id ?? null,
          at,
        };
      }
      return null;
    case 'needs_review':
      if (marker?.status !== 'revising') return null;
      return marker.revised_version !== undefined
        ? {
            status: 'still_failing',
            base_version: marker.base_version,
            task_run_id: marker.task_run_id ?? null,
            at,
          }
        : {
            status: 'revision_failed',
            detail: 'revision round did not complete; original body kept',
            task_run_id: marker.task_run_id ?? null,
            at,
          };
    case 'failed':
      if (!marker)
        return { status: 'check_failed', detail: 'note verification could not complete', at };
      if (marker.status === 'revising') {
        return {
          status: 'check_failed',
          detail:
            marker.revised_version !== undefined
              ? 'recheck could not complete after revision'
              : 'note verification failed during the revision round',
          at,
        };
      }
      return null;
    default:
      return null;
  }
}

/** Apply a marker transition under the artifact lock; the builder re-reads the
 * current state so a racing writer simply makes this a no-op. */
async function applyLongNoteCheckMarker(
  db: Db,
  artifactId: string,
  build: (row: {
    verification_status: string;
    attrs: unknown;
    version: number;
  }) => NoteLongCheck | null,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        attrs: artifact.attrs,
        verification_status: artifact.verification_status,
        version: artifact.version,
      })
      .from(artifact)
      .where(eq(artifact.id, artifactId))
      .for('update')
      .limit(1);
    const row = rows[0];
    if (!row) return false;
    const next = build(row);
    if (!next) return false;
    const attrs = attrsWithNoteLongCheck(row.attrs, next);
    const now = new Date();
    const updated = await tx
      .update(artifact)
      .set({ attrs: attrs as never, updated_at: now })
      .where(and(eq(artifact.id, artifactId), eq(artifact.version, row.version)))
      .returning({ id: artifact.id });
    if (updated.length !== 1) return false;
    await emitArtifactLifecycleEvent(tx, {
      subjectId: artifactId,
      op: 'set_attrs',
      attrs,
      nextVersion: row.version,
      actorKind: 'agent',
      actorRef: NOTE_LONG_CHECK_ACTOR_REF,
      createdAt: now,
    });
    return true;
  });
}

function cappedDetail(detail: string): string {
  return detail.length > NOTE_LONG_CHECK_DETAIL_MAX
    ? detail.slice(0, NOTE_LONG_CHECK_DETAIL_MAX)
    : detail;
}

function taskRunIdOf(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('taskRunId' in error)) return null;
  const value = (error as { taskRunId?: unknown }).taskRunId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function recordLongNoteRevisionFailure(params: {
  db: Db;
  artifactId: string;
  baseVersion: number;
  taskRunId: string | null;
  detail: string;
}): Promise<void> {
  const recorded = await applyLongNoteCheckMarker(params.db, params.artifactId, (row) => {
    const marker = readNoteLongCheck(row.attrs);
    if (
      row.verification_status !== 'needs_review' ||
      row.version !== params.baseVersion ||
      marker?.status !== 'revising' ||
      marker.base_version !== params.baseVersion
    ) {
      return null;
    }
    return {
      status: 'revision_failed' as const,
      detail: cappedDetail(params.detail),
      task_run_id: params.taskRunId,
      at: new Date().toISOString(),
    };
  });
  if (!recorded) {
    console.log(
      `[note_long_check] ${params.artifactId} revision failure not recorded (state moved on)`,
    );
  }
}

type LongNoteArtifactRow = LongNoteCheckRow & {
  id: string;
  title: string;
  knowledge_ids: string[];
  parent_artifact_id: string | null;
  body_blocks: ArtifactBodyBlocksT | null;
};

async function loadLongNoteArtifact(
  db: Db,
  artifactId: string,
): Promise<LongNoteArtifactRow | null> {
  const rows = await db
    .select({
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      knowledge_ids: artifact.knowledge_ids,
      parent_artifact_id: artifact.parent_artifact_id,
      attrs: artifact.attrs,
      body_blocks: artifact.body_blocks,
      generation_status: artifact.generation_status,
      verification_status: artifact.verification_status,
      verification_summary: artifact.verification_summary,
      archived_at: artifact.archived_at,
      version: artifact.version,
    })
    .from(artifact)
    .where(eq(artifact.id, artifactId))
    .limit(1);
  return rows[0] ?? null;
}

type RevisionClaim = {
  baseVersion: number;
  issues: NoteVerificationResultT['issues'];
  source: NoteGenerateSourceRow;
  bodyBlocks: ArtifactBodyBlocksT | null;
};

/** Single-flight claim of the one revision round for this epoch: marker absent
 * → 'revising' pinned to the current version, in one CAS write. */
async function claimLongNoteRevision(db: Db, artifactId: string): Promise<RevisionClaim | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        type: artifact.type,
        title: artifact.title,
        knowledge_ids: artifact.knowledge_ids,
        parent_artifact_id: artifact.parent_artifact_id,
        attrs: artifact.attrs,
        body_blocks: artifact.body_blocks,
        generation_status: artifact.generation_status,
        verification_status: artifact.verification_status,
        verification_summary: artifact.verification_summary,
        archived_at: artifact.archived_at,
        version: artifact.version,
      })
      .from(artifact)
      .where(eq(artifact.id, artifactId))
      .for('update')
      .limit(1);
    const row = rows[0];
    if (
      !row ||
      row.type !== 'note_long' ||
      row.generation_status !== 'ready' ||
      row.verification_status !== 'needs_review' ||
      row.archived_at !== null ||
      readNoteLongCheck(row.attrs) !== null
    ) {
      return null;
    }
    const now = new Date();
    const attrs = attrsWithNoteLongCheck(row.attrs, {
      status: 'revising',
      base_version: row.version,
      at: now.toISOString(),
    });
    const updated = await tx
      .update(artifact)
      .set({ attrs: attrs as never, updated_at: now })
      .where(
        and(
          eq(artifact.id, artifactId),
          eq(artifact.version, row.version),
          eq(artifact.verification_status, 'needs_review'),
        ),
      )
      .returning({ id: artifact.id });
    if (updated.length !== 1) return null;
    await emitArtifactLifecycleEvent(tx, {
      subjectId: artifactId,
      op: 'set_attrs',
      attrs,
      nextVersion: row.version,
      actorKind: 'agent',
      actorRef: NOTE_LONG_CHECK_ACTOR_REF,
      createdAt: now,
    });
    return {
      baseVersion: row.version,
      issues: row.verification_summary?.issues ?? [],
      source: {
        id: artifactId,
        type: row.type,
        title: row.title,
        knowledge_ids: row.knowledge_ids,
        parent_artifact_id: row.parent_artifact_id,
        attrs: row.attrs,
      },
      bodyBlocks: (row.body_blocks ?? null) as ArtifactBodyBlocksT | null,
    };
  });
}

/** Abort the paid call before the provider boundary when the claim was lost
 * (learner edit, regeneration, archive, or a competing writer). */
async function assertRevisionClaimHeld(
  db: Db,
  artifactId: string,
  baseVersion: number,
): Promise<void> {
  const rows = await db
    .select({
      version: artifact.version,
      generation_status: artifact.generation_status,
      verification_status: artifact.verification_status,
      archived_at: artifact.archived_at,
      attrs: artifact.attrs,
    })
    .from(artifact)
    .where(eq(artifact.id, artifactId))
    .limit(1);
  const row = rows[0];
  const marker = row ? readNoteLongCheck(row.attrs) : null;
  if (
    !row ||
    row.version !== baseVersion ||
    row.generation_status !== 'ready' ||
    row.verification_status !== 'needs_review' ||
    row.archived_at !== null ||
    marker?.status !== 'revising' ||
    marker.base_version !== baseVersion
  ) {
    throw new Error(`note long revision claim no longer held: ${artifactId}`);
  }
}

async function writeLongNoteRevisionBody(params: {
  db: Db;
  artifactId: string;
  claim: RevisionClaim;
  result: TaskTextResult;
  bodyBlocks: ArtifactBodyBlocksT;
  referenceArtifacts: NoteGenerationReference[];
}): Promise<boolean> {
  const { db, artifactId, claim, result, bodyBlocks, referenceArtifacts } = params;
  return db.transaction(async (tx) => {
    const currentReferences = await lockCurrentNoteGenerationReferences(
      tx,
      artifactId,
      referenceArtifacts,
    );
    assertNoteGenerationReferences(bodyBlocks, currentReferences);
    const rows = await tx
      .select({
        version: artifact.version,
        body_blocks: artifact.body_blocks,
        history: artifact.history,
        attrs: artifact.attrs,
        generation_status: artifact.generation_status,
        verification_status: artifact.verification_status,
        archived_at: artifact.archived_at,
      })
      .from(artifact)
      .where(eq(artifact.id, artifactId))
      .for('update')
      .limit(1);
    const before = rows[0];
    const marker = before ? readNoteLongCheck(before.attrs) : null;
    if (
      !before ||
      before.generation_status !== 'ready' ||
      before.verification_status !== 'needs_review' ||
      before.archived_at !== null ||
      before.version !== claim.baseVersion ||
      marker?.status !== 'revising' ||
      marker.base_version !== claim.baseVersion
    ) {
      return false;
    }
    const now = new Date();
    const nextVersion = before.version + 1;
    const generatedByRef = aiAgentRef('NoteGenerateTask', result);
    const attrs = attrsWithNoteLongCheck(before.attrs, {
      ...marker,
      revised_version: nextVersion,
      task_run_id: result.task_run_id ?? null,
      at: now.toISOString(),
    });
    const historyAfter = (
      Array.isArray(before.history) ? before.history : []
    ) as ArtifactHistoryEntryT[];
    const updated = await tx
      .update(artifact)
      .set({
        body_blocks: bodyBlocks as never,
        verification_status: 'queued',
        generated_by: { ...generatedByRef } as never,
        attrs: attrs as never,
        version: nextVersion,
        updated_at: now,
      })
      .where(
        and(
          eq(artifact.id, artifactId),
          eq(artifact.version, before.version),
          eq(artifact.verification_status, 'needs_review'),
        ),
      )
      .returning({ id: artifact.id });
    if (updated.length !== 1) return false;

    await syncBlockRefsForArtifact(tx, artifactId, bodyBlocks);
    await emitArtifactBodyBlocksEditEvent(tx, {
      subjectId: artifactId,
      previousArtifactVersion: before.version,
      nextArtifactVersion: nextVersion,
      bodyBlocks,
      previousBodyBlocks: (before.body_blocks ?? null) as ArtifactBodyBlocksT | null,
      historyAfter,
      actorKind: 'agent',
      actorRef: NOTE_LONG_CHECK_ACTOR_REF,
      taskRunId: result.task_run_id ?? null,
      costMicroUsd: costUsdToMicroUsd(result.cost_usd),
      createdAt: now,
      optOutMemoryIngestion: true,
    });
    await emitArtifactLifecycleEvent(tx, {
      subjectId: artifactId,
      op: 'set_verification_status',
      verificationStatus: 'queued',
      attrs,
      generatedBy: generatedByRef,
      nextVersion,
      actorKind: 'agent',
      actorRef: NOTE_LONG_CHECK_ACTOR_REF,
      taskRunId: result.task_run_id ?? null,
      costMicroUsd: costUsdToMicroUsd(result.cost_usd),
      createdAt: now,
    });
    return true;
  });
}

async function runLongNoteRevision(params: {
  db: Db;
  artifactId: string;
  runTaskFn: RunTaskFn;
  claim: RevisionClaim;
}): Promise<void> {
  const { db, artifactId, runTaskFn, claim } = params;
  try {
    const { input, referenceArtifacts } = await loadNoteGenerateTaskInput(db, claim.source);
    const subjectProfile = resolveSubjectProfile(input.knowledge_node?.domain);
    const piSkillDocs = await resolveNoteSkillDoc(subjectProfile.id);
    const result = await runTaskFn(
      'NoteGenerateTask',
      {
        ...input,
        revision_context: {
          issues: claim.issues,
          body_blocks: claim.bodyBlocks,
        },
      },
      {
        subjectProfile,
        piSkillDocs,
        beforeProviderQuery: () => assertRevisionClaimHeld(db, artifactId, claim.baseVersion),
      },
    );
    const parsed = parseNoteGenerateOutput(result.text, 'note_long', result.finishReason);
    assertNoteGenerationReferences(parsed.body_blocks, referenceArtifacts);
    const wrote = await writeLongNoteRevisionBody({
      db,
      artifactId,
      claim,
      result,
      bodyBlocks: parsed.body_blocks,
      referenceArtifacts,
    });
    if (!wrote) {
      await recordLongNoteRevisionFailure({
        db,
        artifactId,
        baseVersion: claim.baseVersion,
        taskRunId: result.task_run_id ?? null,
        detail: 'revision write lost the race; original body kept',
      });
      return;
    }
    console.log(
      `[note_long_check] ${artifactId} revision written (v${claim.baseVersion}->v${claim.baseVersion + 1}); recheck queued`,
    );
  } catch (error) {
    await recordLongNoteRevisionFailure({
      db,
      artifactId,
      baseVersion: claim.baseVersion,
      taskRunId: taskRunIdOf(error),
      detail: error instanceof Error ? error.message : String(error),
    });
    console.error(
      `[note_long_check] ${artifactId} revision round failed; original body kept`,
      error,
    );
  }
}

export interface DriveLongNoteCheckParams {
  db: Db;
  artifactId: string;
  runTaskFn: RunTaskFn;
  /** In-transaction backend-control admission, reused for the in-process recheck. */
  controlAdmission?: (tx: Tx) => Promise<void>;
}

const LONG_NOTE_CHECK_RECHECK_LIMIT = 1;

/**
 * Drive the long-note check loop from stored artifact state: finalize the
 * marker, run the single revision round, or run the single in-process recheck.
 * Bounded by construction — one revision and one recheck per generation epoch.
 */
export async function driveLongNoteCheck(params: DriveLongNoteCheckParams): Promise<void> {
  const { db, artifactId, runTaskFn } = params;
  let rechecks = 0;
  for (;;) {
    const row = await loadLongNoteArtifact(db, artifactId);
    if (
      !row ||
      row.type !== 'note_long' ||
      row.archived_at !== null ||
      row.generation_status !== 'ready'
    ) {
      return;
    }
    const decision = decideLongNoteCheck(row);
    if (decision.kind === 'none') return;
    if (decision.kind === 'finalize') {
      await applyLongNoteCheckMarker(db, artifactId, nextFinalizedLongNoteCheck);
      return;
    }
    if (decision.kind === 'recheck') {
      // A concurrent delivery or the recovery floor may own the recheck; never
      // spin here waiting for it.
      if (rechecks >= LONG_NOTE_CHECK_RECHECK_LIMIT) return;
      rechecks += 1;
      await runNoteVerify({
        db,
        artifactId,
        runTaskFn,
        controlAdmission: params.controlAdmission,
      });
      continue;
    }
    const claim = await claimLongNoteRevision(db, artifactId);
    if (!claim) return;
    await runLongNoteRevision({ db, artifactId, runTaskFn, claim });
  }
}
