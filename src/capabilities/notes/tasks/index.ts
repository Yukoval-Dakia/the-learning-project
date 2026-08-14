import { legacyTaskDefinitions } from '@/ai/legacy-task-definitions';
import { defineOwnedTaskSpecs, defineTransitionalTask } from '@/ai/owned-task-specs';
import { noteGenerateTaskSpec, noteVerifyTaskSpec } from './note-tasks';

export const notesTaskSpecs = defineOwnedTaskSpecs('notes', {
  NoteGenerateTask: noteGenerateTaskSpec,
  NoteVerifyTask: noteVerifyTaskSpec,
  NoteRefineTask: defineTransitionalTask(legacyTaskDefinitions.NoteRefineTask),
});
