// "都看过了" for a classic recording (YUK-1473, contract YUK-1522). A classic recording the reader
// only partly finished cannot go into the library until the learner has checked every question
// it holds — including the ones left out and the ones already put in automatically — and said so.
// That moves the recording to reviewed; putting questions in stays its own, separate step.
//
// Each mark is the learner's, tied to the version of the question they looked at: a question
// read again comes back as a new version and needs a new look. Nothing is marked for them.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '@/ui/lib/api';
import { randomId } from '@/ui/lib/random-id';
import { type Block, type CheckedBlock, reviewBlocks } from './record-api';
import type { Recording } from './recording-model';
import { recordKeys } from './recording-read';

/**
 * Offered only where it unlocks something: a classic recording (the server's own lane verdict,
 * never a guess) that stopped at partial and still has questions waiting. Agent and unknown
 * recordings never get it; extracted ones can already be put in.
 */
export function reviewOffered(rec: Recording): boolean {
  return (
    rec.path === 'extract' &&
    rec.status === 'partial' &&
    rec.blocksRead === 'ready' &&
    rec.blocks.some((b) => b.status === 'draft')
  );
}

export type ReviewProblem =
  /** The server sent no version for some question; nothing can be confirmed. */
  | 'no_version'
  /** The questions changed under the learner; they were read again and need a fresh look. */
  | 'changed'
  /** No answer came back: the same request is looked up again, never sent anew. */
  | 'unknown'
  /** The server turned it down for good. */
  | 'refused';

interface Attempt {
  key: string;
  body: CheckedBlock[];
}

/** No reply, a lost poll, a timeout or a server-side hiccup before any resource: outcome unknown. */
function outcomeUnknown(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  if (err.code === 'operation_timeout') return true;
  return err.status >= 500 && !('operation_id' in err.details);
}

export function useReviewCheck(sessionId: string, blocks: Block[]) {
  const qc = useQueryClient();
  const [marks, setMarks] = useState<Record<string, number>>({});
  // The request in flight or left unanswered; kept so a lookup reuses its key and body exactly.
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [problem, setProblem] = useState<ReviewProblem | null>(null);

  const noVersion = blocks.some((b) => typeof b.version !== 'number');
  const isMarked = (b: Block) => typeof b.version === 'number' && marks[b.id] === b.version;
  const marked = blocks.filter(isMarked).length;

  const reread = () => {
    void qc.invalidateQueries({ queryKey: recordKeys.blocks(sessionId) });
    void qc.invalidateQueries({ queryKey: recordKeys.session(sessionId) });
    void qc.invalidateQueries({ queryKey: recordKeys.history(sessionId) });
  };

  const send = useMutation({
    mutationFn: async (a: Attempt) => {
      const result = await reviewBlocks(sessionId, a.body, a.key);
      if (result?.status !== 'reviewed') throw new Error('review finished without reviewed');
    },
    onSuccess: () => {
      setAttempt(null);
      setProblem(null);
      reread();
      void qc.invalidateQueries({ queryKey: recordKeys.list });
    },
    onError: (err) => {
      if (outcomeUnknown(err)) {
        setProblem('unknown');
        return;
      }
      setAttempt(null);
      if (err instanceof ApiError && err.status === 409) {
        // The set or a version moved: read everything again and let the learner look again.
        setMarks({});
        setProblem('changed');
        reread();
        return;
      }
      setProblem('refused');
    },
  });

  const locked = send.isPending || attempt !== null;
  const ready = !noVersion && blocks.length > 0 && marked === blocks.length;

  const toggle = (b: Block) => {
    if (locked || typeof b.version !== 'number') return;
    const v = b.version;
    setProblem((p) => (p === 'changed' || p === 'refused' ? null : p));
    setMarks((cur) => {
      const next = { ...cur };
      if (next[b.id] === v) delete next[b.id];
      else next[b.id] = v;
      return next;
    });
  };

  /** Sends the learner's marks; after an unknown outcome, looks the same request up again. */
  const confirm = () => {
    if (send.isPending) return;
    if (attempt) {
      send.mutate(attempt);
      return;
    }
    if (!ready) return;
    const next: Attempt = {
      key: randomId(),
      body: blocks.map((b) => ({ block_id: b.id, version: marks[b.id] as number })),
    };
    setAttempt(next);
    setProblem(null);
    send.mutate(next);
  };

  const lookingUp = attempt !== null && !send.isPending;
  return {
    isMarked,
    canMark: (b: Block) => !locked && typeof b.version === 'number',
    toggle,
    marked,
    total: blocks.length,
    ready,
    locked,
    sending: send.isPending,
    done: send.isSuccess,
    lookingUp,
    /** Every question marked at its current version, or an unanswered request to look up. */
    canConfirm: !send.isPending && !send.isSuccess && (ready || lookingUp),
    problem: noVersion ? ('no_version' as const) : problem,
    confirm,
  };
}
