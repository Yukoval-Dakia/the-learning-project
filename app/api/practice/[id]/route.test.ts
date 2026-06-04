// U5 (YUK-203, §4.10 Q8-addendum) — GET /api/practice/[id] route DB tests.
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

import { artifact, event, knowledge, learning_session, question } from '@/db/schema';
import { autosaveAnswerDraft } from '@/server/review/answer-draft';
import { submitPaperSlot } from '@/server/review/paper-submit';
import { Review } from '@/server/session';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './route';

async function seedQuestion(id: string, reference: string, kind = 'true_false') {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind,
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

function makeRequest(artifactId: string): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`http://localhost/api/practice/${artifactId}`),
    { params: Promise.resolve({ id: artifactId }) },
  ];
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

    const body = (await res.json()) as {
      artifact_id: string;
      title: string;
      generation_status: string;
      intent_source: string;
      session: null;
      sections: Array<{
        section_index: number;
        knowledge_focus: string[];
        feedback_policy: string;
        slots: Array<{
          question_id: string;
          part_ref: null;
          section_index: number;
          question: { id: string; kind: string; prompt_md: string };
          slot_state: { draft: null; submission: null };
        }>;
      }>;
      is_flat_fallback: boolean;
    };

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
    const { sessionId } = await Review.startReviewSession(db, { artifactId: 'p1' });

    await autosaveAnswerDraft(db, {
      sessionId,
      questionId: 'q1',
      inputKind: 'text',
      contentMd: 'my draft answer',
      paperArtifactId: 'p1',
    });

    const [req, ctx] = makeRequest('p1');
    const res = await GET(req, ctx);
    const body = (await res.json()) as {
      sections: Array<{
        slots: Array<{
          question_id: string;
          slot_state: {
            draft: { content_md: string; input_kind: string } | null;
            submission: null;
          };
        }>;
      }>;
    };

    const slot = body.sections[0]?.slots.find((s) => s.question_id === 'q1');
    expect(slot?.slot_state.draft?.content_md).toBe('my draft answer');
    expect(slot?.slot_state.draft?.input_kind).toBe('text');
    expect(slot?.slot_state.submission).toBeNull();
  });

  it('returns visible outcome + answer_md + reference_md after correct submission (feedback_policy=immediate)', async () => {
    await seedQuestion('q1', 'true'); // reference_md = 'true'
    await seedPaper('p1', { questionIds: ['q1'], feedbackPolicy: 'immediate' });
    const db = testDb();
    const { sessionId } = await Review.startReviewSession(db, { artifactId: 'p1' });

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
    const body = (await res.json()) as {
      session: { id: string; status: string; pos: number; right: number; wrong: number } | null;
      sections: Array<{
        slots: Array<{
          question_id: string;
          slot_state: {
            draft: null;
            submission:
              | null
              | {
                  submitted: true;
                  visible_to_user: true;
                  outcome: string;
                  score: number | null;
                  answer_md: string;
                  answer_image_refs: string[];
                  reference_md: string | null;
                }
              | {
                  submitted: true;
                  visible_to_user: false;
                  feedback_buffered: true;
                  answer_md: string;
                  answer_image_refs: string[];
                };
          };
        }>;
      }>;
    };

    expect(body.session?.pos).toBe(1);
    expect(body.session?.right).toBe(1);
    expect(body.session?.wrong).toBe(0);

    const slot = body.sections[0]?.slots.find((s) => s.question_id === 'q1');
    expect(slot?.slot_state.draft).toBeNull(); // draft cleared after freeze
    const sub = slot?.slot_state.submission as {
      submitted: true;
      visible_to_user: true;
      outcome: string;
      answer_md: string;
      reference_md: string | null;
    } | null;
    expect(sub?.submitted).toBe(true);
    expect(sub?.visible_to_user).toBe(true);
    expect(sub?.outcome).toBe('success'); // correct → success
    expect(sub?.answer_md).toBe('true'); // user's own answer echoed back
    expect(sub?.reference_md).toBe('true'); // from question.reference_md
  });

  it('hides feedback (feedback_buffered:true) for judge_now_show_later — answer_md present, score/outcome/reference_md absent', async () => {
    await seedQuestion('q1', 'true');
    await seedPaper('p1', { questionIds: ['q1'], feedbackPolicy: 'judge_now_show_later' });
    const db = testDb();
    const { sessionId } = await Review.startReviewSession(db, { artifactId: 'p1' });

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
    const body = (await res.json()) as {
      sections: Array<{
        slots: Array<{
          question_id: string;
          slot_state: {
            submission: {
              submitted?: boolean;
              visible_to_user?: boolean;
              feedback_buffered?: boolean;
              answer_md?: string;
              answer_image_refs?: string[];
              outcome?: string;
              score?: number | null;
              reference_md?: string | null;
            } | null;
          };
        }>;
      }>;
    };

    const slot = body.sections[0]?.slots.find((s) => s.question_id === 'q1');
    const sub = slot?.slot_state.submission;
    expect(sub?.submitted).toBe(true);
    expect(sub?.visible_to_user).toBe(false);
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
    const { sessionId } = await Review.startReviewSession(db, { artifactId: 'p1' });

    await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'p1',
        questionId: 'q1',
        answerMd: 'my revealed answer',
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
    const body = (await res.json()) as {
      sections: Array<{
        slots: Array<{
          question_id: string;
          slot_state: {
            submission: {
              submitted?: boolean;
              visible_to_user?: boolean;
              outcome?: string;
              answer_md?: string;
              answer_image_refs?: string[];
              reference_md?: string | null;
              feedback_buffered?: boolean;
            } | null;
          };
        }>;
      }>;
    };

    const slot = body.sections[0]?.slots.find((s) => s.question_id === 'q1');
    const sub = slot?.slot_state.submission;
    // Completed session reveals buffered feedback.
    expect(sub?.submitted).toBe(true);
    expect(sub?.visible_to_user).toBe(true);
    expect(sub?.outcome).toBe('success');
    expect('feedback_buffered' in (sub ?? {})).toBe(false);
    // answer_md + reference_md now visible.
    expect(sub?.answer_md).toBe('my revealed answer');
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
});
