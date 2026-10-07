import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { issueAssessment } from '@/capabilities/practice/server/assessment/issue';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import {
  normalizeQuestionGroupToContract,
  normalizeQuestionRowToContract,
} from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';

/** Real publisher and issuance, usable by service and HTTP tests. */
export async function freezeSolveQuestion(db: Db, questionId: string, manual = false) {
  const [row] = await db.select().from(question).where(eq(question.id, questionId));
  if (!row) throw new Error('fixture question missing');
  const normalized = normalizeQuestionRowToContract(row);
  const published = await publishQuestionGroup(db, {
    group_id: questionId,
    contract: normalized,
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    admission: manual
      ? { state: 'withheld', reason: 'owner_hold' }
      : {
          state: 'admitted',
          evidence: {
            marking_provenance: 'official',
            verification: { structural_check_passed: true, independent_verification: null },
            model_slice: null,
          },
        },
    actorRef: 'test:frozen-solve',
    now: new Date(),
  });
  if (published.status !== 'published') throw new Error(`fixture publish: ${published.status}`);
  const issued = await issueAssessment(db, {
    group_id: questionId,
    mode: manual ? 'manual' : 'auto_score',
  });
  if (issued.status !== 'issued') throw new Error(`fixture issue: ${issued.status}`);
  return {
    issuanceId: issued.issuance.issuance_id,
    revisionId: published.revision_id,
    contract: normalized,
  };
}

export async function seedFrozenSolveQuestion(db: Db) {
  const id = createId();
  await db.insert(question).values({
    id,
    kind: 'derivation',
    prompt_md:
      '已知 a≠b，化简 (a²−b²)/(a−b)。请保留因式分解、约分条件及最后结果。\n条件只保证分母非零，不能随意令 a=b。',
    reference_md: 'a+b\n\n解析：先因式分解为 (a−b)(a+b)，由 a≠b 才可约分。',
    judge_kind_override: 'exact',
    knowledge_ids: [],
    difficulty: 3,
    source: 'web_sourced',
    created_at: new Date(),
    updated_at: new Date(),
    version: 0,
  });
  const frozen = await freezeSolveQuestion(db, id);
  const slot = frozen.contract.response_spec.slots[0];
  return {
    id,
    ...frozen,
    responseSet: (answer: string) => ({
      entries: [{ slot_id: slot.slot_id, kind: 'text' as const, text_md: answer }],
    }),
  };
}

export async function seedFrozenCompositeSolveQuestion(db: Db) {
  const id = createId();
  const now = new Date();
  const base = {
    kind: 'choice',
    reference_md: 'B',
    choices_md: ['方向相同', '方向相反'],
    knowledge_ids: [],
    difficulty: 3,
    source: 'web_sourced',
    created_at: now,
    updated_at: now,
    version: 0,
  };
  await db
    .insert(question)
    .values({ ...base, id, prompt_md: '分别判断四种航行条件下水流与船的方向。各小题独立计一分。' });
  const [root] = await db.select().from(question).where(eq(question.id, id));
  const parts = Array.from({ length: 4 }, (_, i) => ({
    ...base,
    id: `${id}_part${i}`,
    parent_question_id: id,
    part_index: i,
    prompt_md: `情形 ${i + 1}：船向上游运动，水向下游流动。选择水流与船运动方向的关系。`,
  }));
  await db.insert(question).values(parts);
  const contract = normalizeQuestionGroupToContract(root, parts);
  const published = await publishQuestionGroup(db, {
    group_id: id,
    contract,
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    admission: {
      state: 'admitted',
      evidence: {
        marking_provenance: 'official',
        verification: { structural_check_passed: true, independent_verification: null },
        model_slice: null,
      },
    },
    actorRef: 'test:composite-solve',
    now,
  });
  if (published.status !== 'published') throw new Error(published.status);
  const issued = await issueAssessment(db, { group_id: id });
  if (issued.status !== 'issued') throw new Error(issued.status);
  return {
    id,
    issuanceId: issued.issuance.issuance_id,
    responseSet: (correct: number) => ({
      entries: contract.response_spec.slots.map((slot, i) => {
        if (slot.kind !== 'single_choice') throw new Error('expected choice fixture');
        return {
          slot_id: slot.slot_id,
          kind: 'choice' as const,
          option_ids: [slot.options[i < correct ? 1 : 0].option_id],
        };
      }),
    }),
  };
}
