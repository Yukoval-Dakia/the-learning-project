import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { getAttemptCauseOptions, setAttemptCause } from '../server/learner-cause';
import { AttemptCauseParamsSchema, SetAttemptCauseBodySchema } from './contracts';

function parseParams(params: Record<string, string>) {
  const parsed = AttemptCauseParamsSchema.safeParse(params);
  if (parsed.success) return parsed.data;
  throw new ApiError('validation_error', 'attemptEventId is required', 400);
}

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await getAttemptCauseOptions(db, parseParams(params).attemptEventId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = SetAttemptCauseBodySchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      throw new ApiError('validation_error', message, 400);
    }
    return Response.json(
      await setAttemptCause(db, parseParams(params).attemptEventId, parsed.data),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
