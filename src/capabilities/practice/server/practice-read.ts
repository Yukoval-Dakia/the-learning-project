// U5 (YUK-203, §4.9 + §4.10) — practice read layer.
//
// Two concerns:
//   1. Derived judgement visibility (§4.9): 可见 = visible_to_user !== false ||
//      session completed. NEVER mutated, no reveal event — visibility is purely
//      derived at read time. The Coach read NEVER gates on visible_to_user.
//   2. The GET /api/practice aggregation (§4.10 Q8/Q9): paper artifact + its
//      linked review session + derived pos / right-wrong / gen / source.

import { readPaperSections } from '@/capabilities/practice/server/paper-sections';
import { Artifact } from '@/core/schema/index';
import type { Db, Tx } from '@/db/client';
import { artifact, knowledge, learning_session } from '@/db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

// ────────────────────────────────────────────────────────────────────────────
// Shared knowledge name resolver (used by practice-read + paper-detail)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve human-readable names for a set of knowledge ids with one IN query.
 * archived_at is intentionally NOT filtered — historical papers may reference
 * archived nodes; the name should still display rather than falling back to id.
 * Returns a Map<id, name>; ids not found in the table map to themselves (id as
 * fallback) so callers never surface raw unknown ids to the UI.
 */
export async function resolveKnowledgeNames(
  db: Db | Tx,
  ids: string[],
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();
  if (ids.length === 0) return nameMap;
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(inArray(knowledge.id, ids));
  for (const r of rows) nameMap.set(r.id, r.name);
  // Fallback: ids missing from the table resolve to themselves.
  for (const id of ids) {
    if (!nameMap.has(id)) nameMap.set(id, id);
  }
  return nameMap;
}

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

// YUK-214 (Strategy D · S1): exported so the source-mapping is unit-testable
// without a DB round-trip (Cross-统合 F-11). Internal callers (getPracticeList)
// use it unchanged.
export function intentSourceToPracticeSource(intentSource: string): PracticeSource {
  switch (intentSource) {
    case 'review_plan':
      return 'coach';
    case 'quiz_gen':
      return 'custom';
    case 'embedded_check':
      return 'note';
    // YUK-214: an imported paper (ingest→practice bridge) maps to the existing
    // 'other' bucket — it still appears in the 今日/往日 main list (list inclusion
    // is decided ONLY by the inArray whitelist below, not by this source value;
    // Cross-统合 §C1). A dedicated 'ingested' PracticeSource + source tab is
    // phase-deferred to the OC/UI wave (§Step 1; not built here — no tab UI yet).
    case 'ingestion_paper':
      return 'other';
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
  /**
   * Human-readable knowledge node name pairs for the practice list chips.
   * One entry per id in knowledge_ids; name falls back to id when the node
   * is missing or archived (archived_at not filtered — historical papers
   * should still display the name).
   */
  knowledge: Array<{ id: string; name: string }>;
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
export async function getPracticeList(db: Db | Tx): Promise<PracticeListResult> {
  // 1) Paper artifacts (the widened intent_source provenances).
  //    YUK-214 (Strategy D · S1) — `ingestion_paper` is the fourth source
  //    (ingest→practice bridge); must stay in lock-step with the start-session
  //    whitelist in src/capabilities/practice/api/papers-list.ts (§Step 1).
  const paperRows = await db
    .select()
    .from(artifact)
    .where(
      and(
        eq(artifact.type, 'tool_quiz'),
        inArray(artifact.intent_source, [
          'review_plan',
          'quiz_gen',
          'embedded_check',
          'ingestion_paper',
        ]),
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
  // Keyed by session_id for the right/wrong visibility gate lookup (r.session_id
  // from the rwRows query is a session id, not an artifact id).
  const sessionStatusById = new Map<string, string>();
  for (const s of sessionRows) {
    if (!s.artifact_id) continue;
    if (!sessionByPaper.has(s.artifact_id)) {
      sessionByPaper.set(s.artifact_id, { id: s.id, status: s.status });
      sessionStatusById.set(s.id, s.status);
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
  //    Take the NEWEST frozen row per slot (MAX(submitted_at)).
  //
  //    Round-4 fix #2: use the newest JUDGE event's coarse_outcome instead of
  //    the attempt event's outcome. A later rejudge supersedes the original verdict
  //    by writing a new judge event (action='judge', subject_kind='event',
  //    subject_id=attempt_event_id) — the detail view already uses newest-per-slot,
  //    this keeps the list summary in sync. The correlated subquery fetches the
  //    latest judge payload for the attempt; falls back to e.outcome (which maps
  //    'success'→correct-equivalent bucket) when no judge event exists (historical
  //    rows written before the paper judge path).
  //    §4.10 Q9: correct/partial → right, anything else → wrong (deliberate —
  //    partial counts as right, see comment in previous rounds).
  const rightWrongBySession = new Map<string, { right: number; wrong: number }>();
  if (sessionIds.length > 0) {
    // Round-6 fix #2 (CR 3359820526): also fetch visible_to_user from the newest
    // judge event. For sessions not yet 'completed', slots with visible_to_user:false
    // are excluded from the right/wrong count — the summary must not let the caller
    // infer the buffered verdict. For completed sessions all slots are counted
    // (the visibility gate opens on completion per §4.9).
    const rwRows = await db.execute<{
      session_id: string;
      coarse_outcome: string | null;
      judge_visible_to_user: string | null;
      attempt_outcome: string | null;
      unsupported_judge: string | null;
    }>(sql`
      SELECT
        a.session_id,
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
    for (const r of rwRows as unknown as Array<{
      session_id: string;
      coarse_outcome: string | null;
      judge_visible_to_user: string | null;
      attempt_outcome: string | null;
      unsupported_judge: string | null;
    }>) {
      if (!r.session_id) continue;
      // F1 (PR #309 round-4, YUK-215): an UN-JUDGED attempt (photo-only on a
      // text-only route — `unsupported_judge='true'`, no judge event) is neither
      // right nor wrong; it is "未判分". Skip it entirely so it never pollutes the
      // right/wrong summary. Round-3 wrote this attempt with outcome='failure' and
      // no judge event, so the coarse_outcome fallback below counted it as wrong.
      if (r.unsupported_judge === 'true') continue;
      // Visibility gate: if the newest judge is buffered (visible_to_user='false')
      // and the session is not yet completed, skip this slot entirely — do not
      // count it as right or wrong. The summary must not leak the verdict.
      const sessionStatus = sessionStatusById.get(r.session_id);
      const judgeBuffered = r.judge_visible_to_user === 'false';
      if (judgeBuffered && sessionStatus !== 'completed') continue;
      const bucket = rightWrongBySession.get(r.session_id) ?? { right: 0, wrong: 0 };
      // Prefer judge coarse_outcome; fall back to attempt outcome mapping.
      // attempt 'success' → treated as 'correct'; 'partial' → right; else wrong.
      const verdict =
        r.coarse_outcome ??
        (r.attempt_outcome === 'success' ? 'correct' : (r.attempt_outcome ?? 'incorrect'));
      if (verdict === 'correct' || verdict === 'partial') {
        // partial counts as right (§4.10 Q9 deliberate — meaningful progress)
        bucket.right += 1;
      } else {
        bucket.wrong += 1;
      }
      rightWrongBySession.set(r.session_id, bucket);
    }
  }

  // 5) Knowledge name resolution — one IN query across all paper knowledge_ids.
  //    archived_at intentionally not filtered (historical papers still need names).
  const allKnowledgeIds = [...new Set(paperRows.flatMap((r) => r.knowledge_ids ?? []))];
  const knowledgeNameMap = await resolveKnowledgeNames(db, allKnowledgeIds);

  // 6) Assemble. Total slots = the paper's distinct assignment slots (parsed via
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
    const kIds = row.knowledge_ids ?? [];
    return {
      artifact_id: row.id,
      title: row.title,
      source: intentSourceToPracticeSource(row.intent_source),
      intent_source: row.intent_source,
      generation_status: row.generation_status,
      knowledge_ids: kIds,
      knowledge: kIds.map((id) => ({ id, name: knowledgeNameMap.get(id) ?? id })),
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
