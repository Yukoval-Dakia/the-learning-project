import { ApiError, errorResponse } from '@/kernel/http';
import { createReviewSession } from '../server/session-operations/review-session';
import { CreateReviewSessionBody } from './contracts';

export async function POST(req: Request): Promise<Response> {
  try {
    const requestText = await req.text();
    let raw: unknown = {};
    if (requestText.trim()) {
      try {
        raw = JSON.parse(requestText);
      } catch {
        throw new ApiError('validation_error', 'request body must be valid JSON', 400);
      }
    }
    const parsed = CreateReviewSessionBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((issue) => issue.message).join('; '),
        400,
      );
    }

    const result = await createReviewSession({ paperId: parsed.data.paper_id });
    const { sessionId } = result;
    const location = `/api/review-sessions/${encodeURIComponent(sessionId)}`;

    return Response.json(
      { session_id: sessionId },
      {
        status: result.created ? 201 : 200,
        headers: { Location: location },
      },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
