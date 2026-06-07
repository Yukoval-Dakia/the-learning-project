// YUK-288 题库 UI — question markdown renderer. Thin wrapper over the shared
// MathMarkdown so题面/选项/答案 render with KaTeX ONLY when the row's subject
// notation is 'latex' (PR #83 钉的坑: wenyan `$` is incidental punctuation and
// must NOT trigger math parsing). The caller threads `notation` from the subject
// render model; it defaults to undefined → no math parsing (safe for wenyan).

import { MathMarkdown } from '@/ui/lib/math-markdown';
import type { ReactElement } from 'react';

export interface QMarkdownProps {
  text: string;
  /**
   * Subject renderConfig.notation. KaTeX activates only on 'latex'. Omit (or pass
   * 'wenyan'/undefined) to render `$...$` as raw text — the safe default.
   */
  notation?: 'latex' | 'wenyan' | 'plaintext' | 'code';
  className?: string;
}

export function QMarkdown({ text, notation, className }: QMarkdownProps): ReactElement {
  return (
    <MathMarkdown notation={notation} className={['q-md', className].filter(Boolean).join(' ')}>
      {text}
    </MathMarkdown>
  );
}
