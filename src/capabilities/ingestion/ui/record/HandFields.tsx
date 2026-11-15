import { Button } from '@/ui-next/public';
import { KnowledgePick } from './KnowledgePick';

/** What the learner filled in under a typed-out question. Held by the composer. */
export interface Hand {
  answer: string;
  knowledge: string[];
}

export const HAND_EMPTY: Hand = { answer: '', knowledge: [] };

/**
 * The rest of a typed-out question: the learner's own answer and its knowledge point. A typed
 * question goes into the library together with the answer, as one they got wrong.
 */
export function HandFields({
  hand,
  onHand,
  pending,
  unresolved,
  onSave,
}: {
  hand: Hand;
  onHand: (next: Hand) => void;
  pending: boolean;
  unresolved: boolean;
  onSave: () => void;
}) {
  const missing = !hand.answer.trim()
    ? '写下你当时的答案'
    : hand.knowledge.length === 0
      ? '选一个知识点'
      : null;

  return (
    <div className="rc-hand">
      <label className="rc-field">
        <span className="rc-field-label">我当时的答案</span>
        <textarea
          className="rc-area rc-area-sm"
          rows={2}
          value={hand.answer}
          placeholder="照着当时写的抄下来，错的也照抄"
          onChange={(e) => onHand({ ...hand, answer: e.target.value })}
        />
      </label>
      <KnowledgePick
        value={hand.knowledge}
        onChange={(knowledge) => onHand({ ...hand, knowledge })}
      />
      <div className="rc-bar">
        <span className="rc-quiet">
          {unresolved
            ? '上次保存结果未确认，请先继续原保存；当前修改仍保留。'
            : (missing ?? '会记成一道做错过的题。')}
        </span>
        <Button
          variant="primary"
          disabled={missing !== null || pending || unresolved}
          onClick={onSave}
        >
          {pending ? '正在收…' : '收进题库'}
        </Button>
      </div>
    </div>
  );
}
