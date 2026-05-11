import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { seedKnowledge } from '@/server/knowledge/seed';

export async function POST(_req: Request) {
  try {
    const result = await seedKnowledge(db);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
