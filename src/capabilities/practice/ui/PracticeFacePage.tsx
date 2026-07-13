// M2 练习面 host（YUK-316）— 视图状态机 + toast。
// 设计基准：docs/design/loom-refresh/project/screen-pface.jsx（视图：流(默认)/
// 卷架(?view=shelf)/散题作答/卷模式/结果/复盘；机制不暴露——页面只见 AI 的一句话
// 理由与判定）。路由耦合走 props 注入（壳层规则，web/src/router.tsx）。

import { ErrorState } from '@/ui/primitives/ErrorState';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import './practice-face.css';

import { PfPaper } from './PfPaper';
import { PfRetro } from './PfRetro';
import { PfShelf } from './PfShelf';
import { PfSolo } from './PfSolo';
import { PfStream } from './PfStream';
import {
  type StreamItem,
  type StreamStatus,
  type StreamView,
  advanceStreamItem,
  getStream,
} from './practice-api';

export interface PracticeFacePageProps {
  navigate: (to: string) => void;
  getQuery: (key: string) => string | null;
  setQuery: (key: string, value: string | null) => void;
}

export interface PfToast {
  id: string;
  text: string;
  tone?: 'info';
  icon?: string;
}

type Mode =
  | { kind: 'list' }
  | { kind: 'solo'; item: StreamItem }
  | { kind: 'paper'; artifactId: string }
  | { kind: 'retro'; artifactId: string };

interface StreamActionFailure {
  message: string;
  retry: () => void;
}

function replaceConfirmedItem(view: StreamView | undefined, confirmed: StreamItem) {
  if (!view) return view;
  const items = view.items.map((item) => (item.id === confirmed.id ? confirmed : item));
  return {
    ...view,
    items,
    progress: {
      done: items.filter((item) => item.status === 'done').length,
      total: items.length,
      estimated_total_minutes: items.reduce((sum, item) => sum + item.estimated_minutes, 0),
      estimated_remaining_minutes: items
        .filter((item) => item.status === 'pending' || item.status === 'in_progress')
        .reduce((sum, item) => sum + item.estimated_minutes, 0),
    },
  };
}

function failureMessage(action: string, error: unknown) {
  return `${action}失败：${error instanceof Error ? error.message : String(error)}`;
}

// navigate 暂未消费（M3 知识面挂上后，复盘 trace 的知识点链接会用它跳转）。
export default function PracticeFacePage({ getQuery, setQuery }: PracticeFacePageProps) {
  const qc = useQueryClient();
  // getQuery 非 reactive（history.replace 不触发重渲染）——view 走本地 state，
  // URL 只是持久化副本（mount 时读一次，刷新/直链 ?view=shelf 落对）。
  const [view, setView] = useState<'stream' | 'shelf'>(() =>
    getQuery('view') === 'shelf' ? 'shelf' : 'stream',
  );
  const switchView = useCallback(
    (next: 'stream' | 'shelf') => {
      setView(next);
      setQuery('view', next === 'shelf' ? 'shelf' : null);
    },
    [setQuery],
  );
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [toasts, setToasts] = useState<PfToast[]>([]);
  const [actionFailure, setActionFailure] = useState<StreamActionFailure | null>(null);

  const streamQ = useQuery({ queryKey: ['practice-stream'], queryFn: getStream });

  const addToast = useCallback((text: string, tone?: 'info', icon?: string) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, text, tone, icon }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const recordFailure = useCallback((action: string, error: unknown, retry: () => void) => {
    setActionFailure({ message: failureMessage(action, error), retry });
  }, []);

  // 只在 GET 真成功后替换 cache；失败时保留最后一份由 PATCH 回执确认过的状态。
  const fetchFreshStream = useCallback(async () => {
    const fresh = await getStream();
    qc.setQueryData<StreamView>(['practice-stream'], fresh);
    return fresh;
  }, [qc]);

  const refreshStream = useCallback(
    async function refresh(): Promise<StreamView | null> {
      try {
        const fresh = await fetchFreshStream();
        setActionFailure(null);
        return fresh;
      } catch (error) {
        recordFailure('刷新练习流', error, () => void refresh());
        return null;
      }
    },
    [fetchFreshStream, recordFailure],
  );

  const commitStreamItem = useCallback(
    async function commit(
      item: StreamItem,
      status: StreamStatus,
      action: string,
      onConfirmed: (confirmed: StreamItem) => void | Promise<void>,
    ) {
      let confirmed: StreamItem;
      try {
        ({ item: confirmed } = await advanceStreamItem(item.id, status));
      } catch (error) {
        recordFailure(action, error, () => void commit(item, status, action, onConfirmed));
        return;
      }

      // PATCH 回执是服务端确认态。先写 cache，再做导航或 refresh；后续 GET 即使失败，
      // 也不能把 UI 退回 mutation 前的状态。
      qc.setQueryData<StreamView>(['practice-stream'], (view) =>
        replaceConfirmedItem(view, confirmed),
      );
      setActionFailure(null);
      await onConfirmed(confirmed);
    },
    [qc, recordFailure],
  );

  const openItem = useCallback(
    (item: StreamItem) => {
      if (item.status === 'done') {
        if (item.item_kind === 'paper') setMode({ kind: 'retro', artifactId: item.ref_id });
        return;
      }

      const enter = (confirmed: StreamItem) => {
        if (confirmed.item_kind === 'paper') {
          setMode({ kind: 'paper', artifactId: confirmed.ref_id });
        } else {
          setMode({ kind: 'solo', item: confirmed });
        }
      };

      // 已在做的项重进不再 PATCH（LEGAL_TRANSITIONS 不含 same-state，会 409）。
      if (item.status === 'in_progress') {
        enter(item);
        return;
      }
      void commitStreamItem(item, 'in_progress', '开始练习', enter);
    },
    [commitStreamItem],
  );

  const continueAfterSolo = useCallback(
    async function continueNext() {
      let fresh: StreamView;
      try {
        fresh = await fetchFreshStream();
      } catch (error) {
        recordFailure('读取下一项', error, () => void continueNext());
        return;
      }

      const next = fresh.items.find((it) => it.status === 'pending');
      if (next?.item_kind === 'question') {
        void commitStreamItem(next, 'in_progress', '开始下一题', (confirmed) => {
          setMode({ kind: 'solo', item: confirmed });
        });
        return;
      }

      setMode({ kind: 'list' });
      if (next?.item_kind === 'paper') {
        addToast('下一项是今天的卷——卷内不给即时反馈，准备好了再进。', 'info', 'layers');
      }
    },
    [addToast, commitStreamItem, fetchFreshStream, recordFailure],
  );

  // 散题完成：标 done、推进到下一道 pending 散题（设计稿：流自动推进）。
  const completeSolo = useCallback(
    (item: StreamItem) => {
      void commitStreamItem(item, 'done', '完成练习', async () => {
        // done 已由 PATCH 确认；后续读下一项失败时退出作答面，但 cache 仍保持 done。
        setMode({ kind: 'list' });
        await continueAfterSolo();
      });
    },
    [commitStreamItem, continueAfterSolo],
  );

  // YUK-432 (Bugbot FINDING 1) — 客观题自动 commit 后「返回流」的退出。review 已落库 → 该 slot
  // 实质 done，必须标 done（否则留下「已判分但 slot 卡 in_progress」的不一致态）。区别于
  // completeSolo（「下一项」）：这里**只**标 done + 回列表，不自动推进到下一道 pending——用户按的是
  // 「返回流」而非「下一项」，自动推进会越权。两条出口（completeSolo / 此处）都让 auto-commit 后的
  // slot 落到一致的 done 态。
  const markSoloDoneAndExit = useCallback(
    (item: StreamItem) => {
      void commitStreamItem(item, 'done', '完成并返回练习流', async () => {
        setMode({ kind: 'list' });
        await refreshStream();
      });
    },
    [commitStreamItem, refreshStream],
  );

  const items = useMemo(() => streamQ.data?.items ?? [], [streamQ.data]);

  let body: React.ReactNode;
  if (mode.kind === 'solo') {
    const pos = items.findIndex((it) => it.id === mode.item.id) + 1;
    body = (
      <PfSolo
        // key=item.id：流自动推进换题时强制重挂，判分/作答 state 不跨题残留。
        key={mode.item.id}
        item={mode.item}
        pos={pos || mode.item.position}
        total={items.length}
        onDone={() => void completeSolo(mode.item)}
        onBack={() => {
          setMode({ kind: 'list' });
          void refreshStream();
        }}
        // YUK-432 — 客观题自动 commit 后退出回流：标 done（不自动推进），消除卡 in_progress 的 slot。
        onCommittedBack={() => void markSoloDoneAndExit(mode.item)}
        addToast={addToast}
      />
    );
  } else if (mode.kind === 'paper') {
    body = (
      <PfPaper
        artifactId={mode.artifactId}
        onExit={() => {
          setMode({ kind: 'list' });
          void refreshStream();
          addToast('进度已保留——卷在流里等你回来。', 'info', 'clock');
        }}
        onSubmitted={() => {
          void refreshStream();
          setMode({ kind: 'retro', artifactId: mode.artifactId });
        }}
        addToast={addToast}
      />
    );
  } else if (mode.kind === 'retro') {
    body = (
      <PfRetro
        artifactId={mode.artifactId}
        onBack={() => {
          setMode({ kind: 'list' });
          switchView('shelf');
        }}
        addToast={addToast}
      />
    );
  } else {
    body = (
      <>
        <div className="page-head">
          <span className="eyebrow">
            {view === 'shelf'
              ? 'PRACTICE · 卷架 · papers · 待做 / 在做 / 已完成'
              : 'PRACTICE · GET /api/practice/stream?date=today'}
          </span>
          <div className="pface-head-row">
            <h1 className="page-title">练习</h1>
            <div className="seg" role="tablist" aria-label="练习视图">
              <button
                type="button"
                className={view === 'stream' ? 'on' : ''}
                role="tab"
                aria-selected={view === 'stream'}
                onClick={() => switchView('stream')}
              >
                <LoomIcon name="review" size={14} />
                今日流
              </button>
              <button
                type="button"
                className={view === 'shelf' ? 'on' : ''}
                role="tab"
                aria-selected={view === 'shelf'}
                onClick={() => switchView('shelf')}
              >
                <LoomIcon name="archive" size={14} />
                卷架
              </button>
            </div>
          </div>
        </div>
        {view === 'shelf' ? (
          <PfShelf
            openPaper={(artifactId) => setMode({ kind: 'paper', artifactId })}
            openRetro={(artifactId) => setMode({ kind: 'retro', artifactId })}
          />
        ) : (
          <PfStream
            stream={streamQ.data ?? null}
            loading={streamQ.isLoading}
            error={streamQ.isError ? (streamQ.error as Error) : null}
            openItem={openItem}
            refresh={refreshStream}
            updateItem={commitStreamItem}
            addToast={addToast}
          />
        )}
      </>
    );
  }

  return (
    <main className="page wide pface-loom">
      <div className="pface-root">
        <div aria-live="assertive">
          {actionFailure && (
            <ErrorState text={actionFailure.message} onRetry={actionFailure.retry} compact />
          )}
        </div>
        {body}
      </div>
      {createPortal(
        <div className="pf-toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`pf-toast${t.tone === 'info' ? ' t-info' : ''}`}>
              <LoomIcon name={(t.icon as never) ?? 'sparkle'} size={15} className="ico" />
              <span>{t.text}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </main>
  );
}
