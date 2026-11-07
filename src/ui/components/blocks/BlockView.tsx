// YUK-1548 §2.2 — the one renderer for the generative-UI block family: every Markdown surface hands
// a `tlp-block` fence body here (through MarkdownRenderer), and this switches on `kind`. Kinds in
// the union that no surface draws yet, and anything the schema rejects, get one quiet line.
// v2 grows this into a recursive view over block trees; callers keep passing a fence body.

import type { ReactElement } from 'react';
import { useContext, useMemo } from 'react';
import { type BlockV1T, parseBlockFence } from '@/core/schema/blocks';
import { BlockUnavailable } from './BlockFrame';
import { DiagramBlock } from './DiagramBlock';
import { EntityCardSlotContext } from './entity-card-slot';
import { FigureBlock } from './FigureBlock';
import { QuestionRefSlotContext } from './question-ref-slot';

function QuestionRefBlock({ block }: { block: Extract<BlockV1T, { kind: 'question_ref' }> }) {
  const Slot = useContext(QuestionRefSlotContext);
  const [first] = block.question_ids;
  if (Slot && block.display === 'inline' && first) {
    return <Slot questionId={first} label={block.label} />;
  }
  return (
    <>
      {block.question_ids.map((id) => (
        <p key={id}>
          <a href={`/questions/${encodeURIComponent(id)}`}>{block.label}</a>
        </p>
      ))}
    </>
  );
}

function EntityCardView({ block }: { block: Extract<BlockV1T, { kind: 'entity_card' }> }) {
  const Slot = useContext(EntityCardSlotContext);
  if (Slot) return <Slot entityKind={block.entity_kind} entityId={block.entity_id} />;
  const base = block.entity_kind === 'knowledge' ? '/knowledge' : '/notes';
  return (
    <p>
      <a href={`${base}/${encodeURIComponent(block.entity_id)}`}>{block.label}</a>
    </p>
  );
}

export function BlockView({ block }: { block: BlockV1T | undefined }): ReactElement {
  if (!block) return <BlockUnavailable />;
  switch (block.kind) {
    case 'diagram':
      return <DiagramBlock block={block} />;
    case 'figure':
      return <FigureBlock block={block} />;
    case 'question_ref':
      return <QuestionRefBlock block={block} />;
    case 'entity_card':
      return <EntityCardView block={block} />;
    default:
      return <BlockUnavailable alt={block.alt} />;
  }
}

/** A stored fence body (the JSON between the backticks) → its block view. */
export function BlockFenceView({ body }: { body: string }): ReactElement {
  const block = useMemo(() => parseBlockFence(body), [body]);
  return <BlockView block={block} />;
}
