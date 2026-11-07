// YUK-1473 — the hint drawer (解题会话) of the practice page, in the loft design language. Same
// behaviour as the old PfCoach: a drawer from the right with a scrim, focus held inside while
// open (shared useFocusTrap stack, so one Esc closes one layer), each opening a fresh six-step
// hint ladder (HintLadder, YUK-354), 「看完整解」 through the issuance (recorded as not
// independent), and the session never counts toward grading. While it is open the page's ⌘Enter
// and number-key hotkeys are paused (the page passes hotkeysSuspended).
// It portals to <body> inside its own UiNextRoot: the retained shell's containers must not clip or
// re-anchor a fixed layer. Closed, the drawer stays mounted for its slide-out but is inert (A1).

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
  /** Opening count; each opening gets a fresh hint ladder (closed content stays for the slide-out). */
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
          <span className="un-ps-hint">一级一级加力</span>
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
              : '看了提示，这题不算独立做的；只打开这里不算。'}
            提示一级一级加力，每一级更近一步；也可以直接看完整解。
          </p>
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
        </div>
      </aside>
    </UiNextRoot>,
    document.body,
  );
}
