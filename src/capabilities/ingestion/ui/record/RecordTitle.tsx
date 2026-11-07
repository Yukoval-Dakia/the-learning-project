// A recording's title: the start of its first question, read as Markdown so a formula shows as one.

import type { ReactNode } from 'react';
import { MathMarkdown } from '@/ui/lib/math-markdown';

/**
 * 「1. 过点…」 must not turn into a list, and nothing inside can be its own link or picture: in the
 * list the whole row is one button.
 */
function titleSource(title: string): string {
  return title
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^(\s*)(\d+)([.)])/, '$1$2\\$3')
    .replace(/^(\s*)([-+*#>])/, '$1\\$2');
}

const TITLE_COMPONENTS = {
  a: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
};

export function RecordTitle({ when, title }: { when: string | null; title?: string | null }) {
  const source = title ? titleSource(title).trim() : '';
  return (
    <>
      {when}
      {when && source ? ' · ' : null}
      {source ? (
        <MathMarkdown className="rc-row-md" components={TITLE_COMPONENTS}>
          {source}
        </MathMarkdown>
      ) : null}
    </>
  );
}
