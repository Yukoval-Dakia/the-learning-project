// Portal the drawer outside shell clipping. Closed content remains inert for
// its exit animation; the history reader starts only after an explicit opening.

import { Lightbulb, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '@/ui/primitives/useFocusTrap';
import { IconButton, UiNextRoot } from '@/ui-next/public';
import { HintLadder } from '../HintLadder';
import type { QuestionDetail } from '../practice-api';
import { usePracticeClient } from '../practice-client';

export interface SoloCoachProps {
  open: boolean;
  presentation?: 'workspace';
  /** Opening count rechecks stored-history authorization on each opening. */
  session: number;
  onClose: () => void;
  question: QuestionDetail;
  issuanceId?: string;
  /** The answer is in: its record is sealed, and what is looked at now doesn't change it. */
  submitted: boolean;
}

export function SoloCoach({
  open,
  session,
  onClose,
  question,
  issuanceId,
  presentation,
  submitted,
}: SoloCoachProps) {
  const { revealStudyReference } = usePracticeClient();
  const trapRef = useFocusTrap(open, onClose);
  return createPortal(
    <UiNextRoot
      data-un-m3e={presentation === 'workspace' ? 'practice-studio' : undefined}
      className={
        presentation === 'workspace' ? 'un-st un-st-portal un-ps-coach-root' : 'un-ps-coach-root'
      }
    >
      {open && (
        <button
          type="button"
          className="un-ps-coach-scrim"
          aria-label="关闭解题提示"
          tabIndex={-1}
          onClick={onClose}
        />
      )}
      <aside
        ref={trapRef}
        className="un-ps-coach"
        data-open={open || undefined}
        role="dialog"
        aria-modal={open || undefined}
        aria-label="解题提示"
        inert={!open}
      >
        <header className="un-ps-coach-head">
          <Lightbulb size={15} aria-hidden="true" className="un-ps-coach-icon" />
          <span className="un-ps-coach-title">解题提示</span>
          <span className="un-ps-hint">按需再看一阶</span>
          <IconButton
            label="关闭"
            className="un-ps-coach-close"
            icon={<X size={16} />}
            onClick={onClose}
          />
        </header>
        <div className="un-ps-coach-body">
          <p className="un-ps-hint">
            {submitted
              ? '这题已经交了，现在看提示不影响这次的记录。'
              : '查看新提示或恢复旧提示都会计入援助；没有提示时，只打开这里不算。'}
            越往后越接近答案，已看过的提示可以回看。
          </p>
          {session > 0 && (
            <HintLadder
              key={session}
              question={question}
              onReturnToAnswer={onClose}
              issuanceId={issuanceId}
              submitted={submitted}
              requestFullSolution={
                issuanceId
                  ? async () => (await revealStudyReference(issuanceId)).reference_md
                  : undefined
              }
            />
          )}
        </div>
      </aside>
    </UiNextRoot>,
    document.body,
  );
}
