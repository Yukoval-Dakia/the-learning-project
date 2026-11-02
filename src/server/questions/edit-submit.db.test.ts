// YUK-1468 — edit/submit 边界上的数据与判分不变量。
// 入口是 saveDraftEdit / submitDraftQuestion / acceptAiProposal / poolFetch /
// issueAssessment，不单测内部 helper。

import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { poolFetch } from '@/capabilities/practice/server/quiz/pool-fetch';
import { gradeBlankExactUnit } from '@/core/schema/assessment/grade';
import { defaultPresentation } from '@/core/schema/assessment/presentation';
import type { AdmissionEvidenceT } from '@/core/schema/assessment/publish';
import {
  type DraftBlankTextKeyT,
  QuestionDraftDocument,
  type QuestionDraftDocumentT,
} from '@/core/schema/question-draft';
import {
  knowledge,
  question,
  question_block,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { issueAssessment } from '@/kernel/records/assessment-issuance';
import {
  publishQuestionGroup,
  publishQuestionGroupFromRow,
} from '@/kernel/records/assessment-publication';
import { draftDocumentToContract } from '@/kernel/records/question-draft-contract';
import { acceptAiProposal } from '@/server/proposals/actions';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { contractIntegrityDigest, normalizeQuestionRowToContract } from './contract-normalizer';
import { saveDraftEdit, validateDraftEdit } from './edit-question';
import { submitDraftQuestion } from './submit-question';

const ADMITTED: AdmissionEvidenceT = {
  marking_provenance: 'official',
  verification: { structural_check_passed: true, independent_verification: null },
  model_slice: null,
};

const ACTOR = { actorRef: 'agent:test', actorKind: 'agent' as const };

const CHOICE_RULE = {
  version: 1 as const,
  cases: [
    {
      when: { wrong: { eq: 0 }, miss: { eq: 0 } },
      award: { points: 1 },
    },
  ],
  otherwise: { points: 0 },
};

async function seedKnowledge(id: string): Promise<void> {
  const now = new Date();
  await testDb().insert(knowledge).values({
    id,
    name: id,
    domain: 'math',
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

function selectDocument(prompt: string, knowledgeId: string | null): QuestionDraftDocumentT {
  return QuestionDraftDocument.parse({
    schema_version: 2,
    parts: [
      {
        part_id: 'p1',
        prompt_md: prompt,
        material_ids: [],
        units: [
          {
            unit_id: 'u1',
            slot_id: 's1',
            response_class: 'select',
            response_spec: {
              kind: 'select',
              pick: 'one',
              items: [
                { item_id: 'opt-a', label_md: '甲' },
                { item_id: 'opt-b', label_md: '乙' },
              ],
            },
            key: { kind: 'select', accepted_item_ids: ['opt-b'] },
            points: 1,
            rule: CHOICE_RULE,
            method: { kind: 'set-compare' },
            material_refs: [],
            metadata: {},
          },
        ],
        metadata: {},
      },
    ],
    materials: [],
    knowledge_ids: knowledgeId == null ? [] : [knowledgeId],
    metadata: {},
  });
}

function choiceDocument(
  prompt: string,
  knowledgeId: string,
  sourceRef: string,
  labels: string[],
): QuestionDraftDocumentT {
  const items = labels.map((label, index) => ({ item_id: `opt-${index}`, label_md: label }));
  return QuestionDraftDocument.parse({
    schema_version: 2,
    parts: [
      {
        part_id: 'p1',
        prompt_md: prompt,
        material_ids: [],
        units: [
          {
            unit_id: 'u1',
            slot_id: 's1',
            response_class: 'select',
            response_spec: { kind: 'select', pick: 'one', items },
            key: { kind: 'select', accepted_item_ids: [items[1]?.item_id ?? 'opt-1'] },
            points: 1,
            rule: CHOICE_RULE,
            method: { kind: 'set-compare' },
            material_refs: [],
            metadata: {},
          },
        ],
        metadata: {},
      },
    ],
    materials: [],
    knowledge_ids: [knowledgeId],
    source: { kind: 'generated', ref: sourceRef },
    metadata: {},
  });
}

function freeDocument(
  prompt: string,
  knowledgeId: string,
  sourceRef: string,
): QuestionDraftDocumentT {
  return QuestionDraftDocument.parse({
    schema_version: 2,
    parts: [
      {
        part_id: 'p1',
        prompt_md: prompt,
        material_ids: [],
        units: [
          {
            unit_id: 'u1',
            slot_id: 's1',
            response_class: 'free',
            response_spec: { kind: 'free' },
            reference_md: '7',
            points: 2,
            method: { kind: 'human_review' },
            material_refs: [],
            metadata: {},
          },
        ],
        metadata: {},
      },
    ],
    materials: [],
    knowledge_ids: [knowledgeId],
    source: { kind: 'generated', ref: sourceRef },
    metadata: {},
  });
}

async function insertQuestion(input: {
  id: string;
  prompt: string;
  reference: string | null;
  choices: string[] | null;
  knowledgeIds: string[];
  source?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(question)
    .values({
      id: input.id,
      kind: input.choices == null ? 'short_answer' : 'choice',
      prompt_md: input.prompt,
      reference_md: input.reference,
      choices_md: input.choices,
      knowledge_ids: input.knowledgeIds,
      difficulty: 3,
      source: input.source ?? 'manual',
      ...(input.metadata != null ? { metadata: input.metadata } : {}),
      variant_depth: 0,
      created_at: now,
      updated_at: now,
      version: 0,
    });
}

async function publishSelect(input: {
  id: string;
  prompt: string;
  knowledgeIds: string[];
  admission: 'admitted' | 'withheld';
}): Promise<void> {
  const db = testDb();
  const doc = selectDocument(input.prompt, input.knowledgeIds[0] ?? null);
  const contract = draftDocumentToContract(doc, input.id);
  if (contract.conversion_issues.length > 0) {
    throw new Error(contract.conversion_issues.map((issue) => issue.detail).join('; '));
  }
  const presentation = defaultPresentation(
    contract.structure,
    contract.response_spec,
    contract.scoring_basis,
  );
  if (presentation == null) throw new Error('select fixture has no presentation');
  await insertQuestion({
    id: input.id,
    prompt: input.prompt,
    reference: 'B',
    choices: ['甲', '乙'],
    knowledgeIds: input.knowledgeIds,
  });
  const published = await publishQuestionGroup(db, {
    group_id: input.id,
    contract: {
      structure: contract.structure,
      response_spec: contract.response_spec,
      scoring_basis: contract.scoring_basis,
      execution_plan: contract.execution_plan,
      presentation,
      integrity_digest: contractIntegrityDigest({
        structure: contract.structure,
        response_spec: contract.response_spec,
        scoring_basis: contract.scoring_basis,
        execution_plan: contract.execution_plan,
        presentation,
      }),
    },
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    admission:
      input.admission === 'admitted'
        ? { state: 'admitted', evidence: ADMITTED }
        : { state: 'withheld', reason: 'unverified_rules' },
    actorRef: 'test:edit-submit',
    now: new Date(),
  });
  if (published.status !== 'published') {
    throw new Error(`fixture publish returned ${published.status}`);
  }
}

/** 旧行发布：option_set_key + single_choice/multi_choice，没有印出的规则。 */
async function publishLegacyAdmittedChoice(input: {
  id: string;
  prompt: string;
  reference: string;
  choices: string[];
  knowledgeIds: string[];
  slotKind: 'single_choice' | 'multi_choice';
}): Promise<{ partId: string; unitId: string; optionIds: string[]; accepted: string[] }> {
  const db = testDb();
  await insertQuestion({
    id: input.id,
    prompt: input.prompt,
    reference: input.reference,
    choices: input.choices,
    knowledgeIds: input.knowledgeIds,
  });
  const published = await publishQuestionGroupFromRow(db, {
    rootId: input.id,
    admission: { state: 'admitted', evidence: ADMITTED },
    availability: 'general_pool',
    actorRef: 'test:edit-submit',
    now: new Date(),
  });
  if (published.status !== 'published') {
    throw new Error(`legacy fixture publish returned ${published.status}`);
  }
  const [life] = await db
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, input.id));
  if (life?.scoring_admission_state !== 'admitted') {
    throw new Error(`legacy fixture admission is ${life?.scoring_admission_state ?? 'missing'}`);
  }
  const [revision] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.group_id, input.id));
  const slot = revision.response_spec.slots[0];
  const unit = revision.scoring_basis.units[0];
  if (slot == null || unit == null) throw new Error('legacy fixture has no slot');
  if (slot.kind !== input.slotKind) {
    throw new Error(`legacy fixture slot is ${slot.kind}, expected ${input.slotKind}`);
  }
  if (unit.criterion.kind !== 'option_set_key') {
    throw new Error(`legacy fixture criterion is ${unit.criterion.kind}`);
  }
  if (unit.rule != null) throw new Error('legacy fixture already carries a rule');
  const identity = optionIdentity(revision);
  const partId = revision.structure.parts[0]?.part_id;
  if (partId == null) throw new Error('legacy fixture has no part');
  return {
    partId,
    unitId: unit.scoring_unit_id,
    optionIds: identity.ids,
    accepted: identity.accepted,
  };
}

const BLANK_NORM = {
  version: 'blank-norm@1',
  nfkc: true,
  trim_outer: true,
  casefold: false,
  collapse_whitespace: true,
  ignore_punctuation: false,
  character_variants: [] as [string, string][],
};

const BLANK_RULE = {
  version: 1 as const,
  cases: [{ when: { correct: { eq: 1 } }, award: { points: 1 } }],
  otherwise: { points: 0 },
};

function blankDocument(
  prompt: string,
  accepted: readonly string[] = ['H2O'],
): QuestionDraftDocumentT {
  return QuestionDraftDocument.parse({
    schema_version: 2,
    parts: [
      {
        part_id: 'p1',
        prompt_md: prompt,
        material_ids: [],
        units: [
          {
            unit_id: 'u1',
            slot_id: 's1',
            response_class: 'blank',
            response_spec: { kind: 'blank', format: 'text' },
            key: {
              kind: 'blank',
              key: { kind: 'text', accepted: [...accepted], normalization: BLANK_NORM },
            },
            points: 1,
            rule: BLANK_RULE,
            method: { kind: 'exact' },
            material_refs: [],
            metadata: {},
          },
        ],
        metadata: {},
      },
    ],
    materials: [],
    knowledge_ids: [],
    metadata: {},
  });
}

async function publishAdmittedBlank(input: {
  id: string;
  prompt: string;
  knowledgeIds: string[];
  accepted?: string[];
  blankScoresZero?: boolean;
  aggregation?: { kind: 'capped_sum'; cap: number };
}): Promise<void> {
  const db = testDb();
  const accepted = input.accepted ?? ['H2O'];
  const doc = blankDocument(input.prompt, accepted);
  doc.knowledge_ids = input.knowledgeIds;
  const contract = draftDocumentToContract(doc, input.id);
  if (contract.conversion_issues.length > 0) {
    throw new Error(contract.conversion_issues.map((issue) => issue.detail).join('; '));
  }
  const scoring_basis = {
    ...contract.scoring_basis,
    blank_scores_zero: input.blankScoresZero ?? contract.scoring_basis.blank_scores_zero,
    ...(input.aggregation != null ? { aggregation: input.aggregation } : {}),
  };
  const presentation = defaultPresentation(
    contract.structure,
    contract.response_spec,
    scoring_basis,
  );
  if (presentation == null) throw new Error('blank fixture has no presentation');
  await insertQuestion({
    id: input.id,
    prompt: input.prompt,
    reference: accepted.join(' / '),
    choices: null,
    knowledgeIds: input.knowledgeIds,
  });
  const published = await publishQuestionGroup(db, {
    group_id: input.id,
    contract: {
      structure: contract.structure,
      response_spec: contract.response_spec,
      scoring_basis,
      execution_plan: contract.execution_plan,
      presentation,
      integrity_digest: contractIntegrityDigest({
        structure: contract.structure,
        response_spec: contract.response_spec,
        scoring_basis,
        execution_plan: contract.execution_plan,
        presentation,
      }),
    },
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    admission: { state: 'admitted', evidence: ADMITTED },
    actorRef: 'test:edit-submit',
    now: new Date(),
  });
  if (published.status !== 'published') {
    throw new Error(`blank fixture publish returned ${published.status}`);
  }
}

function twoBlankDocument(prompt: string): QuestionDraftDocumentT {
  const unit = (unitId: string, slotId: string, accepted: string) => ({
    unit_id: unitId,
    slot_id: slotId,
    response_class: 'blank' as const,
    response_spec: { kind: 'blank' as const, format: 'text' as const },
    key: {
      kind: 'blank' as const,
      key: { kind: 'text' as const, accepted: [accepted], normalization: BLANK_NORM },
    },
    points: 1,
    rule: BLANK_RULE,
    method: { kind: 'exact' as const },
    material_refs: [] as string[],
    metadata: {},
  });
  return QuestionDraftDocument.parse({
    schema_version: 2,
    parts: [
      {
        part_id: 'p1',
        prompt_md: prompt,
        material_ids: [],
        units: [unit('u1', 's1', '1'), unit('u2', 's2', '7')],
        metadata: {},
      },
    ],
    materials: [],
    knowledge_ids: [],
    metadata: {},
  });
}

/** 两空已准入题。u1 带槽位 placement，或在归一化上挂编码器不认识的 strip_units。 */
async function publishAdmittedTwoBlank(input: {
  id: string;
  prompt: string;
  knowledgeIds: string[];
  firstUnit: 'placement' | 'strip_units';
}): Promise<void> {
  const db = testDb();
  const doc = twoBlankDocument(input.prompt);
  doc.knowledge_ids = input.knowledgeIds;
  const contract = draftDocumentToContract(doc, input.id);
  if (contract.conversion_issues.length > 0) {
    throw new Error(contract.conversion_issues.map((issue) => issue.detail).join('; '));
  }
  if (input.firstUnit === 'placement') {
    const slot = contract.response_spec.slots.find((item) => item.slot_id === 's1');
    if (slot == null || slot.kind !== 'blank') throw new Error('two-blank fixture lost u1 slot');
    slot.placement = { row: 0, col: 1, label: '(1)' };
  } else {
    const unit = contract.scoring_basis.units.find((item) => item.scoring_unit_id === 'u1');
    if (unit == null || unit.criterion.kind !== 'blank_key' || unit.criterion.key.kind !== 'text') {
      throw new Error('two-blank fixture lost u1 key');
    }
    Object.assign(unit.criterion.key.normalization, { strip_units: true });
  }
  const presentation = defaultPresentation(
    contract.structure,
    contract.response_spec,
    contract.scoring_basis,
  );
  if (presentation == null) throw new Error('two-blank fixture has no presentation');
  await insertQuestion({
    id: input.id,
    prompt: input.prompt,
    reference: '1 / 7',
    choices: null,
    knowledgeIds: input.knowledgeIds,
  });
  const published = await publishQuestionGroup(db, {
    group_id: input.id,
    contract: {
      structure: contract.structure,
      response_spec: contract.response_spec,
      scoring_basis: contract.scoring_basis,
      execution_plan: contract.execution_plan,
      presentation,
      integrity_digest: contractIntegrityDigest({
        structure: contract.structure,
        response_spec: contract.response_spec,
        scoring_basis: contract.scoring_basis,
        execution_plan: contract.execution_plan,
        presentation,
      }),
    },
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    admission: { state: 'admitted', evidence: ADMITTED },
    actorRef: 'test:edit-submit',
    now: new Date(),
  });
  if (published.status !== 'published') {
    throw new Error(`two-blank fixture publish returned ${published.status}`);
  }
}

const RULE_REFERENCE = '水的化学式是 H2O。\n\n解析：每个水分子有两个氢。';

/** 旧行格式：参考答案含解析和空行，发布成 text + rule_reference，不能无损往返。 */
async function publishAdmittedRuleReference(input: {
  id: string;
  prompt: string;
  knowledgeIds: string[];
}): Promise<{ partId: string; unitId: string }> {
  const db = testDb();
  await insertQuestion({
    id: input.id,
    prompt: input.prompt,
    reference: RULE_REFERENCE,
    choices: null,
    knowledgeIds: input.knowledgeIds,
  });
  const published = await publishQuestionGroupFromRow(db, {
    rootId: input.id,
    admission: { state: 'admitted', evidence: ADMITTED },
    availability: 'general_pool',
    actorRef: 'test:edit-submit',
    now: new Date(),
  });
  if (published.status !== 'published') {
    throw new Error(`rule reference fixture publish returned ${published.status}`);
  }
  const [revision] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.group_id, input.id));
  const unit = revision.scoring_basis.units[0];
  const slot = revision.response_spec.slots[0];
  if (unit?.criterion.kind !== 'rule_reference') {
    throw new Error(`rule reference fixture criterion is ${unit?.criterion.kind ?? 'missing'}`);
  }
  if (slot?.kind !== 'text') {
    throw new Error(`rule reference fixture slot is ${slot?.kind ?? 'missing'}`);
  }
  const partId = revision.structure.parts[0]?.part_id;
  if (partId == null) throw new Error('rule reference fixture has no part');
  return { partId, unitId: unit.scoring_unit_id };
}

/** 旧多选，但选择界是恰好 2，不是默认的 1..选项数。 */
async function publishAdmittedExactMulti(input: {
  id: string;
  prompt: string;
  knowledgeIds: string[];
}): Promise<{ partId: string }> {
  const db = testDb();
  await insertQuestion({
    id: input.id,
    prompt: input.prompt,
    reference: 'AB',
    choices: ['甲', '乙', '丙'],
    knowledgeIds: input.knowledgeIds,
  });
  const [row] = await db.select().from(question).where(eq(question.id, input.id));
  const normalized = normalizeQuestionRowToContract(row);
  const slot = normalized.response_spec.slots[0];
  if (slot == null || slot.kind !== 'multi_choice') {
    throw new Error(`expected multi_choice, got ${slot?.kind ?? 'nothing'}`);
  }
  const response_spec = {
    ...normalized.response_spec,
    slots: normalized.response_spec.slots.map((item, index) =>
      index === 0 && item.kind === 'multi_choice'
        ? { ...item, min_select: 2, max_select: 2 }
        : item,
    ),
  };
  const published = await publishQuestionGroup(db, {
    group_id: input.id,
    contract: {
      structure: normalized.structure,
      response_spec,
      scoring_basis: normalized.scoring_basis,
      execution_plan: normalized.execution_plan,
      integrity_digest: contractIntegrityDigest({
        structure: normalized.structure,
        response_spec,
        scoring_basis: normalized.scoring_basis,
        execution_plan: normalized.execution_plan,
      }),
    },
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    admission: { state: 'admitted', evidence: ADMITTED },
    actorRef: 'test:edit-submit',
    now: new Date(),
  });
  if (published.status !== 'published') {
    throw new Error(`multi fixture publish returned ${published.status}`);
  }
  const partId = normalized.structure.parts[0]?.part_id;
  if (partId == null) throw new Error('multi fixture has no part');
  return { partId };
}

function promptOf(structured: unknown): string {
  if (structured == null || typeof structured !== 'object') return '';
  const parts = (structured as { parts?: { prompt_md?: string }[] }).parts;
  return parts?.[0]?.prompt_md ?? '';
}

function blockIdOf(draftRef: string): string {
  const [, id] = draftRef.split(':');
  if (id == null || id.length === 0) throw new Error(`bad draft ref ${draftRef}`);
  return id;
}

describe('edit/submit question boundary', () => {
  beforeEach(resetDb);

  // @invariant data: a draft created in the same save as its edit keeps that edit and the returned version
  // @fails-if the question_block create event is stamped later than the edit event, so the fold replays the v0 snapshot over the edit
  it('keeps the edit when a draft is created in the same save', async () => {
    const db = testDb();

    const created = await saveDraftEdit(db, {
      input: {
        action: 'save',
        document: {
          schema_version: 2,
          parts: [
            {
              part_id: 'p1',
              prompt_md: '草稿原文：函数值',
              material_ids: [],
              units: [
                {
                  unit_id: 'u1',
                  slot_id: 's1',
                  response_class: 'free',
                  response_spec: { kind: 'free' },
                  reference_md: '7',
                  points: 1,
                  method: { kind: 'human_review' },
                  material_refs: [],
                  metadata: {},
                },
              ],
              metadata: {},
            },
          ],
          materials: [],
          knowledge_ids: [],
          metadata: {},
        },
        request_id: 'clock-document',
      },
      ctx: ACTOR,
    });
    expect(created.status).toBe('saved');
    if (created.status !== 'saved') return;
    const createdBlock = (
      await db
        .select()
        .from(question_block)
        .where(eq(question_block.id, blockIdOf(created.draft_ref)))
    )[0];
    expect(createdBlock.version).toBe(created.draft_version);
    expect(created.draft_version).toBeGreaterThan(0);
    const followed = await saveDraftEdit(db, {
      input: {
        action: 'save',
        draft_ref: created.draft_ref,
        ops: [
          {
            op: 'replace_text',
            target: { kind: 'part', id: 'p1' },
            field: 'prompt_md',
            old: '函数值',
            new: '函数值已改',
          },
        ],
        request_id: 'clock-document-follow',
      },
      ctx: ACTOR,
    });
    expect(followed.status).toBe('saved');

    const publishedId = 'q-clock-ops';
    await insertQuestion({
      id: publishedId,
      prompt: '已发布题面：求函数值',
      reference: '7',
      choices: null,
      knowledgeIds: [],
    });
    const [row] = await db.select().from(question).where(eq(question.id, publishedId));
    const normalized = normalizeQuestionRowToContract(row);
    const firstPublish = await publishQuestionGroup(db, {
      group_id: publishedId,
      contract: {
        structure: normalized.structure,
        response_spec: normalized.response_spec,
        scoring_basis: normalized.scoring_basis,
        execution_plan: normalized.execution_plan,
        integrity_digest: normalized.integrity_digest,
      },
      expectedCurrentRevision: null,
      expectedAdmissionGeneration: null,
      availability: 'general_pool',
      admission: { state: 'withheld', reason: 'unverified_rules' },
      actorRef: 'test:edit-submit',
      now: new Date(),
    });
    expect(firstPublish.status).toBe('published');
    const partId = normalized.structure.parts[0].part_id;
    const edited = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: publishedId,
        ops: [
          {
            op: 'replace_text',
            target: { kind: 'part', id: partId },
            field: 'prompt_md',
            old: '函数值',
            new: '函数值已改',
          },
        ],
        request_id: 'clock-ops',
      },
      ctx: ACTOR,
    });
    expect(edited.status).toBe('saved');
    if (edited.status !== 'saved') return;
    const opsBlock = (
      await db
        .select()
        .from(question_block)
        .where(eq(question_block.imported_question_id, publishedId))
    )[0];
    expect(opsBlock.version).toBe(edited.draft_version);
    expect(promptOf(opsBlock.structured)).toContain('函数值已改');

    const acceptId = 'q-clock-accept';
    await publishSelect({
      id: acceptId,
      prompt: '待接受的题面写着函数值',
      knowledgeIds: [],
      admission: 'withheld',
    });
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'agent:copilot',
      payload: {
        kind: 'question_edit',
        target: { subject_kind: 'question', subject_id: acceptId },
        reason_md: '改一个错字',
        evidence_refs: [{ kind: 'question', id: acceptId }],
        proposed_change: {
          question_id: acceptId,
          edit_request: {
            question_id: acceptId,
            ops: [
              {
                op: 'replace_text',
                target: { kind: 'part', id: 'p1' },
                field: 'prompt_md',
                old: '函数值',
                new: '函数值已接受',
              },
            ],
          },
        },
        rollback_plan: { action: 'dismiss proposal' },
        cooldown_key: `clock-accept:${acceptId}`,
        suggestion_kind: 'proactive',
      },
    });
    await acceptAiProposal(db, proposalId, { decision: 'accept' });
    const revisions = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.group_id, acceptId))
      .orderBy(asc(question_revision.revision_ordinal));
    expect(revisions[revisions.length - 1].structure.parts[0].prompt_md).toContain('函数值已接受');
  });

  // @invariant grading: a prompt-only edit of an admitted question stays issuable on the current revision and in the practice pool
  // @fails-if submit withholds a scoring-unchanged edit, or the admitted legacy row is left unchanged while issuance rejects the current revision
  it('keeps an admitted question issuable after a content edit', async () => {
    const db = testDb();
    const kc = 'kc-admit';
    const qid = 'q-admit';
    await seedKnowledge(kc);
    await publishSelect({
      id: qid,
      prompt: '已准入题面：正确的是',
      knowledgeIds: [kc],
      admission: 'admitted',
    });
    const beforeIssue = await issueAssessment(db, {
      group_id: qid,
      now: new Date(),
      actorRef: 'test:issue',
    });
    expect(beforeIssue.status).toBe('issued');
    const [beforeLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    const previousRevision = beforeLife.current_revision_id;
    if (previousRevision == null) throw new Error('admitted fixture has no revision');
    expect(await poolFetch(db, { knowledgeId: kc })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: qid })]),
    );

    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: qid,
        ops: [
          {
            op: 'replace_text',
            target: { kind: 'part', id: 'p1' },
            field: 'prompt_md',
            old: '正确的是',
            new: '恰当的是',
          },
        ],
        request_id: 'admit-save',
      },
      ctx: ACTOR,
    });
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') return;
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'admit-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(submitted.status, JSON.stringify(submitted)).toBe('admitted');

    const [afterLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(afterLife.scoring_admission_state).toBe('admitted');
    const [afterRow] = await db.select().from(question).where(eq(question.id, qid));
    expect(afterRow.prompt_md).toContain('恰当的是');
    const current = await issueAssessment(db, {
      group_id: qid,
      now: new Date(),
      actorRef: 'test:issue',
    });
    const pinned = await issueAssessment(db, {
      group_id: qid,
      revision_id: previousRevision,
      now: new Date(),
      actorRef: 'test:issue',
    });
    expect(current.status, JSON.stringify(current)).toBe('issued');
    expect(pinned.status, JSON.stringify(pinned)).toBe('revision_mismatch');
    expect(await poolFetch(db, { knowledgeId: kc })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: qid })]),
    );
  });

  // @invariant data: identical prompt, reference and choices are one question across source refs and knowledge points
  // @fails-if the content hash includes source or knowledge ids, so the second submit inserts another row instead of merging
  it('merges an exact duplicate onto the existing question', async () => {
    const db = testDb();
    await seedKnowledge('kc-exact-a');
    await seedKnowledge('kc-exact-b');
    const prompt = '已知一次函数 y = 2x + 1，求 x = 3 时的函数值。';
    const firstSaved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        document: freeDocument(prompt, 'kc-exact-a', 'gen-ref-a'),
        request_id: 'exact-save-a',
      },
      ctx: ACTOR,
    });
    expect(firstSaved.status).toBe('saved');
    if (firstSaved.status !== 'saved') return;
    const first = await submitDraftQuestion(
      db,
      {
        draft_ref: firstSaved.draft_ref,
        expected_draft_version: firstSaved.draft_version,
        request_id: 'exact-submit-a',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(first.status, JSON.stringify(first)).not.toBe('conflict');
    expect('question_id' in first, JSON.stringify(first)).toBe(true);
    if (!('question_id' in first)) return;
    const secondSaved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        document: freeDocument(prompt, 'kc-exact-b', 'gen-ref-b'),
        request_id: 'exact-save-b',
      },
      ctx: ACTOR,
    });
    expect(secondSaved.status).toBe('saved');
    if (secondSaved.status !== 'saved') return;
    const second = await submitDraftQuestion(
      db,
      {
        draft_ref: secondSaved.draft_ref,
        expected_draft_version: secondSaved.draft_version,
        request_id: 'exact-submit-b',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(second.status, JSON.stringify(second)).toBe('conflict');
    if (second.status !== 'conflict') return;
    expect(second.reason, JSON.stringify(second)).toBe('duplicate_exact');
    const keptId = first.question_id;
    if (keptId == null) throw new Error('first submit did not return a question id');
    expect(second.existing_question_id).toBe(keptId);
    const [kept] = await db.select().from(question).where(eq(question.id, keptId));
    expect(kept.knowledge_ids).toEqual(expect.arrayContaining(['kc-exact-a', 'kc-exact-b']));
    const rows = await db.select({ id: question.id }).from(question);
    expect(rows.map((row) => row.id)).toEqual([keptId]);
  });

  // @invariant data: a one-character variant of an existing question in the same knowledge point is not published
  // @fails-if the draft submit path skips the n-gram near-duplicate check
  it('rejects a near-duplicate variant', async () => {
    const db = testDb();
    await seedKnowledge('kc-near');
    const original =
      '已知函数 f(x) 等于 x 的平方加二 x 加一，当 x 等于三时函数值是多少，请写出计算过程';
    const variant = original.replace('三', '四');
    const firstSaved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        document: freeDocument(original, 'kc-near', 'near-a'),
        request_id: 'near-save-a',
      },
      ctx: ACTOR,
    });
    expect(firstSaved.status).toBe('saved');
    if (firstSaved.status !== 'saved') return;
    const first = await submitDraftQuestion(
      db,
      {
        draft_ref: firstSaved.draft_ref,
        expected_draft_version: firstSaved.draft_version,
        request_id: 'near-submit-a',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(first.status, JSON.stringify(first)).not.toBe('conflict');
    const secondSaved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        document: freeDocument(variant, 'kc-near', 'near-b'),
        request_id: 'near-save-b',
      },
      ctx: ACTOR,
    });
    expect(secondSaved.status).toBe('saved');
    if (secondSaved.status !== 'saved') return;
    const second = await submitDraftQuestion(
      db,
      {
        draft_ref: secondSaved.draft_ref,
        expected_draft_version: secondSaved.draft_version,
        request_id: 'near-submit-b',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(second.status, JSON.stringify(second)).toBe('conflict');
    if (second.status !== 'conflict') return;
    expect(second.reason, JSON.stringify(second)).toBe('near_dup');
    const rows = await db.select({ id: question.id }).from(question);
    expect(rows).toHaveLength(1);
  });

  // @invariant data: editing a published choice question keeps its option ids and accepted answer
  // @fails-if revisionToDraftDocument maps single_choice and option_set_key onto a free unit with no key
  it('keeps choice options and the answer key across an edit', async () => {
    const db = testDb();
    const qid = 'q-choice';
    const prompt = '下列说法正确的是';
    await insertQuestion({
      id: qid,
      prompt,
      reference: 'B',
      choices: ['甲', '乙', '丙'],
      knowledgeIds: [],
    });
    const [row] = await db.select().from(question).where(eq(question.id, qid));
    const normalized = normalizeQuestionRowToContract(row);
    const first = await publishQuestionGroup(db, {
      group_id: qid,
      contract: {
        structure: normalized.structure,
        response_spec: normalized.response_spec,
        scoring_basis: normalized.scoring_basis,
        execution_plan: normalized.execution_plan,
        integrity_digest: normalized.integrity_digest,
      },
      expectedCurrentRevision: null,
      expectedAdmissionGeneration: null,
      availability: 'general_pool',
      admission: { state: 'withheld', reason: 'unverified_rules' },
      actorRef: 'test:edit-submit',
      now: new Date(),
    });
    expect(first.status).toBe('published');
    const partId = normalized.structure.parts[0].part_id;
    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: qid,
        ops: [
          {
            op: 'replace_text',
            target: { kind: 'part', id: partId },
            field: 'prompt_md',
            old: '正确的是',
            new: '恰当的是',
          },
        ],
        request_id: 'choice-save',
      },
      ctx: ACTOR,
    });
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') return;
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'choice-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(submitted.status, JSON.stringify(submitted)).not.toBe('conflict');
    if ('published' in submitted) {
      throw new Error(`choice edit did not publish: ${submitted.detail}`);
    }

    const revisions = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.group_id, qid))
      .orderBy(asc(question_revision.revision_ordinal));
    expect(revisions).toHaveLength(2);
    const before = optionIdentity(revisions[0]);
    const after = optionIdentity(revisions[1]);
    expect(before.ids.length).toBeGreaterThanOrEqual(2);
    expect(after.ids).toEqual(before.ids);
    expect(after.texts).toEqual(before.texts);
    expect(after.accepted).toEqual(before.accepted);
    expect(after.accepted.length).toBeGreaterThan(0);
  });

  // @invariant grading: changing an admitted answer key drops admission instead of copying the old evidence
  // @fails-if a key edit stays admitted and issuance scores the new key with the previous evidence
  it('withholds admission when the answer key changes', async () => {
    const db = testDb();
    const kc = 'kc-key';
    const qid = 'q-key';
    await seedKnowledge(kc);
    await publishSelect({
      id: qid,
      prompt: '已准入选择题：正确的是',
      knowledgeIds: [kc],
      admission: 'admitted',
    });
    const [beforeLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: qid,
        ops: [
          {
            op: 'set',
            target: { kind: 'unit', id: 'u1' },
            fields: { key: { kind: 'select', accepted_item_ids: ['opt-a'] } },
          },
        ],
        request_id: 'key-save',
      },
      ctx: ACTOR,
    });
    expect(saved.status, JSON.stringify(saved)).toBe('saved');
    if (saved.status !== 'saved') return;
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'key-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(submitted.status, JSON.stringify(submitted)).toBe('withheld');
    const [afterLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(afterLife.scoring_admission_state).toBe('withheld');
    expect(afterLife.scoring_admission_evidence).not.toEqual(beforeLife.scoring_admission_evidence);
    const issued = await issueAssessment(db, {
      group_id: qid,
      now: new Date(),
      actorRef: 'test:issue',
    });
    expect(issued.status, JSON.stringify(issued)).not.toBe('issued');
  });

  // @invariant grading: an admitted question edited into human review is withheld, leaves the practice pool, and is not issued
  // @fails-if the receipt stays admitted while issuance refuses the human-review unit and the pool still selects the row
  it('pulls a human-review edit out of the practice pool', async () => {
    const db = testDb();
    const kc = 'kc-human';
    const qid = 'q-human';
    await seedKnowledge(kc);
    await publishSelect({
      id: qid,
      prompt: '已准入题改为人工判',
      knowledgeIds: [kc],
      admission: 'admitted',
    });
    expect(await poolFetch(db, { knowledgeId: kc })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: qid })]),
    );
    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: qid,
        ops: [
          {
            op: 'set',
            target: { kind: 'unit', id: 'u1' },
            fields: { method: { kind: 'human_review' } },
          },
        ],
        request_id: 'human-save',
      },
      ctx: ACTOR,
    });
    expect(saved.status, JSON.stringify(saved)).toBe('saved');
    if (saved.status !== 'saved') return;
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'human-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(submitted.status, JSON.stringify(submitted)).toBe('withheld');
    if ('published' in submitted && submitted.published === false) {
      throw new Error(`human-review edit did not publish: ${submitted.detail}`);
    }
    const [afterLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(afterLife.scoring_admission_state).toBe('withheld');
    expect(await poolFetch(db, { knowledgeId: kc })).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: qid })]),
    );
    const issued = await issueAssessment(db, {
      group_id: qid,
      now: new Date(),
      actorRef: 'test:issue',
    });
    expect(issued.status, JSON.stringify(issued)).not.toBe('issued');
  });

  // @invariant data: a draft the publish seam would throw on returns withheld instead of an exception
  // @fails-if submit lets publishQuestionGroup throw unadmitted_model_executor or scoring_basis invalid
  it('returns withheld when the draft is not publishable', async () => {
    const db = testDb();
    const kc = 'kc-barrier';
    await seedKnowledge(kc);
    const rubricId = 'q-rubric';
    await publishSelect({
      id: rubricId,
      prompt: '改成模型判分的题',
      knowledgeIds: [kc],
      admission: 'admitted',
    });
    const rubricSaved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: rubricId,
        ops: [
          {
            op: 'set',
            target: { kind: 'unit', id: 'u1' },
            fields: { method: { kind: 'ai-rubric' } },
          },
        ],
        request_id: 'rubric-save',
      },
      ctx: ACTOR,
    });
    expect(rubricSaved.status, JSON.stringify(rubricSaved)).toBe('saved');
    if (rubricSaved.status !== 'saved') return;
    const rubricSubmitted = await submitDraftQuestion(
      db,
      {
        draft_ref: rubricSaved.draft_ref,
        expected_draft_version: rubricSaved.draft_version,
        request_id: 'rubric-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(rubricSubmitted.status, JSON.stringify(rubricSubmitted)).toBe('withheld');

    const ruleId = 'q-rule';
    await publishSelect({
      id: ruleId,
      prompt: '规则指标不适用的题',
      knowledgeIds: [kc],
      admission: 'admitted',
    });
    const ruleSaved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: ruleId,
        ops: [
          {
            op: 'set',
            target: { kind: 'unit', id: 'u1' },
            fields: {
              rule: {
                version: 1,
                cases: [{ when: { correct: { eq: 1 } }, award: { points: 1 } }],
                otherwise: { points: 0 },
              },
            },
          },
        ],
        request_id: 'rule-save',
      },
      ctx: ACTOR,
    });
    expect(ruleSaved.status, JSON.stringify(ruleSaved)).toBe('saved');
    if (ruleSaved.status !== 'saved') return;
    expect(ruleSaved.publishable).toBe(false);
    const ruleSubmitted = await submitDraftQuestion(
      db,
      {
        draft_ref: ruleSaved.draft_ref,
        expected_draft_version: ruleSaved.draft_version,
        request_id: 'rule-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(ruleSubmitted.status, JSON.stringify(ruleSubmitted)).toBe('withheld');
    if (!('published' in ruleSubmitted) || ruleSubmitted.published !== false) {
      throw new Error(`invalid rule published: ${JSON.stringify(ruleSubmitted)}`);
    }
    expect(ruleSubmitted.issues?.map((issue) => issue.code)).toContain(
      'rule_metric_not_applicable',
    );
  });

  // @invariant concurrency: a new issuance cannot pin a superseded revision, while replaying the original issuance still returns it
  // @fails-if a new issuance of the previous revision succeeds after a newer revision is current
  it('refuses a new issuance of a superseded revision', async () => {
    const db = testDb();
    const kc = 'kc-pin';
    const qid = 'q-pin';
    await seedKnowledge(kc);
    await publishSelect({
      id: qid,
      prompt: '钉住旧版的题面写着正确的是',
      knowledgeIds: [kc],
      admission: 'admitted',
    });
    const issued = await issueAssessment(db, {
      group_id: qid,
      issuance_id: 'iss-pin-replay',
      now: new Date(),
      actorRef: 'test:issue',
    });
    expect(issued.status, JSON.stringify(issued)).toBe('issued');
    if (issued.status !== 'issued' && issued.status !== 'replayed') return;
    const previousRevision = issued.issuance.binding.revision_id;
    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: qid,
        ops: [
          {
            op: 'replace_text',
            target: { kind: 'part', id: 'p1' },
            field: 'prompt_md',
            old: '正确的是',
            new: '恰当的是',
          },
        ],
        request_id: 'pin-save',
      },
      ctx: ACTOR,
    });
    expect(saved.status, JSON.stringify(saved)).toBe('saved');
    if (saved.status !== 'saved') return;
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'pin-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(submitted.status, JSON.stringify(submitted)).toBe('admitted');
    const pinned = await issueAssessment(db, {
      group_id: qid,
      revision_id: previousRevision,
      now: new Date(),
      actorRef: 'test:issue',
    });
    expect(pinned.status, JSON.stringify(pinned)).toBe('revision_mismatch');
    const replayed = await issueAssessment(db, {
      group_id: qid,
      issuance_id: 'iss-pin-replay',
      revision_id: previousRevision,
      now: new Date(),
      actorRef: 'test:issue',
    });
    expect(replayed.status, JSON.stringify(replayed)).toBe('replayed');
  });

  // @invariant data: choice questions that share a stem but not their options are not near-duplicates
  // @fails-if the near-duplicate check compares only the prompt and rejects a different option set
  it('keeps a shared stem with different choices', async () => {
    const db = testDb();
    const kc = 'kc-stem';
    await seedKnowledge(kc);
    const stem = '下列关于函数单调性的说法中，正确的是';
    const firstLabels = [
      '函数在区间上递增意味着自变量变大时函数值也变大',
      '函数在区间上递减意味着自变量变大时函数值变小',
      '常函数在定义域内既递增也递减',
      '单调区间必须是定义域的子集',
    ];
    const otherLabels = [
      '抛物线开口向上时对称轴左侧递减',
      '一次函数斜率为负时图像下降',
      '指数函数底数大于一时整体上升',
      '对数函数在定义域内可以先增后减',
    ];
    const firstSaved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        document: choiceDocument(stem, kc, 'stem-a', firstLabels),
        request_id: 'stem-save-a',
      },
      ctx: ACTOR,
    });
    expect(firstSaved.status, JSON.stringify(firstSaved)).toBe('saved');
    if (firstSaved.status !== 'saved') return;
    const first = await submitDraftQuestion(
      db,
      {
        draft_ref: firstSaved.draft_ref,
        expected_draft_version: firstSaved.draft_version,
        request_id: 'stem-submit-a',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(first.status, JSON.stringify(first)).not.toBe('conflict');
    const different = await saveDraftEdit(db, {
      input: {
        action: 'save',
        document: choiceDocument(stem, kc, 'stem-b', otherLabels),
        request_id: 'stem-save-b',
      },
      ctx: ACTOR,
    });
    expect(different.status, JSON.stringify(different)).toBe('saved');
    if (different.status !== 'saved') return;
    const second = await submitDraftQuestion(
      db,
      {
        draft_ref: different.draft_ref,
        expected_draft_version: different.draft_version,
        request_id: 'stem-submit-b',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(second.status, JSON.stringify(second)).not.toBe('conflict');
    const nearSaved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        document: choiceDocument(stem.replace('中', '里'), kc, 'stem-c', firstLabels),
        request_id: 'stem-save-c',
      },
      ctx: ACTOR,
    });
    expect(nearSaved.status, JSON.stringify(nearSaved)).toBe('saved');
    if (nearSaved.status !== 'saved') return;
    const near = await submitDraftQuestion(
      db,
      {
        draft_ref: nearSaved.draft_ref,
        expected_draft_version: nearSaved.draft_version,
        request_id: 'stem-submit-c',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(near.status, JSON.stringify(near)).toBe('conflict');
    if (near.status !== 'conflict') return;
    expect(near.reason, JSON.stringify(near)).toBe('near_dup');
  });

  // @invariant data: withdrawn and archived questions are not near-duplicate neighbors
  // @fails-if the near-duplicate pool still compares against a withdrawn or archived row
  it('ignores withdrawn and archived questions when checking near duplicates', async () => {
    const db = testDb();
    const kc = 'kc-retired';
    await seedKnowledge(kc);
    const stem = '下列关于函数单调性的说法中，正确的是';
    const labels = [
      '函数在区间上递增意味着自变量变大时函数值也变大',
      '函数在区间上递减意味着自变量变大时函数值变小',
      '常函数在定义域内既递增也递减',
      '单调区间必须是定义域的子集',
    ];
    const now = new Date();
    await insertQuestion({
      id: 'q-archived-neighbor',
      prompt: stem,
      reference: 'B',
      choices: labels,
      knowledgeIds: [kc],
      metadata: { archived_at: 1 },
    });
    await insertQuestion({
      id: 'q-withdrawn-neighbor',
      prompt: stem,
      reference: 'B',
      choices: labels,
      knowledgeIds: [kc],
    });
    await db.insert(question_group_lifecycle).values({
      group_id: 'q-withdrawn-neighbor',
      current_revision_id: null,
      availability: 'general_pool',
      scoring_admission_state: 'withheld',
      scoring_admission_withheld_reason: 'unverified_rules',
      scoring_admission_generation: 0,
      claim_policy: 'unbounded',
      suspended: false,
      withdrawn: true,
      withdrawn_at: now,
      created_at: now,
      updated_at: now,
    });
    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        document: choiceDocument(stem, kc, 'retired-new', labels),
        request_id: 'retired-save',
      },
      ctx: ACTOR,
    });
    expect(saved.status, JSON.stringify(saved)).toBe('saved');
    if (saved.status !== 'saved') return;
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'retired-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(submitted.status, JSON.stringify(submitted)).not.toBe('conflict');
  });

  // @invariant grading: a text-only edit of an admitted old-format single_choice question keeps admission and can still be issued
  // @fails-if raw JSON comparison of option_set_key against the re-encoded select_key contract withholds a prompt-only edit
  it('keeps admission when only the text of an old-format single choice question changes', async () => {
    const db = testDb();
    const kc = 'kc-legacy-single';
    const qid = 'q-legacy-single';
    await seedKnowledge(kc);
    const legacy = await publishLegacyAdmittedChoice({
      id: qid,
      prompt: '旧格式单选题：正确的是',
      reference: 'B',
      choices: ['甲', '乙', '丙'],
      knowledgeIds: [kc],
      slotKind: 'single_choice',
    });
    expect(legacy.accepted).toHaveLength(1);
    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: qid,
        ops: [
          {
            op: 'replace_text',
            target: { kind: 'part', id: legacy.partId },
            field: 'prompt_md',
            old: '正确的是',
            new: '恰当的是',
          },
        ],
        request_id: 'legacy-single-save',
      },
      ctx: ACTOR,
    });
    expect(saved.status, JSON.stringify(saved)).toBe('saved');
    if (saved.status !== 'saved') return;
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'legacy-single-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(submitted.status, JSON.stringify(submitted)).toBe('admitted');
    const [afterLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(afterLife.scoring_admission_state).toBe('admitted');
    const [afterRow] = await db.select().from(question).where(eq(question.id, qid));
    expect(afterRow.draft_status).not.toBe('draft');
    expect(afterRow.prompt_md).toContain('恰当的是');
    const issued = await issueAssessment(db, {
      group_id: qid,
      now: new Date(),
      actorRef: 'test:issue',
    });
    expect(issued.status, JSON.stringify(issued)).toBe('issued');
    expect(await poolFetch(db, { knowledgeId: kc })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: qid })]),
    );
  });

  // @invariant grading: a text-only edit of an admitted old-format multi_choice question keeps admission and can still be issued
  // @fails-if multi_choice pick and option_set_key are treated as a scoring change after re-encoding to select
  it('keeps admission when only the text of an old-format multi choice question changes', async () => {
    const db = testDb();
    const kc = 'kc-legacy-multi';
    const qid = 'q-legacy-multi';
    await seedKnowledge(kc);
    const legacy = await publishLegacyAdmittedChoice({
      id: qid,
      prompt: '旧格式多选题：正确的是',
      reference: 'AC',
      choices: ['甲', '乙', '丙'],
      knowledgeIds: [kc],
      slotKind: 'multi_choice',
    });
    expect(legacy.accepted).toHaveLength(2);
    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: qid,
        ops: [
          {
            op: 'replace_text',
            target: { kind: 'part', id: legacy.partId },
            field: 'prompt_md',
            old: '正确的是',
            new: '恰当的是',
          },
        ],
        request_id: 'legacy-multi-save',
      },
      ctx: ACTOR,
    });
    expect(saved.status, JSON.stringify(saved)).toBe('saved');
    if (saved.status !== 'saved') return;
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'legacy-multi-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(submitted.status, JSON.stringify(submitted)).toBe('admitted');
    const [afterLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(afterLife.scoring_admission_state).toBe('admitted');
    const [afterRow] = await db.select().from(question).where(eq(question.id, qid));
    expect(afterRow.draft_status).not.toBe('draft');
    const issued = await issueAssessment(db, {
      group_id: qid,
      now: new Date(),
      actorRef: 'test:issue',
    });
    expect(issued.status, JSON.stringify(issued)).toBe('issued');
    expect(await poolFetch(db, { knowledgeId: kc })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: qid })]),
    );
  });

  // @invariant grading: changing the answer key of an admitted old-format choice question withholds admission
  // @fails-if canonical normalization ignores accepted option ids and keeps the previous admission
  it('withholds an old-format choice question when its answer key changes', async () => {
    const db = testDb();
    const kc = 'kc-legacy-key';
    const qid = 'q-legacy-key';
    await seedKnowledge(kc);
    const legacy = await publishLegacyAdmittedChoice({
      id: qid,
      prompt: '旧格式单选题改键：正确的是',
      reference: 'B',
      choices: ['甲', '乙', '丙'],
      knowledgeIds: [kc],
      slotKind: 'single_choice',
    });
    const nextKey = legacy.optionIds.find((id) => !legacy.accepted.includes(id));
    if (nextKey == null) throw new Error('legacy fixture has no alternate option');
    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: qid,
        ops: [
          {
            op: 'set',
            target: { kind: 'unit', id: legacy.unitId },
            fields: { key: { kind: 'select', accepted_item_ids: [nextKey] } },
          },
        ],
        request_id: 'legacy-key-save',
      },
      ctx: ACTOR,
    });
    expect(saved.status, JSON.stringify(saved)).toBe('saved');
    if (saved.status !== 'saved') return;
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'legacy-key-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(submitted.status, JSON.stringify(submitted)).toBe('withheld');
    const [afterLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(afterLife.scoring_admission_state).toBe('withheld');
    const [afterRow] = await db.select().from(question).where(eq(question.id, qid));
    expect(afterRow.draft_status).toBe('draft');
    const issued = await issueAssessment(db, {
      group_id: qid,
      now: new Date(),
      actorRef: 'test:issue',
    });
    expect(issued.status, JSON.stringify(issued)).not.toBe('issued');
    expect(await poolFetch(db, { knowledgeId: kc })).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: qid })]),
    );
  });

  // @invariant grading: a prompt-only edit of an admitted blank question keeps its normalisation and still scores a full-width answer
  // @fails-if the draft round trip turns nfkc or collapse_whitespace off, so Ｈ2Ｏ scores 0 while admission stays
  it('keeps blank normalisation and full-width credit after a text-only edit', async () => {
    const db = testDb();
    const kc = 'kc-blank-norm';
    const qid = 'q-blank-norm';
    await seedKnowledge(kc);
    const prompt = '旧填空：水的化学式是';
    await publishAdmittedBlank({ id: qid, prompt, knowledgeIds: [kc] });
    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: qid,
        ops: [
          {
            op: 'replace_text',
            target: { kind: 'part', id: 'p1' },
            field: 'prompt_md',
            old: '化学式',
            new: '分子式',
          },
        ],
        request_id: 'blank-norm-save',
      },
      ctx: ACTOR,
    });
    expect(saved.status, JSON.stringify(saved)).toBe('saved');
    if (saved.status !== 'saved') return;
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'blank-norm-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(submitted.status, JSON.stringify(submitted)).toBe('admitted');
    const [afterLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(afterLife.scoring_admission_state).toBe('admitted');
    const [revision] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, afterLife.current_revision_id ?? ''));
    const unit = revision.scoring_basis.units[0];
    if (unit == null || unit.criterion.kind !== 'blank_key' || unit.criterion.key.kind !== 'text') {
      throw new Error(`blank edit published ${unit?.criterion.kind ?? 'nothing'}`);
    }
    expect(unit.criterion.key.normalization).toEqual(BLANK_NORM);
    const graded = await gradeBlankExactUnit(unit, {
      slot_id: unit.slot_refs[0] ?? 's1',
      kind: 'blank',
      state: 'answered',
      text: 'Ｈ2Ｏ',
    });
    expect(graded.status, JSON.stringify(graded)).toBe('scored');
    if (graded.status !== 'scored') return;
    expect(graded.points_awarded, JSON.stringify(graded)).toBe(1);
    const issued = await issueAssessment(db, {
      group_id: qid,
      now: new Date(),
      actorRef: 'test:issue',
    });
    expect(issued.status, JSON.stringify(issued)).toBe('issued');
    expect(await poolFetch(db, { knowledgeId: kc })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: qid })]),
    );
  });

  // @invariant grading: a prompt-only edit does not publish when blank_scores_zero would flip
  // @fails-if a lossy round trip still publishes a withheld revision that becomes current and turns blank_scores_zero true
  it('does not publish when a prompt edit would flip blank_scores_zero', async () => {
    const db = testDb();
    const kc = 'kc-blank-lossy';
    const qid = 'q-blank-lossy';
    await seedKnowledge(kc);
    await publishAdmittedBlank({
      id: qid,
      prompt: '丢失字段的填空：水的化学式是',
      knowledgeIds: [kc],
      blankScoresZero: false,
    });
    await expectPromptEditLeavesCurrent({
      qid,
      partId: 'p1',
      old: '化学式',
      saveRequest: 'blank-lossy-save',
      submitRequest: 'blank-lossy-submit',
    });
    const [current] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.group_id, qid));
    expect(current.scoring_basis.blank_scores_zero).toBe(false);
  });

  // @invariant grading: a prompt-only edit does not publish when capped_sum would become sum
  // @fails-if a lossy round trip publishes a withheld revision whose aggregation is sum
  it('does not publish when a prompt edit would replace capped_sum with sum', async () => {
    const db = testDb();
    const kc = 'kc-capped-sum';
    const qid = 'q-capped-sum';
    await seedKnowledge(kc);
    await publishAdmittedBlank({
      id: qid,
      prompt: '封顶聚合的填空：水的化学式是',
      knowledgeIds: [kc],
      aggregation: { kind: 'capped_sum', cap: 1 },
    });
    await expectPromptEditLeavesCurrent({
      qid,
      partId: 'p1',
      old: '化学式',
      saveRequest: 'capped-sum-save',
      submitRequest: 'capped-sum-submit',
    });
    const [current] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.group_id, qid));
    expect(current.scoring_basis.aggregation).toEqual({ kind: 'capped_sum', cap: 1 });
  });

  // @invariant grading: a prompt-only edit does not publish when exact multi_choice bounds would be dropped
  // @fails-if a lossy round trip publishes a select revision and the exactly-2 bounds are no longer current
  it('does not publish when a prompt edit would drop exact multi_choice bounds', async () => {
    const db = testDb();
    const kc = 'kc-multi-bounds';
    const qid = 'q-multi-bounds';
    await seedKnowledge(kc);
    const { partId } = await publishAdmittedExactMulti({
      id: qid,
      prompt: '恰好选两项：正确的是',
      knowledgeIds: [kc],
    });
    await expectPromptEditLeavesCurrent({
      qid,
      partId,
      old: '恰好',
      saveRequest: 'multi-bounds-save',
      submitRequest: 'multi-bounds-submit',
    });
    const [current] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.group_id, qid));
    const slot = current.response_spec.slots[0];
    if (slot == null || slot.kind !== 'multi_choice') {
      throw new Error(`current slot is ${slot?.kind ?? 'missing'}`);
    }
    expect(slot.min_select).toBe(2);
    expect(slot.max_select).toBe(2);
  });

  // @invariant grading: case_sensitive true together with casefold true is not a publishable key
  // @fails-if the draft accepts both flags and a case-sensitive answer is graded case-insensitively
  // @invariant grading: case_sensitive false together with casefold false is not a publishable key
  // @fails-if the draft accepts both flags and then drops case_sensitive false
  // @invariant grading: trim false together with trim_outer true is not a publishable key
  // @fails-if the draft accepts both flags and then drops trim false
  // @invariant grading: trim true together with trim_outer false is not a publishable key
  // @fails-if the draft accepts both flags and then drops trim true
  it.each([
    {
      title: 'rejects a blank key that is both case sensitive and casefolded',
      prompt: '大小写冲突：水的化学式是',
      key: {
        kind: 'text',
        accepted: ['H2O'],
        case_sensitive: true,
        normalization: { ...BLANK_NORM, casefold: true },
      },
      requestId: 'casefold-conflict-save',
      fragment: 'casefold',
    },
    {
      title: 'rejects a blank key that asks to ignore case and also keep case',
      prompt: '大小写双关：水的化学式是',
      key: {
        kind: 'text',
        accepted: ['H2O'],
        case_sensitive: false,
        normalization: { ...BLANK_NORM, casefold: false },
      },
      requestId: 'casefold-false-conflict-save',
      fragment: 'casefold false',
    },
    {
      title: 'rejects a blank key that asks to keep outer spaces and also trim them',
      prompt: '空白双关：水的化学式是',
      key: {
        kind: 'text',
        accepted: ['H2O'],
        trim: false,
        normalization: { ...BLANK_NORM, trim_outer: true },
      },
      requestId: 'trim-false-conflict-save',
      fragment: 'trim_outer true',
    },
    {
      title: 'rejects a blank key that asks to trim outer spaces and also keep them',
      prompt: '空白反向双关：水的化学式是',
      key: {
        kind: 'text',
        accepted: ['H2O'],
        trim: true,
        normalization: { ...BLANK_NORM, trim_outer: false },
      },
      requestId: 'trim-true-conflict-save',
      fragment: 'trim_outer false',
    },
  ] satisfies {
    title: string;
    prompt: string;
    key: DraftBlankTextKeyT;
    requestId: string;
    fragment: string;
  }[])('$title', async ({ prompt, key, requestId, fragment }) => {
    const db = testDb();
    const doc = blankDocument(prompt);
    const unit = doc.parts[0]?.units[0];
    if (unit?.key?.kind !== 'blank' || unit.key.key.kind !== 'text') {
      throw new Error('blank fixture has no text key');
    }
    unit.key.key = key;
    const saved = await saveDraftEdit(db, {
      input: { action: 'save', document: doc, request_id: requestId },
      ctx: ACTOR,
    });
    expect(saved.status, JSON.stringify(saved)).toBe('rejected');
    if (saved.status !== 'rejected') return;
    expect(JSON.stringify(saved.issues)).toContain(fragment);
  });

  // @invariant grading: a key edit that omits normalisation keeps the previous revision's normalisation
  // @fails-if the omitted normalisation falls back to defaults and full-width ＨＯＨ scores 0
  it('keeps the previous blank normalisation when a key edit omits it', async () => {
    const db = testDb();
    const kc = 'kc-blank-inherit';
    const qid = 'q-blank-inherit';
    await seedKnowledge(kc);
    await publishAdmittedBlank({ id: qid, prompt: '沿用归一化：水的化学式是', knowledgeIds: [kc] });
    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: qid,
        ops: [
          {
            op: 'set',
            target: { kind: 'unit', id: 'u1' },
            fields: { key: { kind: 'blank', key: { kind: 'text', accepted: ['HOH'] } } },
          },
        ],
        request_id: 'blank-inherit-save',
      },
      ctx: ACTOR,
    });
    expect(saved.status, JSON.stringify(saved)).toBe('saved');
    if (saved.status !== 'saved') return;
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'blank-inherit-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(submitted.status, JSON.stringify(submitted)).toBe('withheld');
    if (submitted.status !== 'withheld' || 'published' in submitted) {
      throw new Error(JSON.stringify(submitted));
    }
    const [afterLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    const [revision] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, afterLife.current_revision_id ?? ''));
    const unit = revision.scoring_basis.units[0];
    if (unit == null || unit.criterion.kind !== 'blank_key' || unit.criterion.key.kind !== 'text') {
      throw new Error(`key edit published ${unit?.criterion.kind ?? 'nothing'}`);
    }
    expect(unit.criterion.key.accepted).toEqual(['HOH']);
    expect(unit.criterion.key.normalization).toEqual(BLANK_NORM);
    const graded = await gradeBlankExactUnit(unit, {
      slot_id: unit.slot_refs[0] ?? 's1',
      kind: 'blank',
      state: 'answered',
      text: 'ＨＯＨ',
    });
    expect(graded.status, JSON.stringify(graded)).toBe('scored');
    if (graded.status !== 'scored') return;
    expect(graded.points_awarded, JSON.stringify(graded)).toBe(1);
  });

  // @invariant grading: a prompt-only edit of an admitted rule_reference question publishes the new prompt and the stored scoring layers
  // @fails-if the lossy round trip refuses the edit, or the published revision replaces rule_reference with a rewritten layer
  it('publishes a prompt typo on an old rule_reference question without rewriting scoring', async () => {
    const db = testDb();
    const kc = 'kc-rule-typo';
    const qid = 'q-rule-typo';
    await seedKnowledge(kc);
    const prompt = '旧解答：水的化学式是什么';
    const { partId } = await publishAdmittedRuleReference({
      id: qid,
      prompt,
      knowledgeIds: [kc],
    });
    const [before] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.group_id, qid));
    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: qid,
        ops: [
          {
            op: 'replace_text',
            target: { kind: 'part', id: partId },
            field: 'prompt_md',
            old: '化学式',
            new: '分子式',
          },
        ],
        request_id: 'rule-typo-save',
      },
      ctx: ACTOR,
    });
    expect(saved.status, JSON.stringify(saved)).toBe('saved');
    if (saved.status !== 'saved') return;
    const checked = await validateDraftEdit(db, {
      input: { action: 'validate', draft_ref: saved.draft_ref },
      ctx: ACTOR,
    });
    if (checked.status !== 'validated') throw new Error(JSON.stringify(checked));
    expect(checked.publishable).toBe(true);
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'rule-typo-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(submitted.status, JSON.stringify(submitted)).toBe('admitted');
    const revisions = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.group_id, qid))
      .orderBy(asc(question_revision.revision_ordinal));
    expect(revisions).toHaveLength(2);
    const next = revisions[1];
    expect(next.structure.parts[0]?.prompt_md).toContain('分子式');
    expect(next.response_spec).toEqual(before.response_spec);
    expect(next.scoring_basis).toEqual(before.scoring_basis);
    expect(next.execution_plan).toEqual(before.execution_plan);
    const [afterLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(afterLife.scoring_admission_state).toBe('admitted');
    expect(afterLife.current_revision_id).toBe(next.revision_id);
    const [row] = await db.select().from(question).where(eq(question.id, qid));
    expect(row.prompt_md).toContain('分子式');
  });

  // @invariant grading: converting an old rule_reference unit to a blank key publishes the author's key
  // @fails-if the lossy round trip refuses a blank conversion that validation calls publishable
  it('publishes a blank key converted from an old rule_reference question', async () => {
    const db = testDb();
    const kc = 'kc-rule-blank';
    const qid = 'q-rule-blank';
    await seedKnowledge(kc);
    const { unitId } = await publishAdmittedRuleReference({
      id: qid,
      prompt: '待改成填空：水的化学式是',
      knowledgeIds: [kc],
    });
    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: qid,
        ops: [
          {
            op: 'set',
            target: { kind: 'unit', id: unitId },
            fields: {
              response_class: 'blank',
              response_spec: { kind: 'blank', format: 'text' },
              key: { kind: 'blank', key: { kind: 'text', accepted: ['H2O'] } },
              method: { kind: 'exact' },
              rule: BLANK_RULE,
            },
          },
        ],
        request_id: 'rule-blank-save',
      },
      ctx: ACTOR,
    });
    expect(saved.status, JSON.stringify(saved)).toBe('saved');
    if (saved.status !== 'saved') return;
    const checked = await validateDraftEdit(db, {
      input: { action: 'validate', draft_ref: saved.draft_ref },
      ctx: ACTOR,
    });
    if (checked.status !== 'validated') throw new Error(JSON.stringify(checked));
    expect(checked.publishable).toBe(true);
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'rule-blank-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(submitted.status, JSON.stringify(submitted)).toBe('withheld');
    if (submitted.status !== 'withheld' || 'published' in submitted) {
      throw new Error(JSON.stringify(submitted));
    }
    const [afterLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    const [revision] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, afterLife.current_revision_id ?? ''));
    const unit = revision.scoring_basis.units[0];
    if (unit == null || unit.criterion.kind !== 'blank_key' || unit.criterion.key.kind !== 'text') {
      throw new Error(`blank conversion published ${unit?.criterion.kind ?? 'nothing'}`);
    }
    expect(unit.criterion.key.accepted).toEqual(['H2O']);
    expect(afterLife.scoring_admission_state).toBe('withheld');
  });

  // @invariant grading: accepting a copilot prompt edit of an old rule_reference question publishes that prompt
  // @fails-if accept returns 422 because the stored rule_reference does not round-trip
  it('accepts a copilot prompt edit of an old rule_reference question', async () => {
    const db = testDb();
    const kc = 'kc-rule-accept';
    const qid = 'q-rule-accept';
    await seedKnowledge(kc);
    const { partId } = await publishAdmittedRuleReference({
      id: qid,
      prompt: '待接受：水的化学式是什么',
      knowledgeIds: [kc],
    });
    const [before] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.group_id, qid));
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'agent:copilot',
      payload: {
        kind: 'question_edit',
        target: { subject_kind: 'question', subject_id: qid },
        reason_md: '改一个错字',
        evidence_refs: [{ kind: 'question', id: qid }],
        proposed_change: {
          question_id: qid,
          edit_request: {
            question_id: qid,
            ops: [
              {
                op: 'replace_text',
                target: { kind: 'part', id: partId },
                field: 'prompt_md',
                old: '化学式',
                new: '分子式',
              },
            ],
          },
        },
        rollback_plan: { action: 'dismiss proposal' },
        cooldown_key: `rule-accept:${qid}`,
        suggestion_kind: 'proactive',
      },
    });
    await acceptAiProposal(db, proposalId, { decision: 'accept' });
    const revisions = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.group_id, qid))
      .orderBy(asc(question_revision.revision_ordinal));
    expect(revisions).toHaveLength(2);
    const next = revisions[1];
    expect(next.structure.parts[0]?.prompt_md).toContain('分子式');
    expect(next.response_spec).toEqual(before.response_spec);
    expect(next.scoring_basis).toEqual(before.scoring_basis);
    expect(next.execution_plan).toEqual(before.execution_plan);
  });

  // @invariant grading: correcting the key of a lossy admitted question publishes the new key and keeps capped_sum
  // @fails-if the lossy round trip refuses the key change and leaves 42 as the live accepted answer
  it('publishes a corrected key on a lossy admitted blank question', async () => {
    const db = testDb();
    const kc = 'kc-key-fix';
    const qid = 'q-key-fix';
    await seedKnowledge(kc);
    await publishAdmittedBlank({
      id: qid,
      prompt: '封顶聚合写错了键：答案是',
      knowledgeIds: [kc],
      accepted: ['42'],
      aggregation: { kind: 'capped_sum', cap: 1 },
    });
    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: qid,
        ops: [
          {
            op: 'set',
            target: { kind: 'unit', id: 'u1' },
            fields: { key: { kind: 'blank', key: { kind: 'text', accepted: ['43'] } } },
          },
        ],
        request_id: 'key-fix-save',
      },
      ctx: ACTOR,
    });
    expect(saved.status, JSON.stringify(saved)).toBe('saved');
    if (saved.status !== 'saved') return;
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'key-fix-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(submitted.status, JSON.stringify(submitted)).toBe('withheld');
    if (submitted.status !== 'withheld' || 'published' in submitted) {
      throw new Error(JSON.stringify(submitted));
    }
    const [afterLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(afterLife.scoring_admission_state).toBe('withheld');
    const [revision] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, afterLife.current_revision_id ?? ''));
    const unit = revision.scoring_basis.units[0];
    if (unit == null || unit.criterion.kind !== 'blank_key' || unit.criterion.key.kind !== 'text') {
      throw new Error(`key fix published ${unit?.criterion.kind ?? 'nothing'}`);
    }
    expect(unit.criterion.key.accepted).toEqual(['43']);
    expect(unit.criterion.key.normalization).toEqual(BLANK_NORM);
    expect(revision.scoring_basis.aggregation).toEqual({ kind: 'capped_sum', cap: 1 });
  });

  // @invariant grading: an explicit case_sensitive false overrides an inherited casefold false
  // @fails-if the key edit is admitted as a noop and h2o still scores 0
  it('publishes case_sensitive false over an inherited case-sensitive normalisation', async () => {
    const db = testDb();
    const kc = 'kc-casefold-override';
    const qid = 'q-casefold-override';
    await seedKnowledge(kc);
    await publishAdmittedBlank({
      id: qid,
      prompt: '大小写覆盖：水的化学式是',
      knowledgeIds: [kc],
    });
    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: qid,
        ops: [
          {
            op: 'set',
            target: { kind: 'unit', id: 'u1' },
            fields: {
              key: {
                kind: 'blank',
                key: { kind: 'text', accepted: ['H2O'], case_sensitive: false },
              },
            },
          },
        ],
        request_id: 'casefold-override-save',
      },
      ctx: ACTOR,
    });
    expect(saved.status, JSON.stringify(saved)).toBe('saved');
    if (saved.status !== 'saved') return;
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'casefold-override-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(submitted.status, JSON.stringify(submitted)).toBe('withheld');
    if (submitted.status !== 'withheld' || 'published' in submitted) {
      throw new Error(JSON.stringify(submitted));
    }
    const [afterLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    const [revision] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, afterLife.current_revision_id ?? ''));
    const unit = revision.scoring_basis.units[0];
    if (unit == null || unit.criterion.kind !== 'blank_key' || unit.criterion.key.kind !== 'text') {
      throw new Error(`case override published ${unit?.criterion.kind ?? 'nothing'}`);
    }
    expect(unit.criterion.key.normalization.casefold).toBe(true);
    expect(unit.criterion.key.normalization.nfkc).toBe(true);
    const graded = await gradeBlankExactUnit(unit, {
      slot_id: unit.slot_refs[0] ?? 's1',
      kind: 'blank',
      state: 'answered',
      text: 'h2o',
    });
    expect(graded.status, JSON.stringify(graded)).toBe('scored');
    if (graded.status !== 'scored') return;
    expect(graded.points_awarded, JSON.stringify(graded)).toBe(1);
  });

  // @invariant grading: an explicit trim false overrides an inherited trim_outer true
  // @fails-if the key edit is admitted as a noop and a padded answer still scores 1
  it('publishes trim false over an inherited trimmed normalisation', async () => {
    const db = testDb();
    const kc = 'kc-trim-override';
    const qid = 'q-trim-override';
    await seedKnowledge(kc);
    await publishAdmittedBlank({
      id: qid,
      prompt: '空白覆盖：水的化学式是',
      knowledgeIds: [kc],
    });
    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: qid,
        ops: [
          {
            op: 'set',
            target: { kind: 'unit', id: 'u1' },
            fields: {
              key: { kind: 'blank', key: { kind: 'text', accepted: ['H2O'], trim: false } },
            },
          },
        ],
        request_id: 'trim-override-save',
      },
      ctx: ACTOR,
    });
    expect(saved.status, JSON.stringify(saved)).toBe('saved');
    if (saved.status !== 'saved') return;
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'trim-override-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(submitted.status, JSON.stringify(submitted)).toBe('withheld');
    if (submitted.status !== 'withheld' || 'published' in submitted) {
      throw new Error(JSON.stringify(submitted));
    }
    const [afterLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    const [revision] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, afterLife.current_revision_id ?? ''));
    const unit = revision.scoring_basis.units[0];
    if (unit == null || unit.criterion.kind !== 'blank_key' || unit.criterion.key.kind !== 'text') {
      throw new Error(`trim override published ${unit?.criterion.kind ?? 'nothing'}`);
    }
    expect(unit.criterion.key.normalization.trim_outer).toBe(false);
    expect(unit.criterion.key.normalization.nfkc).toBe(true);
    const padded = await gradeBlankExactUnit(unit, {
      slot_id: unit.slot_refs[0] ?? 's1',
      kind: 'blank',
      state: 'answered',
      text: ' H2O ',
    });
    expect(padded.status, JSON.stringify(padded)).toBe('scored');
    if (padded.status !== 'scored') return;
    expect(padded.points_awarded, JSON.stringify(padded)).toBe(0);
    const bare = await gradeBlankExactUnit(unit, {
      slot_id: unit.slot_refs[0] ?? 's1',
      kind: 'blank',
      state: 'answered',
      text: 'H2O',
    });
    expect(bare.status, JSON.stringify(bare)).toBe('scored');
    if (bare.status !== 'scored') return;
    expect(bare.points_awarded, JSON.stringify(bare)).toBe(1);
  });

  // @invariant grading: editing one blank's key keeps the other unit's slot placement byte-for-byte
  // @fails-if the author path re-encodes the untouched unit and publishes a revision that drops its placement
  it('keeps an untouched blank slot placement when the other unit key changes', async () => {
    const db = testDb();
    const kc = 'kc-untouched-placement';
    const qid = 'q-untouched-placement';
    await seedKnowledge(kc);
    const prompt = '两空改第二空：第一空位置要留下';
    await publishAdmittedTwoBlank({
      id: qid,
      prompt,
      knowledgeIds: [kc],
      firstUnit: 'placement',
    });
    const [beforeLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    const [before] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, beforeLife.current_revision_id ?? ''));
    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: qid,
        ops: [
          {
            op: 'set',
            target: { kind: 'unit', id: 'u2' },
            fields: { key: { kind: 'blank', key: { kind: 'text', accepted: ['8'] } } },
          },
        ],
        request_id: 'untouched-placement-save',
      },
      ctx: ACTOR,
    });
    expect(saved.status, JSON.stringify(saved)).toBe('saved');
    if (saved.status !== 'saved') return;
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'untouched-placement-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(submitted.status, JSON.stringify(submitted)).toBe('withheld');
    if (submitted.status !== 'withheld' || 'published' in submitted) {
      throw new Error(JSON.stringify(submitted));
    }
    const [afterLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    const [after] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, afterLife.current_revision_id ?? ''));
    const beforeSlot = before.response_spec.slots.find((slot) => slot.slot_id === 's1');
    const afterSlot = after.response_spec.slots.find((slot) => slot.slot_id === 's1');
    const beforeUnit = before.scoring_basis.units.find((unit) => unit.scoring_unit_id === 'u1');
    const afterUnit = after.scoring_basis.units.find((unit) => unit.scoring_unit_id === 'u1');
    expect(afterSlot).toEqual(beforeSlot);
    expect(afterUnit).toEqual(beforeUnit);
    expect(beforeSlot?.placement).toEqual({ row: 0, col: 1, label: '(1)' });
    const changed = after.scoring_basis.units.find((unit) => unit.scoring_unit_id === 'u2');
    if (
      changed == null ||
      changed.criterion.kind !== 'blank_key' ||
      changed.criterion.key.kind !== 'text'
    ) {
      throw new Error(`u2 published ${changed?.criterion.kind ?? 'nothing'}`);
    }
    expect(changed.criterion.key.accepted).toEqual(['8']);
  });

  // @invariant grading: editing one blank's key keeps an unknown normalisation field on the other unit
  // @fails-if the author path re-encodes the untouched unit and drops strip_units from the published key
  it('keeps an untouched blank strip_units field when the other unit key changes', async () => {
    const db = testDb();
    const kc = 'kc-untouched-strip';
    const qid = 'q-untouched-strip';
    await seedKnowledge(kc);
    const prompt = '两空改第二空：第一空单位剥离要留下';
    await publishAdmittedTwoBlank({
      id: qid,
      prompt,
      knowledgeIds: [kc],
      firstUnit: 'strip_units',
    });
    const [beforeLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    const [before] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, beforeLife.current_revision_id ?? ''));
    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: qid,
        ops: [
          {
            op: 'set',
            target: { kind: 'unit', id: 'u2' },
            fields: { key: { kind: 'blank', key: { kind: 'text', accepted: ['8'] } } },
          },
        ],
        request_id: 'untouched-strip-save',
      },
      ctx: ACTOR,
    });
    expect(saved.status, JSON.stringify(saved)).toBe('saved');
    if (saved.status !== 'saved') return;
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'untouched-strip-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    expect(submitted.status, JSON.stringify(submitted)).toBe('withheld');
    if (submitted.status !== 'withheld' || 'published' in submitted) {
      throw new Error(JSON.stringify(submitted));
    }
    const [afterLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    const [after] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, afterLife.current_revision_id ?? ''));
    const beforeUnit = before.scoring_basis.units.find((unit) => unit.scoring_unit_id === 'u1');
    const afterUnit = after.scoring_basis.units.find((unit) => unit.scoring_unit_id === 'u1');
    const beforeSlot = before.response_spec.slots.find((slot) => slot.slot_id === 's1');
    const afterSlot = after.response_spec.slots.find((slot) => slot.slot_id === 's1');
    expect(afterUnit).toEqual(beforeUnit);
    expect(afterSlot).toEqual(beforeSlot);
    const storedNorm =
      beforeUnit?.criterion.kind === 'blank_key' && beforeUnit.criterion.key.kind === 'text'
        ? beforeUnit.criterion.key.normalization
        : null;
    expect(storedNorm).toMatchObject({ strip_units: true });
    const changed = after.scoring_basis.units.find((unit) => unit.scoring_unit_id === 'u2');
    if (
      changed == null ||
      changed.criterion.kind !== 'blank_key' ||
      changed.criterion.key.kind !== 'text'
    ) {
      throw new Error(`u2 published ${changed?.criterion.kind ?? 'nothing'}`);
    }
    expect(changed.criterion.key.accepted).toEqual(['8']);
  });
});

async function expectPromptEditLeavesCurrent(input: {
  qid: string;
  partId: string;
  old: string;
  saveRequest: string;
  submitRequest: string;
}): Promise<void> {
  const db = testDb();
  const [beforeLife] = await db
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, input.qid));
  const beforeRevisionId = beforeLife.current_revision_id;
  const [beforeRevision] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, beforeRevisionId ?? ''));
  const saved = await saveDraftEdit(db, {
    input: {
      action: 'save',
      question_id: input.qid,
      ops: [
        {
          op: 'replace_text',
          target: { kind: 'part', id: input.partId },
          field: 'prompt_md',
          old: input.old,
          new: '已改',
        },
      ],
      request_id: input.saveRequest,
    },
    ctx: ACTOR,
  });
  expect(saved.status, JSON.stringify(saved)).toBe('saved');
  if (saved.status !== 'saved') return;
  const checked = await validateDraftEdit(db, {
    input: { action: 'validate', draft_ref: saved.draft_ref },
    ctx: ACTOR,
  });
  if (checked.status !== 'invalid') throw new Error(JSON.stringify(checked));
  expect(checked.publishable).toBe(false);
  expect(checked.issues.map((issue) => issue.code)).toContain('scoring_round_trip_lossy');
  const submitted = await submitDraftQuestion(
    db,
    {
      draft_ref: saved.draft_ref,
      expected_draft_version: saved.draft_version,
      request_id: input.submitRequest,
    },
    { ...ACTOR, sessionId: null },
  );
  expect(submitted.status, JSON.stringify(submitted)).toBe('withheld');
  if (submitted.status !== 'withheld' || !('published' in submitted)) {
    throw new Error(JSON.stringify(submitted));
  }
  expect(submitted.published).toBe(false);
  expect(submitted.issues.map((issue) => issue.code)).toContain('scoring_round_trip_lossy');
  const revisions = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.group_id, input.qid));
  expect(revisions.map((revision) => revision.revision_id)).toEqual([beforeRevision.revision_id]);
  const [afterLife] = await db
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, input.qid));
  expect(afterLife.current_revision_id).toBe(beforeRevisionId);
  expect(afterLife.scoring_admission_state).toBe('admitted');
}

function optionIdentity(revision: {
  response_spec: { slots: ReadonlyArray<{ kind: string }> };
  scoring_basis: { units: ReadonlyArray<{ criterion: { kind: string } }> };
}): { ids: string[]; texts: string[]; accepted: string[] } {
  const slot = revision.response_spec.slots[0] as {
    kind: string;
    options?: { option_id: string; text: string }[];
    items?: { item_id: string; label_md?: string }[];
  };
  const criterion = revision.scoring_basis.units[0]?.criterion as {
    kind: string;
    accepted_option_ids?: string[];
    accepted_item_ids?: string[];
  };
  if (slot.kind === 'single_choice' || slot.kind === 'multi_choice') {
    return {
      ids: (slot.options ?? []).map((option) => option.option_id),
      texts: (slot.options ?? []).map((option) => option.text),
      accepted: criterion.accepted_option_ids ?? [],
    };
  }
  if (slot.kind === 'select') {
    return {
      ids: (slot.items ?? []).map((item) => item.item_id),
      texts: (slot.items ?? []).map((item) => item.label_md ?? ''),
      accepted: criterion.accepted_item_ids ?? [],
    };
  }
  throw new Error(`slot kind ${slot.kind} dropped the choice options`);
}
