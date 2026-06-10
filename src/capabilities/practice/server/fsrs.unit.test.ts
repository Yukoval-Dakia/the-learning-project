import { describe, expect, it } from 'vitest';
import { scheduleReview } from './fsrs';

const NOW = new Date('2026-05-10T12:00:00Z');

describe('scheduleReview', () => {
  it('first review (prevState=null) with rating=again returns a near-future due', () => {
    const out = scheduleReview(null, 'again', NOW);
    expect(out.nextState.reps).toBeGreaterThanOrEqual(1);
    expect(out.dueAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(out.dueAt.getTime() - NOW.getTime()).toBeLessThan(2 * 24 * 60 * 60 * 1000);
  });

  it('first review with good produces a longer interval than again', () => {
    const again = scheduleReview(null, 'again', NOW);
    const good = scheduleReview(null, 'good', NOW);
    expect(good.dueAt.getTime()).toBeGreaterThan(again.dueAt.getTime());
  });

  it('first review with hard sits between again and good', () => {
    const again = scheduleReview(null, 'again', NOW);
    const hard = scheduleReview(null, 'hard', NOW);
    const good = scheduleReview(null, 'good', NOW);
    expect(hard.dueAt.getTime()).toBeGreaterThanOrEqual(again.dueAt.getTime());
    expect(hard.dueAt.getTime()).toBeLessThanOrEqual(good.dueAt.getTime());
  });

  it('again on a card in review state increments lapses', () => {
    // ts-fsrs v5 default: lapses only increment on Review->Relearning, not from short-term Learning steps,
    // so we need two 'good' reviews to graduate the card into Review state before 'again' can lapse.
    const r1 = scheduleReview(null, 'good', NOW);
    const t1 = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const r2 = scheduleReview(r1.nextState, 'good', t1);
    const t2 = new Date(t1.getTime() + 24 * 60 * 60 * 1000);
    const r3 = scheduleReview(r2.nextState, 'again', t2);
    expect(r2.nextState.state).toBe('review');
    expect(r3.nextState.lapses).toBeGreaterThan(r2.nextState.lapses);
  });

  it('good on a previously-scheduled review card progresses state forward', () => {
    const first = scheduleReview(null, 'good', NOW);
    const ONE_DAY_LATER = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const second = scheduleReview(first.nextState, 'good', ONE_DAY_LATER);
    expect(second.nextState.reps).toBeGreaterThan(first.nextState.reps);
  });

  it('handles a state round-tripped through DB JSON without breaking ts-fsrs (regression)', async () => {
    const { FsrsState } = await import('@/core/schema/business');
    const first = scheduleReview(null, 'good', NOW);
    const dbShaped = JSON.parse(JSON.stringify(first.nextState)) as unknown;
    expect(typeof (dbShaped as { due: unknown }).due).toBe('string');
    const reparsed = FsrsState.parse(dbShaped);
    expect(reparsed.due).toBeInstanceOf(Date);
    const ONE_DAY_LATER = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const second = scheduleReview(reparsed, 'good', ONE_DAY_LATER);
    expect(Number.isFinite(second.nextState.scheduled_days)).toBe(true);
    expect(Number.isFinite(second.nextState.stability)).toBe(true);
    expect(second.dueAt.getTime()).toBeGreaterThan(ONE_DAY_LATER.getTime());
  });
});
