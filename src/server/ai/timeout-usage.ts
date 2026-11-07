/**
 * Token estimate for a call that ended before the usage chunk.
 * Never an invoice and never {0,0}. CJK is one token; other text is
 * 2.5 characters per token because LaTeX and markup undercounted by
 * about 40–50% at 4. Compaction keeps its own divisor.
 */
import { type PiSkillDoc, composePiSystemPrompt } from './pi-system-prompt';

const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/gu;
const NON_CJK_CHARS_PER_TOKEN = 2.5;

/** Character totals for one stream. The text itself is not retained. */
export interface StreamTextStats {
  chars: number;
  cjk: number;
}

/**
 * Provider-visible input for a timeout estimate.
 * The user turn is the submitted task text. Note reference artifacts live in
 * that JSON, so they are counted once here and not appended again.
 */
export interface TimeoutPromptInput {
  /** Task system prompt before skill bodies are appended. */
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /** SKILL.md bodies the adapter appends onto the system prompt. */
  readonly skillDocs?: readonly PiSkillDoc[];
  readonly searchUnavailable?: boolean;
}

/** Same system-prompt composition the adapter sends, plus the user turn. */
export function timeoutPromptText(input: TimeoutPromptInput): string {
  const system = composePiSystemPrompt(
    input.systemPrompt,
    input.skillDocs,
    input.searchUnavailable === true,
  );
  return `${system}\n${input.userPrompt}`;
}

export function emptyStreamTextStats(): StreamTextStats {
  return { chars: 0, cjk: 0 };
}

export function addStreamText(stats: StreamTextStats, text: string): void {
  if (text.length === 0) return;
  const cjk = text.match(CJK_RE)?.length ?? 0;
  stats.chars += text.length;
  stats.cjk += cjk;
}

export function tokensFromStreamText(stats: StreamTextStats): number {
  if (stats.chars === 0) return 0;
  return Math.max(1, Math.ceil((stats.chars - stats.cjk) / NON_CJK_CHARS_PER_TOKEN + stats.cjk));
}

export function estimateTextTokens(text: string): number {
  const stats = emptyStreamTextStats();
  addStreamText(stats, text);
  return tokensFromStreamText(stats);
}

export function estimateAbortedUsage(
  promptText: string,
  output: StreamTextStats,
): { inputTokens: number; outputTokens: number } {
  let inputTokens = estimateTextTokens(promptText);
  const outputTokens = tokensFromStreamText(output);
  // The provider query had started, so at least the prompt was submitted.
  if (inputTokens + outputTokens === 0) inputTokens = 1;
  return { inputTokens, outputTokens };
}
