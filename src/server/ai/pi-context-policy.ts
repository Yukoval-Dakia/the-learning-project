// Internal pi transcript policy. Capacity estimates are never billing usage.
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Message as PiMessage } from '@earendil-works/pi-ai';
import type { LoomPiModel } from './pi-models';

/**
 * Rough chars-per-token divisor for the transformContext compaction trigger.
 * Used for pruning and request headroom, never billing usage.
 */
const PI_COMPACT_CHARS_PER_TOKEN = 4;
/**
 * CJK codepoints estimate to ~1 token each — the repo's own budget note puts
 * 400 CJK chars at ~400–1000 tokens (kernel/tools/budgets.ts), so the generic
 * divisor would undercount a Chinese transcript 4–10× and the window would
 * overflow before the compaction trigger ever fired. Erring toward early compaction
 * is the safe direction.
 */
const PI_COMPACT_CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/gu;

/** Estimate context tokens over the LLM-visible text of a message list. */
export function estimatePiTokens(messages: readonly AgentMessage[]): number {
  let chars = 0;
  let cjkChars = 0;
  const addText = (text: string) => {
    chars += text.length;
    cjkChars += text.match(PI_COMPACT_CJK_RE)?.length ?? 0;
  };
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'toolResult' || message.role === 'system') {
      const content = message.content;
      if (typeof content === 'string') {
        addText(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') addText(block.text);
        }
      }
      if (message.role === 'system') {
        if (message.sections) addText(JSON.stringify(message.sections));
        if (message.toolsAdded) addText(JSON.stringify(message.toolsAdded));
      }
    } else if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'text') addText(block.text);
        else if (block.type === 'thinking') addText(block.thinking);
        else if (block.type === 'toolCall') addText(JSON.stringify(block.arguments));
      }
    }
  }
  return Math.ceil((chars - cjkChars) / PI_COMPACT_CHARS_PER_TOKEN + cjkChars);
}

/** Keep a fresh converter per loop config and retain each LLM message object. */
export function createPiLlmMessageConverter() {
  return (messages: AgentMessage[]): PiMessage[] =>
    messages.filter(
      (m): m is PiMessage =>
        m.role === 'system' ||
        m.role === 'user' ||
        m.role === 'assistant' ||
        m.role === 'toolResult',
    );
}

/**
 * Decide whether to compact, then select the complete retained transcript.
 * The adapter still owns system-delta replay, clocks, frames and failure recovery.
 * The message factory runs after history filtering, at the original injection
 * point; selection therefore does not claim purity for that callback.
 */
export function createPiContextCompactionPolicy(
  model: Pick<LoomPiModel, 'contextWindow' | 'maxInputTokens'>,
  sessionContext: string,
) {
  const contextWindow = Math.min(model.contextWindow, model.maxInputTokens ?? model.contextWindow);
  // Keep the existing 85%/60% policy; max output is a ceiling, not a reservation.
  const triggerTokens = Math.max(1, Math.floor(contextWindow * 0.85));
  const targetTokens = Math.max(1, Math.floor(contextWindow * 0.6));
  const isSessionContextMessage = (message: AgentMessage): boolean =>
    message.role === 'user' &&
    (message.content === sessionContext ||
      (Array.isArray(message.content) &&
        message.content.some((block) => block.type === 'text' && block.text === sessionContext)));

  return (messages: AgentMessage[]) => {
    const preTokens = estimatePiTokens(messages);
    if (preTokens <= triggerTokens) return undefined;
    return {
      preTokens,
      selectMessages(
        system: Extract<PiMessage, { role: 'system' }> | undefined,
        createUserMessage: (content: string) => AgentMessage,
      ): AgentMessage[] {
        const history = messages.filter((message) => message.role !== 'system');
        const prefix: AgentMessage[] = [
          ...(system ? [system] : []),
          createUserMessage(sessionContext),
        ];
        const kept: AgentMessage[] = [];
        let budget = targetTokens - estimatePiTokens(prefix);
        for (let i = history.length - 1; i >= 0; i -= 1) {
          const message = history[i];
          const cost = estimatePiTokens([message]);
          // A retained tool-result batch must include its assistant call even if it exceeds budget.
          if (kept.length > 0 && cost > budget && kept[0].role !== 'toolResult') break;
          kept.unshift(message);
          budget -= cost;
          if (i === 0) break;
        }
        // A fresh injection replaces any previously injected copy so repeated
        // compactions never stack duplicate session contexts.
        const tail = kept.filter((message) => !isSessionContextMessage(message));
        return [...prefix, ...tail];
      },
    };
  };
}
