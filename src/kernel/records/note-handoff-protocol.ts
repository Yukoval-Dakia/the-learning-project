import { createHash } from 'node:crypto';

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db, Tx } from '@/db/client';
import { artifact, event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';

export const NOTE_HANDOFF_ACTION = 'experimental:note_handoff';

export const NOTE_HANDOFF_VERSION = 1;
export const NOTE_GENERATION_SINGLETON_SECONDS = 24 * 60 * 60;

const NOTE_HANDOFF_ARTIFACT_TYPES = ['note_atomic', 'note_long', 'note_hub'] as const;

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
  readonly version: typeof NOTE_HANDOFF_VERSION;
  readonly artifact_id: string;
  readonly handoff_kind: HandoffKind;
};

export const noteHandoffIntentPayloadSchema = z.object({
  version: z.literal(NOTE_HANDOFF_VERSION),
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

type NoteHandoffBossResolver = () => Promise<BossDispatch>;

let noteHandoffBossResolver: NoteHandoffBossResolver | undefined;

/** Composition root wires pg-boss dispatch so non-notes capabilities can enqueue note jobs. */
export function registerNoteHandoffBossResolver(resolver: NoteHandoffBossResolver): void {
  noteHandoffBossResolver = resolver;
}

async function resolveNoteHandoffBoss(explicit?: BossDispatch): Promise<BossDispatch> {
  if (explicit) return explicit;
  if (!noteHandoffBossResolver) {
    throw new Error('note handoff boss resolver is not registered');
  }
  return noteHandoffBossResolver();
}

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
    version: NOTE_HANDOFF_VERSION,
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

export async function artifactCanReceiveNoteHandoff(
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
        inArray(artifact.type, NOTE_HANDOFF_ARTIFACT_TYPES),
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
  if (!(await artifactCanReceiveNoteHandoff(db, artifactId, intentKind))) return false;

  const boss = await resolveNoteHandoffBoss(deps.boss);
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
