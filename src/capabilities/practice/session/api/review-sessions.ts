import { errorResponse } from '@/kernel/http';
import { createReviewSession } from '../server/session-operations/review-session';

export async function POST(req: Request): Promise<Response> {
  try {
    const result = await createReviewSession(await req.text());
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
