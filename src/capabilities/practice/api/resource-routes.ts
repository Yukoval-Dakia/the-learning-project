import { ApiError, canonicalResourceResponse, errorResponse } from '@/kernel/http';
import type { ZodType } from 'zod';
import { createAnswerDraft } from './paper-answer-route';
import {
  CreatePaperAnswerDraftBodySchema,
  CreatePaperSubmissionBodySchema,
} from './paper-contracts';
import { createPaperSubmission } from './paper-submit-route';
import {
  CreateHintRequestBodySchema,
  CreateSolveSessionBodySchema,
  CreateSolveSubmissionBodySchema,
} from './question-solve-contracts';
import { createHintRequest } from './solve-hint';
import { createSolveSession } from './solve-start';
import { createSolveSubmission } from './solve-submit';

type JsonObject = Record<string, unknown>;

async function parseJsonBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const raw = await req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      'validation_error',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      400,
    );
  }
  return parsed.data;
}

function forwardedJsonRequest(req: Request, body: JsonObject): Request {
  const headers = new Headers(req.headers);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');
  return new Request(req.url, {
    method: req.method,
    headers,
    body: JSON.stringify(body),
  });
}

export async function createSolveSessionResource(req: Request): Promise<Response> {
  try {
    const { question_id: questionId, ...body } = await parseJsonBody(
      req,
      CreateSolveSessionBodySchema,
    );
    return canonicalResourceResponse(
      await createSolveSession(forwardedJsonRequest(req, body), { id: questionId }),
      {
        outcome: 'created',
        location: (responseBody) =>
          `/api/solve-sessions/${encodeURIComponent(
            (responseBody as { session_id: string }).session_id,
          )}`,
      },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function createHintRequestResource(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const { question_id: questionId, ...body } = await parseJsonBody(
      req,
      CreateHintRequestBodySchema,
    );
    return canonicalResourceResponse(
      await createHintRequest(forwardedJsonRequest(req, body), {
        id: questionId,
        sid: params.sid,
      }),
      {
        outcome: 'created',
        location: (responseBody) =>
          `/api/events/${encodeURIComponent(
            (responseBody as { hint_request_id: string }).hint_request_id,
          )}`,
      },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function createSolveSubmissionResource(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const { question_id: questionId, ...body } = await parseJsonBody(
      req,
      CreateSolveSubmissionBodySchema,
    );
    return canonicalResourceResponse(
      await createSolveSubmission(forwardedJsonRequest(req, body), {
        id: questionId,
        sid: params.sid,
      }),
      {
        outcome: 'created',
        location: (responseBody) =>
          `/api/events/${encodeURIComponent(
            (responseBody as { attempt_event_id: string }).attempt_event_id,
          )}`,
      },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function createPaperAnswerDraftResource(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const { paper_id: paperId, ...body } = await parseJsonBody(
      req,
      CreatePaperAnswerDraftBodySchema,
    );
    return canonicalResourceResponse(
      await createAnswerDraft(
        forwardedJsonRequest(req, {
          ...body,
          session_id: params.id,
        }),
        { id: paperId },
      ),
      {
        outcome: (responseBody) =>
          (responseBody as { created: boolean }).created ? 'created' : 'existing',
        location: (responseBody) =>
          `/api/review-sessions/${encodeURIComponent(params.id)}/answer-drafts/${encodeURIComponent(
            (responseBody as { answer_id: string }).answer_id,
          )}`,
      },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function createPaperSubmissionResource(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const { paper_id: paperId, ...body } = await parseJsonBody(
      req,
      CreatePaperSubmissionBodySchema,
    );
    return canonicalResourceResponse(
      await createPaperSubmission(
        forwardedJsonRequest(req, {
          ...body,
          session_id: params.id,
        }),
        { id: paperId },
      ),
      {
        outcome: 'created',
        location: (responseBody) =>
          `/api/events/${encodeURIComponent(
            (responseBody as { attempt_event_id: string }).attempt_event_id,
          )}`,
      },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
