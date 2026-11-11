import { installNoteRefineTrigger } from '@/kernel/note-refine-trigger';
import { enqueueNoteRefineTrigger } from './note-refine-triggers';

/** Binds the note-refine enqueue behind the kernel port. Hosts call this before serving. */
export function installNotesHostOperations(): void {
  installNoteRefineTrigger(enqueueNoteRefineTrigger);
}
