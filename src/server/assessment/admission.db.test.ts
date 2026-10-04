import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { issueAssessment } from '@/capabilities/practice/server/assessment/issue';
import { saveSubmission } from '@/capabilities/practice/server/assessment/submit';
import {
  type EvaluateSubmissionRequest,
  evaluateSubmission,
} from '@/capabilities/practice/server/judge/evaluate-submission';
import type { ModelUnitOutcomeT } from '@/core/schema/assessment';
import {
  evaluation,
  evaluation_effective_head,
  event,
  mastery_state,
  material_fsrs_state,
  question,
  question_group_lifecycle,
} from '@/db/schema';
import {
  type NormalizableQuestionRow,
  contractIntegrityDigest,
  normalizeQuestionRowToContract,
} from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { activateEvaluation } from './activate';
import { learningSettlement } from './settle';

const NOW = new Date('2026-10-04T00:00:00.000Z');
const EVIDENCE = {
  marking_provenance: 'official' as const,
  verification: { structural_check_passed: true, independent_verification: null },
  model_slice: null,
};

async function seed(opts: { withheld?: boolean; model?: boolean } = {}) {
  const db = testDb();
  await db.insert(question).values({
    id: 'admission-q',
    kind: 'choice',
    prompt_md:
      '雨水沿坡面流动。保持水量与表面材质，改变坡度。\n|坡度|流速|\n|5°|0.4 m/s|\n|10°|0.8 m/s|\n哪项是受控变量？',
    reference_md: 'B',
    choices_md: ['坡度', '水量与材质', '测得的流速'],
    knowledge_ids: [],
    difficulty: 3,
    source: 'web_sourced',
    variant_depth: 0,
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  });
  const [row] = await db.select().from(question).where(eq(question.id, 'admission-q'));
  const contract = normalizeQuestionRowToContract(row as NormalizableQuestionRow);
  if (opts.model)
    contract.execution_plan.assignments[0].executor = {
      kind: 'model_executor',
      task_kind: 'JevScoringDecisionTask',
      admitted_slice_id: 'test:admitted-slice',
    };
  contract.integrity_digest = contractIntegrityDigest(contract);
  const published = await publishQuestionGroup(db, {
    group_id: row.id,
    contract,
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    admission: opts.withheld
      ? { state: 'withheld', reason: 'owner_hold' }
      : { state: 'admitted', evidence: EVIDENCE },
    actorRef: 'test:admission',
    now: NOW,
  });
  if (published.status !== 'published') throw new Error(published.status);
  const issued = await issueAssessment(db, {
    group_id: row.id,
    mode: opts.withheld ? 'manual' : 'auto_score',
    now: NOW,
  });
  if (issued.status !== 'issued') throw new Error(issued.status);
  const slot = contract.response_spec.slots[0];
  if (slot.kind !== 'single_choice') throw new Error('expected choice');
  const saved = await saveSubmission(db, {
    issuance_id: issued.issuance.issuance_id,
    evaluation_group_id: 'admission-group',
    idempotency_key: 'confirmed-answer',
    response_set: {
      entries: [{ slot_id: slot.slot_id, kind: 'choice', option_ids: [slot.options[1].option_id] }],
    },
    now: NOW,
  });
  if (saved.status !== 'saved') throw new Error(saved.status);
  return { row, contract, published, issued, saved };
}
type Seed = Awaited<ReturnType<typeof seed>>;

function evaluate(s: Seed, extra: Partial<EvaluateSubmissionRequest> = {}) {
  return evaluateSubmission(testDb(), {
    submission_id: s.saved.submission.submission_id,
    evaluation_group_id: 'admission-group',
    ...extra,
  });
}
function activate(id: string, observed?: number) {
  return testDb().transaction((tx) =>
    activateEvaluation(
      tx,
      {
        evaluation_id: id,
        expected_effective_id: null,
        expected_generation: 0,
        ...(observed === undefined ? {} : { admission_generation_observed: observed }),
      },
      { settle: learningSettlement, now: NOW },
    ),
  );
}
async function changeAdmission(s: Seed, state: 'admitted' | 'withheld') {
  const [current] = await testDb()
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, s.row.id));
  return publishQuestionGroup(testDb(), {
    group_id: s.row.id,
    contract: s.contract,
    expectedCurrentRevision: current.current_revision_id,
    expectedAdmissionGeneration: current.scoring_admission_generation,
    availability: 'general_pool',
    admission:
      state === 'admitted' ? { state, evidence: EVIDENCE } : { state, reason: 'owner_hold' },
    actorRef: 'test:verify',
    now: NOW,
  });
}
async function expectNoActivation() {
  const [head] = await testDb()
    .select()
    .from(evaluation_effective_head)
    .where(eq(evaluation_effective_head.evaluation_group_id, 'admission-group'));
  expect(head).toMatchObject({ effective_evaluation_id: null, generation: 0 });
  expect(
    await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_activation')),
  ).toEqual([]);
  expect(await testDb().select().from(material_fsrs_state)).toEqual([]);
  expect(await testDb().select().from(mastery_state)).toEqual([]);
}

describe('YUK-1045 authoritative candidate admission snapshot', () => {
  beforeEach(resetDb);

  it('stores the actual admission snapshot and activates without a caller-supplied token', async () => {
    const s = await seed();
    const candidate = await evaluate(s);
    expect(candidate.record.provenance).toMatchObject({
      admission_snapshot: {
        current_revision_id: s.published.revision_id,
        generation: s.published.admission_generation,
        state: 'admitted',
        suspended: false,
        withdrawn: false,
      },
    });
    const [stored] = await testDb()
      .select()
      .from(evaluation)
      .where(eq(evaluation.evaluation_id, candidate.record.evaluation_id));
    expect(stored.provenance).toEqual(candidate.record.provenance);
    expect((await activate(candidate.record.evaluation_id)).status).toBe('activated');
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(1);
  });

  it.each(['withheld', 'generation_changed'])(
    'holds automatic candidates after %s with no caller token',
    async (scenario) => {
      const s = await seed();
      const candidate = await evaluate(s);
      if (scenario === 'withheld') await changeAdmission(s, 'withheld');
      else
        await testDb()
          .update(question_group_lifecycle)
          .set({ scoring_admission_generation: s.published.admission_generation + 1 })
          .where(eq(question_group_lifecycle.group_id, s.row.id));
      expect((await activate(candidate.record.evaluation_id)).status).toBe('stale_admission');
      await expectNoActivation();
    },
  );

  it('cannot repair stale candidate evidence by supplying the current generation', async () => {
    const s = await seed();
    const candidate = await evaluate(s);
    await changeAdmission(s, 'withheld');
    await changeAdmission(s, 'admitted');
    const [current] = await testDb()
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, s.row.id));
    expect(
      (await activate(candidate.record.evaluation_id, current.scoring_admission_generation)).status,
    ).toBe('stale_admission');
    await expectNoActivation();
    const fresh = await evaluate(s);
    expect((await activate(fresh.record.evaluation_id)).status).toBe('activated');
  });

  it.each(['manual', 'self_report'] as const)(
    'rejects executed scoring labeled as %s without model or learning writes',
    async (source) => {
      const s = await seed({ withheld: true, model: true });
      const model_executor = vi.fn(
        async (): Promise<ModelUnitOutcomeT> => ({
          kind: 'scored',
          points_awarded: s.contract.scoring_basis.units[0].points,
          evidence_citations: [],
          run_refs: [],
        }),
      );
      for (const mode of [undefined, 'execute'] as const) {
        await expect(
          evaluate(s, { mode, provenance: { source, assisted: false }, model_executor }),
        ).rejects.toMatchObject({ code: 'execute_mode_requires_automatic_provenance' });
      }
      expect(model_executor).not.toHaveBeenCalled();
      expect(await testDb().select().from(evaluation)).toEqual([]);
      await expectNoActivation();
    },
  );

  it('persists an automatic candidate while withheld but never settles it', async () => {
    const s = await seed({ withheld: true });
    const candidate = await evaluate(s);
    expect(candidate.record.status).toBe('completed');
    expect(
      (await activate(candidate.record.evaluation_id, s.published.admission_generation)).status,
    ).toBe('stale_admission');
    await expectNoActivation();
  });

  it.each([false, true])(
    'keeps historical candidates without a snapshot held (legacy token=%s)',
    async (legacyToken) => {
      const s = await seed();
      const candidate = await evaluate(s);
      const [original] = await testDb()
        .select()
        .from(evaluation)
        .where(eq(evaluation.evaluation_id, candidate.record.evaluation_id));
      const historical = {
        ...original,
        evaluation_id: 'historical-candidate',
        attempt: 2,
        provenance: {
          source: 'automatic',
          assisted: false,
          ...(legacyToken ? { admission_generation: s.published.admission_generation } : {}),
        },
      };
      await testDb().insert(evaluation).values(historical);
      expect(
        (await activate(historical.evaluation_id, s.published.admission_generation)).status,
      ).toBe('stale_admission');
      await expectNoActivation();
      const [unchanged] = await testDb()
        .select()
        .from(evaluation)
        .where(eq(evaluation.evaluation_id, historical.evaluation_id));
      expect(unchanged).toEqual(historical);
    },
  );

  it.each(['manual', 'self_report'] as const)(
    'preserves explicit %s FSRS without admitted marking rules',
    async (source) => {
      const s = await seed({ withheld: true });
      const candidate = await evaluate(s, {
        mode: 'manual_assert',
        provenance: { source, assisted: false },
        asserted_unit_results: [
          {
            scoring_unit_id: s.contract.scoring_basis.units[0].scoring_unit_id,
            status: 'scored',
            points_awarded: 1,
            scored_because: 'response',
            evidence_citations: [],
          },
        ],
      });
      expect((await activate(candidate.record.evaluation_id)).status).toBe('activated');
      expect(await testDb().select().from(material_fsrs_state)).toHaveLength(1);
      expect(await testDb().select().from(mastery_state)).toEqual([]);
    },
  );

  it('keeps already-effective replay idempotent after admission is withdrawn', async () => {
    const s = await seed();
    const candidate = await evaluate(s);
    expect((await activate(candidate.record.evaluation_id)).status).toBe('activated');
    const before = await testDb().select().from(material_fsrs_state);
    await changeAdmission(s, 'withheld');
    expect(await activate(candidate.record.evaluation_id)).toMatchObject({
      status: 'already_effective',
      effect: 'idempotent_replay',
    });
    expect(await testDb().select().from(material_fsrs_state)).toEqual(before);
  });

  it('holds a candidate if its lifecycle disappears instead of treating it as a legacy bypass', async () => {
    const s = await seed();
    const candidate = await evaluate(s);
    await testDb()
      .delete(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, s.row.id));
    expect((await activate(candidate.record.evaluation_id)).status).toBe('stale_admission');
    await expectNoActivation();
  });

  it('captures admission before the executor runs, so a concurrent verification cannot refresh it', async () => {
    const s = await seed({ model: true });
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const pending = evaluate(s, {
      model_executor: async () => {
        entered.resolve();
        await finish.promise;
        return {
          kind: 'scored',
          points_awarded: 1,
          matched: { option_ids: [] },
          evidence_citations: [],
          run_refs: [],
        } satisfies ModelUnitOutcomeT;
      },
    });
    try {
      await entered.promise;
      await changeAdmission(s, 'withheld');
    } finally {
      finish.resolve();
    }
    const candidate = await pending;
    expect(candidate.record.provenance).toMatchObject({
      admission_snapshot: { generation: s.published.admission_generation, state: 'admitted' },
    });
    expect((await activate(candidate.record.evaluation_id)).status).toBe('stale_admission');
    await expectNoActivation();
  });

  it('overwrites caller-supplied admission metadata with the real server observation', async () => {
    const s = await seed({ withheld: true });
    const forged = {
      source: 'automatic' as const,
      assisted: false,
      admission_snapshot: {
        current_revision_id: s.published.revision_id,
        generation: s.published.admission_generation,
        state: 'admitted' as const,
        suspended: false,
        withdrawn: false,
      },
    };
    const candidate = await evaluate(s, { provenance: forged });
    expect(candidate.record.provenance).toMatchObject({
      admission_snapshot: { state: 'withheld' },
    });
    expect((await activate(candidate.record.evaluation_id)).status).toBe('stale_admission');
    await expectNoActivation();
  });

  it('cannot activate old revision grading under the replacement revision admission', async () => {
    const s = await seed();
    const candidate = await evaluate(s);
    const revised = normalizeQuestionRowToContract({
      ...s.row,
      prompt_md: '改用另一种材质；新的规则版本',
    } as NormalizableQuestionRow);
    const replaced = await publishQuestionGroup(testDb(), {
      group_id: s.row.id,
      contract: revised,
      expectedCurrentRevision: s.published.revision_id,
      expectedAdmissionGeneration: s.published.admission_generation,
      availability: 'general_pool',
      admission: { state: 'admitted', evidence: EVIDENCE },
      actorRef: 'test:replace',
      now: NOW,
    });
    if (replaced.status !== 'published') throw new Error(replaced.status);
    expect(
      (await activate(candidate.record.evaluation_id, replaced.admission_generation)).status,
    ).toBe('stale_admission');
    await expectNoActivation();
    const freshOldRevisionCandidate = await evaluate(s);
    expect((await activate(freshOldRevisionCandidate.record.evaluation_id)).status).toBe(
      'stale_admission',
    );
    await expectNoActivation();
  });
});
