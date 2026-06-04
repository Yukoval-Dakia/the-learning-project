// U5 (YUK-203, §4.9 + §4.10) — practice read layer.
//
// Two concerns:
//   1. Derived judgement visibility (§4.9): 可见 = visible_to_user !== false ||
//      session completed. NEVER mutated, no reveal event — visibility is purely
//      derived at read time. The Coach read NEVER gates on visible_to_user.
//   2. The GET /api/practice aggregation (§4.10 Q8/Q9): paper artifact + its
//      linked review session + derived pos / right-wrong / gen / source.

import { Artifact } from '@/core/schema/index';
import type { Db } from '@/db/client';
import { artifact, learning_session } from '@/db/schema';
import { readPaperSections } from '@/server/review/paper-sections';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

// ────────────────────────────────────────────────────────────────────────────
// Derived visibility (§4.9)
// ────────────────────────────────────────────────────────────────────────────

export type JudgeVisibilityInput = {
  /** the judge event payload's visible_to_user (undefined = visible default) */
  visibleToUser: boolean | undefined;
  /** the running session's status */
  sessionStatus: string | null | undefined;
};

/**
 * USER-facing visibility (§4.9). A buffered judgement (visible_to_user:false)
 * stays hidden until the session is `completed`. Abandoned does NOT reveal
 * (the user walked away — only `completed` is in the reveal disjunct). A
 * reopened paper is `started` (abandoned→started only, §4.9), so the disjunct is
 * false and hidden stays hidden.
 */
export function isJudgementVisibleToUser(input: JudgeVisibilityInput): boolean {
  return input.visibleToUser !== false || input.sessionStatus === 'completed';
}

// The Coach read never gates on visible_to_user — it always sees every
// judgement (the gate is user-facing only). Exposed as a named no-op predicate
// for call-site clarity / symmetry with isJudgementVisibleToUser.
export function isJudgementVisibleToCoach(): boolean {
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/practice aggregation (§4.10)
// ────────────────────────────────────────────────────────────────────────────

// 往日 source-filter provenance mapping (critic #4). The UI tab filter is a pure
// client-side predicate over `source` (review_plan → Coach 排期, etc.).
export type PracticeSource = 'coach' | 'custom' | 'note' | 'other';

function intentSourceToPracticeSource(intentSource: string): PracticeSource {
  switch (intentSource) {
    case 'review_plan':
      return 'coach';
    case 'quiz_gen':
      return 'custom';
    case 'embedded_check':
      return 'note';
    default:
      return 'other';
  }
}

export interface PracticePaperItem {
  artifact_id: string;
  title: string;
  /** the paper provenance, mapped for the 往日 source-filter tabs */
  source: PracticeSource;
  intent_source: string;
  /** artifact generation_status — drives the 生成中 pill (NOT a pg-boss poll) */
  generation_status: string;
  knowledge_ids: string[];
  /** total answerable slots in the paper (DISTINCT assignment slots) */
  total_slots: number;
  /** the linked review session, if one has been started */
  session: {
    id: string;
    status: string;
    /** answered-so-far = COUNT(DISTINCT slot) WHERE submitted (§4.10 Q9) */
    pos: number;
    /** right/wrong distribution from the latest judge per slot */
    right: number;
    wrong: number;
  } | null;
  created_at: Date;
}

export interface PracticeListResult {
  papers: PracticePaperItem[];
}

/**
 * Aggregate the practice list: every paper artifact (tool_quiz with a paper
 * intent_source) + its linked review session + derived pos / right-wrong / gen.
 * One round-trip per concern (papers, sessions, answered-slot counts, judge
 * outcomes) — no N+1 per-paper fetch leaked to the browser (Q8).
 *
 * The UI splits 今日 / 往日 and applies the source-tab filter client-side over
 * the returned `source` field (Map §C2 / critic #4).
 */
export async function getPracticeList(db: Db): Promise<PracticeListResult> {
  // 1) Paper artifacts (the three widened intent_source provenances).
  const paperRows = await db
    .select()
    .from(artifact)
    .where(
      and(
        eq(artifact.type, 'tool_quiz'),
        inArray(artifact.intent_source, ['review_plan', 'quiz_gen', 'embedded_check']),
      ),
    )
    .orderBy(desc(artifact.created_at));

  if (paperRows.length === 0) return { papers: [] };
  const paperIds = paperRows.map((r) => r.id);

  // 2) Linked review sessions (learning_session.artifact_id → paper). Take the
  //    newest session per paper (a paper can be reopened / restarted).
  const sessionRows = await db
    .select({
      id: learning_session.id,
      status: learning_session.status,
      artifact_id: learning_session.artifact_id,
      created_at: learning_session.created_at,
    })
    .from(learning_session)
    .where(
      and(eq(learning_session.type, 'review'), inArray(learning_session.artifact_id, paperIds)),
    )
    .orderBy(desc(learning_session.created_at));

  const sessionByPaper = new Map<string, { id: string; status: string }>();
  for (const s of sessionRows) {
    if (!s.artifact_id) continue;
    if (!sessionByPaper.has(s.artifact_id)) {
      sessionByPaper.set(s.artifact_id, { id: s.id, status: s.status });
    }
  }
  const sessionIds = [...sessionByPaper.values()].map((s) => s.id);

  // 3) Answered-slot counts per session: COUNT(DISTINCT slot) WHERE submitted
  //    (§4.10 Q9 — DISTINCT so append-only re-submits don't double-count).
  const posBySession = new Map<string, number>();
  if (sessionIds.length > 0) {
    const posRows = await db.execute<{ session_id: string; pos: number }>(sql`
      SELECT session_id, COUNT(DISTINCT (question_id, COALESCE(part_ref, '')))::int AS pos
      FROM answer
      WHERE session_id IN (${sql.join(sessionIds, sql`, `)}) AND submitted_at IS NOT NULL
      GROUP BY session_id
    `);
    for (const r of posRows as unknown as Array<{ session_id: string; pos: number }>) {
      posBySession.set(r.session_id, r.pos);
    }
  }

  // 4) Right/wrong per session, distinct by slot. We use the answer table as the
  //    single truth source — same (session_id, question_id, COALESCE(part_ref,''))
  //    slot key used by pos (step 3), so composite question parts are never
  //    collapsed (Option B fix — the event.payload has no part_ref field; the
  //    answer table's part_ref column is the canonical per-slot identifier).
  //    Take the NEWEST frozen row per slot (MAX(submitted_at)), join to the
  //    attempt event via answer.event_id, read the outcome from event.outcome.
  //    §4.10 Q9: correct/partial → right, incorrect → wrong (the loom dist-bar
  //    is a two-segment good/again split; partial counts as right deliberately —
  //    a partial answer represents meaningful progress toward mastery).
  const rightWrongBySession = new Map<string, { right: number; wrong: number }>();
  if (sessionIds.length > 0) {
    const rwRows = await db.execute<{
      session_id: string;
      outcome: string;
    }>(sql`
      SELECT a.session_id, e.outcome
      FROM answer a
      JOIN event e ON e.id = a.event_id
      WHERE a.session_id IN (${sql.join(sessionIds, sql`, `)})
        AND a.submitted_at IS NOT NULL
        AND a.submitted_at = (
          SELECT MAX(a2.submitted_at)
          FROM answer a2
          WHERE a2.session_id = a.session_id
            AND a2.question_id = a.question_id
            AND COALESCE(a2.part_ref, '') = COALESCE(a.part_ref, '')
            AND a2.submitted_at IS NOT NULL
        )
    `);
    for (const r of rwRows as unknown as Array<{ session_id: string; outcome: string }>) {
      if (!r.session_id) continue;
      const bucket = rightWrongBySession.get(r.session_id) ?? { right: 0, wrong: 0 };
      if (r.outcome === 'failure') bucket.wrong += 1;
      // partial counts as right (§4.10 Q9 deliberate — see comment above)
      else bucket.right += 1;
      rightWrongBySession.set(r.session_id, bucket);
    }
  }

  // 5) Assemble. Total slots = the paper's distinct assignment slots (parsed via
  //    readPaperSections, covering both U4 session_meta + U5 top-level plans).
  const papers: PracticePaperItem[] = paperRows.map((row) => {
    const parsed = Artifact.safeParse(row);
    const toolState = parsed.success ? parsed.data.tool_state : null;
    const sections = readPaperSections(toolState);
    const slotKeys = new Set<string>();
    for (const section of sections) {
      for (const a of section.assignments) {
        slotKeys.add(`${a.question_id}::${a.part_ref ?? ''}`);
      }
    }
    // Fall back to flat question_ids when no sections (legacy flat quiz).
    const totalSlots = slotKeys.size > 0 ? slotKeys.size : (toolState?.question_ids?.length ?? 0);

    const session = sessionByPaper.get(row.id) ?? null;
    return {
      artifact_id: row.id,
      title: row.title,
      source: intentSourceToPracticeSource(row.intent_source),
      intent_source: row.intent_source,
      generation_status: row.generation_status,
      knowledge_ids: row.knowledge_ids ?? [],
      total_slots: totalSlots,
      session: session
        ? {
            id: session.id,
            status: session.status,
            pos: posBySession.get(session.id) ?? 0,
            right: rightWrongBySession.get(session.id)?.right ?? 0,
            wrong: rightWrongBySession.get(session.id)?.wrong ?? 0,
          }
        : null,
      created_at: row.created_at,
    };
  });

  return { papers };
}
