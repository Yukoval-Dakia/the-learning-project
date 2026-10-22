// The text of a recognised question (YUK-1473). Current extraction leaves extracted_prompt_md and
// reference_md empty and keeps the question in `structured`; Word blocks and older rows carry the
// text directly. Both read the same here, with the server's own builders.

import {
  structuredToPromptMarkdown,
  structuredToReferenceMarkdown,
} from '@/core/schema/structured_question';
import type { Block } from './record-api';

/** A block's question text: the stored text, else the text built from its structured question. */
export function promptOf(block: Block): string {
  if (block.extracted_prompt_md) return block.extracted_prompt_md;
  return block.structured ? structuredToPromptMarkdown(block.structured) : '';
}

/** A block's reference answer, the same way; null when there is none. */
export function referenceOf(block: Block): string | null {
  if (block.reference_md) return block.reference_md;
  const derived = block.structured ? structuredToReferenceMarkdown(block.structured) : '';
  return derived.trim() ? derived : null;
}
