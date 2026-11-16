import { useRef, useState } from 'react';
import type { Companion, WorkspaceProps } from './contracts';
import { Actions, ActionButton, ContentView, Icon, IconButton, NoticeView } from './controls';
const delivery = {
  queued: '排队中',
  sending: '发送中',
  'acceptance-unknown': '是否已接收尚不确定',
  accepted: '已接收',
  committed: '已保存',
};
const states = {
  waiting: '等待回复',
  streaming: '生成中，尚未保存',
  committed: '已保存',
  unknown: '回复状态尚不确定',
  partial: '回复不完整',
  refused: '无法回答',
  failed: '回复失败',
  cancelled: '已取消',
};
function Stop({ stop, props: p }: { stop: NonNullable<Companion['stop']>; props: WorkspaceProps }) {
  return (
    <section className="un-pw-stop">
      <NoticeView notice={stop.notice} onAction={p.intents.action} />
      {stop.consequence && <p>{stop.consequence}</p>}
      {stop.canStop && stop.action && (
        <ActionButton action={stop.action} onAction={p.intents.action} />
      )}
    </section>
  );
}
export function CompanionWorkspace({ props: p, close }: { props: WorkspaceProps; close(): void }) {
  const c = p.view.companion;
  const [history, setHistory] = useState(false);
  const historyTrigger = useRef<HTMLButtonElement>(null);
  const composing = useRef(false);
  const canSend =
    c.editable &&
    c.send.availability.kind === 'enabled' &&
    !['acceptance-unknown', 'reading-back', 'sending', 'queued'].includes(c.sending.kind);
  return (
    <aside
      className="un-pw-companion"
      aria-label="学习伙伴"
      onKeyDown={(e) => {
        if (
          e.key === 'Escape' &&
          history &&
          !p.presentation.externalModalOpen &&
          !p.view.blocking
        ) {
          e.preventDefault();
          e.stopPropagation();
          setHistory(false);
          historyTrigger.current?.focus();
        }
      }}
    >
      <header className="un-pw-partner-heading">
        <Icon name="partner" />
        <div>
          <h2 ref={p.lifecycle?.companionTitleRef} tabIndex={-1}>
            学习伙伴
          </h2>
          <p>围绕当前题目一起思考</p>
        </div>
        <IconButton label="收起学习伙伴" onClick={close}>
          <Icon name="close" />
        </IconButton>
      </header>
      <div className="un-pw-partner-tools">
        <button
          type="button"
          ref={historyTrigger}
          className="un-pw-action"
          aria-expanded={history}
          onClick={() => setHistory(!history)}
        >
          <Icon name="history" />
          会话历史
        </button>
        {c.newSession && <ActionButton action={c.newSession} onAction={p.intents.action} />}
      </div>
      {history && (
        <section className="un-pw-history" aria-label="会话历史">
          <h3>会话历史</h3>
          {p.surfaces?.history ??
            (c.sessions.kind === 'ready' ? (
              <ul className="un-pw-list">
                {c.sessions.items.map((s) => (
                  <li key={s.id} aria-current={s.current ? 'true' : undefined}>
                    <span>{s.title}</span>
                    <ActionButton action={s.action} onAction={p.intents.action} />
                  </li>
                ))}
              </ul>
            ) : (
              <NoticeView notice={c.sessions.notice} onAction={p.intents.action} />
            ))}
          <button
            type="button"
            className="un-pw-action"
            onClick={() => {
              setHistory(false);
              historyTrigger.current?.focus();
            }}
          >
            返回对话
          </button>
        </section>
      )}
      <details className="un-pw-summary">
        <summary>当前学习摘要</summary>
        {c.summary.kind === 'ready' ? (
          <ContentView content={c.summary.content} renderers={p.renderers} />
        ) : (
          <NoticeView notice={c.summary.notice} onAction={p.intents.action} />
        )}
      </details>
      {c.connection.kind !== 'connected' && (
        <NoticeView notice={c.connection.notice} onAction={p.intents.action} strong />
      )}
      <section className="un-pw-messages" aria-label="对话消息">
        {c.messages.length === 0 ? (
          <div className="un-pw-conversation-empty">
            <Icon name="partner" />
            <h3>从一个具体问题开始</h3>
            <p>引用题干或材料，或写下你卡住的地方。</p>
          </div>
        ) : (
          c.messages.map((m) => (
            <article key={m.id} className="un-pw-message" data-author={m.author}>
              <h3>{m.author === 'user' ? '你' : '学习伙伴'}</h3>
              {m.body && <ContentView content={m.body} renderers={p.renderers} />}
              <p className="un-pw-meta">
                {[delivery[m.delivery], states[m.state]]
                  .filter((x, i, a) => a.indexOf(x) === i)
                  .join(' · ')}
              </p>
              {m.detail && <p>{m.detail}</p>}
              {m.structures.map((s) => (
                <section key={s.id} className="un-pw-structure">
                  {p.renderers.structured(s.content, s.kind)}
                  <Actions items={s.actions} onAction={p.intents.action} />
                </section>
              ))}
              {m.sources.length > 0 && (
                <details>
                  <summary>来源与引用</summary>
                  {m.sources.map((s) => (
                    <ContentView key={s.id} content={s} renderers={p.renderers} />
                  ))}
                </details>
              )}
              <Actions items={m.actions} onAction={p.intents.action} />
            </article>
          ))
        )}
      </section>
      {(c.teachingActions.length > 0 || c.suggestionActions.length > 0) && (
        <details>
          <summary>教学方式与建议</summary>
          <Actions items={c.teachingActions} onAction={p.intents.action} />
          <Actions items={c.suggestionActions} onAction={p.intents.action} />
        </details>
      )}
      <div className="un-pw-composer">
        <div className="un-pw-contexts">
          {c.contexts.map((x) => (
            <div key={x.id} className="un-pw-context">
              <details>
                <summary>
                  <Icon name="quote" />
                  {x.label}
                </summary>
                <ContentView content={x.content} renderers={p.renderers} />
              </details>
              <ActionButton action={x.remove} onAction={p.intents.action} />
            </div>
          ))}
        </div>
        <fieldset className="un-pw-purpose">
          <legend>本轮用途</legend>
          {(['learning', 'this-answer'] as const).map((v) => {
            const a = c.purpose.options[v];
            return (
              <label key={v}>
                <input
                  type="radio"
                  name="un-pw-purpose"
                  checked={c.purpose.value === v}
                  disabled={a.kind !== 'enabled' || c.purpose.state === 'validating'}
                  onChange={() => p.intents.companionPurpose(v)}
                />
                {v === 'learning' ? '日常学习' : '仅本次回答'}
                {a.kind !== 'enabled' && <small>{a.reason}</small>}
              </label>
            );
          })}
          {c.purpose.reason && <p>{c.purpose.reason}</p>}
        </fieldset>
        <label className="un-pw-composer-label">
          发给学习伙伴
          <textarea
            rows={4}
            value={c.draft}
            readOnly={!c.editable}
            aria-describedby="un-pw-composer-help"
            onChange={(e) => p.intents.companionDraft(e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                !composing.current &&
                e.nativeEvent.keyCode !== 229
              ) {
                e.preventDefault();
                if (canSend && !e.repeat) p.intents.action(c.send.id);
              }
            }}
          />
        </label>
        <p id="un-pw-composer-help" className="un-pw-meta">
          {c.draftReason ?? 'Enter 发送 · Shift+Enter 换行'}
        </p>
        {c.sending.notice && <NoticeView notice={c.sending.notice} onAction={p.intents.action} />}
        <div className="un-pw-send">
          <ActionButton
            primary
            icon={<Icon name="send" />}
            action={
              canSend
                ? c.send
                : {
                    ...c.send,
                    availability:
                      c.send.availability.kind === 'enabled'
                        ? {
                            kind: 'disabled',
                            reason: c.draftReason ?? '当前暂不能发送，请等待状态确认',
                          }
                        : c.send.availability,
                  }
            }
            onAction={p.intents.action}
          />
        </div>
      </div>
      {c.stop && <Stop stop={c.stop} props={p} />}
      {p.presentation.runs?.map((run) => (
        <section key={run.id}>
          <h3>{run.label}</h3>
          <Stop stop={run.stop} props={p} />
        </section>
      ))}
    </aside>
  );
}
