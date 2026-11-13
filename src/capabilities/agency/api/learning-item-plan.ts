// Learner plan edit: pin and project deadline on one learning item.
// The Today editor and other callers share the canonical plan writer.

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { setLearningItemPlan } from '@/kernel/records/learning-items';
import { LearningItemPlanBody } from './contracts';

export async function PATCH(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const id = params.id;
    if (!id) throw new ApiError('validation_error', 'missing learning item id', 400);
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new ApiError('validation_error', 'request body must be valid JSON', 400);
    }
    const parsed = LearningItemPlanBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((issue) => issue.message).join('; '),
        400,
      );
    }
    const body = parsed.data;
    const patch = {
      ...(body.user_pinned !== undefined ? { user_pinned: body.user_pinned } : {}),
      ...(body.due_at !== undefined
        ? { due_at: body.due_at === null ? null : new Date(body.due_at) }
        : {}),
    };
    const result = await setLearningItemPlan(db, id, patch);
    if (!result.ok) {
      if (result.reason === 'missing') {
        throw new ApiError('not_found', `learning_item ${id} not found`, 404);
      }
      if (result.reason === 'unanchored') {
        throw new ApiError(
          'conflict',
          `Learning item ${id} needs canonical projection migration`,
          409,
        );
      }
      throw new ApiError('validation_error', 'plan update must set pin or deadline', 400);
    }
    return Response.json({
      id: result.id,
      user_pinned: result.user_pinned,
      due_at: result.due_at === null ? null : result.due_at.toISOString(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
