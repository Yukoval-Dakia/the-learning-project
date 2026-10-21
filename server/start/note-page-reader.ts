import type { Db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';

// Invoked only after token/epoch authorization; reuse the HTTP route's reader
// and input contract rather than reconstructing its aggregate here.
export async function readStartNotePage(input: { id: string }, options: { database?: Db } = {}) {
  try {
    const { NoteIdParamsSchema, loadNotePage } = await import('@/capabilities/notes/public');
    const parsed = NoteIdParamsSchema.safeParse(input);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'note id is required', 400);
    }
    const database = options.database ?? (await import('@/db/client')).db;
    const page = await loadNotePage(database, parsed.data.id);
    if (!page) {
      throw new ApiError('not_found', `note ${parsed.data.id} not found`, 404);
    }
    return page;
  } catch (error) {
    // Preserve the HTTP ApiError payload across the Start ESM/CJS boundary.
    throw errorResponse(error);
  }
}
