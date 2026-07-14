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
});
