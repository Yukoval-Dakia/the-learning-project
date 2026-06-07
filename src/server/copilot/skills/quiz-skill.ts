// YUK-262 — the Copilot quiz skill.
//
// PROBLEM (owner finding): when a user asks Copilot for a paper/quiz ("给我出套题"),
// the free-form CopilotTask loop just emits quiz TEXT inline instead of producing a
// runnable tool_quiz paper the user can practice in /practice/[id].
//
// FIX (U6 R5 red line, held verbatim): a skill ≠ a surface. This module COMPOSES
// existing SERVICE-layer functions — it does NOT add tools to COPILOT_TOOLS, does
// NOT construct the budget tracker / mcp / tool allowlist, and the surface stays
// 'copilot' (src/server/copilot/chat.ts:349-356 comment, load-bearing).
//
// The quiz skill is PURE service orchestration: it runs the S2 找题次序
// (runSourcingSequence) synchronously to read the existing pool (step 1), assembles
// a tool_quiz artifact from the tier-sorted hits, persists it, and returns a SHORT
// templated reply with a /practice/<artifact_id> markdown link. There is NO LLM
// call on this path (unlike teaching/solve, which call TeachingTurnTask) — the reply
// text is deterministic. When the pool cannot satisfy the request, the skill
// DEGRADES EXPLICITLY with a stated reason — it NEVER silently falls back to
// text-spraying a quiz (the whole point of the fix).
//
// ATOMICITY: the artifact INSERT is wrapped in a db.transaction so a half-written
// paper never escapes. The caller (runCopilotChat) writes its reply event separately
// after this fn returns (the quiz skill owns ONLY the artifact write, mirroring the
// make-paper / review-plan separation).
//
// tool_state builder (buildQuizSkillToolState): kept LOCAL to this module. It
// produces the SAME ToolState-parsed shape as buildIngestionPaperToolState
// (make-paper.ts:47) and write_review_plan's toToolStateSections — but those two
// siblings are semantically stamped (ingestion_session_id / review-plan mode), so
// reusing either would leak the wrong provenance. This is the THIRD concrete
// instance; per the project's "don't abstract until a second instance demands it"
// rule the shared `buildPaperToolState` hoist waits for a FOURTH. See the
// deferred-consolidation note in the YUK-262 plan §9.

import { createId } from '@paralleldrive/cuid2';
import { inArray } from 'drizzle-orm';

import { ToolState, type ToolStateT } from '@/core/schema/business';
import type { Db, Tx } from '@/db/client';
import { artifact, knowledge, question } from '@/db/schema';
import {
  type ExistingPoolHit,
  SOURCING_DEFAULT_COUNT,
  type SourcingSequenceStep,
  runSourcingSequence,
} from '@/server/quiz/sourcing-sequence';

// DI seam: defaults to runSourcingSequence; the db test injects a fixture so the
// existing-pool / knowledgeNodeMissing branches are exercised without enqueuing real
// background jobs.
type RunSourcingSequenceFn = typeof runSourcingSequence;

export interface RunQuizSkillParams {
  db: Db;
  /** The Copilot session this turn belongs to (already resolved by runCopilotChat). */
  sessionId: string;
  /** The quiz ref id — a knowledge node id (skill_context.ref.id). */
  knowledgeId: string;
  /** The user's typed message — used for title/evidence only; it does NOT drive sourcing. */
  userMessage: string;
  /** How many questions to assemble (step-1 short-circuit count). Default 3. */
  count?: number;
  /** 题型 hint forwarded to the sourcing route preference. Optional. */
  kind?: string | null;
  /** Subject domain → resolves the profile route preference. Optional. */
  domain?: string | null;
}

export interface RunQuizSkillDeps {
  runSourcingSequenceFn?: RunSourcingSequenceFn;
  now?: () => Date;
}

export type QuizDegradeReason = 'knowledge_not_found' | 'pool_empty';

export interface QuizSkillResult {
  /** The reply body incl. a /practice/<id> link OR an explicit degradation notice. */
  text_md: string;
  /** Present only when a paper was actually built. */
  artifact_id?: string;
  /** Number of questions in the built paper; 0 on a degraded result. */
  question_count: number;
  status: 'ok' | 'degraded';
  degrade_reason?: QuizDegradeReason;
  /** Background production lines triggered by the sequence (evidence留痕). */
  enqueued?: SourcingSequenceStep[];
}

// The shape buildQuizSkillToolState consumes for per-question knowledge wiring.
interface QuestionKnowledgeRow {
  id: string;
  knowledge_ids: string[];
}

/**
 * Build the tool_quiz `tool_state` for a Copilot-sourced quiz (§2.3). Pure: the
 * tier-sorted pool hits (input order = practice order) → one section, one assignment
 * per question, FSRS keyed on each question's primary knowledge (knowledge_ids[0]).
 * feedback_policy 'immediate' so judgements are visible as the user practices.
 *
 * Throws on an empty hit set (no empty papers — the caller degrades BEFORE calling
 * this) or a question with no knowledge_ids (primary_knowledge_id would be
 * undefined). Passes the ToolState Zod barrier before returning (RL4) — tool_state is
 * jsonb, opaque to audit:schema, so the parse is the load-bearing guard (same
 * discipline as buildIngestionPaperToolState + write_review_plan).
 */
export function buildQuizSkillToolState(
  hits: ExistingPoolHit[],
  knowledgeRows: QuestionKnowledgeRow[],
  params: { sessionId: string },
): ToolStateT {
  if (hits.length === 0) {
    throw new Error('buildQuizSkillToolState: a paper needs at least one question');
  }

  const knowledgeByQuestion = new Map(knowledgeRows.map((r) => [r.id, r.knowledge_ids]));
  const knowledgeFocus = new Set<string>();
  const selectedTiers: Array<{ question_id: string; tier: number }> = [];

  const assignments = hits.map((hit) => {
    const knowledgeIds = knowledgeByQuestion.get(hit.question_id) ?? [];
    if (knowledgeIds.length === 0) {
      throw new Error(
        `buildQuizSkillToolState: question ${hit.question_id} has no knowledge_id (primary would be undefined)`,
      );
    }
    for (const k of knowledgeIds) knowledgeFocus.add(k);
    selectedTiers.push({ question_id: hit.question_id, tier: hit.tier });
    return {
      question_id: hit.question_id,
      // part_ref omitted: pool questions are scheduled as whole questions (one slot).
      primary_knowledge_id: knowledgeIds[0],
      secondary_knowledge_ids: knowledgeIds.slice(1),
      selection_reason: 'copilot_quiz_skill',
      review_profile_snapshot: {},
    };
  });

  return ToolState.parse({
    question_ids: hits.map((h) => h.question_id),
    sections: [
      {
        knowledge_focus: [...knowledgeFocus],
        feedback_policy: 'immediate',
        adaptation_policy: 'none',
        assignments,
      },
    ],
    session_meta: {
      copilot_session_id: params.sessionId,
      // 合约: provenance/tier is READ from runSourcingSequence (deriveSourceTier),
      // never invented here — record the selected tiers for evidence留痕 (S2 §6).
      selected_tiers: selectedTiers,
      // Not an LLM product — there is no tool-context run on the quiz-skill path.
      tool_context_task_run_id: null,
    },
  });
}

/**
 * Format the deterministic reply text for a quiz-skill result. Pure +
 * unit-testable without a DB. The success body keeps it SHORT (no quiz body —
 * the questions live in the artifact, rendered by /practice/[id]); the degraded
 * bodies explain WHY honestly instead of hallucinating a paper.
 */
export function formatQuizReply(
  args:
    | { status: 'ok'; artifactId: string; questionCount: number; partial: boolean }
    | { status: 'degraded'; reason: QuizDegradeReason },
): string {
  if (args.status === 'degraded') {
    if (args.reason === 'knowledge_not_found') {
      return '没找到这个知识点对应的内容，换一个知识点再试试。';
    }
    return '题库里暂时没有现成的题。我已经在后台按「外部检索 → 素材生成 → 闭卷兜底」三条线生成新题，稍后再来求卷就能命中。';
  }
  const link = `/practice/${args.artifactId}`;
  if (args.partial) {
    return `先给你 ${args.questionCount} 道题，其余的我已经在后台补。点这里开始练习：[去练习](${link})`;
  }
  return `已为你组好一套练习（共 ${args.questionCount} 道）。点这里开始练习：[去练习](${link})`;
}

/**
 * Run one quiz-skill turn inside the Copilot session.
 *
 * Steps (no LLM call on any path):
 *  1. runSourcingSequence (step-1 SYNC pool query; steps 2-4 enqueue, NOT awaited),
 *  2. degrade EXPLICITLY when the node is missing or the pool is empty (no text-spray),
 *  3. otherwise load each hit's knowledge_ids, build the tool_state, INSERT the
 *     tool_quiz artifact in one transaction, and return a /practice/<id> link.
 */
export async function runQuizSkill(
  params: RunQuizSkillParams,
  deps: RunQuizSkillDeps = {},
): Promise<QuizSkillResult> {
  const { db, sessionId, knowledgeId, userMessage } = params;
  const count = params.count ?? SOURCING_DEFAULT_COUNT;
  const kind = params.kind ?? null;
  const runSequence = deps.runSourcingSequenceFn ?? runSourcingSequence;
  const now = deps.now?.() ?? new Date();

  // Step 1 (SYNC) + enqueue steps 2-4 (NOT awaited). We consume seq.existing
  // synchronously; we do NOT wait for background production.
  const seq = await runSequence({
    db,
    knowledgeId,
    trigger: 'manual',
    count,
    kind,
    ...(params.domain !== undefined ? { domain: params.domain } : {}),
  });

  // Degrade: the node is missing/archived → nothing was enqueued, nothing to build.
  if (seq.knowledgeNodeMissing) {
    return {
      text_md: formatQuizReply({ status: 'degraded', reason: 'knowledge_not_found' }),
      question_count: 0,
      status: 'degraded',
      degrade_reason: 'knowledge_not_found',
    };
  }

  const hits = seq.existing;

  // Degrade: pool empty → background lines were enqueued, but there is NO ready
  // paper. We surface the honest "couldn't" + the enqueued lines for evidence —
  // we do NOT text-spray a quiz.
  if (hits.length === 0) {
    return {
      text_md: formatQuizReply({ status: 'degraded', reason: 'pool_empty' }),
      question_count: 0,
      status: 'degraded',
      degrade_reason: 'pool_empty',
      enqueued: seq.enqueued,
    };
  }

  // Load each hit's knowledge_ids (one inArray select) to fill per-assignment
  // primary/secondary knowledge — the field invariant the practice path depends on.
  const questionIds = hits.map((h) => h.question_id);
  const knowledgeRows = await db
    .select({ id: question.id, knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(inArray(question.id, questionIds));

  const toolState = buildQuizSkillToolState(hits, knowledgeRows, { sessionId });

  // Title: prefer the knowledge node name; fall back to a generic label.
  const [knowledgeRow] = await db
    .select({ name: knowledge.name })
    .from(knowledge)
    .where(inArray(knowledge.id, [knowledgeId]))
    .limit(1);
  const knowledgeTitle = knowledgeRow?.name ?? '练习';

  // Derived knowledge_ids: the requested node + any others the selected questions
  // carry (so the artifact's knowledge_ids reflect the paper's real coverage).
  const derivedKnowledge = new Set<string>([knowledgeId]);
  for (const row of knowledgeRows) for (const k of row.knowledge_ids) derivedKnowledge.add(k);

  const artifactId = `art_${createId()}`;
  const partial = hits.length < count;

  await db.transaction(async (tx: Tx) => {
    await tx.insert(artifact).values({
      id: artifactId,
      type: 'tool_quiz',
      title: `练习卷 · ${knowledgeTitle}`,
      parent_artifact_id: null,
      knowledge_ids: [...derivedKnowledge],
      // §3 decision: reuse quiz_gen (a first-class paper provenance already on BOTH
      // practice whitelists + BOTH enums) so the paper is immediately runnable with
      // ZERO whitelist/enum/migration edits. attrs.origin disambiguates Copilot-origin.
      intent_source: 'quiz_gen',
      source: 'ai_generated',
      source_ref: null,
      body_blocks: null,
      attrs: {
        origin: 'copilot_quiz_skill',
        copilot_session_id: sessionId,
        // user_message kept for evidence/traceability only (it did NOT drive sourcing).
        user_message: userMessage,
      } as never,
      tool_kind: 'quiz_gen',
      tool_state: toolState as never,
      generation_status: 'ready',
      verification_status: 'not_required',
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
  });

  return {
    text_md: formatQuizReply({
      status: 'ok',
      artifactId,
      questionCount: hits.length,
      partial,
    }),
    artifact_id: artifactId,
    question_count: hits.length,
    status: 'ok',
  };
}
