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
import { canonicalHash } from '@/core/migration/canonical';
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
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import {
  CandidateReplayInputSchema,
  SealedCandidateInputSchema,
  initialCandidateState,
  projectCandidateDue,
  sealCandidateFact,
} from '@/server/fsrs/candidate';
import {
  enrollFsrsStateIfAbsent,
  getFsrsRetrievabilityByIds,
  initialSchedulingState,
  upsertFsrsState,
} from '@/server/fsrs/state';
import {
  normalizeQuestionGroupToContract,
  normalizeQuestionRowToContract,
} from '@/server/questions/contract-normalizer';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { activateEvaluation, insertInitialEvaluationHead } from './activate';
import {
  ASSESSMENT_SETTLEMENT_ACTION,
  candidateStateForRead,
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

async function publishAdmittedForGroup(qid: string, partIds: string[] = []) {
  const db = testDb();
  const [row] = await db.select().from(question).where(eq(question.id, qid)).limit(1);
  const parts = await Promise.all(
    partIds.map(async (id) => {
      const [part] = await db.select().from(question).where(eq(question.id, id));
      return part;
    }),
  );
  const n = parts.length
    ? normalizeQuestionGroupToContract(row, parts)
    : normalizeQuestionRowToContract(row);
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
  opts: { kcs?: string[]; submittedAt?: Date; parts?: Array<{ id: string; kcs: string[] }> } = {},
): Promise<SeedIds> {
  const db = testDb();
  const qid = `${prefix}_q`;
  const issuanceId = `${prefix}_iss`;
  const groupId = `${prefix}_grp`;
  const submissionId = `${prefix}_sub`;
  const submittedAt = opts.submittedAt ?? NOW;
  await seedQuestionRow(qid, { kcs: opts.kcs });
  for (const part of opts.parts ?? [])
    await seedQuestionRow(part.id, { kcs: part.kcs, parentId: qid });
  const partIds = opts.parts?.map((part) => part.id) ?? [qid];
  const { revisionId } = await publishAdmittedForGroup(
    qid,
    opts.parts?.map((part) => part.id),
  );
  await db.insert(assessment_issuance).values({
    issuance_id: issuanceId,
    revision_id: revisionId,
    part_ids: partIds,
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
  // @fails-if old sealed multi-KC partial enters read/replay or loses its valid single-KC neighbor, receipts mutate, or duplicates count twice
  it('seals continuous evidence and ignores duplicate activation and reverse activation clocks', async () => {
    await seedKnowledge('kc_b');
    await seedScored('unattributed', NOW, 0.5, ['kc_a', 'kc_b']);
    expect(await activate('unattributed_eval', { effectiveId: null, generation: 0 })).toMatchObject(
      {
        effect: 'ineligible',
      },
    );
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
    const excludedReceipt = (await appliedEvents())[0];
    expect(excludedReceipt.payload.replay_inputs).toMatchObject({
      forgettingInput: {
        adaptedEvidence: [
          {
            kind: 'excluded',
            reason: 'unattributed_multi_skill',
            evidenceRefs: expect.arrayContaining(['unattributed_sub', 'unattributed_eval']),
          },
        ],
      },
    });
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
    const receipt = (await appliedEvents()).find((e) => e.payload.submission_id === a.submissionId);
    if (!receipt) throw new Error('candidate receipt missing');
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
    await seedKnowledge('kc_c');
    await seedKnowledge('kc_d');
    const mixed = await seedChain('mixed', {
      kcs: ['kc_b', 'kc_c'],
      parts: [
        { id: 'mixed_unmapped', kcs: [] },
        { id: 'mixed_mapped', kcs: ['kc_d'] },
      ],
    });
    await seedEvaluation(mixed, 'mixed_eval', {
      unitResults: [unitResult('mixed_unmapped::u', 0.5), unitResult('mixed_mapped::u', 0.5)],
    });
    await activate('mixed_eval', { effectiveId: null, generation: 0 });
    expect(
      (await testDb().select().from(material_fsrs_state)).map((r) => r.subject_id).sort(),
    ).toEqual(['kc_a', 'kc_d']);
    expect((await candidateRow('kc_d')).state.global.lastApplied).toMatchObject({
      kind: 'known',
      value: { quality: 0.5 },
    });
    const mixedReceipt = (await appliedEvents()).find(
      (e) => e.payload.submission_id === mixed.submissionId,
    );
    expect(mixedReceipt?.payload.replay_inputs).toMatchObject({
      forgettingInput: {
        adaptedEvidence: [
          { kind: 'included', observation: { skillId: 'kc_d', quality: 0.5 } },
          {
            kind: 'excluded',
            reason: 'unattributed_multi_skill',
            evidenceRefs: expect.arrayContaining([mixed.submissionId]),
          },
        ],
      },
    });
    if (!mixedReceipt) throw new Error('mixed receipt missing');
    const mixedPlan = mixedReceipt.payload.replay_inputs as Record<string, unknown>;
    const oldFact = SealedCandidateInputSchema.parse(mixedPlan.forgettingInput).fact;
    // Pre-fix seals guessed equal shares for this partial total. The single-KC point is valid.
    const oldInput = sealCandidateFact({
      ...oldFact,
      points: oldFact.points.map((point, index) =>
        index === 0
          ? {
              ...point,
              shares: [
                { skillId: 'kc_b', share: 0.5 },
                { skillId: 'kc_c', share: 0.5 },
              ],
            }
          : point,
      ),
    });
    // Recreate the old stored rows and matching restore bracket from their sealed observations.
    // Current candidate admission is deliberately not used to manufacture this historical fixture.
    const oldPackets: Array<
      ReturnType<typeof CandidateReplayInputSchema.parse> & {
        subject_kind: 'knowledge';
        subject_id: string;
      }
    > = [];
    const oldSnapshots = [];
    for (const adapted of oldInput.adaptedEvidence) {
      if (adapted.kind !== 'included') continue;
      const observation = adapted.observation;
      const skillId = observation.skillId;
      const context = oldFact.context;
      const projections = [null, ...(context ? [context] : [])].map((scope) => {
        const initial = initialCandidateState(skillId, NOW).global;
        const digest = canonicalHash({ skillId, context: scope, versions: oldInput.versions });
        const packet = CandidateReplayInputSchema.parse({
          ...global,
          seed: {
            ...initial,
            scope: scope ? { kind: 'context', key: scope } : { kind: 'global' },
            inputDigest: digest,
          },
          effective: [
            {
              observation,
              recordedSequence: oldInput.recordedSequence,
              receipt: {
                previousInputDigest: digest,
                nextInputDigest: canonicalHash({ previous: digest, fact: oldInput.evidenceDigest }),
                nextThrough: oldInput.orderKey,
              },
            },
          ],
        });
        oldPackets.push({ ...packet, subject_kind: 'knowledge', subject_id: skillId });
        const result = replay(packet);
        if (result.kind !== 'updated') throw new Error('old sealed fixture did not replay');
        return result.state;
      });
      const state = {
        ...initialCandidateState(skillId, NOW),
        conversion: 'native' as const,
        last_review: NOW,
        global: projections[0],
        contexts: context ? { [context]: projections[1] } : {},
      };
      const schedule = projectCandidateDue(state, NOW);
      if (schedule.modelDue.kind !== 'due_now' && schedule.modelDue.kind !== 'scheduled')
        throw new Error('old sealed fixture has no finite model due');
      const after = {
        ...state,
        due: new Date(schedule.modelDue.at),
        dueKind: schedule.dueKind,
        fallbackReason: schedule.fallbackReason,
      };
      oldSnapshots.push({
        subject_kind: 'knowledge' as const,
        subject_id: skillId,
        before: null,
        after,
      });
      await upsertFsrsState(testDb(), {
        subject_kind: 'knowledge',
        subject_id: skillId,
        state: after,
        due_at: after.due,
        last_review_event_id: mixedReceipt.id,
      });
    }
    const [mixedSnapshot] = await testDb()
      .select()
      .from(event)
      .where(eq(event.id, `${mixedReceipt.id}:snapshot:fsrs`));
    await testDb()
      .update(event)
      .set({ payload: { ...mixedSnapshot.payload, fsrs_snapshots: oldSnapshots } })
      .where(eq(event.id, mixedSnapshot.id));
    const [oldReceipt] = await testDb()
      .update(event)
      .set({
        payload: {
          ...mixedReceipt.payload,
          effects: {
            ...(mixedReceipt.payload.effects as Record<string, unknown>),
            subjects: ['knowledge:kc_b', 'knowledge:kc_c', 'knowledge:kc_d'],
            fsrs_applied: ['knowledge:kc_b', 'knowledge:kc_c', 'knowledge:kc_d'],
          },
          replay_inputs: {
            ...mixedPlan,
            forgettingInput: oldInput,
            forgettingReplayInputs: oldPackets,
          },
        },
      })
      .where(eq(event.id, mixedReceipt.id))
      .returning();
    const oldRead = await testDb().transaction((tx) =>
      candidateStateForRead(tx, { kind: 'knowledge', id: 'kc_b' }, NOW),
    );
    expect.soft(oldRead.global.projection.kind).toBe('cold');
    expect.soft(oldRead.fallbackReason).toBe('unattributed_multi_skill_requires_rebuild');
    expect(
      (
        await testDb().transaction((tx) =>
          candidateStateForRead(tx, { kind: 'knowledge', id: 'kc_d' }, NOW),
        )
      ).global.lastApplied,
    ).toMatchObject({ kind: 'known', value: { quality: 0.5 } });
    await seedScored('before_old_seal', new Date(NOW.getTime() - DAY), 1, ['kc_d']);
    expect(
      await activate('before_old_seal_eval', { effectiveId: null, generation: 0 }),
    ).toMatchObject({ effect: 'applied' });
    expect
      .soft((await testDb().select().from(material_fsrs_state)).map((r) => r.subject_id).sort())
      .toEqual(['kc_a', 'kc_d']);
    expect((await candidateRow('kc_d')).state.global.projection).toMatchObject({ eventCount: 2 });
    const reapplied = (await appliedEvents()).find((e) => e.payload.replay_of === oldReceipt.id);
    expect.soft(reapplied?.payload.replay_inputs).toMatchObject({
      forgettingExcludedEvidence: [
        {
          kind: 'excluded',
          reason: 'unattributed_multi_skill_requires_rebuild',
          evidenceRefs: expect.arrayContaining([mixed.submissionId]),
        },
      ],
    });
    const [unchanged] = await testDb().select().from(event).where(eq(event.id, oldReceipt.id));
    expect(unchanged).toEqual(oldReceipt);
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
  // @fails-if evaluation assistance or sealed hint counts are ignored in direct/legacy/sealed memory writes, or explicit self-report is dropped
  it('excludes assisted and unresolved judgments while preserving explicit self-report', async () => {
    const helped = await seedChain('helped', { kcs: ['kc_a'] });
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
    // Reproduce old persisted receipts: the sealed path must inspect plan provenance;
    // the legacy path must reconstruct the authoritative evaluation's assisted flag.
    const helpedReceipt = (await appliedEvents()).find(
      (e) => e.payload.submission_id === helped.submissionId,
    );
    if (!helpedReceipt) throw new Error('helped receipt missing');
    const helpedReceiptId = helpedReceipt.id;
    const helpedPlan = helpedReceipt.payload.replay_inputs as Record<string, unknown>;
    const helpedFact = SealedCandidateInputSchema.parse(helpedPlan.forgettingInput).fact;
    const oldPlan = {
      ...helpedPlan,
      forgettingSuppressed: false,
      forgettingInput: sealCandidateFact({ ...helpedFact, help: 'none' }),
    };
    const oldPayload = {
      ...helpedReceipt.payload,
      effect: 'applied',
      effects: { subjects: ['knowledge:kc_a'], fsrs_applied: ['knowledge:kc_a'] },
      replay_inputs: oldPlan,
    };
    async function expectHistoryExcluded(replayInputs: Record<string, unknown>) {
      const payload = { ...oldPayload, replay_inputs: replayInputs };
      const [sealedReceipt] = await testDb()
        .update(event)
        .set({ payload })
        .where(eq(event.id, helpedReceiptId))
        .returning();
      const state = await testDb().transaction((tx) =>
        candidateStateForRead(tx, { kind: 'knowledge', id: 'kc_a' }, NOW),
      );
      expect(state.global.projection.kind).toBe('cold');
      const [unchanged] = await testDb().select().from(event).where(eq(event.id, helpedReceiptId));
      expect(unchanged).toEqual(sealedReceipt);
    }
    await expectHistoryExcluded(oldPlan);
    await expectHistoryExcluded({
      ...oldPlan,
      provenance: { source: 'automatic', assisted: false },
      forgettingInput: sealCandidateFact({
        ...helpedFact,
        help: 'none',
        hints_used: 2,
        final_hint_level: 2,
      }),
    });
    const { forgettingInput: _sealed, ...legacyPlan } = oldPlan;
    await expectHistoryExcluded({
      ...legacyPlan,
      provenance: { source: 'automatic', assisted: false },
    });
    const self = await seedChain('self', {
      kcs: ['kc_a'],
      submittedAt: new Date(NOW.getTime() + DAY),
    });
    await seedEvaluation(self, 'self_eval', {
      aggregate: { kind: 'unresolved', reason: 'no_mapping', pending_units: [] },
      provenance: { source: 'automatic', assisted: true },
    });
    expect(
      await activate('self_eval', { effectiveId: null, generation: 0 }, undefined, 'hard'),
    ).toMatchObject({ effect: 'applied' });
    const beforeUnknown = await candidateRow();
    expect(beforeUnknown.state.global.projection).toMatchObject({ eventCount: 1 });
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
    // Seed a legacy bracket via explicit rating, then model its old judgment-only replay receipt.
    // The immutable evaluation remains assisted; late arrival must not recreate its two rows.
    await seedKnowledge('kc_b');
    await seedKnowledge('kc_c');
    vi.stubEnv('FORGETTING_ENGINE', 'fsrs');
    const legacy = await seedChain('legacy_helped', {
      submittedAt: new Date(NOW.getTime() + 4 * DAY),
      kcs: ['kc_b', 'kc_c'],
    });
    await seedEvaluation(legacy, 'legacy_helped_eval', {
      unitResults: [unitResult(`${legacy.qid}::u`, 1)],
      provenance: { source: 'automatic', assisted: true },
    });
    await activate('legacy_helped_eval', { effectiveId: null, generation: 0 }, undefined, 'good');
    const legacyReceipt = (await appliedEvents()).find(
      (e) => e.payload.submission_id === legacy.submissionId,
    );
    if (!legacyReceipt) throw new Error('legacy receipt missing');
    const {
      forgettingInput: _input,
      forgettingSuppressed: _suppressed,
      ...legacyInputs
    } = legacyReceipt.payload.replay_inputs as Record<string, unknown>;
    await testDb()
      .update(event)
      .set({
        payload: {
          ...legacyReceipt.payload,
          replay_inputs: {
            ...legacyInputs,
            ratingSource: 'verdict',
            provenance: { source: 'automatic', assisted: false },
          },
        },
      })
      .where(eq(event.id, legacyReceipt.id));
    vi.stubEnv('FORGETTING_ENGINE', 'forgetting_candidate');
    await seedScored('late_before_help', new Date(NOW.getTime() + 3 * DAY), 1, ['kc_b']);
    expect(
      await activate('late_before_help_eval', { effectiveId: null, generation: 0 }),
    ).toMatchObject({ effect: 'applied' });
    expect(
      (await testDb().select().from(material_fsrs_state)).map((r) => r.subject_id).sort(),
    ).toEqual(['kc_a', 'kc_b']);
    expect((await candidateRow('kc_b')).state.global.projection).toMatchObject({ eventCount: 1 });
  });

  // @invariant grading: partial-unknown settlement cannot write candidate memory, FSRS or ability evidence
  // @fails-if partial-unknown counts become candidate observations or a sealed unsupported verdict is replayed as scored evidence
  it('excludes partial-unknown scores from candidate settlement and sealed replay', async () => {
    const seed = await seedChain('partial_unknown', { kcs: ['kc_a'] });
    const unitId = `${seed.qid}::u`;
    await seedEvaluation(seed, 'partial_unknown_eval', {
      unitResults: [
        {
          status: 'scored',
          scoring_unit_id: unitId,
          points_awarded: null,
          scored_because: 'response',
          partial_unknown_points: { correct_count: 2, total_count: 3 },
        },
      ],
      aggregate: {
        kind: 'partial_unknown_points',
        known_points: 0,
        partial_units: [{ scoring_unit_id: unitId, correct_count: 2, total_count: 3 }],
      },
    });
    expect(
      await activate('partial_unknown_eval', { effectiveId: null, generation: 0 }),
    ).toMatchObject({ status: 'activated', effect: 'ineligible' });
    expect(await testDb().select().from(material_fsrs_state)).toEqual([]);
    expect(await testDb().select().from(mastery_state)).toEqual([]);
    const [receipt] = await appliedEvents();
    expect(receipt.payload).toMatchObject({
      rating: null,
      verdict: { verdict: 'unsupported', reason: 'partial_unknown_points' },
      effects: { fsrs_applied: [], theta_applied: [], family_observation_recorded: false },
      replay_inputs: {
        forgettingSuppressed: true,
        forgettingInput: {
          fact: { judgment: 'unknown' },
          adaptedEvidence: [{ kind: 'excluded' }],
        },
      },
    });
    // An old seal may have admitted a scored point; the verdict remains authoritative.
    const plan = receipt.payload.replay_inputs as Record<string, unknown>;
    const fact = SealedCandidateInputSchema.parse(plan.forgettingInput).fact;
    const [oldReceipt] = await testDb()
      .update(event)
      .set({
        payload: {
          ...receipt.payload,
          effect: 'applied',
          effects: { subjects: ['knowledge:kc_a'], fsrs_applied: ['knowledge:kc_a'] },
          replay_inputs: {
            ...plan,
            forgettingSuppressed: false,
            forgettingInput: sealCandidateFact({
              ...fact,
              judgment: 'admitted',
              points: [{ maximum: 1, earned: 1, shares: [{ skillId: 'kc_a', share: 1 }] }],
            }),
          },
        },
      })
      .where(eq(event.id, receipt.id))
      .returning();
    const state = await testDb().transaction((tx) =>
      candidateStateForRead(tx, { kind: 'knowledge', id: 'kc_a' }, NOW),
    );
    expect(state.global.projection.kind).toBe('cold');
    expect(await testDb().select().from(material_fsrs_state)).toEqual([]);
    expect(await testDb().select().from(mastery_state)).toEqual([]);
    expect((await testDb().select().from(event).where(eq(event.id, receipt.id)))[0]).toEqual(
      oldReceipt,
    );
  });

  // @invariant grading: due-list and copilot use the same selected due projection and preserve unknown retention metadata
  // @fails-if first independent failure bypasses one-day completion cooldown, reader clocks postpone it, or queue/tool counts diverge
  it('flips due boundaries across queue/tool readers and keeps cold states unknown', async () => {
    const seed = await seedScored('due', NOW, 0);
    await activate('due_eval', { effectiveId: null, generation: 0 });
    const row = await candidateRow();
    expect(row.due_at.getTime()).toBe(NOW.getTime() + DAY);
    expect(row.state).toMatchObject({
      modelDue: { kind: 'due_now', at: NOW.getTime() },
      dueKind: 'due_now',
    });
    // A pre-fix candidate row has no modelDue and an unconstrained persisted date.
    const { modelDue: _modelDue, ...legacyCandidate } = row.state;
    await testDb()
      .update(material_fsrs_state)
      .set({ state: { ...legacyCandidate, due: NOW }, due_at: NOW })
      .where(eq(material_fsrs_state.id, row.id));
    expect(
      (await queryReviewDue(testDb(), { now: new Date(NOW.getTime() + DAY / 2) })).rows,
    ).toHaveLength(0);
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
