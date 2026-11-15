import { useCallback, useRef } from 'react';
import type { DraftFocusT } from '@/core/schema/assessment/draft-focus';
import {
  type CompanionFocus,
  readCompanionFocus,
  setCompanionFocus,
} from '@/ui/lib/use-copilot-dwell';

export function usePaperCompanionFocus({
  questionId,
  issuanceId,
  revisionId,
  title,
  available,
  readSavedDraft,
}: {
  questionId: string;
  issuanceId: string | undefined;
  revisionId: string | undefined;
  title: string;
  available: boolean;
  readSavedDraft: () => DraftFocusT | undefined;
}) {
  const reader = useRef<typeof readSavedDraft | undefined>(undefined);
  const owned = useRef<CompanionFocus | null>(null);
  const clearFocus = useCallback(() => {
    const focus = owned.current;
    owned.current = null;
    if (focus && readCompanionFocus()?.readSavedDraft === focus.readSavedDraft)
      setCompanionFocus(null);
  }, []);
  const attachFocus = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !available || !issuanceId || !revisionId) return;
      const focus: CompanionFocus = {
        kind: 'question',
        id: questionId,
        title,
        readSavedDraft: () => {
          if (owned.current !== focus) return undefined;
          const draft = reader.current?.();
          return draft?.question_id === questionId &&
            draft.issuance_id === issuanceId &&
            draft.revision_id === revisionId
            ? draft
            : undefined;
        },
      };
      owned.current = focus;
      setCompanionFocus(focus);
      return () => {
        if (owned.current === focus) clearFocus();
      };
    },
    [available, questionId, issuanceId, revisionId, title, clearFocus],
  );
  // Commit the latest reader without re-publishing focus after every edit or save ACK.
  const attachReader = (node: HTMLDivElement | null) => {
    reader.current = node ? readSavedDraft : undefined;
  };
  return { attachFocus, attachReader, clearFocus };
}
