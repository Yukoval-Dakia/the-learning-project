'use client';

// /record — one panel that shows the ingestion agent's progress AND its
// follow-up questions, answered in place (owner: 「录入要快，进度看得见，并和录入后的
// Copilot 问询在同一个界面」; ADR-0074 D5).
//
// Input is the plain SSE snapshot (useIngestionSSE or the loft replay); all
// state worth keeping lives in the event stream. Local state is only the
// learner's unsent drafts and "answer posted, waiting for the server echo".

import { type FormEvent, useState } from 'react';
import {
  AGENT_STAGES,
  type AgentAsk,
  type AgentItem,
  type AgentView,
  type AskAnswer,
  ITEM_STATUS_LABEL,
  STAGE_LABEL,
  errorCopy,
  foldAgentEvents,
  holdReasonCopy,
} from '@/ui/lib/ingestion-agent-events';
import type { UseIngestionSSEResult } from '@/ui/lib/sse';
import { Button } from '@/ui/primitives/Button';
import './ingest-agent-panel.css';

export interface IngestAgentPanelProps {
  stream: UseIngestionSSEResult;
  /** Posts one answer. Resolves when the server accepted it (the echo comes over SSE). */
  onAnswer: (askId: string, answer: AskAnswer) => Promise<void>;
  onRetryItem?: (itemId: string) => void;
  onRetrySession?: () => void;
}

const NONE_OF_THESE = '__none_of_these__';

function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function IngestAgentPanel({
  stream,
  onAnswer,
  onRetryItem,
  onRetrySession,
}: IngestAgentPanelProps) {
  const view = foldAgentEvents(stream.events);
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(null);
  const [retrying, setRetrying] = useState<Record<string, true>>({});

  const openAskByItem = new Map<string, AgentAsk>();
  for (const a of view.asks) if (!a.answer && a.item_id) openAskByItem.set(a.item_id, a);
  const openAsks = view.asks.filter((a) => !a.answer).length;

  const jumpTo = (domId: string) => {
    const el = document.getElementById(domId);
    if (!el) return;
    el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    el.focus({ preventScroll: true });
    setFlash((cur) => ({ id: domId, n: (cur?.n ?? 0) + 1 }));
  };
  const flashClass = (domId: string) =>
    flash?.id === domId ? (flash.n % 2 ? ' is-flash-a' : ' is-flash-b') : '';

  const retryItem = (id: string) => {
    setRetrying((cur) => ({ ...cur, [id]: true }));
    onRetryItem?.(id);
  };

  const pages = groupByPage(view.items);

  return (
    <section className="ia" aria-label="录入进度">
      <Headline view={view} openAsks={openAsks} connecting={stream.status === 'connecting'} />
      <StageRail stage={view.stage} />
      <Tally view={view} openAsks={openAsks} />

      {view.sessionError && (
        <div className="ia-session-error" role="alert">
          <span>{errorCopy(view.sessionError.code, 'session')}。已经收好的题不会丢。</span>
          {view.sessionError.retryable && onRetrySession && (
            <Button size="sm" variant="secondary" onClick={onRetrySession}>
              接着录
            </Button>
          )}
        </div>
      )}

      {view.asks.length > 0 && (
        <section className="ia-asks" aria-label="录入助手的问题">
          <h3 className="ia-section-title">
            录入助手想确认
            {openAsks > 0 ? (
              <span className="ia-section-count">还差 {openAsks} 个</span>
            ) : (
              <span className="ia-section-count is-done">都答完了</span>
            )}
          </h3>
          {view.asks.map((a) => (
            <div key={a.ask_id} className="ia-ask-wrap">
              <AskCard
                ask={a}
                flashClass={flashClass(`ia-ask-${a.ask_id}`)}
                onAnswer={onAnswer}
                onJumpToItem={a.item_id ? () => jumpTo(`ia-item-${a.item_id}`) : undefined}
              />
            </div>
          ))}
        </section>
      )}

      {pages.length > 0 && (
        <section className="ia-items" aria-label="逐题进度">
          {pages.map(([page, items]) => (
            <div key={page ?? 'none'} className="ia-page">
              <h4 className="ia-page-title">
                {page === null ? '未定页' : `第 ${page} 页`}
                <span className="ia-page-count">{items.length} 题</span>
              </h4>
              <ul className="ia-rows">
                {items.map((it) => (
                  <ItemRow
                    key={it.item_id}
                    item={it}
                    ask={openAskByItem.get(it.item_id)}
                    flashClass={flashClass(`ia-item-${it.item_id}`)}
                    retrying={retrying[it.item_id] === true && it.status === 'failed'}
                    onRetry={onRetryItem ? () => retryItem(it.item_id) : undefined}
                    onJumpToAsk={(askId) => jumpTo(`ia-ask-${askId}`)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </section>
  );
}

// ── headline ────────────────────────────────────────────────────────────────

function Headline({
  view,
  openAsks,
  connecting,
}: {
  view: AgentView;
  openAsks: number;
  connecting: boolean;
}) {
  const { stage, pages, counts } = view;
  let now: string;
  if (!stage) now = connecting ? '正在连接…' : '等待开始…';
  else if (stage === 'reading')
    now =
      pages && pages.done < pages.total
        ? `正在读第 ${pages.done + 1} 页，共 ${pages.total} 页`
        : '页面都读完了';
  else if (stage === 'segmenting') now = `正在找题目，已找到 ${counts.items_total} 题`;
  else if (stage === 'done') now = openAsks > 0 ? `录完了，还有 ${openAsks} 个问题等你` : '录完了';
  else now = `正在${STAGE_LABEL[stage]}`;

  const sub: string[] = [];
  if (stage && stage !== 'done') {
    sub.push(`第 ${AGENT_STAGES.indexOf(stage) + 1}/${AGENT_STAGES.length} 步`);
  }
  if (pages) sub.push(`已读 ${pages.done}/${pages.total} 页`);
  if (counts.items_total > 0) sub.push(`找到 ${counts.items_total} 题`);

  return (
    <header className="ia-head">
      <p className="ia-now" aria-live="polite">
        {now}
      </p>
      {sub.length > 0 && <p className="ia-sub">{sub.join(' · ')}</p>}
    </header>
  );
}

function StageRail({ stage }: { stage: AgentView['stage'] }) {
  const idx = stage === 'done' ? AGENT_STAGES.length : stage ? AGENT_STAGES.indexOf(stage) : -1;
  return (
    <ol className="ia-stages" aria-label="阶段">
      {AGENT_STAGES.map((s, i) => {
        const state = i < idx ? 'done' : i === idx ? 'now' : 'next';
        return (
          <li
            key={s}
            className={`ia-stage is-${state}`}
            aria-current={state === 'now' ? 'step' : undefined}
          >
            <span className="ia-stage-bar" />
            <span className="ia-stage-label">{STAGE_LABEL[s]}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Tally({ view, openAsks }: { view: AgentView; openAsks: number }) {
  const c = view.counts;
  if (c.items_total === 0) return null;
  const inFlight = Math.max(
    0,
    c.items_total - c.items_done - c.items_withheld - c.items_failed - openAsks,
  );
  const cells: { label: string; value: number; tone: string }[] = [
    { label: '已收好', value: c.items_done, tone: 'good' },
    { label: '处理中', value: inFlight, tone: 'neutral' },
    { label: '等你回答', value: openAsks, tone: 'coral' },
    { label: '暂不出题', value: c.items_withheld, tone: 'hard' },
    { label: '出错', value: c.items_failed, tone: 'again' },
  ];
  return (
    <dl className="ia-tally">
      {cells.map((cell) => (
        <div
          key={cell.label}
          className={`ia-tally-cell tone-${cell.tone}${cell.value === 0 ? ' is-zero' : ''}`}
        >
          <dt>{cell.label}</dt>
          <dd>
            <span key={cell.value} className="ia-num">
              {cell.value}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── item rows ───────────────────────────────────────────────────────────────

function groupByPage(items: AgentItem[]): [number | null, AgentItem[]][] {
  const map = new Map<number | null, AgentItem[]>();
  for (const it of items) {
    const list = map.get(it.page);
    if (list) list.push(it);
    else map.set(it.page, [it]);
  }
  return [...map.entries()].sort(([a], [b]) => (a ?? 1e9) - (b ?? 1e9));
}

function ItemRow({
  item,
  ask,
  flashClass,
  retrying,
  onRetry,
  onJumpToAsk,
}: {
  item: AgentItem;
  ask: AgentAsk | undefined;
  flashClass: string;
  retrying: boolean;
  onRetry?: () => void;
  onJumpToAsk: (askId: string) => void;
}) {
  const tone = ask ? 'ask' : item.status;
  const label = ask ? '等你回答' : ITEM_STATUS_LABEL[item.status];
  return (
    <li className="ia-row-wrap">
      <div
        id={`ia-item-${item.item_id}`}
        tabIndex={-1}
        className={`ia-row is-${tone}${flashClass}`}
      >
        <span className="ia-no">{item.question_no ?? '—'}</span>
        <span className="ia-preview">
          {item.preview ?? (item.question_no ? `第 ${item.question_no} 题` : '未编号的题')}
        </span>
        <span className="ia-status">
          <span className="ia-dot" aria-hidden="true" />
          {label}
        </span>
        {ask && (
          <div className="ia-row-note">
            <button type="button" className="ia-link" onClick={() => onJumpToAsk(ask.ask_id)}>
              录入助手有个问题，去回答
            </button>
          </div>
        )}
        {!ask && item.status === 'withheld' && (
          <p className="ia-row-note">{holdReasonCopy(item.reason)}</p>
        )}
        {!ask && item.status === 'failed' && (
          <div className="ia-row-note">
            <span>{item.error ? errorCopy(item.error.code, 'item') : '这道题处理时出错了'}</span>
            {item.error?.retryable && onRetry && (
              <button type="button" className="ia-link" onClick={onRetry} disabled={retrying}>
                {retrying ? '已重新提交' : '再试一次'}
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

// ── follow-up asks ──────────────────────────────────────────────────────────

function answerLabel(ask: AgentAsk, answer: AskAnswer): string {
  if (answer.kind === 'choice') {
    return ask.options.find((o) => o.id === answer.option_id)?.label_md ?? '已选择';
  }
  return answer.text;
}

function AskCard({
  ask,
  flashClass,
  onAnswer,
  onJumpToItem,
}: {
  ask: AgentAsk;
  flashClass: string;
  onAnswer: (askId: string, answer: AskAnswer) => Promise<void>;
  onJumpToItem?: () => void;
}) {
  const [choice, setChoice] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sent, setSent] = useState<AskAnswer | null>(null);
  const [failed, setFailed] = useState(false);

  const domId = `ia-ask-${ask.ask_id}`;
  const shown = ask.answer ?? sent;
  const needsText = ask.kind === 'short' || choice === NONE_OF_THESE;
  const ready =
    ask.kind === 'choice'
      ? choice !== null && (!needsText || text.trim() !== '')
      : text.trim() !== '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || sent) return;
    const answer: AskAnswer =
      ask.kind === 'choice' && choice && choice !== NONE_OF_THESE
        ? { kind: 'choice', option_id: choice }
        : ask.kind === 'choice'
          ? { kind: 'text', text: text.trim(), via_option: 'none_of_these' }
          : { kind: 'text', text: text.trim() };
    setSent(answer);
    setFailed(false);
    onAnswer(ask.ask_id, answer).catch(() => {
      setSent(null);
      setFailed(true);
    });
  };

  const ref = (
    <span className="ia-ask-ref">
      {onJumpToItem && ask.question_no ? (
        <button type="button" className="ia-link" onClick={onJumpToItem}>
          第 {ask.question_no} 题
        </button>
      ) : ask.question_no ? (
        `第 ${ask.question_no} 题`
      ) : (
        '整份材料'
      )}
    </span>
  );

  if (shown) {
    const confirmed = ask.answer !== null;
    return (
      <article
        id={domId}
        tabIndex={-1}
        className={`ia-ask is-${confirmed ? 'resolved' : 'sending'}${flashClass}`}
      >
        <header className="ia-ask-head">
          {ref}
          <span className="ia-ask-state">{confirmed ? '已回答' : '已提交，正在记下'}</span>
        </header>
        <p className="ia-ask-prompt is-quiet">{ask.prompt_md}</p>
        <p className="ia-ask-answer">
          <span className="ia-ask-answer-mark" aria-hidden="true">
            {confirmed ? '✓' : '…'}
          </span>
          <span>{answerLabel(ask, shown)}</span>
        </p>
      </article>
    );
  }

  const nameId = `${domId}-opt`;
  return (
    <article id={domId} tabIndex={-1} className={`ia-ask is-open${flashClass}`}>
      <header className="ia-ask-head">
        {ref}
        <span className="ia-ask-state">{ask.kind === 'choice' ? '选一个' : '一句话就好'}</span>
      </header>
      <form onSubmit={submit} className="ia-ask-form">
        <fieldset className="ia-fieldset">
          <legend className="ia-ask-prompt">{ask.prompt_md}</legend>
          {ask.kind === 'choice' && (
            <div className="ia-opts">
              {[...ask.options, { id: NONE_OF_THESE, label_md: '都不是，我来说' }].map((o) => (
                <label
                  key={o.id}
                  className={`ia-opt${choice === o.id ? ' is-on' : ''}${o.id === NONE_OF_THESE ? ' is-other' : ''}`}
                >
                  <input
                    type="radio"
                    name={nameId}
                    value={o.id}
                    checked={choice === o.id}
                    onChange={() => setChoice(o.id)}
                  />
                  <span>{o.label_md}</span>
                </label>
              ))}
            </div>
          )}
          {needsText && (
            <input
              className="ia-input"
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                ask.kind === 'short' ? (ask.placeholder ?? '写一句就好') : '说说它属于哪里'
              }
              aria-label={ask.kind === 'short' ? ask.prompt_md : '你的说法'}
              // biome-ignore lint/a11y/noAutofocus: only after the learner picks "都不是"; it is the next step
              autoFocus={ask.kind === 'choice'}
              enterKeyHint="send"
            />
          )}
        </fieldset>
        <div className="ia-ask-actions">
          {failed && <span className="ia-ask-fail">没有发出去，再试一次</span>}
          <Button size="sm" type="submit" disabled={!ready}>
            确定
          </Button>
        </div>
      </form>
    </article>
  );
}
