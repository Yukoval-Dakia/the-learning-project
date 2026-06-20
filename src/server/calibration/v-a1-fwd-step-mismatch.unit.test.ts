// OCR finding 7 (isolated): assembleForwardClusters assumes the SRT and binary replay
// runs produce index-aligned, EQUAL-LENGTH step lists (they replay the same attempt list,
// so they must). This file mocks `./replay` to force a future divergence and asserts the
// guard fails LOUD instead of silently mis-pairing srt/binary scores.
//
// It lives in its OWN file because vi.mock('./replay') is hoisted file-wide and would
// break the real-engine end-to-end tests in v-a1-fwd.unit.test.ts.

import { describe, expect, it, vi } from 'vitest';

// Mock the replay engine so the SRT run yields 2 steps and the binary run yields 1 step
// (a deliberate length mismatch). Step contents are irrelevant — the guard fires on the
// length check before any scoring.
vi.mock('./replay', () => {
  const step = (scoredKnowledgeId: string) => ({
    eventId: 'e',
    scoredKnowledgeId,
    preAttemptEffectiveTheta: 0,
    b: 0,
    predictedP: 0.5,
    outcome: 1 as 0 | 1,
    hasRt: true,
  });
  return {
    replayTheta: (_attempts: unknown, opts: { srtEnabled: boolean }) => ({
      // SRT run: 2 steps; binary run: 1 step → mismatch.
      steps: opts.srtEnabled ? [step('kcX'), step('kcX')] : [step('kcX')],
      finalState: {},
    }),
  };
});

describe('OCR finding 7 — srt/binary step-count mismatch fails loud', () => {
  it('throws on a replay divergence instead of silently mis-pairing scores', async () => {
    const { assembleForwardClusters } = await import('./v-a1-fwd');
    type ReplayAttempt = import('./replay').ReplayAttempt;
    const attempt = {
      knowledgeIds: ['kcX'],
      scoredKnowledgeId: 'kcX',
      domainByKc: { kcX: null },
      outcome: 1 as 0 | 1,
      difficulty: 3,
      b: 0,
      bWeight: 1,
      responseTimeMs: 5000,
      createdAt: 1,
      eventId: 'e1',
    } satisfies ReplayAttempt;
    // YUK-466: assembler now takes the full ordered list (not a per-KC Map).
    expect(() => assembleForwardClusters([attempt])).toThrow(/step count mismatch|divergence/i);
  });
});
