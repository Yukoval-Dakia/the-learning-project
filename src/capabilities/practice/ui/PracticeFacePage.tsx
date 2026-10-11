// M2 练习面 host（YUK-316）— 视图状态机 + toast。
// 设计基准：docs/design/loom-refresh/project/screen-pface.jsx（视图：流(默认)/
// 卷架(?view=shelf)/散题作答/卷模式/结果/复盘；机制不暴露——页面只见 AI 的一句话
// 理由与判定）。路由耦合走 props 注入（壳层规则，web/src/router.tsx）。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Btn } from '@/ui/primitives/Btn';
import { ErrorState } from '@/ui/primitives/ErrorState';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useSharedMorph } from '@/ui-next/public';
import './practice-face.css';

import { PracticeNextEmpty } from './next/PracticeNextEmpty';
import { type PracticeCompanionMode, PracticeNextSolo } from './next/PracticeNextSolo';
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
import { questionDetailQuery } from './use-practice-submit';

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

const SCOPE_MISMATCH_ERROR = new Error('练习范围与请求不一致，请重试。');

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

function streamForRequestedScope(
  stream: StreamView | undefined,
  scopeKnowledgeId: string | null,
): StreamView | undefined {
  if (!stream) return undefined;
  if (scopeKnowledgeId) return stream.scope?.id === scopeKnowledgeId ? stream : undefined;
  return stream.scope ? undefined : stream;
}

// navigate：旧页面暂未消费（M3 知识面挂上后复盘 trace 会用它跳转）；新页面用于空态与学习伙伴回复里的链接。
export default function PracticeFacePage(props: PracticeFacePageProps) {
  return <PracticeFace {...props} soloView="retained" />;
}

export interface PracticeNextPageProps extends PracticeFacePageProps {
  /**
   * Where the learning companion's conversation lives. `embedded` mounts the Copilot dock inside
   * the page's companion panel and is only valid when the shell's global dock is off (one dock
   * owns the open-with-context signal). Default `none`: the honest placeholder, since the shell
   * still mounts its global dock until the migration line turns it off.
   */
  companion?: PracticeCompanionMode;
}

/** YUK-1473 — the same practice flow with the solve view in the new design language. */
export function PracticeNextPage({ companion = 'none', ...props }: PracticeNextPageProps) {
  return <PracticeFace {...props} soloView="next" companion={companion} />;
}

function PracticeFace({
  navigate,
  getQuery,
  setQuery,
  soloView,
  companion = 'none',
}: PracticeFacePageProps & { soloView: 'retained' | 'next'; companion?: PracticeCompanionMode }) {
  const qc = useQueryClient();
  const [scopeKnowledgeId, setScopeKnowledgeId] = useState<string | null>(() => {
    const value = getQuery('kc')?.trim();
    return value || null;
  });
  // getQuery 非 reactive（history.replace 不触发重渲染）——view 走本地 state，
  // URL 只是持久化副本（mount 时读一次，刷新/直链 ?view=shelf 落对）。
  const [view, setView] = useState<'stream' | 'shelf'>(() =>
    !scopeKnowledgeId && getQuery('view') === 'shelf' ? 'shelf' : 'stream',
  );
  const switchView = useCallback(
    (next: 'stream' | 'shelf') => {
      setView(next);
      setQuery('view', next === 'shelf' ? 'shelf' : null);
    },
    [setQuery],
  );
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  // YUK-1473 — moving to the next question in place (see advanceInPlace below).
  const [advancing, setAdvancing] = useState(false);
  const advancingRef = useRef(false);
  const advanceSeq = useRef(0);
  // YUK-1473 — shared-title morph (M4) between a stream row and the new question page. Only the
  // new solo view takes part; the retained one never captures, so nothing flies there.
  const hostRef = useRef<HTMLDivElement>(null);
  // One key for every question: moving to the next question keeps the page mounted and is not
  // a view change (no morph, no page entrance replay).
  const morph = useSharedMorph(
    hostRef,
    mode.kind === 'solo' && soloView === 'next'
      ? 'solo'
      : mode.kind === 'solo'
        ? `solo:${mode.item.id}`
        : mode.kind,
  );
  const listScroll = useRef(0);
  const captureMorph = useCallback(
    (leaving: 'list' | 'solo') => {
      if (soloView !== 'next') return;
      if (leaving === 'list') listScroll.current = window.scrollY;
      morph.capture();
    },
    [morph, soloView],
  );
  const [toasts, setToasts] = useState<PfToast[]>([]);
  const [actionFailure, setActionFailure] = useState<StreamActionFailure | null>(null);

  // TanStack Router 会在 search-only navigation 时复用页面实例。壳层传入的 getQuery 会随
  // location.searchStr 更新；这里同步本地交互状态，确保 kc=a → kc=b 不会继续使用旧 session。
  useLayoutEffect(() => {
    const value = getQuery('kc')?.trim();
    const nextScope = value || null;
    let nextView: 'stream' | 'shelf' = 'stream';
    if (!nextScope && getQuery('view') === 'shelf') nextView = 'shelf';
    setScopeKnowledgeId(nextScope);
    setView(nextView);
    setMode({ kind: 'list' });
    setActionFailure(null);
    // A scope change ends any move to the next question that is still on its way.
    advanceSeq.current += 1;
    advancingRef.current = false;
    setAdvancing(false);
  }, [getQuery]);

  const streamQueryKey = useMemo(
    () => ['practice-stream', scopeKnowledgeId] as const,
    [scopeKnowledgeId],
  );
  const streamQ = useQuery({
    queryKey: streamQueryKey,
    queryFn: () => getStream(scopeKnowledgeId ?? undefined),
  });
  // 路由范围切换/HMR 期间，Query cache 可能短暂保留上一分区的数据。范围与 payload
  // 不一致时宁可展示读取态，也不能把「今日流」题目挂在专项标题下（反向亦然）。
  const visibleStream = streamForRequestedScope(streamQ.data, scopeKnowledgeId);
  const streamScopeMismatch = streamQ.data !== undefined && visibleStream === undefined;
  let streamError: Error | null = null;
  if (streamQ.isError) streamError = streamQ.error as Error;
  else if (streamScopeMismatch && !streamQ.isFetching) streamError = SCOPE_MISMATCH_ERROR;

  const items = useMemo(() => visibleStream?.items ?? [], [visibleStream]);

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
    const fresh = await getStream(scopeKnowledgeId ?? undefined);
    qc.setQueryData<StreamView>(streamQueryKey, fresh);
    return fresh;
  }, [qc, scopeKnowledgeId, streamQueryKey]);

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
        return false;
      }

      // PATCH 回执是服务端确认态。先写 cache，再做导航或 refresh；后续 GET 即使失败，
      // 也不能把 UI 退回 mutation 前的状态。
      qc.setQueryData<StreamView>(streamQueryKey, (view) => replaceConfirmedItem(view, confirmed));
      setActionFailure(null);
      await onConfirmed(confirmed);
      return true;
    },
    [qc, recordFailure, streamQueryKey],
  );

  const clearScope = useCallback(() => {
    setScopeKnowledgeId(null);
    setQuery('kc', null);
    setQuery('view', null);
    setView('stream');
    setMode({ kind: 'list' });
    setActionFailure(null);
  }, [setQuery]);

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
          captureMorph('list');
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
    [captureMorph, commitStreamItem],
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

  // YUK-1473 — the new question page moves to the next question in place: the finished question
  // stays on screen (its 下一题 shows 下一题准备中…) until the next one is confirmed, then the page
  // swaps the question column without passing through the list. One advance at a time; going
  // back to the list cancels it, so a late answer never pulls the learner back into a question.
  const endAdvance = useCallback(() => {
    advancingRef.current = false;
    setAdvancing(false);
  }, []);
  const cancelAdvance = useCallback(() => {
    advanceSeq.current += 1;
    endAdvance();
  }, [endAdvance]);

  const continueInPlace = useCallback(
    async function continueNext(seq: number) {
      const live = () => seq === advanceSeq.current;
      let fresh: StreamView;
      try {
        fresh = await fetchFreshStream();
      } catch (error) {
        if (!live()) return;
        endAdvance();
        setMode({ kind: 'list' });
        recordFailure('读取下一项', error, () => void continueAfterSolo());
        return;
      }
      if (!live()) return;

      const next = fresh.items.find((it) => it.status === 'pending');
      if (next?.item_kind === 'question') {
        const ok = await commitStreamItem(next, 'in_progress', '开始下一题', (confirmed) => {
          if (live()) setMode({ kind: 'solo', item: confirmed });
        });
        if (!live()) return;
        endAdvance();
        if (!ok) setMode({ kind: 'list' });
        return;
      }

      endAdvance();
      captureMorph('solo');
      setMode({ kind: 'list' });
      if (next?.item_kind === 'paper') {
        addToast('下一项是今天的卷——卷内不给即时反馈，准备好了再进。', 'info', 'layers');
      }
    },
    [
      addToast,
      captureMorph,
      commitStreamItem,
      continueAfterSolo,
      endAdvance,
      fetchFreshStream,
      recordFailure,
    ],
  );

  const advanceInPlace = useCallback(
    async (item: StreamItem) => {
      if (advancingRef.current) return;
      advancingRef.current = true;
      setAdvancing(true);
      const seq = ++advanceSeq.current;
      const ok = await commitStreamItem(item, 'done', '完成练习', () => continueInPlace(seq));
      // Marking done failed: stay on the question; the error above offers a retry.
      if (!ok && seq === advanceSeq.current) endAdvance();
    },
    [commitStreamItem, continueInPlace, endAdvance],
  );

  // While a result is on screen, read the next question ahead so it can arrive without a wait
  // (M13). A read only: the next item is not started until the learner moves on.
  const prefetchNext = useCallback(
    (current: StreamItem) => {
      const next = items.find(
        (it) => it.status === 'pending' && it.item_kind === 'question' && it.id !== current.id,
      );
      if (next) void qc.prefetchQuery(questionDetailQuery(next.ref_id));
    },
    [items, qc],
  );

  // YUK-432 (Bugbot FINDING 1) — 客观题自动 commit 后「返回流」的退出。review 已落库 → 该 slot
  // 实质 done，必须标 done（否则留下「已判分但 slot 卡 in_progress」的不一致态）。区别于
  // completeSolo（「下一项」）：这里**只**标 done + 回列表，不自动推进到下一道 pending——用户按的是
  // 「返回流」而非「下一项」，自动推进会越权。两条出口（completeSolo / 此处）都让 auto-commit 后的
  // slot 落到一致的 done 态。
  const markSoloDoneAndExit = useCallback(
    (item: StreamItem) => {
      void commitStreamItem(item, 'done', '完成并返回练习流', async () => {
        captureMorph('solo');
        setMode({ kind: 'list' });
        await refreshStream();
      });
    },
    [captureMorph, commitStreamItem, refreshStream],
  );

  // Back on the list from the new question page: return to where the reader was, so the title
  // can fold back into its row (M4). Runs before paint; the morph measures after the first frame.
  const backToList = mode.kind === 'list' && soloView === 'next';
  useLayoutEffect(() => {
    if (backToList && listScroll.current > 0) {
      window.scrollTo(0, listScroll.current);
      listScroll.current = 0;
    }
  }, [backToList]);

  let body: React.ReactNode;
  if (mode.kind === 'solo') {
    const pos = items.findIndex((it) => it.id === mode.item.id) + 1;
    body =
      soloView === 'next' ? (
        // Not keyed by question: the page stays mounted and swaps its question column itself.
        <PracticeNextSolo
          item={mode.item}
          sessionId={visibleStream?.scope?.session_id ?? null}
          pos={pos || mode.item.position}
          total={items.length}
          advancing={advancing}
          onDone={(done) => void advanceInPlace(done)}
          onResultShown={prefetchNext}
          onBack={() => {
            cancelAdvance();
            captureMorph('solo');
            setMode({ kind: 'list' });
            void refreshStream();
          }}
          onCommittedBack={(done) => {
            cancelAdvance();
            void markSoloDoneAndExit(done);
          }}
          navigate={navigate}
          companion={companion}
        />
      ) : (
        <PfSolo
          // key=item.id：流自动推进换题时强制重挂，判分/作答 state 不跨题残留。
          key={mode.item.id}
          item={mode.item}
          sessionId={visibleStream?.scope?.session_id ?? null}
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
        onExit={(info) => {
          setMode({ kind: 'list' });
          void refreshStream();
          const n = info?.unsavedFailures ?? 0;
          addToast(
            n > 0 ? `已退出——有 ${n} 处草稿未保存` : '进度已保留——卷在流里等你回来。',
            'info',
            n > 0 ? 'alert' : 'clock',
          );
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
      />
    );
  } else {
    let eyebrowText = '今日练习 · 按当前学习状态编排';
    if (scopeKnowledgeId) {
      eyebrowText = `知识点专项 · ${visibleStream?.scope?.label ?? '正在读取范围'}`;
    } else if (view === 'shelf') {
      eyebrowText = '练习卷 · 待做 / 在做 / 已完成';
    }
    body = (
      <>
        <div className="page-head">
          <span className="eyebrow">{eyebrowText}</span>
          <div className="pface-head-row">
            <h1 className="page-title">{scopeKnowledgeId ? '针对性练习' : '练习'}</h1>
            {scopeKnowledgeId ? (
              <Btn size="sm" variant="ghost" icon="arrowL" onClick={clearScope}>
                返回今日流
              </Btn>
            ) : (
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
            )}
          </div>
        </div>
        {soloView === 'next' &&
        view === 'stream' &&
        visibleStream &&
        !streamQ.isFetching &&
        visibleStream.items.length === 0 ? (
          <PracticeNextEmpty
            scopeLabel={scopeKnowledgeId ? (visibleStream.scope?.label ?? null) : null}
            onClearScope={scopeKnowledgeId ? clearScope : null}
            navigate={navigate}
          />
        ) : view === 'shelf' ? (
          <PfShelf
            openPaper={(artifactId) => setMode({ kind: 'paper', artifactId })}
            openRetro={(artifactId) => setMode({ kind: 'retro', artifactId })}
          />
        ) : (
          <PfStream
            stream={visibleStream ?? null}
            loading={streamQ.isLoading || (streamScopeMismatch && streamQ.isFetching)}
            error={streamError}
            openItem={openItem}
            refresh={refreshStream}
            updateItem={async (item, status, action, onConfirmed) => {
              await commitStreamItem(item, status, action, onConfirmed);
            }}
            addToast={addToast}
          />
        )}
      </>
    );
  }

  return (
    // The new question page lays out its own width (reading column + floating companion).
    <main
      className={
        soloView === 'next' && mode.kind === 'solo'
          ? 'pface-loom pface-next'
          : 'page wide pface-loom'
      }
    >
      <div className="pface-root" ref={hostRef}>
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
