import { BlockLine } from './BlockLine';
import { printedNumber } from './block-text';
import type { Block } from './record-api';
import type { BlockServing } from './recording-model';

/** Recognised questions. They go into the library by themselves; each line says how that went. */
export function BlockLines({
  sessionId,
  blocks,
  serving,
  onHoverPage,
}: {
  sessionId: string;
  blocks: Block[];
  serving: ReadonlyMap<string, BlockServing>;
  onHoverPage: (page: number | null) => void;
}) {
  if (blocks.length === 0) return null;
  // A position number would read as the book's number and send the learner to the wrong question,
  // so where others have their printed number, one without it shows none.
  const anyPrinted = blocks.some((block) => printedNumber(block) !== null);
  const lineNumber = (block: Block, index: number) =>
    printedNumber(block) ?? (anyPrinted ? '–' : String(index + 1));
  return (
    <ol className="rc-lines" aria-label="认出的题">
      {blocks.map((block, i) => (
        <BlockLine
          key={block.id}
          sessionId={sessionId}
          block={block}
          no={lineNumber(block, i)}
          serving={serving.get(block.id) ?? null}
          onHoverPage={onHoverPage}
        />
      ))}
    </ol>
  );
}
