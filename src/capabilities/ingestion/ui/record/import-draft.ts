// Recognised questions on their way into the library (YUK-1473). Holds the learner's edits per
// question and the rules the import route enforces: text present, at least one knowledge point,
// and an answer when the learner says it was wrong (otherwise it goes in as a plain question).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type Block, type ImportBlockBody, importBlocks } from './record-api';
import { recordKeys } from './recording-read';

export interface QuestionEdit {
  prompt: string;
  knowledgeIds: string[];
  wrong: boolean;
  answer: string;
  skip: boolean;
}

export const IMPORTABLE_STATUS = new Set(['extracted', 'reviewed']);

export function startingEdit(block: Block): QuestionEdit {
  return {
    prompt: block.extracted_prompt_md,
    knowledgeIds: block.auto_enroll_observation?.suggested_knowledge_ids ?? [],
    wrong: false,
    answer:
      block.wrong_answer_md ?? block.auto_enroll_observation?.mistake_draft?.wrong_answer ?? '',
    skip: false,
  };
}

export type Readiness = 'ready' | 'needs_knowledge' | 'needs_answer' | 'needs_text' | 'skipped';

export function readiness(edit: QuestionEdit): Readiness {
  if (edit.skip) return 'skipped';
  if (!edit.prompt.trim()) return 'needs_text';
  if (edit.knowledgeIds.length === 0) return 'needs_knowledge';
  if (edit.wrong && !edit.answer.trim()) return 'needs_answer';
  return 'ready';
}

function body(block: Block, edit: QuestionEdit): ImportBlockBody {
  return {
    block_id: block.id,
    source_block_ids: [block.id],
    page_spans: block.page_spans,
    image_refs: block.image_refs,
    final_prompt_md: edit.prompt.trim(),
    final_reference_md: block.reference_md,
    final_wrong_answer_md: edit.wrong ? edit.answer.trim() : '',
    outcome: edit.wrong ? 'failure' : 'unanswered',
    knowledge_ids: edit.knowledgeIds,
    cause: null,
    difficulty: 3,
    question_kind: 'short_answer',
  };
}

export function useImportDraft(sessionId: string, blocks: Block[]) {
  const [edits, setEdits] = useState<Record<string, QuestionEdit>>({});
  const qc = useQueryClient();
  const open = blocks.filter((b) => b.status === 'draft');
  const editOf = (b: Block) => edits[b.id] ?? startingEdit(b);
  const update = (b: Block, patch: Partial<QuestionEdit>) =>
    setEdits((cur) => ({ ...cur, [b.id]: { ...(cur[b.id] ?? startingEdit(b)), ...patch } }));

  const ready = open.filter((b) => readiness(editOf(b)) === 'ready');
  const waiting = open.filter((b) => {
    const r = readiness(editOf(b));
    return r !== 'ready' && r !== 'skipped';
  });

  const send = useMutation({
    // The variable is how many went in as wrong, kept for the line shown afterwards.
    mutationFn: (_wrong: number) =>
      importBlocks(
        sessionId,
        ready.map((b) => body(b, editOf(b))),
      ),
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
    wrongCount: ready.filter((b) => editOf(b).wrong).length,
    send,
  };
}

export type ImportDraft = ReturnType<typeof useImportDraft>;
