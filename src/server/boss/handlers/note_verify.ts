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
import { writeEvent } from '@/server/events/queries';
import { resolveSubjectProfile } from '@/subjects/profile';

export interface NoteVerifyJobData {
  artifact_id: string;
}

export type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;

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
  issues_count?: number;
}

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

export async function runNoteVerify(params: RunNoteVerifyParams): Promise<RunNoteVerifyResult> {
  const { db, artifactId, runTaskFn } = params;

  const rows = await db
    .select({
      id: artifact.id,
      title: artifact.title,
      knowledge_id: artifact.knowledge_id,
      sections: artifact.sections,
      generation_status: artifact.generation_status,
    })
    .from(artifact)
    .where(eq(artifact.id, artifactId))
    .limit(1);
  const row = rows[0];
  if (!row) return { status: 'skipped:not_found' };
  if (row.generation_status !== 'ready') return { status: 'skipped:not_ready' };
  if (!row.sections || row.sections.length === 0) return { status: 'skipped:no_sections' };

  let kNode: { id: string; name: string; domain: string | null } | null = null;
  if (row.knowledge_id) {
    const kRows = await db
      .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
      .from(knowledge)
      .where(eq(knowledge.id, row.knowledge_id))
      .limit(1);
    kNode = kRows[0] ?? null;
  }

  const input = {
    artifact_id: row.id,
    title: row.title,
    knowledge_node: kNode,
    sections: row.sections,
  };

  try {
    const result = await runTaskFn('NoteVerifyTask', input, {
      db,
      subjectProfile: resolveSubjectProfile(kNode?.domain),
    });
    const parsed = parseVerificationOutput(result.text);
    const status = parsed.verdict === 'pass' ? 'verified' : 'needs_review';

    await db
      .update(artifact)
      .set({
        verification_status: status,
        verification_summary: parsed as never,
        verified_by: {
          by: 'ai',
          task_kind: 'NoteVerifyTask',
        } as never,
        updated_at: new Date(),
      })
      .where(eq(artifact.id, artifactId));

    await writeEvent(db, {
      id: createId(),
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'note_verify',
      action: 'experimental:note_verify',
      subject_kind: 'artifact',
      subject_id: artifactId,
      outcome: parsed.verdict === 'pass' ? 'success' : 'partial',
      payload: parsed,
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });

    return { status, issues_count: parsed.issues.length };
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
  return async (jobs) => {
    for (const job of jobs) {
      const artifactId = job.data?.artifact_id;
      if (!artifactId) {
        console.warn('[note_verify] job missing artifact_id', job.id);
        continue;
      }
      const result = await runNoteVerify({ db, artifactId, runTaskFn });
      console.log(`[note_verify] ${artifactId} -> ${result.status}`);
    }
  };
}
