import { defineOwnedTaskSpecs } from '@/ai/owned-task-specs';
import { noteRefineTaskSpec } from './note-refine';
import { noteGenerateTaskSpec } from './note-tasks';

export const notesTaskSpecs = defineOwnedTaskSpecs('notes', {
  NoteGenerateTask: noteGenerateTaskSpec,
  NoteRefineTask: noteRefineTaskSpec,
});
