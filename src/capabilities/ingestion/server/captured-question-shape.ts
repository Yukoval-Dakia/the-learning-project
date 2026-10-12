import type { StructuredQuestionT } from '@/core/schema/structured_question';

export function capturedQuestionShape(structured: StructuredQuestionT | null) {
  const choices = structured?.options?.map((option) => option.text) ?? [];
  return {
    kind:
      structured?.kind ??
      (choices.length > 0 ? 'choice' : structured?.role === 'stem' ? 'reading' : 'short_answer'),
    choices_md: choices.length > 0 ? choices : null,
  };
}
