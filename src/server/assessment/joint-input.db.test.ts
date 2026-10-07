import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  issueAssessment,
  revisionRowToContract,
} from '@/capabilities/practice/server/assessment/issue';
import {
  type SaveSubmissionRequest,
  saveSubmission,
} from '@/capabilities/practice/server/assessment/submit';
import {
  type EvaluateSubmissionRequest,
  evaluateSubmission,
} from '@/capabilities/practice/server/judge/evaluate-submission';
import {
  type ModelExecutorRequest,
  type ModelUnitOutcomeT,
  type SubmissionRecordT,
  projectFeedback,
} from '@/core/schema/assessment';
import {
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  evaluation_group,
  event,
  knowledge,
  mastery_state,
  material_fsrs_state,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { resolveVerdictForGroup } from '@/kernel/read-models/assessment-verdict';
import {
  type NormalizableQuestionRow,
  type PartRow,
  contractIntegrityDigest,
  normalizeQuestionGroupToContract,
} from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { activateEvaluation } from './activate';
import { learningSettlement } from './settle';

const NOW = new Date('2026-09-25T00:00:00Z');
const LATER = new Date('2026-09-25T00:00:01Z');
const EVIDENCE = {
  marking_provenance: 'official' as const,
  verification: { structural_check_passed: true, independent_verification: null },
  model_slice: null,
};

async function seed(opts: { model?: boolean; withheld?: boolean; saveCount?: number } = {}) {
  const db = testDb();
  await db.insert(knowledge).values({
    id: 'joint-kc',
    name: '控制变量与关系证据',
    domain: 'physics',
    approval_status: 'approved',
    proposed_by_ai: false,
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  });
  for (const [i, id] of ['joint-root', 'joint-p1', 'joint-p2'].entries()) {
    await db.insert(question).values({
      id,
      kind: 'choice',
      prompt_md:
        i === 0
          ? '雨水沿坡面流动。保持水量与材质，比较两组读数。\n|坡度|流速|\n|5°|2 m/s|\n|10°|4 m/s|\n材料中的两问共同解释控制变量与关系。'
          : `第${i}问：结合表中两组数据，选择有证据的关系陈述。`,
      reference_md: 'B',
      knowledge_ids: ['joint-kc'],
      parent_question_id: i === 0 ? null : 'joint-root',
      difficulty: 3,
      source: 'web_sourced',
      variant_depth: 0,
      choices_md: ['只考虑流速而忽略水量', '同水量与材质下比较坡度', '不需要第二组读数'],
      created_at: NOW,
      updated_at: NOW,
      version: 0,
    });
  }
  const rows = await db.select().from(question);
  const root = rows.find((row) => row.id === 'joint-root');
  if (!root) throw new Error('root');
  const contract = normalizeQuestionGroupToContract(
    root as NormalizableQuestionRow,
    ['joint-p1', 'joint-p2'].map((id) => rows.find((row) => row.id === id) as PartRow),
  );
  if (opts.model)
    for (const assignment of contract.execution_plan.assignments)
      assignment.executor = {
        kind: 'model_executor',
        task_kind: 'JevScoringDecisionTask',
        admitted_slice_id: 'test:joint-admitted',
      };
  contract.integrity_digest = contractIntegrityDigest(contract);
  const pub = await publishQuestionGroup(db, {
    group_id: root.id,
    contract,
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    admission: opts.withheld
      ? { state: 'withheld', reason: 'owner_hold' }
      : { state: 'admitted', evidence: EVIDENCE },
    actorRef: 'test:joint',
    now: NOW,
  });
  if (pub.status !== 'published') throw new Error(pub.status);
  const members: SubmissionRecordT[] = [];
  const requests: SaveSubmissionRequest[] = [];
  for (const [i, part] of contract.structure.parts.entries()) {
    const issued = await issueAssessment(db, {
      group_id: root.id,
      part_ids: [part.part_id],
      mode: opts.withheld ? 'manual' : 'auto_score',
      now: NOW,
    });
    if (issued.status !== 'issued') throw new Error(issued.status);
    const slot = contract.response_spec.slots.find((slot) => slot.part_id === part.part_id);
    if (slot?.kind !== 'single_choice') throw new Error('choice');
    const request: SaveSubmissionRequest = {
      issuance_id: issued.issuance.issuance_id,
      evaluation_group_id: 'joint-attempt',
      idempotency_key: part.part_id,
      response_set: {
        entries: [
          { slot_id: slot.slot_id, kind: 'choice', option_ids: [slot.options[1].option_id] },
        ],
      },
      now: i === 0 ? NOW : LATER,
    };
    requests.push(request);
    if (i < (opts.saveCount ?? 2)) {
      const saved = await saveSubmission(db, request);
      if (saved.status !== 'saved') throw new Error(saved.status);
      members.push(saved.submission);
    }
  }
  return { members, requests, contract, pub };
}
type Seed = Awaited<ReturnType<typeof seed>>;
function evaluate(s: Seed, extra: Partial<EvaluateSubmissionRequest> = {}) {
  return evaluateSubmission(testDb(), {
    submission_id: s.members.at(-1)?.submission_id ?? '',
    evaluation_group_id: 'joint-attempt',
    expected_submission_ids: s.members.map((m) => m.submission_id),
    ...extra,
  });
}
function activate(id: string, previous: string | null = null, generation = 0) {
  return testDb().transaction((tx) =>
    activateEvaluation(
      tx,
      { evaluation_id: id, expected_effective_id: previous, expected_generation: generation },
      { settle: learningSettlement, now: new Date('2026-10-04T00:00:00Z') },
    ),
  );
}
async function noLearning() {
  const [head] = await testDb().select().from(evaluation_effective_head);
  expect(head).toMatchObject({ generation: 0, effective_evaluation_id: null });
  expect(await testDb().select().from(material_fsrs_state)).toEqual([]);
  expect(await testDb().select().from(mastery_state)).toEqual([]);
  expect(
    await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_activation')),
  ).toEqual([]);
}
const scored = (): Promise<ModelUnitOutcomeT> =>
  Promise.resolve({ kind: 'scored', points_awarded: 1, evidence_citations: [], run_refs: [] });

describe('YUK-1091 frozen joint input', () => {
  beforeEach(resetDb);

  it('model context keeps the issued question and native options after a newer revision is published', async () => {
    const s = await seed({ model: true });
    const updated = structuredClone(s.contract);
    updated.structure.parts[0].prompt_md = '新版本完全不同的题面：请解释电路中的电流关系。';
    const slot = updated.response_spec.slots[0];
    if (slot.kind !== 'single_choice') throw new Error('choice fixture required');
    slot.options[1].text = '新版本选项，不得解释旧作答中的同一个option ID。';
    updated.integrity_digest = contractIntegrityDigest(updated);
    const next = await publishQuestionGroup(testDb(), {
      group_id: 'joint-root',
      contract: updated,
      expectedCurrentRevision: s.pub.revision_id,
      expectedAdmissionGeneration: s.pub.admission_generation,
      availability: 'general_pool',
      admission: { state: 'admitted', evidence: EVIDENCE },
      actorRef: 'test:context-republish',
      now: LATER,
    });
    expect(next.status).toBe('published');
    const originalSubmissions = await testDb().select().from(assessment_submission);
    const requests: ModelExecutorRequest[] = [];
    await evaluate(s, {
      model_executor: async (request) => {
        requests.push(request);
        return scored();
      },
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.revision_id).toBe(s.pub.revision_id);
      const part = s.contract.structure.parts.find(
        (part) => part.part_id === request.question_parts[0]?.part_id,
      );
      expect(part).toBeDefined();
      expect(request.question_parts).toEqual([part]);
      expect(request.response_slots).toEqual(
        s.contract.response_spec.slots.filter((slot) => slot.part_id === part?.part_id),
      );
      expect(JSON.stringify(request)).not.toContain('新版本');
    }
    expect(await testDb().select().from(assessment_submission)).toEqual(originalSubmissions);
    await noLearning();
  });

  it('scores both members through the fixed anchor, settles once per KC and reads the full denominator', async () => {
    const s = await seed();
    const before = await testDb().select().from(assessment_submission);
    const candidate = await evaluate(s);
    expect(candidate.record.submission_id).toBe(s.members[0].submission_id);
    expect(candidate.record.unit_results).toHaveLength(2);
    expect(candidate.record.aggregate).toMatchObject({ points: 2 });
    const [revision] = await testDb()
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, s.pub.revision_id));
    const feedback = projectFeedback(
      s.members[1],
      candidate.record,
      revisionRowToContract(revision),
      {
        reveal_total_score: true,
        reveal_unit_breakdown: true,
        reveal_answer_keys: true,
        reveal_rubric_explanations: false,
      },
    );
    expect(feedback.member_submission_ids).toEqual(s.members.map((m) => m.submission_id).sort());
    expect(feedback.unit_results).toHaveLength(2);
    expect(() =>
      projectFeedback(
        { ...s.members[1], submission_id: 'outsider' },
        candidate.record,
        revisionRowToContract(revision),
        {
          reveal_total_score: true,
          reveal_unit_breakdown: true,
          reveal_answer_keys: true,
          reveal_rubric_explanations: true,
        },
      ),
    ).toThrow();

    expect(candidate.record.provenance?.input_snapshot).toMatchObject({
      member_submission_ids: s.members.map((m) => m.submission_id).sort(),
      issued_part_ids: ['joint-p1', 'joint-p2'],
      occurrence_at: LATER.toISOString(),
    });
    expect((await activate(candidate.record.evaluation_id)).status).toBe('activated');
    expect(
      (await resolveVerdictForGroup(testDb(), 'joint-attempt')).effective?.verdict,
    ).toMatchObject({ maxPoints: 2, normalized: 1, verdict: 'correct' });
    const [receipt] = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_settlement'));
    expect(receipt.payload).toMatchObject({
      scope_version: 3,
      replay_inputs: {
        occurrenceAt: LATER.toISOString(),
        kcObservations: [{ kc_id: 'joint-kc', bit: 1 }],
      },
    });
    const mastery = await testDb().select().from(mastery_state);
    expect(mastery.find((row) => row.subject_id === 'joint-kc')).toMatchObject({
      evidence_count: 1,
    });
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(1);
    expect((await activate(candidate.record.evaluation_id)).status).toBe('already_effective');
    const next = await evaluate(s, { submission_id: s.members[0].submission_id });
    expect(next.record.attempt).toBe(2);
    expect(next.record.provenance?.input_snapshot).toEqual(
      candidate.record.provenance?.input_snapshot,
    );
    expect(
      (await activate(next.record.evaluation_id, candidate.record.evaluation_id, 1)).status,
    ).toBe('activated');
    expect(
      (await testDb().select().from(mastery_state)).find((row) => row.subject_id === 'joint-kc'),
    ).toMatchObject({ evidence_count: 1 });
    expect(await testDb().select().from(assessment_submission)).toEqual(before);
  });

  it.each(['omitted', 'partial', 'duplicate', 'phantom'])(
    'rejects %s member selection before executor or candidate writes',
    async (scenario) => {
      const s = await seed({ model: true });
      const ids = s.members.map((m) => m.submission_id);
      const selected =
        scenario === 'omitted'
          ? undefined
          : scenario === 'partial'
            ? [ids[1]]
            : scenario === 'duplicate'
              ? [...ids, ids[0]]
              : [...ids, 'not-a-member'];
      const executor = vi.fn(scored);
      await expect(
        evaluate(s, { expected_submission_ids: selected, model_executor: executor }),
      ).rejects.toMatchObject({ code: 'group_membership_mismatch' });
      expect(executor).not.toHaveBeenCalled();
      expect(await testDb().select().from(evaluation)).toEqual([]);
      await noLearning();
    },
  );

  it('seals even a pending candidate, rejects new answers, and preserves the original idempotent replay', async () => {
    const s = await seed({ model: true, saveCount: 1 });
    const candidate = await evaluate(s);
    expect(candidate.record.status).toBe('pending');
    expect((await saveSubmission(testDb(), s.requests[1])).status).toBe('group_conflict');
    expect((await saveSubmission(testDb(), s.requests[0])).status).toBe('replayed');
    const [row] = await testDb().select().from(assessment_submission);
    await expect(
      testDb()
        .insert(assessment_submission)
        .values({ ...row, submission_id: 'raw-late', idempotency_key: 'raw-late' }),
    ).rejects.toThrow();
    expect(await testDb().select().from(assessment_submission)).toHaveLength(1);
    await noLearning();
  });

  it('serializes an append queued while the model is scoring and rejects it after input freeze', async () => {
    const s = await seed({ model: true, saveCount: 1 });
    let entered!: () => void;
    const atModel = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const evaluating = evaluate(s, {
      model_executor: async () => {
        entered();
        await resume;
        return scored();
      },
    });
    await atModel;
    let finished = false;
    const appending = saveSubmission(testDb(), s.requests[1]).finally(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(finished).toBe(false);
    release();
    await evaluating;
    expect((await appending).status).toBe('group_conflict');
    expect(await testDb().select().from(assessment_submission)).toHaveLength(1);
  });

  it('allocates canonical attempts when different members are evaluated concurrently', async () => {
    const s = await seed();
    const results = await Promise.all(
      s.members.map((m) => evaluate(s, { submission_id: m.submission_id })),
    );
    expect(results.map((r) => r.record.attempt).sort()).toEqual([1, 2]);
    expect(new Set(results.map((r) => r.record.submission_id))).toEqual(
      new Set([s.members[0].submission_id]),
    );
    for (const result of results) expect(result.record.unit_results).toHaveLength(2);
  });

  it.each(['missing', 'wrong_digest', 'partial_scope'])(
    'holds a stored joint candidate with %s input proof and leaves it unchanged',
    async (scenario) => {
      const s = await seed();
      const candidate = await evaluate(s);
      const [row] = await testDb().select().from(evaluation);
      const proof = candidate.record.provenance?.input_snapshot;
      const forged =
        scenario === 'missing'
          ? null
          : {
              ...proof,
              ...(scenario === 'wrong_digest'
                ? { digest: `sha256:${'0'.repeat(64)}` }
                : { issued_part_ids: ['joint-p1'] }),
            };
      const old = {
        ...row,
        evaluation_id: 'historical-joint',
        attempt: 2,
        provenance: { ...row.provenance, input_snapshot: forged },
      };
      await testDb().insert(evaluation).values(old);
      expect((await activate(old.evaluation_id)).status).toBe('coordinate_mismatch');
      await noLearning();
      expect(
        (
          await testDb()
            .select()
            .from(evaluation)
            .where(eq(evaluation.evaluation_id, old.evaluation_id))
        )[0],
      ).toEqual(old);
    },
  );

  it('overwrites caller input proof with actual members and rejects overlapping alternative answers', async () => {
    const s = await seed();
    const candidate = await evaluate(s, {
      provenance: {
        source: 'automatic',
        assisted: false,
        input_snapshot: {
          version: 1,
          revision_id: 'forged',
          member_submission_ids: ['forged'],
          issued_part_ids: ['forged'],
          occurrence_at: NOW.toISOString(),
          digest: `sha256:${'0'.repeat(64)}`,
        },
      },
    });
    expect(candidate.record.provenance?.input_snapshot?.revision_id).toBe(s.pub.revision_id);
    // A distinct attempt group may accept original responses, but alternative
    // answers to overlapping scopes cannot masquerade as a joint score.
    const a = await saveSubmission(testDb(), {
      ...s.requests[0],
      evaluation_group_id: 'alternatives',
      idempotency_key: 'a',
    });
    const b = await saveSubmission(testDb(), {
      ...s.requests[0],
      evaluation_group_id: 'alternatives',
      idempotency_key: 'b',
    });
    if (a.status !== 'saved' || b.status !== 'saved') throw new Error('save alternatives');
    await expect(
      evaluateSubmission(testDb(), {
        submission_id: a.submission.submission_id,
        evaluation_group_id: 'alternatives',
        expected_submission_ids: [a.submission.submission_id, b.submission.submission_id],
      }),
    ).rejects.toMatchObject({ code: 'invalid_group_input' });
    expect(await testDb().select().from(assessment_submission)).toHaveLength(4);
  });

  it.each(['manual', 'self_report'] as const)(
    'preserves explicit %s joint assertions while withheld, without theta',
    async (source) => {
      const s = await seed({ withheld: true });
      const candidate = await evaluate(s, {
        mode: 'manual_assert',
        provenance: { source, assisted: false },
        asserted_unit_results: s.contract.scoring_basis.units.map((unit) => ({
          status: 'scored',
          scoring_unit_id: unit.scoring_unit_id,
          points_awarded: unit.points,
          scored_because: 'response',
          evidence_citations: [],
        })),
      });
      expect((await activate(candidate.record.evaluation_id)).status).toBe('activated');
      expect(await testDb().select().from(material_fsrs_state)).toHaveLength(1);
      expect(await testDb().select().from(mastery_state)).toEqual([]);
      await testDb()
        .update(question_group_lifecycle)
        .set({ suspended: true, suspension_reason: 'verify_hold' })
        .where(eq(question_group_lifecycle.group_id, 'joint-root'));
      expect((await activate(candidate.record.evaluation_id)).status).toBe('already_effective');
    },
  );

  it('feedback reveals only the issued scope of a newly frozen single-member input', async () => {
    const s = await seed({ saveCount: 1 });
    const candidate = await evaluate(s);
    const [revision] = await testDb()
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, s.pub.revision_id));
    const feedback = projectFeedback(
      s.members[0],
      candidate.record,
      revisionRowToContract(revision),
      {
        reveal_total_score: true,
        reveal_unit_breakdown: true,
        reveal_answer_keys: true,
        reveal_rubric_explanations: true,
      },
    );
    expect(feedback.answer_keys.map((key) => key.scoring_unit_id)).toEqual(['joint-p1::u']);
    expect(feedback.unit_results.map((unit) => unit.scoring_unit_id)).toEqual(['joint-p1::u']);
  });

  it('keeps acknowledged mixed-revision members but refuses to score them under the first plan', async () => {
    const s = await seed({ saveCount: 1 });
    const nextContract = structuredClone(s.contract);
    nextContract.structure.parts[1].prompt_md += ' 新的题面要求。';
    nextContract.integrity_digest = contractIntegrityDigest(nextContract);
    const next = await publishQuestionGroup(testDb(), {
      group_id: 'joint-root',
      contract: nextContract,
      expectedCurrentRevision: s.pub.revision_id,
      expectedAdmissionGeneration: s.pub.admission_generation,
      availability: 'general_pool',
      admission: { state: 'admitted', evidence: EVIDENCE },
      actorRef: 'test:new-version',
      now: LATER,
    });
    if (next.status !== 'published') throw new Error(next.status);
    const issued = await issueAssessment(testDb(), {
      group_id: 'joint-root',
      part_ids: ['joint-p2'],
      now: LATER,
    });
    if (issued.status !== 'issued') throw new Error(issued.status);
    const second = await saveSubmission(testDb(), {
      ...s.requests[1],
      issuance_id: issued.issuance.issuance_id,
    });
    if (second.status !== 'saved') throw new Error(second.status);
    s.members.push(second.submission);
    await expect(evaluate(s)).rejects.toMatchObject({ code: 'invalid_group_input' });
    expect(await testDb().select().from(assessment_submission)).toHaveLength(2);
    expect(await testDb().select().from(evaluation)).toEqual([]);
    await noLearning();
  });

  it('refuses phantom declared membership instead of silently narrowing the group', async () => {
    const s = await seed();
    await testDb().transaction(async (tx) => {
      await tx.execute(sql`set local app.assessment_restore_mode = 'on'`);
      await tx
        .update(evaluation_group)
        .set({ submission_ids: [...s.members.map((m) => m.submission_id), 'phantom'] })
        .where(eq(evaluation_group.evaluation_group_id, 'joint-attempt'));
    });
    await expect(evaluate(s)).rejects.toMatchObject({ code: 'group_membership_mismatch' });
    await noLearning();
  });

  it('preserves the established restore bypass for acknowledged historical members', async () => {
    const s = await seed({ saveCount: 1 });
    await evaluate(s);
    const [row] = await testDb().select().from(assessment_submission);
    await testDb().transaction(async (tx) => {
      await tx.execute(sql`set local app.assessment_restore_mode = 'on'`);
      await tx
        .insert(assessment_submission)
        .values({ ...row, submission_id: 'restored-history', idempotency_key: 'restored-history' });
    });
    expect(await testDb().select().from(assessment_submission)).toHaveLength(2);
  });
});

describe('joint occurrence settlement', () => {
  beforeEach(resetDb);
  it('uses last-member time for actual receipt and learning writes', async () => {
    const s = await seed();
    const candidate = await evaluate(s);
    expect((await activate(candidate.record.evaluation_id)).status).toBe('activated');
    const [receipt] = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_settlement'));
    expect.soft(receipt.payload).toMatchObject({ occurrence_at: LATER.toISOString() });
    const [fsrs] = await testDb().select().from(material_fsrs_state);
    const lastReview = fsrs.state.last_review;
    if (lastReview === null) throw new Error('settlement must persist an FSRS review time');
    expect.soft(new Date(lastReview).toISOString()).toBe(LATER.toISOString());
    const mastery = await testDb().select().from(mastery_state);
    expect(mastery).toHaveLength(2);
    for (const row of mastery)
      expect.soft(row.last_outcome_at?.toISOString()).toBe(LATER.toISOString());
  });
});

describe('joint occurrence replay boundary', () => {
  beforeEach(resetDb);
  it('orders an intervening occurrence before the joint occurrence, including regrade', async () => {
    const db = testDb();
    const s = await seed();
    const joint = await evaluate(s);
    expect((await activate(joint.record.evaluation_id)).status).toBe('activated');
    const mid = new Date(NOW.getTime() + 500);
    const saved = await saveSubmission(db, {
      ...s.requests[0],
      evaluation_group_id: 'between',
      idempotency_key: 'mid',
      now: mid,
    });
    if (saved.status !== 'saved') throw new Error(saved.status);
    const candidate = await evaluateSubmission(db, {
      submission_id: saved.submission.submission_id,
      evaluation_group_id: 'between',
    });
    expect((await activate(candidate.record.evaluation_id)).status).toBe('activated');
    const receipts = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_settlement'));
    expect.soft(receipts.filter((r) => r.payload.replay_of)).toHaveLength(1);
    for (const row of await db.select().from(mastery_state))
      expect.soft(row.last_outcome_at?.toISOString()).toBe(LATER.toISOString());
    const next = await evaluate(s);
    expect((await activate(next.record.evaluation_id, joint.record.evaluation_id, 1)).status).toBe(
      'activated',
    );
    for (const row of await db.select().from(mastery_state)) {
      expect.soft(row.last_outcome_at?.toISOString()).toBe(LATER.toISOString());
      expect.soft(row.evidence_count).toBe(2);
    }
  });
});
