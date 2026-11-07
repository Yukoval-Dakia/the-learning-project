import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { readKnowledgeEntityCard } from '@/kernel/read-models/knowledge-card';
import { readNoteEntityCard } from '@/kernel/read-models/note-card';
import { EntityCardParamsSchema } from './contracts';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsed = EntityCardParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'card kind must be knowledge or note', 400);
    }
    const card =
      parsed.data.kind === 'knowledge'
        ? await readKnowledgeEntityCard(db, parsed.data.id)
        : await readNoteEntityCard(db, parsed.data.id);
    return Response.json(card);
  } catch (error) {
    return errorResponse(error);
  }
}
