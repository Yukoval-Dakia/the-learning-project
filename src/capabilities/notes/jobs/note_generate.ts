// Async generation of one note artifact. Picks up `{ artifact_id }`, loads the
// note, parent hub, and knowledge context, calls NoteGenerateTask, and writes
// the ready body. Failures flip generation_status to 'failed' so the UI never
// sits on pending; the throw still lets pg-boss retry.

import { createHash } from 'node:crypto';
import { type SQL, and, eq, inArray, isNull } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import { type NoteGeneratePhaseTimings, type TaskTextResult, aiAgentRef } from '@/ai/task-result';
import {
  emitArtifactBodyBlocksEditEvent,
  emitArtifactLifecycleEvent,
} from '@/capabilities/notes/server/artifacts/mutation-events';
import { syncBlockRefsForArtifact } from '@/capabilities/notes/server/block-refs';
import {
  NOTE_ARTIFACT_TYPES,
  isNoteArtifactType,
} from '@/capabilities/notes/server/note-artifact-types';
import {
  type NoteGenerationFailure,
  attrsClearingGenerationFailure,
  attrsWithGenerationFailure,
  noteGenerationFailure,
} from '@/capabilities/notes/server/note-generation-failure';
import {
  NOTE_GENERATION_FALLBACK_ACTOR_REF,
  buildNoteGenerationFallbackBody,
  loadNoteGenerationFallbackMaterial,
  mayOverwriteNoteBodyForGeneration,
  noteBodyIsEmpty,
  recordNoteFallbackReferenceExposure,
} from '@/capabilities/notes/server/note-generation-fallback';
import {
  type NoteGenerateSourceRow,
  loadNoteGenerateTaskInput,
} from '@/capabilities/notes/server/note-generation-input';
import {
  assertNoteGenerationReferences,
  lockCurrentNoteGenerationReferences,
} from '@/capabilities/notes/server/note-generation-references';
import { dispatchNoteVerification } from '@/capabilities/notes/server/note-handoff';
import { attrsClearingNoteLongCheck } from '@/capabilities/notes/server/note-long-check';
import { parseNoteGenerateOutput } from '@/capabilities/notes/tasks/note-tasks';
import type { ArtifactBodyBlocksT, ArtifactHistoryEntryT } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { artifact } from '@/db/schema';
import { writeNoteVerificationIntent } from '@/kernel/records/note-handoff-protocol';
import {
  type TaskTextRunFn,
  costUsdToMicroUsd,
  isGenerationBudgetTimeout,
} from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { resolveNoteSkillDoc } from '@/subjects/note-skills';
import { resolveSubjectProfile } from '@/subjects/profile';

export interface NoteGenerateJobData {
  artifact_id: string;
}

export type RunTaskFn = TaskTextRunFn;

type DepsOverride = {
  runTaskFn?: RunTaskFn;
  dispatchVerification?: (artifactId: string) => Promise<boolean>;
};

export { parseNoteGenerateOutput } from '@/capabilities/notes/tasks/note-tasks';

const NOTE_GENERATE_RAW_EXCERPT_CHARS = 2_000;

function logNoteGeneratePhases(input: {
  artifactId: string;
  taskRunId: string | null;
  promptBuildMs: number;
  modelWaitMs: number | null;
  parseMs: number | null;
  validationMs: number | null;
  dbWriteMs: number | null;
  runnerPhases?: NoteGeneratePhaseTimings;
}): void {
  console.info('[note_generate] phase_timings', {
    event: 'note_generate_phase_timings',
    artifact_id: input.artifactId,
    task_run_id: input.taskRunId,
    phases: {
      prompt_build_ms: input.promptBuildMs,
      model_wait_ms: input.modelWaitMs,
      model_ttft_ms: input.runnerPhases?.model_ttft_ms ?? null,
      model_total_ms: input.runnerPhases?.model_total_ms ?? null,
      stream_ms: input.runnerPhases?.stream_ms ?? null,
      parse_ms: input.parseMs,
      validation_ms: input.validationMs,
      retry_count: input.runnerPhases?.retry_count ?? 0,
      db_write_ms: input.dbWriteMs,
    },
  });
}

function taskRunIdOf(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('taskRunId' in error)) return null;
  const value = (error as { taskRunId?: unknown }).taskRunId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function noteGenerationFailureKind(error: unknown): NoteGenerationFailure['kind'] {
  return isGenerationBudgetTimeout(error) ? 'timeout' : 'model_or_parse';
}

function annotateNoteGenerateFailure(
  error: unknown,
  taskRunId: string | null,
  rawText: string | undefined,
): Error {
  const failure = error instanceof Error ? error : new Error(String(error));
  const parts: string[] = [];
  if (taskRunId) parts.push(`task_run_id=${taskRunId}`);
  if (rawText !== undefined) {
    const excerpt =
      rawText.length > NOTE_GENERATE_RAW_EXCERPT_CHARS
        ? `${rawText.slice(0, NOTE_GENERATE_RAW_EXCERPT_CHARS)}…`
        : rawText;
    parts.push(`raw_sha256=${createHash('sha256').update(rawText).digest('hex')}`);
    parts.push(`raw_excerpt=${JSON.stringify(excerpt)}`);
  }
  if (parts.length > 0) failure.message = `${failure.message} (${parts.join(' ')})`;
  return failure;
}

export interface RunNoteGenerateParams {
  db: Db;
  artifactId: string;
  runTaskFn: RunTaskFn;
}

export interface RunNoteGenerateResult {
  status:
    | 'ready'
    | 'skipped:not_pending'
    | 'skipped:not_found'
    | 'skipped:learner_edited'
    | 'failed';
  sections_count?: number;
  blocks_count?: number;
}

type ReopenOutcome = 'reopened' | 'absent' | 'refused:learner_edited';

async function reopenFailedGenerationForRetry(db: Db, artifactId: string): Promise<ReopenOutcome> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        version: artifact.version,
        body_blocks: artifact.body_blocks,
        history: artifact.history,
      })
      .from(artifact)
      .where(
        and(
          eq(artifact.id, artifactId),
          inArray(artifact.type, NOTE_ARTIFACT_TYPES),
          eq(artifact.generation_status, 'failed'),
          isNull(artifact.archived_at),
        ),
      )
      .for('update')
      .limit(1);
    const row = rows[0];
    if (!row) return 'absent';
    // Reopening content the learner has touched would discard the provider
    // output anyway, so refuse before paying for the call.
    if (!mayOverwriteNoteBodyForGeneration(row.body_blocks, row.history, row.version)) {
      return 'refused:learner_edited';
    }
    const now = new Date();
    const updated = await tx
      .update(artifact)
      .set({ generation_status: 'pending', updated_at: now })
      .where(
        and(
          eq(artifact.id, artifactId),
          inArray(artifact.type, NOTE_ARTIFACT_TYPES),
          eq(artifact.generation_status, 'failed'),
          isNull(artifact.archived_at),
        ),
      )
      .returning({ id: artifact.id });
    if (updated.length !== 1) return 'absent';
    await emitArtifactLifecycleEvent(tx, {
      subjectId: artifactId,
      op: 'set_generation_status',
      generationStatus: 'pending',
      nextVersion: row.version,
      actorKind: 'system',
      actorRef: 'note_generate_retry',
      createdAt: now,
    });
    return 'reopened';
  });
}

/**
 * Runs NoteGenerateTask and persists the ready body. A failed artifact is
 * atomically reopened for retry; other non-pending states skip.
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
      archived_at: artifact.archived_at,
    })
    .from(artifact)
    .where(eq(artifact.id, artifactId))
    .limit(1);
  const row = rows[0];
  if (!row) return { status: 'skipped:not_found' };
  if (!isNoteArtifactType(row.type)) return { status: 'skipped:not_pending' };
  if (row.archived_at !== null) return { status: 'skipped:not_pending' };
  if (row.generation_status === 'failed') {
    const reopen = await reopenFailedGenerationForRetry(db, artifactId);
    if (reopen !== 'reopened') {
      return {
        status:
          reopen === 'refused:learner_edited' ? 'skipped:learner_edited' : 'skipped:not_pending',
      };
    }
  } else if (row.generation_status !== 'pending') {
    return { status: 'skipped:not_pending' };
  }

  let attempt: TaskTextResult | undefined;
  const promptStarted = Date.now();
  const { input, referenceArtifacts } = await loadNoteGenerateTaskInput(
    db,
    row satisfies NoteGenerateSourceRow,
  );
  const subjectProfile = resolveSubjectProfile(input.knowledge_node?.domain);
  const skillDocs = await resolveNoteSkillDoc(subjectProfile.id);
  const promptBuildMs = Date.now() - promptStarted;
  let modelWaitMs: number | null = null;
  let parseMs: number | null = null;
  let validationMs: number | null = null;
  let dbWriteMs: number | null = null;
  const modelStarted = Date.now();

  try {
    const result = await runTaskFn('NoteGenerateTask', input, {
      subjectProfile,
      piSkillDocs: skillDocs,
      beforeProviderQuery: async () => {
        const activeRows = await db
          .select({ id: artifact.id })
          .from(artifact)
          .where(
            and(
              eq(artifact.id, artifactId),
              inArray(artifact.type, NOTE_ARTIFACT_TYPES),
              eq(artifact.generation_status, 'pending'),
              isNull(artifact.archived_at),
            ),
          )
          .limit(1);
        if (activeRows.length === 0) {
          throw new Error(`note generation is no longer pending and active: ${artifactId}`);
        }
      },
    });
    modelWaitMs = Date.now() - modelStarted;
    attempt = result;
    const parseStarted = Date.now();
    const parsed = parseNoteGenerateOutput(result.text, row.type, result.finishReason);
    parseMs = Date.now() - parseStarted;
    const validationStarted = Date.now();
    assertNoteGenerationReferences(parsed.body_blocks, referenceArtifacts);
    validationMs = Date.now() - validationStarted;

    // Compound mutation: body + statuses + provenance must fold as two same-tx
    // events. body_blocks_edit requires a version advance, so this first content
    // write bumps it. Both events opt out of memory ingestion (background work).
    const now = new Date();
    const generatedByRef = aiAgentRef('NoteGenerateTask', result);
    const dbStarted = Date.now();
    // One tx keeps the backlink index in step with the body and rolls the UPDATE
    // back if an event payload is malformed. The AI body may only take over an
    // empty body or the untouched fallback; learner content flips back to failed.
    type SuccessTxOutcome =
      | { kind: 'ready'; rows: Array<{ id: string }> }
      | { kind: 'learner_edited' }
      | { kind: 'not_pending' };
    const updated = await db.transaction(async (tx): Promise<SuccessTxOutcome> => {
      const currentReferences = await lockCurrentNoteGenerationReferences(
        tx,
        artifactId,
        referenceArtifacts,
      );
      assertNoteGenerationReferences(parsed.body_blocks, currentReferences);
      // Read inside the tx (FOR UPDATE) so events carry the values actually written.
      const beforeRows = await tx
        .select({
          version: artifact.version,
          body_blocks: artifact.body_blocks,
          history: artifact.history,
          attrs: artifact.attrs,
        })
        .from(artifact)
        .where(
          and(
            eq(artifact.id, artifactId),
            inArray(artifact.type, NOTE_ARTIFACT_TYPES),
            eq(artifact.generation_status, 'pending'),
            isNull(artifact.archived_at),
          ),
        )
        .for('update')
        .limit(1);
      const before = beforeRows[0];
      if (!before) return { kind: 'not_pending' }; // concurrently no longer pending
      const clearedFailure = attrsClearingGenerationFailure(before.attrs);
      // A fresh generation epoch restarts the long-note check cycle (YUK-1642).
      const clearedLongCheck = attrsClearingNoteLongCheck(clearedFailure.attrs);
      const clearedAttrs =
        clearedFailure.cleared || clearedLongCheck.cleared ? { attrs: clearedLongCheck.attrs } : {};
      if (!mayOverwriteNoteBodyForGeneration(before.body_blocks, before.history, before.version)) {
        // Authored over the fallback: keep it and honestly report failed.
        const kept = await tx
          .update(artifact)
          .set({ generation_status: 'failed', updated_at: now })
          .where(
            and(
              eq(artifact.id, artifactId),
              inArray(artifact.type, NOTE_ARTIFACT_TYPES),
              eq(artifact.generation_status, 'pending'),
              isNull(artifact.archived_at),
            ),
          )
          .returning({ id: artifact.id });
        if (kept.length === 0) return { kind: 'not_pending' };
        await emitArtifactLifecycleEvent(tx, {
          subjectId: artifactId,
          op: 'set_generation_status',
          generationStatus: 'failed',
          nextVersion: before.version,
          actorKind: 'agent',
          actorRef: 'note_generate',
          createdAt: now,
        });
        return { kind: 'learner_edited' };
      }
      const nextVersion = before.version + 1;
      // No history entry here: carry the current one so the full-snapshot event
      // does not blank the column.
      const historyAfter = (
        Array.isArray(before.history) ? before.history : []
      ) as ArtifactHistoryEntryT[];

      const rows = await tx
        .update(artifact)
        .set({
          body_blocks: parsed.body_blocks as never,
          generation_status: 'ready',
          verification_status: 'queued',
          generated_by: { ...generatedByRef } as never,
          ...clearedAttrs,
          version: nextVersion,
          updated_at: now,
        })
        .where(
          and(
            eq(artifact.id, artifactId),
            inArray(artifact.type, NOTE_ARTIFACT_TYPES),
            eq(artifact.generation_status, 'pending'),
            isNull(artifact.archived_at),
          ),
        )
        .returning({ id: artifact.id });
      if (rows.length === 0) return { kind: 'not_pending' };

      await syncBlockRefsForArtifact(tx, artifactId, parsed.body_blocks);

      await emitArtifactBodyBlocksEditEvent(tx, {
        subjectId: artifactId,
        previousArtifactVersion: before.version,
        nextArtifactVersion: nextVersion,
        bodyBlocks: parsed.body_blocks,
        previousBodyBlocks: (before.body_blocks ?? null) as ArtifactBodyBlocksT | null,
        historyAfter,
        actorKind: 'agent',
        actorRef: 'note_generate',
        taskRunId: result.task_run_id ?? null,
        costMicroUsd: costUsdToMicroUsd(result.cost_usd),
        createdAt: now,
        optOutMemoryIngestion: true,
      });
      await emitArtifactLifecycleEvent(tx, {
        subjectId: artifactId,
        op: 'set_generation_status',
        generationStatus: 'ready',
        verificationStatus: 'queued',
        generatedBy: generatedByRef,
        ...clearedAttrs,
        nextVersion,
        actorKind: 'agent',
        actorRef: 'note_generate',
        taskRunId: result.task_run_id ?? null,
        costMicroUsd: costUsdToMicroUsd(result.cost_usd),
        createdAt: now,
      });
      await writeNoteVerificationIntent(tx, artifactId);
      return { kind: 'ready', rows };
    });

    dbWriteMs = Date.now() - dbStarted;
    logNoteGeneratePhases({
      artifactId,
      taskRunId: result.task_run_id ?? null,
      promptBuildMs,
      modelWaitMs,
      parseMs,
      validationMs,
      dbWriteMs,
      runnerPhases: result.phases,
    });

    if (updated.kind === 'not_pending') {
      return { status: 'skipped:not_pending' };
    }
    if (updated.kind === 'learner_edited') {
      console.log(
        `[note_generate] ${artifactId} retry output discarded; body carries authored content (skipped:learner_edited)`,
      );
      return { status: 'skipped:learner_edited' };
    }

    return {
      status: 'ready',
      sections_count: parsed.sections_count,
      blocks_count: parsed.blocks_count,
    };
  } catch (err) {
    if (modelWaitMs === null) modelWaitMs = Date.now() - modelStarted;
    const taskRunId = attempt?.task_run_id ?? taskRunIdOf(err);
    const generationFailure = noteGenerationFailure(
      noteGenerationFailureKind(err),
      taskRunId,
      err instanceof Error ? err.message : String(err),
    );
    const failure = annotateNoteGenerateFailure(err, taskRunId, attempt?.text);
    const failureDbStarted = Date.now();
    // Flip to failed so the UI never sits on pending; rethrow so pg-boss still
    // retries.
    //
    // Two ordered transactions:
    //   tx1 records the failure and must be indestructible — nothing about the
    //      fallback may keep the note pending.
    //   tx2 fills an EMPTY body with the deterministic fallback (real material
    //      only, honestly labelled). It bumps the version like any content write,
    //      so a later retry can replace the untouched fallback, and a learner
    //      edit is never clobbered. Already-written bodies are left alone, and a
    //      tx2 failure is logged rather than masking the original error.
    const failedAt = new Date();
    let flipVersion: number | null = null;
    try {
      flipVersion = await db.transaction(async (tx) => {
        const beforeRows = await tx
          .select({ version: artifact.version, attrs: artifact.attrs })
          .from(artifact)
          .where(
            and(
              eq(artifact.id, artifactId),
              inArray(artifact.type, NOTE_ARTIFACT_TYPES),
              eq(artifact.generation_status, 'pending'),
              isNull(artifact.archived_at),
            ),
          )
          .for('update')
          .limit(1);
        const before = beforeRows[0];
        if (!before) return null;
        const failedAttrs = attrsWithGenerationFailure(before.attrs, generationFailure);
        const rows = await tx
          .update(artifact)
          .set({ generation_status: 'failed', attrs: failedAttrs, updated_at: failedAt })
          .where(
            and(
              eq(artifact.id, artifactId),
              inArray(artifact.type, NOTE_ARTIFACT_TYPES),
              eq(artifact.generation_status, 'pending'),
              isNull(artifact.archived_at),
            ),
          )
          .returning({ id: artifact.id });
        if (rows.length === 0) return null;
        await emitArtifactLifecycleEvent(tx, {
          subjectId: artifactId,
          op: 'set_generation_status',
          generationStatus: 'failed',
          attrs: failedAttrs,
          nextVersion: before.version,
          actorKind: 'agent',
          actorRef: 'note_generate',
          taskRunId,
          costMicroUsd: attempt ? costUsdToMicroUsd(attempt.cost_usd) : null,
          createdAt: failedAt,
        });
        return before.version;
      });
    } catch (cleanupErr) {
      console.error('[note_generate] failed-status cleanup failed for', artifactId, cleanupErr);
    }

    if (flipVersion === null) {
      logNoteGeneratePhases({
        artifactId,
        taskRunId,
        promptBuildMs,
        modelWaitMs,
        parseMs,
        validationMs,
        dbWriteMs: Date.now() - failureDbStarted,
        runnerPhases: attempt?.phases,
      });
      throw failure; // not pending anymore (or flip failed) — nothing to fill
    }

    // Material loading has its own guard: a throw degrades to a status-only flip
    // instead of stranding the note in pending.
    let fallbackMaterial: Awaited<ReturnType<typeof loadNoteGenerationFallbackMaterial>> | null =
      null;
    try {
      fallbackMaterial = await loadNoteGenerationFallbackMaterial(db, {
        id: artifactId,
        title: row.title,
        knowledge_ids: row.knowledge_ids,
        parent_artifact_id: row.parent_artifact_id,
        attrs: row.attrs,
      });
    } catch (materialErr) {
      console.error('[note_generate] fallback material load failed for', artifactId, materialErr);
    }

    if (fallbackMaterial) {
      try {
        const wroteFallback = await db.transaction(async (tx): Promise<boolean> => {
          const beforeRows = await tx
            .select({
              version: artifact.version,
              body_blocks: artifact.body_blocks,
              history: artifact.history,
            })
            .from(artifact)
            .where(
              and(
                eq(artifact.id, artifactId),
                inArray(artifact.type, NOTE_ARTIFACT_TYPES),
                eq(artifact.generation_status, 'failed'),
                eq(artifact.version, flipVersion),
                isNull(artifact.archived_at),
              ),
            )
            .for('update')
            .limit(1);
          const before = beforeRows[0];
          if (!before) return false; // raced between tx1 and tx2 — leave it alone

          const bodyIsEmpty = noteBodyIsEmpty(before.body_blocks);
          if (!bodyIsEmpty) return false; // already filled — idempotent no-op

          const fallbackBody = buildNoteGenerationFallbackBody(fallbackMaterial);
          const nextVersion = before.version + 1;
          const fallbackHistoryAfter: ArtifactHistoryEntryT[] = [
            ...(Array.isArray(before.history) ? before.history : []),
            {
              version: nextVersion,
              at: failedAt,
              by: { by: 'system' },
              summary_md: '生成失败：写入确定性原材料兜底正文（非 AI 生成）',
              action: 'note_generation_fallback',
              previous_artifact_version: before.version,
              next_artifact_version: nextVersion,
            },
          ];
          const rows = await tx
            .update(artifact)
            .set({
              body_blocks: fallbackBody as never,
              version: nextVersion,
              history: fallbackHistoryAfter as never,
              updated_at: failedAt,
            })
            .where(
              and(
                eq(artifact.id, artifactId),
                eq(artifact.version, before.version),
                eq(artifact.generation_status, 'failed'),
                isNull(artifact.archived_at),
              ),
            )
            .returning({ id: artifact.id });
          if (rows.length === 0) return false;

          await syncBlockRefsForArtifact(tx, artifactId, fallbackBody);
          await emitArtifactBodyBlocksEditEvent(tx, {
            subjectId: artifactId,
            previousArtifactVersion: before.version,
            nextArtifactVersion: nextVersion,
            bodyBlocks: fallbackBody,
            previousBodyBlocks: (before.body_blocks ?? null) as ArtifactBodyBlocksT | null,
            historyAfter: fallbackHistoryAfter,
            actorKind: 'agent',
            actorRef: NOTE_GENERATION_FALLBACK_ACTOR_REF,
            createdAt: failedAt,
            optOutMemoryIngestion: true,
          });
          if (fallbackMaterial.question?.reference_md) {
            await recordNoteFallbackReferenceExposure(tx, {
              issuanceId: fallbackMaterial.question.issuance_id,
              questionId: fallbackMaterial.question.question_id,
              referenceMd: fallbackMaterial.question.reference_md,
            });
          }
          return true;
        });
        if (wroteFallback) {
          console.log(
            `[note_generate] ${artifactId} generation failed; deterministic fallback body written (v${flipVersion}->v${flipVersion + 1})`,
          );
        }
      } catch (fallbackErr) {
        // A fallback-write failure must not mask the committed failed flip or the
        // original error; the note honestly stays failed.
        console.error('[note_generate] fallback body write failed for', artifactId, fallbackErr);
      }
    }
    logNoteGeneratePhases({
      artifactId,
      taskRunId,
      promptBuildMs,
      modelWaitMs,
      parseMs,
      validationMs,
      dbWriteMs: Date.now() - failureDbStarted,
      runnerPhases: attempt?.phases,
    });
    throw failure;
  }
}

export function buildNoteGenerateHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<NoteGenerateJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? makeRunTaskFn(db);
  const dispatchVerification =
    deps.dispatchVerification ?? ((artifactId: string) => dispatchNoteVerification(db, artifactId));
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
          await dispatchVerification(artifactId);
        }
        console.log(`[note_generate] ${artifactId} → ${result.status}`);
      } catch (err) {
        console.error(`[note_generate] ${artifactId} failed`, err);
        throw err;
      }
    }
  };
}

void (null as SQL | null);
