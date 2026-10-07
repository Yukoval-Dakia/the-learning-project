// U5 (YUK-203, §4.10 Q8-addendum) — GET /api/papers/[id] route DB tests.
//
// Covers:
//   1. Full render payload: paper meta + sections + question faces + null slot state
//      when no session started yet.
//   2. Draft restoration: a live autosaved draft appears in slot_state.draft.
//   3. Visible submission: correct answer → slot_state.submission with outcome,
//      answer_md (user's own answer echoed back), and reference_md.
//   4. Hidden feedback: judge_now_show_later + in-progress session → feedback_buffered,
//      answer_md present; score/outcome/reference_md NOT in response (§4.9 gate).
//   5. Revealed on complete: same slot after session.status='completed' → full
//      outcome + reference_md visible.
//   6. Flat fallback: a quiz with no sections degrades to single synthetic section.
//   7. 404 for unknown artifact id.
//   8. section knowledge_focus_names resolved from DB; unknown id falls back to id.
//   9. Face has no reference_md field (reference is gated, not pre-answer-visible).

import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@/core/ids';
import {
  artifact,
  evaluation,
  evaluation_effective_head,
  event,
  knowledge,
  learning_session,
  question,
  question_revision,
} from '@/db/schema';
import {
  contractIntegrityDigest,
  normalizeQuestionRowToContract,
} from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';
import {
  correctPaperFixture,
  paperFixtureAssessment,
  startFrozenPaperFixture,
  submitPaperFixture as submitPaperSlot,
} from '../../../../tests/fixtures/assessment-paper';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { readPaperAssessmentBinding } from '../server/assessment/paper-issuance';
import { getIssuanceState } from '../server/assessment/submit';
import {
  activateSubmissionCandidate,
  evaluateSubmission,
} from '../server/judge/evaluate-submission';
import { createAnswerDraft } from './paper-answer-route';
import { PaperDetailResponseSchema, PaperListResponseSchema } from './paper-contracts';
import { GET } from './paper-detail-route';
import { GET as listPapers } from './papers-list';

async function seedQuestion(id: string, reference: string, kind = 'true_false') {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind,
    judge_kind_override: 'exact',
    prompt_md: `Prompt for ${id}`,
    reference_md: reference,
    knowledge_ids: ['k1'],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    version: 0,
    created_at: now,
    updated_at: now,
  });
}

async function seedPaper(
  id: string,
  opts: {
    intentSource?: string;
    questionIds: string[];
    feedbackPolicy?: string;
    sectioned?: boolean;
  },
) {
  const db = testDb();
  const now = new Date();
  const {
    intentSource = 'review_plan',
    questionIds,
    feedbackPolicy = 'immediate',
    sectioned = true,
  } = opts;

  const toolState = sectioned
    ? {
        question_ids: questionIds,
        sections: [
          {
            knowledge_focus: ['k1'],
            feedback_policy: feedbackPolicy,
            adaptation_policy: 'none',
            assignments: questionIds.map((qid) => ({
              question_id: qid,
              primary_knowledge_id: 'k1',
              secondary_knowledge_ids: [],
              selection_reason: 'test',
              review_profile_snapshot: {},
            })),
          },
        ],
      }
    : {
        // Flat quiz — no sections (U4 / quiz_gen fallback)
        question_ids: questionIds,
      };

  await db.insert(artifact).values({
    id,
    type: 'tool_quiz',
    title: `卷 ${id}`,
    knowledge_ids: ['k1'],
    intent_source: intentSource,
    source: 'ai_generated',
    tool_kind: intentSource,
    tool_state: toolState as never,
    generation_status: 'ready',
    verification_status: 'not_required',
    history: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedKnowledge(id: string, name: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({ id, name, created_at: now, updated_at: now });
}

function makeRequest(artifactId: string): [Request, Record<string, string>] {
  return [new Request(`http://localhost/api/practice/${artifactId}`), { id: artifactId }];
}

async function publishWithoutSolutionMaterials(questionId: string) {
  const db = testDb();
  const [row] = await db.select().from(question).where(eq(question.id, questionId));
  const contract = normalizeQuestionRowToContract(row);
  const solutions = new Set(
    contract.structure.materials
      .filter((material) => /^sol_/.test(material.asset.asset_id))
      .map((material) => material.material_id),
  );
  expect(solutions.size).toBeGreaterThan(0);
  contract.structure.materials = contract.structure.materials.filter(
    (material) => !solutions.has(material.material_id),
  );
  for (const part of contract.structure.parts)
    part.material_ids = part.material_ids.filter((id) => !solutions.has(id));
  contract.integrity_digest = contractIntegrityDigest(contract);
  const published = await publishQuestionGroup(db, {
    group_id: questionId,
    contract,
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    actorRef: 'test:paper-basis-without-solution',
    now: new Date(),
    admission: {
      state: 'admitted',
      evidence: {
        marking_provenance: 'official',
        verification: { structural_check_passed: true, independent_verification: null },
        model_slice: null,
      },
    },
  });
  expect(published.status).toBe('published');
}

describe('GET /api/practice/[id]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns full render payload with question faces and null session when no session started', async () => {
    await seedQuestion('q1', 'true');
    await seedQuestion('q2', 'false');
    await seedPaper('p1', { questionIds: ['q1', 'q2'] });

    const [req, ctx] = makeRequest('p1');
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);

    const body = PaperDetailResponseSchema.parse(await res.json());

    expect(body.artifact_id).toBe('p1');
    expect(body.generation_status).toBe('ready');
    expect(body.intent_source).toBe('review_plan');
    expect(body.session).toBeNull();
    expect(body.is_flat_fallback).toBe(false);
    expect(body.sections).toHaveLength(1);

    const section = body.sections[0];
    expect(section.section_index).toBe(0);
    expect(section.knowledge_focus).toEqual(['k1']);
    expect(section.feedback_policy).toBe('immediate');
    expect(section.slots).toHaveLength(2);

    const slot1 = section.slots.find((s) => s.question_id === 'q1');
    expect(slot1).toBeDefined();
    expect(slot1?.question.kind).toBe('true_false');
    expect(slot1?.question.prompt_md).toBe('Prompt for q1');
    expect(slot1?.slot_state.draft).toBeNull();
    expect(slot1?.slot_state.submission).toBeNull();
  });

  it('restores live draft in slot_state.draft', async () => {
    await seedQuestion('q1', 'true');
    await seedPaper('p1', { questionIds: ['q1'] });
    const db = testDb();
    const { sessionId } = await startFrozenPaperFixture(db, 'p1');

    const saved = await createAnswerDraft(
      new Request('http://localhost/paper-draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          question_id: 'q1',
          content_md: 'my draft answer',
          assessment: await paperFixtureAssessment(db, sessionId, 'q1', 'my draft answer'),
          expected_save_epoch: 0,
        }),
      }),
      { id: 'p1' },
    );
    expect(saved.status).toBe(200);

    const [req, ctx] = makeRequest('p1');
    const res = await GET(req, ctx);
    const body = PaperDetailResponseSchema.parse(await res.json());

    const slot = body.sections[0]?.slots.find((s) => s.question_id === 'q1');
    expect(slot?.assessment?.response_set.entries).toMatchObject([
      { kind: 'text', text_md: 'my draft answer' },
    ]);
    expect(slot?.assessment?.save_epoch).toBe(1);
    expect(slot?.slot_state.submission).toBeNull();
  });

  it('returns visible outcome + answer_md + reference_md after correct submission (feedback_policy=immediate)', async () => {
    await seedQuestion('q1', 'true'); // reference_md = 'true'
    await seedPaper('p1', { questionIds: ['q1'], feedbackPolicy: 'immediate' });
    const db = testDb();
    const { sessionId } = await startFrozenPaperFixture(db, 'p1');

    await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'p1',
        questionId: 'q1',
        answerMd: 'true',
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'immediate',
      },
      db,
    );

    const [req, ctx] = makeRequest('p1');
    const res = await GET(req, ctx);
    const body = PaperDetailResponseSchema.parse(await res.json());

    expect(body.session?.pos).toBe(1);
    expect(body.session?.right).toBe(1);
    expect(body.session?.wrong).toBe(0);

    const slot = body.sections[0]?.slots.find((s) => s.question_id === 'q1');
    expect(slot?.slot_state.draft).toBeNull(); // draft cleared after freeze
    const sub = slot?.slot_state.submission;
    expect(sub?.submitted).toBe(true);
    expect(sub?.visible_to_user).toBe(true);
    if (!sub || !sub.visible_to_user) throw new Error('expected visible submission state');
    // fix #2: outcome is coarse_outcome from judge payload ('correct'), not
    // the judge event's own outcome field ('success').
    expect(sub?.outcome).toBe('correct');
    expect(sub?.answer_md).toBe('true'); // user's own answer echoed back
    expect(sub?.reference_md).toBe('true'); // from question.reference_md
  });

  it('hides feedback (feedback_buffered:true) for judge_now_show_later — answer_md present, score/outcome/reference_md absent', async () => {
    await seedQuestion('q1', 'true');
    await seedPaper('p1', { questionIds: ['q1'], feedbackPolicy: 'judge_now_show_later' });
    const db = testDb();
    const { sessionId } = await startFrozenPaperFixture(db, 'p1');

    await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'p1',
        questionId: 'q1',
        answerMd: 'my buffered answer',
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'judge_now_show_later',
      },
      db,
    );

    const [req, ctx] = makeRequest('p1');
    const res = await GET(req, ctx);
    const body = PaperDetailResponseSchema.parse(await res.json());

    const slot = body.sections[0]?.slots.find((s) => s.question_id === 'q1');
    const sub = slot?.slot_state.submission;
    expect(sub?.submitted).toBe(true);
    expect(sub?.visible_to_user).toBe(false);
    if (!sub || sub.visible_to_user) throw new Error('expected buffered submission state');
    expect(sub?.feedback_buffered).toBe(true);
    // User's own answer is always echoed back (safe even in buffered variant).
    expect(sub?.answer_md).toBe('my buffered answer');
    expect(Array.isArray(sub?.answer_image_refs)).toBe(true);
    // Server visibility gate: outcome, score, reference_md must NOT be present when buffered.
    expect('outcome' in (sub ?? {})).toBe(false);
    expect('score' in (sub ?? {})).toBe(false);
    expect('reference_md' in (sub ?? {})).toBe(false);
  });

  it('reveals full feedback (+ answer_md + reference_md) after session completed (judge_now_show_later → completed reveals)', async () => {
    await seedQuestion('q1', 'true'); // reference_md = 'true'
    await seedPaper('p1', { questionIds: ['q1'], feedbackPolicy: 'judge_now_show_later' });
    const db = testDb();
    const { sessionId } = await startFrozenPaperFixture(db, 'p1');

    // Submit the correct answer so coarse_outcome='correct' after reveal.
    await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'p1',
        questionId: 'q1',
        answerMd: 'true', // matches reference_md='true' → correct
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'judge_now_show_later',
      },
      db,
    );

    // Force session to 'completed' (directly, no helper needed — the visibility
    // gate only reads session.status, not how it got there).
    await db
      .update(learning_session)
      .set({ status: 'completed' })
      // biome-ignore lint/suspicious/noExplicitAny: dynamic import for test helper
      .where((sql as any)`id = ${sessionId}`);

    const [req, ctx] = makeRequest('p1');
    const res = await GET(req, ctx);
    const body = PaperDetailResponseSchema.parse(await res.json());

    const slot = body.sections[0]?.slots.find((s) => s.question_id === 'q1');
    const sub = slot?.slot_state.submission;
    // Completed session reveals buffered feedback.
    expect(sub?.submitted).toBe(true);
    expect(sub?.visible_to_user).toBe(true);
    if (!sub || !sub.visible_to_user) throw new Error('expected revealed submission state');
    // fix #2: coarse_outcome from judge payload ('correct') not event.outcome ('success').
    expect(sub?.outcome).toBe('correct');
    expect('feedback_buffered' in (sub ?? {})).toBe(false);
    // answer_md + reference_md now visible.
    expect(sub?.answer_md).toBe('true'); // user's own answer echoed back
    expect(sub?.reference_md).toBe('true'); // from question.reference_md
  });

  it('flat fallback: quiz with no sections degrades to single synthetic section', async () => {
    await seedQuestion('q1', 'true');
    await seedQuestion('q2', 'false');
    await seedPaper('p_flat', { questionIds: ['q1', 'q2'], sectioned: false });

    const [req, ctx] = makeRequest('p_flat');
    const res = await GET(req, ctx);
    const body = (await res.json()) as {
      is_flat_fallback: boolean;
      sections: Array<{
        section_index: number;
        slots: Array<{ question_id: string }>;
      }>;
    };

    expect(body.is_flat_fallback).toBe(true);
    expect(body.sections).toHaveLength(1);
    expect(body.sections[0].section_index).toBe(0);
    expect(body.sections[0].slots).toHaveLength(2);
    const qIds = body.sections[0].slots.map((s) => s.question_id);
    expect(qIds).toContain('q1');
    expect(qIds).toContain('q2');
  });

  it('section knowledge_focus_names resolved from DB; unknown id falls back to id', async () => {
    await seedQuestion('q1', 'true');
    // k_named: node exists. k_unknown: no row → name falls back to id.
    await seedKnowledge('k_named', '文言文基础');
    const db = testDb();
    const now = new Date();
    await db.insert(artifact).values({
      id: 'p_named',
      type: 'tool_quiz',
      title: '知识名测试卷',
      knowledge_ids: ['k_named'],
      intent_source: 'review_plan',
      source: 'ai_generated',
      tool_kind: 'review_plan',
      tool_state: {
        question_ids: ['q1'],
        sections: [
          {
            knowledge_focus: ['k_named', 'k_unknown'],
            feedback_policy: 'immediate',
            adaptation_policy: 'none',
            assignments: [
              {
                question_id: 'q1',
                primary_knowledge_id: 'k_named',
                secondary_knowledge_ids: [],
                selection_reason: 'test',
                review_profile_snapshot: {},
              },
            ],
          },
        ],
      } as never,
      generation_status: 'ready',
      verification_status: 'not_required',
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });

    const [req, ctx] = makeRequest('p_named');
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sections: Array<{
        knowledge_focus: string[];
        knowledge_focus_names: string[];
      }>;
    };

    const sec = body.sections[0];
    expect(sec.knowledge_focus).toEqual(['k_named', 'k_unknown']);
    // Resolved: k_named → '文言文基础', k_unknown → 'k_unknown' (fallback)
    expect(sec.knowledge_focus_names).toEqual(['文言文基础', 'k_unknown']);
  });

  it('question face has no reference_md field (reference is gated — not pre-answer-visible)', async () => {
    // reference_md must NOT appear in the question face returned for an unsubmitted
    // slot. The face is shown before the user answers, so leaking the reference
    // answer would defeat the exercise.
    await seedQuestion('q1', 'secret reference answer');
    await seedPaper('p_face', { questionIds: ['q1'] });

    const [req, ctx] = makeRequest('p_face');
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sections: Array<{
        slots: Array<{
          question: Record<string, unknown>;
          slot_state: { submission: null };
        }>;
      }>;
    };

    const slot = body.sections[0]?.slots[0];
    // Face must have prompt_md but must NOT expose reference_md.
    expect(slot?.question.prompt_md).toBe('Prompt for q1');
    expect('reference_md' in (slot?.question ?? {})).toBe(false);
    // Unsubmitted slot: submission is null.
    expect(slot?.slot_state.submission).toBeNull();
  });

  it('returns 404 for unknown artifact id', async () => {
    const [req, ctx] = makeRequest('does_not_exist');
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
  });

  it('round-4 fix #2: rejudge event supersedes original verdict in detail session summary', async () => {
    // Submit correct (right=1), then insert a superseding judge event with
    // coarse_outcome='incorrect'. Detail summary must flip to right=0 wrong=1.
    await seedQuestion('q1', 'true');
    await seedPaper('p_rj', { questionIds: ['q1'], feedbackPolicy: 'immediate' });
    const db = testDb();
    const { sessionId } = await startFrozenPaperFixture(db, 'p_rj');

    const sub = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'p_rj',
        questionId: 'q1',
        answerMd: 'true',
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'immediate',
      },
      db,
    );
    expect(sub.coarseOutcome).toBe('correct');

    // Sanity: before rejudge, detail shows right=1.
    const [req0, ctx0] = makeRequest('p_rj');
    const before = (await (await GET(req0, ctx0)).json()) as {
      session: { right: number; wrong: number } | null;
    };
    expect(before.session?.right).toBe(1);
    expect(before.session?.wrong).toBe(0);

    await correctPaperFixture(db, sub.attemptEventId, 0);

    // After rejudge: detail summary must use newest judge event → wrong=1.
    const [req1, ctx1] = makeRequest('p_rj');
    const after = (await (await GET(req1, ctx1)).json()) as {
      session: { right: number; wrong: number } | null;
    };
    expect(after.session?.right).toBe(0);
    expect(after.session?.wrong).toBe(1);
  });
});

describe('frozen paper feedback disclosure, YUK-1047 late P1s', () => {
  beforeEach(resetDb);

  it.each([
    { policy: 'immediate', outcome: 'correct', answer: 'true', right: 1, wrong: 0 },
    { policy: 'immediate', outcome: 'incorrect', answer: 'false', right: 0, wrong: 1 },
    { policy: 'immediate', outcome: 'partial', answer: 'false', right: 1, wrong: 0 },
    { policy: 'judge_now_show_later', outcome: 'correct', answer: 'true', right: 1, wrong: 0 },
    { policy: 'judge_now_show_later', outcome: 'incorrect', answer: 'false', right: 0, wrong: 1 },
    { policy: 'judge_now_show_later', outcome: 'partial', answer: 'false', right: 1, wrong: 0 },
  ])(
    '$policy $outcome survives pause, completion and hot edits without disclosing buffered grades',
    async ({ policy, outcome, answer, right, wrong }) => {
      const db = testDb();
      await seedQuestion('q_frozen', 'true');
      const frozenPrompt =
        '实验组与对照组使用相同体积的水、同种容器和同一计时方式。\n' +
        '表格记录三次重复实验；实验组只改变坡度，对照组保持原坡度。\n' +
        '判断：比较水流速度时，坡度是自变量。不要把重复次数当作自变量。';
      await db.update(question).set({ prompt_md: frozenPrompt }).where(eq(question.id, 'q_frozen'));
      await publishWithoutSolutionMaterials('q_frozen');
      await seedPaper('p_frozen', { questionIds: ['q_frozen'], feedbackPolicy: policy });
      const { sessionId } = await startFrozenPaperFixture(db, 'p_frozen');
      const binding = await readPaperAssessmentBinding(db, sessionId);
      if (!binding) throw new Error('expected real frozen paper opening');
      const state = await getIssuanceState(db, binding.slots[0].issuance_id);
      if (!state.issuance) throw new Error('expected frozen issuance');
      const [revision] = await db
        .select()
        .from(question_revision)
        .where(eq(question_revision.revision_id, state.issuance.binding.revision_id));
      expect(
        revision.structure.materials.some((material) => /^sol_/.test(material.asset.asset_id)),
      ).toBe(false);
      expect(revision.scoring_basis.units[0].criterion).toMatchObject({
        kind: 'text_key',
        accepted_texts: ['true'],
      });

      const submitted = await submitPaperSlot(
        {
          sessionId,
          paperArtifactId: 'p_frozen',
          questionId: 'q_frozen',
          answerMd: answer,
          primaryKnowledgeId: 'k1',
          feedbackPolicy: policy,
        },
        db,
      );
      if (outcome === 'partial') await correctPaperFixture(db, submitted.attemptEventId, 0.5);
      if (policy === 'judge_now_show_later') {
        // Capture policy is optional; the immutable opening receipt must enforce disclosure itself.
        const [capture] = await db
          .select()
          .from(event)
          .where(eq(event.id, submitted.attemptEventId));
        const { paper_feedback_policy: _optionalPolicy, ...payload } = capture.payload;
        await db.update(event).set({ payload }).where(eq(event.id, capture.id));
      }

      // Neither mutable question content nor the current paper plan controls disclosure.
      await db
        .update(question)
        .set({ prompt_md: 'HOT PROMPT', reference_md: 'HOT ANSWER' })
        .where(eq(question.id, 'q_frozen'));
      await seedPaper('p_hot_plan', {
        questionIds: ['q_frozen'],
        feedbackPolicy: policy === 'immediate' ? 'judge_now_show_later' : 'immediate',
      });
      const [hotPlan] = await db.select().from(artifact).where(eq(artifact.id, 'p_hot_plan'));
      await db
        .update(artifact)
        .set({ tool_state: hotPlan.tool_state })
        .where(eq(artifact.id, 'p_frozen'));

      for (const status of ['started', 'paused', 'completed']) {
        await db.update(learning_session).set({ status }).where(eq(learning_session.id, sessionId));
        const detailResponse = await GET(...makeRequest('p_frozen'));
        expect(detailResponse.status).toBe(200);
        const detail = PaperDetailResponseSchema.parse(await detailResponse.json());
        const list = PaperListResponseSchema.parse(await (await listPapers()).json());
        const listed = list.papers.find((item) => item.artifact_id === 'p_frozen');
        const visible = policy === 'immediate' || status === 'completed';
        const expected = { pos: 1, right: visible ? right : 0, wrong: visible ? wrong : 0 };
        expect.soft(detail.session, `detail ${status}`).toMatchObject(expected);
        expect.soft(listed?.session, `list ${status}`).toMatchObject(expected);
        const slot = detail.sections[0].slots[0];
        expect.soft(slot.question.prompt_md).toBe(frozenPrompt);
        expect.soft(detail.sections[0].feedback_policy).toBe(policy);
        const submission = slot.slot_state.submission;
        expect
          .soft(submission)
          .toMatchObject({ submitted: true, answer_md: answer, visible_to_user: visible });
        if (visible) {
          expect.soft(submission).toMatchObject({ outcome, reference_md: 'true' });
        } else {
          expect.soft(submission).toMatchObject({ feedback_buffered: true });
          for (const field of ['outcome', 'score', 'feedback_md', 'reference_md']) {
            expect.soft(submission).not.toHaveProperty(field);
          }
        }
        expect.soft(JSON.stringify(detail)).not.toMatch(/HOT PROMPT|HOT ANSWER/);
      }
      const restored = PaperDetailResponseSchema.parse(
        await (await GET(...makeRequest('p_frozen'))).json(),
      );
      expect.soft(restored.session).toMatchObject({ status: 'completed', pos: 1, right, wrong });
      expect
        .soft(restored.sections[0].slots[0].slot_state.submission)
        .toMatchObject({ outcome, reference_md: 'true' });
    },
  );

  it.each(['correct', 'incorrect'] as const)(
    'mixed policy counts only the immediate %s slot before completion',
    async (immediateOutcome) => {
      const db = testDb();
      await seedQuestion('q_buffered', 'true');
      await seedQuestion('q_immediate', 'false');
      await seedPaper('p_mixed', {
        questionIds: ['q_buffered'],
        feedbackPolicy: 'judge_now_show_later',
      });
      await seedPaper('p_immediate_plan', {
        questionIds: ['q_immediate'],
        feedbackPolicy: 'immediate',
      });
      const [bufferedPaper] = await db.select().from(artifact).where(eq(artifact.id, 'p_mixed'));
      const [immediatePaper] = await db
        .select()
        .from(artifact)
        .where(eq(artifact.id, 'p_immediate_plan'));
      await db
        .update(artifact)
        .set({
          tool_state: {
            question_ids: ['q_buffered', 'q_immediate'],
            sections: [
              ...(bufferedPaper.tool_state?.sections ?? []),
              ...(immediatePaper.tool_state?.sections ?? []),
            ],
          },
        })
        .where(eq(artifact.id, 'p_mixed'));
      const { sessionId } = await startFrozenPaperFixture(db, 'p_mixed');
      const buffered = await submitPaperSlot(
        {
          sessionId,
          paperArtifactId: 'p_mixed',
          questionId: 'q_buffered',
          answerMd: 'false',
          primaryKnowledgeId: 'k1',
          feedbackPolicy: 'judge_now_show_later',
        },
        db,
      );
      await correctPaperFixture(db, buffered.attemptEventId, 0.5);
      const [capture] = await db.select().from(event).where(eq(event.id, buffered.attemptEventId));
      const { paper_feedback_policy: _optionalPolicy, ...payload } = capture.payload;
      await db.update(event).set({ payload }).where(eq(event.id, capture.id));
      await submitPaperSlot(
        {
          sessionId,
          paperArtifactId: 'p_mixed',
          questionId: 'q_immediate',
          answerMd: immediateOutcome === 'correct' ? 'false' : 'true',
          primaryKnowledgeId: 'k1',
          feedbackPolicy: 'immediate',
        },
        db,
      );
      for (const status of ['started', 'paused', 'completed']) {
        await db.update(learning_session).set({ status }).where(eq(learning_session.id, sessionId));
        const detail = PaperDetailResponseSchema.parse(
          await (await GET(...makeRequest('p_mixed'))).json(),
        );
        const list = PaperListResponseSchema.parse(await (await listPapers()).json());
        const expected = {
          pos: 2,
          right: Number(immediateOutcome === 'correct') + Number(status === 'completed'),
          wrong: Number(immediateOutcome === 'incorrect'),
        };
        expect.soft(detail.session, `mixed detail ${status}`).toMatchObject(expected);
        expect
          .soft(
            list.papers.find((item) => item.artifact_id === 'p_mixed')?.session,
            `mixed list ${status}`,
          )
          .toMatchObject(expected);
        expect.soft(detail.sections[1].slots[0].slot_state.submission).toMatchObject({
          visible_to_user: true,
          outcome: immediateOutcome,
          reference_md: 'false',
        });
        if (status !== 'completed')
          expect
            .soft(detail.sections[0].slots[0].slot_state.submission)
            .not.toHaveProperty('outcome');
        else
          expect
            .soft(detail.sections[0].slots[0].slot_state.submission)
            .toMatchObject({ visible_to_user: true, outcome: 'partial', reference_md: 'true' });
      }
    },
  );

  it.each(['missing', 'unresolved'] as const)(
    'a completed submission with %s adjudication preserves progress without counting a wrong answer',
    async (adjudication) => {
      const db = testDb();
      await seedQuestion('q_pending', 'true');
      await seedPaper('p_pending', {
        questionIds: ['q_pending'],
        feedbackPolicy: 'judge_now_show_later',
      });
      const { sessionId } = await startFrozenPaperFixture(db, 'p_pending');
      const submitted = await submitPaperSlot(
        {
          sessionId,
          paperArtifactId: 'p_pending',
          questionId: 'q_pending',
          answerMd: 'false',
          primaryKnowledgeId: 'k1',
          feedbackPolicy: 'judge_now_show_later',
        },
        db,
      );
      const [anchor] = await db.select().from(event).where(eq(event.id, submitted.attemptEventId));
      const groupId = anchor.payload.evaluation_group_id;
      if (typeof groupId !== 'string') throw new Error('native capture missing group');
      const [head] = await db
        .select()
        .from(evaluation_effective_head)
        .where(eq(evaluation_effective_head.evaluation_group_id, groupId));
      if (adjudication === 'missing') {
        // Model the valid no-effective-head read state without rewriting the original capture.
        await db
          .update(evaluation_effective_head)
          .set({ effective_evaluation_id: null })
          .where(eq(evaluation_effective_head.evaluation_group_id, groupId));
      } else {
        if (!head.effective_evaluation_id) throw new Error('expected original active grade');
        const [original] = await db
          .select()
          .from(evaluation)
          .where(eq(evaluation.evaluation_id, head.effective_evaluation_id));
        const candidate = await evaluateSubmission(db, {
          submission_id: original.submission_id,
          evaluation_group_id: groupId,
          evaluation_key: 'paper-terminal-unresolved',
          mode: 'manual_assert',
          provenance: { source: 'manual', assisted: false },
          asserted_unit_results: original.unit_results.map((unit) => ({
            scoring_unit_id: unit.scoring_unit_id,
            status: 'pending',
            pending: {
              reason: 'unjudgeable',
              detail: '判据无法支持确定裁决；保留原始作答，等待有证据的复核。',
            },
          })),
        });
        expect(
          await activateSubmissionCandidate(
            db,
            {
              evaluation_id: candidate.record.evaluation_id,
              expected_effective_id: head.effective_evaluation_id,
              expected_generation: head.generation,
            },
            { actorRef: 'test:paper-unresolved' },
          ),
        ).toMatchObject({ status: 'activated' });
      }
      await db
        .update(learning_session)
        .set({ status: 'completed' })
        .where(eq(learning_session.id, sessionId));
      const detail = PaperDetailResponseSchema.parse(
        await (await GET(...makeRequest('p_pending'))).json(),
      );
      const list = PaperListResponseSchema.parse(await (await listPapers()).json());
      expect.soft(detail.session).toMatchObject({ pos: 1, right: 0, wrong: 0 });
      expect
        .soft(list.papers.find((item) => item.artifact_id === 'p_pending')?.session)
        .toMatchObject({ pos: 1, right: 0, wrong: 0 });
      expect.soft(detail.sections[0].slots[0].slot_state.submission).toMatchObject({
        visible_to_user: true,
        outcome: 'unsupported',
        score: null,
        reference_md: 'true',
      });
    },
  );
});
