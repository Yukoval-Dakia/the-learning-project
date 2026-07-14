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
    for (const mock of [
      mocks.createAnswerDraft,
      mocks.createPaperSubmission,
      mocks.createHintRequest,
      mocks.createSolveSession,
      mocks.createSolveSubmission,
    ]) {
      mock.mockResolvedValue(Response.json({ ok: true }));
    }
  });

  it('binds solve session creation to question_id', async () => {
    const response = await createSolveSessionResource(
      jsonRequest({ question_id: 'q1', regenerate: true }),
    );

    expect(response.status).toBe(200);
    expect(mocks.createSolveSession.mock.calls[0]?.[1]).toEqual({ id: 'q1' });
    expect(await capturedBody(mocks.createSolveSession)).toEqual({ regenerate: true });
  });

  it('binds hint and solve submissions to the solve session resource', async () => {
    await createHintRequestResource(jsonRequest({ question_id: 'q1', hint_index: 2 }), {
      sid: 'solve_1',
    });
    await createSolveSubmissionResource(
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
  });

  it('uses the review session path as the authority for paper writes', async () => {
    await createPaperAnswerDraftResource(
      jsonRequest({ paper_id: 'paper_1', question_id: 'q1', content_md: 'draft' }),
      { id: 'review_1' },
    );
    await createPaperSubmissionResource(
      jsonRequest({ paper_id: 'paper_1', question_id: 'q1', answer_md: 'answer' }),
      { id: 'review_1' },
    );

    expect(mocks.createAnswerDraft.mock.calls[0]?.[1]).toEqual({ id: 'paper_1' });
    expect(await capturedBody(mocks.createAnswerDraft)).toEqual({
      question_id: 'q1',
      content_md: 'draft',
      session_id: 'review_1',
    });
    expect(mocks.createPaperSubmission.mock.calls[0]?.[1]).toEqual({ id: 'paper_1' });
    expect(await capturedBody(mocks.createPaperSubmission)).toEqual({
      question_id: 'q1',
      answer_md: 'answer',
      session_id: 'review_1',
    });
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
