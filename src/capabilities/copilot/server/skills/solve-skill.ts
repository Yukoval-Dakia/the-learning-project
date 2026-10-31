// Standalone single-shot solve-hint service: not routed through chat and has no
// UI seed, but runSolveSkill keeps its signature so a question-page hint entry can
// call it directly.
//
// Hints ONLY. Grading is never routed through the Copilot turn; this module writes
// no judge/attempt event and opens or mutates no tutor session. It calls
// TeachingTurnTask directly via the session-free buildSolveHintInput seed — not the
// tutor-session-bound planSolveHint, which would require a live tutor session — with
// allowedTools:[] → no memory tool, and the prompt/reference input carries no
// memory content, so the hint cannot bias grading.

import { eq } from 'drizzle-orm';

import { AgentRunError } from '@/ai/agent-run-error';
import {
  type HelpProviderFault,
  readHelpProviderFault,
  renderHelpExitMarkdown,
} from '@/ai/help-provider-fault';
import { type SealedHelpExplanationReplay, replayHelpExplanation } from '@/ai/help-reply-grounding';
import type { RunTaskResult } from '@/ai/task-result';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { resolveSubjectProfileForKnowledgeIds } from '@/kernel/read-models/subject-profile';
import { runAgentTask } from '@/server/ai/runner';
import {
  SolveError,
  buildSolveHintInput,
  loadHelpExplanationEvidence,
  parseHintTurn,
  persistHelpExplanationReplay,
} from '../practice-port';

type RunAgentTaskFn = (
  kind: string,
  input: unknown,
  ctx: Parameters<typeof runAgentTask>[2],
) => Promise<Pick<RunTaskResult, 'task_run_id' | 'text' | 'cost_usd' | 'cost_basis'>>;

export interface RunSolveSkillParams {
  db: Db;
  /** Question id (skill_context.ref.id). */
  questionId: string;
  /** 0-based hint count so far for this question; escalates the ask. Defaults to 0. */
  hintIndex?: number;
}

export interface SolveSkillResult {
  /** Non-revealing hint markdown to surface as the Copilot reply. */
  text_md: string;
  /** Real task_run_id from the TeachingTurnTask runner, for cost tracing. */
  task_run_id: string;
  /** Present when the reply was checked against a gold stem. */
  reply_grounding?: SealedHelpExplanationReplay;
}

export interface RunSolveSkillDeps {
  runAgentTaskFn?: RunAgentTaskFn;
}

/**
 * Run one hint turn; returns a non-revealing hint and writes no judge/attempt event.
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
      source: question.source,
    })
    .from(question)
    .where(eq(question.id, questionId))
    .limit(1);
  if (!q || q.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE) {
    throw new SolveError('question_not_found', `question ${questionId} not found`);
  }

  const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, q.knowledge_ids);

  // Reuse the tutor route's session-free seed (question face + reference only).
  const input = buildSolveHintInput(q, hintIndex);
  let result: Pick<RunTaskResult, 'task_run_id' | 'text' | 'cost_usd' | 'cost_basis'>;
  try {
    result = await run('TeachingTurnTask', input, {
      db,
      subjectProfile,
      // Empty tool list → no memory, no tool budget, single structured turn.
      allowedTools: [],
    });
  } catch (error) {
    const fault = readHelpProviderFault(error);
    const taskRunId = error instanceof AgentRunError ? error.taskRunId : undefined;
    if (!fault || !taskRunId) throw error;
    return { text_md: solveSkillExit(fault, q, hintIndex), task_run_id: taskRunId };
  }

  try {
    const parsed = parseHintTurn(result.text);
    const evidence = await loadHelpExplanationEvidence(db, result);
    const replayed = replayHelpExplanation({
      prompt: q.prompt_md ?? '',
      explanation: parsed.text_md,
      hintIndex,
      evidence,
    });
    if (replayed.replay) {
      await persistHelpExplanationReplay(db, {
        subjectKind: 'question',
        subjectId: questionId,
        replay: replayed.replay,
      });
    }
    return {
      text_md: replayed.text_md,
      task_run_id: result.task_run_id,
      ...(replayed.replay ? { reply_grounding: replayed.replay } : {}),
    };
  } catch (error) {
    if (error instanceof SolveError && error.code === 'llm_parse_failed') {
      return {
        text_md: solveSkillExit({ kind: 'parse' }, q, hintIndex),
        task_run_id: result.task_run_id,
      };
    }
    throw error;
  }
}

/** Full reference only at the ladder's reveal stage. Earlier levels stay on the prompt. */
function solveSkillExit(
  fault: HelpProviderFault,
  questionRow: { prompt_md: string | null; reference_md: string | null },
  hintIndex: number,
): string {
  const lead = renderHelpExitMarkdown(fault);
  const reference = questionRow.reference_md?.trim();
  if (hintIndex >= 5 && reference) {
    return `${lead}\n\n参考解（封存材料，不是这次生成的）：\n${reference}`;
  }
  const prompt = questionRow.prompt_md?.trim();
  if (!prompt) return lead;
  const excerpt = prompt.length > 180 ? `${prompt.slice(0, 179)}…` : prompt;
  return `${lead}\n\n题面：${excerpt}`;
}
