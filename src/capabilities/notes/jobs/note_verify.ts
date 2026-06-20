// Product Track 1 — second-pass verification for generated atomic notes.
//
// Enqueued after note_generate marks an atomic artifact ready. The verifier is
// deliberately a separate lifecycle axis: generation_status says whether note
// content exists; verification_status says whether another AI pass trusts it.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import {
  bodyBlocksHaveSemanticKinds,
  bodyBlocksToBlockSummaries,
  bodyBlocksToNoteSections,
} from '@/capabilities/notes/server/body-blocks';
import { enqueueVerifyNoteRefine } from '@/capabilities/notes/server/note-refine-triggers';
import { NoteVerificationResult, type NoteVerificationResultT } from '@/core/schema/business';
import { toUnifiedVerifyResult } from '@/core/schema/verify-contract';
import type { Db } from '@/db/client';
import { artifact, knowledge } from '@/db/schema';
import { type TaskTextRunFn, aiAgentRef, costUsdToMicroUsd } from '@/server/ai/provenance';
import type { TaskTextResult } from '@/server/ai/provenance';
import { writeEvent } from '@/server/events/queries';
import { resolveNoteSkill } from '@/subjects/note-skills';
import { resolveSubjectProfile } from '@/subjects/profile';

const ATOMIC_REQUIRED_SEMANTIC_KINDS = [
  'definition',
  'mechanism',
  'example',
  'pitfall',
  'check',
] as const;

export interface NoteVerifyJobData {
  artifact_id: string;
}

export type RunTaskFn = TaskTextRunFn;

export interface RunNoteVerifyParams {
  db: Db;
  artifactId: string;
  runTaskFn: RunTaskFn;
}

export interface RunNoteVerifyResult {
  status:
    | 'verified'
    | 'needs_review'
    | 'skipped:not_found'
    | 'skipped:not_ready'
    | 'skipped:no_sections';
  artifact_type?: string;
  issues_count?: number;
}

type DepsOverride = {
  runTaskFn?: RunTaskFn;
  onPassed?: (artifactId: string) => Promise<void>;
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

function parseVerificationOutput(text: string): NoteVerificationResultT {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseVerificationOutput: no JSON object found in text');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`parseVerificationOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  const parsed = NoteVerificationResult.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `parseVerificationOutput: schema invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed.data;
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

interface PersistVerificationOutcome {
  status: 'verified' | 'needs_review';
  // YUK-358 决定7 — the committed verify event id, so the caller can chain a
  // (flag-gated) verify→refine enqueue to it AFTER the transaction commits.
  verifyEventId: string;
}

async function persistNoteVerificationResult(params: {
  db: Db;
  artifactId: string;
  parsed: NoteVerificationResultT;
  taskResult?: TaskTextResult;
}): Promise<PersistVerificationOutcome> {
  const { db, artifactId, parsed, taskResult } = params;
  const status = parsed.verdict === 'pass' ? 'verified' : 'needs_review';

  // YUK-350 (B5 increment 2) — project the note verdict onto the unified verify
  // contract shape, exactly like increment C did for quiz/source/variant. The note
  // PROMOTE decision is NOT recomputed here — `parsed.verdict` IS the handler's
  // decision (pass ⇒ verified active artifact, needs_review ⇒ stays needs_review).
  // The helper only PROJECTS: pass ⇒ overall='pass' (no failure_class), needs_review
  // ⇒ overall='needs_review' + failure_class='validation_failure'. A note has NO
  // 'fail' verdict, so it can never project overall='fail'; the result-layer 'error'
  // lives solely on the catch-bottom (red line 1). The verify-event payload below
  // is an ADDITIVE SUPERSET: it spreads the unified { axes, overall, failure_class?,
  // summary_md, confidence } and keeps the full `...parsed` NoteVerificationResult
  // (verdict / issues / summary_md / confidence) byte-identical for existing readers.
  const unified = toUnifiedVerifyResult({
    source: 'note',
    verdict: parsed.verdict,
    summary_md: parsed.summary_md,
    confidence: parsed.confidence,
    issues: parsed.issues,
  });

  const verifyEventId = createId();
  await db.transaction(async (tx) => {
    await tx
      .update(artifact)
      .set({
        verification_status: status,
        verification_summary: parsed as never,
        verified_by: taskResult
          ? (aiAgentRef('NoteVerifyTask', taskResult) as never)
          : ({ by: 'system', task_kind: 'NoteVerifyTask', model: 'body-block-contract' } as never),
        updated_at: new Date(),
      })
      .where(eq(artifact.id, artifactId));

    await writeEvent(tx, {
      id: verifyEventId,
      session_id: null,
      actor_kind: taskResult ? 'agent' : 'system',
      actor_ref: 'note_verify',
      action: 'experimental:note_verify',
      subject_kind: 'artifact',
      subject_id: artifactId,
      outcome: parsed.verdict === 'pass' ? 'success' : 'partial',
      // SUPERSET: the unified contract shape spread first, then the full parsed note
      // result kept on top (verdict / issues stay byte-identical; summary_md /
      // confidence are shared between the two; axes / overall / failure_class? are
      // the additive new keys).
      payload: { ...unified, ...parsed },
      caused_by_event_id: null,
      task_run_id: taskResult?.task_run_id ?? null,
      cost_micro_usd: costUsdToMicroUsd(taskResult?.cost_usd),
      created_at: new Date(),
    });

    // YUK-358 决定7 (ADR-0040) — the DEAD patch-less note_update proposal is GONE.
    // It was a permanent inbox occupant carrying only a summary + issues (no patch),
    // so the owner could never ACT on it (acceptNoteUpdateProposal needs a patch via
    // writeNoteRefineProposal — the verify-path proposal never carried one). The
    // needs_review verdict is now ADVISORY: the verification_summary + the
    // experimental:note_verify event above are the artifacts. Acting on the issues
    // is a SEPARATE, flag-gated verify→refine enqueue done by the caller AFTER this
    // transaction commits (see runNoteVerify), which routes through the NORMAL refine
    // gate so verify gets zero gate privilege (red line 1).
  });

  return { status, verifyEventId };
}

// YUK-358 决定7 — build the verify→refine context_md from the verdict summary +
// issues so the refine task sees exactly what the verifier flagged.
function buildVerifyRefineContext(parsed: NoteVerificationResultT): string {
  const lines = ['Note verification flagged issues:', parsed.summary_md];
  for (const issue of parsed.issues) {
    const where = issue.block_id ? `[block ${issue.block_id}] ` : '';
    const fix = issue.suggested_fix_md ? ` (suggested: ${issue.suggested_fix_md})` : '';
    lines.push(`- ${where}${issue.message}${fix}`);
  }
  return lines.join('\n');
}

// YUK-358 决定7 — on needs_review, (flag-gated default-OFF) enqueue a verify-kind
// refine carrying the verifier context, chained to the committed verify event.
// Default-OFF + test-env skip mean this is a no-op in tests and in prod unless the
// owner sets WAVE6_TRIGGER_VERIFY_ENABLED="true" — so the advisory verdict never
// silently spends background AI budget (red lines 1 & 2). Enqueue happens AFTER
// the persist transaction commits so the trigger event id is durable.
async function maybeEnqueueVerifyRefine(params: {
  db: Db;
  artifactId: string;
  parsed: NoteVerificationResultT;
  outcome: PersistVerificationOutcome;
}): Promise<void> {
  if (params.outcome.status !== 'needs_review') return;
  await enqueueVerifyNoteRefine({
    db: params.db,
    artifactId: params.artifactId,
    contextMd: buildVerifyRefineContext(params.parsed),
    triggerEventId: params.outcome.verifyEventId,
  });
}

export async function runNoteVerify(params: RunNoteVerifyParams): Promise<RunNoteVerifyResult> {
  const { db, artifactId, runTaskFn } = params;

  const rows = await db
    .select({
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      knowledge_ids: artifact.knowledge_ids,
      body_blocks: artifact.body_blocks,
      generation_status: artifact.generation_status,
    })
    .from(artifact)
    .where(eq(artifact.id, artifactId))
    .limit(1);
  const row = rows[0];
  if (!row) return { status: 'skipped:not_found' };
  if (row.generation_status !== 'ready') {
    return { status: 'skipped:not_ready', artifact_type: row.type };
  }
  const content = (row.body_blocks as { content?: unknown } | null)?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return { status: 'skipped:no_sections', artifact_type: row.type };
  }

  const contractFailure = noteBodyBlockContractFailure(row.type, row.body_blocks);
  if (contractFailure) {
    const outcome = await persistNoteVerificationResult({
      db,
      artifactId,
      parsed: contractFailure,
    });
    await maybeEnqueueVerifyRefine({ db, artifactId, parsed: contractFailure, outcome });
    return {
      status: outcome.status,
      artifact_type: row.type,
      issues_count: contractFailure.issues.length,
    };
  }

  const sections = bodyBlocksToNoteSections(row.body_blocks);
  const blockSummaries = bodyBlocksToBlockSummaries(row.body_blocks);

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

  const input = {
    artifact_id: row.id,
    artifact_type: row.type,
    title: row.title,
    knowledge_node: kNode,
    body_blocks: row.body_blocks,
    block_summaries: blockSummaries,
    sections,
  };

  let taskResult: TaskTextResult | null = null;
  try {
    const subjectProfile = resolveSubjectProfile(kNode?.domain);
    const result = await runTaskFn('NoteVerifyTask', input, {
      db,
      subjectProfile,
      skills: await resolveNoteSkill(subjectProfile.id),
    });
    taskResult = result;
    const parsed = parseVerificationOutput(result.text);
    const outcome = await persistNoteVerificationResult({
      db,
      artifactId,
      parsed,
      taskResult: result,
    });
    await maybeEnqueueVerifyRefine({ db, artifactId, parsed, outcome });

    return { status: outcome.status, artifact_type: row.type, issues_count: parsed.issues.length };
  } catch (err) {
    // YUK-350 (B5 increment 2, RL1) — error-safe catch-bottom. note_verify has NO
    // promote-into-the-pool path (a note never enrolls into the question pool / FSRS),
    // so a system error here can never promote anything. This catch:
    //   (a) marks the artifact verification_status='failed' (best-effort), and
    //   (b) writes a TRANSIENT-error verify event projecting the unified contract's
    //       system_error shape ({ axes:[], overall:'error', failure_class:'system_error',
    //       summary_md, confidence:0 }) — the ONLY producer of the result-layer 'error'
    //       value. The note LLM-parse schema can never emit 'error' (its verdict is the
    //       2-value pass|needs_review), so an `overall:'error'` payload is an unambiguous
    //       "system blew up before a verdict" signal. The catch re-throws so pg-boss
    //       retries; it NEVER promotes (red line 1: the model cannot self-report error).
    // The error event uses outcome='error' (NOT 'failure'): like quiz_verify, a transient
    // system failure is non-terminal and must remain retriable, distinct from a terminal
    // model verdict (note has none — its non-promote verdict is needs_review/'partial').
    try {
      await db
        .update(artifact)
        .set({ verification_status: 'failed', updated_at: new Date() })
        .where(eq(artifact.id, artifactId));
      await writeEvent(db, {
        id: createId(),
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'note_verify',
        action: 'experimental:note_verify',
        subject_kind: 'artifact',
        subject_id: artifactId,
        outcome: 'error',
        payload: {
          artifact_id: artifactId,
          ...toUnifiedVerifyResult({
            source: 'system_error',
            summary_md: `note_verify failed: ${String((err as Error).message ?? err)}`,
            error: String((err as Error).message ?? err),
          }),
          error: String((err as Error).message ?? err),
        },
        caused_by_event_id: null,
        task_run_id: taskResult?.task_run_id ?? null,
        cost_micro_usd: costUsdToMicroUsd(taskResult?.cost_usd),
        created_at: new Date(),
      });
    } catch (cleanupErr) {
      console.error('[note_verify] catch-block cleanup failed for', artifactId, cleanupErr);
    }
    throw err;
  }
}

export function buildNoteVerifyHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<NoteVerifyJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
  const { onPassed } = deps;
  return async (jobs) => {
    for (const job of jobs) {
      const artifactId = job.data?.artifact_id;
      if (!artifactId) {
        console.warn('[note_verify] job missing artifact_id', job.id);
        continue;
      }
      const result = await runNoteVerify({ db, artifactId, runTaskFn });
      if (result.status === 'verified' && result.artifact_type === 'note_atomic') {
        await onPassed?.(artifactId);
      }
      console.log(`[note_verify] ${artifactId} -> ${result.status}`);
    }
  };
}
