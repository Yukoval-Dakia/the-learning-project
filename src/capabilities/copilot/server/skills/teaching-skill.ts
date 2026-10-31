// Copilot teaching skill.
//
// Composes TeachingTurnTask at the service layer — never through the CopilotTask
// LLM tool loop or tool surface — and renders its single ask_check/explain/end
// turn as a Copilot reply plus, for ask_check, a materialized question + chips.
//
// SINGLE-SESSION: the turn lives entirely on the Copilot `entrypoint='copilot'`
// session that runCopilotChat already resolved; there is no second teaching
// session. The ask_check question is stamped with metadata.session_id = the
// Copilot session id, and accept-chip lineage resolves against that same id via
// the event table, not the question stamp.
//
// ATOMICITY: this skill returns unpersisted question params instead of writing the
// row, so the caller can wrap the copilot_reply event write and the question INSERT
// in one transaction and avoid a dangling question row if the reply write fails.
//
// allowedTools:[] → empty SDK tool list + maxTurns:1 → one structured JSON reply,
// never a tool loop, no memory, no tool budget.

import { AgentRunError } from '@/ai/agent-run-error';
import {
  type HelpProviderFault,
  readHelpProviderFault,
  renderHelpExitMarkdown,
} from '@/ai/help-provider-fault';
import { type SealedHelpExplanationReplay, replayHelpExplanation } from '@/ai/help-reply-grounding';
import type { RunTaskResult } from '@/ai/task-result';
import type { MaterializeAskCheckParams } from '@/capabilities/copilot/server/teaching/materialize-ask-check';
import type { Db } from '@/db/client';
import { runAgentTask } from '@/server/ai/runner';
import { loadHelpExplanationEvidence, persistHelpExplanationReplay } from '../practice-port';
import {
  TeachingError,
  type TeachingStructuredQuestionT,
  type TeachingTurnOutputT,
  loadTeachingContext,
  parseTurnOutput,
} from '../teaching';

// Injectable runner seam (kind, input, ctx) → { text }; defaults to runAgentTask.
type RunAgentTaskFn = (
  kind: string,
  input: unknown,
  ctx: Parameters<typeof runAgentTask>[2],
) => Promise<Pick<RunTaskResult, 'task_run_id' | 'text' | 'cost_usd' | 'cost_basis'>>;

export interface RunTeachingSkillParams {
  db: Db;
  /** Stable attempt identity owned by the enclosing conversation run. */
  taskRunId?: string;
  /** Explicit run cancellation, not the browser subscription signal. */
  signal?: AbortSignal;
  /** Absolute deadline shared with the enclosing Copilot run. */
  providerSessionDeadlineAt?: number;
  /** Owning Copilot session, already resolved by runCopilotChat. */
  sessionId: string;
  /** learning_item id (skill_context.ref.id). */
  learningItemId: string;
  userMessage: string;
}

// Question params minus sourceRef, which the caller assigns after this returns.
export type PendingAskCheckParams = Omit<MaterializeAskCheckParams, 'sourceRef'> & {
  structured_question: TeachingStructuredQuestionT;
};

export interface TeachingSkillResult {
  /** Reply markdown to surface as the Copilot reply. */
  text_md: string;
  kind: TeachingTurnOutputT['kind'];
  suggested_next: TeachingTurnOutputT['suggested_next'];
  /** ask_check only; unpersisted — the caller materializes it in the reply transaction. */
  pendingQuestion?: PendingAskCheckParams;
  /** Real task_run_id for cost tracing; the caller writes it onto the reply event. */
  task_run_id: string;
  /** Present when the reply was checked against a gold stem. */
  reply_grounding?: SealedHelpExplanationReplay;
}

function helpExitResult(fault: HelpProviderFault, taskRunId: string): TeachingSkillResult {
  return {
    text_md: renderHelpExitMarkdown(fault),
    kind: 'explain',
    suggested_next: 'end',
    task_run_id: taskRunId,
  };
}

export interface RunTeachingSkillDeps {
  runAgentTaskFn?: RunAgentTaskFn;
}

/** Teaching turns are full explanations, so a failed claim may use the numeric gloss. */
const FULL_EXPLANATION_HINT = 5;

/**
 * Run one teaching-skill turn in the Copilot session; an ask_check turn returns
 * unpersisted question params for the caller to materialize atomically.
 */
export async function runTeachingSkill(
  params: RunTeachingSkillParams,
  deps: RunTeachingSkillDeps = {},
): Promise<TeachingSkillResult> {
  const { db, sessionId, learningItemId, userMessage, providerSessionDeadlineAt } = params;
  const run = deps.runAgentTaskFn ?? runAgentTask;

  params.signal?.throwIfAborted();
  const context = await loadTeachingContext(db, learningItemId);
  params.signal?.throwIfAborted();

  // Single-turn: the Copilot session carries no teach_message history, so the
  // structured contract is preserved but prior turns are not replayed.
  const input = {
    learning_item: context.learning_item,
    parent_hub_summary: context.parent_hub_summary,
    atomic_sections: context.atomic_sections,
    messages: [{ role: 'user' as const, text_md: userMessage }],
  };

  let result: Pick<RunTaskResult, 'task_run_id' | 'text' | 'cost_usd' | 'cost_basis'>;
  try {
    result = await run('TeachingTurnTask', input, {
      db,
      subjectProfile: context.subjectProfile,
      // Empty tool list → no memory, no tool budget, single structured turn.
      allowedTools: [],
      ...(params.taskRunId ? { taskRunId: params.taskRunId } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
      ...(providerSessionDeadlineAt !== undefined ? { providerSessionDeadlineAt } : {}),
    });
  } catch (error) {
    if (params.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw error;
    }
    const fault = readHelpProviderFault(error);
    const taskRunId = error instanceof AgentRunError ? error.taskRunId : params.taskRunId;
    if (!fault || !taskRunId) throw error;
    return helpExitResult(fault, taskRunId);
  }

  // A provider completing at the same time as Stop does not authorize returning
  // an ask_check that the caller could subsequently materialize.
  params.signal?.throwIfAborted();
  let turn: ReturnType<typeof parseTurnOutput>;
  try {
    turn = parseTurnOutput(result.text);
  } catch (error) {
    if (error instanceof TeachingError && error.code === 'llm_parse_failed') {
      return helpExitResult({ kind: 'parse' }, result.task_run_id);
    }
    throw error;
  }

  const evidence = await loadHelpExplanationEvidence(db, result);
  const replayed = replayHelpExplanation({
    prompt: [context.learning_item.title, context.learning_item.one_line_intent, userMessage]
      .filter((part) => part.trim().length > 0)
      .join('\n'),
    explanation: turn.text_md,
    hintIndex: FULL_EXPLANATION_HINT,
    evidence,
  });
  if (replayed.replay) {
    await persistHelpExplanationReplay(db, {
      sessionId,
      subjectKind: 'learning_item',
      subjectId: learningItemId,
      replay: replayed.replay,
    });
  }
  let pendingQuestion: PendingAskCheckParams | undefined;
  if (turn.kind === 'ask_check' && turn.structured_question) {
    pendingQuestion = {
      structured_question: {
        ...turn.structured_question,
        prompt_md: replayed.text_md,
      },
      learningItemId,
      // Stamp the Copilot session id as question provenance; accept-chip lineage
      // resolves against that same session.
      sessionId,
      fallbackPromptMd: replayed.text_md,
    };
  }

  return {
    text_md: replayed.text_md,
    kind: turn.kind,
    suggested_next: turn.suggested_next,
    task_run_id: result.task_run_id,
    ...(replayed.replay ? { reply_grounding: replayed.replay } : {}),
    ...(pendingQuestion ? { pendingQuestion } : {}),
  };
}
