import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  question,
  question_group_lifecycle,
  question_revision,
  question_solution_prior,
  source_document,
} from '@/db/schema';
import { buildCoverageEvidenceDemand } from '@/kernel/supply-contracts';
import type { ToolContext } from '@/kernel/tools/types';
import { EMBED_DIMS, type embedMany } from '@/server/ai/embed';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { retrieveFewShotExamples } from '../../server/quiz/fewshot-retrieve';
import { questionPreparerPendingStock } from '../../supply/server/question-preparer-stock';
import { embedSolutionPriorVectors } from '../server/admission/solution-prior-vectors';
import { selectItemPriorCandidates } from '../server/item-prior-durable-operation';
import { encodeBankRef } from '../tools/bank-ref';
import { readBankTool } from '../tools/read-bank';
import { runBankSearchV3 } from '../tools/search-bank';
import { runEmbedBackfill } from './embed_backfill';
import { runReferenceAnswerBackfill } from './reference_answer_backfill';

const db = testDb();
const now = new Date();

const unit = {
  scoring_unit_id: 'u1',
  slot_refs: ['s1'],
  material_refs: [],
  evidence_slot_refs: [],
  requires_group_evidence: false,
  criterion: {
    kind: 'rubric' as const,
    criteria: [{ criterion_id: 'c1', statement_md: '答案正确', max: 4, allowed_awards: [0, 2, 4] }],
    crossed_out_steps: 'ignore' as const,
  },
  points: 4,
};
const slots = [
  {
    slot_id: 's1',
    part_id: 'p1',
    kind: 'open_response' as const,
    accepted_evidence: [],
    evidence_required: false,
  },
];

const bankRows = [
  ['qr-1', 'RDOC-q1 题面', 'doc-restricted'],
  ['qr-2', 'RDOC-q2 题面', 'doc-restricted'],
  ['qa-1', 'ADOC-q1 题面', 'doc-allow'],
  ['qa-2', 'ADOC-q2 题面', 'doc-allow'],
] as const;

async function seedBank(policy: 'answer_only' | 'crisis' | 'allow') {
  await db.insert(source_document).values([
    {
      id: 'doc-restricted',
      source_asset_ids: [],
      provenance: { usage_policy: { derivation_policy: policy } },
      created_at: now,
      updated_at: now,
      version: 0,
    },
    {
      id: 'doc-allow',
      source_asset_ids: [],
      provenance: { usage_policy: { derivation_policy: 'allow' } },
      created_at: now,
      updated_at: now,
      version: 0,
    },
  ]);
  for (const [index, [id, prompt, doc]] of bankRows.entries()) {
    await db.insert(question).values({
      id,
      kind: 'short_answer',
      prompt_md: prompt,
      reference_md: null,
      choices_md: null,
      knowledge_ids: ['k1'],
      difficulty: 3,
      source: 'vision_paper',
      draft_status: 'active',
      variant_depth: 0,
      metadata: { source_document_id: doc },
      created_at: now,
      updated_at: now,
      version: 0,
    });
    const revisionId = `rv${String(index).padStart(10, '0')}`;
    const integrityDigest = `sha256:${(index + 1).toString(16).padStart(64, '0')}`;
    const revisionRow: typeof question_revision.$inferInsert = {
      revision_id: revisionId,
      group_id: id,
      revision_ordinal: 1,
      integrity_digest: integrityDigest,
      structure: {
        group_id: id,
        parts: [{ part_id: 'p1', prompt_md: prompt, material_ids: [] }],
        materials: [],
      },
      response_spec: { slots },
      scoring_basis: { units: [unit], aggregation: { kind: 'sum' }, blank_scores_zero: false },
      execution_plan: {
        plan_version: 1,
        assignments: [
          {
            scoring_unit_ids: ['u1'],
            executor: {
              kind: 'model_executor',
              task_kind: 'AssessmentRuleJudgeTask',
              admitted_slice_id: null,
              max_cost_usd_micros: 10000,
            },
          },
        ],
        escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
      },
      availability: 'general_pool',
      published_at: now,
    };
    await db.insert(question_revision).values(revisionRow);
    // Withheld-pending lifecycle so the preparer's pending-stock surface sees the
    // rows; admission/withdrawal state is orthogonal to the derivation policy gate.
    await db.insert(question_group_lifecycle).values({
      group_id: id,
      current_revision_id: revisionId,
      availability: 'general_pool',
      scoring_admission_state: 'withheld',
      scoring_admission_withheld_reason: 'unverified_rules',
      claim_policy: 'unbounded',
      suspended: false,
      withdrawn: false,
      created_at: now,
      updated_at: now,
    });
    await db.insert(question_solution_prior).values({
      revision_id: revisionId,
      part_id: 'p1',
      prior_version: 'prior-v1',
      prior: {
        part_id: 'p1',
        methods: [{ core_idea_md: `${id} PRIOR-IDEA`, key_step_md: '代入', steps_md: [] }],
        pitfalls: [],
        prerequisites: [],
        difficulty: null,
      },
      origin: 'admission',
      task_run_ids: ['tr-fixture'],
      created_at: now,
    });
  }
}

function countingEmbed() {
  const sent: string[] = [];
  const embedFn: typeof embedMany = async (texts) => {
    sent.push(...texts);
    return texts.map(() => new Array(EMBED_DIMS).fill(0));
  };
  return { sent, embedFn };
}

const attempt = {
  db,
  caller: 'worker' as const,
  deadlineAt: new Date(Date.now() + 20_000),
};

describe('restricted-source questions in model derivation lanes', () => {
  beforeEach(async () => {
    vi.stubEnv('BANK_GAP_EVIDENCE_SECRET', 'bank-boundary-fixture-signing-key-at-least-32-chars');
    await resetDb();
  });

  // @invariant security: question rows whose provenance resolves to a restricted
  //   derivation policy are excluded at every derivation surface's selection —
  //   background lanes (embedding, reference-answer, item-prior, prior-vector) and
  //   cross-question authoring surfaces (quiz few-shot material, preparer pending
  //   stock, preparer search/read tools) never receive their text; allowed lineage
  //   is selected and sent normally, and serving callers still read restricted rows
  // @fails-if a lane or tool drops the shared tlp_question_allows_derivation /
  //   sourceAllowsDerivationSql check (restricted rows consume the batch, the page
  //   or the few-shot pool and reach the provider), or the filter is applied after
  //   selection so restricted rows starve the batch — or a serving read starts
  //   refusing rows it is allowed to see
  it.each([
    { policy: 'answer_only' as const, expectRestrictedSent: false },
    { policy: 'crisis' as const, expectRestrictedSent: false },
    { policy: 'allow' as const, expectRestrictedSent: true },
  ])(
    'selection predicates keep restricted lineage out of every derivation read ($policy)',
    async ({ policy, expectRestrictedSent }) => {
      await seedBank(policy);

      const { sent: embedSent, embedFn } = countingEmbed();
      await runEmbedBackfill(db, 50, attempt, embedFn);

      // Question pass + prior-vector pass share the embedFn inside one run.
      expect(embedSent.filter((text) => text.includes('ADOC-'))).toHaveLength(2);
      expect(
        embedSent.filter((text) => text.includes('qa-') && text.includes('PRIOR')),
      ).toHaveLength(2);
      expect(embedSent.some((text) => text.includes('RDOC-'))).toBe(expectRestrictedSent);
      expect(embedSent.some((text) => text.includes('qr-') && text.includes('PRIOR'))).toBe(
        expectRestrictedSent,
      );

      const generated: string[] = [];
      const backfill = await runReferenceAnswerBackfill(db, {
        generateFn: async ({ questionId }) => {
          generated.push(questionId);
          return { status: 'generated', final_answer: 'x' };
        },
      });
      const expectedGenerate = expectRestrictedSent
        ? ['qa-1', 'qa-2', 'qr-1', 'qr-2']
        : ['qa-1', 'qa-2'];
      expect([...generated].sort()).toEqual(expectedGenerate);
      expect(backfill.scanned).toBe(expectedGenerate.length);

      const candidates = await selectItemPriorCandidates(db, 25);
      expect(candidates.map((row) => row.id).sort()).toEqual(expectedGenerate);

      // The prior-vector lane's own entry, probed directly: allowed priors are
      // already embedded from the run above, so only restricted leftovers remain
      // eligible — and the scan must still refuse them.
      const { sent: priorSent, embedFn: priorEmbedFn } = countingEmbed();
      await embedSolutionPriorVectors(db, 25, attempt, priorEmbedFn);
      expect(priorSent).toHaveLength(0);

      // Cross-question derivation surfaces: restricted question content is never
      // material another question consumes. answer_only is '仅用于本次回答' — it
      // authorizes serving reads for the same learner, never authoring feeds.
      const fewShot = await retrieveFewShotExamples({
        db,
        kind: 'short_answer',
        knowledgeIds: ['k1'],
      });
      // Retrieval caps at 3 examples; every returned id must be derivation-allowed.
      expect(fewShot.map((ex) => ex.id)).toHaveLength(Math.min(3, expectedGenerate.length));
      expect(fewShot.every((ex) => expectedGenerate.includes(ex.id))).toBe(true);

      const ticket = buildCoverageEvidenceDemand({
        subjectId: 'subj-1',
        knowledgeIds: ['k1'],
        statement: '覆盖证据需求',
      });
      const stock = await questionPreparerPendingStock(db, ticket);
      expect([...stock.map((row) => row.question_id)].sort()).toEqual(expectedGenerate);

      const preparerCtx: ToolContext = {
        db,
        taskRunId: 'test-run',
        callerActor: { kind: 'agent', ref: 'question_preparer' },
      };
      const servingCtx: ToolContext = {
        db,
        taskRunId: 'test-run',
        callerActor: { kind: 'agent', ref: 'test' },
      };
      const preparerSearch = await runBankSearchV3(
        preparerCtx,
        { query: '题面', use: 'dedup', filters: { terms: ['题面'] } },
        { vectors: 'off' },
      );
      expect([...preparerSearch.hits.map((hit) => hit.id)].sort()).toEqual(expectedGenerate);
      const servingSearch = await runBankSearchV3(
        servingCtx,
        { query: '题面', use: 'dedup', filters: { terms: ['题面'] } },
        { vectors: 'off' },
      );
      expect([...servingSearch.hits.map((hit) => hit.id)].sort()).toEqual(
        [...bankRows.map(([id]) => id)].sort(),
      );

      const refs = bankRows.map((_, index) =>
        encodeBankRef(
          `rv${String(index).padStart(10, '0')}`,
          `sha256:${(index + 1).toString(16).padStart(64, '0')}`,
        ),
      );
      const preparerRead = await readBankTool.execute(preparerCtx, {
        refs,
        include: ['overview'],
      });
      const deniedRefs = preparerRead.items
        .filter((item) => item.status === 'denied')
        .map((item) => item.ref)
        .sort();
      const okRefs = preparerRead.items
        .filter((item) => item.status === 'ok')
        .map((item) => item.ref)
        .sort();
      const restrictedRefs = refs.filter((_, index) => bankRows[index][0].startsWith('qr-'));
      const allowedRefs = refs.filter((_, index) => !bankRows[index][0].startsWith('qr-'));
      expect(deniedRefs).toEqual(expectRestrictedSent ? [] : restrictedRefs.sort());
      expect(okRefs).toEqual(expectRestrictedSent ? [...refs].sort() : allowedRefs.sort());
      const servingRead = await readBankTool.execute(servingCtx, {
        refs,
        include: ['overview'],
      });
      expect(servingRead.items.every((item) => item.status === 'ok')).toBe(true);
    },
  );
});
