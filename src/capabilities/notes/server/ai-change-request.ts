// AI note-change reads and undo for both front doors (HTTP and Start).
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { listNoteRefineChanges } from '@/kernel/read-models/note-refine-changes';
import { undoNoteRefineApplyEvent } from './note-refine-apply';

const RECENT_WINDOW_HOURS = 24 as const;

/** Newest 25 AI changes across all notes in the last 24 hours. */
export async function readRecentAiChanges(db: Db, now: Date = new Date()) {
  const rows = await listNoteRefineChanges(db, {
    since: new Date(now.getTime() - RECENT_WINDOW_HOURS * 60 * 60_000),
    limit: 25,
  });
  return { window_hours: RECENT_WINDOW_HOURS, rows };
}

function requireArtifactId(rawArtifactId: unknown): string {
  if (typeof rawArtifactId !== 'string' || !rawArtifactId) {
    throw new ApiError('validation_error', 'artifact id is required', 400);
  }
  return rawArtifactId;
}

/** Newest 50 AI changes for one note. */
export async function listArtifactAiChanges(db: Db, rawArtifactId: unknown) {
  const artifactId = requireArtifactId(rawArtifactId);
  const rows = await listNoteRefineChanges(db, { artifactId, limit: 50 });
  return { artifact_id: artifactId, rows };
}

/**
 * Undo one AI change, only when that apply event belongs to this note. Ownership is
 * checked by event id, so it holds for any change, however old.
 */
export async function undoArtifactAiChange(db: Db, rawArtifactId: unknown, rawEventId: unknown) {
  const artifactId = requireArtifactId(rawArtifactId);
  if (typeof rawEventId !== 'string' || !rawEventId) {
    throw new ApiError('validation_error', 'event id is required', 400);
  }
  const eventId = rawEventId;
  const owned = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.id, eventId),
        eq(event.action, 'experimental:note_refine_apply'),
        eq(event.subject_id, artifactId),
      ),
    )
    .limit(1);
  if (owned.length === 0) {
    throw new ApiError(
      'not_found',
      `note refine apply event ${eventId} was not found for artifact ${artifactId}`,
      404,
    );
  }
  return undoNoteRefineApplyEvent(db, { applyEventId: eventId });
}
