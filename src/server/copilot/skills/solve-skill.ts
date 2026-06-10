// YUK-284 (C3) — independent single-shot 解题提示 service (脱离 copilot 展示形式).
//
// 正名 (was: "the Copilot solve skill" / 行为包). As of C3, solve is NO longer a
// chat-routed behavior pack: chat.ts removed the skill_context:{skill:'solve'} branch
// because solve had NO UI seed (a dead入口). This module stays as a standalone service
// — runSolveSkill(params) keeps its signature ({db, questionId, hintIndex?} →
// SolveSkillResult) so a FUTURE 题目页 inline「给点提示」入口 can call it directly. That
// UI 触发点 is OUT OF SCOPE this wave (本期只做服务端摘出); see YUK-284 plan §9.
//
// AF S4 / YUK-203 U6 (OQ6, R4/R7 — Cross-统合 §4.3) — solve service behavior.
//
// Provides the escalating-hint behavior. It does NOT reuse
// planSolveHint (tutor-session-bound: takes a sessionId, calls Tutor.getTutorQuestionId,
// gates on status==='active') — that would force a live tutor session into the
// Copilot path (R3/R7 violation). Instead it calls TeachingTurnTask DIRECTLY via
// the shared session-free seed helper buildSolveHintInput(question, hintIndex).
//
// R4 (load-bearing): hints ONLY. Grading/judging is NEVER routed through the
// Copilot turn — it stays on the memory-denied invoker.ts path on the tutor
// session. This module writes NO judge/attempt event and opens/mutates NO tutor
// session (R7: the Copilot path writes only type='conversation').
//
// R6: the TeachingTurnTask call runs allowedTools:[] → no memory tool. The input
// (prompt_md + reference_md) carries no memory content, so the hint turn is not
// memory-bearing and cannot bias grading.

import { eq } from 'drizzle-orm';

import {
  SolveError,
  buildSolveHintInput,
  parseHintTurn,
} from '@/capabilities/practice/server/solve-session';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { type RunTaskResult, runAgentTask } from '@/server/ai/runner';
import { resolveSubjectProfileForKnowledgeIds } from '@/server/knowledge/subject-profile';

type RunAgentTaskFn = (
  kind: string,
  input: unknown,
  ctx: Parameters<typeof runAgentTask>[2],
) => Promise<RunTaskResult>;

export interface RunSolveSkillParams {
  db: Db;
  /** The solve ref id — a question id (skill_context.ref.id). */
  questionId: string;
  /**
   * 0-based hint count so far for this question in the Copilot conversation —
   * escalates the ask. The caller derives it from prior solve-skill turns; for a
   * first ask it is 0 (the userMessage itself is the implicit ask).
   */
  hintIndex?: number;
}

export interface SolveSkillResult {
  /** The non-revealing hint markdown to surface as the Copilot reply. */
  text_md: string;
  /**
   * The real task_run_id returned by the TeachingTurnTask runner. The caller
   * writes this onto the reply event for cost-tracing + observability
   * (PR #305 review comment #3).
   */
  task_run_id: string;
}

export interface RunSolveSkillDeps {
  runAgentTaskFn?: RunAgentTaskFn;
}

/**
 * Run one solve-skill hint turn inside the Copilot session. Returns a
 * non-revealing hint; writes no judge/attempt event and touches no tutor session.
 */
export async function runSolveSkill(
  params: RunSolveSkillParams,
  deps: RunSolveSkillDeps = {},
): Promise<SolveSkillResult> {
  const { db, questionId } = params;
  const hintIndex = params.hintIndex ?? 0;
  const run = deps.runAgentTaskFn ?? runAgentTask;

  const [q] = await db
    .select({
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      knowledge_ids: question.knowledge_ids,
    })
    .from(question)
    .where(eq(question.id, questionId))
    .limit(1);
  if (!q) throw new SolveError('question_not_found', `question ${questionId} not found`);

  const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, q.knowledge_ids);

  // Reuse the SAME session-free seed (question face + reference only) the tutor
  // route uses (OQ6 "reuse the seed logic, not the tutor-bound entry").
  const input = buildSolveHintInput(q, hintIndex);
  const result = await run('TeachingTurnTask', input, {
    db,
    subjectProfile,
    // R4/R6/OQ5: empty tool list → no memory, no tool budget, single structured turn.
    allowedTools: [],
  });

  return { ...parseHintTurn(result.text), task_run_id: result.task_run_id };
}
