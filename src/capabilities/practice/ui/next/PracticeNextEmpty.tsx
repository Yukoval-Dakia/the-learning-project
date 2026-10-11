// YUK-1473 — nothing to practise, said plainly, with a way out (design doc M14: an empty state
// carries an entry action). Shown by the new practice page when the stream has no items at all.

import { surfacePath } from '@/kernel/ui-surfaces';
import { Button, UiNextRoot } from '@/ui-next/public';
import './practice-next.css';

export interface PracticeNextEmptyProps {
  /** Knowledge-point scope label when the practice is scoped; null for today's stream. */
  scopeLabel: string | null;
  /** Leave the scope and go back to today's stream; null when not scoped. */
  onClearScope: (() => void) | null;
  navigate: (to: string) => void;
}

export function PracticeNextEmpty({ scopeLabel, onClearScope, navigate }: PracticeNextEmptyProps) {
  return (
    <UiNextRoot className="un-pn-empty-root">
      <section className="un-pn-empty" aria-labelledby="un-pn-empty-title">
        <h2 id="un-pn-empty-title" className="un-pn-empty-title">
          {scopeLabel ? `「${scopeLabel}」现在没有可以练的题` : '现在没有要做的题'}
        </h2>
        <p className="un-pn-empty-text">
          {scopeLabel
            ? '题库里还没有关联到这个知识点的题。可以先回到今天的练习，或者录几道这类题进来。'
            : '今天的练习里还没有题。录几道题进来，或者回到今天看看别的安排。'}
        </p>
        <div className="un-pn-actions">
          {onClearScope ? (
            <Button variant="primary" onClick={onClearScope}>
              回到今天的练习
            </Button>
          ) : (
            <Button variant="primary" onClick={() => navigate(surfacePath('record'))}>
              录题
            </Button>
          )}
          <Button variant="quiet" onClick={() => navigate(surfacePath('today'))}>
            回到今天
          </Button>
        </div>
      </section>
    </UiNextRoot>
  );
}
