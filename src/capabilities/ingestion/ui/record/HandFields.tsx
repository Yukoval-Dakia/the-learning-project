import { useMutation } from '@tanstack/react-query';
import { Button } from '@/ui-next/public';
import { KnowledgePick } from './KnowledgePick';
import { createWrongAnswer } from './record-api';

/** What the learner filled in under a typed-out question. Held by the composer. */
export interface Hand {
  answer: string;
  knowledge: string[];
}

export const HAND_EMPTY: Hand = { answer: '', knowledge: [] };

/**
 * The rest of a typed-out question: the learner's own answer and its knowledge point. A typed
 * question goes into the library together with the answer, as one they got wrong.
 *
 * The mistake route takes no Idempotency-Key, so the only guard against saving twice is here:
 * one save at a time, and nothing to press again once it went in.
 */
export function HandFields({
  prompt,
  hand,
  onHand,
  onSaved,
}: {
  prompt: string;
  hand: Hand;
  onHand: (next: Hand) => void;
  onSaved: () => void;
}) {
  const save = useMutation({
    mutationFn: () =>
      createWrongAnswer({
        prompt: prompt.trim(),
        answer: hand.answer.trim(),
        knowledgeIds: hand.knowledge,
      }),
    onSuccess: onSaved,
  });
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
          disabled={save.isPending}
          onChange={(e) => onHand({ ...hand, answer: e.target.value })}
        />
      </label>
      <KnowledgePick
        value={hand.knowledge}
        onChange={(knowledge) => onHand({ ...hand, knowledge })}
        disabled={save.isPending}
      />
      <div className="rc-bar">
        <span className="rc-quiet">
          {save.isError ? '没收进去，再试一次。' : (missing ?? '会记成一道做错过的题。')}
        </span>
        <Button
          variant="primary"
          disabled={missing !== null || save.isPending}
          onClick={() => {
            if (!save.isPending) save.mutate();
          }}
        >
          {save.isPending ? '正在收…' : '收进题库'}
        </Button>
      </div>
    </div>
  );
}
