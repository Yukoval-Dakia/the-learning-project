import { useCallback, useRef, useState } from 'react';
import { ApiError } from '@/ui/lib/api';
import type { AttemptEvidence } from './attempt-facts';
import { type AttemptCauseOptions, getAttemptCauseOptions } from './practice-api';

type ReadCauseOptions = typeof getAttemptCauseOptions;
type SetRecorded = (evidence: AttemptEvidence | null, attemptEventId?: string | null) => void;

interface CauseEditTarget {
  questionId: string;
  attemptEventId: string;
  current: AttemptCauseOptions['current'];
  state:
    | { status: 'loading' }
    | { status: 'ready'; options: AttemptCauseOptions['options'] }
    | { status: 'owner-confirmed-unavailable'; reason: string }
    | { status: 'transient-failed' };
}

/**
 * Pair a recorded attempt with the owner's cause-options read. The read, rather than an outcome
 * table in the presenter, decides whether this attempt can be attributed.
 */
export function useAttemptCauseEdit(
  questionId: string | undefined,
  setRecorded: SetRecorded,
  readCauseOptions: ReadCauseOptions = getAttemptCauseOptions,
) {
  const [target, setTarget] = useState<CauseEditTarget | null>(null);
  const latestAttemptId = useRef<string | null>(null);
  const latestQuestionId = useRef(questionId);
  const requestToken = useRef(0);
  if (latestQuestionId.current !== questionId) {
    latestQuestionId.current = questionId;
    latestAttemptId.current = null;
    requestToken.current += 1;
  }
  const read = useCallback(
    (attemptEventId: string) => {
      if (
        !questionId ||
        latestQuestionId.current !== questionId ||
        latestAttemptId.current !== attemptEventId
      ) {
        return;
      }
      const token = ++requestToken.current;
      const isCurrent = () =>
        requestToken.current === token &&
        latestQuestionId.current === questionId &&
        latestAttemptId.current === attemptEventId;
      setTarget((previous) => ({
        questionId,
        attemptEventId,
        current:
          previous?.questionId === questionId && previous.attemptEventId === attemptEventId
            ? previous.current
            : null,
        state: { status: 'loading' },
      }));
      void readCauseOptions(attemptEventId).then(
        (response) => {
          if (!isCurrent()) return;
          setTarget((previous) =>
            isCurrent()
              ? {
                  questionId,
                  attemptEventId,
                  current: response.current
                    ? { ...response.current, note: response.current.note }
                    : null,
                  state: { status: 'ready', options: response.options },
                }
              : previous,
          );
        },
        (error: unknown) => {
          if (!isCurrent()) return;
          const unavailable =
            error instanceof ApiError &&
            (error.status === 404 || error.code === 'cause_not_available');
          setTarget((previous) =>
            previous && isCurrent()
              ? {
                  ...previous,
                  state: unavailable
                    ? {
                        status: 'owner-confirmed-unavailable',
                        reason:
                          error.code === 'cause_not_available'
                            ? error.message
                            : '这条作答记录已经不能补错因。',
                      }
                    : { status: 'transient-failed' },
                }
              : previous,
          );
        },
      );
    },
    [questionId, readCauseOptions],
  );
  const recordAttempt = useCallback(
    (evidence: AttemptEvidence | null, attemptEventId: string | null = null) => {
      if (latestQuestionId.current !== questionId) return;
      latestAttemptId.current = attemptEventId;
      requestToken.current += 1;
      setRecorded(evidence, attemptEventId);
      if (attemptEventId && questionId) read(attemptEventId);
      else setTarget(null);
    },
    [questionId, read, setRecorded],
  );
  return {
    recordAttempt,
    causeEdit:
      target &&
      target.questionId === questionId &&
      target.attemptEventId === latestAttemptId.current
        ? { ...target, retry: () => read(target.attemptEventId) }
        : null,
  };
}
