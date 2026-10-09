import { NoteListQuerySchema } from '@/capabilities/notes/api/contracts';
import { loadNoteList } from '@/capabilities/notes/server/note-list-read';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

export async function GET(req: Request): Promise<Response> {
  try {
    const params = new URL(req.url).searchParams;
    const parsed = NoteListQuerySchema.safeParse({
      subject: params.get('subject') ?? undefined,
      query: params.get('query') ?? undefined,
    });
    if (!parsed.success) return Response.json({ error: 'validation_error' }, { status: 400 });
    return Response.json(await loadNoteList(db, parsed.data));
  } catch (err) {
    return errorResponse(err);
  }
}
