// M2 练习面 host（YUK-316）— 视图状态机 + toast。
// 设计基准：docs/design/loom-refresh/project/screen-pface.jsx（视图：流(默认)/
// 卷架(?view=shelf)/散题作答/卷模式/结果/复盘；机制不暴露——页面只见 AI 的一句话
// 理由与判定）。路由耦合走 props 注入（壳层规则，web/src/router.tsx）。

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
import { type StreamItem, advanceStreamItem, getStream } from './practice-api';

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

  const streamQ = useQuery({ queryKey: ['practice-stream'], queryFn: getStream });

  const addToast = useCallback((text: string, tone?: 'info', icon?: string) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, text, tone, icon }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const refreshStream = useCallback(
    () => qc.invalidateQueries({ queryKey: ['practice-stream'] }),
    [qc],
  );

  const openItem = useCallback((item: StreamItem) => {
    if (item.status === 'done') {
      if (item.item_kind === 'paper') setMode({ kind: 'retro', artifactId: item.ref_id });
      return;
    }
    if (item.item_kind === 'paper') {
      setMode({ kind: 'paper', artifactId: item.ref_id });
      return;
    }
    // 已在做的项重进不再 PATCH（LEGAL_TRANSITIONS 不含 same-state，会 409）。
    if (item.status !== 'in_progress') {
      void advanceStreamItem(item.id, 'in_progress').catch(() => {});
    }
    setMode({ kind: 'solo', item });
  }, []);

  // 散题完成：标 done、推进到下一道 pending 散题（设计稿：流自动推进）。
  const completeSolo = useCallback(
    async (item: StreamItem) => {
      await advanceStreamItem(item.id, 'done').catch(() => {});
      await refreshStream();
      const items = (await getStream()).items;
      const next = items.find((it) => it.status === 'pending');
      if (next && next.item_kind === 'question') {
        void advanceStreamItem(next.id, 'in_progress').catch(() => {});
        setMode({ kind: 'solo', item: next });
      } else {
        setMode({ kind: 'list' });
        if (next?.item_kind === 'paper') {
          addToast('下一项是今天的卷——卷内不给即时反馈，准备好了再进。', 'info', 'layers');
        }
      }
    },
    [addToast, refreshStream],
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
            addToast={addToast}
          />
        )}
      </>
    );
  }

  return (
    <main className="page wide">
      <div className="pface-root">{body}</div>
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
