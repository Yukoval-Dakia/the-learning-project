import { previewFormalAttempt } from './assessment/attempt';
// YUK-1047 — evaluateSubmission 持久化路径 DB 测试（testcontainer Postgres）。
//
// 断言（§4.3 Interface + grounding §4.2）：
//   1. 冻结输入（submission + published revision + issuance）→ candidate
//      evaluation 行落库；(submission_id, attempt) 单调递增；
//   2. 坐标不一致（submission.group ≠ 请求 group）⇒ fail-closed 拒绝；
//   3. retryable infra_failure ⇒ 记录 pending + aggregate=null，下一次调用
//      产生 attempt+1 的恢复尝试；
//   4. evaluateAttempt contract lane 端到端（登记 → 落库 → 投影）；
//   5. 绝不触碰 evaluation_effective_head（activation = YUK-1045 的范围）。

import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateSubmission } from '@/capabilities/practice/server/judge/evaluate-submission';
import {
  evaluateAttempt,
  projectEvaluationToJudgeResult,
} from '@/capabilities/practice/server/judge/evaluation-authority';
import { canonicalHash } from '@/core/migration/canonical';
import type {
  ExecutionPlanT,
  ResponseSetT,
  ResponseSpecT,
  ScoringBasisT,
  ScoringUnitResultT,
} from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  evaluation_group,
  question_revision,
} from '@/db/schema';
import { resolveVerdictsForGroups } from '@/kernel/read-models/assessment-verdict';
import { resetDb, testDb } from '../../../../tests/helpers/db';

let db: Db = testDb();
beforeEach(async () => {
  await resetDb();
  db = testDb();
});

const NOW = new Date('2026-09-25T00:00:00.000Z');

// ---------- fixture 构造（镜像 apply.db.test.ts 的 contract-row 形状） ----------

interface SeedSpec {
  groupId: string;
  revisionId: string;
  issuanceId: string;
  submissionId: string;
  evalGroupId: string;
  slots?: ResponseSpecT['slots'];
  units?: ScoringBasisT['units'];
  assignments?: ExecutionPlanT['assignments'];
  entries?: ResponseSetT['entries'];
  partIds?: string[];
  blankScoresZero?: boolean;
  issuedPartIds?: string[];
  aggregation?: ScoringBasisT['aggregation'];
}

async function seedContractChain(spec: SeedSpec): Promise<void> {
  const partId = 'p1';
  const slots = spec.slots ?? [
    {
      slot_id: `${partId}::r`,
      part_id: partId,
      kind: 'single_choice',
      options: [
        { option_id: 'opt-a', label: 'A', text: 'alpha' },
        { option_id: 'opt-b', label: 'B', text: 'beta' },
      ],
    },
  ];
  const units = spec.units ?? [
    {
      scoring_unit_id: `${partId}::u`,
      slot_refs: [`${partId}::r`],
      material_refs: [],
      evidence_slot_refs: [],
      requires_group_evidence: false,
      criterion: {
        kind: 'option_set_key',
        accepted_option_ids: ['opt-a'],
      },
      points: 4,
    },
  ];
  const assignments = spec.assignments ?? [
    {
      scoring_unit_ids: [`${partId}::u`],
      executor: { kind: 'deterministic', comparator: 'exact_option_set' },
    },
  ];
  const partIds = spec.partIds ?? [partId];

  await testDb()
    .insert(question_revision)
    .values({
      revision_id: spec.revisionId,
      group_id: spec.groupId,
      revision_ordinal: 1,
      integrity_digest: canonicalHash({ revision: spec.revisionId }),
      structure: {
        group_id: spec.groupId,
        materials: [],
        parts: partIds.map((pid) => ({ part_id: pid, prompt_md: 'pick one', material_ids: [] })),
      },
      response_spec: { slots },
      scoring_basis: {
        units,
        aggregation: spec.aggregation ?? { kind: 'sum' },
        blank_scores_zero: spec.blankScoresZero ?? true,
      },
      execution_plan: {
        plan_version: 1,
        assignments,
        escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
      },
      supersedes_revision_id: null,
      availability: 'general_pool',
      published_by: null,
      published_at: NOW,
    });

  await testDb()
    .insert(assessment_issuance)
    .values({
      issuance_id: spec.issuanceId,
      revision_id: spec.revisionId,
      part_ids: spec.issuedPartIds ?? partIds,
      material_bindings: [],
      option_order: [{ slot_id: `${partIds[0]}::r`, option_ids: ['opt-a', 'opt-b'] }],
      container_occurrence_ref: null,
      claim_policy: 'one_time',
      claim_status: 'unclaimed',
      claimed_by_ref: null,
      issued_at: NOW,
    });

  await testDb()
    .insert(evaluation_group)
    .values({
      evaluation_group_id: spec.evalGroupId,
      submission_ids: [spec.submissionId],
      created_at: NOW,
    });

  await testDb()
    .insert(assessment_submission)
    .values({
      submission_id: spec.submissionId,
      issuance_id: spec.issuanceId,
      revision_id: spec.revisionId,
      evaluation_group_id: spec.evalGroupId,
      response_set: {
        entries: spec.entries ?? [
          { slot_id: `${partIds[0]}::r`, kind: 'choice', option_ids: ['opt-a'] },
        ],
      },
      group_evidence: [],
      idempotency_key: `idem-${spec.submissionId}`,
      submitted_at: NOW,
    });
}

// ---------- tests ----------

describe('evaluateSubmission (persisted §4.3 path)', () => {
  it.each([
    { weighted: false, subset: true, maximum: 1, score: 1 },
    { weighted: true, subset: true, maximum: 2, score: 1 },
    { weighted: false, subset: false, maximum: 4, score: 0.25 },
    { weighted: true, subset: false, maximum: 17, score: 2 / 17 },
  ])(
    'frozen issuance projection $weighted/$subset survives repeated evaluation',
    async ({ weighted, subset, maximum, score }) => {
      await seedContractChain({
        groupId: 'scope_q',
        revisionId: 'scope_rev',
        issuanceId: 'scope_iss',
        submissionId: 'scope_sub',
        evalGroupId: 'scope_group',
        partIds: ['p1', 'p2'],
        issuedPartIds: subset ? ['p1'] : ['p1', 'p2'],
        slots: ['p1', 'p2'].map((part_id) => ({
          slot_id: `${part_id}::r`,
          part_id,
          kind: 'text',
          math_preview: false,
        })),
        units: ['p1', 'p2'].map((part, i) => ({
          scoring_unit_id: `${part}::u`,
          slot_refs: [`${part}::r`],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: { kind: 'text_key', accepted_texts: [String(i + 1)], normalization: 'trim' },
          points: i === 0 ? 1 : 3,
        })),
        assignments: [
          {
            scoring_unit_ids: ['p1::u', 'p2::u'],
            executor: { kind: 'deterministic', comparator: 'exact_text' },
          },
        ],
        aggregation: weighted
          ? { kind: 'weighted_sum', weights: { 'p1::u': 2, 'p2::u': 5 } }
          : { kind: 'sum' },
        entries: subset
          ? [{ slot_id: 'p1::r', kind: 'text', text_md: ' 1 ' }]
          : [
              { slot_id: 'p1::r', kind: 'text', text_md: ' 1 ' },
              { slot_id: 'p2::r', kind: 'text', text_md: 'wrong' },
            ],
      });
      const [frozen] = await db
        .select()
        .from(question_revision)
        .where(eq(question_revision.revision_id, 'scope_rev'));
      for (const attempt of [1, 2]) {
        const out = await evaluateSubmission(db, {
          submission_id: 'scope_sub',
          evaluation_group_id: 'scope_group',
        });
        expect(out.record.attempt).toBe(attempt);
        const projected = projectEvaluationToJudgeResult(out.record, out.scoring_basis);
        expect.soft(projected.score).toBe(score);
        expect.soft(projected.coarse_outcome).toBe(subset ? 'correct' : 'partial');
        expect.soft(projected.evidence_json).toMatchObject({ max_points: maximum });
        expect
          .soft(out.scoring_basis.units.map((u) => u.scoring_unit_id))
          .toEqual(subset ? ['p1::u'] : ['p1::u', 'p2::u']);
      }
      const [after] = await db
        .select()
        .from(question_revision)
        .where(eq(question_revision.revision_id, 'scope_rev'));
      expect(after).toEqual(frozen);
      // Exercise the protected INSERT-conflict replay with a database trigger:
      // preserve the exact inserted payload, but make the outer RETURNING empty.
      // This is the existing defensive replay branch, not a second model call.
      await db.execute(sql`CREATE FUNCTION scope_replay_probe() RETURNS trigger AS $$
        BEGIN
          IF pg_trigger_depth() = 1 AND NEW.submission_id = 'scope_sub' THEN
            INSERT INTO evaluation SELECT NEW.*;
            RETURN NULL;
          END IF;
          RETURN NEW;
        END;
      $$ LANGUAGE plpgsql`);
      await db.execute(sql`CREATE TRIGGER scope_replay_probe BEFORE INSERT ON evaluation
        FOR EACH ROW EXECUTE FUNCTION scope_replay_probe()`);
      try {
        const replay = await evaluateSubmission(db, {
          submission_id: 'scope_sub',
          evaluation_group_id: 'scope_group',
        });
        expect(replay.replayed).toBe(true);
        expect(replay.record.attempt).toBe(3);
        expect(projectEvaluationToJudgeResult(replay.record, replay.scoring_basis).score).toBe(
          score,
        );
      } finally {
        await db.execute(sql`DROP TRIGGER scope_replay_probe ON evaluation`);
        await db.execute(sql`DROP FUNCTION scope_replay_probe()`);
      }
      // Another issuance of the SAME revision has a different denominator.
      await db.insert(assessment_issuance).values({
        issuance_id: 'other_iss',
        revision_id: 'scope_rev',
        part_ids: ['p1', 'p2'],
        material_bindings: [],
        option_order: [],
        claim_policy: 'one_time',
        claim_status: 'unclaimed',
        issued_at: NOW,
      });
      await db.insert(evaluation_group).values({
        evaluation_group_id: 'other_group',
        submission_ids: ['other_sub'],
        created_at: NOW,
      });
      await db.insert(assessment_submission).values({
        submission_id: 'other_sub',
        issuance_id: 'other_iss',
        revision_id: 'scope_rev',
        evaluation_group_id: 'other_group',
        response_set: {
          entries: [
            { slot_id: 'p1::r', kind: 'text', text_md: '1' },
            { slot_id: 'p2::r', kind: 'text', text_md: 'wrong' },
          ],
        },
        group_evidence: [],
        idempotency_key: 'other_idem',
        submitted_at: NOW,
      });
      await evaluateSubmission(db, {
        submission_id: 'other_sub',
        evaluation_group_id: 'other_group',
      });
      const read = await resolveVerdictsForGroups(db, ['scope_group', 'other_group']);
      expect(read.get('scope_group')?.original?.verdict).toMatchObject({
        normalized: score,
        maxPoints: maximum,
      });
      expect(read.get('other_group')?.original?.verdict).toMatchObject({
        normalized: weighted ? 2 / 17 : 0.25,
        maxPoints: weighted ? 17 : 4,
      });
    },
  );

  it.each([{ parts: [] }, { parts: ['ghost'] }, { parts: ['p1', 'p1'] }])(
    'stored invalid issuance $parts is unavailable, never a full-revision grade',
    async ({ parts }) => {
      await seedContractChain({
        groupId: 'invalid_q',
        revisionId: 'invalid_rev',
        issuanceId: 'invalid_iss',
        submissionId: 'invalid_sub',
        evalGroupId: 'invalid_group',
        issuedPartIds: parts,
      });
      // Seed an already-stored invalid record directly; frozen bindings may not
      // be mutated, and the current evaluator correctly refuses this input.
      await db.insert(evaluation).values({
        evaluation_id: 'invalid_ev',
        evaluation_group_id: 'invalid_group',
        submission_id: 'invalid_sub',
        attempt: 1,
        status: 'completed',
        unit_results: [],
        aggregate: { kind: 'points_total', points: 4, policy: { kind: 'sum' } },
        run_refs: [],
        created_at: NOW,
      });
      await expect(
        evaluateSubmission(db, {
          submission_id: 'invalid_sub',
          evaluation_group_id: 'invalid_group',
        }),
      ).rejects.toMatchObject({ code: 'invalid_issuance_scope' });
      const read = await resolveVerdictsForGroups(db, ['invalid_group']);
      expect(read.get('invalid_group')?.original?.verdict).toMatchObject({
        verdict: 'unsupported',
        reason: 'issuance_scope_unavailable',
        normalized: null,
        maxPoints: null,
      });
    },
  );

  it('deterministic hit: writes a completed candidate with points_total aggregate', async () => {
    await seedContractChain({
      groupId: 'g1',
      revisionId: 'rev-1',
      issuanceId: 'iss-1',
      submissionId: 'sub-1',
      evalGroupId: 'eg-1',
    });
    const out = await evaluateSubmission(db, {
      submission_id: 'sub-1',
      evaluation_group_id: 'eg-1',
    });
    expect(out.replayed).toBe(false);
    expect(out.record.attempt).toBe(1);
    expect(out.record.status).toBe('completed');
    expect(out.record.aggregate).toMatchObject({ kind: 'points_total', points: 4 });
    expect(out.record.evaluation_id.startsWith('eva_')).toBe(true);
    expect(out.record.plan_digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const rows = await testDb()
      .select()
      .from(evaluation)
      .where(eq(evaluation.submission_id, 'sub-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0].unit_results[0]).toMatchObject({
      status: 'scored',
      scoring_unit_id: 'p1::u',
      points_awarded: 4,
    });
    // candidate 永不生效 —— head 行未被本模块触碰（不存在也是合法的）。
    const heads = await testDb()
      .select()
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, 'eg-1'));
    expect(heads).toHaveLength(0);
  });

  it('binary comparator: wrong answer scores 0 (no partial credit)', async () => {
    await seedContractChain({
      groupId: 'g2',
      revisionId: 'rev-2',
      issuanceId: 'iss-2',
      submissionId: 'sub-2',
      evalGroupId: 'eg-2',
      entries: [{ slot_id: 'p1::r', kind: 'choice', option_ids: ['opt-b'] }],
    });
    const out = await evaluateSubmission(db, {
      submission_id: 'sub-2',
      evaluation_group_id: 'eg-2',
    });
    expect(out.record.aggregate).toMatchObject({ kind: 'points_total', points: 0 });
  });

  it('unadmitted model_executor ⇒ withhold ⇒ completed + unresolved (no fake zero)', async () => {
    await seedContractChain({
      groupId: 'g3',
      revisionId: 'rev-3',
      issuanceId: 'iss-3',
      submissionId: 'sub-3',
      evalGroupId: 'eg-3',
      slots: [{ slot_id: 'p1::r', part_id: 'p1', kind: 'text', math_preview: false }],
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'rule_reference',
            rule_id: 'r1',
            statement_md: 'grade the short answer',
            source: 'official',
          },
          points: 10,
        },
      ],
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: {
            kind: 'model_executor',
            task_kind: 'RuleJudgeTask',
            admitted_slice_id: null,
          },
        },
      ],
      entries: [{ slot_id: 'p1::r', kind: 'text', text_md: 'student work' }],
    });
    const out = await evaluateSubmission(db, {
      submission_id: 'sub-3',
      evaluation_group_id: 'eg-3',
    });
    expect(out.record.status).toBe('completed');
    expect(out.record.unit_results[0]).toMatchObject({
      status: 'pending',
      pending: { reason: 'unjudgeable' },
    });
    expect(out.record.aggregate).toMatchObject({
      kind: 'unresolved',
      reason: 'pending_units',
    });
    expect(out.model_units_invoked).toBe(0);
  });

  it('admitted model_executor without port ⇒ retryable infra_failure ⇒ pending record; retry writes attempt 2', async () => {
    await seedContractChain({
      groupId: 'g4',
      revisionId: 'rev-4',
      issuanceId: 'iss-4',
      submissionId: 'sub-4',
      evalGroupId: 'eg-4',
      slots: [{ slot_id: 'p1::r', part_id: 'p1', kind: 'text', math_preview: false }],
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'rule_reference',
            rule_id: 'r1',
            statement_md: 'grade it',
            source: 'manual',
          },
          points: 10,
        },
      ],
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: {
            kind: 'model_executor',
            task_kind: 'RuleJudgeTask',
            admitted_slice_id: 'slice-zh-text-v1',
          },
        },
      ],
      entries: [{ slot_id: 'p1::r', kind: 'text', text_md: 'answer' }],
    });

    const first = await evaluateSubmission(db, {
      submission_id: 'sub-4',
      evaluation_group_id: 'eg-4',
    });
    expect(first.record.status).toBe('pending');
    expect(first.record.aggregate).toBeNull();

    // 恢复尝试：注入端口后产出 attempt=2 的 completed candidate。
    const second = await evaluateSubmission(db, {
      submission_id: 'sub-4',
      evaluation_group_id: 'eg-4',
      model_executor: async () => ({
        kind: 'scored',
        points_awarded: 6,
        matched: { rule_id: 'r1', option_ids: [] },
        run_refs: ['run-xyz'],
        evidence_citations: [],
        cost_usd_micros: 1200,
      }),
    });
    expect(second.record.attempt).toBe(2);
    expect(second.record.status).toBe('completed');
    expect(second.record.aggregate).toMatchObject({ kind: 'points_total', points: 6 });
    expect(second.record.run_refs).toEqual(['run-xyz']);
    expect(second.spent_cost_usd_micros).toBe(1200);

    const rows = await testDb()
      .select()
      .from(evaluation)
      .where(eq(evaluation.submission_id, 'sub-4'));
    expect(rows.map((r) => r.attempt).sort()).toEqual([1, 2]);
  });

  it('a keyed model candidate is reused without another invocation, including a pending result', async () => {
    await seedContractChain({
      groupId: 'paid_g',
      revisionId: 'paid_r',
      issuanceId: 'paid_i',
      submissionId: 'paid_s',
      evalGroupId: 'paid_eg',
      slots: [{ slot_id: 'p1::r', part_id: 'p1', kind: 'text', math_preview: false }],
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'rule_reference',
            rule_id: 'r1',
            statement_md: 'Explain the mechanism with original evidence',
            source: 'manual',
          },
          points: 10,
        },
      ],
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: {
            kind: 'model_executor',
            task_kind: 'RuleJudgeTask',
            admitted_slice_id: 'slice-zh-text-v1',
          },
        },
      ],
      entries: [
        {
          slot_id: 'p1::r',
          kind: 'text',
          text_md:
            'A detailed response with multiple clauses; preserve original punctuation and evidence.',
        },
      ],
    });
    let calls = 0;
    const request = {
      submission_id: 'paid_s',
      evaluation_group_id: 'paid_eg',
      evaluation_key: 'preview:paid_s',
      model_executor: async () => {
        calls++;
        const holders = await db.execute(sql`
          SELECT a.xact_start, a.state FROM pg_locks l
          JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE l.locktype = 'advisory' AND l.granted
            AND l.classid::bigint = (hashtext('assessment-evaluation-group')::bigint & 4294967295)
            AND l.objid::bigint = (hashtext('paid_eg')::bigint & 4294967295)
        `);
        expect(holders).toHaveLength(1);
        expect(holders[0]).toMatchObject({ xact_start: null, state: 'idle' });
        return {
          kind: 'pending' as const,
          pending: {
            reason: 'infra_failure' as const,
            retryable: true,
            detail: 'offline transport failed after dispatch',
          },
          run_refs: ['run_paid'],
          cost_usd_micros: 1200,
        };
      },
    };
    await expect(
      evaluateSubmission(db, { ...request, expected_evaluation_id: 'unknown-candidate' }),
    ).rejects.toMatchObject({ code: 'candidate_not_found' });
    expect(calls).toBe(0);
    await expect(db.transaction((tx) => evaluateSubmission(tx, request))).rejects.toMatchObject({
      code: 'invalid_executor_spec',
    });
    expect(calls).toBe(0);
    const [first, concurrent] = await Promise.all([
      evaluateSubmission(db, request),
      evaluateSubmission(db, request),
    ]);
    expect(concurrent.record.evaluation_id).toBe(first.record.evaluation_id);
    expect([first.replayed, concurrent.replayed].sort()).toEqual([false, true]);
    await expect(
      evaluateSubmission(db, { ...request, expected_evaluation_id: 'unrelated-candidate' }),
    ).rejects.toMatchObject({ code: 'evaluation_key_conflict' });
    const second = await evaluateSubmission(db, {
      ...request,
      expected_evaluation_id: first.record.evaluation_id,
    });
    expect.soft(calls).toBe(1);
    expect.soft(first.record.status).toBe('pending');
    expect.soft(second.record).toEqual(first.record);
    expect
      .soft(second)
      .toMatchObject({ replayed: true, model_units_invoked: 0, spent_cost_usd_micros: 0 });
    // Recovery must be a new explicitly identified operation, not an HTTP retry.
    const third = await evaluateSubmission(db, { ...request, evaluation_key: 'retry:paid_s:1' });
    expect.soft(calls).toBe(2);
    expect.soft(third.record.attempt).toBe(2);
  });

  it('model_executor {kind:"jev"} descriptor ⇒ Jev port assembled at the composition point (YUK-1092)', async () => {
    await seedContractChain({
      groupId: 'g4b',
      revisionId: 'rev-4b',
      issuanceId: 'iss-4b',
      submissionId: 'sub-4b',
      evalGroupId: 'eg-4b',
      slots: [{ slot_id: 'p1::r', part_id: 'p1', kind: 'text', math_preview: false }],
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'rule_reference',
            rule_id: 'r1',
            statement_md: 'grade it',
            source: 'manual',
          },
          points: 10,
        },
      ],
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: {
            kind: 'model_executor',
            task_kind: 'JevScoringDecisionTask',
            admitted_slice_id: 'slice-zh-text-v1',
          },
        },
      ],
      entries: [{ slot_id: 'p1::r', kind: 'text', text_md: 'answer' }],
    });

    const savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const out = await evaluateSubmission(db, {
        submission_id: 'sub-4b',
        evaluation_group_id: 'eg-4b',
        model_executor: {
          kind: 'jev',
          deadline_at: Date.now() + 60_000,
          rule_threshold: 0.8,
        },
      });
      // 装配生效的证据：单元走到了 Jev 端口的凭证闸门（Jev 专属文案），
      // 而不是『no model executor port registered』的 retryable 未决。
      expect(out.model_units_invoked).toBe(1);
      expect(out.record.status).toBe('completed');
      expect(out.record.unit_results[0]).toMatchObject({
        status: 'pending',
        pending: {
          reason: 'infra_failure',
          retryable: false,
          detail: expect.stringContaining('no credentialed Jev lane'),
        },
      });
    } finally {
      if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
    }
  });

  it('submission/group coordinate mismatch ⇒ group_scope_mismatch (fail-closed)', async () => {
    await seedContractChain({
      groupId: 'g5',
      revisionId: 'rev-5',
      issuanceId: 'iss-5',
      submissionId: 'sub-5',
      evalGroupId: 'eg-5',
    });
    await expect(
      evaluateSubmission(db, {
        submission_id: 'sub-5',
        evaluation_group_id: 'eg-OTHER',
      }),
    ).rejects.toMatchObject({ code: 'group_scope_mismatch' });
  });

  it('unknown submission ⇒ submission_not_found', async () => {
    await expect(
      evaluateSubmission(db, {
        submission_id: 'ghost',
        evaluation_group_id: 'eg-x',
      }),
    ).rejects.toMatchObject({ code: 'submission_not_found' });
  });

  it('manual_assert writes a completed manual-provenance candidate', async () => {
    await seedContractChain({
      groupId: 'g6',
      revisionId: 'rev-6',
      issuanceId: 'iss-6',
      submissionId: 'sub-6',
      evalGroupId: 'eg-6',
    });
    const asserted: ScoringUnitResultT[] = [
      {
        status: 'scored',
        scoring_unit_id: 'p1::u',
        points_awarded: 4,
        scored_because: 'response',
        evidence_citations: [],
      },
    ];
    const out = await evaluateSubmission(db, {
      submission_id: 'sub-6',
      evaluation_group_id: 'eg-6',
      mode: 'manual_assert',
      provenance: { source: 'manual', assisted: false },
      asserted_unit_results: asserted,
    });
    expect(out.record.provenance).toMatchObject({ source: 'manual' });
    expect(out.record.aggregate).toMatchObject({ kind: 'points_total', points: 4 });
  });
});

describe('evaluateAttempt — contract lane end-to-end', () => {
  it('contract ref ⇒ evaluateSubmission + JudgeResultV2 projection', async () => {
    await seedContractChain({
      groupId: 'g7',
      revisionId: 'rev-7',
      issuanceId: 'iss-7',
      submissionId: 'sub-7',
      evalGroupId: 'eg-7',
      entries: [{ slot_id: 'p1::r', kind: 'choice', option_ids: ['opt-a'] }],
    });
    const out = await evaluateAttempt({
      entry: 'conjecture_probe',
      db,
      contract: { submission_id: 'sub-7', evaluation_group_id: 'eg-7' },
    });
    expect(out.lane).toBe('contract');
    expect(out.entry).toBe('conjecture_probe');
    expect(out.evaluation.record.attempt).toBe(1);
    expect(out.result.coarse_outcome).toBe('correct');
    expect(out.result.score).toBe(1);
  });
});

describe('YUK-1047 formal entry candidate reuse', () => {
  it('reuses the same frozen candidate for preview and commit; changed execution intent conflicts', async () => {
    await seedContractChain({
      groupId: 'reuse_g',
      revisionId: 'reuse_r',
      issuanceId: 'reuse_i',
      submissionId: 'reuse_s',
      evalGroupId: 'reuse_eg',
    });
    const request = {
      submission_id: 'reuse_s',
      evaluation_group_id: 'reuse_eg',
      evaluation_key: 'submission:reuse_s',
    };
    const preview = await evaluateSubmission(db, request);
    const commit = await evaluateSubmission(db, request);
    expect.soft(commit.replayed).toBe(true);
    expect.soft(commit.record).toEqual(preview.record);
    expect.soft(commit.created_at).toEqual(preview.created_at);
    expect.soft(await db.select().from(evaluation)).toHaveLength(1);
    await expect(
      evaluateSubmission(db, { ...request, provenance: { source: 'automatic', assisted: true } }),
    ).rejects.toMatchObject({ code: 'evaluation_key_conflict' });
  });
});

describe('formal preview entry service', () => {
  it('reuses the immutable response and candidate; wrong question or changed answer cannot use them', async () => {
    await seedContractChain({
      groupId: 'entry_g',
      revisionId: 'entry_r',
      issuanceId: 'entry_i',
      submissionId: 'entry_s',
      evalGroupId: 'entry_eg',
    });
    const request = {
      issuance_id: 'entry_i',
      submission_id: 'entry_s',
      evaluation_group_id: 'entry_eg',
      idempotency_key: 'idem-entry_s',
      response_set: {
        entries: [{ slot_id: 'p1::r', kind: 'choice' as const, option_ids: ['opt-a'] }],
      },
      group_evidence: [],
    };
    const first = await previewFormalAttempt(db, 'advice_preview', 'entry_g', request);
    const second = await previewFormalAttempt(db, 'solo_submit', 'entry_g', request);
    expect.soft(first.candidate.lane).toBe('contract');
    expect.soft(second.candidate.evaluation.replayed).toBe(true);
    expect.soft(second.candidate.evaluation.record).toEqual(first.candidate.evaluation.record);
    await expect(
      previewFormalAttempt(db, 'advice_preview', 'unrelated_question', request),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      previewFormalAttempt(db, 'advice_preview', 'entry_g', {
        ...request,
        response_set: { entries: [{ slot_id: 'p1::r', kind: 'choice', option_ids: ['opt-b'] }] },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect.soft(await db.select().from(evaluation)).toHaveLength(1);
  });
});
