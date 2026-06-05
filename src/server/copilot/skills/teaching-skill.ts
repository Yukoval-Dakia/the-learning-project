// AF S4 / YUK-203 U6 (OQ2=B2, R2/R5) — the Copilot teaching skill.
//
// A teaching-context turn COMPOSES a call to the existing TeachingTurnTask at the
// SERVICE layer (it does NOT enter the CopilotTask LLM tool loop and does NOT
// enter the tool surface — R2/R5 double-guard). TeachingTurnTask stays a narrow
// internal task; this module renders its single structured ask_check/explain/end
// turn as a Copilot reply + (for ask_check) a materialized question + chips.
//
// SINGLE-SESSION model (Cross-统合 §3.1/§4.2): the turn lives ENTIRELY on the
// Copilot `entrypoint='copilot'` session that runCopilotChat already resolved.
// There is NO second teaching session. The ask_check question is stamped with
// metadata.session_id = the Copilot session id (via materializeAskCheckQuestion),
// so getActiveQuestionState + the accept-chip lineage key off the Copilot session.
//
// The TeachingTurnTask call runs with allowedTools:[] → the SDK gets an empty
// tool list + maxTurns:1 (registry.ts) → a single structured-JSON reply, never a
// tool loop, NO memory (R6), NO tool budget (OQ5).
//
// ATOMICITY NOTE (PR #305 review): this skill deliberately does NOT materialize
// the ask_check question itself. Instead it returns the un-persisted structured
// question params so the caller (runCopilotChat in chat.ts) can wrap BOTH the
// copilot_reply event write AND the question INSERT in a single db.transaction,
// preventing a dangling question row if the reply event write fails mid-flight.

import type { Db } from '@/db/client';
import { type RunTaskResult, runAgentTask } from '@/server/ai/runner';
import {
  type TeachingStructuredQuestionT,
  type TeachingTurnOutputT,
  loadTeachingContext,
  parseTurnOutput,
} from '@/server/orchestrator/teaching';
import type { MaterializeAskCheckParams } from '@/server/teaching/materialize-ask-check';

// Same injectable runner seam the orchestrator uses (kind, input, ctx) → { text }.
// Defaults to runAgentTask; unit tests inject a fixture so the {}-stub db is
// never touched.
type RunAgentTaskFn = (
  kind: string,
  input: unknown,
  ctx: Parameters<typeof runAgentTask>[2],
) => Promise<RunTaskResult>;

export interface RunTeachingSkillParams {
  db: Db;
  /** The Copilot session this turn belongs to (already resolved by runCopilotChat). */
  sessionId: string;
  /** The teaching ref id — a learning_item id (skill_context.ref.id). */
  learningItemId: string;
  /** The user's typed message for this turn. */
  userMessage: string;
}

// Pending question params: the structured question + context needed for
// materializeAskCheckQuestion, without the sourceRef (which is the reply event id
// determined by the caller after this fn returns).
export type PendingAskCheckParams = Omit<MaterializeAskCheckParams, 'sourceRef'> & {
  structured_question: TeachingStructuredQuestionT;
};

export interface TeachingSkillResult {
  /** The reply markdown to surface as the Copilot reply (= turn.text_md). */
  text_md: string;
  /** The discriminated turn kind. */
  kind: TeachingTurnOutputT['kind'];
  suggested_next: TeachingTurnOutputT['suggested_next'];
  /**
   * Present only for an ask_check turn. NOT yet persisted — the caller
   * (runCopilotChat) materializes it inside the same transaction as the reply
   * event write so the two are atomic (PR #305 review comment #1).
   */
  pendingQuestion?: PendingAskCheckParams;
  /**
   * The real task_run_id returned by the TeachingTurnTask runner. The caller
   * writes this onto the reply event for cost-tracing + observability
   * (PR #305 review comment #3).
   */
  task_run_id: string;
}

export interface RunTeachingSkillDeps {
  runAgentTaskFn?: RunAgentTaskFn;
}

/**
 * Run one teaching-skill turn inside the Copilot session.
 *
 * Steps:
 *  1. load the teaching context (reuses the orchestrator's single loader),
 *  2. compose a TeachingTurnTask call with allowedTools:[] (no tool loop, no memory),
 *  3. parse the single structured turn,
 *  4. for ask_check, return a pendingQuestion (NOT yet persisted — the caller
 *     is responsible for wrapping the INSERT + reply event in one transaction).
 */
export async function runTeachingSkill(
  params: RunTeachingSkillParams,
  deps: RunTeachingSkillDeps = {},
): Promise<TeachingSkillResult> {
  const { db, sessionId, learningItemId, userMessage } = params;
  const run = deps.runAgentTaskFn ?? runAgentTask;

  const context = await loadTeachingContext(db, learningItemId);

  // Single-turn teaching: the user's message is the only message. (The legacy
  // route replays prior teach_message events; the Copilot session does not carry
  // teach_message events, so the skill drives one turn from the current message —
  // §4.2: the structured contract is preserved, the history seam is not.)
  const input = {
    learning_item: context.learning_item,
    parent_hub_summary: context.parent_hub_summary,
    atomic_sections: context.atomic_sections,
    messages: [{ role: 'user' as const, text_md: userMessage }],
  };

  const result = await run('TeachingTurnTask', input, {
    db,
    subjectProfile: context.subjectProfile,
    // R5/R6/OQ5: empty tool list → no memory, no tool budget, single structured turn.
    allowedTools: [],
  });

  const turn = parseTurnOutput(result.text);

  let pendingQuestion: PendingAskCheckParams | undefined;
  if (turn.kind === 'ask_check' && turn.structured_question) {
    pendingQuestion = {
      structured_question: turn.structured_question,
      learningItemId,
      // SINGLE-SESSION: stamp the Copilot session id so getActiveQuestionState
      // + the accept-chip lineage resolve against the Copilot session.
      sessionId,
      fallbackPromptMd: turn.text_md,
    };
  }

  return {
    text_md: turn.text_md,
    kind: turn.kind,
    suggested_next: turn.suggested_next,
    task_run_id: result.task_run_id,
    ...(pendingQuestion ? { pendingQuestion } : {}),
  };
}
