import { createHash } from 'node:crypto';

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db, Tx } from '@/db/client';
import { artifact, event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { getNotesBoss } from './boss-port';
import { NOTE_ARTIFACT_TYPES } from './note-artifact-types';

export const NOTE_HANDOFF_ACTION = 'experimental:note_handoff';

const HANDOFF_VERSION = 1;
const RECOVERY_BATCH_SIZE = 50;
export const NOTE_GENERATION_SINGLETON_SECONDS = 24 * 60 * 60;

export const NOTE_HANDOFF_KINDS = {
  generationIntent: 'generation_intent',
  generationDispatchComplete: 'generation_dispatch_complete',
  verificationIntent: 'verification_intent',
  verificationDispatchComplete: 'verification_dispatch_complete',
} as const;

type IntentKind =
  | typeof NOTE_HANDOFF_KINDS.generationIntent
  | typeof NOTE_HANDOFF_KINDS.verificationIntent;
type CompletionKind =
  | typeof NOTE_HANDOFF_KINDS.generationDispatchComplete
  | typeof NOTE_HANDOFF_KINDS.verificationDispatchComplete;
type HandoffKind = IntentKind | CompletionKind;

type HandoffPayload = {
  readonly version: typeof HANDOFF_VERSION;
  readonly artifact_id: string;
  readonly handoff_kind: HandoffKind;
};

const IntentPayloadSchema = z.object({
  version: z.literal(HANDOFF_VERSION),
  artifact_id: z.string().min(1),
  handoff_kind: z.enum([
    NOTE_HANDOFF_KINDS.generationIntent,
    NOTE_HANDOFF_KINDS.verificationIntent,
  ]),
});

export type BossDispatch = {
  send(
    queue: string,
    data: object,
    options: {
      readonly id: string;
      readonly singletonKey?: string;
      readonly singletonSeconds?: number;
    },
  ): Promise<string | null>;
  getJobById(queue: string, id: string): Promise<{ readonly state: string } | null>;
};

function deterministicHex(namespace: string, artifactId: string): string {
  return createHash('sha256').update(`${namespace}\0${artifactId}`).digest('hex');
}

export function noteHandoffEventId(kind: HandoffKind, artifactId: string): string {
  return `note_handoff_v1_${kind}_${deterministicHex(kind, artifactId).slice(0, 24)}`;
}

export function noteHandoffJobId(kind: IntentKind, artifactId: string): string {
  const hex = deterministicHex(`note-job:${kind}`, artifactId);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(
    17,
    20,
  )}-${hex.slice(20, 32)}`;
}

export function noteVerificationRecoveryJobId(artifactId: string, fence: number): string {
  const hex = deterministicHex(`note-verification-claim-recovery:${fence}`, artifactId);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(
    17,
    20,
  )}-${hex.slice(20, 32)}`;
}

function completionFor(intentKind: IntentKind): CompletionKind {
  return intentKind === NOTE_HANDOFF_KINDS.generationIntent
    ? NOTE_HANDOFF_KINDS.generationDispatchComplete
    : NOTE_HANDOFF_KINDS.verificationDispatchComplete;
}

function queueFor(intentKind: IntentKind): 'note_generate' | 'note_verify' {
  return intentKind === NOTE_HANDOFF_KINDS.generationIntent ? 'note_generate' : 'note_verify';
}

function jobOptionsFor(
  intentKind: IntentKind,
  artifactId: string,
  jobId: string,
): { readonly id: string; readonly singletonKey?: string; readonly singletonSeconds?: number } {
  return intentKind === NOTE_HANDOFF_KINDS.generationIntent
    ? {
        id: jobId,
        singletonKey: artifactId,
        singletonSeconds: NOTE_GENERATION_SINGLETON_SECONDS,
      }
    : { id: jobId };
}

async function writeHandoffRecord(
  tx: Tx,
  artifactId: string,
  handoffKind: HandoffKind,
): Promise<void> {
  const payload: HandoffPayload = {
    version: HANDOFF_VERSION,
    artifact_id: artifactId,
    handoff_kind: handoffKind,
  };
  await writeEvent(tx, {
    id: noteHandoffEventId(handoffKind, artifactId),
    actor_kind: 'system',
    actor_ref: 'notes-handoff',
    action: NOTE_HANDOFF_ACTION,
    subject_kind: 'artifact',
    subject_id: artifactId,
    outcome: 'success',
    payload,
    ingest_at: new Date(),
  });
}

export async function writeNoteGenerationIntent(tx: Tx, artifactId: string): Promise<void> {
  await writeHandoffRecord(tx, artifactId, NOTE_HANDOFF_KINDS.generationIntent);
}

export async function writeNoteVerificationIntent(tx: Tx, artifactId: string): Promise<void> {
  await writeHandoffRecord(tx, artifactId, NOTE_HANDOFF_KINDS.verificationIntent);
}

async function recordExists(db: Db, id: string): Promise<boolean> {
  const rows = await db.select({ id: event.id }).from(event).where(eq(event.id, id)).limit(1);
  return rows.length === 1;
}

async function durableJobExists(
  boss: BossDispatch,
  queue: string,
  jobId: string,
): Promise<boolean> {
  const job = await boss.getJobById(queue, jobId);
  return job !== null;
}

async function artifactCanReceiveHandoff(
  db: Db | Tx,
  artifactId: string,
  intentKind: IntentKind,
): Promise<boolean> {
  const lifecyclePredicate =
    intentKind === NOTE_HANDOFF_KINDS.generationIntent
      ? eq(artifact.generation_status, 'pending')
      : and(eq(artifact.generation_status, 'ready'), eq(artifact.verification_status, 'queued'));
  const rows = await db
    .select({ id: artifact.id })
    .from(artifact)
    .where(
      and(
        eq(artifact.id, artifactId),
        inArray(artifact.type, NOTE_ARTIFACT_TYPES),
        isNull(artifact.archived_at),
        lifecyclePredicate,
      ),
    )
    .limit(1);
  return rows.length === 1;
}

export async function dispatchNoteHandoff(
  db: Db,
  artifactId: string,
  intentKind: IntentKind,
  deps: { readonly boss?: BossDispatch } = {},
): Promise<boolean> {
  const intentId = noteHandoffEventId(intentKind, artifactId);
  const completionKind = completionFor(intentKind);
  const completionId = noteHandoffEventId(completionKind, artifactId);
  if (!(await recordExists(db, intentId)) || (await recordExists(db, completionId))) return false;
  if (!(await artifactCanReceiveHandoff(db, artifactId, intentKind))) return false;

  const boss = deps.boss ?? (await getNotesBoss());
  const queue = queueFor(intentKind);
  const jobId = noteHandoffJobId(intentKind, artifactId);
  const jobOptions = jobOptionsFor(intentKind, artifactId, jobId);
  let confirmed = false;
  try {
    const sentId = await boss.send(queue, { artifact_id: artifactId }, jobOptions);
    confirmed = sentId === jobId || (await durableJobExists(boss, queue, jobId));
  } catch (error) {
    try {
      confirmed = await durableJobExists(boss, queue, jobId);
    } catch {
      throw error;
    }
    if (!confirmed) throw error;
  }
  if (!confirmed) return false;

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`notes:handoff-complete:${completionId}`}, 0))`,
    );
    const existing = await tx
      .select({ id: event.id })
      .from(event)
      .where(eq(event.id, completionId))
      .limit(1);
    if (existing.length > 0) return false;
    await writeHandoffRecord(tx, artifactId, completionKind);
    return true;
  });
}

export async function dispatchNoteGeneration(
  db: Db,
  artifactId: string,
  deps: { readonly boss?: BossDispatch } = {},
): Promise<boolean> {
  return dispatchNoteHandoff(db, artifactId, NOTE_HANDOFF_KINDS.generationIntent, deps);
}

export async function dispatchNoteVerification(
  db: Db,
  artifactId: string,
  deps: { readonly boss?: BossDispatch } = {},
): Promise<boolean> {
  return dispatchNoteHandoff(db, artifactId, NOTE_HANDOFF_KINDS.verificationIntent, deps);
}

export async function dispatchNoteVerificationClaimRecovery(
  artifactId: string,
  fence: number,
  deps: { readonly boss?: BossDispatch } = {},
): Promise<boolean> {
  const boss = deps.boss ?? (await getNotesBoss());
  const jobId = noteVerificationRecoveryJobId(artifactId, fence);
  try {
    const sentId = await boss.send('note_verify', { artifact_id: artifactId }, { id: jobId });
    return sentId === jobId || (await durableJobExists(boss, 'note_verify', jobId));
  } catch (error) {
    try {
      if (await durableJobExists(boss, 'note_verify', jobId)) return true;
    } catch {
      throw error;
    }
    throw error;
  }
}

async function synthesizeLegacyIntents(db: Db): Promise<void> {
  const rows = await db
    .select({
      id: artifact.id,
      generation_status: artifact.generation_status,
      verification_status: artifact.verification_status,
    })
    .from(artifact)
    .where(
      and(
        isNull(artifact.archived_at),
        inArray(artifact.type, NOTE_ARTIFACT_TYPES),
        sql`(${artifact.generation_status} = 'pending' OR (${artifact.generation_status} = 'ready' AND ${artifact.verification_status} = 'queued'))
        AND NOT EXISTS (
          SELECT 1 FROM ${event} e
          WHERE e.action = ${NOTE_HANDOFF_ACTION}
            AND e.subject_id = ${artifact.id}
            AND e.payload ->> 'artifact_id' = e.subject_id
            AND e.payload ->> 'version' = ${String(HANDOFF_VERSION)}
            AND e.payload ->> 'handoff_kind' = CASE
              WHEN ${artifact.generation_status} = 'pending' THEN ${NOTE_HANDOFF_KINDS.generationIntent}
              ELSE ${NOTE_HANDOFF_KINDS.verificationIntent}
            END
        )`,
      ),
    )
    .orderBy(asc(artifact.created_at), asc(artifact.id))
    .limit(RECOVERY_BATCH_SIZE);

  for (const row of rows) {
    await db.transaction(async (tx) => {
      if (
        row.generation_status === 'pending' &&
        (await artifactCanReceiveHandoff(tx, row.id, NOTE_HANDOFF_KINDS.generationIntent))
      ) {
        await writeNoteGenerationIntent(tx, row.id);
      } else if (
        row.generation_status === 'ready' &&
        row.verification_status === 'queued' &&
        (await artifactCanReceiveHandoff(tx, row.id, NOTE_HANDOFF_KINDS.verificationIntent))
      ) {
        await writeNoteVerificationIntent(tx, row.id);
      }
    });
  }
}

export async function recoverNoteHandoffs(
  db: Db,
  deps: { readonly boss?: BossDispatch } = {},
): Promise<number> {
  await synthesizeLegacyIntents(db);
  const intentKinds = [
    NOTE_HANDOFF_KINDS.generationIntent,
    NOTE_HANDOFF_KINDS.verificationIntent,
  ] as const;
  const rows = await db
    .select({ id: event.id, artifact_id: event.subject_id, payload: event.payload })
    .from(event)
    .innerJoin(artifact, eq(artifact.id, event.subject_id))
    .where(
      and(
        eq(event.action, NOTE_HANDOFF_ACTION),
        inArray(sql<string>`${event.payload} ->> 'handoff_kind'`, intentKinds),
        eq(sql<string>`${event.payload} ->> 'version'`, String(HANDOFF_VERSION)),
        eq(sql<string>`${event.payload} ->> 'artifact_id'`, event.subject_id),
        isNull(artifact.archived_at),
        inArray(artifact.type, NOTE_ARTIFACT_TYPES),
        sql`NOT EXISTS (
          SELECT 1 FROM ${event} completion
          WHERE completion.action = ${NOTE_HANDOFF_ACTION}
            AND completion.subject_id = ${event.subject_id}
            AND completion.payload ->> 'artifact_id' = completion.subject_id
            AND completion.payload ->> 'version' = ${String(HANDOFF_VERSION)}
            AND completion.payload ->> 'handoff_kind' = CASE ${event.payload} ->> 'handoff_kind'
              WHEN ${NOTE_HANDOFF_KINDS.generationIntent} THEN ${NOTE_HANDOFF_KINDS.generationDispatchComplete}
              ELSE ${NOTE_HANDOFF_KINDS.verificationDispatchComplete}
            END
        )`,
        sql`((${event.payload} ->> 'handoff_kind' = ${NOTE_HANDOFF_KINDS.generationIntent} AND ${artifact.generation_status} = 'pending')
          OR (${event.payload} ->> 'handoff_kind' = ${NOTE_HANDOFF_KINDS.verificationIntent} AND ${artifact.generation_status} = 'ready' AND ${artifact.verification_status} = 'queued'))`,
      ),
    )
    .orderBy(asc(event.dispatch_seq), asc(event.id))
    .limit(RECOVERY_BATCH_SIZE);

  let completed = 0;
  for (const row of rows) {
    const parsed = IntentPayloadSchema.safeParse(row.payload);
    if (!parsed.success || parsed.data.artifact_id !== row.artifact_id) continue;
    if (await dispatchNoteHandoff(db, row.artifact_id, parsed.data.handoff_kind, deps))
      completed += 1;
  }
  return completed;
}

type NotesRecoveryFloorDeps = {
  recoverHandoffs?: () => Promise<number>;
  recoverClaims?: () => Promise<number>;
};

export async function recoverNoteHandoffsAndClaims(
  db: Db,
  deps: NotesRecoveryFloorDeps = {},
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await (deps.recoverHandoffs?.() ?? recoverNoteHandoffs(db));
  } catch (error) {
    errors.push(error);
  }
  try {
    if (deps.recoverClaims) {
      await deps.recoverClaims();
    } else {
      const { recoverResultReadyNoteVerifications } = await import(
        '@/capabilities/notes/jobs/note_verify'
      );
      await recoverResultReadyNoteVerifications(db);
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw errors[0];
}
