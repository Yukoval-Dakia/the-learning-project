import type { Content, Material, WorkspaceProps } from './contracts';
import { AnswerControl } from './AnswerWorkspace';
import { ResultWorkspace } from './ResultWorkspace';
import { ActionButton, Actions, ContentView, Icon, NoticeView } from './controls';
function Reading({ content, props: p }: { content: Content; props: WorkspaceProps }) {
  const quote = p.presentation.quotes[content.id];
  return (
    <div className="un-pw-reading-block">
      <ContentView content={content} renderers={p.renderers} />
      {quote && (
        <div className="un-pw-quote">
          <ActionButton action={quote} onAction={p.intents.action} icon={<Icon name="quote" />} />
        </div>
      )}
    </div>
  );
}
function Materials({ items, props: p }: { items: readonly Material[]; props: WorkspaceProps }) {
  return (
    <>
      {items.map((m) => (
        <section key={m.id} className="un-pw-material">
          <h3>{m.title}</h3>
          {m.state.kind === 'ready' ? (
            <Reading content={m.state.content} props={p} />
          ) : (
            <NoticeView notice={m.state.notice} onAction={p.intents.action} />
          )}
        </section>
      ))}
    </>
  );
}
export function ReadingWorkspace({ props: p }: { props: WorkspaceProps }) {
  const page = p.view.page;
  if ('notice' in page)
    return (
      <section
        ref={p.lifecycle?.issuancePlaceholderRef}
        tabIndex={-1}
        className="un-pw-page-state"
        aria-busy={page.kind === 'loading' || page.kind === 'recovering'}
      >
        <h1 ref={p.lifecycle?.titleRef} tabIndex={-1}>
          {page.notice.title}
        </h1>
        <NoticeView notice={{ ...page.notice, title: '' }} onAction={p.intents.action} />
      </section>
    );
  const q = page.question;
  return (
    <article className="un-pw-question" data-identity={p.view.identity}>
      <header>
        <p className="un-pw-eyebrow">
          {q.subject} · {q.progressLabel}
        </p>
        <h1 ref={p.lifecycle?.titleRef} tabIndex={-1}>
          {q.title}
        </h1>
        <p className="un-pw-meta">
          {[q.attemptLabel, q.estimatedTime, q.source, q.reason].filter(Boolean).join(' · ')}
        </p>
      </header>
      {page.missing && <NoticeView notice={page.missing} onAction={p.intents.action} strong />}
      <div ref={p.lifecycle?.quotableRef}>
        <div ref={p.lifecycle?.answeringRootRef} tabIndex={-1}>
          {p.surfaces?.questionBody ?? (
            <>
              <Materials items={q.materials} props={p} />
              <Reading content={q.stem} props={p} />
              {q.fields.length > 0 && (
                <section className="un-pw-answer">
                  <h2>你的作答</h2>
                  {q.fields.map((f) => (
                    <AnswerControl
                      key={f.id}
                      field={f}
                      intents={p.intents}
                      renderers={p.renderers}
                    />
                  ))}
                </section>
              )}
              {q.parts.map((part) => (
                <section key={part.id} className="un-pw-question-part" aria-label={part.label}>
                  <h2>{part.label}</h2>
                  <Materials items={part.materials} props={p} />
                  <Reading content={part.stem} props={p} />
                  <div className="un-pw-answer">
                    {part.fields.map((f) => (
                      <AnswerControl
                        key={f.id}
                        field={f}
                        intents={p.intents}
                        renderers={p.renderers}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </>
          )}
        </div>
      </div>
      {p.presentation.selection && (
        <aside className="un-pw-selection" aria-label="选中内容">
          <p>{p.presentation.selection.label}</p>
          <ContentView content={p.presentation.selection.preview} renderers={p.renderers} />
          <ActionButton
            action={p.presentation.selection.action}
            onAction={p.intents.action}
            icon={<Icon name="quote" />}
          />
        </aside>
      )}
      {p.surfaces?.selectionActions}
      {q.thought && (
        <details className="un-pw-thought">
          <summary>记录解题思路（可选）</summary>
          <AnswerControl field={q.thought} intents={p.intents} renderers={p.renderers} />
        </details>
      )}
      <Actions items={q.supportActions} onAction={p.intents.action} />
      <div className="un-pw-draft" data-state={q.draft.kind}>
        {q.draft.kind === 'conflict' ? (
          <>
            <NoticeView notice={q.draft.notice} onAction={p.intents.action} strong />
            {p.surfaces?.conflict ?? (
              <div className="un-pw-conflict">
                <section>
                  <h3>本地作答</h3>
                  <ContentView content={q.draft.local} renderers={p.renderers} />
                </section>
                <section>
                  <h3>远端作答</h3>
                  <ContentView content={q.draft.remote} renderers={p.renderers} />
                </section>
              </div>
            )}
          </>
        ) : (
          q.draft.kind !== 'empty' && (
            <NoticeView
              notice={q.draft.notice}
              onAction={p.intents.action}
              strong={q.draft.kind === 'failed' || q.draft.kind === 'offline'}
            />
          )
        )}
      </div>
      <section aria-label="保存与判分状态">
        {q.submission.recording.notice ? (
          <NoticeView notice={q.submission.recording.notice} onAction={p.intents.action} />
        ) : (
          q.submission.recording.kind !== 'idle' && (
            <p>
              {
                {
                  saving: '正在保存作答',
                  saved: '作答已保存',
                  unknown: '尚不能确认作答是否保存',
                  failed: '作答保存失败',
                }[q.submission.recording.kind]
              }
            </p>
          )
        )}
        {q.submission.grading.notice ? (
          <NoticeView notice={q.submission.grading.notice} onAction={p.intents.action} />
        ) : (
          q.submission.grading.kind !== 'idle' && (
            <p>
              {
                {
                  pending: '等待判分',
                  grading: '正在判分',
                  unknown: '判分结果尚未确定',
                  failed: '判分失败',
                  settled: '判分完成',
                  manual: '这道题需要自行评级',
                }[q.submission.grading.kind]
              }
            </p>
          )
        )}
      </section>
      <ResultWorkspace question={q} props={p} />
      {q.submission.continuation && (
        <NoticeView notice={q.submission.continuation.notice} onAction={p.intents.action} />
      )}
      <div className="un-pw-submit" ref={p.lifecycle?.submitActionsRef}>
        <div>
          {q.submission.primary && (
            <ActionButton primary action={q.submission.primary} onAction={p.intents.action} />
          )}
        </div>
        <Actions items={q.submission.secondary} onAction={p.intents.action} />
      </div>
    </article>
  );
}
