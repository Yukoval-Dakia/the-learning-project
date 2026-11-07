import { Fragment } from 'react';
import { BlockLine } from './BlockLine';
import { printedNumber, sectionOf } from './block-text';
import type { Block } from './record-api';
import type { BlockServing } from './recording-model';

/** Statuses in which a question can still be taken in or read again (the server's own rule). */
const STILL_OPEN = new Set(['partial', 'extracted']);

/** Recognised questions. They go into the library by themselves; each line says how that went. */
export function BlockLines({
  sessionId,
  status,
  blocks,
  serving,
  photos,
  onHoverPage,
}: {
  sessionId: string;
  status: string;
  blocks: Block[];
  serving: ReadonlyMap<string, BlockServing>;
  /** The material is photos or PDF pages, which a question can be read again from. */
  photos: boolean;
  onHoverPage: (page: number | null) => void;
}) {
  if (blocks.length === 0) return null;
  // A position number would read as the book's number and send the learner to the wrong question,
  // so where others have their printed number, one without it shows none.
  const anyPrinted = blocks.some((block) => printedNumber(block) !== null);
  const lineNumber = (block: Block, index: number) =>
    printedNumber(block) ?? (anyPrinted ? '–' : String(index + 1));
  let lastSection: string | null = null;
  return (
    <ol className="rc-lines" aria-label="认出的题">
      {blocks.map((block, i) => {
        // The book prints a column head once over its questions; show it where it starts.
        const section = sectionOf(block);
        const head = section !== lastSection ? section : null;
        lastSection = section;
        return (
          <Fragment key={block.id}>
            {head !== null && <li className="rc-line-sec">{head}</li>}
            <BlockLine
              sessionId={sessionId}
              block={block}
              no={lineNumber(block, i)}
              serving={serving.get(block.id) ?? null}
              open={STILL_OPEN.has(status)}
              photos={photos}
              onHoverPage={onHoverPage}
            />
          </Fragment>
        );
      })}
    </ol>
  );
}
