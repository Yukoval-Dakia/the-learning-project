import { NoteListQuerySchema } from '@/capabilities/notes/api/contracts';
import { listNotes } from '@/capabilities/notes/server/notes-read';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { resolveSubjectKnowledgeIds } from '@/kernel/read-models/knowledge-tree';

export async function GET(req: Request): Promise<Response> {
  try {
    const parsed = NoteListQuerySchema.safeParse({
      subject: new URL(req.url).searchParams.get('subject') ?? undefined,
    });
    if (!parsed.success) return Response.json({ error: 'validation_error' }, { status: 400 });
    const subjectKnowledgeIds = parsed.data.subject
      ? await resolveSubjectKnowledgeIds(db, parsed.data.subject)
      : undefined;
    return Response.json({ rows: await listNotes(db, subjectKnowledgeIds) });
  } catch (err) {
    return errorResponse(err);
  }
}
