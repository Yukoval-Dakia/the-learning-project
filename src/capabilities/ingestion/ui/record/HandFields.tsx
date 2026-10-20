import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/ui-next/public';
import { KnowledgePick } from './KnowledgePick';
import { createWrongAnswer } from './record-api';

/**
 * The rest of a typed-out question: the learner's own answer and its knowledge point. A typed
 * question goes into the library together with the answer, as one they got wrong.
 */
export function HandFields({ prompt, onSaved }: { prompt: string; onSaved: () => void }) {
  const [answer, setAnswer] = useState('');
  const [knowledge, setKnowledge] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: () =>
      createWrongAnswer({ prompt: prompt.trim(), answer: answer.trim(), knowledgeIds: knowledge }),
    onSuccess: () => {
      setAnswer('');
      setKnowledge([]);
      onSaved();
    },
  });
  const missing = !answer.trim()
    ? '写下你当时的答案'
    : knowledge.length === 0
      ? '选一个知识点'
      : null;

  return (
    <div className="rc-hand">
      <label className="rc-field">
        <span className="rc-field-label">我当时的答案</span>
        <textarea
          className="rc-area rc-area-sm"
          rows={2}
          value={answer}
          placeholder="照着当时写的抄下来，错的也照抄"
          onChange={(e) => setAnswer(e.target.value)}
        />
      </label>
      <KnowledgePick value={knowledge} onChange={setKnowledge} disabled={save.isPending} />
      <div className="rc-bar">
        <span className="rc-quiet">
          {save.isError ? '没收进去，再试一次。' : (missing ?? '会记成一道做错过的题。')}
        </span>
        <Button
          variant="primary"
          disabled={missing !== null || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? '正在收…' : '收进题库'}
        </Button>
      </div>
    </div>
  );
}
