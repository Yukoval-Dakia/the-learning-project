import { and, eq, gt, sql } from 'drizzle-orm';
import type { NoteRefineTriggerKind } from '@/capabilities/notes/jobs/note-refine';
import { getConfig } from '@/core/config/store';
import type { Db } from '@/db/client';
import { job_events } from '@/db/schema';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';
import { getNotesBoss, notesBossTransaction } from './boss-port';

export const NOTE_REFINE_TRIGGER_DEBOUNCE_MS = 60 * 60_000;
const NOTE_REFINE_DEBOUNCE_TABLE = 'note_refine_debounce';

const FLAG_BY_KIND: Record<NoteRefineTriggerKind, string> = {
  mark_wrong: 'WAVE6_TRIGGER_MARK_WRONG_ENABLED',
  mastery_change: 'WAVE6_TRIGGER_MASTERY_ENABLED',
  dreaming: 'WAVE6_TRIGGER_DREAMING_ENABLED',
  // Opt-in: verify findings add background AI cost only when enabled.
  verify: 'WAVE6_TRIGGER_VERIFY_ENABLED',
};

export type NoteRefineBossSend = (
  queue: 'note_refine',
  data: {
    artifact_id: string;
    effect_id?: string;
    trigger: {
      kind: NoteRefineTriggerKind;
      context_md?: string;
      evidence_ids?: string[];
      trigger_event_id?: string;
    };
  },
  options?: {
    singletonKey?: string;
    singletonSeconds?: number;
    db?: ReturnType<typeof notesBossTransaction>;
  },
) => Promise<string | null>;

export type NoteRefineTriggerResult =
  | { status: 'enqueued'; artifact_id: string; kind: NoteRefineTriggerKind }
  | { status: 'skipped:disabled'; artifact_id: string; kind: NoteRefineTriggerKind }
  | { status: 'skipped:debounced'; artifact_id: string; kind: NoteRefineTriggerKind }
  | { status: 'skipped:test_env'; artifact_id: string; kind: NoteRefineTriggerKind }
  | { status: 'failed'; artifact_id: string; kind: NoteRefineTriggerKind; error: string };

export function noteRefineTriggerEnabled(
  kind: NoteRefineTriggerKind,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const resolved = getConfig(FLAG_BY_KIND[kind], env);
  return resolved === true;
}

export async function enqueueNoteRefineTrigger(input: {
  db?: Db;
  artifactId: string;
  kind: NoteRefineTriggerKind;
  contextMd?: string;
  evidenceIds?: string[];
  triggerEventId?: string;
  now?: Date;
  bossSend?: NoteRefineBossSend;
  env?: NodeJS.ProcessEnv;
}): Promise<NoteRefineTriggerResult> {
  if (!noteRefineTriggerEnabled(input.kind, input.env ?? process.env)) {
    return { status: 'skipped:disabled', artifact_id: input.artifactId, kind: input.kind };
  }
  const key = `${input.kind}:${input.artifactId}`;

  // Central guard (NODE_ENV === 'test' or VITEST) rather than a bare VITEST
  // check, which would also skip real enqueues if prod set it. An injected
  // bossSend still bypasses the skip for tests.
  if (!input.bossSend && !shouldEnqueueBackgroundJobs()) {
    return { status: 'skipped:test_env', artifact_id: input.artifactId, kind: input.kind };
  }

  try {
    let send = input.bossSend;
    if (!send) {
      const boss = await getNotesBoss();
      send = boss.send.bind(boss);
    }
    const data = {
      artifact_id: input.artifactId,
      trigger: {
        kind: input.kind,
        context_md: input.contextMd,
        evidence_ids: input.evidenceIds,
        trigger_event_id: input.triggerEventId,
      },
    };

    if (input.db) {
      const enqueued = await input.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`note_refine:${key}`}))`);
        const cutoff = input.now
          ? sql`${input.now.toISOString()}::timestamptz - ${NOTE_REFINE_TRIGGER_DEBOUNCE_MS} * interval '1 millisecond'`
          : sql`now() - ${NOTE_REFINE_TRIGGER_DEBOUNCE_MS} * interval '1 millisecond'`;
        const existing = await tx
          .select({ id: job_events.id })
          .from(job_events)
          .where(
            and(
              eq(job_events.business_table, NOTE_REFINE_DEBOUNCE_TABLE),
              eq(job_events.business_id, key),
              gt(job_events.occurred_at, cutoff),
            ),
          )
          .limit(1);
        if (existing.length > 0) return false;

        const jobId = await send('note_refine', data, { db: notesBossTransaction(tx) });
        if (jobId === null) return false;

        await tx.insert(job_events).values({
          business_table: NOTE_REFINE_DEBOUNCE_TABLE,
          business_id: key,
          event_type: 'note_refine.enqueued',
          payload: { kind: input.kind, artifact_id: input.artifactId, job_id: jobId },
          ...(input.now ? { occurred_at: input.now } : {}),
        });
        return true;
      });
      return {
        status: enqueued ? 'enqueued' : 'skipped:debounced',
        artifact_id: input.artifactId,
        kind: input.kind,
      };
    }

    const jobId = await send('note_refine', data, {
      singletonKey: key,
      singletonSeconds: NOTE_REFINE_TRIGGER_DEBOUNCE_MS / 1000,
    });
    return {
      status: jobId === null ? 'skipped:debounced' : 'enqueued',
      artifact_id: input.artifactId,
      kind: input.kind,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[note_refine:${input.kind}] enqueue failed for ${input.artifactId}:`, err);
    return { status: 'failed', artifact_id: input.artifactId, kind: input.kind, error };
  }
}

export const enqueueMarkWrongNoteRefine = (input: {
  db?: Db;
  artifactId: string;
  blockId?: string;
  reasonMd?: string;
  triggerEventId?: string;
  bossSend?: NoteRefineBossSend;
}) =>
  enqueueNoteRefineTrigger({
    ...input,
    kind: 'mark_wrong',
    contextMd: [
      'User marked an artifact block as wrong.',
      input.blockId ? `block_id=${input.blockId}` : null,
      input.reasonMd ? `reason=${input.reasonMd}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    evidenceIds: input.triggerEventId ? [input.triggerEventId] : [],
  });

// note_verify → refine bridge: needs_review enqueues a verify refine carrying the
// findings. Opt-in so it does not silently add background cost, and it passes the
// same gate as every other trigger. Its debounce key is separate from the others.
export const enqueueVerifyNoteRefine = (input: {
  db?: Db;
  artifactId: string;
  contextMd?: string;
  triggerEventId?: string;
  bossSend?: NoteRefineBossSend;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}) =>
  enqueueNoteRefineTrigger({
    ...input,
    kind: 'verify',
    contextMd:
      input.contextMd ?? 'Note verification flagged issues; consider a small corrective patch.',
    evidenceIds: input.triggerEventId ? [input.triggerEventId] : [],
  });

// Fires on a successful attempt during the instrumentation window; gating on a
// p(L) cross-threshold is deferred until telemetry chooses that threshold. Do not
// hardcode one here or change the condition.
export const enqueueMasteryNoteRefine = (input: {
  db?: Db;
  artifactId: string;
  questionId?: string;
  triggerEventId?: string;
  bossSend?: NoteRefineBossSend;
}) =>
  enqueueNoteRefineTrigger({
    ...input,
    kind: 'mastery_change',
    contextMd: input.questionId
      ? `Mastery signal raised for question ${input.questionId} (attempt succeeded).`
      : 'Mastery signal raised (attempt succeeded).',
    evidenceIds: input.triggerEventId ? [input.triggerEventId] : [],
  });

export const enqueueDreamingNoteRefine = (input: {
  db?: Db;
  artifactId: string;
  triggerEventId?: string;
  bossSend?: NoteRefineBossSend;
}) =>
  enqueueNoteRefineTrigger({
    ...input,
    kind: 'dreaming',
    contextMd: 'Dreaming scan found this artifact as a Living Note refresh candidate.',
    evidenceIds: input.triggerEventId ? [input.triggerEventId] : [],
  });
