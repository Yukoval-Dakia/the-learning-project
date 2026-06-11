// Product Track 1 — second-pass verification for generated atomic notes.
//
// Enqueued after note_generate marks an atomic artifact ready. The verifier is
// deliberately a separate lifecycle axis: generation_status says whether note
// content exists; verification_status says whether another AI pass trusts it.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import { NoteVerificationResult, type NoteVerificationResultT } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { artifact, knowledge } from '@/db/schema';
import { type TaskTextRunFn, aiAgentRef, costUsdToMicroUsd } from '@/server/ai/provenance';
import type { TaskTextResult } from '@/server/ai/provenance';
import {
  bodyBlocksHaveSemanticKinds,
  bodyBlocksToBlockSummaries,
  bodyBlocksToNoteSections,
} from '@/capabilities/notes/server/body-blocks';
import { writeEvent } from '@/server/events/queries';
import { writeNoteUpdateProposal } from '@/server/proposals/producers';
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

async function persistNoteVerificationResult(params: {
  db: Db;
  artifactId: string;
  parsed: NoteVerificationResultT;
  taskResult?: TaskTextResult;
}): Promise<'verified' | 'needs_review'> {
  const { db, artifactId, parsed, taskResult } = params;
  const status = parsed.verdict === 'pass' ? 'verified' : 'needs_review';

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

    const verifyEventId = createId();
    await writeEvent(tx, {
      id: verifyEventId,
      session_id: null,
      actor_kind: taskResult ? 'agent' : 'system',
      actor_ref: 'note_verify',
      action: 'experimental:note_verify',
      subject_kind: 'artifact',
      subject_id: artifactId,
      outcome: parsed.verdict === 'pass' ? 'success' : 'partial',
      payload: parsed,
      caused_by_event_id: null,
      task_run_id: taskResult?.task_run_id ?? null,
      cost_micro_usd: costUsdToMicroUsd(taskResult?.cost_usd),
      created_at: new Date(),
    });

    if (status === 'needs_review') {
      await writeNoteUpdateProposal(tx, {
        artifact_id: artifactId,
        verification_event_id: verifyEventId,
        summary_md: parsed.summary_md,
        issues: parsed.issues,
        reason_md: parsed.summary_md,
        task_run_id: taskResult?.task_run_id ?? null,
        cost_usd: taskResult?.cost_usd,
      });
    }
  });

  return status;
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
    const status = await persistNoteVerificationResult({
      db,
      artifactId,
      parsed: contractFailure,
    });
    return { status, artifact_type: row.type, issues_count: contractFailure.issues.length };
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

  try {
    const subjectProfile = resolveSubjectProfile(kNode?.domain);
    const result = await runTaskFn('NoteVerifyTask', input, {
      db,
      subjectProfile,
      skills: await resolveNoteSkill(subjectProfile.id),
    });
    const parsed = parseVerificationOutput(result.text);
    const status = await persistNoteVerificationResult({
      db,
      artifactId,
      parsed,
      taskResult: result,
    });

    return { status, artifact_type: row.type, issues_count: parsed.issues.length };
  } catch (err) {
    await db
      .update(artifact)
      .set({ verification_status: 'failed', updated_at: new Date() })
      .where(eq(artifact.id, artifactId));
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
