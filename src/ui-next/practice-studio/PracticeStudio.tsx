import { MessageSquareQuote, Paperclip } from 'lucide-react';
import { Mascot } from '@/ui-next/public';
import type { ReadingProps, Submission } from './contracts';
import { ConfidenceScale, IntentButton, NoticeBlock } from './controls';
import { PracticeFeedback } from './PracticeFeedback';
import { PracticeField } from './PracticeFields';
import './studio.css';
import './renderers.css';

function SubmissionStatus({
  submission: s,
  intents,
  judged,
}: {
  submission: Submission;
  intents: ReadingProps['intents'];
  /** A verdict on screen already says the answer went through. */
  judged: boolean;
}) {
  const recording = {
    idle: '',
    saving: '正在保存作答',
    saved: '作答已保存',
    unknown: '尚未确认是否保存',
    failed: '作答未能保存',
  };
  const grading = {
    idle: '',
    pending: '在看你的答案，不用重交',
    grading: '在看你的答案',
    unknown: '结果待定',
    failed: '这次没判成，答案还在',
    settled: '',
    manual: '可以自己评一下，用来安排复习',
  };
  return (
    <div className="un-st-submission-status" aria-live="polite">
      {s.recording.notice ? (
        <NoticeBlock notice={s.recording.notice} intents={intents} />
      ) : (
        recording[s.recording.kind] &&
        !(judged && s.recording.kind === 'saved') && <p>{recording[s.recording.kind]}</p>
      )}
      {s.grading.notice ? (
        <NoticeBlock notice={s.grading.notice} intents={intents} />
      ) : (
        grading[s.grading.kind] && <p>{grading[s.grading.kind]}</p>
      )}
      {s.continuation && <NoticeBlock notice={s.continuation.notice} intents={intents} />}
    </div>
  );
}

export function PracticeStudio(p: ReadingProps) {
  const { page } = p.view;
  const { intents, renderers, surfaces, lifecycle } = p;
  if ('notice' in page)
    return (
      <section
        ref={lifecycle?.issuancePlaceholderRef}
        className="un-st-page un-st-page-state"
        data-state={page.kind}
      >
        <p className="un-st-eyebrow">练习</p>
        <h1 ref={lifecycle?.titleRef}>{page.notice.title}</h1>
        {(page.kind === 'loading' || page.kind === 'recovering') && (
          <div className="un-st-skeleton" aria-hidden="true">
            <span className="un-st-skeleton-line" />
            <span className="un-st-skeleton-line" />
            <span className="un-st-skeleton-line" />
          </div>
        )}
        <NoticeBlock
          notice={{ ...page.notice, title: page.notice.detail ?? '', detail: undefined }}
          intents={intents}
          tone={page.kind === 'failed' ? 'error' : 'neutral'}
        />
        {surfaces?.conflict}
        {surfaces?.overlays}
      </section>
    );
  const q = page.question;
  const primary = q.submission.primary;
  const afterFeedback = q.revelation.kind === 'revealed';
  const actionRow = (
    <div ref={lifecycle?.submitActionsRef} className="un-st-submit">
      {q.submission.confidence && (
        <ConfidenceScale confidence={q.submission.confidence} intents={intents} />
      )}
      <div className="un-st-actions">
        {primary && <IntentButton action={primary} intents={intents} primary />}
        {q.submission.secondary.map((action) => (
          <IntentButton key={action.id} action={action} intents={intents} />
        ))}
      </div>
      {primary?.availability.kind !== 'enabled' && primary && (
        <p className="un-st-secondary">{primary.availability.reason}</p>
      )}
      <SubmissionStatus submission={q.submission} intents={intents} judged={afterFeedback} />
    </div>
  );
  return (
    <article className="un-st-page" ref={lifecycle?.contentRef} data-question={q.id}>
      <header className="un-st-task-heading">
        <div>
          <p className="un-st-eyebrow">{q.progressLabel}</p>
          <h1 ref={lifecycle?.titleRef}>{q.title}</h1>
          <p className="un-st-task-meta">
            {[q.subject, q.attemptLabel, q.estimatedTime, q.source, q.reason]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="un-st-heading-companion">
          <div className="un-st-task-stage">
            <span data-current={!afterFeedback || undefined}>作答</span>
            <span aria-hidden="true">→</span>
            <span data-current={afterFeedback || undefined}>反馈</span>
          </div>
          <Mascot
            thinking={
              q.submission.grading.kind === 'grading' ||
              q.submission.grading.kind === 'pending' ||
              q.submission.recording.kind === 'saving'
            }
          />
        </div>
      </header>
      {page.kind === 'partial' && page.missing && (
        <NoticeBlock notice={page.missing} intents={intents} />
      )}
      {surfaces?.conflict}
      {q.draft.kind !== 'empty' && (
        <div className="un-st-draft">
          <NoticeBlock
            notice={q.draft.notice}
            intents={intents}
            tone={q.draft.kind === 'failed' || q.draft.kind === 'conflict' ? 'error' : 'neutral'}
          />
        </div>
      )}
      <div className="un-st-work" ref={lifecycle?.answeringRootRef}>
        <div ref={lifecycle?.quotableRef} className="un-st-question" data-quotable="">
          {surfaces?.questionBody ?? (
            <>
              <div className="un-st-stem">{renderers.content(q.stem)}</div>
              {q.materials.map((material) => {
                const quote = p.presentation.quotes[material.id];
                return (
                  <section className="un-st-material" key={material.id}>
                    <h2>{material.title}</h2>
                    {material.state.kind === 'ready' ? (
                      renderers.content(material.state.content)
                    ) : (
                      <NoticeBlock notice={material.state.notice} intents={intents} />
                    )}
                    {quote && <IntentButton action={quote} intents={intents} />}
                  </section>
                );
              })}
              {q.fields.map((field) => (
                <PracticeField
                  key={field.id}
                  field={field}
                  intents={intents}
                  renderers={renderers}
                />
              ))}
              {q.parts.map((part) => (
                <section key={part.id} className="un-st-question-part">
                  <h2>{part.label}</h2>
                  {renderers.content(part.stem)}
                  {part.materials.map((material) => (
                    <section key={material.id}>
                      <h3>{material.title}</h3>
                      {material.state.kind === 'ready' ? (
                        renderers.content(material.state.content)
                      ) : (
                        <NoticeBlock notice={material.state.notice} intents={intents} />
                      )}
                    </section>
                  ))}
                  {part.fields.map((field) => (
                    <PracticeField
                      key={field.id}
                      field={field}
                      intents={intents}
                      renderers={renderers}
                    />
                  ))}
                </section>
              ))}
            </>
          )}
        </div>
        {!afterFeedback && actionRow}
      </div>
      <div ref={lifecycle?.resultRef}>
        <PracticeFeedback
          revelation={q.revelation}
          intents={intents}
          renderers={renderers}
          actions={afterFeedback ? actionRow : undefined}
        />
      </div>
      <section className="un-st-study-tools" aria-label="辅助工具">
        <div className="un-st-actions">
          {q.supportActions.map((action) => (
            <IntentButton key={action.id} action={action} intents={intents} />
          ))}
        </div>
        {surfaces?.answerExtras && (
          <details className="un-st-disclosure">
            <summary>
              <Paperclip size={18} aria-hidden="true" />
              补充附件与思路
            </summary>
            <div className="un-st-supplement">{surfaces.answerExtras}</div>
          </details>
        )}
        {q.thought && (
          <details className="un-st-disclosure">
            <summary>补充解题思路</summary>
            <PracticeField field={q.thought} intents={intents} renderers={renderers} />
          </details>
        )}
        {surfaces?.history}
        {p.presentation.selection && (
          <aside className="un-st-quote-preview">
            <MessageSquareQuote size={18} />
            <div>
              {renderers.content(p.presentation.selection.preview)}
              <IntentButton action={p.presentation.selection.action} intents={intents} />
            </div>
          </aside>
        )}
      </section>
      {p.view.feedback && <NoticeBlock notice={p.view.feedback} intents={intents} />}
      {surfaces?.selectionActions}
      {surfaces?.overlays}
    </article>
  );
}
