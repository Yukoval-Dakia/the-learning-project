import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAnswerDraft: vi.fn(),
  createPaperSubmission: vi.fn(),
  createHintRequest: vi.fn(),
  createSolveSession: vi.fn(),
  createSolveSubmission: vi.fn(),
}));

vi.mock('./paper-answer-route', () => ({ createAnswerDraft: mocks.createAnswerDraft }));
vi.mock('./paper-submit-route', () => ({ createPaperSubmission: mocks.createPaperSubmission }));
vi.mock('./solve-hint', () => ({ createHintRequest: mocks.createHintRequest }));
vi.mock('./solve-start', () => ({ createSolveSession: mocks.createSolveSession }));
vi.mock('./solve-submit', () => ({ createSolveSubmission: mocks.createSolveSubmission }));

import { PaperAnswerDraftCreatedSchema, PaperSubmissionResponseSchema } from './paper-contracts';
import {
  createHintRequestResource,
  createPaperAnswerDraftResource,
  createPaperSubmissionResource,
  createSolveSessionResource,
  createSolveSubmissionResource,
} from './resource-routes';

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/resource', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function capturedBody(mock: ReturnType<typeof vi.fn>): Promise<Record<string, unknown>> {
  const request = mock.mock.calls[0]?.[0] as Request;
  return (await request.json()) as Record<string, unknown>;
}

describe('canonical practice resource adapters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAnswerDraft.mockResolvedValue(
      Response.json({ answer_id: 'answer_1', created: true }),
    );
    mocks.createPaperSubmission.mockResolvedValue(
      Response.json({
        attempt_event_id: 'paper_attempt_1',
        judge_event_id: 'paper_judge_1',
        answer_id: 'answer_1',
        visible_to_user: true,
        coarse_outcome: 'correct',
        score: 1,
      }),
    );
    mocks.createHintRequest.mockResolvedValue(Response.json({ hint_request_id: 'hint_1' }));
    mocks.createSolveSession.mockResolvedValue(Response.json({ session_id: 'solve_1' }));
    mocks.createSolveSubmission.mockResolvedValue(
      Response.json({ attempt_event_id: 'solve_attempt_1' }),
    );
  });

  it('binds solve session creation to question_id', async () => {
    const response = await createSolveSessionResource(
      jsonRequest({ question_id: 'q1', regenerate: true }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('Location')).toBe('/api/solve-sessions/solve_1');
    expect(mocks.createSolveSession.mock.calls[0]?.[1]).toEqual({ id: 'q1' });
    expect(await capturedBody(mocks.createSolveSession)).toEqual({ regenerate: true });
  });

  it('binds hint and solve submissions to the solve session resource', async () => {
    const hint = await createHintRequestResource(
      jsonRequest({ question_id: 'q1', hint_index: 2 }),
      {
        sid: 'solve_1',
      },
    );
    const submission = await createSolveSubmissionResource(
      jsonRequest({ question_id: 'q1', student_final_answer_text: '42' }),
      { sid: 'solve_1' },
    );

    expect(mocks.createHintRequest.mock.calls[0]?.[1]).toEqual({ id: 'q1', sid: 'solve_1' });
    expect(await capturedBody(mocks.createHintRequest)).toEqual({ hint_index: 2 });
    expect(mocks.createSolveSubmission.mock.calls[0]?.[1]).toEqual({
      id: 'q1',
      sid: 'solve_1',
    });
    expect(await capturedBody(mocks.createSolveSubmission)).toEqual({
      student_final_answer_text: '42',
    });
    expect(hint.status).toBe(201);
    expect(hint.headers.get('Location')).toBe('/api/events/hint_1');
    expect(submission.status).toBe(201);
    expect(submission.headers.get('Location')).toBe('/api/events/solve_attempt_1');
  });

  it('uses the review session path as the authority for paper writes', async () => {
    const draft = await createPaperAnswerDraftResource(
      jsonRequest({ paper_id: 'paper_1', question_id: 'q1', content_md: 'draft' }),
      { id: 'review_1' },
    );
    const submission = await createPaperSubmissionResource(
      jsonRequest({ paper_id: 'paper_1', question_id: 'q1', answer_md: 'answer' }),
      { id: 'review_1' },
    );

    expect(mocks.createAnswerDraft.mock.calls[0]?.[1]).toEqual({ id: 'paper_1' });
    expect(await capturedBody(mocks.createAnswerDraft)).toEqual({
      question_id: 'q1',
      content_md: 'draft',
      input_kind: 'text',
      image_refs: [],
      session_id: 'review_1',
    });
    expect(mocks.createPaperSubmission.mock.calls[0]?.[1]).toEqual({ id: 'paper_1' });
    expect(await capturedBody(mocks.createPaperSubmission)).toEqual({
      question_id: 'q1',
      answer_md: 'answer',
      image_refs: [],
      session_id: 'review_1',
    });
    expect(draft.status).toBe(201);
    expect(draft.headers.get('Location')).toBe(
      '/api/review-sessions/review_1/answer-drafts/answer_1',
    );
    expect(submission.status).toBe(201);
    expect(submission.headers.get('Location')).toBe('/api/events/paper_attempt_1');
    expect(PaperAnswerDraftCreatedSchema.parse(await draft.json()).created).toBe(true);
    expect(PaperSubmissionResponseSchema.parse(await submission.json()).visible_to_user).toBe(true);
  });

  it('returns 200 for an idempotently updated answer draft', async () => {
    mocks.createAnswerDraft.mockResolvedValue(
      Response.json({ answer_id: 'answer_1', created: false }),
    );

    const response = await createPaperAnswerDraftResource(
      jsonRequest({ paper_id: 'paper_1', question_id: 'q1', content_md: 'updated' }),
      { id: 'review_1' },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Location')).toBe(
      '/api/review-sessions/review_1/answer-drafts/answer_1',
    );
  });

  it('rejects missing resource identifiers before forwarding', async () => {
    const solve = await createSolveSessionResource(jsonRequest({}));
    const paper = await createPaperSubmissionResource(jsonRequest({ question_id: 'q1' }), {
      id: 'review_1',
    });

    expect(solve.status).toBe(400);
    expect(paper.status).toBe(400);
    expect(mocks.createSolveSession).not.toHaveBeenCalled();
    expect(mocks.createPaperSubmission).not.toHaveBeenCalled();
  });
});
