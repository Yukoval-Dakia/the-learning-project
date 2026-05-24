'use client';

import { MathMarkdown } from '@/ui/lib/math-markdown';
import type { HTMLAttributes, ReactElement } from 'react';

export type NoteRendererKind = 'note' | 'verification' | 'inline';

export interface NoteRendererProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Markdown source. */
  children: string;
  /**
   * Subject renderConfig.notation — threaded through to MathMarkdown for KaTeX
   * gating. Math only parses when notation === 'latex'.
   */
  notation?: 'latex' | 'wenyan' | 'plaintext' | 'code';
  /**
   * Visual variant. Controls which CSS prose ruleset applies.
   * - 'note' (default): atomic / hub note body — wide prose rhythm
   * - 'verification': denser verification summary / suggested-fix blocks
   * - 'inline': single-line callers (badges, chips) — no block margin
   */
  kind?: NoteRendererKind;
}

const KIND_CLASS: Record<NoteRendererKind, string> = {
  note: 'note-prose',
  verification: 'note-prose note-prose--verification',
  inline: 'note-prose note-prose--inline',
};

/**
 * YUK-52 — shared markdown-renderer wrapper for note read views.
 *
 * Thin facade over MathMarkdown: adds a stable `.note-prose` class so global
 * CSS can scope list / code / image / blockquote rules without leaking into
 * other MathMarkdown consumers (TeachingDrawer, JudgeResultPanel, etc.).
 * KaTeX gating + react-markdown behavior are unchanged from MathMarkdown.
 */
export function NoteRenderer({
  children,
  notation,
  kind = 'note',
  className,
  ...divProps
}: NoteRendererProps): ReactElement {
  const composed = [KIND_CLASS[kind], className].filter(Boolean).join(' ');
  return (
    <MathMarkdown notation={notation} className={composed} {...divProps}>
      {children}
    </MathMarkdown>
  );
}
