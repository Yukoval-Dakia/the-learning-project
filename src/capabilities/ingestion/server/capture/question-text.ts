import type { StructuredQuestionT } from '@/core/schema/structured_question';
import { structuredToPromptMarkdown } from '@/core/schema/structured_question';

/**
 * The printed prompt of a captured block, single-sourced for enrollment, the question
 * writer and the read-side projection. A structured tree without `prompt_text` (VLM
 * emitted only options) must not hide an extracted prompt behind it: the extracted text
 * replaces the empty prompt and the options are still appended by the same renderer.
 * An options-only tree with no extracted prompt has no prompt at all.
 */
export function blockQuestionMarkdown(block: {
  structured: StructuredQuestionT | null;
  extracted_prompt_md: string | null;
}): string {
  const structured = block.structured;
  if (structured != null && (structured.prompt_text ?? '').trim().length > 0) {
    return structuredToPromptMarkdown(structured);
  }
  const extracted = (block.extracted_prompt_md ?? '').trim();
  if (structured != null && extracted.length > 0) {
    return structuredToPromptMarkdown({ ...structured, prompt_text: extracted });
  }
  return extracted;
}

/** Whether the block carries enough printed text to enter the library. */
export function blockHasPrompt(block: {
  structured: StructuredQuestionT | null;
  extracted_prompt_md: string | null;
}): boolean {
  return blockQuestionMarkdown(block).trim().length > 0;
}
