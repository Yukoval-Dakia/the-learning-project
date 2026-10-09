import type { NoteListQuery } from '@/capabilities/notes/public';
import type { Db, Tx } from '@/db/client';
import { errorResponse } from '@/kernel/http';

// Auth runs before this reader imports the domain or the default database.
export async function readStartNoteList(
  input: NoteListQuery,
  options: { database?: Db | Tx } = {},
) {
  try {
    const { NoteListQuerySchema, loadNoteList } = await import('@/capabilities/notes/public');
    const parsed = NoteListQuerySchema.safeParse(input);
    if (!parsed.success) throw Response.json({ error: 'validation_error' }, { status: 400 });
    const database = options.database ?? (await import('@/db/client')).db;
    return await loadNoteList(database, parsed.data);
  } catch (error) {
    // Shape errors inside the Start ESM bundle before the CJS host boundary.
    throw error instanceof Response ? error : errorResponse(error);
  }
}
