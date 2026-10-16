import type { ReactNode } from 'react';
import type { ChipTone } from './Chip';
import { Expand } from './Expand';

export type JudgmentPhase = 'checking' | 'settled';

export interface JudgmentProps {
  /** `checking` right after submit; `settled` once the deterministic result is back (R3). */
  phase: JudgmentPhase;
  /** Tone of the settled result. Status colours carry meaning only; unknown is never critical (R4). */
  tone?: ChipTone;
  /** The settled result, stated plainly, e.g. "与参考答案不一致（确定性核对）". */
  label: ReactNode;
  /** Shown while checking. */
  checkingLabel?: string;
  /** What follows the result (e.g. "原因还没判断"); opens its own space once settled. */
  children?: ReactNode;
  id?: string;
}

function Mark({ tone }: { tone: ChipTone }) {
  if (tone === 'positive') {
    return (
      <svg
        className="un-judgment-mark"
        viewBox="0 0 12 12"
        width="12"
        height="12"
        aria-hidden="true"
      >
        <path d="M2.5 6.4 5 8.8 9.6 3.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  }
  return <span className="un-judgment-dot" aria-hidden="true" />;
}

/**
 * Submit → result in one place (R3, in the spirit of C3). The line opens its own space when it
 * first appears, shows "正在核对" with a running line, then settles in place: the chip takes the
 * result's tone, the mark draws, and the explanation opens below. The host page owns the live region that announces it (one announcement, not two).
 * Judging and explaining stay separate: `label` is the check, `children` the explanation.
 */
export function Judgment({
  phase,
  tone = 'neutral',
  label,
  checkingLabel = '正在核对',
  children,
  id,
}: JudgmentProps) {
  const settled = phase === 'settled';
  return (
    <div id={id} className="un-judgment" data-phase={phase} data-tone={settled ? tone : 'neutral'}>
      <div className="un-judgment-inner">
        <p className="un-judgment-line">
          <span className="un-judgment-chip">
            {settled ? (
              <Mark tone={tone} />
            ) : (
              <span className="un-judgment-dot" aria-hidden="true" />
            )}
            {settled ? label : checkingLabel}
          </span>
        </p>
        {children !== undefined && (
          <Expand open={settled}>
            <div className="un-judgment-body">{children}</div>
          </Expand>
        )}
      </div>
    </div>
  );
}
