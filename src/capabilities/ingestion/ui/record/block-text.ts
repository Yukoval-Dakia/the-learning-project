// The text of a recognised question (YUK-1473). Current extraction leaves extracted_prompt_md and
// reference_md empty and keeps the question in `structured`; Word blocks and older rows carry the
// text directly. Both read the same here, with the server's own builders.

import {
  type FigureRefT,
  type StructuredQuestionT,
  structuredToPromptMarkdown,
} from '@/core/schema/structured_question';
import type { Block } from './record-api';

/** A block's question text: the stored text, else the text built from its structured question. */
export function promptOf(block: Block): string {
  if (block.extracted_prompt_md) return block.extracted_prompt_md;
  return block.structured ? structuredToPromptMarkdown(block.structured) : '';
}

/** The number printed in the book, when it was read. */
export function printedNumber(block: Block): string | null {
  const no = block.structured?.question_no?.trim();
  return no ? no : null;
}

/** The column head printed over this question in the book, e.g. 一、选择题. */
export function sectionOf(block: Block): string | null {
  const section = block.structured?.section?.trim();
  return section ? section : null;
}

function leaves(question: StructuredQuestionT): StructuredQuestionT[] {
  return question.sub_questions?.length ? question.sub_questions.flatMap(leaves) : [question];
}

function nodes(question: StructuredQuestionT): StructuredQuestionT[] {
  return [question, ...(question.sub_questions ?? []).flatMap(nodes)];
}

/** Rows aren't validated on read, so an old one can have no text at all. */
function picturedOptions(question: StructuredQuestionT) {
  return (question.options ?? []).filter((option) => !option.text?.trim());
}

/**
 * A question's text for its line. The line shows the printed number in its own column and an
 * option's figure under its letter, and the built text has both again: the number, and a bare「A.」
 * per pictured option. Only for reading; what gets saved keeps the text as it is.
 */
export function lineText(text: string, block: Block): string {
  const no = printedNumber(block);
  const prefix = `${no}. `;
  const body = no && text.startsWith(prefix) ? text.slice(prefix.length) : text;
  if (!block.structured) return body;
  const bare = new Set(
    leaves(block.structured).flatMap((q) => picturedOptions(q).map((o) => `${o.label}.`)),
  );
  return body
    .split('\n')
    .filter((line) => !bare.has(line.trim()))
    .join('\n');
}

/** An option with no words and no figure either: a picture that didn't reach this question. */
export function hasOptionsWithoutFigure(block: Block): boolean {
  if (!block.structured) return false;
  const figures = block.figures ?? [];
  return leaves(block.structured).some((question) =>
    picturedOptions(question).some(
      (option) =>
        !figures.some(
          (f) => f.attached_to_index === question.id && f.option_label === option.label,
        ),
    ),
  );
}

export interface LineFigure {
  key: string;
  assetId: string;
  /** What the learner reads under it: the option's letter, or the sub-question it belongs to. */
  label: string | null;
  alt: string;
  handwriting: boolean;
}

/** A question's figures in reading order: a node's own, then its options by their letter's place. */
export function figuresOf(block: Block): LineFigure[] {
  const figures = block.figures ?? [];
  const tree = block.structured ? nodes(block.structured) : [];
  const line = (
    figure: FigureRefT,
    node: StructuredQuestionT | undefined,
    isRoot: boolean,
  ): LineFigure => {
    const sub = !isRoot && node?.question_no ? `第 ${node.question_no} 小题` : null;
    const option = figure.option_label;
    return {
      key: `${figure.asset_id}:${figure.attached_to_index}:${option ?? ''}`,
      assetId: figure.asset_id,
      label: [sub, option].filter(Boolean).join(' ') || null,
      alt: option ? `${sub ?? ''}选项 ${option} 的图` : `${sub ?? '这道题'}的图`,
      handwriting: figure.handwriting_unverified === true,
    };
  };
  const placed = tree.flatMap((node) => {
    const own = figures.filter((f) => f.attached_to_index === node.id);
    const isRoot = node === block.structured;
    const plain = own.filter((f) => !f.option_label);
    const lettered = (node.options ?? []).flatMap((o) =>
      own.filter((f) => f.option_label === o.label),
    );
    // Moved here from a question whose options this one doesn't have: still its figure.
    const rest = own.filter((f) => f.option_label && !lettered.includes(f));
    return [...plain, ...lettered, ...rest].map((f) => line(f, node, isRoot));
  });
  // A figure pointing at a node this question no longer has still belongs to the question.
  const known = new Set(tree.map((node) => node.id));
  const loose = figures
    .filter((f) => !known.has(f.attached_to_index))
    .map((f) => line(f, undefined, true));
  return [...placed, ...loose];
}
