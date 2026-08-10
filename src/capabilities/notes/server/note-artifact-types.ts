export const NOTE_ARTIFACT_TYPES = ['note_atomic', 'note_long', 'note_hub'] as const;

export type NoteArtifactType = (typeof NOTE_ARTIFACT_TYPES)[number];

export function isNoteArtifactType(value: string): value is NoteArtifactType {
  return value === 'note_atomic' || value === 'note_long' || value === 'note_hub';
}
