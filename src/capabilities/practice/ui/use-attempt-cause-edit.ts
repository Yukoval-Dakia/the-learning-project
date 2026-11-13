import { useCallback, useRef, useState } from 'react';
import type { AttemptEvidence } from './attempt-facts';
import { type AttemptCauseOptions, getAttemptCauseOptions } from './practice-api';

type ReadCauseOptions = typeof getAttemptCauseOptions;
type SetRecorded = (evidence: AttemptEvidence | null, attemptEventId?: string | null) => void;

interface CauseEditTarget {
  questionId: string;
  attemptEventId: string;
  current: AttemptCauseOptions['current'];
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
  const recordAttempt = useCallback(
    (evidence: AttemptEvidence | null, attemptEventId: string | null = null) => {
      latestAttemptId.current = attemptEventId;
      setRecorded(evidence, attemptEventId);
      setTarget(null);
      if (!attemptEventId || !questionId) return;
      void readCauseOptions(attemptEventId).then(
        (response) => {
          if (latestAttemptId.current !== attemptEventId) return;
          setTarget({
            questionId,
            attemptEventId,
            current: response.current,
          });
        },
        () => {
          // A 404/409 from the owner read means this attempt is not editable.
        },
      );
    },
    [questionId, readCauseOptions, setRecorded],
  );
  return {
    recordAttempt,
    causeEdit:
      target && target.questionId === questionId
        ? { attemptEventId: target.attemptEventId, current: target.current }
        : null,
  };
}
