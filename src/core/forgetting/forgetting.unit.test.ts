import { describe, expect, it } from 'vitest';
import {
  type AppendReceipt,
  ContextKeySchema,
  DAY_MS,
  DigestSchema,
  ENGINEERING_MODEL,
  type EffectiveObservation,
  EpochMsSchema,
  type EvidenceInput,
  type Evolution,
  FractionSchema,
  LearnerIdSchema,
  type MemoryState,
  type MemoryView,
  type Scope,
  ScoreSchema,
  SequenceKeySchema,
  SkillIdSchema,
  VERSIONS,
  VersionSchema,
  adaptEvidence,
  applyUserCorrection,
  arrange,
  coldState,
  due,
  evolve,
  fallbackSchedule,
  replay,
  retention,
  sortSchedules,
  weakestRequiredSkillScore,
} from './index';
import oracle from './numeric-oracle.fixture.json';

const ORIGIN = 1_792_000_000_000;
const learnerId = LearnerIdSchema.parse('learner-synthetic-continuous-learning');
const skillId = SkillIdSchema.parse('math:quadratic-equations:reasoning');
const time = (day: number) => EpochMsSchema.parse(ORIGIN + day * DAY_MS);
const digest = (value: string) => DigestSchema.parse(value);
const key = (n: number) => SequenceKeySchema.parse(String(n).padStart(8, '0'));
const initial = (scope: Scope = { kind: 'global' }): MemoryState =>
  coldState({
    learnerId,
    skillId,
    scope,
    versions: VERSIONS,
    inputDigest: digest('empty-effective-input'),
  });
const view = (global: MemoryState): MemoryView => ({
  global,
  context: { kind: 'unknown', reason: 'no_context_projection' },
  requestedScope: { kind: 'global' },
});
function updated(result: Evolution): MemoryState {
  if (result.kind !== 'updated' && result.kind !== 'duplicate')
    throw new Error(JSON.stringify(result));
  return result.state;
}
function observation(n: number, day: number, quality = 1, weight = 1): EffectiveObservation {
  return {
    learnerId,
    skillId,
    attemptId: `attempt-${n}`,
    effectiveJudgmentId: `judgment-${n}:admission-r7`,
    context: { kind: 'known', value: ContextKeySchema.parse('algebra:constructed-response') },
    occurredAt: time(day),
    orderKey: key(n),
    evidenceDigest: digest(`immutable-fact-${n}`),
    quality: FractionSchema.parse(quality),
    weight: FractionSchema.parse(weight),
    independent: true,
    mappingNotes: [],
    evidenceRefs: [
      `event:attempt-${n}:original`,
      `judgment:${n}:score-leaves`,
      'rubric:r7:derive-discriminant-and-explain-double-root',
    ],
  };
}
function append(state: MemoryState, o: EffectiveObservation) {
  const receipt: AppendReceipt = {
    previousInputDigest: state.inputDigest,
    nextInputDigest: digest(`${state.inputDigest}|${o.evidenceDigest}`),
    nextThrough: o.orderKey,
  };
  return { receipt, result: evolve({ state, observation: o, receipt, model: ENGINEERING_MODEL }) };
}
function read(state: MemoryState, day: number) {
  return retention({
    view: view(state),
    asOf: time(day),
    offsetsDays: [],
    model: ENGINEERING_MODEL,
  }).now;
}
function value(state: MemoryState, day: number): number {
  const result = read(state, day);
  if (result.kind !== 'score') throw new Error(result.reason);
  return result.value;
}
function history(mode: 'original' | 'corrected' | 'withdrawn' = 'original', queryDay = 180) {
  let state = initial();
  const effective: {
    observation: EffectiveObservation;
    recordedSequence: number;
    receipt: AppendReceipt;
  }[] = [];
  for (const [index, event] of oracle.events.entries()) {
    if (
      event.status !== 'applied' ||
      Number(event.day) > queryDay ||
      (mode === 'withdrawn' && event.id === 'e12')
    )
      continue;
    const o = {
      ...observation(
        index + 1,
        Number(event.day),
        mode === 'corrected' && event.id === 'e12' ? 1 : Number(event.quality),
        Number(event.rho),
      ),
      independent: event.independent,
      context: { kind: 'known' as const, value: ContextKeySchema.parse(event.context) },
      evidenceDigest: digest(
        `${event.id}:${mode === 'corrected' && event.id === 'e12' ? 'corrected' : 'original'}`,
      ),
    };
    const next = append(state, o);
    state = updated(next.result);
    effective.push({ observation: o, recordedSequence: index + 1, receipt: next.receipt });
  }
  return { state, effective };
}
const constraints = {
  lastCompletedAt: { kind: 'unknown' as const, reason: 'none' },
  explicitUserNotBefore: { kind: 'unknown' as const, reason: 'none' },
};
function evidence(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  const o = observation(1, 0);
  return {
    identity: o,
    occurredAt: { kind: 'known', value: o.occurredAt },
    source: 'judged',
    judgment: 'admitted',
    judgeRevision: { kind: 'known', value: 'executor-r7:rubric-r5:admission-r3' },
    help: 'none',
    guess: 'no',
    confidence: 'medium',
    duration: { kind: 'known', value: 178_934 },
    processEvidenceRefs: ['process:sign-error-corrected-before-final-answer'],
    scoring: { kind: 'single_skill', skillId, maximum: 20, earned: 20 },
    ...overrides,
  };
}

describe('deterministic forgetting and scheduling invariants', () => {
  // @invariant grading: user self-ratings remain weak non-independent memory evidence
  // @fails-if self-report is dropped, receives judged weight, or contributes independent evidence
  it('admits self-report separately from judged and excludes unknown help', () => {
    expect(adaptEvidence(evidence({ source: 'self_report' }))).toMatchObject([
      {
        kind: 'included',
        observation: {
          quality: 1,
          weight: 0.1,
          independent: false,
          mappingNotes: expect.arrayContaining(['source:self_report']),
        },
      },
    ]);
    expect(adaptEvidence(evidence({ source: 'self_report', help: 'unknown' }))).toMatchObject([
      { kind: 'excluded', reason: 'help_unknown' },
    ]);
  });

  // @invariant grading: effective facts always produce the same score and preserve sealed historical inputs
  // @fails-if replay injects twice, uses arrival order, mutates input, or uses current wall-clock time
  it('recomputes the 25-review history deterministically from shuffled immutable facts', () => {
    const h = history();
    const before = JSON.stringify(h);
    const input = {
      seed: initial(),
      effective: h.effective.toReversed(),
      queryTime: time(180),
      knowledgeCutoff: 25,
      model: ENGINEERING_MODEL,
    };
    expect(updated(replay(input))).toEqual(h.state);
    expect(updated(replay(input))).toEqual(updated(replay(input)));
    expect(JSON.stringify(h)).toBe(before);
    expect(value(h.state, 180)).toBeCloseTo(0.824343379626745, 12);
    for (const event of oracle.events.filter((e) => e.status === 'applied')) {
      expect(value(history('original', Number(event.day)).state, Number(event.day))).toBeCloseTo(
        Number(event.score),
        12,
      );
    }
  });

  // @invariant grading: elapsed time alone cannot increase retention or leak future evidence
  // @fails-if a read updates lastAt, clamps negative elapsed time, or uses a non-monotonic time window
  it('decays monotonically through long horizons without changing the projection', () => {
    const state = history().state;
    const before = JSON.stringify(state);
    const r = retention({
      view: view(state),
      asOf: time(180),
      offsetsDays: [30, 1, 7, 365, 36500],
      model: ENGINEERING_MODEL,
    });
    expect(r.future.map((p) => (p.kind === 'score' ? p.value : null))).toEqual(
      expect.arrayContaining([
        expect.closeTo(0.277098991546349, 12),
        expect.closeTo(0.756757170320064, 12),
        expect.closeTo(0.549644693888944, 12),
      ]),
    );
    let previous = value(state, 180);
    for (const day of [180 + 1 / DAY_MS, 181, 187, 210, 545, 36680]) {
      const next = value(state, day);
      expect(next).toBeLessThanOrEqual(previous);
      previous = next;
    }
    expect(previous).toBe(0);
    expect(read(state, 179)).toMatchObject({ kind: 'unknown', reason: 'invalid_time' });
    expect(
      retention({
        view: view(state),
        asOf: time(179),
        offsetsDays: [1, 7],
        model: ENGINEERING_MODEL,
      }).future.every((p) => p.kind === 'unknown'),
    ).toBe(true);
    expect(JSON.stringify(state)).toBe(before);
  });

  // @invariant grading: due must be on or after the first target crossing within one second
  // @fails-if the solver chooses its left endpoint, solves a different score, or treats horizon as the root
  it('matches the independent 180-day oracle and brackets the score crossing', () => {
    const state = history().state;
    const result = due({
      view: view(state),
      asOf: time(180),
      target: ScoreSchema.parse(0.6),
      horizonAt: time(545),
      model: ENGINEERING_MODEL,
    });
    expect(result.kind).toBe('scheduled');
    if (result.kind !== 'scheduled') throw new Error(JSON.stringify(result));
    const crossing = ORIGIN + Number('184.42168371994243') * DAY_MS;
    expect(result.at).toBeGreaterThanOrEqual(crossing);
    expect(result.at - crossing).toBeLessThanOrEqual(1000);
    expect(value(state, (result.at - ORIGIN) / DAY_MS)).toBeLessThanOrEqual(0.6);
    expect(value(state, (result.at - ORIGIN - 1000) / DAY_MS)).toBeGreaterThan(0.6);
    expect(
      due({
        view: view(state),
        asOf: time(180),
        target: ScoreSchema.parse(0.6),
        horizonAt: time(181),
        model: ENGINEERING_MODEL,
      }),
    ).toMatchObject({
      kind: 'beyond_horizon',
      checkedThrough: time(181),
      scoreThere: expect.closeTo(0.756757170320064, 12),
    });
    expect(
      due({
        view: view(state),
        asOf: time(210),
        target: ScoreSchema.parse(0.6),
        horizonAt: time(545),
        model: ENGINEERING_MODEL,
      }),
    ).toMatchObject({ kind: 'due_now', at: time(210) });
  });

  // @invariant grading: correcting or withdrawing an old failure must replay subsequent spacing without rewriting sealed history
  // @fails-if correction subtracts a contribution, withdrawal retains the old interval, or replay consumes duplicate attempts twice
  it('replays correction, withdrawal, duplicate receipts and both knowledge clocks idempotently', () => {
    const original = history();
    const sealed = JSON.stringify(original.state);
    const corrected = history('corrected');
    const withdrawn = history('withdrawn');
    expect(value(corrected.state, 180)).toBeCloseTo(0.8243599673615414, 12);
    expect(value(withdrawn.state, 180)).toBeCloseTo(0.8243484942190032, 12);
    for (const h of [original, corrected, withdrawn]) {
      const repeated = [...h.effective, ...h.effective];
      expect(
        updated(
          replay({
            seed: initial(),
            effective: repeated,
            queryTime: time(180),
            knowledgeCutoff: 100,
            model: ENGINEERING_MODEL,
          }),
        ),
      ).toEqual(h.state);
    }
    const early = history('original', 30);
    expect(
      updated(
        replay({
          seed: initial(),
          effective: original.effective,
          queryTime: time(30),
          knowledgeCutoff: 25,
          model: ENGINEERING_MODEL,
        }),
      ),
    ).toEqual(early.state);
    expect(
      updated(
        replay({
          seed: initial(),
          effective: original.effective,
          queryTime: time(180),
          knowledgeCutoff: 8,
          model: ENGINEERING_MODEL,
        }),
      ),
    ).toEqual(history('original', 21).state);

    // Late knowledge about an old event cannot enter an earlier knowledge cutoff.
    const late = original.effective.map((e) =>
      e.observation.attemptId === 'attempt-12' ? { ...e, recordedSequence: 99 } : e,
    );
    expect(
      replay({
        seed: initial(),
        effective: late,
        queryTime: time(180),
        knowledgeCutoff: 25,
        model: ENGINEERING_MODEL,
      }),
    ).toMatchObject({ kind: 'rebuild_required', reason: 'digest_mismatch' });
    // Canonical receipts regenerated for the selected history recover the same withdrawn projection.
    const selected = [...withdrawn.effective, ...late.filter((e) => e.recordedSequence === 99)];
    expect(
      updated(
        replay({
          seed: initial(),
          effective: selected,
          queryTime: time(180),
          knowledgeCutoff: 25,
          model: ENGINEERING_MODEL,
        }),
      ),
    ).toEqual(withdrawn.state);
    expect(JSON.stringify(original.state)).toBe(sealed);
    const o = observation(1, 0);
    const a = append(initial(), o);
    const state = updated(a.result);
    expect(evolve({ state, observation: o, receipt: a.receipt, model: ENGINEERING_MODEL })).toEqual(
      { kind: 'duplicate', state },
    );
    expect(
      evolve({
        state,
        observation: { ...o, quality: FractionSchema.parse(0) },
        receipt: a.receipt,
        model: ENGINEERING_MODEL,
      }),
    ).toMatchObject({ kind: 'rebuild_required', reason: 'conflict' });
    expect(
      evolve({
        state,
        observation: observation(2, 1),
        receipt: { ...a.receipt, nextThrough: key(2), nextInputDigest: digest('new') },
        model: ENGINEERING_MODEL,
      }),
    ).toMatchObject({ kind: 'rebuild_required', reason: 'digest_mismatch' });
    expect(append(state, o).result).toMatchObject({
      kind: 'rebuild_required',
      reason: 'old_order_key',
    });
  });

  // @invariant grading: missing evidence, known failure and cold state have distinct scheduling meanings
  // @fails-if missing help becomes a failure, cold becomes zero, or same-time repeats gain full success evidence
  it('distinguishes cold, excluded evidence, full failure and same-time brushing', () => {
    expect(read(initial(), 0)).toMatchObject({ kind: 'unknown', reason: 'cold' });
    const first = updated(append(initial(), observation(1, 0)).result);
    expect(first.projection).toMatchObject({ fast: 3, slow: 1, independentMass: 1 });
    expect(value(first, 0)).toBe(0.8);
    expect(value(first, 1)).toBeCloseTo(0.710287277505435, 12);
    const failure = updated(append(first, observation(2, 0, 0)).result);
    expect(failure.projection).toMatchObject({ fast: 1.5, slow: 0.5 });
    expect(value(failure, 0)).toBeCloseTo(2 / 3, 12);
    const zero = updated(append(initial(), observation(1, 0, 0)).result);
    expect(read(zero, 0)).toMatchObject({ kind: 'score', value: 0 });
    expect(adaptEvidence(evidence({ help: 'unknown' }))).toMatchObject([
      { kind: 'excluded', reason: 'help_unknown' },
    ]);
    expect(adaptEvidence(evidence({ source: 'reading' }))).toMatchObject([
      { kind: 'excluded', reason: 'separate_evidence' },
    ]);
    const brush = updated(append(first, observation(2, 0)).result);
    expect(value(brush, 0)).toBe(0.8);
    const tiny = updated(append(first, observation(2, 1 / DAY_MS)).result);
    expect(value(tiny, 0 + 1 / DAY_MS) - 0.8).toBeLessThan(1e-7);
    expect(value(updated(append(first, observation(2, 1000)).result), 1000)).toBeLessThanOrEqual(
      0.80000000000001,
    );
  });

  // @invariant grading: one answer's score-leaf budget cannot create full success in every skill
  // @fails-if quality is averaged across skills, shared leaves are duplicated, or help and guess discounts are skipped
  it('maps nested score leaves per skill and excludes unavailable or invalid evidence', () => {
    const other = SkillIdSchema.parse('math:graph:intersection-explanation');
    const mapped = adaptEvidence(
      evidence({
        scoring: {
          kind: 'mapped',
          points: [
            { maximum: 8, earned: 8, shares: [{ skillId, share: 1 }] },
            { maximum: 2, earned: 2, shares: [{ skillId, share: 1 }] },
            { maximum: 7, earned: 0, shares: [{ skillId: other, share: 1 }] },
            { maximum: 3, earned: 0, shares: [{ skillId: other, share: 1 }] },
          ],
        },
      }),
    );
    expect(
      mapped.map((p) =>
        p.kind === 'included'
          ? [p.observation.skillId, p.observation.quality, p.observation.weight]
          : p.reason,
      ),
    ).toEqual([
      [skillId, 1, 0.5],
      [other, 0, 0.5],
    ]);
    const mixed = adaptEvidence(evidence({ help: 'shallow', guess: 'yes', confidence: 'low' }));
    expect(mixed).toMatchObject([
      { kind: 'included', observation: { weight: 0.0625, independent: false } },
    ]);
    expect(adaptEvidence(evidence({ help: 'deep' }))).toMatchObject([
      { observation: { weight: 0.25, independent: false } },
    ]);
    expect(adaptEvidence(evidence({ help: 'answer' }))).toMatchObject([
      { observation: { weight: 0.1, independent: false } },
    ]);
    expect(adaptEvidence(evidence({ guess: 'unknown', confidence: 'unknown' }))).toMatchObject([
      { observation: { weight: 0.5, independent: false } },
    ]);
    expect(
      adaptEvidence(
        evidence({ confidence: 'unknown', duration: { kind: 'unknown', reason: 'not_measured' } }),
      ),
    ).toMatchObject([{ observation: { weight: 1, quality: 1, independent: true } }]);
    for (const judgment of ['unadmitted', 'withdrawn', 'unknown'] as const)
      expect(adaptEvidence(evidence({ judgment }))).toMatchObject([
        { kind: 'excluded', reason: 'judgment_not_admitted' },
      ]);
    expect(
      adaptEvidence(evidence({ occurredAt: { kind: 'unknown', reason: 'no_original_time' } })),
    ).toMatchObject([{ reason: 'missing_occurrence_time' }]);
    expect(
      adaptEvidence(evidence({ scoring: { kind: 'unattributed_multi_skill' } })),
    ).toMatchObject([{ reason: 'unattributed_multi_skill' }]);
    expect(
      adaptEvidence(
        evidence({
          scoring: {
            kind: 'mapped',
            points: [
              {
                maximum: 10,
                earned: 5,
                shares: [
                  { skillId, share: 1 },
                  { skillId: other, share: 1 },
                ],
              },
            ],
          },
        }),
      ),
    ).toMatchObject([{ reason: 'overallocated_mapping' }]);
    expect(
      adaptEvidence(
        evidence({
          scoring: {
            kind: 'mapped',
            points: [{ maximum: 10, earned: 5, shares: [{ skillId, share: 0.6 }] }],
          },
        }),
      ),
    ).toMatchObject([
      { observation: { quality: 0.5, weight: 0.6 } },
      { reason: 'unattributed_scoring' },
    ]);
  });

  // @invariant grading: context evidence is shrunk toward global and cannot be added as a second independent history
  // @fails-if global and context masses are added, context identity is ignored, or unknown required skills become zero
  it('matches the context oracle, borrows absent contexts and rejects cross-identity mixing', () => {
    const a = observation(1, 0);
    const b = {
      ...observation(2, 1),
      context: { kind: 'known' as const, value: ContextKeySchema.parse('graph') },
    };
    const global = updated(append(updated(append(initial(), a).result), b).result);
    const context = updated(append(initial({ kind: 'context', key: b.context.value }), b).result);
    const v: MemoryView = {
      global,
      context: { kind: 'known', value: context },
      requestedScope: context.scope,
    };
    const r = retention({
      view: v,
      asOf: time(1),
      offsetsDays: [1, 7, 30],
      model: ENGINEERING_MODEL,
    });
    expect(r.now).toMatchObject({
      kind: 'score',
      value: expect.closeTo(0.8271135087199277, 12),
      scope: 'context_shrunk',
    });
    let prev = 1;
    for (const p of [r.now, ...r.future]) {
      if (p.kind !== 'score') throw new Error(p.reason);
      expect(p.value).toBeLessThanOrEqual(prev);
      prev = p.value;
    }
    expect(
      retention({
        view: { ...v, context: { kind: 'unknown', reason: 'absent' } },
        asOf: time(1),
        offsetsDays: [],
        model: ENGINEERING_MODEL,
      }).now,
    ).toMatchObject({ kind: 'score', scope: 'global_borrowed' });
    expect(
      retention({
        view: {
          ...v,
          context: {
            kind: 'known',
            value: { ...context, learnerId: LearnerIdSchema.parse('other') },
          },
        },
        asOf: time(1),
        offsetsDays: [],
        model: ENGINEERING_MODEL,
      }).now,
    ).toMatchObject({ kind: 'unknown', reason: 'scope_mismatch' });
    expect(
      evolve({
        state: initial({ kind: 'context', key: ContextKeySchema.parse('different') }),
        observation: b,
        receipt: {
          previousInputDigest: initial().inputDigest,
          nextInputDigest: digest('b'),
          nextThrough: b.orderKey,
        },
        model: ENGINEERING_MODEL,
      }),
    ).toMatchObject({ kind: 'invalid', reason: 'scope_mismatch' });
    expect(
      weakestRequiredSkillScore([
        { kind: 'known', value: ScoreSchema.parse(0.8) },
        { kind: 'unknown', reason: 'cold' },
      ]),
    ).toEqual({ kind: 'unknown', reason: 'cold' });
    expect(
      weakestRequiredSkillScore([
        { kind: 'known', value: ScoreSchema.parse(0.8) },
        { kind: 'known', value: ScoreSchema.parse(0.2) },
      ]),
    ).toMatchObject({ kind: 'known', value: 0.2 });
  });

  // @invariant grading: invalid numbers, unsafe times and parameter changes never become successful schedules or full scores
  // @fails-if invalid input is clamped, old parameters reuse u, or huge timestamps overflow to dates
  it('fails explicitly on incompatible versions, invalid states and time arithmetic', () => {
    const state = history().state;
    const args = {
      view: view(state),
      asOf: time(180),
      target: ScoreSchema.parse(0.6),
      horizonAt: time(545),
      model: ENGINEERING_MODEL,
    };
    const missingModel = { ...args };
    Reflect.set(missingModel, 'model', null);
    expect(due(missingModel)).toMatchObject({ kind: 'unknown', reason: 'version_mismatch' });
    expect(retention({ ...missingModel, offsetsDays: [1] }).now).toMatchObject({
      kind: 'unknown',
      reason: 'version_mismatch',
    });
    const missingState = { ...args, view: { ...args.view } };
    Reflect.set(missingState.view, 'global', null);
    expect(due(missingState)).toMatchObject({ kind: 'unknown', reason: 'missing_state' });
    for (const target of [0, 1, NaN, Infinity]) {
      const invalid = { ...args };
      Reflect.set(invalid, 'target', target);
      expect(due(invalid)).toMatchObject({ kind: 'invalid_input' });
    }
    expect(due({ ...args, horizonAt: time(179) })).toMatchObject({ kind: 'invalid_input' });
    expect(due({ ...args, asOf: time(179) })).toMatchObject({ kind: 'invalid_input' });
    for (const fast of [-1, NaN, Infinity]) {
      if (state.projection.kind !== 'warm') throw new Error('fixture');
      expect(
        due({ ...args, view: view({ ...state, projection: { ...state.projection, fast } }) }),
      ).toMatchObject({ kind: 'invalid_input' });
    }
    expect(due({ ...args, model: { ...ENGINEERING_MODEL, slowHalfLifeDays: 15 } })).toMatchObject({
      kind: 'invalid_input',
      reason: 'invalid_model',
    });
    const old = {
      ...state,
      versions: { ...VERSIONS, parameters: VersionSchema.parse('future-v2') },
    };
    expect(append(old, observation(26, 181)).result).toMatchObject({
      kind: 'rebuild_required',
      reason: 'version_mismatch',
    });
    expect(due({ ...args, view: view(old) })).toMatchObject({
      kind: 'unknown',
      reason: 'version_mismatch',
    });
    const offsets = retention({
      view: view(state),
      asOf: time(180),
      offsetsDays: [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER, 1],
      model: ENGINEERING_MODEL,
    });
    expect(offsets.future.map((p) => p.kind)).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'score',
    ]);
    expect(append(state, observation(26, 170)).result).toMatchObject({
      kind: 'invalid',
      reason: 'invalid_time',
    });
    if (state.projection.kind !== 'warm') throw new Error('fixture');
    const full = {
      ...state,
      projection: { ...state.projection, independentMass: Number.MAX_SAFE_INTEGER },
    };
    expect(append(full, observation(26, 181)).result).toMatchObject({
      kind: 'invalid',
      reason: 'numeric_range',
    });
    expect(
      append(
        { ...state, projection: { ...state.projection, eventCount: Number.MAX_SAFE_INTEGER } },
        observation(26, 181),
      ).result,
    ).toMatchObject({ kind: 'invalid', reason: 'numeric_range' });
  });

  // @invariant grading: model failure still produces a deterministic next check and preserves user cooldown constraints
  // @fails-if fallback reads a model, overwrites modelDue, ignores notBefore, or uses receivedAt as completion
  it('schedules without any model and keeps model due distinct from execution eligibility', () => {
    expect(fallbackSchedule({ asOf: time(180), constraints })).toMatchObject({
      kind: 'eligible',
      eligibleAt: time(180),
    });
    const recent = {
      lastCompletedAt: { kind: 'known' as const, value: time(179.5) },
      explicitUserNotBefore: { kind: 'known' as const, value: time(183) },
    };
    expect(fallbackSchedule({ asOf: time(180), constraints: recent })).toMatchObject({
      kind: 'eligible',
      eligibleAt: time(183),
      appliedConstraints: ['cooldown', 'user_not_before'],
    });
    const modelDue = { kind: 'due_now' as const, at: time(180), target: ScoreSchema.parse(0.6) };
    expect(
      arrange({
        asOf: time(180),
        modelDue,
        constraints: { ...recent, explicitUserNotBefore: constraints.explicitUserNotBefore },
      }),
    ).toMatchObject({ kind: 'eligible', eligibleAt: time(180.5), modelDue });
    expect(
      arrange({
        asOf: time(180),
        modelDue: { kind: 'unknown', reason: 'cannot_decode_model' },
        constraints: recent,
      }),
    ).toMatchObject({ kind: 'eligible', eligibleAt: time(183) });
    expect(
      fallbackSchedule({
        asOf: time(180),
        constraints: { ...constraints, lastCompletedAt: { kind: 'known', value: time(181) } },
      }),
    ).toMatchObject({ kind: 'invalid_input' });
    const sorted = sortSchedules([
      { skillId: SkillIdSchema.parse('z'), eligibleAt: time(181) },
      { skillId: SkillIdSchema.parse('b'), eligibleAt: time(180) },
      { skillId: SkillIdSchema.parse('a'), eligibleAt: time(180) },
    ]);
    expect(sorted.map((x) => x.skillId)).toEqual(['a', 'b', 'z']);
  });
  // @invariant grading: negative-window expiry and immediate-success certainty cannot enter the candidate's retention curve
  // @fails-if failure history disappears at a fixed window boundary or correct practice resets score to one
  it('avoids the DAS3H and HLR counterexamples while preserving the candidate limitations', () => {
    const first = updated(append(initial(), observation(1, 0)).result);
    const failed = updated(append(first, observation(2, 1, 0)).result);
    // The source's A0 counterexample jumps from sigmoid(-ln2)=1/3 to sigmoid(0)=1/2.
    expect(1 / (1 + Math.exp(Math.LN2))).toBeCloseTo(1 / 3, 14);
    const before = value(failed, 1 + (3_600_000 - 1) / DAY_MS);
    const after = value(failed, 1 + (3_600_000 + 1) / DAY_MS);
    expect(after).toBeLessThan(before);
    expect(value(first, 0)).toBeLessThan(1);
    expect(value(failed, 1)).toBeLessThan(value(first, 1));
    // Fixed gain after a very long successful interval is still four, not learned stability.
    const late = updated(append(first, observation(3, 10_000)).result);
    expect(late.projection).toMatchObject({ fast: 3, slow: 1 });
    const partial = updated(append(first, observation(2, 1 / DAY_MS, 0.5)).result);
    expect(value(partial, 1 / DAY_MS)).toBeLessThan(value(first, 1 / DAY_MS));
  });

  // @invariant grading: owner correction remains a hard display and arrangement constraint despite contrary weak evidence
  // @fails-if a correction injects fake success into u, later evidence clears the assertion, or an explicit user date is ignored
  it('keeps user correction outside the mathematical state and schedules an optional check', () => {
    const state = history().state;
    const sealed = JSON.stringify(state);
    const correction = {
      correctionId: 'owner-correction:immutable:47',
      assertion: 'can_do' as const,
      evidenceRefs: ['event:owner-correction:47'],
      notBefore: { kind: 'unknown' as const, reason: 'not_requested' },
    };
    const result = applyUserCorrection({
      correction,
      asOf: time(180),
      constraints: { ...constraints, lastCompletedAt: { kind: 'known', value: time(180) } },
      conflictingEvidenceRefs: ['judgment:contrary:48'],
    });
    expect(result).toMatchObject({
      displayAssertion: 'can_do',
      source: 'user_correction',
      optionalCheck: { kind: 'eligible', eligibleAt: time(181) },
      conflictingEvidenceRefs: ['judgment:contrary:48'],
    });
    expect(
      applyUserCorrection({
        correction: { ...correction, notBefore: { kind: 'known', value: time(190) } },
        asOf: time(180),
        constraints,
        conflictingEvidenceRefs: [],
      }),
    ).toMatchObject({ optionalCheck: { eligibleAt: time(190) } });
    expect(JSON.stringify(state)).toBe(sealed);
  });
});
