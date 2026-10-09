import type { NoteListResponse } from '@/capabilities/notes/ui-public';

export const noteList: NoteListResponse = {
  rows: ['note_atomic', 'note_hub', 'note_long'].map((type, index) => ({
    id: `note-${index}`,
    type,
    title: `${type}: 条件未决 α🙂 %_ \\ <script>原文</script> ${'长标题'.repeat(60)}`,
    knowledge_ids: ['inherited-child', 'custom-node', 'missing-label'],
    generation_status: index ? 'ready' : 'pending',
    verification_status: index ? 'verified' : 'unverified',
    version: index + 7,
    updated_at: `2026-10-09T12:34:5${6 - index}.789Z`,
  })),
};
