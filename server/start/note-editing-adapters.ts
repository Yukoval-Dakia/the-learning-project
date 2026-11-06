import { blurStartNoteEditing, heartbeatStartNoteEditing } from './note-editing-operation';

// One family surface, constructed in the API graph when a Start operation first asks
// for it; each adapter keeps owning its own conversion, error and deadline handling.
export const noteEditingAdapters = { blurStartNoteEditing, heartbeatStartNoteEditing };
