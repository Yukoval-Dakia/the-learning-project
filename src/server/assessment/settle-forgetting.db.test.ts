import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryReviewDue } from '@/capabilities/practice/server/due-list';
import { executeGetReviewDue } from '@/capabilities/practice/server/tools/question-context';
import {
  prefetchProbeSelection,
  selectProbeFromPrefetch,
} from '@/capabilities/practice/server/variant-rotation';
import { replay } from '@/core/forgetting';
import { initialFsrsState } from '@/core/fsrs';
import { AggregateOutcome, ScoringUnitResult } from '@/core/schema/assessment/judgment';
import { StateSnapshotExperimental } from '@/core/schema/event/state-snapshot';
import { CandidateStateSchema, SchedulingStateSchema } from '@/core/schema/scheduling-state';
import type { Tx } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_group,
  event,
  knowledge,
  mastery_state,
  material_fsrs_state,
  question,
  question_group_lifecycle,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { CandidateReplayInputSchema } from '@/server/fsrs/candidate';
import {
  enrollFsrsStateIfAbsent,
  getFsrsRetrievabilityByIds,
  initialSchedulingState,
} from '@/server/fsrs/state';
import { normalizeQuestionRowToContract } from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { activateEvaluation, insertInitialEvaluationHead } from './activate';
import {
  ASSESSMENT_SETTLEMENT_ACTION,
  learningSettlement,
  withdrawCapturedOccurrence,
} from './settle';

const NOW = new Date('2026-09-26T00:00:00Z');
const ADMITTED_EVIDENCE = {
  marking_provenance: 'official' as const,
  verification: { structural_check_passed: true, independent_verification: null },
  model_slice: null,
};

async function seedKnowledge(id: string, opts: { parentId?: string; domain?: string } = {}) {
  const db = testDb();
  await db.insert(knowledge).values({
    id,
    name: id,
    domain: opts.parentId ? null : (opts.domain ?? null),
    parent_id: opts.parentId ?? null,
    approval_status: 'approved',
    proposed_by_ai: false,
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  });
}

interface SeedQuestionOpts {
  kcs?: string[];
  difficulty?: number;
}

async function seedQuestionRow(id: string, opts: SeedQuestionOpts & { parentId?: string } = {}) {
  const db = testDb();
  await db.insert(question).values({
    id,
    kind: 'choice',
    prompt_md: `在一个跨三周的代数复习序列中，学生先独立求解二次方程，再检查因式分解。题号 ${id}：若 x²−5x+6=0，请从所给选项中选择完整的根集，并说明检验步骤。`,
    reference_md: 'B',
    knowledge_ids: opts.kcs ?? [],
    difficulty: opts.difficulty ?? 3,
    source: 'web_sourced',
    variant_depth: 0,
    choices_md: ['x=2 或 x=3', '仅 x=2，忽略第二根', 'x=−2 或 x=−3，符号错误'],
    ...(opts.parentId ? { parent_question_id: opts.parentId, part_index: 0 } : {}),
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  });
}

async function publishAdmittedForGroup(qid: string) {
  const db = testDb();
  const [row] = await db.select().from(question).where(eq(question.id, qid)).limit(1);
  const n = normalizeQuestionRowToContract(row);
  const result = await publishQuestionGroup(db, {
    group_id: n.group_id,
    contract: {
      structure: n.structure,
      response_spec: n.response_spec,
      scoring_basis: n.scoring_basis,
      execution_plan: n.execution_plan,
      integrity_digest: n.integrity_digest,
    },
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    admission: { state: 'admitted', evidence: ADMITTED_EVIDENCE },
    actorRef: 'test:publish',
    now: NOW,
  });
  if (result.status !== 'published') throw new Error(`seed publish: ${result.status}`);
  return { revisionId: result.revision_id };
}

interface SeedIds {
  qid: string;
  revisionId: string;
  issuanceId: string;
  groupId: string;
  submissionId: string;
}

/** 单 submission group + head 同事务（§11 原子不变量）。 */
async function seedChain(
  prefix: string,
  opts: { kcs?: string[]; submittedAt?: Date } = {},
): Promise<SeedIds> {
  const db = testDb();
  const qid = `${prefix}_q`;
  const issuanceId = `${prefix}_iss`;
  const groupId = `${prefix}_grp`;
  const submissionId = `${prefix}_sub`;
  const submittedAt = opts.submittedAt ?? NOW;
  await seedQuestionRow(qid, { kcs: opts.kcs });
  const { revisionId } = await publishAdmittedForGroup(qid);
  await db.insert(assessment_issuance).values({
    issuance_id: issuanceId,
    revision_id: revisionId,
    part_ids: [qid],
    material_bindings: [],
    option_order: [],
    claim_policy: 'one_time',
    claim_status: 'claimed',
    claimed_by_ref: 'occ_1',
    issued_at: NOW,
  });
  await db.transaction(async (tx) => {
    await tx.insert(evaluation_group).values({
      evaluation_group_id: groupId,
      submission_ids: [submissionId],
      created_at: NOW,
    });
    await tx.insert(assessment_submission).values({
      submission_id: submissionId,
      issuance_id: issuanceId,
      revision_id: revisionId,
      evaluation_group_id: groupId,
      response_set: { entries: [] },
      group_evidence: [],
      idempotency_key: `${prefix}_idem`,
      submitted_at: submittedAt,
    });
    await insertInitialEvaluationHead(tx, {
      evaluation_group_id: groupId,
      submission_id: submissionId,
      now: submittedAt,
    });
  });
  await writeEvent(db, {
    id: `${prefix}_receipt`,
    action: 'experimental:assessment_submission',
    subject_kind: 'submission',
    subject_id: submissionId,
    actor_kind: 'system',
    actor_ref: 'fixture',
    outcome: null,
    payload: { assistance: { status: 'independent', event_ids: [] } },
    created_at: submittedAt,
  });
  await writeEvent(db, {
    id: `evt_assessment_${submissionId}`,
    action: 'experimental:assessment_attempt',
    subject_kind: 'question',
    subject_id: qid,
    actor_kind: 'user',
    actor_ref: 'self',
    outcome: null,
    payload: {
      submission_id: submissionId,
      response_md: '我把多项式分解成 (x−2)(x−3)，并将两个候选根代回原式检查。',
      hints_used: 0,
      final_hint_level: 0,
      self_confidence: 4,
      duration_ms: 182731,
    },
    created_at: submittedAt,
  });
  return { qid, revisionId, issuanceId, groupId, submissionId };
}

interface EvalOpts {
  unitResults?: unknown[];
  aggregate?: unknown;
  provenance?: Record<string, unknown>;
  attempt?: number;
}

async function admissionSnapshot(groupId: string) {
  const [snapshot] = await testDb()
    .select({
      current_revision_id: question_group_lifecycle.current_revision_id,
      generation: question_group_lifecycle.scoring_admission_generation,
      state: question_group_lifecycle.scoring_admission_state,
      suspended: question_group_lifecycle.suspended,
      withdrawn: question_group_lifecycle.withdrawn,
    })
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, groupId));
  if (!snapshot) throw new Error('missing fixture admission');
  return snapshot;
}

async function seedEvaluation(seed: SeedIds, evalId: string, opts: EvalOpts = {}) {
  const db = testDb();
  await db.insert(evaluation).values({
    evaluation_id: evalId,
    evaluation_group_id: seed.groupId,
    submission_id: seed.submissionId,
    attempt: opts.attempt ?? 1,
    status: 'completed',
    unit_results: ScoringUnitResult.array().parse(opts.unitResults ?? []),
    aggregate: AggregateOutcome.parse(
      opts.aggregate ?? {
        kind: 'points_total',
        points: 1,
        policy: { kind: 'sum' },
      },
    ),
    plan_digest: null,
    run_refs: [],
    provenance: {
      ...(opts.provenance ?? { source: 'automatic', assisted: false }),
      admission_snapshot: await admissionSnapshot(seed.qid),
    },
    created_at: NOW,
  });
}

function unitResult(unitId: string, points: number, scoredBecause = 'response') {
  return {
    status: 'scored',
    scoring_unit_id: unitId,
    points_awarded: points,
    scored_because: scoredBecause,
  };
}

async function activate(
  evalId: string,
  expected: { effectiveId: string | null; generation: number },
  now?: Date,
  userRating?: 'again' | 'hard' | 'good',
) {
  const db = testDb();
  return db.transaction((tx) =>
    activateEvaluation(
      tx,
      {
        evaluation_id: evalId,
        expected_effective_id: expected.effectiveId,
        expected_generation: expected.generation,
        ...(userRating === undefined ? {} : { user_rating: userRating }),
      },
      { settle: learningSettlement, actorRef: 'test', now: now ?? NOW },
    ),
  );
}

async function candidateRow(id = 'kc_a') {
  const [row] = await testDb()
    .select()
    .from(material_fsrs_state)
    .where(eq(material_fsrs_state.subject_id, id));
  return { ...row, state: CandidateStateSchema.parse(row.state) };
}
async function appliedEvents() {
  return testDb().select().from(event).where(eq(event.action, ASSESSMENT_SETTLEMENT_ACTION));
}
async function seedScored(prefix: string, at: Date, points = 1, kcs = ['kc_a']) {
  const seed = await seedChain(prefix, { kcs, submittedAt: at });
  await seedEvaluation(seed, `${prefix}_eval`, {
    unitResults: [unitResult(`${seed.qid}::u`, points)],
    aggregate: { kind: 'points_total', points, policy: { kind: 'sum' } },
  });
  return seed;
}
async function activateIn(tx: Tx, evalId: string, now = NOW) {
  return activateEvaluation(
    tx,
    { evaluation_id: evalId, expected_effective_id: null, expected_generation: 0 },
    { settle: learningSettlement, actorRef: 'fixture', now },
  );
}
const DAY = 86400000;
describe('candidate product settlement, replay and selected readers', () => {
  beforeEach(async () => {
    vi.stubEnv('FORGETTING_ENGINE', 'forgetting_candidate');
    await resetDb();
    await seedKnowledge('kc_a', { domain: 'dom_x' });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // @invariant grading: sealed scored facts drive one versioned candidate row and immutable brackets at submission time
  // @fails-if settlement uses activation time, drops capture fields, double counts a duplicate, or writes two state sources
  it('seals continuous evidence and ignores duplicate activation and reverse activation clocks', async () => {
    const a = await seedScored('continuous_a', NOW, 0.5);
    expect(
      await activate(
        'continuous_a_eval',
        { effectiveId: null, generation: 0 },
        new Date(NOW.getTime() - DAY),
      ),
    ).toMatchObject({ effect: 'applied' });
    const before = await candidateRow();
    expect(before.state).toMatchObject({
      engine: 'forgetting_candidate',
      calibration: 'uncalibrated',
      provenance: 'engineering',
      last_review: NOW,
      global: { projection: { kind: 'warm', eventCount: 1 } },
    });
    const receipt = (await appliedEvents())[0];
    const replayInputs = receipt.payload.replay_inputs;
    if (
      !replayInputs ||
      typeof replayInputs !== 'object' ||
      !('forgettingReplayInputs' in replayInputs) ||
      !Array.isArray(replayInputs.forgettingReplayInputs)
    )
      throw new Error('sealed replay engine inputs missing');
    const sealed = replayInputs.forgettingReplayInputs.map((raw) =>
      CandidateReplayInputSchema.parse(raw),
    );
    const global = sealed.find((input) => input.seed.scope.kind === 'global');
    if (!global) throw new Error('global replay packet missing');
    expect(replay(global)).toMatchObject({ kind: 'updated', state: before.state.global });
    expect(global.effective[0].receipt).toMatchObject({
      nextInputDigest: before.state.global.inputDigest,
      nextThrough:
        before.state.global.through.kind === 'known' ? before.state.global.through.value : null,
    });

    expect(receipt.payload.replay_inputs).toMatchObject({
      forgettingInput: {
        recordedSequence: NOW.getTime(),
        fact: {
          hints_used: 0,
          final_hint_level: 0,
          self_confidence: 4,
          latency_ms: 182731,
          help: 'none',
          confidence: 'high',
        },
        adaptedEvidence: [{ kind: 'included', observation: { quality: 0.5, independent: false } }],
      },
    });
    expect(
      await activate(
        'continuous_a_eval',
        { effectiveId: 'continuous_a_eval', generation: 1 },
        new Date(NOW.getTime() + 200 * DAY),
      ),
    ).toMatchObject({ status: 'already_effective' });
    expect(await candidateRow()).toEqual(before);
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(1);
    const b = await seedScored('continuous_b', new Date(NOW.getTime() + 9 * DAY), 1);
    expect(
      await activate(
        'continuous_b_eval',
        { effectiveId: null, generation: 0 },
        new Date(NOW.getTime() - DAY),
      ),
    ).toMatchObject({ effect: 'applied' });
    expect((await candidateRow()).state.global.projection).toMatchObject({ eventCount: 2 });
    expect((await candidateRow()).state.last_review).toEqual(new Date(NOW.getTime() + 9 * DAY));
    expect((await appliedEvents()).map((e) => e.payload.submission_id)).toEqual(
      expect.arrayContaining([a.submissionId, b.submissionId]),
    );
  });

  // @invariant concurrency: late and equal-time facts converge to the same ordered candidate state without future leakage
  // @fails-if replay omits the newly inserted occurrence, revives superseded facts, or orders ties by settlement wall clock
  it('converges across forward, reverse and equal-time arrival using exactly the same sealed facts', async () => {
    const times = [0, 0, 4, 18];
    for (let i = 0; i < times.length; i++)
      await seedScored(
        `ordered_${i}`,
        new Date(NOW.getTime() + times[i] * DAY),
        i === 2 ? 0 : i === 1 ? 0.5 : 1,
      );
    const rollback = new Error('rollback fixture scenario');
    async function run(order: number[]) {
      let result: unknown;
      await testDb()
        .transaction(async (tx) => {
          for (const index of order) {
            const activated = await activateIn(
              tx,
              `ordered_${index}_eval`,
              new Date(NOW.getTime() + 30 * DAY),
            );
            const receipts = await tx
              .select({ payload: event.payload })
              .from(event)
              .where(eq(event.action, ASSESSMENT_SETTLEMENT_ACTION));
            expect(activated, JSON.stringify({ index, receipts })).toMatchObject({
              effect: 'applied',
            });
          }
          const [row] = await tx.select().from(material_fsrs_state);
          const state = CandidateStateSchema.parse(row.state);
          const mastery = await tx
            .select({
              theta: mastery_state.theta_hat,
              count: mastery_state.evidence_count,
              success: mastery_state.success_count,
              fail: mastery_state.fail_count,
              at: mastery_state.last_outcome_at,
            })
            .from(mastery_state);
          result = { state, due: row.due_at, mastery };
          throw rollback;
        })
        .catch((error) => {
          if (error !== rollback) throw error;
        });
      return result;
    }
    expect(await run([3, 2, 1, 0])).toEqual(await run([0, 1, 2, 3]));
  });

  // @invariant data: legacy history converts once and mixed legacy/candidate brackets restore and reapply without rewriting receipts
  // @fails-if legacy cards are silently cold-started, candidate revert compares only FSRS scalars, or old receipts change
  it('rebuilds legacy history and corrects a candidate across the version boundary', async () => {
    vi.stubEnv('FORGETTING_ENGINE', 'fsrs');
    const old = await seedScored('legacy_old', NOW);
    await activate('legacy_old_eval', { effectiveId: null, generation: 0 });
    const original = await appliedEvents();
    const legacyRow = (await testDb().select().from(material_fsrs_state))[0];
    vi.stubEnv('FORGETTING_ENGINE', 'forgetting_candidate');
    const readTime = new Date(NOW.getTime() + 11 * 60000);
    expect((await queryReviewDue(testDb(), { now: readTime })).rows).toHaveLength(0);
    expect(
      (await getFsrsRetrievabilityByIds(testDb(), 'knowledge', ['kc_a'], readTime)).get('kc_a'),
    ).toMatchObject({ kind: 'score', calibration: 'uncalibrated' });
    expect((await testDb().select().from(material_fsrs_state))[0]).toEqual(legacyRow);
    const nextTime = new Date(NOW.getTime() + 6 * DAY);
    const next = await seedScored('legacy_next', nextTime);
    expect(
      await activate('legacy_next_eval', { effectiveId: null, generation: 0 }, nextTime),
    ).toMatchObject({ effect: 'applied' });
    expect((await candidateRow()).state).toMatchObject({
      conversion: 'legacy_history',
      global: { projection: { eventCount: 2 } },
    });
    const receipts = await appliedEvents();
    const applied = receipts.find((e) => e.payload.submission_id === next.submissionId);
    if (!applied) throw new Error('candidate receipt missing');
    const [rawSnapshot] = await testDb()
      .select()
      .from(event)
      .where(eq(event.id, `${applied.id}:snapshot:fsrs`));
    const bracket = StateSnapshotExperimental.shape.payload.parse(rawSnapshot.payload);
    expect(bracket.fsrs_snapshots[0].before).toEqual(SchedulingStateSchema.parse(legacyRow.state));
    expect(bracket.fsrs_snapshots[0].after).toMatchObject({ engine: 'forgetting_candidate' });
    const [unchanged] = await testDb().select().from(event).where(eq(event.id, original[0].id));
    expect(unchanged).toEqual(original[0]);
    await seedEvaluation(next, 'legacy_corrected', {
      attempt: 2,
      unitResults: [unitResult(`${next.qid}::u`, 0)],
      aggregate: { kind: 'points_total', points: 0, policy: { kind: 'sum' } },
    });
    expect(
      await activate(
        'legacy_corrected',
        { effectiveId: 'legacy_next_eval', generation: 1 },
        nextTime,
      ),
    ).toMatchObject({ effect: 'applied' });
    const corrected = await candidateRow();
    expect(corrected.state.global.projection).toMatchObject({ eventCount: 2 });
    expect(corrected.state.global.lastApplied).toMatchObject({
      kind: 'known',
      value: { effectiveJudgmentId: 'legacy_corrected', quality: 0 },
    });
    expect(
      (await appliedEvents()).filter((e) => e.payload.submission_id === old.submissionId),
    ).toHaveLength(1);
  });

  // @invariant grading: unresolved and assisted judgments never write memory while explicit self-report remains separate
  // @fails-if unresolved or assisted judgment writes memory, missing help admits evidence, or self-report creates mastery effects
  it('excludes assisted and unresolved judgments while preserving explicit self-report', async () => {
    const helped = await seedChain('helped', { kcs: ['kc_a'] });
    await testDb()
      .update(event)
      .set({
        payload: {
          assistance: { status: 'assisted', event_ids: ['released-hint-with-answer-help'] },
        },
      })
      .where(eq(event.id, 'helped_receipt'));
    await testDb()
      .update(event)
      .set({
        payload: { hints_used: 2, final_hint_level: 2, self_confidence: 2, duration_ms: 402122 },
      })
      .where(eq(event.id, `evt_assessment_${helped.submissionId}`));
    await seedEvaluation(helped, 'helped_eval', {
      unitResults: [unitResult(`${helped.qid}::u`, 1)],
      provenance: { source: 'automatic', assisted: true },
    });
    expect(await activate('helped_eval', { effectiveId: null, generation: 0 })).toMatchObject({
      effect: 'ineligible',
    });
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
    expect(await testDb().select().from(mastery_state)).toHaveLength(0);
    const unresolved = await seedChain('unresolved', {
      kcs: ['kc_a'],
      submittedAt: new Date(NOW.getTime() + DAY / 2),
    });
    await seedEvaluation(unresolved, 'unresolved_eval', {
      unitResults: [
        {
          status: 'pending',
          scoring_unit_id: `${unresolved.qid}::u`,
          pending: {
            reason: 'insufficient_evidence',
            detail:
              'Derivation supplied, but the shared diagram scale is missing; partial credit cannot be determined.',
          },
        },
      ],
      aggregate: { kind: 'unresolved', reason: 'pending_units' },
    });
    await activate('unresolved_eval', { effectiveId: null, generation: 0 });
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
    expect(await testDb().select().from(mastery_state)).toHaveLength(0);
    const self = await seedChain('self', {
      kcs: ['kc_a'],
      submittedAt: new Date(NOW.getTime() + DAY),
    });
    await seedEvaluation(self, 'self_eval', {
      aggregate: { kind: 'unresolved', reason: 'no_mapping', pending_units: [] },
      provenance: { source: 'self_report', assisted: false },
    });
    expect(
      await activate('self_eval', { effectiveId: null, generation: 0 }, undefined, 'hard'),
    ).toMatchObject({ effect: 'applied' });
    const beforeUnknown = await candidateRow();
    expect(beforeUnknown.state.global.lastApplied).toMatchObject({
      kind: 'known',
      value: {
        quality: 0.5,
        independent: false,
        mappingNotes: expect.arrayContaining(['source:self_report']),
      },
    });
    expect(await testDb().select().from(mastery_state)).toHaveLength(0);
    const missing = await seedScored('missing', new Date(NOW.getTime() + 2 * DAY));
    await testDb().delete(event).where(eq(event.id, 'missing_receipt'));
    await activate('missing_eval', { effectiveId: null, generation: 0 });
    expect(await candidateRow()).toEqual(beforeUnknown);
    const missingReceipt = (await appliedEvents()).find(
      (e) => e.payload.submission_id === missing.submissionId,
    );
    expect(missingReceipt?.payload.replay_inputs).toMatchObject({
      forgettingInput: { adaptedEvidence: [{ kind: 'excluded', reason: 'help_unknown' }] },
    });
  });

  // @invariant grading: due-list and copilot use the same selected due projection and preserve unknown retention metadata
  // @fails-if due rows are filtered by legacy dates, counts diverge, cold retention becomes zero, or suspended questions are served
  it('flips due boundaries across queue/tool readers and keeps cold states unknown', async () => {
    const seed = await seedScored('due', NOW);
    await activate('due_eval', { effectiveId: null, generation: 0 });
    const row = await candidateRow();
    expect(row.due_at.getTime()).toBeGreaterThan(NOW.getTime());
    const before = new Date(row.due_at.getTime() - 1);
    const after = row.due_at;
    expect((await queryReviewDue(testDb(), { now: before })).rows).toHaveLength(0);
    const due = (await queryReviewDue(testDb(), { now: after })).rows;
    expect(due.map((r) => r.question_id)).toContain(seed.qid);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(after);
    const tool = await executeGetReviewDue(
      {
        db: testDb(),
        taskRunId: 'fixture-reader-no-provider',
        callerActor: { kind: 'system', ref: 'fixture' },
      },
      { limit: 20 },
    );
    expect(tool.queue_summary.total_returned).toBe(due.length);
    expect(tool.fsrs_projection_summary.due_now_state_count).toBe(1);
    const reading = (await getFsrsRetrievabilityByIds(testDb(), 'knowledge', ['kc_a'], after)).get(
      'kc_a',
    );
    expect(reading).toMatchObject({
      kind: 'score',
      calibration: 'uncalibrated',
      provenance: 'engineering',
    });
    await testDb()
      .update(question_group_lifecycle)
      .set({ suspended: true })
      .where(eq(question_group_lifecycle.group_id, seed.qid));
    expect((await queryReviewDue(testDb(), { now: after })).rows).toHaveLength(0);
    expect(
      (
        await executeGetReviewDue(
          {
            db: testDb(),
            taskRunId: 'fixture-reader-no-provider',
            callerActor: { kind: 'system', ref: 'fixture' },
          },
          { limit: 20 },
        )
      ).rows,
    ).toHaveLength(0);
    await seedKnowledge('kc_cold');
    const initial = initialFsrsState(NOW);
    await testDb().insert(material_fsrs_state).values({
      id: 'legacy-cold-reader',
      subject_kind: 'knowledge',
      subject_id: 'kc_cold',
      state: initial.state,
      due_at: initial.dueAt,
    });
    expect(
      (await getFsrsRetrievabilityByIds(testDb(), 'knowledge', ['kc_cold'], after)).get('kc_cold'),
    ).toMatchObject({ kind: 'unknown', calibration: 'uncalibrated', provenance: 'engineering' });
  });

  // @invariant grading: the forgetting selector does not change theta/PFA evidence or by-kind question selection ownership
  // @fails-if selecting the candidate changes ability effects, occurrence timestamps, or removes the last-review reference used by variant rotation
  it('keeps theta/PFA identical to FSRS for the same scored sequence', async () => {
    await seedScored('boundary_a', NOW);
    await seedScored('boundary_b', new Date(NOW.getTime() + DAY), 0);
    const rollback = new Error('rollback boundary fixture');
    async function run(engine: string) {
      vi.stubEnv('FORGETTING_ENGINE', engine);
      let result: unknown;
      await testDb()
        .transaction(async (tx) => {
          for (const prefix of ['boundary_a', 'boundary_b'])
            expect(await activateIn(tx, `${prefix}_eval`)).toMatchObject({ effect: 'applied' });
          result = await tx
            .select({
              kind: mastery_state.subject_kind,
              id: mastery_state.subject_id,
              theta: mastery_state.theta_hat,
              precision: mastery_state.theta_precision,
              grid: mastery_state.theta_grid_json,
              count: mastery_state.evidence_count,
              success: mastery_state.success_count,
              fail: mastery_state.fail_count,
              at: mastery_state.last_outcome_at,
              rt: mastery_state.rt_correct_ms,
            })
            .from(mastery_state)
            .orderBy(mastery_state.subject_id);
          const [row] = await tx.select().from(material_fsrs_state);
          const [writer] = await tx
            .select()
            .from(event)
            .where(eq(event.id, row.last_review_event_id ?? 'missing'));
          expect(writer.payload.submission_id).toBe('boundary_b_sub');
          const selectionInput = {
            knowledgeId: 'kc_a',
            lastReviewEventId: row.last_review_event_id,
            usedQuestionIds: new Set<string>(),
          };
          const prefetch = await prefetchProbeSelection(tx, [selectionInput]);
          const chosen = selectProbeFromPrefetch(prefetch, selectionInput);
          result = { ability: result, selected: chosen };
          expect(chosen?.question_id).toBeDefined();
          throw rollback;
        })
        .catch((error) => {
          if (error !== rollback) throw error;
        });
      return result;
    }
    expect(await run('forgetting_candidate')).toEqual(await run('fsrs'));
  });

  // @invariant security: selected candidate scheduling cannot bypass draft, admission, withdrawal, suspension or synthetic-root serving guards
  // @fails-if either queue reader serves an excluded question solely because an active due row exists
  it('keeps all automatic-serving guards and structural anchors out of both queue readers', async () => {
    const cases = ['allowed', 'suspended', 'withdrawn', 'draft', 'withheld'];
    for (const prefix of cases) {
      const seed = await seedScored(`guard_${prefix}`, NOW, 1, []);
      await enrollFsrsStateIfAbsent(testDb(), {
        subject_kind: 'question',
        subject_id: seed.qid,
        ...initialSchedulingState(seed.qid, NOW),
        last_review_event_id: null,
      });
      if (prefix === 'draft')
        await testDb()
          .update(question)
          .set({ draft_status: 'draft' })
          .where(eq(question.id, seed.qid));
      if (prefix === 'suspended')
        await testDb()
          .update(question_group_lifecycle)
          .set({ suspended: true })
          .where(eq(question_group_lifecycle.group_id, seed.qid));
      if (prefix === 'withdrawn')
        await testDb()
          .update(question_group_lifecycle)
          .set({ withdrawn: true })
          .where(eq(question_group_lifecycle.group_id, seed.qid));
      if (prefix === 'withheld')
        await testDb()
          .update(question_group_lifecycle)
          .set({
            scoring_admission_state: 'withheld',
            scoring_admission_withheld_reason: 'owner_hold',
          })
          .where(eq(question_group_lifecycle.group_id, seed.qid));
    }
    await seedKnowledge('seed:algebra:root');
    await enrollFsrsStateIfAbsent(testDb(), {
      subject_kind: 'knowledge',
      subject_id: 'seed:algebra:root',
      ...initialSchedulingState('seed:algebra:root', NOW),
      last_review_event_id: null,
    });
    const due = await queryReviewDue(testDb(), { now: NOW });
    expect(due.rows.map((row) => row.question_id)).toEqual(['guard_allowed_q']);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const tool = await executeGetReviewDue(
      {
        db: testDb(),
        taskRunId: 'fixture-no-provider',
        callerActor: { kind: 'system', ref: 'fixture' },
      },
      { limit: 20 },
    );
    expect(tool.rows.map((row) => row.question_id)).toEqual(['guard_allowed_q']);
  });

  // @invariant data: withdrawing a preserved ingestion capture replays later effective facts without changing their memory history or immutable originals
  // @fails-if capture withdrawal leaves ability residue, removes later candidate memory, or rewrites the original captured event
  it('withdraws a preserved capture and reapplies a later candidate from the same sealed facts', async () => {
    const capture = await seedScored('capture_original', NOW);
    const [original] = await testDb()
      .select()
      .from(event)
      .where(eq(event.id, `evt_assessment_${capture.submissionId}`));
    await testDb()
      .update(event)
      .set({
        payload: {
          ...original.payload,
          entry: 'ingestion_grading',
          evaluation_group_id: capture.groupId,
          submission_id: capture.submissionId,
        },
      })
      .where(eq(event.id, original.id));
    await writeEvent(testDb(), {
      id: 'capture_issuance_receipt',
      action: 'experimental:assessment_issuance',
      subject_kind: 'issuance',
      subject_id: capture.issuanceId,
      actor_kind: 'system',
      actor_ref: 'fixture',
      outcome: null,
      payload: {
        mode: 'capture_existing',
        scheduling_policy: 'preserve',
        capture_source: { block_id: 'captured-paper-block', session_id: 'captured-paper-session' },
      },
      created_at: NOW,
    });
    expect(
      await activate('capture_original_eval', { effectiveId: null, generation: 0 }),
    ).toMatchObject({ effect: 'applied' });
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
    const at = new Date(NOW.getTime() + 2 * DAY);
    await seedScored('capture_later', at);
    await activate('capture_later_eval', { effectiveId: null, generation: 0 }, at);
    const before = await candidateRow();
    const [sealedOriginal] = await testDb().select().from(event).where(eq(event.id, original.id));
    const input = {
      originalAttemptEventId: original.id,
      correctionEventId: 'capture-correction',
      blockId: 'captured-paper-block',
      sessionId: 'captured-paper-session',
      now: at,
    };
    await testDb().transaction((tx) => withdrawCapturedOccurrence(tx, input));
    expect((await candidateRow()).state).toEqual(before.state);
    expect(
      (await testDb().select().from(mastery_state)).filter(
        (row) => row.subject_kind === 'knowledge',
      ),
    ).toMatchObject([{ evidence_count: 1, success_count: 1 }]);
    expect((await appliedEvents()).filter((e) => e.payload.effect === 'withdrawn')).toHaveLength(1);
    expect((await testDb().select().from(event).where(eq(event.id, original.id)))[0]).toEqual(
      sealedOriginal,
    );
    await testDb().transaction((tx) => withdrawCapturedOccurrence(tx, input));
    expect((await appliedEvents()).filter((e) => e.payload.effect === 'withdrawn')).toHaveLength(1);
  });
});
