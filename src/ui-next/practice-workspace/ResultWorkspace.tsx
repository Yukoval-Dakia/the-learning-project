import type { Question, WorkspaceProps, Verdict } from './contracts';
import { AnswerControl } from './AnswerWorkspace';
import { Actions, ActionButton, ContentView, NoticeView } from './controls';
const verdicts: Record<Verdict, string> = {
  correct: '✓ 正确',
  partial: '◐ 部分正确',
  incorrect: '× 需要订正',
  unanswered: '— 未作答',
  review: '◷ 待复核',
  unknown: '? 结果尚未确定',
};
export function ResultWorkspace({
  question: q,
  props: p,
}: {
  question: Question;
  props: WorkspaceProps;
}) {
  const r = q.revelation;
  return (
    <div ref={p.lifecycle?.resultRef} tabIndex={-1} className="un-pw-results">
      {r.kind === 'concealed' ? (
        <>
          {r.reason && <p>{r.reason}</p>}
          {r.confidence && (
            <section className="un-pw-confidence">
              <h2>你有几分把握？</h2>
              <p>1 表示很不确定，5 表示很有把握。也可以跳过。</p>
              <fieldset disabled={r.confidence.availability.kind !== 'enabled'}>
                <legend className="un-pw-sr">揭晓前的把握</legend>
                <div className="un-pw-scale">
                  {([1, 2, 3, 4, 5] as const).map((v) => (
                    <label key={v}>
                      <input
                        type="radio"
                        name={`confidence-${q.id}`}
                        checked={r.confidence?.value === v}
                        onChange={() => p.intents.confidence(v)}
                      />
                      <span>{v}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {r.confidence.availability.kind !== 'enabled' && (
                <p>{r.confidence.availability.reason}</p>
              )}
              <div className="un-pw-actions">
                {r.confidence.continue && (
                  <ActionButton
                    action={r.confidence.continue}
                    primary
                    onAction={p.intents.action}
                  />
                )}
                <ActionButton action={r.confidence.skip} onAction={p.intents.action} />
              </div>
            </section>
          )}
        </>
      ) : (
        <>
          {r.result && (
            <section aria-label="作答结果">
              <div className="un-pw-verdict" data-verdict={r.result.verdict}>
                <span>{verdicts[r.result.verdict]}</span>
                <h2>{r.result.summary}</h2>
              </div>
              {r.result.parts.map((part) => (
                <section key={part.id} className="un-pw-part-result">
                  <h3>
                    {part.label} · {verdicts[part.verdict]}
                  </h3>
                  {part.feedback && <ContentView content={part.feedback} renderers={p.renderers} />}
                </section>
              ))}
              <h3>解释与参考</h3>
              {r.result.reference.kind === 'ready' ? (
                <ContentView content={r.result.reference.content} renderers={p.renderers} />
              ) : (
                <p>{r.result.reference.reason}</p>
              )}
              {r.result.evidence.map((e) => (
                <ContentView key={e.id} content={e} renderers={p.renderers} />
              ))}
              {r.result.uncertainty && <p className="un-pw-attention">{r.result.uncertainty}</p>}
            </section>
          )}
          {r.confidenceRecord && <p className="un-pw-meta">{r.confidenceRecord}</p>}
          {r.selfRating && (
            <section>
              <h3>{r.selfRating.label}</h3>
              <fieldset disabled={r.selfRating.disabled}>
                <legend className="un-pw-sr">结果后的自我评级</legend>
                {r.selfRating.options.map((o) => (
                  <label key={o.id} className="un-pw-rating">
                    <input
                      type="radio"
                      name={`rating-${q.id}`}
                      checked={r.selfRating?.value === o.id}
                      onChange={() => p.intents.rating(o.id)}
                    />
                    {o.label}
                  </label>
                ))}
              </fieldset>
              {r.selfRating.reason && <p>{r.selfRating.reason}</p>}
              <Actions items={r.selfRating.actions} onAction={p.intents.action} />
            </section>
          )}
          {r.appeal && (
            <section aria-label="申诉" data-state={r.appeal.kind}>
              <NoticeView notice={r.appeal.notice} onAction={p.intents.action} />
              {r.appeal.field && (
                <AnswerControl field={r.appeal.field} intents={p.intents} renderers={p.renderers} />
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
