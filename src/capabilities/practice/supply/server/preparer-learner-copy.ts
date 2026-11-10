// What the preparer read about the learner may decide the method and the errors a question
// targets, but three things are checked in code before any write runs:
// - learner-authored text (answer excerpts, cause notes, cause analyses) must not reappear
//   verbatim; windows are whitespace-free so a reflowed copy still matches, and text shorter
//   than one window (e.g. a bare `x=2`) is too generic to tell a copy from a coincidence;
// - a question the learner got wrong must not come back as the new prompt; a new parameter or
//   interval in the same function family is a different prompt;
// - once learner causes were read, a draft citing only「常见错因」ignored them; a draft that cites
//  「你近期的错因」somewhere may still label other parts as common errors.
import { inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { normalizePrompt } from '@/kernel/prompt-identity';

const LEARNER_TOOLS = new Set(['query_mistakes', 'query_knowledge', 'expand_knowledge_subgraph']);
const LEARNER_TEXT_FIELDS = new Set(['excerpt', 'user_notes', 'analysis_md']);
export const LEARNER_COPY_WINDOW = 24;

const squash = (text: string) => text.replace(/\s+/g, '');

function strings(
  value: unknown,
  key: string | undefined,
  visit: (text: string, key?: string) => void,
) {
  if (typeof value === 'string') visit(value, key);
  else if (Array.isArray(value)) for (const item of value) strings(item, key, visit);
  else if (value !== null && typeof value === 'object')
    for (const [childKey, child] of Object.entries(value)) strings(child, childKey, visit);
}

function hasLearnerCauses(toolName: string, output: unknown): boolean {
  if (output === null || typeof output !== 'object') return false;
  const record = output as Record<string, unknown>;
  if (toolName === 'query_mistakes')
    return (
      Array.isArray(record.mistakes) &&
      record.mistakes.some((row) => (row as { cause?: unknown } | null)?.cause != null)
    );
  if (toolName === 'get_knowledge_state') {
    const causes = record.top_causes as { known?: boolean; value?: unknown[] | null } | undefined;
    return causes?.known === true && (causes.value?.length ?? 0) > 0;
  }
  return false;
}

export function createLearnerMaterialGuard(db: Db) {
  const learnerText = new Set<string>();
  const missedPrompts = new Set<string>();
  let readLearnerCauses = false;
  return {
    /** Records what one successful read showed about the learner. */
    async observe(toolName: string, output: unknown): Promise<void> {
      readLearnerCauses ||= hasLearnerCauses(toolName, output);
      if (!LEARNER_TOOLS.has(toolName)) return;
      const questionIds = new Set<string>();
      strings(output, undefined, (text, key) => {
        if (key === 'question_id') questionIds.add(text);
        if (key === undefined || !LEARNER_TEXT_FIELDS.has(key)) return;
        const squashed = squash(text);
        if (squashed.length >= LEARNER_COPY_WINDOW) learnerText.add(squashed);
      });
      if (questionIds.size === 0) return;
      const rows = await db
        .select({ prompt_md: question.prompt_md })
        .from(question)
        .where(inArray(question.id, [...questionIds]));
      for (const row of rows) if (row.prompt_md) missedPrompts.add(normalizePrompt(row.prompt_md));
    },
    /** A refusal for the model when a write's arguments break one of the rules, else null. */
    refusal(args: unknown): string | null {
      const fields: string[] = [];
      const prompts: string[] = [];
      const explanations: string[] = [];
      strings(args, undefined, (text, key) => {
        fields.push(squash(text));
        if (key === 'prompt_md' || key === 'stem_md') prompts.push(text);
        if (key === 'explanation_md' || key === 'reference_md') explanations.push(text);
      });
      // NUL is not whitespace, so no window spans two separate fields.
      const haystack = fields.join('\u0000');
      for (const text of learnerText)
        for (let start = 0; start + LEARNER_COPY_WINDOW <= text.length; start++) {
          const window = text.slice(start, start + LEARNER_COPY_WINDOW);
          if (haystack.includes(window))
            return `learner_text_copied: 草稿原样含有学习者错题材料「${window}」。错题、笔记和错因分析只用来定方法和要防的错因类别，题面、选项、解答要自己写；改写后再保存。`;
        }
      const candidates = prompts.length > 1 ? [...prompts, prompts.join('')] : prompts;
      if (candidates.some((prompt) => missedPrompts.has(normalizePrompt(prompt))))
        return 'learner_question_reused: 这是学习者做错的原题，换参数或换区间重出。';
      if (
        readLearnerCauses &&
        explanations.some((text) => text.includes('常见错因')) &&
        !explanations.some((text) => text.includes('你近期的错因'))
      )
        return 'source_label_mismatch: 本次读到了该学习者的错因，草稿却只标了「常见错因」。用到学习者错因的部分写「来源：你近期的错因」，确实没用学习者数据的部分才写「常见错因」。改正后再保存。';
      return null;
    },
  };
}
