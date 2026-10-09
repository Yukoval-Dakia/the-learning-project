import type { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { resolveSubjectKnowledgeIds } from '@/kernel/read-models/knowledge-tree';
import type { NoteListQuerySchema, NoteListResponseSchema } from '../api/contracts';
import { listNotes } from './notes-read';

export type NoteListQuery = z.infer<typeof NoteListQuerySchema>;
export type NoteListResponse = z.infer<typeof NoteListResponseSchema>;

// Both transports validate with NoteListQuerySchema before calling this operation.
export async function loadNoteList(
  database: Db | Tx,
  input: NoteListQuery,
): Promise<NoteListResponse> {
  const ids = input.subject ? await resolveSubjectKnowledgeIds(database, input.subject) : undefined;
  return { rows: await listNotes(database, ids, input.query) };
}
