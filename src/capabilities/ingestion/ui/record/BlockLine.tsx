import { isLowJudgeConfidence } from '@/core/judge-confidence';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { BlockFigures } from './BlockFigures';
import { RescueButton, RevertButton } from './BlockTools';
import { figuresOf, hasOptionsWithoutFigure, lineText, promptOf } from './block-text';
import type { Block } from './record-api';
import { servingNote } from './record-copy';
import type { BlockServing } from './recording-model';
import type { Tone } from './status-words';

function enrollmentWords(block: Block): { text: string; tone: Tone } {
  const { state, reason, library_visible: visible } = block.ingestion_enrollment;
  if (state === 'in_library') {
    return visible === false
      ? { text: '还没放进题库', tone: 'neutral' }
      : { text: '已进题库', tone: 'positive' };
  }
  if (state === 'ignored') return { text: '没收', tone: 'neutral' };
  // Waiting in line is not a failure: only publish_failed says it didn't go in.
  if (reason === 'pending') return { text: '正在进题库', tone: 'working' };
  if (reason === 'needs_text') return { text: '没认出题目', tone: 'caution' };
  return { text: '没进题库', tone: 'caution' };
}

/** One recognised question: its text, how sure the reading was, and where it stands. */
export function BlockLine({
  sessionId,
  block,
  no,
  serving,
  rescuable,
  onHoverPage,
}: {
  sessionId: string;
  block: Block;
  /** The number to show: the printed one when it was read, so it can be checked against the book. */
  no: string;
  /** Today's serving state, once history has been read. */
  serving: BlockServing | null;
  /** The recording still lets a question be read again from its page. */
  rescuable: boolean;
  onHoverPage: (page: number | null) => void;
}) {
  const enrollment = block.ingestion_enrollment;
  const inLibrary = enrollment.state === 'in_library';
  // A question still waiting here has no recorded judgement yet, only how sure the reading was.
  const lowConfidence = isLowJudgeConfidence(
    block.workflow_judge_confidence ?? block.extraction_confidence,
  );
  const emptyOptions = hasOptionsWithoutFigure(block);
  const noKnowledge = inLibrary && enrollment.knowledge === 'missing';
  const held = inLibrary ? servingNote(serving) : null;
  // A question that is only pictures has no words to miss.
  const noWords = figuresOf(block).length > 0 ? '' : '（没认出文字）';
  const first = block.page_spans?.[0];
  const page = first ? first.page_index + 1 : null;
  const state = enrollmentWords(block);
  return (
    <li
      className="rc-line"
      onPointerEnter={() => onHoverPage(page)}
      onPointerLeave={() => onHoverPage(null)}
    >
      <span className="rc-line-no un-num" title={no === '–' ? '没认出题号' : undefined}>
        {no}
      </span>
      <div className="rc-line-main">
        <MathMarkdown className="rc-line-text">
          {lineText(promptOf(block), block) || noWords}
        </MathMarkdown>
        <BlockFigures block={block} />
        {lowConfidence || emptyOptions || noKnowledge || held ? (
          <p className="rc-line-note">
            {lowConfidence && <span>这道题认得把握不高，对照原页看一下。</span>}
            {emptyOptions && <span>选项可能是图，对照原页看。</span>}
            {noKnowledge && <span>知识点还没标。</span>}
            {held && <span>{held}</span>}
          </p>
        ) : null}
        <div className="rc-line-tools">
          {block.status === 'auto_enrolled' && (
            <RevertButton sessionId={sessionId} blockId={block.id} />
          )}
          {block.status === 'draft' && rescuable && enrollment.reason !== 'pending' && (
            <RescueButton sessionId={sessionId} block={block} />
          )}
        </div>
      </div>
      <span className="rc-state rc-line-state" data-tone={state.tone}>
        {state.text}
      </span>
    </li>
  );
}
