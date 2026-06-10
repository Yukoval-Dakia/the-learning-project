// M2 练习面 — 流视图（YUK-316）。
// 设计基准 docs/design/loom-refresh/project/pface-stream.jsx：§6.1 织线纵轨——
// item 挂在线上、AI 开场白与第一人称理由陪练递题、已完成项收紧成织入的一行；
// 跳过的留流尾可捡回；流尾点播 composer。点播生成（quiz-gen 异步链）M2 后端
// 未接——composer 提交后 toast 告知（占位，M4 夜链/quiz 域接上后变真）。

import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { IconBtn } from '@/ui/primitives/IconBtn';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useState } from 'react';

import type { PfToast } from './PracticeFacePage';
import {
  type StreamItem,
  type StreamSource,
  type StreamView,
  advanceStreamItem,
  recomposeStream,
} from './practice-api';

const SRC_META: Record<StreamSource, { label: string; tone: string; icon: string }> = {
  decay: { label: '衰减复习', tone: 'info', icon: 'history' },
  variant: { label: '错题变式', tone: 'again', icon: 'mistakes' },
  new_check: { label: '新学自测', tone: 'good', icon: 'spark2' },
  paper: { label: '打包卷', tone: 'coral', icon: 'layers' },
  on_demand: { label: '点播', tone: 'neutral', icon: 'send' },
  import: { label: '导入', tone: 'neutral', icon: 'record' },
};

export function PfSrcBadge({ source }: { source: StreamSource }) {
  const s = SRC_META[source];
  return (
    <span className={`badge tone-${s.tone}`}>
      <LoomIcon name={s.icon as never} size={12} />
      {s.label}
    </span>
  );
}

export function PfStream({
  stream,
  loading,
  error,
  openItem,
  refresh,
  addToast,
}: {
  stream: StreamView | null;
  loading: boolean;
  error: Error | null;
  openItem: (item: StreamItem) => void;
  refresh: () => void;
  addToast: (text: string, tone?: PfToast['tone'], icon?: string) => void;
}) {
  const [demand, setDemand] = useState('');
  const [recomposing, setRecomposing] = useState(false);

  if (loading) return <p className="quiet-empty">正在编排今天的流…</p>;
  if (error) return <p className="quiet-empty">流加载失败：{error.message}</p>;
  if (!stream) return null;

  const items = stream.items;
  const active = items.filter((it) => it.status !== 'skipped');
  const skipped = items.filter((it) => it.status === 'skipped');
  const pending = items.filter((it) => it.status === 'pending');
  // current = 正在做的那项优先（中途退出回来还在原位），否则第一个待做。
  const currentItem = items.find((it) => it.status === 'in_progress') ?? pending[0] ?? null;
  const allDone = items.length > 0 && stream.progress.done === items.length;
  const etaMin = pending.reduce((m, it) => m + (it.item_kind === 'paper' ? 10 : 2), 0);

  const skip = async (it: StreamItem) => {
    await advanceStreamItem(it.id, 'skipped').catch(() => {});
    refresh();
  };
  const unskip = async (it: StreamItem) => {
    await advanceStreamItem(it.id, 'pending').catch(() => {});
    refresh();
  };
  const recompose = async () => {
    setRecomposing(true);
    try {
      const r = await recomposeStream();
      addToast(r.added > 0 ? `我重排了今天的流——新进 ${r.added} 项。` : '看过一轮，没有要补的。');
      refresh();
    } catch (e) {
      addToast(`重排失败：${(e as Error).message}`, 'info', 'alert');
    } finally {
      setRecomposing(false);
    }
  };

  const row = (it: StreamItem) => {
    const isCur = currentItem?.id === it.id;
    const cls = [
      'pf-row',
      `kind-${it.item_kind === 'paper' ? 'paper' : 'question'}`,
      it.status === 'done'
        ? 'is-done'
        : it.status === 'skipped'
          ? 'is-skipped'
          : isCur
            ? 'is-current'
            : 'is-pending',
    ].join(' ');

    if (it.status === 'done') {
      return (
        <div key={it.id} className={cls}>
          <span className="pf-node" />
          <div className="pf-done">
            <PfSrcBadge source={it.source} />
            <span className="pf-done-kp">{it.reasoning}</span>
            <span className="pf-done-at">已完成</span>
          </div>
        </div>
      );
    }

    const isSkipped = it.status === 'skipped';
    const inner = (
      <div
        className="pf-item"
        // biome-ignore lint/a11y/useSemanticElements: 行卡片内嵌套了真按钮
        // （CTA + 跳过），native <button> 不允许嵌套交互元素；div+role 是
        // 可聚焦容器的正确 ARIA 形态。
        role="button"
        tabIndex={0}
        onClick={() => openItem(it)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') openItem(it);
        }}
      >
        <div className="pf-item-top">
          <PfSrcBadge source={it.source} />
          <span className="pf-item-kind mono">
            <span className="src-q">
              {it.item_kind} · {it.ref_id.slice(0, 12)}
            </span>
          </span>
        </div>
        {it.item_kind === 'paper' && (
          <span className="pf-paper-note">
            <LoomIcon name="clock" size={12} />
            交卷后统一判分 · 卷内无即时反馈
          </span>
        )}
        <div className="pf-reason">
          <LoomIcon name="sparkle" size={13} className="ico" />
          <span>{it.reasoning}</span>
        </div>
        <div className="pf-item-cta">
          <Btn
            size="sm"
            variant={
              isCur
                ? 'primary'
                : isSkipped
                  ? 'ghost'
                  : it.item_kind === 'paper'
                    ? 'secondary'
                    : 'ghost'
            }
            icon={isSkipped ? 'undo' : it.item_kind === 'paper' ? 'layers' : 'pencil'}
            onClick={(e) => {
              e.stopPropagation();
              if (isSkipped) void unskip(it);
              else openItem(it);
            }}
          >
            {isSkipped ? '捡回来' : it.item_kind === 'paper' ? '进入卷' : '开始作答'}
          </Btn>
          {!isSkipped && it.status === 'pending' && (
            <button
              type="button"
              className="pf-skip"
              onClick={(e) => {
                e.stopPropagation();
                void skip(it);
              }}
            >
              跳过 · 流尾可回头
            </button>
          )}
        </div>
      </div>
    );

    return (
      <div key={it.id} className={cls}>
        <span className="pf-node" />
        {it.item_kind === 'paper' ? <div className="pf-item-stack">{inner}</div> : inner}
      </div>
    );
  };

  return (
    <div className="pface">
      <div className="pf-open">
        <span className="pf-open-ava">
          <LoomIcon name="sparkle" size={18} />
        </span>
        <div>
          <p className="pf-open-line">
            {allDone ? '都织完了——下面是今天的线头。' : stream.opening_line}
          </p>
          <span className="pf-open-meta">composer · {stream.date}</span>
        </div>
      </div>

      {items.length > 0 && (
        <div className="pf-prog">
          <span className="pf-prog-n">
            <b className="tnum">{stream.progress.done}</b> / {stream.progress.total}
          </span>
          <div className="bar thin">
            <span style={{ width: `${(stream.progress.done / stream.progress.total) * 100}%` }} />
          </div>
          <span className="pf-prog-eta">{allDone ? '今日完成' : `预计还剩 ~${etaMin} 分钟`}</span>
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState
          icon="review"
          title="今天流里还没有东西"
          text="录几道题，或让我按当前信号重排一次。"
        />
      ) : (
        <div className="pf-thread">{active.map(row)}</div>
      )}

      {skipped.length > 0 && (
        <>
          <div className="section-label pf-skipped-label">
            <h2 className="serif">跳过的</h2>
            <span className="rule" />
            <span className="count">{skipped.length}</span>
          </div>
          <div className="pf-thread">{skipped.map(row)}</div>
        </>
      )}

      <div className="pf-item-cta" style={{ marginTop: 'var(--s-5)' }}>
        <Btn
          size="sm"
          variant="ghost"
          icon="refresh"
          disabled={recomposing}
          onClick={() => void recompose()}
        >
          {recomposing ? '重排中…' : '按当前信号重排'}
        </Btn>
      </div>

      <div className="pf-ondemand">
        <div className="pf-ondemand-label">
          <LoomIcon name="send" size={13} />
          点播 · ON_DEMAND
        </div>
        <div className="composer">
          <textarea
            rows={1}
            value={demand}
            placeholder="向我点播：比如「来份判断句专项卷」"
            onChange={(e) => setDemand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!demand.trim()) return;
                // 点播生成链（quiz-gen 异步）M2 未接——见文件头注。
                addToast(
                  '点播收到——出题链路在 M4 接上后，这里会出现生成中的占位卷。',
                  'info',
                  'clock',
                );
                setDemand('');
              }
            }}
            aria-label="向 AI 点播"
          />
          <IconBtn
            icon="send"
            size={16}
            title="点播"
            onClick={() => {
              if (!demand.trim()) return;
              addToast(
                '点播收到——出题链路在 M4 接上后，这里会出现生成中的占位卷。',
                'info',
                'clock',
              );
              setDemand('');
            }}
          />
        </div>
      </div>
    </div>
  );
}
