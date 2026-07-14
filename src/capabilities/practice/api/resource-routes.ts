import { ApiError, errorResponse } from '@/kernel/http';
import { createAnswerDraft } from './paper-answer-route';
import { createPaperSubmission } from './paper-submit-route';
import { createHintRequest } from './solve-hint';
import { createSolveSession } from './solve-start';
import { createSolveSubmission } from './solve-submit';

type JsonObject = Record<string, unknown>;

async function readJsonObject(req: Request): Promise<JsonObject> {
  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError('validation_error', 'request body must be a JSON object', 400);
  }
  return raw as JsonObject;
}

function requiredId(body: JsonObject, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError('validation_error', `${field} is required`, 400);
  }
  return value;
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

function withoutField(body: JsonObject, field: string): JsonObject {
  const forwarded = { ...body };
  delete forwarded[field];
  return forwarded;
}

export async function createSolveSessionResource(req: Request): Promise<Response> {
  try {
    const body = await readJsonObject(req);
    const questionId = requiredId(body, 'question_id');
    return createSolveSession(forwardedJsonRequest(req, withoutField(body, 'question_id')), {
      id: questionId,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function createHintRequestResource(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const body = await readJsonObject(req);
    const questionId = requiredId(body, 'question_id');
    return createHintRequest(forwardedJsonRequest(req, withoutField(body, 'question_id')), {
      id: questionId,
      sid: params.sid,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function createSolveSubmissionResource(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const body = await readJsonObject(req);
    const questionId = requiredId(body, 'question_id');
    return createSolveSubmission(forwardedJsonRequest(req, withoutField(body, 'question_id')), {
      id: questionId,
      sid: params.sid,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function createPaperAnswerDraftResource(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const body = await readJsonObject(req);
    const paperId = requiredId(body, 'paper_id');
    return createAnswerDraft(
      forwardedJsonRequest(req, {
        ...withoutField(body, 'paper_id'),
        session_id: params.id,
      }),
      { id: paperId },
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
    const body = await readJsonObject(req);
    const paperId = requiredId(body, 'paper_id');
    return createPaperSubmission(
      forwardedJsonRequest(req, {
        ...withoutField(body, 'paper_id'),
        session_id: params.id,
      }),
      { id: paperId },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
