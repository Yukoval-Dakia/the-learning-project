// YUK-1468 — edit/submit 边界上的数据与判分不变量。
// 入口是 saveDraftEdit / submitDraftQuestion / acceptAiProposal / poolFetch /
// issueAssessment，不单测内部 helper。

import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { poolFetch } from '@/capabilities/practice/server/quiz/pool-fetch';
import { defaultPresentation } from '@/core/schema/assessment/presentation';
import type { AdmissionEvidenceT } from '@/core/schema/assessment/publish';
import { QuestionDraftDocument, type QuestionDraftDocumentT } from '@/core/schema/question-draft';
import {
  knowledge,
  question,
  question_block,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { issueAssessment } from '@/kernel/records/assessment-issuance';
import { acceptAiProposal } from '@/server/proposals/actions';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { contractIntegrityDigest, normalizeQuestionRowToContract } from './contract-normalizer';
import { draftDocumentToContract } from './draft-contract';
import { saveDraftEdit } from './edit-question';
import { publishQuestionGroup } from './publisher';
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
              units: [],
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

  // @invariant grading: a content edit of an admitted question stays issuable, including the previous revision, and the practice pool still returns it
  // @fails-if submit always publishes withheld admission, or the admitted legacy row is left unchanged while issuance rejects the group
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
    expect(submitted.status).toBe('admitted');

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
    expect(current.status).toBe('issued');
    expect(pinned.status).toBe('issued');
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
    expect(first.status).not.toBe('conflict');
    expect('question_id' in first).toBe(true);
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
    expect(second.status).toBe('conflict');
    if (second.status !== 'conflict') return;
    expect(second.reason).toBe('duplicate_exact');
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
    expect(first.status).not.toBe('conflict');
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
    expect(second.status).toBe('conflict');
    if (second.status !== 'conflict') return;
    expect(second.reason).toBe('near_dup');
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
    expect(submitted.status).not.toBe('conflict');
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
});

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
