import { Check, CircleHelp, RotateCcw, Sparkles, X } from 'lucide-react';
import { type ReactNode, useCallback, useRef } from 'react';
import { CauseEditor } from './CauseEditor';
import type { PracticeIntents, PracticeRenderers, Revelation } from './contracts';
import { IntentButton, NoticeBlock } from './controls';
import { PracticeField } from './PracticeFields';

const verdicts = {
  correct: '做对了',
  partial: '部分正确',
  incorrect: '再看一遍',
  unanswered: '尚未作答',
  review: '需要复核',
  unknown: '待定',
};
export function PracticeFeedback({
  revelation: r,
  intents,
  renderers,
  actions,
}: {
  revelation: Revelation;
  intents: PracticeIntents;
  renderers: PracticeRenderers;
  /** The way forward closes the card, as it closes the question card before an answer. */
  actions?: ReactNode;
}) {
  const verdict = r.kind === 'concealed' ? undefined : r.result?.verdict;
  const previousVerdict = useRef(verdict);
  const focusVerdictOnAttach = useRef(false);
  // Only a live concealed-to-revealed transition may take focus; restored results keep DOM order.
  if (previousVerdict.current !== verdict) {
    focusVerdictOnAttach.current = previousVerdict.current === undefined && verdict !== undefined;
    previousVerdict.current = verdict;
  }
  const verdictHeadingRef = useCallback((heading: HTMLHeadingElement | null) => {
    if (!heading || !focusVerdictOnAttach.current) return;
    focusVerdictOnAttach.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || active.classList.contains('un-st-skip')) {
      heading.focus({ preventScroll: true });
    }
  }, []);
  if (r.kind === 'concealed')
    return r.reason ? <p className="un-st-secondary">{r.reason}</p> : null;
  const result = r.result;
  const VerdictIcon =
    result?.verdict === 'correct' ? Check : result?.verdict === 'incorrect' ? X : CircleHelp;
  return (
    <section className="un-st-feedback" aria-label="作答反馈">
      {result && (
        <>
          <header className="un-st-verdict" data-verdict={result.verdict}>
            <span className="un-st-verdict-mark">
              <VerdictIcon size={22} aria-hidden="true" />
            </span>
            <div>
              <h2 ref={verdictHeadingRef} tabIndex={-1}>
                {verdicts[result.verdict]}
              </h2>
              {result.summary && <p>{result.summary}</p>}
              {result.aiGraded && (
                <p className="un-st-ai-graded">
                  <Sparkles size={14} aria-hidden="true" />
                  这次有 AI 判的部分，还没和人工核对过，仅供参考。
                </p>
              )}
            </div>
          </header>
          {result.uncertainty && <p role="status">{result.uncertainty}</p>}
          {result.facts && result.facts.length > 0 && (
            <dl className="un-st-facts">
              {result.facts.map((fact) => (
                <div key={fact.label}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
      {result && (
        <>
          {result.parts.map((part) => (
            <section key={part.id} className="un-st-feedback-part">
              <h3>
                {part.label} · {verdicts[part.verdict]}
              </h3>
              {part.feedback && renderers.content(part.feedback)}
            </section>
          ))}
          <div className="un-st-feedback-evidence">
            {result.evidence.map((content) => (
              <div key={content.id}>{renderers.content(content)}</div>
            ))}
          </div>
          <details className="un-st-disclosure">
            <summary>参考答案</summary>
            {result.reference.kind === 'ready' ? (
              renderers.content(result.reference.content)
            ) : (
              <p>{result.reference.reason}</p>
            )}
          </details>
        </>
      )}
      {r.confidenceRecord && <p className="un-st-secondary">{r.confidenceRecord}</p>}
      {r.selfRating && (
        <fieldset className="un-st-rating" disabled={r.selfRating.disabled}>
          <legend>{r.selfRating.label}</legend>
          <div>
            {r.selfRating.options.map((option) => (
              <button
                type="button"
                key={option.id}
                aria-pressed={r.selfRating?.value === option.id}
                onClick={() => intents.rating(option.id)}
              >
                <RotateCcw size={18} aria-hidden="true" />
                {option.label}
              </button>
            ))}
          </div>
          {r.selfRating.reason && <p className="un-st-secondary">{r.selfRating.reason}</p>}
          {r.selfRating.actions.map((action) => (
            <IntentButton key={action.id} action={action} intents={intents} />
          ))}
        </fieldset>
      )}
      {/* After the answer and its reference: only then can a learner tell a judgment looks wrong. */}
      {r.cause && <CauseEditor editor={r.cause} />}
      {r.appeal && (
        <section className="un-st-appeal">
          {r.appeal.field && (
            <PracticeField field={r.appeal.field} intents={intents} renderers={renderers} />
          )}
          <NoticeBlock notice={r.appeal.notice} intents={intents} />
        </section>
      )}
      {actions}
    </section>
  );
}
