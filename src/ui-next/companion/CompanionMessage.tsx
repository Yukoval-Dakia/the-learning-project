import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

/**
 * Where a companion reply is in its life (C3, ADR-0066). The same element walks through all of
 * them in place; it is never swapped for a new one.
 * - `thinking`: only the status mark;
 * - `streaming`: grey text with a caret, "生成中 · 还未生效";
 * - `recording`: generation finished, a thin line runs beneath, "生成完毕 · 正在记录";
 * - `settled`: the committed state was re-read; ink turns normal, "✓ 已记录" shows, then folds away;
 * - `done`: history, no badge.
 * `settled` must come from the re-read committed state, never from the end of the stream.
 */
export type ReplyPhase = 'thinking' | 'streaming' | 'recording' | 'settled' | 'done';

const BADGE: Record<Exclude<ReplyPhase, 'done' | 'settled'>, string> = {
  thinking: '在想…',
  streaming: '生成中 · 还未生效',
  recording: '生成完毕 · 正在记录',
};

/** How long "✓ 已记录" stays before folding away (C3: about two seconds). */
const SETTLED_SHOWN_MS = 2000;

export interface CompanionMessageProps {
  role: 'me' | 'companion';
  /** Companion replies only; omit (or `done`) for history. */
  phase?: ReplyPhase;
  /** A quoted passage this message carries (C4). With `onQuote`, it is a button back to it. */
  quote?: ReactNode;
  onQuote?: () => void;
  /** Accessible name for the quote button, e.g. "回到原文：第 3 步". */
  quoteLabel?: string;
  /** A reference in a reply, e.g. "第 5 步": a button that scrolls the page there (C4, R5). */
  reference?: string;
  onReference?: () => void;
  /** The anchor this message cites, so a margin mark can bring it back into view (R5). */
  cites?: string;
  /** Inline content (text, inline math). The caret follows it while streaming. */
  children?: ReactNode;
}

function Check() {
  return (
    <svg className="un-msg-check" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M2.5 6.4 5 8.8 9.6 3.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function CompanionMessage({
  role,
  phase = 'done',
  quote,
  onQuote,
  quoteLabel,
  reference,
  onReference,
  cites,
  children,
}: CompanionMessageProps) {
  // The receipt folds away by itself; a transition (zeroed under reduced motion) does the motion.
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    setFolded(false);
    if (phase !== 'settled') return;
    const timer = window.setTimeout(() => setFolded(true), SETTLED_SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const temporary = phase === 'thinking' || phase === 'streaming' || phase === 'recording';
  const showBadge = role === 'companion' && phase !== 'done';
  const hasText = phase !== 'thinking' && children !== undefined && children !== null;

  return (
    <div
      className="un-msg"
      data-role={role}
      data-phase={role === 'companion' ? phase : undefined}
      data-cite={cites}
      aria-busy={temporary || undefined}
    >
      {quote !== undefined &&
        (onQuote ? (
          <button
            type="button"
            className="un-msg-quote un-hit"
            onClick={onQuote}
            aria-label={quoteLabel}
            title={quoteLabel}
          >
            {quote}
          </button>
        ) : (
          <span className="un-msg-quote">{quote}</span>
        ))}
      {reference && (
        <button
          type="button"
          className="un-msg-ref un-hit"
          onClick={onReference}
          title={`在正文里看：${reference}`}
        >
          <span aria-hidden="true">↳ </span>
          {reference}
        </button>
      )}
      {showBadge && (
        <span className="un-msg-badge" role="status" data-folded={folded}>
          {phase === 'settled' ? (
            <>
              <Check /> 已记录
            </>
          ) : (
            BADGE[phase as keyof typeof BADGE]
          )}
        </span>
      )}
      {hasText && (
        <p className="un-msg-text">
          {children}
          {phase === 'streaming' && <span className="un-msg-caret" aria-hidden="true" />}
        </p>
      )}
    </div>
  );
}
