// Priced-spend ceiling for one root pi loop (Options.maxBudgetUsd; only kinds with
// `enforceMaxCost` get one). Each turn is priced with the same cost truth the attempt
// settles at. An unpriced turn adds nothing, so for that run the turn ceiling and the
// timeout stay the only bound.
//
// The ceiling stops the run at the current turn without voiding it: once the spend so far
// plus one more turn of the latest size would reach the ceiling while the model still wants
// tools, the loop gets one closing turn. That turn is told to answer from what it already
// has, any tool call in it is refused, and the loop ends after it. The run then finishes as a
// normal answer (stop_reason MAX_BUDGET_STOP_REASON), not as the turn ceiling's error.
import type { AgentLoopConfig, FinishTurn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { Provider } from '@/ai/registry';
import { resolveAttemptCostTruth } from './attempt-cost';
import { piUserMessage } from './pi-runner-frames';

/** finish_reason recorded for a run the ceiling closed. */
export const MAX_BUDGET_STOP_REASON = 'max_budget_usd';

const CLOSING_TURN_PROMPT =
  'The cost budget for this run is used up. Do not call any more tools. Using only what you have already gathered, give your final output now, in exactly the format the task requires.';

const CLOSING_TURN_TOOL_REFUSAL =
  'The cost budget for this run is used up; no more tool calls. Give the final output from what you already have.';

export interface PiCostCeiling {
  /** Runs `inner` (turn ceiling, contract gates) first; its decision always wins. */
  finishTurn(inner: FinishTurn | undefined): FinishTurn;
  readonly prepareNextTurn: NonNullable<AgentLoopConfig['prepareNextTurn']>;
  beforeToolCall(
    inner: AgentLoopConfig['beforeToolCall'],
  ): NonNullable<AgentLoopConfig['beforeToolCall']>;
  /** True once the closing turn was requested. */
  readonly closed: boolean;
}

export function createPiCostCeiling(input: {
  maxBudgetUsd: number;
  provider: Provider;
  model: string;
}): PiCostCeiling {
  let spentUsd = 0;
  let phase: 'open' | 'closing_requested' | 'closing' = 'open';

  const priceTurn = (message: AssistantMessage): number | null => {
    const usage = message.usage;
    if (!usage) return null;
    return resolveAttemptCostTruth({
      provider: input.provider,
      model: input.model,
      tokens: {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheCreationTokens: usage.cacheWrite,
      },
      reportedCostUsd: usage.cost?.total,
    }).amountUsd;
  };

  return {
    get closed() {
      return phase !== 'open';
    },
    finishTurn: (inner) => async (turn, signal) => {
      const decided = await inner?.(turn, signal);
      if (decided) return decided;
      const { message } = turn;
      if (message.stopReason === 'error' || message.stopReason === 'aborted') return undefined;
      if (phase === 'closing') return { action: 'end' };
      if (phase === 'closing_requested') return undefined;
      const turnUsd = priceTurn(message);
      if (turnUsd === null) return undefined;
      spentUsd += turnUsd;
      if (!message.content.some((block) => block.type === 'toolCall')) return undefined;
      if (spentUsd + turnUsd < input.maxBudgetUsd) return undefined;
      phase = 'closing_requested';
      return undefined;
    },
    prepareNextTurn: () => {
      if (phase !== 'closing_requested') return undefined;
      phase = 'closing';
      return { messages: [piUserMessage(CLOSING_TURN_PROMPT)] };
    },
    beforeToolCall: (inner) => async (context, signal) => {
      if (phase === 'closing') return { block: true, reason: CLOSING_TURN_TOOL_REFUSAL };
      return inner?.(context, signal);
    },
  };
}
