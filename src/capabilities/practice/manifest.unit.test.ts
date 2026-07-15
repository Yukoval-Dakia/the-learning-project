import { generateOpenApiDocument } from '@/kernel/openapi';
import { describe, expect, it } from 'vitest';
import { practiceCapability } from './manifest';

describe('practice manifest jobs', () => {
  it('registers embed_backfill nightly job staggered from other 夜链 cron slots', () => {
    const handlers = practiceCapability.jobs?.handlers ?? [];
    const job = handlers.find((j) => j.name === 'embed_backfill');
    expect(job).toBeTruthy();
    expect(job?.schedule?.cron).toBe('40 4 * * *');
    expect(job?.schedule?.tz).toBe('Asia/Shanghai');
    expect(job?.queue).toBe('llm');
    expect(typeof job?.load).toBe('function');

    // staggered: no other scheduled job shares embed_backfill's cron slot
    const crons = handlers.filter((j) => j.schedule).map((j) => j.schedule?.cron);
    const dupes = crons.filter((c) => c === job?.schedule?.cron);
    expect(dupes).toHaveLength(1);
  });

  it('registers answer_class_backfill nightly job staggered from other 夜链 cron slots', () => {
    const handlers = practiceCapability.jobs?.handlers ?? [];
    const job = handlers.find((j) => j.name === 'answer_class_backfill');
    expect(job).toBeTruthy();
    expect(job?.schedule?.cron).toBe('0 5 * * *');
    expect(job?.schedule?.tz).toBe('Asia/Shanghai');
    expect(job?.queue).toBe('llm');
    expect(typeof job?.load).toBe('function');

    const crons = handlers.filter((j) => j.schedule).map((j) => j.schedule?.cron);
    const dupes = crons.filter((c) => c === job?.schedule?.cron);
    expect(dupes).toHaveLength(1);
  });
});

describe('practice manifest API resources', () => {
  it('declares canonical paper and review-session resources alongside legacy aliases', () => {
    const routes = practiceCapability.api?.routes ?? [];
    const keys = new Set(routes.map((route) => `${route.method} ${route.path}`));

    expect(keys.has('GET /api/papers')).toBe(true);
    expect(keys.has('GET /api/papers/[id]')).toBe(true);
    expect(keys.has('POST /api/review-sessions')).toBe(true);
    expect(keys.has('GET /api/review-sessions/[id]')).toBe(true);
    expect(keys.has('GET /api/practice')).toBe(true);
    expect(keys.has('POST /api/practice')).toBe(true);
    expect(keys.has('GET /api/practice/[id]')).toBe(true);
  });

  it('declares session state and attempt resources alongside command aliases', () => {
    const routes = practiceCapability.api?.routes ?? [];
    const keys = new Set(routes.map((route) => `${route.method} ${route.path}`));

    for (const key of [
      'POST /api/attempts',
      'POST /api/appeals',
      'PATCH /api/review-sessions/[id]',
      'POST /api/review-sessions/[id]/answer-drafts',
      'POST /api/review-sessions/[id]/submissions',
      'POST /api/placement-sessions',
      'POST /api/placement-sessions/[id]/question-selections',
      'PATCH /api/placement-sessions/[id]',
      'POST /api/solve-sessions',
      'POST /api/solve-sessions/[sid]/hint-requests',
      'POST /api/solve-sessions/[sid]/submissions',
    ]) {
      expect(keys.has(key), key).toBe(true);
    }

    for (const key of [
      'POST /api/review/submit',
      'POST /api/review/appeal',
      'POST /api/review/sessions/[id]/pause',
      'POST /api/review/sessions/[id]/resume',
      'POST /api/review/sessions/[id]/end',
      'POST /api/review/sessions/[id]/reopen',
      'POST /api/placement/start',
      'POST /api/placement/[id]/next',
      'POST /api/placement/[id]/end',
    ]) {
      expect(keys.has(key), key).toBe(true);
    }
  });

  it('publishes paper write contracts with real path params, statuses and successors', () => {
    const routes = practiceCapability.api?.routes ?? [];
    const expected = new Map([
      ['POST /api/review-sessions/[id]/answer-drafts', 'createPaperAnswerDraft'],
      ['GET /api/review-sessions/[id]/answer-drafts/[answerId]', 'getPaperAnswerDraft'],
      ['POST /api/review-sessions/[id]/submissions', 'createPaperSubmission'],
      ['GET /api/practice/[id]', 'getPaperLegacy'],
      ['POST /api/practice/[id]/answer', 'createPaperAnswerDraftLegacy'],
      ['POST /api/practice/[id]/submit', 'createPaperSubmissionLegacy'],
    ]);

    const declared = routes.filter((route) => expected.has(`${route.method} ${route.path}`));
    expect(declared).toHaveLength(expected.size);
    for (const route of declared) {
      const key = `${route.method} ${route.path}`;
      expect(route.operationId, key).toBe(expected.get(key));
    }

    const document = generateOpenApiDocument([practiceCapability]) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const draftCreate = document.paths['/api/review-sessions/{id}/answer-drafts'].post;
    expect(draftCreate.responses).toEqual(
      expect.objectContaining({ 200: expect.any(Object), 201: expect.any(Object) }),
    );
    const draftRead = document.paths['/api/review-sessions/{id}/answer-drafts/{answerId}'].get;
    expect(draftRead.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id', in: 'path', required: true }),
        expect.objectContaining({ name: 'answerId', in: 'path', required: true }),
      ]),
    );
    expect(document.paths['/api/practice/{id}'].get).toMatchObject({
      deprecated: true,
      'x-successor': '/api/papers/[id]',
    });
  });

  it('publishes paper collection and review-session lifecycle compatibility contracts', () => {
    const routes = practiceCapability.api?.routes ?? [];
    const expected = new Map([
      ['GET /api/practice', 'listPapersLegacy'],
      ['POST /api/practice', 'createPaperReviewSessionLegacy'],
      ['POST /api/review/sessions', 'createReviewSessionLegacy'],
      ['POST /api/review/sessions/[id]/pause', 'pauseReviewSessionLegacy'],
      ['POST /api/review/sessions/[id]/resume', 'resumeReviewSessionLegacy'],
      ['POST /api/review/sessions/[id]/end', 'endReviewSessionLegacy'],
      ['POST /api/review/sessions/[id]/reopen', 'reopenReviewSessionLegacy'],
    ]);

    const declared = routes.filter((route) => expected.has(`${route.method} ${route.path}`));
    expect(declared).toHaveLength(expected.size);
    for (const route of declared) {
      const key = `${route.method} ${route.path}`;
      expect(route.operationId, key).toBe(expected.get(key));
      expect(route.deprecation?.successor, key).toBeTruthy();
    }

    const document = generateOpenApiDocument([practiceCapability]) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(document.paths['/api/practice'].get).toMatchObject({
      deprecated: true,
      'x-successor': '/api/papers',
      'x-pagination': { kind: 'cursor', defaultLimit: 50, maxLimit: 200 },
    });
    const end = document.paths['/api/review/sessions/{id}/end'].post;
    expect(end.requestBody).toMatchObject({ required: false });
    expect(end.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'id', in: 'path', required: true })]),
    );
    expect(end).toMatchObject({
      deprecated: true,
      'x-successor': '/api/review-sessions/[id]',
    });
  });

  it('publishes placement session, selection and profile contracts', () => {
    const routes = practiceCapability.api?.routes ?? [];
    const expected = new Map([
      ['POST /api/placement/start', 'createPlacementSessionLegacy'],
      ['POST /api/placement/[id]/next', 'createPlacementQuestionSelectionLegacy'],
      ['POST /api/placement/[id]/end', 'endPlacementSessionLegacy'],
      ['POST /api/placement-sessions', 'createPlacementSession'],
      ['POST /api/placement-sessions/[id]/question-selections', 'createPlacementQuestionSelection'],
      ['GET /api/placement-sessions/[id]', 'getPlacementSession'],
      ['PATCH /api/placement-sessions/[id]', 'updatePlacementSession'],
      ['GET /api/placement/profile', 'getPlacementProfile'],
    ]);

    const declared = routes.filter((route) => expected.has(`${route.method} ${route.path}`));
    expect(declared).toHaveLength(expected.size);
    for (const route of declared) {
      const key = `${route.method} ${route.path}`;
      expect(route.operationId, key).toBe(expected.get(key));
    }

    const document = generateOpenApiDocument([practiceCapability]) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(document.paths['/api/placement/start'].post).toMatchObject({
      deprecated: true,
      'x-successor': '/api/placement-sessions',
    });
    expect(document.paths['/api/placement/{id}/next'].post.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'id', in: 'path', required: true })]),
    );
    expect(document.paths['/api/placement/{id}/end'].post.requestBody).toMatchObject({
      required: false,
    });
    expect(document.paths['/api/placement-sessions'].post.responses).toEqual(
      expect.objectContaining({ 201: expect.any(Object) }),
    );
    expect(document.paths['/api/placement/profile'].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'goal', in: 'query', required: true }),
      ]),
    );
  });

  it('publishes practice stream read, recompose and item-update contracts', () => {
    const routes = practiceCapability.api?.routes ?? [];
    const expected = new Map([
      ['GET /api/practice/stream', 'getPracticeStream'],
      ['POST /api/practice/stream/recompose', 'recomposePracticeStream'],
      ['PATCH /api/practice/stream/items/[id]', 'updatePracticeStreamItem'],
    ]);

    const declared = routes.filter((route) => expected.has(`${route.method} ${route.path}`));
    expect(declared).toHaveLength(expected.size);
    for (const route of declared) {
      const key = `${route.method} ${route.path}`;
      expect(route.operationId, key).toBe(expected.get(key));
    }

    const document = generateOpenApiDocument([practiceCapability]) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(document.paths['/api/practice/stream'].get).toMatchObject({
      'x-pagination': 'none',
    });
    expect(document.paths['/api/practice/stream'].get.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'date', in: 'query' })]),
    );
    expect(document.paths['/api/practice/stream/recompose'].post.requestBody).toMatchObject({
      required: false,
    });
    expect(document.paths['/api/practice/stream/items/{id}'].patch.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'id', in: 'path', required: true })]),
    );
  });

  it('publishes review planning, reporting and calibration contracts', () => {
    const routes = practiceCapability.api?.routes ?? [];
    const expected = new Map([
      ['GET /api/review/due', 'listDueReviews'],
      ['POST /api/review/advice', 'previewReviewAdvice'],
      ['GET /api/review/weekly', 'getWeeklyReviewReport'],
      ['POST /api/practice/calibration/anchors', 'setPracticeCalibrationAnchors'],
    ]);

    const declared = routes.filter((route) => expected.has(`${route.method} ${route.path}`));
    expect(declared).toHaveLength(expected.size);
    for (const route of declared) {
      const key = `${route.method} ${route.path}`;
      expect(route.operationId, key).toBe(expected.get(key));
    }

    const document = generateOpenApiDocument([practiceCapability]) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(document.paths['/api/review/due'].get).toMatchObject({
      'x-pagination': 'none',
    });
    expect(document.paths['/api/review/due'].get.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'limit', in: 'query' })]),
    );
    expect(document.paths['/api/review/advice'].post.requestBody).toMatchObject({
      required: true,
    });
    const adviceResponse = document.paths['/api/review/advice'].post.responses as Record<
      string,
      { content: Record<string, { schema: Record<string, unknown> }> }
    >;
    expect(adviceResponse['200'].content['application/json'].schema).toMatchObject({
      properties: { judge: { type: 'object' } },
    });
    expect(document.paths['/api/review/weekly'].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'days', in: 'query' }),
        expect.objectContaining({ name: 'timezone', in: 'query' }),
      ]),
    );
    expect(document.paths['/api/practice/calibration/anchors'].post.requestBody).toMatchObject({
      required: true,
    });
  });
});
