// U5 (YUK-203, §4.10 Q8-addendum) — GET /api/practice/[id] server logic.
//
// Discovered plan gap (UI lane integration): the four practice endpoints
// returned zero question-face content, making the answering page impossible to
// render. Orchestrator ruling: L-paper-core addendum (additive only, zero
// contract change to the four existing endpoints).
//
// One round-trip per concern — no N+1 per-slot question fetch (Q8 principle):
//   1. Paper artifact (parse via Artifact.safeParse for tool_state shape)
//   2. Linked review session (newest per paper, via artifact_id)
//   3. Question rows for all slot question_ids (one IN query)
//   4. Live draft + frozen answer rows for the session (one query)
//   5. Judge event outcomes for the frozen rows (one query via answer.event_id)
//
// Visibility gate (§4.9): judge feedback is SERVER-gated. When a judge event
// was written with visible_to_user:false AND the session is not yet 'completed',
// the slot response carries { submitted: true, feedback_buffered: true } — the
// score/outcome/feedback_md are NOT sent to the client.

import { readPaperSections } from '@/capabilities/practice/server/paper-sections';
import {
  isJudgementVisibleToUser,
  resolveKnowledgeNames,
} from '@/capabilities/practice/server/practice-read';
import { Artifact } from '@/core/schema/index';
import type { Db } from '@/db/client';
import { answer, artifact, event, learning_session, question } from '@/db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

// ────────────────────────────────────────────────────────────────────────────
// Response types (contract for L-practice-ui)
// ────────────────────────────────────────────────────────────────────────────

/** Rendering-safe question face — fields the answering page needs to render. */
export interface PaperQuestionFace {
  id: string;
  kind: string;
  prompt_md: string;
  /** Multiple-choice options (null for open-ended questions) */
  choices_md: string[] | null;
  /** Difficulty 1-5 */
  difficulty: number;
  /** For composite questions: the parent question_id; null for root/atomic */
  parent_question_id: string | null;
  /** The part index within the parent, for ordering (null for atomic) */
  part_index: number | null;
  image_refs: string[];
}

/** Per-slot state: the current answer draft (if any) and submitted status. */
export interface PaperSlotState {
  /** null = no draft started yet */
  draft: {
    content_md: string;
    input_kind: string;
    image_refs: string[];
  } | null;
  /**
   * null = not yet submitted. When submitted:
   *   - visible feedback: { submitted, visible_to_user: true, outcome, score, answer_md,
   *       answer_image_refs, reference_md } — outcome/score/reference_md all gated by
   *       visibility (visible_to_user !== false || session completed).
   *   - buffered feedback: { submitted, visible_to_user: false, feedback_buffered: true,
   *       answer_md, answer_image_refs } — user's own answer is always safe to echo back;
   *       reference_md/outcome/score are NOT included (server visibility gate §4.9).
   */
  submission:
    | null
    | {
        submitted: true;
        visible_to_user: true;
        outcome: string;
        score: number | null;
        /** The user's frozen answer text (echoed back unconditionally). */
        answer_md: string;
        /** Image refs attached to the frozen answer row. */
        answer_image_refs: string[];
        /**
         * Reference answer from question.reference_md. Null when the question
         * has no reference_md, or when the row is missing. Only present in the
         * visible variant (same gate as outcome/score).
         */
        reference_md: string | null;
      }
    | {
        submitted: true;
        visible_to_user: false;
        feedback_buffered: true;
        /** The user's frozen answer text (always safe to echo back). */
        answer_md: string;
        /** Image refs attached to the frozen answer row. */
        answer_image_refs: string[];
        // reference_md / outcome / score are structurally absent (§4.9 discipline).
      };
}

export interface PaperDetailSlot {
  /** The slot's question_id */
  question_id: string;
  /** StructuredQuestion part id; null for atomic questions */
  part_ref: string | null;
  /** 0-based index of the owning section */
  section_index: number;
  /** knowledge nodes this section focuses on (drives UI section header) */
  knowledge_focus: string[];
  /** The question face for rendering */
  question: PaperQuestionFace;
  /** Current answer state for the slot */
  slot_state: PaperSlotState;
}

export interface PaperDetailSection {
  section_index: number;
  knowledge_focus: string[];
  /**
   * Human-readable names parallel to knowledge_focus[]. Index-aligned:
   * knowledge_focus_names[i] is the name for knowledge_focus[i].
   * Falls back to the id itself when the node is missing or archived.
   */
  knowledge_focus_names: string[];
  feedback_policy: string;
  slots: PaperDetailSlot[];
}

export interface PaperDetailResult {
  artifact_id: string;
  title: string;
  generation_status: string;
  intent_source: string;
  /** The linked review session, if one has been started */
  session: {
    id: string;
    status: string;
    pos: number;
    right: number;
    wrong: number;
  } | null;
  /** Ordered sections with their slots + question faces + slot state */
  sections: PaperDetailSection[];
  /**
   * Flat fallback for U4 quizzes with no structured plan (sections will be a
   * single synthetic section with all question_ids; UI may render flat).
   */
  is_flat_fallback: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Main aggregation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate the full answering-page payload for one paper artifact.
 * Returns null when the artifact is not found.
 *
 * Visibility contract (§4.9):
 *   visible = payload.visible_to_user !== false || session.status === 'completed'
 * When visible=false the response carries { feedback_buffered: true } and OMITS
 * score/outcome — the server holds the visibility boundary even for single-user
 * installs (principle over convenience).
 */
export async function getPaperDetail(
  db: Db,
  paperArtifactId: string,
): Promise<PaperDetailResult | null> {
  // 1) Paper artifact.
  const artifactRows = await db
    .select()
    .from(artifact)
    .where(eq(artifact.id, paperArtifactId))
    .limit(1);
  const artifactRow = artifactRows[0];
  if (!artifactRow) return null;

  const parsed = Artifact.safeParse(artifactRow);
  const toolState = parsed.success ? parsed.data.tool_state : null;

  // 2) Resolve sections (U5 top-level or U4 session_meta fallback, §4.8 shim).
  const sections = readPaperSections(toolState);
  const isFlatFallback = sections.length === 0;

  // Build the ordered slot list from sections (or flat question_ids fallback).
  type RawSlot = {
    question_id: string;
    part_ref: string | null;
    section_index: number;
    knowledge_focus: string[];
    feedback_policy: string;
  };
  const rawSlots: RawSlot[] = [];

  if (!isFlatFallback) {
    for (let si = 0; si < sections.length; si++) {
      const sec = sections[si];
      for (const a of sec.assignments) {
        rawSlots.push({
          question_id: a.question_id,
          part_ref: a.part_ref ?? null,
          section_index: si,
          knowledge_focus: sec.knowledge_focus,
          feedback_policy: sec.feedback_policy,
        });
      }
    }
  } else {
    // Flat fallback: synthesize a single section from question_ids.
    const qIds = toolState?.question_ids ?? [];
    for (const qid of qIds) {
      rawSlots.push({
        question_id: qid,
        part_ref: null,
        section_index: 0,
        knowledge_focus: [],
        feedback_policy: 'immediate',
      });
    }
  }

  // 3) Linked review session (newest for this paper).
  let sessionInfo: { id: string; status: string } | null = null;
  const sessionRows = await db
    .select({
      id: learning_session.id,
      status: learning_session.status,
    })
    .from(learning_session)
    .where(
      and(eq(learning_session.type, 'review'), eq(learning_session.artifact_id, paperArtifactId)),
    )
    .orderBy(desc(learning_session.created_at))
    .limit(1);
  if (sessionRows[0]) {
    sessionInfo = { id: sessionRows[0].id, status: sessionRows[0].status };
  }

  // 4) Question faces — one IN query for all distinct question_ids.
  //    reference_md is fetched here but kept out of PaperQuestionFace (face is
  //    pre-answer-visible; reference_md must only appear in the visible submission
  //    variant). Stored in a parallel referenceMap for the assembly step.
  const questionIds = [...new Set(rawSlots.map((s) => s.question_id))];
  const questionMap = new Map<string, PaperQuestionFace>();
  const referenceMap = new Map<string, string | null>(); // question_id → reference_md
  if (questionIds.length > 0) {
    const qRows = await db
      .select({
        id: question.id,
        kind: question.kind,
        prompt_md: question.prompt_md,
        choices_md: question.choices_md,
        difficulty: question.difficulty,
        parent_question_id: question.parent_question_id,
        part_index: question.part_index,
        image_refs: question.image_refs,
        reference_md: question.reference_md,
      })
      .from(question)
      .where(inArray(question.id, questionIds));
    for (const q of qRows) {
      referenceMap.set(q.id, q.reference_md ?? null);
      questionMap.set(q.id, {
        id: q.id,
        kind: q.kind,
        prompt_md: q.prompt_md,
        choices_md: q.choices_md ?? null,
        difficulty: q.difficulty,
        parent_question_id: q.parent_question_id ?? null,
        part_index: q.part_index ?? null,
        image_refs: q.image_refs ?? [],
      });
    }
  }

  // 5) Knowledge name resolution for section headers — one IN query across all
  //    knowledge_focus ids referenced by any section. archived_at not filtered
  //    (historical papers must still display names). Falls back to id on miss.
  const allFocusIds = [...new Set(rawSlots.flatMap((s) => s.knowledge_focus))];
  const knowledgeNameMap = await resolveKnowledgeNames(db, allFocusIds);

  // 6 & 7) Answer rows + judge outcomes — only meaningful if a session exists.
  //
  // Live draft: the single row WHERE submitted_at IS NULL for a slot.
  // Newest frozen: MAX(submitted_at) per slot — the submission to show feedback for.
  // Judge outcome: JOIN event via answer.event_id for the newest frozen row.
  //
  // Both queries are scoped to the session — no cross-session leakage.

  type DraftRow = {
    question_id: string;
    part_ref: string | null;
    content_md: string;
    input_kind: string;
    image_refs: string[];
  };
  type SubmittedRow = {
    question_id: string;
    part_ref: string | null;
    event_id: string | null;
    submitted_at: Date;
    content_md: string;
    image_refs: string[];
    // F1 (PR #309 round-4, YUK-215) — 'true' when the frozen attempt was the
    // un-judged photo-only-on-text-route case (no judge event written). Drives the
    // visible outcome='unsupported' surface in slot assembly. NULL for every normal
    // graded attempt.
    unsupported_judge: string | null;
  };
  type JudgeRow = {
    event_id: string;
    outcome: string;
    payload: unknown;
  };

  const draftMap = new Map<string, DraftRow>(); // slotKey → draft
  const submittedMap = new Map<string, SubmittedRow>(); // slotKey → newest frozen
  const judgeMap = new Map<string, JudgeRow>(); // event_id → judge event

  if (sessionInfo) {
    const sid = sessionInfo.id;

    // Live drafts (submitted_at IS NULL).
    const draftRows = await db
      .select({
        question_id: answer.question_id,
        part_ref: answer.part_ref,
        content_md: answer.content_md,
        input_kind: answer.input_kind,
        image_refs: answer.image_refs,
      })
      .from(answer)
      .where(and(eq(answer.session_id, sid), sql`${answer.submitted_at} IS NULL`));
    for (const d of draftRows) {
      const key = `${d.question_id}::${d.part_ref ?? ''}`;
      draftMap.set(key, {
        question_id: d.question_id,
        part_ref: d.part_ref ?? null,
        content_md: d.content_md,
        input_kind: d.input_kind,
        image_refs: (d.image_refs as string[]) ?? [],
      });
    }

    // Newest frozen row per slot: subquery on MAX(submitted_at).
    // content_md + image_refs: user's own answer, echoed back unconditionally.
    const frozenRows = await db.execute<{
      question_id: string;
      part_ref: string | null;
      event_id: string | null;
      submitted_at: Date;
      content_md: string;
      image_refs: string[];
      unsupported_judge: string | null;
    }>(sql`
      SELECT
        answer.question_id,
        answer.part_ref,
        answer.event_id,
        answer.submitted_at,
        answer.content_md,
        answer.image_refs,
        -- F1 (PR #309 round-4): the attempt event's un-judged marker, so slot
        -- assembly can surface outcome='unsupported' without an extra round-trip.
        att.payload->>'unsupported_judge' AS unsupported_judge
      FROM answer
      LEFT JOIN event att ON att.id = answer.event_id
      WHERE answer.session_id = ${sid}
        AND answer.submitted_at IS NOT NULL
        AND answer.submitted_at = (
          SELECT MAX(a2.submitted_at)
          FROM answer a2
          WHERE a2.session_id = ${sid}
            AND a2.question_id = answer.question_id
            AND COALESCE(a2.part_ref, '') = COALESCE(answer.part_ref, '')
            AND a2.submitted_at IS NOT NULL
        )
    `);
    const frozenArr = frozenRows as unknown as Array<SubmittedRow>;
    const eventIds: string[] = [];
    for (const f of frozenArr) {
      const key = `${f.question_id}::${f.part_ref ?? ''}`;
      submittedMap.set(key, f);
      if (f.event_id) eventIds.push(f.event_id);
    }

    // Judge events for the frozen attempt events (one IN query).
    if (eventIds.length > 0) {
      const judgeRows = await db
        .select({
          subject_id: event.subject_id,
          outcome: event.outcome,
          payload: event.payload,
        })
        .from(event)
        .where(
          and(
            eq(event.action, 'judge'),
            eq(event.subject_kind, 'event'),
            inArray(event.subject_id, eventIds),
          ),
        )
        // newest judge first (D6: rejudge = new event; take newest per attempt)
        .orderBy(desc(event.created_at));

      const seenSubject = new Set<string>();
      for (const j of judgeRows) {
        if (!j.subject_id || seenSubject.has(j.subject_id)) continue;
        seenSubject.add(j.subject_id);
        judgeMap.set(j.subject_id, {
          event_id: j.subject_id,
          outcome: j.outcome ?? 'unknown',
          payload: j.payload,
        });
      }
    }

    // pos / right / wrong (same SQL as getPracticeList for consistency).
    // pos = COUNT(DISTINCT slot) WHERE submitted.
    const posRows = await db.execute<{ pos: number }>(sql`
      SELECT COUNT(DISTINCT (question_id, COALESCE(part_ref, '')))::int AS pos
      FROM answer
      WHERE session_id = ${sid} AND submitted_at IS NOT NULL
    `);
    const pos = (posRows as unknown as Array<{ pos: number }>)[0]?.pos ?? 0;

    // Round-4 fix #2 + Round-6 fix #2 (CR 3359820526): use the newest JUDGE
    // event's coarse_outcome; also fetch visible_to_user so buffered slots are
    // excluded from the summary when the session is not yet 'completed'.
    // Slots with visible_to_user:false and session not completed are skipped —
    // the summary must not let the caller infer the buffered verdict.
    const sessionStatus = sessionInfo.status;
    const rwRows = await db.execute<{
      coarse_outcome: string | null;
      judge_visible_to_user: string | null;
      attempt_outcome: string | null;
      unsupported_judge: string | null;
    }>(sql`
      SELECT
        (SELECT j.payload->>'coarse_outcome'
         FROM event j
         WHERE j.action = 'judge'
           AND j.subject_kind = 'event'
           AND j.subject_id = a.event_id
         ORDER BY j.created_at DESC
         LIMIT 1) AS coarse_outcome,
        (SELECT j.payload->>'visible_to_user'
         FROM event j
         WHERE j.action = 'judge'
           AND j.subject_kind = 'event'
           AND j.subject_id = a.event_id
         ORDER BY j.created_at DESC
         LIMIT 1) AS judge_visible_to_user,
        e.outcome AS attempt_outcome,
        e.payload->>'unsupported_judge' AS unsupported_judge
      FROM answer a
      JOIN event e ON e.id = a.event_id
      WHERE a.session_id = ${sid}
        AND a.submitted_at IS NOT NULL
        AND a.submitted_at = (
          SELECT MAX(a2.submitted_at)
          FROM answer a2
          WHERE a2.session_id = ${sid}
            AND a2.question_id = a.question_id
            AND COALESCE(a2.part_ref, '') = COALESCE(a.part_ref, '')
            AND a2.submitted_at IS NOT NULL
        )
    `);
    let right = 0;
    let wrong = 0;
    for (const r of rwRows as unknown as Array<{
      coarse_outcome: string | null;
      judge_visible_to_user: string | null;
      attempt_outcome: string | null;
      unsupported_judge: string | null;
    }>) {
      // F1 (PR #309 round-4, YUK-215): un-judged attempts (photo-only on a
      // text-only route) are "未判分" — neither right nor wrong. Skip so the
      // summary here stays in lock-step with getPracticeList (practice-read.ts).
      if (r.unsupported_judge === 'true') continue;
      // Visibility gate: skip buffered slots when session is not yet completed.
      if (r.judge_visible_to_user === 'false' && sessionStatus !== 'completed') continue;
      const verdict =
        r.coarse_outcome ??
        (r.attempt_outcome === 'success' ? 'correct' : (r.attempt_outcome ?? 'incorrect'));
      if (verdict === 'correct' || verdict === 'partial') {
        right += 1; // partial counts as right (§4.10 Q9 deliberate)
      } else {
        wrong += 1;
      }
    }

    sessionInfo = { id: sessionInfo.id, status: sessionInfo.status };
    // Attach pos/right/wrong by building the full session shape below.
    (sessionInfo as typeof sessionInfo & { pos?: number; right?: number; wrong?: number }).pos =
      pos;
    (sessionInfo as typeof sessionInfo & { pos?: number; right?: number; wrong?: number }).right =
      right;
    (sessionInfo as typeof sessionInfo & { pos?: number; right?: number; wrong?: number }).wrong =
      wrong;
  }

  // 7) Assemble sections + slots.
  const sessionStatus = sessionInfo?.status ?? null;

  // Group raw slots by section_index.
  const sectionSlots = new Map<number, RawSlot[]>();
  for (const slot of rawSlots) {
    const arr = sectionSlots.get(slot.section_index) ?? [];
    arr.push(slot);
    sectionSlots.set(slot.section_index, arr);
  }

  const resultSections: PaperDetailSection[] = [];
  const sectionIndices = [...new Set(rawSlots.map((s) => s.section_index))].sort((a, b) => a - b);

  for (const si of sectionIndices) {
    const slots = sectionSlots.get(si) ?? [];
    const firstSlot = slots[0];
    const detailSlots: PaperDetailSlot[] = [];

    for (const slot of slots) {
      const slotKey = `${slot.question_id}::${slot.part_ref ?? ''}`;
      const qFace = questionMap.get(slot.question_id);

      // Graceful degradation: if the question row is missing (deleted/orphaned),
      // synthesize a minimal face so the rest of the slot renders.
      const questionFace: PaperQuestionFace = qFace ?? {
        id: slot.question_id,
        kind: 'unknown',
        prompt_md: '',
        choices_md: null,
        difficulty: 3,
        parent_question_id: null,
        part_index: null,
        image_refs: [],
      };

      // Draft state.
      const draftRow = draftMap.get(slotKey) ?? null;
      const draft = draftRow
        ? {
            content_md: draftRow.content_md,
            input_kind: draftRow.input_kind,
            image_refs: draftRow.image_refs,
          }
        : null;

      // Submission state with visibility gate (§4.9).
      const frozenRow = submittedMap.get(slotKey) ?? null;
      let submission: PaperSlotState['submission'] = null;
      if (frozenRow) {
        const judgeRow = frozenRow.event_id ? judgeMap.get(frozenRow.event_id) : null;
        const judgePayload = judgeRow?.payload as
          | { visible_to_user?: boolean; coarse_outcome?: string; score?: number }
          | null
          | undefined;
        const visibleToUser = judgePayload?.visible_to_user;
        const visible = isJudgementVisibleToUser({ visibleToUser, sessionStatus });
        // User's own answer is always safe to echo back (both variants).
        const answerMd = frozenRow.content_md;
        const answerImageRefs = (frozenRow.image_refs as string[]) ?? [];
        if (visible) {
          // reference_md lives on the question row — fetched in referenceMap (step 4).
          // Null when question is missing/orphaned or has no reference answer.
          const refMd = referenceMap.get(slot.question_id) ?? null;
          // F1 (PR #309 round-4, YUK-215): an un-judged attempt (photo-only on a
          // text-only route) has NO judge event, so coarse_outcome is absent. It
          // is "未判分" — surface outcome='unsupported' (always visible: this is
          // actionable user feedback, "this question type can't grade a photo",
          // matching paper-submit's visibleToUser=true for the case) rather than
          // the generic 'unknown'. JudgeResultPanel renders 'unsupported' as
          // "无法判分", so the user sees WHY the slot is ungraded.
          // coarse_outcome is written into the judge payload by paper-submit when a
          // judge DID run; fall back to 'unknown' only for pre-fix judge events.
          const unjudged = frozenRow.unsupported_judge === 'true';
          submission = {
            submitted: true,
            visible_to_user: true,
            outcome: unjudged ? 'unsupported' : (judgePayload?.coarse_outcome ?? 'unknown'),
            score: (judgePayload?.score as number | null | undefined) ?? null,
            answer_md: answerMd,
            answer_image_refs: answerImageRefs,
            reference_md: refMd,
          };
        } else {
          submission = {
            submitted: true,
            visible_to_user: false,
            feedback_buffered: true,
            answer_md: answerMd,
            answer_image_refs: answerImageRefs,
          };
        }
      }

      detailSlots.push({
        question_id: slot.question_id,
        part_ref: slot.part_ref,
        section_index: si,
        knowledge_focus: slot.knowledge_focus,
        question: questionFace,
        slot_state: { draft, submission },
      });
    }

    const sectionFocus = firstSlot?.knowledge_focus ?? [];
    resultSections.push({
      section_index: si,
      knowledge_focus: sectionFocus,
      knowledge_focus_names: sectionFocus.map((id) => knowledgeNameMap.get(id) ?? id),
      feedback_policy: firstSlot?.feedback_policy ?? 'immediate',
      slots: detailSlots,
    });
  }

  // Build final session shape (with pos/right/wrong injected above).
  type SessionShape = { id: string; status: string; pos: number; right: number; wrong: number };
  const si = sessionInfo as
    | (typeof sessionInfo & { pos?: number; right?: number; wrong?: number })
    | null;
  const session: SessionShape | null = si
    ? {
        id: si.id,
        status: si.status,
        pos: si.pos ?? 0,
        right: si.right ?? 0,
        wrong: si.wrong ?? 0,
      }
    : null;

  return {
    artifact_id: artifactRow.id,
    title: artifactRow.title,
    generation_status: artifactRow.generation_status,
    intent_source: artifactRow.intent_source,
    session,
    sections: resultSections,
    is_flat_fallback: isFlatFallback,
  };
}
