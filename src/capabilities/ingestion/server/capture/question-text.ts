import type { StructuredQuestionT } from '@/core/schema/structured_question';
import { structuredToPromptMarkdown } from '@/core/schema/structured_question';

/**
 * The printed prompt of a captured block, single-sourced for enrollment and the
 * read-side enrollment projection. A structured tree without `prompt_text` (VLM
 * emitted only options) must not hide an extracted prompt behind it.
 */
export function blockQuestionMarkdown(block: {
  structured: StructuredQuestionT | null;
  extracted_prompt_md: string | null;
}): string {
  const structured = block.structured;
  if (structured != null && (structured.prompt_text ?? '').trim().length > 0) {
    return structuredToPromptMarkdown(structured);
  }
  return block.extracted_prompt_md ?? '';
}

/** Whether the block carries enough printed text to enter the library. */
export function blockHasPrompt(block: {
  structured: StructuredQuestionT | null;
  extracted_prompt_md: string | null;
}): boolean {
  return blockQuestionMarkdown(block).trim().length > 0;
}
