import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildNodeThreeDim } from '@/capabilities/knowledge/ui/node-dims';
import { DAY_MS, EpochMsSchema, ScoreSchema } from '@/core/forgetting';
import { initialFsrsState } from '@/core/fsrs';
import { FsrsSnapshot } from '@/core/schema/event/state-snapshot';
import { CandidateStateSchema } from '@/core/schema/scheduling-state';
import {
  type CandidateFact,
  CandidateFactSchema,
  candidateObservations,
  candidateRetention,
  initialCandidateState,
  projectCandidateDue,
  projectDueResult,
  rebuildCandidate,
  sealCandidateFact,
} from './candidate';
import { selectedForgettingEngine } from './engine-selection';

const NOW = new Date('2026-09-26T00:00:00Z');
function fact(index: number, day: number, overrides: Partial<CandidateFact> = {}) {
  return sealCandidateFact({
    submissionId: `submission_${index}`,
    evaluationId: `judgment_${index}`,
    occurredAt: new Date(NOW.getTime() + day * DAY_MS),
    revisionId: 'published-rubric-7',
    context: 'algebra:constructed_response',
    source: 'judged',
    judgment: 'admitted',
    judgeRevision: 'executor-v3:rubric-v7',
    help: 'none',
    guess: 'no',
    confidence: 'high',
    hints_used: 0,
    final_hint_level: 0,
    self_confidence: 4,
    latency_ms: 182731,
    points: [
      {
        maximum: 8,
        earned: 6,
        shares: [
          { skillId: 'factorization', share: 0.6 },
          { skillId: 'substitution-check', share: 0.3 },
        ],
      },
    ],
    ...overrides,
  });
}
describe('candidate integration input and projection contracts', () => {
  afterEach(() => vi.unstubAllEnvs());
  // @invariant data: only sealed canonical facts enter digests and projected adapter evidence stays exactly reproducible
  // @fails-if digest includes float outputs, capture modifiers disappear, or unattributed score mass is silently discarded
  it('seals continuous mapped scores, exclusions, stable time keys and realistic capture modifiers', () => {
    const first = fact(1, 0);
    expect(candidateObservations(first)).toMatchObject([
      { kind: 'included', observation: { quality: 0.75, weight: 0.6, independent: true } },
      { kind: 'included', observation: { quality: 0.75, weight: 0.3, independent: true } },
      {
        kind: 'excluded',
        reason: 'unattributed_scoring',
        evidenceRefs: ['submission_1', 'judgment_1', 'published-rubric-7'],
      },
    ]);
    expect(sealCandidateFact(JSON.parse(JSON.stringify(first.fact)))).toEqual(first);
    expect(
      sealCandidateFact({ ...first.fact, occurredAt: new Date('2026-09-26T09:00:00+09:00') }),
    ).toEqual(first);
    expect(fact(1, 0, { confidence: 'low', self_confidence: 1 }).evidenceDigest).not.toBe(
      first.evidenceDigest,
    );
    expect(first.orderKey < fact(2, 0).orderKey).toBe(true);
    expect(first.recordedSequence).toBe(NOW.getTime());
    expect(
      candidateObservations(
        fact(3, 0, {
          help: 'deep',
          hints_used: 2,
          final_hint_level: 2,
          confidence: 'low',
          guess: 'yes',
        }),
      ),
    ).toMatchObject([
      { kind: 'included', observation: { independent: false } },
      { kind: 'included', observation: { independent: false } },
      { kind: 'excluded', reason: 'unattributed_scoring' },
    ]);
  });
  // @invariant grading: deterministic resolved replay handles duplicates and future cutoffs without any clock or provider
  // @fails-if duplicates add learning gain, reverse arrival changes the result, or a future observation leaks into an earlier projection
  it('rebuilds both global and nested contexts from unique facts in stable order', () => {
    const facts = [
      fact(1, 0),
      fact(2, 3),
      fact(3, 17, {
        points: [{ maximum: 8, earned: 0, shares: [{ skillId: 'factorization', share: 1 }] }],
      }),
    ];
    const end = new Date(NOW.getTime() + 17 * DAY_MS);
    const forward = rebuildCandidate('factorization', facts, end, 'native');
    expect(
      rebuildCandidate('factorization', [facts[2], facts[1], facts[0], facts[0]], end, 'native'),
    ).toEqual(forward);
    expect(Object.keys(forward.contexts)).toEqual(['algebra:constructed_response']);
    expect(forward.global.projection).toMatchObject({ eventCount: 3 });
    expect(rebuildCandidate('factorization', facts, NOW, 'native').global.projection).toMatchObject(
      { eventCount: 1 },
    );
    expect(() =>
      rebuildCandidate(
        'factorization',
        [facts[0], fact(1, 0, { confidence: 'low' })],
        NOW,
        'native',
      ),
    ).toThrow('attempt conflict');
    expect(() =>
      rebuildCandidate(
        'factorization',
        [{ ...facts[0], recordedSequence: NOW.getTime() + 1 }],
        NOW,
        'native',
      ),
    ).toThrow('receipt mismatch');
  });
  // @invariant grading: each due kind projects to a non-null timestamp with an observable kind and deterministic model-free fallback
  // @fails-if beyond-horizon becomes immediate, unknown/invalid rows disappear, or fallback uses wall-clock time
  it('projects all due kinds and carries unknown retention instead of zero', () => {
    const at = EpochMsSchema.parse(NOW.getTime());
    const cap = EpochMsSchema.parse(NOW.getTime() + 365 * DAY_MS);
    const target = ScoreSchema.parse(0.6);
    expect(projectDueResult({ kind: 'due_now', at, target }, NOW).due).toEqual(NOW);
    expect(projectDueResult({ kind: 'scheduled', at, target, toleranceMs: 1000 }, NOW).due).toEqual(
      NOW,
    );
    expect(
      projectDueResult(
        { kind: 'beyond_horizon', checkedThrough: cap, scoreThere: ScoreSchema.parse(0.8) },
        NOW,
      ),
    ).toMatchObject({ due: new Date(cap), dueKind: 'beyond_horizon', fallbackReason: null });
    for (const kind of ['unknown', 'invalid_input'] as const) {
      const projected = projectDueResult({ kind, reason: 'synthetic-unavailable-state' }, NOW);
      expect(projected.due.getTime()).toBeGreaterThan(NOW.getTime());
      expect(projectDueResult({ kind, reason: 'synthetic-unavailable-state' }, NOW)).toEqual(
        projected,
      );
      expect(projected).toMatchObject({
        dueKind: kind,
        fallbackReason: 'synthetic-unavailable-state',
      });
    }
    const cold = initialCandidateState('factorization', NOW);
    expect(candidateRetention(cold, NOW).now).toMatchObject({ kind: 'unknown', reason: 'cold' });
    expect(projectCandidateDue(cold, NOW)).toMatchObject({
      dueKind: 'unknown',
      fallbackReason: 'cold',
    });
    const warm = rebuildCandidate(
      'factorization',
      [fact(1, 0), fact(2, 3)],
      new Date(NOW.getTime() + 3 * DAY_MS),
      'native',
    );
    expect(candidateRetention(warm, NOW).now).toMatchObject({
      kind: 'unknown',
      reason: 'invalid_time',
    });
    expect(candidateRetention(warm, new Date(NOW.getTime() + 4 * DAY_MS)).now).toMatchObject({
      kind: 'score',
      calibration: 'uncalibrated',
    });
    const wrongVersion = {
      ...warm,
      global: { ...warm.global, versions: { ...warm.global.versions, parameters: 'unregistered' } },
    };
    expect(
      projectCandidateDue(
        CandidateStateSchema.parse(wrongVersion),
        new Date(NOW.getTime() + 4 * DAY_MS),
      ),
    ).toMatchObject({ dueKind: 'unknown', fallbackReason: 'version_mismatch' });
  });
  // @invariant data: historical untagged cards and candidate states coexist inside a JSON-roundtrip-safe snapshot bracket
  // @fails-if adding the engine discriminator makes old before snapshots unreadable or candidate contexts disappear
  it('accepts mixed-version brackets while selecting only one server engine', () => {
    vi.stubEnv('FORGETTING_ENGINE', 'fsrs');
    expect(selectedForgettingEngine()).toBe('fsrs');
    const before = initialFsrsState(NOW).state;
    const after = rebuildCandidate('factorization', [fact(1, 0)], NOW, 'legacy_cold');
    expect(
      FsrsSnapshot.parse(
        JSON.parse(
          JSON.stringify({ subject_kind: 'knowledge', subject_id: 'factorization', before, after }),
        ),
      ),
    ).toEqual({ subject_kind: 'knowledge', subject_id: 'factorization', before, after });
    vi.stubEnv('FORGETTING_ENGINE', 'forgetting_candidate');
    expect(selectedForgettingEngine()).toBe('forgetting_candidate');
    expect(
      CandidateFactSchema.safeParse({ ...fact(1, 0).fact, sleep_hours: 8, ranking: 1 }).success,
    ).toBe(false);
    for (const source of ['reading', 'conversation', 'agent_explanation'])
      expect(CandidateFactSchema.safeParse({ ...fact(1, 0).fact, source }).success).toBe(false);
  });
  // @invariant grading: learner retention stays unknown or explicitly uncalibrated engineering evidence
  // @fails-if the numeric display renders unknown as band zero or assigns engineering scores a calibrated hard source
  it('carries uncertainty through the learner retention reader', () => {
    const input = { mastery: null, beta: null, difficultyAnchored: false, evidenceCount: 0 };
    const unknown = buildNodeThreeDim({
      ...input,
      retrievability: 0,
      retention: { kind: 'unknown', calibration: 'uncalibrated', provenance: 'engineering' },
    }).dims[0];
    expect(unknown.view).toMatchObject({ unknown: true, source: 'soft', lowConf: true });
    expect(unknown.note).toContain('未知');
    expect(unknown.note).toContain('尚未校准');
    const score = buildNodeThreeDim({
      ...input,
      retrievability: 0.75,
      retention: { kind: 'score', calibration: 'uncalibrated', provenance: 'engineering' },
    }).dims[0];
    expect(score.view).toMatchObject({ unknown: false, source: 'soft', lowConf: true });
    expect(score.note).toContain('工程估计');
  });
});
