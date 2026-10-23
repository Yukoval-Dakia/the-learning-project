// Quick prompts follow what the learner is looking at. They are ordinary chat turns
// (triggered_by 'chat'); the focus itself rides along as ambient_context.focused_entity.

import type { CompanionFocus } from '@/ui/lib/use-copilot-dwell';

export interface FocusChip {
  label: string;
  /** Sent as the learner's message. */
  text: string;
  /** Seed the quiz skill on this knowledge point. */
  quiz?: { knowledgeId: string | null };
}

const FOCUS_KIND_LABELS: Readonly<Record<string, string>> = {
  question: '题目',
  knowledge: '知识点',
  note: '笔记',
  learning_session: '录入',
  mistake: '错题',
};

export function focusKindLabel(kind: string): string | null {
  return FOCUS_KIND_LABELS[kind] ?? null;
}

export function focusChips(
  focus: CompanionFocus | null,
  skillKnowledgeId: string | null,
): FocusChip[] {
  switch (focus?.kind) {
    case 'question':
      return [
        { label: '讲讲这题', text: '讲讲这题' },
        { label: '出一道类似的', text: '出一道类似的题' },
      ];
    case 'knowledge':
      return [
        { label: '出题 · 这个知识点', text: '出题', quiz: { knowledgeId: focus.id } },
        { label: '讲讲这个知识点', text: '讲讲这个知识点' },
      ];
    case 'note':
      return [{ label: '用几句话讲讲这篇', text: '用几句话讲讲这篇笔记' }];
    default:
      return [
        { label: '今天该复习哪些？', text: '今天该复习哪些？' },
        {
          label: skillKnowledgeId ? '出题 · 当前知识点' : '出题',
          text: '出题',
          quiz: { knowledgeId: skillKnowledgeId },
        },
      ];
  }
}
