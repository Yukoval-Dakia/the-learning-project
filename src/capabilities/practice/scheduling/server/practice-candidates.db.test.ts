// YUK-1790 LIGHT — candidate read boundary. One invariant: the read is an AUTHORIZATION
// boundary for question content. Only currently servable (admitted, published, non-draft)
// questions may appear, and the answer key never leaves the read. A missing reading stays
// unknown with its reason — it is never rendered as a zero / low-mastery claim.
import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';
import { knowledge, question } from '@/db/schema';
import { contractIntegrityDigest } from '@/kernel/records/assessment-normalization';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { readPracticeCandidates } from './practice-candidates';

const SECRET_ADMITTED = 'SECRET-ANSWER-ADMITTED-6b1f';
const SECRET_DRAFT = 'SECRET-ANSWER-DRAFT-9a02';
const SECRET_UNPUBLISHED = 'SECRET-ANSWER-UNPUBLISHED-4d77';

async function seedKnowledge(db: ReturnType<typeof testDb>): Promise<string> {
  const now = new Date();
  const knowledgeId = createId();
  await db.insert(knowledge).values({
    id: knowledgeId,
    name: '候选读口的授权边界',
    domain: 'computer-science',
    created_at: now,
    updated_at: now,
  });
  return knowledgeId;
}

function optionContract(questionId: string, prompt: string) {
  const options = [
    {
      option_id: `opt_${questionId}_a`,
      label: 'A',
      text: '先读候选再决定',
    },
    {
      option_id: `opt_${questionId}_b`,
      label: 'B',
      text: '先决定再读候选',
    },
  ];
  return {
    structure: {
      group_id: questionId,
      materials: [],
      parts: [{ part_id: 'p1', prompt_md: prompt, material_ids: [] }],
    },
    response_spec: {
      slots: [{ slot_id: 'p1::r', part_id: 'p1', kind: 'single_choice' as const, options }],
    },
    scoring_basis: {
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'option_set_key' as const,
            accepted_option_ids: [`opt_${questionId}_b`],
          },
          points: 2,
        },
      ],
      aggregation: { kind: 'sum' as const },
      blank_scores_zero: true,
    },
    execution_plan: {
      plan_version: 1,
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: { kind: 'deterministic' as const, comparator: 'exact_option_set' as const },
        },
      ],
      escalation: {
        on_unadmitted_model: 'withhold' as const,
        on_low_confidence: 'human_review' as const,
      },
    },
  };
}

/** Publish + admit one servable choice question (the same gate real candidates pass). */
async function seedAdmittedQuestion(
  db: ReturnType<typeof testDb>,
  knowledgeId: string,
  referenceMd: string,
): Promise<string> {
  const now = new Date();
  const questionId = createId();
  const prompt = '候选读口返回这题时应该带出哪类事实？';
  await db.insert(question).values({
    id: questionId,
    kind: 'choice',
    prompt_md: prompt,
    reference_md: referenceMd,
    choices_md: ['先读候选再决定', '先决定再读候选'],
    knowledge_ids: [knowledgeId],
    source: 'manual',
    draft_status: 'active',
    created_at: now,
    updated_at: now,
  });
  const contract = optionContract(questionId, prompt);
  const published = await publishQuestionGroup(db, {
    group_id: questionId,
    contract: { ...contract, integrity_digest: contractIntegrityDigest(contract) },
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    actorRef: 'test:practice-candidates',
    now,
    admission: {
      state: 'admitted',
      evidence: {
        marking_provenance: 'official',
        verification: { structural_check_passed: true, independent_verification: null },
        model_slice: null,
      },
    },
  });
  if (published.status !== 'published') throw new Error(published.status);
  return questionId;
}

/** A question row that never reached the admission gate (no lifecycle revision). */
async function seedUnadmittedQuestion(
  db: ReturnType<typeof testDb>,
  knowledgeId: string,
  referenceMd: string,
): Promise<string> {
  const now = new Date();
  const questionId = createId();
  await db.insert(question).values({
    id: questionId,
    kind: 'choice',
    prompt_md: '这道题还没有走完准入。',
    reference_md: referenceMd,
    knowledge_ids: [knowledgeId],
    source: 'manual',
    draft_status: null,
    created_at: now,
    updated_at: now,
  });
  return questionId;
}

/** An unverified draft must never surface as a practice candidate. */
async function seedDraftQuestion(
  db: ReturnType<typeof testDb>,
  knowledgeId: string,
  referenceMd: string,
): Promise<string> {
  const now = new Date();
  const questionId = createId();
  await db.insert(question).values({
    id: questionId,
    kind: 'choice',
    prompt_md: '这道题仍是草稿。',
    reference_md: referenceMd,
    knowledge_ids: [knowledgeId],
    source: 'manual',
    draft_status: 'draft',
    created_at: now,
    updated_at: now,
  });
  return questionId;
}

beforeEach(async () => {
  await resetDb();
});

describe('read_practice_candidates authorization boundary', () => {
  // @invariant security: only servable admitted questions are returned, and the answer key
  // is never part of the read; a missing mastery reading stays unknown, not zero.
  // @fails-if the candidate read stops filtering on admission/draft state, starts returning
  // reference_md content, or coerces an unknown mastery signal into a numeric zero/low band.
  it('returns only servable admitted questions and never the answer key', async () => {
    const db = testDb();
    const knowledgeId = await seedKnowledge(db);
    const admittedId = await seedAdmittedQuestion(db, knowledgeId, SECRET_ADMITTED);
    const draftId = await seedDraftQuestion(db, knowledgeId, SECRET_DRAFT);
    const unadmittedId = await seedUnadmittedQuestion(db, knowledgeId, SECRET_UNPUBLISHED);

    const result = await readPracticeCandidates(db, {
      scope: { kind: 'knowledge', knowledgeIds: [knowledgeId] },
    });

    expect(result.status).toBe('ok');
    const refIds = result.candidates.map((row) => row.ref_id);
    expect(refIds).toContain(admittedId);
    expect(refIds).not.toContain(draftId);
    expect(refIds).not.toContain(unadmittedId);

    const admittedRow = result.candidates.find((row) => row.ref_id === admittedId);
    expect(admittedRow?.roles).toContain('unattempted');
    expect(admittedRow?.serving.servable).toBe(true);

    // The answer key is question-side truth the candidate read must never carry.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_ADMITTED);
    expect(serialized).not.toContain(SECRET_DRAFT);
    expect(serialized).not.toContain(SECRET_UNPUBLISHED);
    expect(serialized).not.toContain('reference_md');

    // No mastery row exists for the KC yet: unknown with a reason, never a zero or a band.
    const mastery = admittedRow?.knowledge[0]?.mastery;
    expect(mastery?.known).toBe(false);
    expect(mastery?.value).toBeNull();
    expect(mastery?.missingReason).toBeTruthy();

    // The unadmitted row is counted as an exclusion, not silently dropped from the story.
    const notAdmitted = result.exclusions.find((entry) => entry.reason === 'not_admitted');
    expect(notAdmitted?.count).toBeGreaterThanOrEqual(1);
  });
});
