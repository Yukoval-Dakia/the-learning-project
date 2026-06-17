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
