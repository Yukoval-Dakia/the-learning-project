import { ArrowRight, Check, RotateCcw } from 'lucide-react';
import { useId } from 'react';
import { Button, Mascot, Segmented } from '@/ui-next/public';
import './queue.css';

export function PracticeListHeader(p: {
  scopeLabel: string | null;
  view: 'stream' | 'shelf';
  onView(view: 'stream' | 'shelf'): void;
  onClearScope(): void;
}) {
  return (
    <header className="un-pq-heading">
      <div>
        <h1>{p.scopeLabel === null ? '练习' : '针对性练习'}</h1>
        <p>{p.scopeLabel ?? '从这一题开始，按自己的节奏继续。'}</p>
        {p.scopeLabel !== null ? (
          <Button variant="ghost" type="button" onClick={p.onClearScope}>
            返回今日练习
          </Button>
        ) : (
          <Segmented
            label="练习视图"
            value={p.view}
            options={[
              { value: 'stream', label: '今日练习' },
              { value: 'shelf', label: '练习卷' },
            ]}
            onChange={p.onView}
          />
        )}
      </div>
      <Mascot />
    </header>
  );
}

export interface QueueRow {
  id: string;
  morphKey: string;
  title: string;
  source: string;
  kind: string;
  reason: string;
  facts: string | null;
  note: string | null;
  current: boolean;
  completed: boolean;
  completion: string | null;
  verdict: string | null;
  action: { label: string; run(): void } | null;
  skip: (() => void) | null;
}

function QueueItem({ row: r }: { row: QueueRow }) {
  return (
    <li className="un-pq-item" data-current={r.current || undefined} data-morph-row="">
      <div className="un-pq-item-content">
        <p className="un-pq-meta">
          {r.completed ? <Check size={16} aria-hidden="true" /> : null}
          {r.source} · {r.kind}
          {r.current ? ' · 接着做' : ''}
        </p>
        <h3 data-morph={r.morphKey}>{r.title}</h3>
        {!r.completed && <p>{r.reason}</p>}
        {r.facts && !r.completed && <p className="un-pq-meta">{r.facts}</p>}
        {r.note && !r.completed && <p className="un-pq-meta">{r.note}</p>}
        {r.completed && (
          <p className="un-pq-meta">{[r.verdict, r.completion].filter(Boolean).join(' · ')}</p>
        )}
      </div>
      {r.action && (
        <div className="un-pq-item-actions">
          <Button type="button" variant={r.current ? 'primary' : 'ghost'} onClick={r.action.run}>
            {r.action.label}
            <ArrowRight size={18} aria-hidden="true" />
          </Button>
          {r.skip && (
            <Button type="button" variant="ghost" onClick={r.skip}>
              稍后再做
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

export function PracticeQueue(p: {
  opening: string;
  context: string;
  done: number;
  total: number;
  remaining: string;
  active: QueueRow[];
  skipped: QueueRow[];
  emptyTitle: string;
  emptyText: string;
  closing: string | null;
  recompose: { busy: boolean; run(): void } | null;
  demand: { value: string; change(value: string): void; handoff(): void } | null;
}) {
  const demandId = useId();
  return (
    <div className="un-pq-body">
      <section className="un-pq-summary" aria-label="本轮练习进度">
        <div>
          <p>{p.opening}</p>
          <p className="un-pq-meta">{p.context}</p>
        </div>
        {p.total > 0 && (
          <div className="un-pq-progress">
            <span>
              已完成 <strong>{p.done}</strong> / {p.total}
            </span>
            <progress aria-label="本轮已完成" value={p.done} max={p.total} />
            <span className="un-pq-meta">{p.remaining}</span>
          </div>
        )}
      </section>
      {p.active.length === 0 && p.skipped.length === 0 ? (
        <section className="un-pq-state">
          <h2>{p.emptyTitle}</h2>
          <p>{p.emptyText}</p>
        </section>
      ) : (
        <section aria-label="练习队列">
          <ol className="un-pq-list">
            {p.active.map((row) => (
              <QueueItem key={row.id} row={row} />
            ))}
          </ol>
        </section>
      )}
      {p.skipped.length > 0 && (
        <section>
          <h2>
            稍后再做 <span className="un-pq-meta">{p.skipped.length} 项</span>
          </h2>
          <ol className="un-pq-list">
            {p.skipped.map((row) => (
              <QueueItem key={row.id} row={row} />
            ))}
          </ol>
        </section>
      )}
      {p.closing && (
        <p className="un-pq-state" role="status">
          {p.closing}
        </p>
      )}
      {p.recompose && (
        <Button
          type="button"
          variant="ghost"
          disabled={p.recompose.busy}
          aria-busy={p.recompose.busy || undefined}
          onClick={p.recompose.run}
        >
          <RotateCcw size={18} aria-hidden="true" />
          {p.recompose.busy ? '重排中…' : '按当前信号重排'}
        </Button>
      )}
      {p.demand && (
        <section className="un-pq-demand">
          <h2>想加练什么？</h2>
          <label htmlFor={demandId}>把想练的内容交给学习伙伴</label>
          <textarea
            id={demandId}
            rows={2}
            value={p.demand.value}
            placeholder="例如：判断句专项练习"
            onChange={(e) => p.demand?.change(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                p.demand?.handoff();
              }
            }}
          />
          <div className="un-pq-demand-footer">
            <p>先填入伙伴输入框，由你确认发送。</p>
            <Button type="button" variant="ghost" onClick={p.demand.handoff}>
              交给学习伙伴
              <ArrowRight size={18} aria-hidden="true" />
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

export function PracticeQueueState({ error }: { error?: string }) {
  return (
    <div className="un-pq-state" role={error ? 'alert' : 'status'}>
      <h2>{error ? '练习暂时无法读取' : '正在准备练习'}</h2>
      <p>{error ?? '正在读取当前队列和作答进度…'}</p>
    </div>
  );
}
