// Recognised questions on their way into the library (YUK-1473). Holds the learner's edits per
// question and the rules the import route enforces: text present, at least one knowledge point,
// and an answer when the learner says it was wrong (otherwise it goes in as a plain question).
//
// The import finishes the recording: every draft not sent is marked as not taken, for good. So
// the button only sends when no kept question is still missing something.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { promptOf, referenceOf } from './block-text';
import { type Block, type ImportBlockBody, type PageSpan, importBlocks } from './record-api';
import { recordKeys } from './recording-read';

export interface QuestionEdit {
  prompt: string;
  knowledgeIds: string[];
  wrong: boolean;
  answer: string;
  skip: boolean;
}

export const IMPORTABLE_STATUS = new Set(['extracted', 'reviewed']);

function startingEdit(block: Block): QuestionEdit {
  const answer = block.wrong_answer_md ?? '';
  return {
    prompt: promptOf(block),
    knowledgeIds: block.auto_enroll_observation?.suggested_knowledge_ids ?? [],
    // The judge's verdict decides: wrong_answer_md holds the learner's answer whether it was right
    // or wrong, so only a 'failure' verdict switches this on ('partial' is a worked example).
    wrong: block.auto_enroll_observation?.mistake_draft?.wrong_answer === 'failure',
    answer,
    skip: false,
  };
}

export type Readiness = 'ready' | 'needs_knowledge' | 'needs_answer' | 'needs_text' | 'skipped';

export function readiness(edit: QuestionEdit): Readiness {
  if (edit.skip) return 'skipped';
  if (!(edit.prompt ?? '').trim()) return 'needs_text';
  if (edit.knowledgeIds.length === 0) return 'needs_knowledge';
  if (edit.wrong && !(edit.answer ?? '').trim()) return 'needs_answer';
  return 'ready';
}

/** Rows saved before spans were kept, or reverted ones, cover the whole first page. */
const FULL_PAGE: PageSpan[] = [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }];

function body(block: Block, edit: QuestionEdit): ImportBlockBody {
  const refs = block.image_refs ?? [];
  const spans = block.page_spans ?? [];
  return {
    block_id: block.id,
    source_block_ids: [block.id],
    page_spans: spans.length > 0 ? spans : FULL_PAGE,
    // A block with no image refs points at its own pages (Word blocks rely on this).
    image_refs: refs.length > 0 ? refs : (block.source_asset_ids ?? []),
    // Untouched text goes back exactly as read, so the server keeps its structured form.
    final_prompt_md: edit.prompt === promptOf(block) ? edit.prompt : edit.prompt.trim(),
    final_reference_md: referenceOf(block),
    final_wrong_answer_md: edit.wrong ? edit.answer.trim() : '',
    outcome: edit.wrong ? 'failure' : 'unanswered',
    knowledge_ids: edit.knowledgeIds,
    cause: null,
    difficulty: 3,
    question_kind: 'short_answer',
  };
}

export function useImportDraft(sessionId: string, blocks: Block[]) {
  // Only what the learner changed is kept; the rest is read fresh from the block, so a question
  // read again shows its new text unless the learner had rewritten it.
  const [edits, setEdits] = useState<Record<string, Partial<QuestionEdit>>>({});
  const qc = useQueryClient();
  const open = blocks.filter((b) => b.status === 'draft');
  const editOf = (b: Block): QuestionEdit => ({ ...startingEdit(b), ...edits[b.id] });
  const update = (b: Block, patch: Partial<QuestionEdit>) =>
    setEdits((cur) => ({ ...cur, [b.id]: { ...cur[b.id], ...patch } }));

  /** After a question is read again, its new text replaces the learner's earlier rewrite. */
  const forgetText = (b: Block) =>
    setEdits((cur) => {
      const { prompt: _old, ...rest } = cur[b.id] ?? {};
      return { ...cur, [b.id]: rest };
    });

  const ready = open.filter((b) => readiness(editOf(b)) === 'ready');
  const waiting = open.filter((b) => {
    const r = readiness(editOf(b));
    return r !== 'ready' && r !== 'skipped';
  });
  /** The learner's explicit choice to leave the unfinished ones out; each stays reversible. */
  const skipWaiting = () =>
    setEdits((cur) => {
      const next = { ...cur };
      for (const b of waiting) next[b.id] = { ...cur[b.id], skip: true };
      return next;
    });

  const send = useMutation({
    // The variable is how many went in as wrong, kept for the line shown afterwards.
    mutationFn: (_wrong: number) => {
      // Sending finishes the recording; anything unfinished would be dropped for good.
      if (waiting.length > 0) throw new Error('unfinished drafts');
      return importBlocks(
        sessionId,
        ready.map((b) => body(b, editOf(b))),
      );
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: recordKeys.blocks(sessionId) });
      void qc.invalidateQueries({ queryKey: recordKeys.session(sessionId) });
      void qc.invalidateQueries({ queryKey: recordKeys.list });
    },
  });

  return {
    editOf,
    update,
    ready,
    waiting,
    skipWaiting,
    forgetText,
    wrongCount: ready.filter((b) => editOf(b).wrong).length,
    skippedCount: open.filter((b) => readiness(editOf(b)) === 'skipped').length,
    send,
  };
}
