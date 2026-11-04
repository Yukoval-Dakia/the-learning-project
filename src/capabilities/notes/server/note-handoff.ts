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

const RECOVERY_BATCH_SIZE = 50;

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

type NotesRecoveryFloorDeps = {
  recoverHandoffs?: () => Promise<number>;
};

export async function recoverNoteHandoffsAndClaims(
  db: Db,
  deps: NotesRecoveryFloorDeps = {},
): Promise<void> {
  await (deps.recoverHandoffs?.() ?? recoverNoteHandoffs(db));
}
