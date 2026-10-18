// YUK-1468 — admission grades the published revision and admits a passing verdict.
// The boundary is submitDraftQuestion plus question_admission_run on Postgres.
// The provider is fake; it only stands in for the model.

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { QuestionDraftDocument, type QuestionDraftDocumentT } from '@/core/schema/question-draft';
import {
  ai_task_runs,
  knowledge,
  paid_effect,
  question,
  question_admission_verification,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { normalizeQuestionGroupToContract } from '@/kernel/records/assessment-normalization';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
import { saveDraftEdit } from '@/server/questions/edit-question';
import { submitDraftQuestion } from '@/server/questions/submit-question';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { taskInputHash } from '../server/judge/judge-execution-provenance';
import { canonicalQuestionContentHash } from '../server/quiz/content-fingerprint';
import { poolFetch } from '../server/quiz/pool-fetch';
import type { PracticeTaskRunFn } from '../server/task-runtime';
import { runAdmissionForQuestion } from './question_admission_run';

const ACTOR = { actorRef: 'agent:admission-test', actorKind: 'agent' as const };

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

function blankDocument(
  prompt: string,
  knowledgeId: string,
  accepted: string,
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
            response_class: 'blank',
            response_spec: { kind: 'blank', format: 'text' },
            key: {
              kind: 'blank',
              key: { kind: 'text', accepted: [accepted], normalization: BLANK_NORM },
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
    knowledge_ids: [knowledgeId],
    source: { kind: 'generated', ref: sourceRef },
    metadata: {},
  });
}

async function submitBlank(input: {
  prompt: string;
  knowledgeId: string;
  accepted: string;
  requestId: string;
}): Promise<{ questionId: string; revisionId: string; digest: string }> {
  const db = testDb();
  const saved = await saveDraftEdit(db, {
    input: {
      action: 'save',
      document: blankDocument(input.prompt, input.knowledgeId, input.accepted, input.requestId),
      request_id: `${input.requestId}-save`,
    },
    ctx: ACTOR,
  });
  if (saved.status !== 'saved') throw new Error(JSON.stringify(saved));
  const submitted = await submitDraftQuestion(
    db,
    {
      draft_ref: saved.draft_ref,
      expected_draft_version: saved.draft_version,
      request_id: `${input.requestId}-submit`,
    },
    { ...ACTOR, sessionId: null },
  );
  if (
    submitted.status === 'conflict' ||
    !('revision_id' in submitted) ||
    submitted.revision_id == null
  ) {
    throw new Error(JSON.stringify(submitted));
  }
  const [revision] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, submitted.revision_id));
  if (!revision) throw new Error('submit published no revision');
  return {
    questionId: submitted.question_id,
    revisionId: revision.revision_id,
    digest: revision.integrity_digest,
  };
}

const CHOICE_RULE = {
  version: 1 as const,
  cases: [{ when: { wrong: { eq: 0 }, miss: { eq: 0 } }, award: { points: 1 } }],
  otherwise: { points: 0 },
};

type SolvePayload = {
  mode?: string;
  units: { scoring_unit_id: string; kind: string; blank?: { answer_kind?: string } }[];
};

function fakeSolver(
  answerFor: (scoringUnitId: string) => Record<string, unknown>,
  seen: SolvePayload[],
): PracticeTaskRunFn {
  return async (_kind, payload) => {
    const input = payload as SolvePayload;
    seen.push(input);
    const id = `atr_${randomUUID()}`;
    const output =
      input.mode === 'source_crosscheck'
        ? {
            per_unit: input.units.map((unit) => ({
              scoring_unit_id: unit.scoring_unit_id,
              status: 'consistent' as const,
            })),
          }
        : {
            units: input.units.map((unit) => ({
              scoring_unit_id: unit.scoring_unit_id,
              ...answerFor(unit.scoring_unit_id),
            })),
          };
    await testDb()
      .insert(ai_task_runs)
      .values({
        id,
        task_kind: 'QuestionAdmissionSolveTask',
        provider: 'fake',
        model: 'fake-solver',
        input_hash: taskInputHash(payload),
        status: 'success',
        started_at: new Date(),
        finished_at: new Date(),
      });
    return { text: JSON.stringify(output), task_run_id: id, structured_output: output };
  };
}

function numericBlankDocument(
  prompt: string,
  knowledgeId: string,
  value: number,
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
            response_class: 'blank',
            response_spec: { kind: 'blank', format: 'text' },
            key: {
              kind: 'blank',
              key: { kind: 'numeric', value, tolerance: { kind: 'absolute', value: 0 } },
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
    knowledge_ids: [knowledgeId],
    source: { kind: 'generated', ref: sourceRef },
    metadata: {},
  });
}

function stemDocument(
  stem: string,
  knowledgeId: string,
  sourceRef: string,
): QuestionDraftDocumentT {
  const part = (
    partId: string,
    unitId: string,
    slotId: string,
    prompt: string,
    accepted: string,
  ) => ({
    part_id: partId,
    prompt_md: prompt,
    material_ids: ['m-stem'],
    units: [
      {
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
        material_refs: [],
        metadata: {},
      },
    ],
    metadata: {},
  });
  return QuestionDraftDocument.parse({
    schema_version: 2,
    parts: [
      part('p1', 'u1', 's1', '(1) $a+b=$ ____', '5'),
      part('p2', 'u2', 's2', '(2) $ab=$ ____', '6'),
    ],
    materials: [
      {
        material_id: 'm-stem',
        kind: 'plaintext',
        asset: { asset_id: 'txt_stem', digest: 'sha256:stem' },
        caption: 'stem/shared context',
        content_md: stem,
      },
    ],
    knowledge_ids: [knowledgeId],
    source: { kind: 'generated', ref: sourceRef },
    metadata: {},
  });
}

function selectDocument(
  prompt: string,
  knowledgeId: string,
  sourceRef: string,
  pick: 'one' | 'many',
  accepted: string[],
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
            response_class: 'select',
            response_spec: {
              kind: 'select',
              pick,
              items: [
                { item_id: 'opt-a', label_md: '甲' },
                { item_id: 'opt-b', label_md: '乙' },
                { item_id: 'opt-c', label_md: '丙' },
              ],
            },
            key: { kind: 'select', accepted_item_ids: accepted },
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

function multiSelectDocument(prompt: string, knowledgeId: string, sourceRef: string) {
  return selectDocument(prompt, knowledgeId, sourceRef, 'many', ['opt-a', 'opt-c']);
}

function singleSelectDocument(prompt: string, knowledgeId: string, sourceRef: string) {
  return selectDocument(prompt, knowledgeId, sourceRef, 'one', ['opt-b']);
}

async function submitDocument(document: QuestionDraftDocumentT, requestId: string) {
  const db = testDb();
  const saved = await saveDraftEdit(db, {
    input: { action: 'save', document, request_id: `${requestId}-save` },
    ctx: ACTOR,
  });
  if (saved.status !== 'saved') throw new Error(JSON.stringify(saved));
  const submitted = await submitDraftQuestion(
    db,
    {
      draft_ref: saved.draft_ref,
      expected_draft_version: saved.draft_version,
      request_id: `${requestId}-submit`,
    },
    { ...ACTOR, sessionId: null },
  );
  if (
    submitted.status === 'conflict' ||
    !('revision_id' in submitted) ||
    submitted.revision_id == null
  ) {
    throw new Error(JSON.stringify(submitted));
  }
  const [revision] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, submitted.revision_id));
  if (!revision) throw new Error('submit published no revision');
  return {
    questionId: submitted.question_id,
    revisionId: revision.revision_id,
    digest: revision.integrity_digest,
  };
}

async function revisionIds(questionId: string): Promise<string[]> {
  const rows = await testDb()
    .select({ id: question_revision.revision_id })
    .from(question_revision)
    .where(eq(question_revision.group_id, questionId));
  return rows.map((row) => row.id);
}

function solvedBlank(accepted: string, dialect: 'typed' | 'model'): Record<string, unknown> {
  if (dialect === 'typed') {
    return {
      status: 'solved',
      answer: { kind: 'blank_text', accepted: [accepted] },
      equivalent_forms: [],
      typical_wrong: [],
    };
  }
  return {
    status: 'solved',
    answer: { kind: 'text', accepted: [accepted] },
    equivalent_forms: [accepted],
    typical_wrong: [],
  };
}

async function runPinned(
  questionId: string,
  revisionId: string,
  digest: string,
  runTask: PracticeTaskRunFn,
) {
  return runAdmissionForQuestion(
    testDb(),
    {
      question_id: questionId,
      revision_id: revisionId,
      expected_revision_digest: digest,
    },
    { id: randomUUID() },
    { runTask },
  );
}

describe('question admission run', () => {
  beforeEach(resetDb);

  // @invariant grading: admission grades the published revision and spends nothing when that pin does not match
  // @fails-if the job solves a contract rebuilt from the question row, or a mismatched revision digest still calls the provider
  it('grades the published revision and fails closed on a mismatched pin', async () => {
    const db = testDb();
    await seedKnowledge('kc-pin');
    const published = await submitBlank({
      prompt: '计算 2 的 10 次方，结果是多少？',
      knowledgeId: 'kc-pin',
      accepted: '1024',
      requestId: 'pin',
    });
    const [revision] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, published.revisionId));
    const [row] = await db.select().from(question).where(eq(question.id, published.questionId));
    const rebuilt = normalizeQuestionGroupToContract(row, []);
    expect(rebuilt.integrity_digest).not.toBe(published.digest);
    expect(revision.scoring_basis.units[0]?.criterion.kind).toBe('blank_key');
    expect(revision.response_spec.slots[0]?.slot_id).toBe('s1');

    const seen: SolvePayload[] = [];
    const stale = await runAdmissionForQuestion(
      db,
      {
        question_id: published.questionId,
        revision_id: published.revisionId,
        expected_revision_digest: `sha256:${'ab'.repeat(32)}`,
      },
      { id: randomUUID() },
      { runTask: fakeSolver(() => solvedBlank('1024', 'typed'), seen) },
    );
    expect(stale.status).toBe('stale');
    expect(await db.select({ id: ai_task_runs.id }).from(ai_task_runs)).toEqual([]);

    const solved = await runPinned(
      published.questionId,
      published.revisionId,
      published.digest,
      fakeSolver(() => solvedBlank('1024', 'typed'), seen),
    );
    expect(solved.status).toBe('admitted');
    expect(seen[0]?.units[0]).toMatchObject({ scoring_unit_id: 'u1', kind: 'blank' });
    const effects = await db
      .select()
      .from(paid_effect)
      .where(eq(paid_effect.entity_id, published.questionId));
    expect(effects.map((effect) => effect.entity_revision)).toContain(published.digest);
    const verifications = await db
      .select({ evidence: question_admission_verification.evidence })
      .from(question_admission_verification)
      .innerJoin(
        question_revision,
        eq(question_admission_verification.revision_id, question_revision.revision_id),
      )
      .where(eq(question_revision.group_id, published.questionId));
    expect(verifications.map((row) => row.evidence)).toEqual(
      expect.arrayContaining([expect.objectContaining({ base_contract_digest: published.digest })]),
    );
  });

  // @invariant grading: a model dialect that names the published key is admitted, and a different key stays out of the pool
  // @fails-if kind text or a string equivalent form is rejected, or an accepted value other than the published seed is admitted
  it('accepts the model key dialect and withholds a different key', async () => {
    const db = testDb();
    await seedKnowledge('kc-dialect');
    await seedKnowledge('kc-wrong');
    const matching = await submitBlank({
      prompt: '一个四位数，等于 32 的平方。',
      knowledgeId: 'kc-dialect',
      accepted: '1024',
      requestId: 'dialect',
    });
    const admitted = await runPinned(
      matching.questionId,
      matching.revisionId,
      matching.digest,
      fakeSolver(() => solvedBlank('1024', 'model'), []),
    );
    expect(admitted.status).toBe('admitted');
    expect(await poolFetch(db, { knowledgeId: 'kc-dialect' })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: matching.questionId })]),
    );

    const wrong = await submitBlank({
      prompt: '光从太阳到地球大约要多少秒？填一个错误对照。',
      knowledgeId: 'kc-wrong',
      accepted: '1024',
      requestId: 'wrong-key',
    });
    const withheld = await runPinned(
      wrong.questionId,
      wrong.revisionId,
      wrong.digest,
      fakeSolver(() => solvedBlank('999', 'model'), []),
    );
    expect(withheld.status).toBe('withheld');
    const [life] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, wrong.questionId));
    const [row] = await db.select().from(question).where(eq(question.id, wrong.questionId));
    expect(life.scoring_admission_state).toBe('withheld');
    expect(row.draft_status).toBe('draft');
    expect(await poolFetch(db, { knowledgeId: 'kc-wrong' })).toEqual([]);
  });

  // @invariant data: a paid solve whose output cannot be read stays pending and keeps that task run id
  // @fails-if parse failure drops the task run, so the pending reason has an empty task_runs list
  it('keeps the task run id on an unreadable model output', async () => {
    const db = testDb();
    await seedKnowledge('kc-pending');
    const published = await submitBlank({
      prompt: '把这段无法判读的输出留给待定。',
      knowledgeId: 'kc-pending',
      accepted: '1024',
      requestId: 'pending',
    });
    const result = await runPinned(
      published.questionId,
      published.revisionId,
      published.digest,
      fakeSolver(
        () => ({
          status: 'solved',
          answer: { kind: 'text', accepted: 1024 },
          equivalent_forms: [1],
        }),
        [],
      ),
    );
    expect(result.status).toBe('pending');
    const runs = await db.select({ id: ai_task_runs.id }).from(ai_task_runs);
    expect(runs).toHaveLength(1);
    const taskRunId = runs[0]?.id;
    if (taskRunId == null) throw new Error('missing task run');
    const [effect] = await db
      .select()
      .from(paid_effect)
      .where(eq(paid_effect.entity_id, published.questionId));
    expect(effect.state).toBe('unknown');
    expect(effect.unresolved_reason).toContain(`task_run_id=${taskRunId}`);
    expect(effect.unresolved_reason).toContain(`task_runs=${taskRunId}`);
    const [life] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, published.questionId));
    expect(life.scoring_admission_state).toBe('withheld');
  });

  // @invariant data: admitting a withheld edit projects that revision onto the question row and clears draft
  // @fails-if the job admits the lifecycle but leaves the previous prompt and draft_status on the row
  it('projects the admitted revision onto a withheld edit', async () => {
    const db = testDb();
    await seedKnowledge('kc-edit');
    const original = await submitBlank({
      prompt: '计算 2 的 10 次方。',
      knowledgeId: 'kc-edit',
      accepted: '1024',
      requestId: 'edit-base',
    });
    const first = await runPinned(
      original.questionId,
      original.revisionId,
      original.digest,
      fakeSolver(() => solvedBlank('1024', 'typed'), []),
    );
    expect(first.status).toBe('admitted');
    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: original.questionId,
        ops: [
          {
            op: 'replace_text',
            target: { kind: 'part', id: 'p1' },
            field: 'prompt_md',
            old: '10',
            new: '11',
          },
          {
            op: 'set',
            target: { kind: 'unit', id: 'u1' },
            fields: {
              key: {
                kind: 'blank',
                key: { kind: 'text', accepted: ['2048'], normalization: BLANK_NORM },
              },
            },
          },
        ],
        request_id: 'edit-save',
      },
      ctx: ACTOR,
    });
    if (saved.status !== 'saved') throw new Error(JSON.stringify(saved));
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'edit-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    if (
      submitted.status !== 'withheld' ||
      !('revision_id' in submitted) ||
      submitted.revision_id == null
    ) {
      throw new Error(JSON.stringify(submitted));
    }
    const [frozen] = await db.select().from(question).where(eq(question.id, original.questionId));
    expect(frozen.prompt_md).toContain('10');
    expect(frozen.prompt_md).not.toContain('11');
    expect(frozen.reference_md).toBe('1024');
    expect(frozen.draft_status).toBe('draft');
    expect(await poolFetch(db, { knowledgeId: 'kc-edit' })).toEqual([]);

    const [next] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, submitted.revision_id));
    const admitted = await runPinned(
      original.questionId,
      next.revision_id,
      next.integrity_digest,
      fakeSolver(() => solvedBlank('2048', 'typed'), []),
    );
    expect(admitted.status).toBe('admitted');
    const [row] = await db.select().from(question).where(eq(question.id, original.questionId));
    expect(row.prompt_md).toContain('11');
    expect(row.reference_md).toBe('2048');
    expect(row.draft_status).toBe('active');
    expect(row.canonical_content_hash).toBe(
      canonicalQuestionContentHash({
        promptMd: row.prompt_md,
        referenceMd: '2048',
        choicesMd: null,
      }),
    );
    expect(await poolFetch(db, { knowledgeId: 'kc-edit' })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: original.questionId })]),
    );
  });

  // @invariant grading: a new question is admitted only when the verdict passed and its knowledge is still live
  // @fails-if a passing solve leaves the new question withheld, or an archived knowledge node is still admitted
  it('admits a passing new question and holds one whose knowledge died', async () => {
    const db = testDb();
    await seedKnowledge('kc-pass');
    await seedKnowledge('kc-dead');
    const passing = await submitBlank({
      prompt: '8 的立方是多少？',
      knowledgeId: 'kc-pass',
      accepted: '512',
      requestId: 'pass',
    });
    expect(
      (
        await db
          .select()
          .from(question_group_lifecycle)
          .where(eq(question_group_lifecycle.group_id, passing.questionId))
      )[0]?.scoring_admission_state,
    ).toBe('withheld');
    const admitted = await runPinned(
      passing.questionId,
      passing.revisionId,
      passing.digest,
      fakeSolver(() => solvedBlank('512', 'typed'), []),
    );
    expect(admitted.status).toBe('admitted');
    expect(admitted.per_unit.every((unit) => unit.status === 'admitted')).toBe(true);
    const [life] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, passing.questionId));
    const [row] = await db.select().from(question).where(eq(question.id, passing.questionId));
    expect(life.scoring_admission_state).toBe('admitted');
    expect(row.draft_status).toBe('active');
    expect(await poolFetch(db, { knowledgeId: 'kc-pass' })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: passing.questionId })]),
    );

    const dying = await submitBlank({
      prompt: '9 的立方是多少？',
      knowledgeId: 'kc-dead',
      accepted: '729',
      requestId: 'dead',
    });
    await db.update(knowledge).set({ archived_at: new Date() }).where(eq(knowledge.id, 'kc-dead'));
    const held = await runPinned(
      dying.questionId,
      dying.revisionId,
      dying.digest,
      fakeSolver(() => solvedBlank('729', 'typed'), []),
    );
    expect(held.status).toBe('pending');
    const [heldLife] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, dying.questionId));
    const [heldRow] = await db.select().from(question).where(eq(question.id, dying.questionId));
    expect(heldLife.scoring_admission_state).toBe('withheld');
    expect(heldRow.draft_status).toBe('draft');
    expect(await poolFetch(db, { knowledgeId: 'kc-dead' })).toEqual([]);
  });

  // @invariant grading: a numeric blank equal to the textual key is the same answer, and a different number is not
  // @fails-if blank_numeric 1024 against text ["1024"] stays withheld, or expected 999 is admitted
  it('admits the captured numeric blank when it equals the textual key', async () => {
    const db = testDb();
    await seedKnowledge('kc-numeric');
    await seedKnowledge('kc-numeric-wrong');
    await seedKnowledge('kc-text-on-number');
    const seen: SolvePayload[] = [];
    const published = await submitBlank({
      prompt: '计算 2 的 10 次方，结果是多少？',
      knowledgeId: 'kc-numeric',
      accepted: '1024',
      requestId: 'numeric-shape',
    });
    const qaShape = {
      status: 'solved',
      answer: { kind: 'blank_numeric', expected: 1024, tolerance: { kind: 'absolute', value: 0 } },
      equivalent_forms: [],
      typical_wrong: [],
    };
    const admitted = await runPinned(
      published.questionId,
      published.revisionId,
      published.digest,
      fakeSolver(() => qaShape, seen),
    );
    expect(admitted.status).toBe('admitted');
    expect(seen[0]?.units[0]?.blank?.answer_kind).toBe('blank_text');
    expect(admitted.revision_id).toBe(published.revisionId);
    const [row] = await db.select().from(question).where(eq(question.id, published.questionId));
    expect(row.reference_md).toBe('1024');
    const [revision] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, published.revisionId));
    expect(revision.scoring_basis.units[0]?.criterion).toMatchObject({
      kind: 'blank_key',
      key: { kind: 'text', accepted: ['1024'] },
    });

    const wrong = await submitBlank({
      prompt: '一个错误的数值不能代替文本键。',
      knowledgeId: 'kc-numeric-wrong',
      accepted: '1024',
      requestId: 'numeric-wrong',
    });
    const withheld = await runPinned(
      wrong.questionId,
      wrong.revisionId,
      wrong.digest,
      fakeSolver(
        () => ({
          status: 'solved',
          answer: {
            kind: 'blank_numeric',
            expected: 999,
            tolerance: { kind: 'absolute', value: 0 },
          },
          equivalent_forms: [],
          typical_wrong: [],
        }),
        [],
      ),
    );
    expect(withheld.status).toBe('withheld');
    const [wrongRow] = await db.select().from(question).where(eq(question.id, wrong.questionId));
    expect(wrongRow.reference_md).toBe('1024');
    expect(wrongRow.draft_status).toBe('draft');

    const numericSeed = await submitDocument(
      numericBlankDocument('把数值键和文本答案对上。', 'kc-text-on-number', 1024, 'text-on-number'),
      'text-on-number',
    );
    const textAdmitted = await runPinned(
      numericSeed.questionId,
      numericSeed.revisionId,
      numericSeed.digest,
      fakeSolver(() => solvedBlank('1024', 'typed'), []),
    );
    expect(textAdmitted.status).toBe('admitted');
    expect(textAdmitted.revision_id).toBe(numericSeed.revisionId);
    const [numericRow] = await db
      .select()
      .from(question)
      .where(eq(question.id, numericSeed.questionId));
    expect(numericRow.reference_md).toBe('1024');
  });

  // @invariant data: admitting a multi-part question keeps the shared stem in the row identity
  // @fails-if admission replaces the stem prompt with the sub-part prompts and changes the content hash
  it('keeps the shared stem and content hash when a multi-part question is admitted', async () => {
    const db = testDb();
    await seedKnowledge('kc-stem');
    const stem = '已知 $a=2$，$b=3$。\n\n(1) $a+b=$ ____\n\n(2) $ab=$ ____';
    const published = await submitDocument(stemDocument(stem, 'kc-stem', 'stem'), 'stem');
    const [before] = await db.select().from(question).where(eq(question.id, published.questionId));
    expect(before.prompt_md).toBe(stem);
    const admitted = await runPinned(
      published.questionId,
      published.revisionId,
      published.digest,
      fakeSolver((unitId) => solvedBlank(unitId === 'u1' ? '5' : '6', 'typed'), []),
    );
    expect(admitted.status).toBe('admitted');
    const [row] = await db.select().from(question).where(eq(question.id, published.questionId));
    expect(row.prompt_md).toBe(stem);
    expect(row.reference_md).toBe('5\n\n6');
    expect(row.canonical_content_hash).toBe(before.canonical_content_hash);
    expect(row.draft_status).toBe('active');
  });

  // @invariant data: admission does not replace the author's key or mint a revision when the text is unchanged
  // @fails-if a full-width or reordered model answer is written into the stored key or a new revision
  it('keeps the author key verbatim and does not open a revision', async () => {
    const db = testDb();
    await seedKnowledge('kc-author-blank');
    await seedKnowledge('kc-author-select');
    const blank = await submitBlank({
      prompt: '全角数字不能改写作者的键。',
      knowledgeId: 'kc-author-blank',
      accepted: '1024',
      requestId: 'author-blank',
    });
    const blankAdmitted = await runPinned(
      blank.questionId,
      blank.revisionId,
      blank.digest,
      fakeSolver(
        () => ({
          status: 'solved',
          answer: { kind: 'blank_text', accepted: ['１０２４'] },
          equivalent_forms: [],
          typical_wrong: [],
        }),
        [],
      ),
    );
    expect(blankAdmitted.status).toBe('admitted');
    expect(await revisionIds(blank.questionId)).toEqual([blank.revisionId]);
    const [blankRow] = await db.select().from(question).where(eq(question.id, blank.questionId));
    expect(blankRow.reference_md).toBe('1024');

    const select = await submitDocument(
      multiSelectDocument('多选顺序保持作者写法。', 'kc-author-select', 'author-select'),
      'author-select',
    );
    const selectAdmitted = await runPinned(
      select.questionId,
      select.revisionId,
      select.digest,
      fakeSolver(
        () => ({
          status: 'solved',
          answer: { kind: 'select', item_ids: ['opt-c', 'opt-a'] },
          equivalent_forms: [],
          typical_wrong: [],
        }),
        [],
      ),
    );
    expect(selectAdmitted.status).toBe('admitted');
    expect(await revisionIds(select.questionId)).toEqual([select.revisionId]);
    const [selectRow] = await db.select().from(question).where(eq(question.id, select.questionId));
    const [selectRevision] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, select.revisionId));
    expect(selectRow.reference_md).toBe('AC');
    expect(selectRevision.scoring_basis.units[0]?.criterion).toMatchObject({
      kind: 'select_key',
      accepted_item_ids: ['opt-a', 'opt-c'],
    });
  });

  // @invariant data: a stored scoring layer whose digest no longer matches is not graded
  // @fails-if a tampered key is admitted while the sealed digest stays unchanged
  it('fails closed when the stored key no longer matches its digest', async () => {
    const db = testDb();
    await seedKnowledge('kc-tamper');
    const published = await submitBlank({
      prompt: '被改写的存储键不能准入。',
      knowledgeId: 'kc-tamper',
      accepted: '1024',
      requestId: 'tamper',
    });
    await db.execute(
      sql`ALTER TABLE question_revision DISABLE TRIGGER question_revision_immutable`,
    );
    try {
      await db.execute(sql`
        update question_revision
        set scoring_basis = jsonb_set(scoring_basis, '{units,0,criterion,key,accepted,0}', '"999"')
        where revision_id = ${published.revisionId}
      `);
      const result = await runPinned(
        published.questionId,
        published.revisionId,
        published.digest,
        fakeSolver(() => solvedBlank('999', 'typed'), []),
      );
      expect(result.status).toBe('stale');
      expect(await db.select({ id: ai_task_runs.id }).from(ai_task_runs)).toEqual([]);
      const [row] = await db.select().from(question).where(eq(question.id, published.questionId));
      expect(row.draft_status).toBe('draft');
    } finally {
      await db.execute(
        sql`ALTER TABLE question_revision ENABLE TRIGGER question_revision_immutable`,
      );
    }
  });

  // @invariant grading: disagreeing item_ids and accepted_item_ids are not a select key
  // @fails-if item_ids is trusted and the question is admitted while accepted_item_ids names another item
  it('rejects a select answer whose item id fields disagree', async () => {
    const db = testDb();
    await seedKnowledge('kc-conflict');
    const published = await submitDocument(
      singleSelectDocument('冲突的选项字段不能准入。', 'kc-conflict', 'conflict'),
      'conflict',
    );
    const result = await runPinned(
      published.questionId,
      published.revisionId,
      published.digest,
      fakeSolver(
        () => ({
          status: 'solved',
          answer: { kind: 'select', item_ids: ['opt-a'], accepted_item_ids: ['opt-b'] },
          equivalent_forms: [],
          typical_wrong: [],
        }),
        [],
      ),
    );
    expect(result.status).toBe('pending');
    const [life] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, published.questionId));
    const [row] = await db.select().from(question).where(eq(question.id, published.questionId));
    expect(life.scoring_admission_state).toBe('withheld');
    expect(row.draft_status).toBe('draft');
    expect(await poolFetch(db, { knowledgeId: 'kc-conflict' })).toEqual([]);
  });

  // @invariant grading: the author key accepts a model answer only when this question's grader does
  // @fails-if text key "1024.0" is admitted for final answer 1024, which gradeBlankExactUnit scores 0
  it('withholds a non-canonical text key the grader would score as wrong', async () => {
    const db = testDb();
    await seedKnowledge('kc-noncanonical');
    const published = await submitBlank({
      prompt: '计算 2 的 10 次方，结果是多少？',
      knowledgeId: 'kc-noncanonical',
      accepted: '1024.0',
      requestId: 'noncanonical',
    });
    const result = await runPinned(
      published.questionId,
      published.revisionId,
      published.digest,
      fakeSolver(
        () => ({
          status: 'solved',
          answer: {
            kind: 'blank_numeric',
            expected: 1024,
            tolerance: { kind: 'absolute', value: 0 },
          },
          equivalent_forms: [],
          typical_wrong: [],
        }),
        [],
      ),
    );
    expect(result.status).toBe('withheld');
    const [row] = await db.select().from(question).where(eq(question.id, published.questionId));
    expect(row.reference_md).toBe('1024.0');
    expect(row.draft_status).toBe('draft');
  });

  // @invariant grading: a solver-claimed alternative is not a form the author key must accept
  // @fails-if equivalent form "5.0" withholds text key "5" when the grader accepts the final answer
  it('admits the final answer without requiring the solver equivalent form', async () => {
    const db = testDb();
    await seedKnowledge('kc-equiv');
    const published = await submitBlank({
      prompt: 'x 等于多少？',
      knowledgeId: 'kc-equiv',
      accepted: '5',
      requestId: 'equiv',
    });
    const result = await runPinned(
      published.questionId,
      published.revisionId,
      published.digest,
      fakeSolver(
        () => ({
          status: 'solved',
          answer: { kind: 'blank_text', accepted: ['5'] },
          equivalent_forms: [{ text: '5.0' }],
          typical_wrong: [],
        }),
        [],
      ),
    );
    expect(result.status).toBe('admitted');
    expect(result.revision_id).toBe(published.revisionId);
    const [row] = await db.select().from(question).where(eq(question.id, published.questionId));
    expect(row.reference_md).toBe('5');
    expect(row.draft_status).toBe('active');
  });

  // @invariant data: resubmitting an edited legacy revision admits that revision
  // @fails-if a rule_reference question edited to blank key H2O is stale and never calls the model
  it('admits a legacy question after its key is edited and resubmitted', async () => {
    const db = testDb();
    const knowledgeId = 'kc-legacy-edit';
    const questionId = 'q-legacy-edit';
    await seedKnowledge(knowledgeId);
    const now = new Date();
    await db.insert(question).values({
      id: questionId,
      kind: 'short_answer',
      prompt_md: '水的化学式是',
      reference_md: '水的化学式是 H2O。\n\n解析：每个水分子有两个氢。',
      choices_md: null,
      knowledge_ids: [knowledgeId],
      difficulty: 3,
      source: 'manual',
      variant_depth: 0,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    const first = await publishQuestionGroupFromRow(db, {
      rootId: questionId,
      admission: {
        state: 'admitted',
        evidence: {
          marking_provenance: 'official',
          verification: { structural_check_passed: true, independent_verification: null },
          model_slice: null,
        },
      },
      availability: 'general_pool',
      actorRef: 'test:admission',
      now,
    });
    if (first.status !== 'published') throw new Error(JSON.stringify(first));
    const [legacy] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, first.revision_id));
    const legacyUnit = legacy.scoring_basis.units[0];
    if (legacyUnit?.criterion.kind !== 'rule_reference') {
      throw new Error(`legacy criterion is ${legacyUnit?.criterion.kind ?? 'missing'}`);
    }
    const saved = await saveDraftEdit(db, {
      input: {
        action: 'save',
        question_id: questionId,
        ops: [
          {
            op: 'set',
            target: { kind: 'unit', id: legacyUnit.scoring_unit_id },
            fields: {
              response_class: 'blank',
              response_spec: { kind: 'blank', format: 'text' },
              key: { kind: 'blank', key: { kind: 'text', accepted: ['H2O'] } },
              method: { kind: 'exact' },
              rule: BLANK_RULE,
            },
          },
        ],
        request_id: 'legacy-edit-save',
      },
      ctx: ACTOR,
    });
    if (saved.status !== 'saved') throw new Error(JSON.stringify(saved));
    const submitted = await submitDraftQuestion(
      db,
      {
        draft_ref: saved.draft_ref,
        expected_draft_version: saved.draft_version,
        request_id: 'legacy-edit-submit',
      },
      { ...ACTOR, sessionId: null },
    );
    if (
      submitted.status === 'conflict' ||
      !('revision_id' in submitted) ||
      submitted.revision_id == null
    ) {
      throw new Error(JSON.stringify(submitted));
    }
    expect(submitted.status).toBe('withheld');
    const [edited] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, submitted.revision_id));
    const admitted = await runPinned(
      questionId,
      edited.revision_id,
      edited.integrity_digest,
      fakeSolver(() => solvedBlank('H2O', 'typed'), []),
    );
    expect(admitted.status).toBe('admitted');
    expect(await db.select({ id: ai_task_runs.id }).from(ai_task_runs)).not.toEqual([]);
    expect(await revisionIds(questionId)).toHaveLength(2);
    const [row] = await db.select().from(question).where(eq(question.id, questionId));
    expect(row.reference_md).toBe('H2O');
    expect(row.draft_status).toBe('active');
  });
});
