// Read-only projection of refine apply events and their recorded undo facts.
// Notes retains the mutation, publication, recovery and provider policy.
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';

type DbLike = Db | Tx;

export interface NoteRefineChangeRow {
  event_id: string;
  artifact_id: string;
  created_at: Date;
  actor_ref: string;
  ops_count: number;
  new_blocks: number;
  previous_artifact_version: number;
  next_artifact_version: number;
  undone: boolean;
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export async function listNoteRefineChanges(
  db: DbLike,
  opts: { artifactId?: string; since?: Date; limit?: number } = {},
): Promise<NoteRefineChangeRow[]> {
  const conditions = [eq(event.action, 'experimental:note_refine_apply')];
  if (opts.artifactId) conditions.push(eq(event.subject_id, opts.artifactId));
  if (opts.since) conditions.push(gte(event.created_at, opts.since));
  const query = db
    .select()
    .from(event)
    .where(and(...conditions))
    .orderBy(desc(event.created_at), desc(event.id));
  const rows = opts.limit === undefined ? await query : await query.limit(opts.limit);
  const applyEventIds = rows.map((row) => row.id);
  const undoRows =
    applyEventIds.length === 0
      ? []
      : await db
          .select()
          .from(event)
          .where(
            and(
              eq(event.action, 'experimental:note_refine_undo'),
              inArray(event.caused_by_event_id, applyEventIds),
            ),
          );
  const undoneIds = new Set(
    undoRows
      .map((row) => (row.payload as { undone_event_id?: unknown }).undone_event_id)
      .filter((id): id is string => typeof id === 'string'),
  );
  return rows.map((row) => {
    const payload = row.payload as Record<string, unknown>;
    return {
      event_id: row.id,
      artifact_id: row.subject_id,
      created_at: row.created_at,
      actor_ref: row.actor_ref,
      ops_count: toNumber(payload.ops_count),
      new_blocks: toNumber(payload.new_blocks),
      previous_artifact_version: toNumber(payload.previous_artifact_version),
      next_artifact_version: toNumber(payload.next_artifact_version),
      undone: undoneIds.has(row.id),
    };
  });
}
