// The text of a recognised question (YUK-1473). Current extraction leaves extracted_prompt_md and
// reference_md empty and keeps the question in `structured`; Word blocks and older rows carry the
// text directly. Both read the same here, with the server's own builders.

import {
  type StructuredQuestionT,
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

/** The number printed in the book, when it was read. */
export function printedNumber(block: Block): string | null {
  const no = block.structured?.question_no?.trim();
  return no ? no : null;
}

/**
 * A question's text for its line, which shows the printed number in its own column: the built text
 * starts with that number too. Only for reading; what gets saved keeps the text as it is.
 */
export function withoutPrintedNumber(text: string, block: Block): string {
  const no = printedNumber(block);
  const prefix = `${no}. `;
  return no && text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

function leaves(question: StructuredQuestionT): StructuredQuestionT[] {
  return question.sub_questions?.length ? question.sub_questions.flatMap(leaves) : [question];
}

/** Options read as a letter with no words: often a picture this page can't show. Rows aren't validated on read. */
export function hasEmptyOptions(block: Block): boolean {
  if (!block.structured) return false;
  return leaves(block.structured).some((question) =>
    question.options?.some((option) => !option.text?.trim()),
  );
}
