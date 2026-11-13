import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { listOpenLearningItemPlans } from '@/kernel/records/learning-items';
import { LearningItemPlansQuerySchema, LearningItemPlansResponseSchema } from './contracts';

export async function GET(req: Request): Promise<Response> {
  try {
    const parsed = LearningItemPlansQuerySchema.safeParse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    if (!parsed.success) throw new ApiError('validation_error', 'invalid pagination', 400);
    const page = await listOpenLearningItemPlans(db, parsed.data);
    return Response.json(
      LearningItemPlansResponseSchema.parse({
        ...page,
        items: page.items.map((item) => ({
          ...item,
          due_at: item.due_at?.toISOString() ?? null,
        })),
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
