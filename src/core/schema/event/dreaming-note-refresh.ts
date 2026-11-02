import { z } from 'zod';

/** Agency commits one of these per new note_update artifact. Notes subscribes and enqueues the refine. */
export const DREAMING_NOTE_REFRESH_ACTION = 'experimental:dreaming_note_refresh' as const;

export const DreamingNoteRefreshPayload = z.object({
  artifact_id: z.string().min(1),
  trigger_event_id: z.string().min(1),
});
export type DreamingNoteRefreshPayloadT = z.infer<typeof DreamingNoteRefreshPayload>;

export interface NoteUpdateRefreshRow {
  readonly kind?: string;
  readonly target?: {
    readonly subject_kind?: string;
    readonly subject_id?: string | null;
  } | null;
}

function noteUpdateArtifactId(row: NoteUpdateRefreshRow): string | null {
  if (row.kind !== 'note_update') return null;
  const target = row.target;
  if (target?.subject_kind !== 'artifact') return null;
  const artifactId = target.subject_id;
  if (typeof artifactId !== 'string' || artifactId.length === 0) return null;
  return artifactId;
}

/** First-seen artifact ids from new note_update proposals. Empty string targets are not signals. */
export function dreamingNoteRefreshArtifactIds(rows: readonly NoteUpdateRefreshRow[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const row of rows) {
    const artifactId = noteUpdateArtifactId(row);
    if (artifactId === null || seen.has(artifactId)) continue;
    seen.add(artifactId);
    ids.push(artifactId);
  }
  return ids;
}
