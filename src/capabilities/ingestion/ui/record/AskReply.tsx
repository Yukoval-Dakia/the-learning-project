import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '@/ui/lib/api';
import { randomId } from '@/ui/lib/random-id';
import { Button } from '@/ui-next/public';
import { type AskAnswerBody, answerAsk } from './record-api';
import { answerRejectWords } from './record-copy';
import type { Ask } from './recording-model';

const TEXT_MAX = 500;

function answeredWords(ask: Ask): string {
  const a = ask.answer;
  if (!a) return '未回答';
  if (a.kind === 'choice') return ask.options.find((o) => o.id === a.option_id)?.label ?? '已选择';
  if (a.kind === 'text') return a.via_option === 'none_of_these' ? `都不是：${a.text}` : a.text;
  return a.by === 'learner' ? '你跳过了这一问' : '没等到回答，未回答';
}

/**
 * The helper's question, under the question it is about. Picking an option sends it; a short
 * answer sends on 回答. It only counts as answered once the helper confirms it on the stream.
 */
export function AskReply({ sessionId, ask }: { sessionId: string; ask: Ask }) {
  const [text, setText] = useState('');
  const [noneOfThese, setNoneOfThese] = useState(false);
  // Same answer → same key, so pressing again after a network error cannot answer twice.
  const [sent, setSent] = useState<{ print: string; key: string } | null>(null);
  const send = useMutation({
    mutationFn: (answer: AskAnswerBody) => {
      const print = JSON.stringify(answer);
      const key = sent?.print === print ? sent.key : randomId();
      setSent({ print, key });
      return answerAsk(sessionId, ask.id, answer, key);
    },
  });

  if (!ask.open) {
    return (
      <div className="rc-ask" data-done="true">
        <p className="rc-ask-q">{ask.prompt}</p>
        <p
          className="rc-ask-a"
          data-unanswered={ask.answer === null || ask.answer.kind === 'skipped'}
        >
          {answeredWords(ask)}
        </p>
      </div>
    );
  }

  const waiting = send.isSuccess;
  const err =
    send.error instanceof ApiError
      ? answerRejectWords(send.error.status, send.error.code)
      : send.isError
        ? '没发出去，再试一次。'
        : null;
  const typed = text.trim();
  const showText = ask.kind === 'short' || noneOfThese;

  return (
    <div className="rc-ask" aria-live="polite">
      <p className="rc-ask-q">{ask.prompt}</p>
      {waiting ? (
        <p className="rc-quiet">发出去了，录入助手会接着整理。</p>
      ) : (
        <>
          {ask.kind === 'choice' && !noneOfThese && (
            <div className="rc-ask-options">
              {ask.options.map((o) => (
                <Button
                  key={o.id}
                  size="sm"
                  variant="secondary"
                  disabled={send.isPending}
                  onClick={() => send.mutate({ kind: 'choice', option_id: o.id })}
                >
                  {o.label}
                </Button>
              ))}
              <Button size="sm" variant="ghost" onClick={() => setNoneOfThese(true)}>
                都不是，我来说
              </Button>
            </div>
          )}
          {showText && (
            <form
              className="rc-ask-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!typed) return;
                send.mutate(
                  noneOfThese
                    ? { kind: 'text', text: typed, via_option: 'none_of_these' }
                    : { kind: 'text', text: typed },
                );
              }}
            >
              <input
                className="rc-input"
                value={text}
                maxLength={TEXT_MAX}
                placeholder={ask.placeholder || '简单说一下'}
                aria-label={ask.prompt}
                onChange={(e) => setText(e.target.value)}
              />
              <Button type="submit" size="sm" variant="primary" disabled={!typed || send.isPending}>
                回答
              </Button>
            </form>
          )}
          <div className="rc-ask-foot">
            {err && <span className="rc-problem">{err}</span>}
            <button
              type="button"
              className="rc-link"
              disabled={send.isPending}
              onClick={() => send.mutate({ kind: 'skipped', by: 'learner' })}
            >
              跳过这一问
            </button>
          </div>
        </>
      )}
    </div>
  );
}
