// Note verification durable operation (YUK-1355 receipt reference): the
// backend-agnostic execution boundary for verifying one note artifact
// end-to-end against the existing note_verification_claim state machine
// (reserve -> provider-start fence -> staged result -> finalize, plus the
// contract-failure fast path and epoch supersede/ambiguous terminals).
//
// This module owns no runner wiring and no queue backend: `runTaskFn` is
// always injected by the consumer (pg-boss handler default, tests, or a
// future DBOS host assembled by the parent-owned registration). The retained
// pg-boss consumer lives in ../jobs/note_verify.ts; the DBOS migration
// candidate adapter lives in src/server/durable/note-verify-family.ts.
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';

import {
  bodyBlocksHaveSemanticKinds,
  bodyBlocksToBlockSummaries,
  bodyBlocksToNoteSections,
} from '@/capabilities/notes/server/body-blocks';
import { enqueueVerifyNoteRefine } from '@/capabilities/notes/server/note-refine-triggers';
import {
  type StagedNoteVerification,
  deferNoteVerificationResultForRetry,
  discardReservedNoteVerificationClaim,
  finalizeNoteVerificationResult,
  markNoteVerificationAmbiguous,
  markNoteVerificationProviderStarted,
  releaseNoteVerificationForRetry,
  releaseReservedNoteVerificationForRetry,
  reserveNoteVerification,
  stageNoteVerificationContractResult,
  stageNoteVerificationResult,
  supersedeNoteVerificationEpoch,
} from '@/capabilities/notes/server/note-verification-claim';
import { emitNoteVerificationLifecycleEvent } from '@/capabilities/notes/server/note-verification-lifecycle';
import { parseNoteVerificationOutput } from '@/capabilities/notes/tasks/note-tasks';
import type { NoteVerificationResultT } from '@/core/schema/business';
import { toUnifiedVerifyResult } from '@/core/schema/verify-contract';
import type { Db, Tx } from '@/db/client';
import { ai_task_runs, artifact, knowledge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { type TaskTextRunFn, aiAgentRef, costUsdToMicroUsd } from '@/server/ai/provenance';
import { resolveNoteSkillDoc } from '@/subjects/note-skills';
import { resolveSubjectProfile } from '@/subjects/profile';

const ATOMIC_REQUIRED_SEMANTIC_KINDS = [
  'definition',
  'mechanism',
  'example',
  'pitfall',
  'check',
] as const;

export type RunTaskFn = TaskTextRunFn;

export interface RunNoteVerifyParams {
  db: Db;
  artifactId: string;
  runTaskFn: RunTaskFn;
  /**
   * Optional in-transaction backend-control admission, threaded into
   * reserveNoteVerification's reservation transaction (YUK-1355). Production
   * send entries (pg-boss handler, DBOS adapter) wire it by default.
   */
  controlAdmission?: (tx: Tx) => Promise<void>;
}

export interface RunNoteVerifyResult {
  status:
    | 'verified'
    | 'needs_review'
    | 'skipped:not_found'
    | 'skipped:not_ready'
    | 'skipped:not_queued'
    | 'skipped:no_sections'
    | 'skipped:in_progress'
    | 'skipped:attempts_exhausted'
    | 'skipped:ambiguous';
  artifact_type?: string;
  issues_count?: number;
}

export function noteVerificationRetryRequired(artifactId: string, reason: string): Error {
  return new Error(`note verification retry required for ${artifactId}: ${reason}`);
}

export function noteBodyBlockContractFailure(
  artifactType: string,
  bodyBlocks: unknown,
): NoteVerificationResultT | null {
  if (artifactType !== 'note_atomic') return null;
  const semanticCheck = bodyBlocksHaveSemanticKinds(bodyBlocks, [
    ...ATOMIC_REQUIRED_SEMANTIC_KINDS,
  ]);
  if (semanticCheck.ok) return null;
  const missingKinds = semanticCheck.missing.join(', ');
  return {
    verdict: 'needs_review',
    summary_md: `Atomic note body_blocks missing required semantic kinds: ${missingKinds}.`,
    issues: [
      {
        block_id: null,
        severity: 'error',
        category: 'coverage',
        message: `Missing semantic_kind blocks: ${missingKinds}.`,
        suggested_fix_md:
          'Regenerate or edit body_blocks so definition, mechanism, example, pitfall, and check each appear at least once.',
      },
    ],
    confidence: 1,
  };
}

type PersistVerificationOutcome = {
  status: 'verified' | 'needs_review';
  verifyEventId: string;
};

type ParsedStagedNoteVerification = Extract<StagedNoteVerification, { kind: 'parsed' }>;

async function persistNoteVerificationResultTx(params: {
  tx: Tx;
  artifactId: string;
  staged: ParsedStagedNoteVerification;
}): Promise<PersistVerificationOutcome> {
  const { tx, artifactId, staged } = params;
  const { parsed, taskResult } = staged;
  const status = parsed.verdict === 'pass' ? 'verified' : 'needs_review';
  const unified = toUnifiedVerifyResult({
    source: 'note',
    verdict: parsed.verdict,
    summary_md: parsed.summary_md,
    confidence: parsed.confidence,
    issues: parsed.issues,
  });
  const verifyEventId = createId();
  const now = new Date();
  const verifiedByRef = taskResult
    ? aiAgentRef('NoteVerifyTask', taskResult)
    : { by: 'system', task_kind: 'NoteVerifyTask', model: 'body-block-contract' };
  const updatedRows = await tx
    .update(artifact)
    .set({
      verification_status: status,
      verification_summary: parsed as never,
      verified_by: verifiedByRef as never,
      updated_at: now,
    })
    .where(eq(artifact.id, artifactId))
    .returning({ version: artifact.version });
  await writeEvent(tx, {
    id: verifyEventId,
    session_id: null,
    actor_kind: taskResult ? 'agent' : 'system',
    actor_ref: 'note_verify',
    action: 'experimental:note_verify',
    subject_kind: 'artifact',
    subject_id: artifactId,
    outcome: parsed.verdict === 'pass' ? 'success' : 'partial',
    payload: { ...unified, ...parsed },
    caused_by_event_id: null,
    task_run_id: taskResult?.task_run_id ?? null,
    cost_micro_usd: costUsdToMicroUsd(taskResult?.cost_usd),
    created_at: now,
  });
  const version = updatedRows[0]?.version;
  if (version !== undefined) {
    await emitNoteVerificationLifecycleEvent(tx, {
      artifactId,
      status,
      summary: parsed,
      verifiedBy: verifiedByRef,
      nextVersion: version,
      actorKind: taskResult ? 'agent' : 'system',
      actorRef: 'note_verify',
      taskRunId: taskResult?.task_run_id ?? null,
      costMicroUsd: costUsdToMicroUsd(taskResult?.cost_usd),
      createdAt: now,
    });
  }
  return { status, verifyEventId };
}

function buildVerifyRefineContext(parsed: NoteVerificationResultT): string {
  const lines = ['Note verification flagged issues:', parsed.summary_md];
  for (const issue of parsed.issues) {
    const where = issue.block_id ? `[block ${issue.block_id}] ` : '';
    const fix = issue.suggested_fix_md ? ` (suggested: ${issue.suggested_fix_md})` : '';
    lines.push(`- ${where}${issue.message}${fix}`);
  }
  return lines.join('\n');
}

async function maybeEnqueueVerifyRefine(params: {
  db: Db;
  artifactId: string;
  staged: ParsedStagedNoteVerification;
  outcome: PersistVerificationOutcome;
}): Promise<void> {
  if (params.outcome.status !== 'needs_review') return;
  await enqueueVerifyNoteRefine({
    db: params.db,
    artifactId: params.artifactId,
    contextMd: buildVerifyRefineContext(params.staged.parsed),
    triggerEventId: params.outcome.verifyEventId,
  });
}

async function loadVerificationInput(db: Db, artifactId: string) {
  const rows = await db
    .select({
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      knowledgeIds: artifact.knowledge_ids,
      bodyBlocks: artifact.body_blocks,
    })
    .from(artifact)
    .where(eq(artifact.id, artifactId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const content = (row.bodyBlocks as { content?: unknown } | null)?.content;
  if (!Array.isArray(content) || content.length === 0) return { row, input: null };
  const primaryKnowledgeId = row.knowledgeIds[0] ?? null;
  const knowledgeRows = primaryKnowledgeId
    ? await db
        .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
        .from(knowledge)
        .where(eq(knowledge.id, primaryKnowledgeId))
        .limit(1)
    : [];
  const knowledgeNode = knowledgeRows[0] ?? null;
  return {
    row,
    input: {
      artifact_id: row.id,
      artifact_type: row.type,
      title: row.title,
      knowledge_node: knowledgeNode,
      body_blocks: row.bodyBlocks,
      block_summaries: bodyBlocksToBlockSummaries(row.bodyBlocks),
      sections: bodyBlocksToNoteSections(row.bodyBlocks),
    },
  };
}

/**
 * Finalize a staged (result_ready) verification into the artifact exactly once.
 * Shared by the pg-boss recovery floor and any durable-backend replay that
 * finds a staged result: re-entry never re-crosses the provider boundary.
 */
export async function finalizeStagedNoteVerification(
  db: Db,
  artifactId: string,
  artifactType: string,
): Promise<RunNoteVerifyResult> {
  let finalized: {
    outcome: PersistVerificationOutcome;
    staged: ParsedStagedNoteVerification;
  } | null;
  try {
    finalized = await finalizeNoteVerificationResult(db, artifactId, async (tx, current) => {
      const staged: ParsedStagedNoteVerification =
        current.kind === 'parsed'
          ? current
          : {
              kind: 'parsed',
              parsed: parseNoteVerificationOutput(current.taskResult.text),
              taskResult: current.taskResult,
            };
      const outcome = await persistNoteVerificationResultTx({ tx, artifactId, staged });
      return { outcome, staged };
    });
  } catch (error) {
    await deferNoteVerificationResultForRetry(db, artifactId, error);
    throw error;
  }
  if (!finalized) return { status: 'skipped:in_progress', artifact_type: artifactType };
  await maybeEnqueueVerifyRefine({
    db,
    artifactId,
    staged: finalized.staged,
    outcome: finalized.outcome,
  });
  return {
    status: finalized.outcome.status,
    artifact_type: artifactType,
    issues_count: finalized.staged.parsed.issues.length,
  };
}

export async function runNoteVerify(params: RunNoteVerifyParams): Promise<RunNoteVerifyResult> {
  const { db, artifactId, runTaskFn } = params;
  const reservation = await reserveNoteVerification(db, artifactId, {
    controlAdmission: params.controlAdmission,
  });
  if (reservation.kind === 'not_found') return { status: 'skipped:not_found' };
  if (reservation.kind === 'not_ready') {
    return { status: 'skipped:not_ready', artifact_type: reservation.artifactType };
  }
  if (reservation.kind === 'not_queued') {
    return { status: 'skipped:not_queued', artifact_type: reservation.artifactType };
  }
  if (reservation.kind === 'completed') return { status: 'skipped:not_queued' };
  if (reservation.kind === 'attempts_exhausted') {
    return { status: 'skipped:attempts_exhausted' };
  }
  if (reservation.kind === 'ambiguous') return { status: 'skipped:ambiguous' };
  if (reservation.kind === 'busy') return { status: 'skipped:in_progress' };

  const loaded = await loadVerificationInput(db, artifactId);
  if (!loaded) return { status: 'skipped:not_found' };
  const input = loaded.input;
  if (!input) {
    if (reservation.kind === 'claimed') {
      await discardReservedNoteVerificationClaim(db, reservation.lease);
    }
    return { status: 'skipped:no_sections', artifact_type: loaded.row.type };
  }
  if (reservation.kind === 'result_ready') {
    return finalizeStagedNoteVerification(db, artifactId, loaded.row.type);
  }

  const lease = reservation.lease;
  let staged: StagedNoteVerification;
  const contractFailure = noteBodyBlockContractFailure(loaded.row.type, loaded.row.bodyBlocks);
  if (contractFailure) {
    staged = { kind: 'parsed', parsed: contractFailure, taskResult: null };
    if (!(await stageNoteVerificationContractResult(db, lease, staged))) {
      if (!(await supersedeNoteVerificationEpoch(db, lease))) {
        await discardReservedNoteVerificationClaim(db, lease);
      }
      throw noteVerificationRetryRequired(artifactId, 'contract-result claim changed');
    }
  } else {
    const runtime = await (async () => {
      try {
        const subjectProfile = resolveSubjectProfile(input.knowledge_node?.domain);
        return { subjectProfile, piSkillDocs: await resolveNoteSkillDoc(subjectProfile.id) };
      } catch (error) {
        await releaseReservedNoteVerificationForRetry(db, lease, error);
        throw error;
      }
    })();
    let providerBoundaryCrossed = false;
    const providerStartState: {
      rejection: 'attempts_exhausted' | 'claim_changed' | null;
    } = { rejection: null };
    try {
      const taskResult = await runTaskFn('NoteVerifyTask', input, {
        subjectProfile: runtime.subjectProfile,
        piSkillDocs: runtime.piSkillDocs,
        taskRunId: lease.taskRunId,
        beforeProviderQuery: async () => {
          const providerStart = await markNoteVerificationProviderStarted(db, lease);
          switch (providerStart.kind) {
            case 'started':
              providerBoundaryCrossed = true;
              return;
            case 'attempts_exhausted':
              providerStartState.rejection = 'attempts_exhausted';
              throw noteVerificationRetryRequired(artifactId, 'provider attempts exhausted');
            case 'claim_changed':
              providerStartState.rejection = 'claim_changed';
              if (!(await supersedeNoteVerificationEpoch(db, lease))) {
                await discardReservedNoteVerificationClaim(db, lease);
              }
              throw noteVerificationRetryRequired(artifactId, 'provider-start claim changed');
            default: {
              const exhaustive: never = providerStart;
              throw new Error(`unhandled provider-start result: ${String(exhaustive)}`);
            }
          }
        },
      });
      staged = {
        kind: 'provider_result',
        taskResult: { ...taskResult, task_run_id: lease.taskRunId },
      };
    } catch (error) {
      switch (providerStartState.rejection) {
        case 'attempts_exhausted':
          return { status: 'skipped:attempts_exhausted' };
        case 'claim_changed':
          throw error;
        case null:
          break;
        default: {
          const exhaustive: never = providerStartState.rejection;
          throw new Error(`unhandled provider-start rejection: ${String(exhaustive)}`);
        }
      }
      if (!providerBoundaryCrossed) {
        await releaseReservedNoteVerificationForRetry(db, lease, error);
        throw error;
      }
      let durableStatus: string | null = null;
      try {
        const statusRows = await db
          .select({ status: ai_task_runs.status })
          .from(ai_task_runs)
          .where(eq(ai_task_runs.id, lease.taskRunId))
          .limit(1);
        durableStatus = statusRows[0]?.status ?? null;
      } catch {
        durableStatus = null;
      }
      if (durableStatus === 'failure') {
        const release = await releaseNoteVerificationForRetry(db, lease, error);
        switch (release.kind) {
          case 'retry_wait':
            break;
          case 'attempts_exhausted':
            return { status: 'skipped:attempts_exhausted' };
          case 'claim_changed':
            await supersedeNoteVerificationEpoch(db, lease);
            throw error;
          default: {
            const exhaustive: never = release;
            throw new Error(`unhandled verification release: ${String(exhaustive)}`);
          }
        }
      } else {
        await markNoteVerificationAmbiguous(db, lease, error);
      }
      throw error;
    }
  }
  if (!contractFailure && !(await stageNoteVerificationResult(db, lease, staged))) {
    await supersedeNoteVerificationEpoch(db, lease);
    throw noteVerificationRetryRequired(artifactId, 'result claim changed');
  }
  return finalizeStagedNoteVerification(db, artifactId, loaded.row.type);
}
