import type { StructuredQuestionT } from '@/core/schema/structured_question';
import { structuredToPromptMarkdown } from '@/core/schema/structured_question';

/**
 * The captured block's structured content with a printed prompt. A VLM tree can carry
 * options but an empty `prompt_text` (the OCR text then holds the stem); the extracted
 * text replaces the empty prompt so both the stored tree and the publication contract
 * have a prompt while the same renderer still appends the options. An options-only tree
 * with no extracted prompt stays prompt-less.
 */
export function blockStructuredContent(block: {
  structured: StructuredQuestionT | null;
  extracted_prompt_md: string | null;
}): StructuredQuestionT | null {
  const structured = block.structured;
  if (structured == null) return null;
  if ((structured.prompt_text ?? '').trim().length > 0) return structured;
  const extracted = (block.extracted_prompt_md ?? '').trim();
  return extracted.length > 0 ? { ...structured, prompt_text: extracted } : structured;
}

/**
 * The printed prompt of a captured block, single-sourced for enrollment, the question
 * writer and the read-side projection.
 */
export function blockQuestionMarkdown(block: {
  structured: StructuredQuestionT | null;
  extracted_prompt_md: string | null;
}): string {
  const structured = blockStructuredContent(block);
  if (structured != null && (structured.prompt_text ?? '').trim().length > 0) {
    return structuredToPromptMarkdown(structured);
  }
  return (block.extracted_prompt_md ?? '').trim();
}

/** Whether the block carries enough printed text to enter the library. */
export function blockHasPrompt(block: {
  structured: StructuredQuestionT | null;
  extracted_prompt_md: string | null;
}): boolean {
  return blockQuestionMarkdown(block).trim().length > 0;
}
