import { Check, CircleHelp, RotateCcw, X } from 'lucide-react';
import type { PracticeIntents, PracticeRenderers, Revelation } from './contracts';
import { IntentButton, NoticeBlock } from './controls';
import { PracticeField } from './PracticeFields';

const verdicts = {
  correct: '做对了',
  partial: '部分正确',
  incorrect: '再看一遍',
  unanswered: '尚未作答',
  review: '需要复核',
  unknown: '结果尚不确定',
};
export function PracticeFeedback({
  revelation: r,
  intents,
  renderers,
}: {
  revelation: Revelation;
  intents: PracticeIntents;
  renderers: PracticeRenderers;
}) {
  if (r.kind === 'concealed') {
    if (!r.confidence) return r.reason ? <p className="un-st-secondary">{r.reason}</p> : null;
    const c = r.confidence;
    return (
      <section className="un-st-confidence" aria-label="作答把握">
        <h2>看反馈前，你有多大把握？</h2>
        <p>按这次的感觉选择，也可以跳过。</p>
        <fieldset className="un-st-confidence-scale" aria-label="把握从低到高">
          {([1, 2, 3, 4, 5] as const).map((value) => (
            <button
              type="button"
              key={value}
              disabled={c.availability.kind !== 'enabled'}
              aria-pressed={c.value === value}
              onClick={() => intents.confidence(value)}
            >
              <strong>{value}</strong>
              <span className="un-st-confidence-caption">
                {value === 1 ? '没把握' : value === 3 ? '有些把握' : value === 5 ? '很有把握' : ' '}
              </span>
            </button>
          ))}
        </fieldset>
        {c.availability.kind !== 'enabled' && <p>{c.availability.reason}</p>}
        <div className="un-st-actions">
          <IntentButton action={c.skip} intents={intents} />
          {c.continue && <IntentButton action={c.continue} intents={intents} primary />}
        </div>
      </section>
    );
  }
  const result = r.result;
  const VerdictIcon =
    result?.verdict === 'correct' ? Check : result?.verdict === 'incorrect' ? X : CircleHelp;
  return (
    <section className="un-st-feedback" aria-label="作答反馈">
      {result && (
        <>
          <header className="un-st-verdict" data-verdict={result.verdict}>
            <VerdictIcon size={24} aria-hidden="true" />
            <div>
              <h2>{verdicts[result.verdict]}</h2>
              <p>{result.summary}</p>
            </div>
          </header>
          {result.uncertainty && <p role="status">{result.uncertainty}</p>}
          {result.parts.map((part) => (
            <section key={part.id}>
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
      {r.appeal && (
        <section className="un-st-appeal">
          <NoticeBlock notice={r.appeal.notice} intents={intents} />
          {r.appeal.field && (
            <PracticeField field={r.appeal.field} intents={intents} renderers={renderers} />
          )}
        </section>
      )}
    </section>
  );
}
