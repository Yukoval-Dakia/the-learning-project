import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { artifact, event } from '@/db/schema';
import {
  type BossDispatch,
  NOTE_HANDOFF_ACTION,
  NOTE_HANDOFF_KINDS,
  NOTE_HANDOFF_VERSION,
  artifactCanReceiveNoteHandoff,
  dispatchNoteGeneration as dispatchNoteGenerationKernel,
  dispatchNoteHandoff as dispatchNoteHandoffKernel,
  noteHandoffIntentPayloadSchema,
  writeNoteGenerationIntent,
} from '@/kernel/records/note-handoff-protocol';
import { getNotesBoss } from './boss-port';
import { NOTE_ARTIFACT_TYPES } from './note-artifact-types';
import { attrsWithGenerationWait, readNoteGenerationWait } from './note-generation-failure';

const RECOVERY_BATCH_SIZE = 50;
const LIVE_JOB_STATES = new Set(['created', 'retry', 'active']);

async function resolveNotesBoss(deps: { readonly boss?: BossDispatch }): Promise<BossDispatch> {
  return deps.boss ?? (await getNotesBoss());
}

export async function dispatchNoteHandoff(
  db: Db,
  artifactId: string,
  intentKind:
    | typeof NOTE_HANDOFF_KINDS.generationIntent
    | typeof NOTE_HANDOFF_KINDS.verificationIntent,
  deps: { readonly boss?: BossDispatch } = {},
): Promise<boolean> {
  const boss = await resolveNotesBoss(deps);
  return dispatchNoteHandoffKernel(db, artifactId, intentKind, { boss });
}

export async function dispatchNoteGeneration(
  db: Db,
  artifactId: string,
  deps: { readonly boss?: BossDispatch } = {},
): Promise<boolean> {
  const boss = await resolveNotesBoss(deps);
  return dispatchNoteGenerationKernel(db, artifactId, { boss });
}

async function synthesizeLegacyIntents(db: Db): Promise<void> {
  const rows = await db
    .select({ id: artifact.id, generation_status: artifact.generation_status })
    .from(artifact)
    .where(
      and(
        isNull(artifact.archived_at),
        inArray(artifact.type, NOTE_ARTIFACT_TYPES),
        sql`${artifact.generation_status} = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM ${event} e
          WHERE e.action = ${NOTE_HANDOFF_ACTION}
            AND e.subject_id = ${artifact.id}
            AND e.payload ->> 'artifact_id' = e.subject_id
            AND e.payload ->> 'version' = ${String(NOTE_HANDOFF_VERSION)}
            AND e.payload ->> 'handoff_kind' = ${NOTE_HANDOFF_KINDS.generationIntent}
        )`,
      ),
    )
    .orderBy(asc(artifact.created_at), asc(artifact.id))
    .limit(RECOVERY_BATCH_SIZE);

  for (const row of rows) {
    await db.transaction(async (tx) => {
      if (await artifactCanReceiveNoteHandoff(tx, row.id, NOTE_HANDOFF_KINDS.generationIntent)) {
        await writeNoteGenerationIntent(tx, row.id);
      }
    });
  }
}

export async function recoverNoteHandoffs(
  db: Db,
  deps: { readonly boss?: BossDispatch } = {},
): Promise<number> {
  await synthesizeLegacyIntents(db);
  // Stale verification_intent records (pre-YUK-1772) are left alone: nothing
  // consumes the retired note_verify queue anymore.
  const intentKinds = [NOTE_HANDOFF_KINDS.generationIntent] as const;
  const rows = await db
    .select({ id: event.id, artifact_id: event.subject_id, payload: event.payload })
    .from(event)
    .innerJoin(artifact, eq(artifact.id, event.subject_id))
    .where(
      and(
        eq(event.action, NOTE_HANDOFF_ACTION),
        inArray(sql<string>`${event.payload} ->> 'handoff_kind'`, intentKinds),
        eq(sql<string>`${event.payload} ->> 'version'`, String(NOTE_HANDOFF_VERSION)),
        eq(sql<string>`${event.payload} ->> 'artifact_id'`, event.subject_id),
        isNull(artifact.archived_at),
        inArray(artifact.type, NOTE_ARTIFACT_TYPES),
        sql`NOT EXISTS (
          SELECT 1 FROM ${event} completion
          WHERE completion.action = ${NOTE_HANDOFF_ACTION}
            AND completion.subject_id = ${event.subject_id}
            AND completion.payload ->> 'artifact_id' = completion.subject_id
            AND completion.payload ->> 'version' = ${String(NOTE_HANDOFF_VERSION)}
            AND completion.payload ->> 'handoff_kind' = ${NOTE_HANDOFF_KINDS.generationDispatchComplete}
        )`,
        sql`${artifact.generation_status} = 'pending'`,
      ),
    )
    .orderBy(asc(event.dispatch_seq), asc(event.id))
    .limit(RECOVERY_BATCH_SIZE);

  let completed = 0;
  for (const row of rows) {
    const parsed = noteHandoffIntentPayloadSchema.safeParse(row.payload);
    if (!parsed.success || parsed.data.artifact_id !== row.artifact_id) continue;
    if (await dispatchNoteHandoff(db, row.artifact_id, parsed.data.handoff_kind, deps))
      completed += 1;
  }
  return completed;
}

/**
 * Provider-wait floor (YUK-2030): pending notes carrying a generation_wait
 * receipt whose retry instant passed. The recorded wake_job_id is resent with
 * the same id (a lost wake lands; a live one collides harmlessly), and when the
 * recorded job is provably dead the receipt is repointed to a fresh id — the
 * same repoint pattern intervention reconcile uses. No paid effect is created:
 * the wake job is just a delivery.
 */
async function recoverNoteGenerationWaits(
  db: Db,
  deps: { readonly boss?: BossDispatch } = {},
): Promise<number> {
  const now = new Date().toISOString();
  const rows = await db
    .select({ id: artifact.id, attrs: artifact.attrs })
    .from(artifact)
    .where(
      and(
        isNull(artifact.archived_at),
        inArray(artifact.type, NOTE_ARTIFACT_TYPES),
        sql`${artifact.generation_status} = 'pending'`,
        sql`${artifact.attrs} -> 'generation_wait' ->> 'retry_at' <= ${now}`,
      ),
    )
    .orderBy(asc(artifact.updated_at), asc(artifact.id))
    .limit(RECOVERY_BATCH_SIZE);

  const boss = await resolveNotesBoss(deps);
  let rearmed = 0;
  for (const row of rows) {
    const wait = readNoteGenerationWait(row.attrs);
    if (!wait) continue;
    const job = await boss.getJobById('note_generate', wait.wake_job_id);
    if (job && LIVE_JOB_STATES.has(job.state)) continue;
    // Dead or never-landed wake: repoint the receipt to a fresh id and send it
    // immediately — the recorded retry instant is already past.
    const wakeJobId = randomUUID();
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ attrs: artifact.attrs })
        .from(artifact)
        .where(and(eq(artifact.id, row.id), sql`${artifact.generation_status} = 'pending'`))
        .for('update')
        .limit(1);
      const currentWait = readNoteGenerationWait(current?.attrs);
      // Someone else already re-armed or finished this note — leave it.
      if (!currentWait || currentWait.retry_at !== wait.retry_at) return;
      await tx
        .update(artifact)
        .set({
          attrs: attrsWithGenerationWait(current.attrs, {
            ...currentWait,
            wake_job_id: wakeJobId,
          }),
          updated_at: new Date(),
        })
        .where(and(eq(artifact.id, row.id), sql`${artifact.generation_status} = 'pending'`));
    });
    const sent = await boss.send('note_generate', { artifact_id: row.id }, { id: wakeJobId });
    if (sent !== null) rearmed += 1;
  }
  return rearmed;
}

type NotesRecoveryFloorDeps = {
  recoverHandoffs?: () => Promise<number>;
};

export async function recoverNoteHandoffsAndClaims(
  db: Db,
  deps: NotesRecoveryFloorDeps = {},
): Promise<void> {
  await (deps.recoverHandoffs?.() ?? recoverNoteHandoffs(db));
  const rearmed = await recoverNoteGenerationWaits(db);
  if (rearmed > 0) {
    console.log('[hub_sync_recovery] re-armed note generation waits', { rearmed });
  }
}
