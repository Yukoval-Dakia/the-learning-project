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
import { prefersReducedMotion, useSharedMorph } from '@/ui-next/public';
import './practice-face.css';

import { PfPaper } from './PfPaper';
import { PfRetro } from './PfRetro';
import { PfShelf } from './PfShelf';
import { PfStream, practiceMorphKey } from './PfStream';
import {
  type StreamItem,
  type StreamStatus,
  type StreamView,
  advanceStreamItem,
  getStream,
} from './practice-api';
import { type Running, glideToTop, leaveQuestion } from './solo/advance-motion';
import { PracticeSolo } from './solo/PracticeSolo';
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

/** If the next question's text is still not read after this long, move on and let it load there. */
const NEXT_READY_FALLBACK_MS = 8000;

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

// navigate 暂未消费（M3 知识面挂上后，复盘 trace 的知识点链接会用它跳转）。
export default function PracticeFacePage({ getQuery, setQuery }: PracticeFacePageProps) {
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
  const [toasts, setToasts] = useState<PfToast[]>([]);
  const [actionFailure, setActionFailure] = useState<StreamActionFailure | null>(null);

  // ── YUK-1473 — moving on, in place (see advanceInPlace). One move at a time: `advancingRef`
  // turns away repeated presses, `advanceSeq` lets going back (or a scope change) cancel a move
  // still on its way, and `transition` holds the running leave motion so back can stop it.
  const [advancing, setAdvancing] = useState(false);
  const advancingRef = useRef(false);
  const advanceSeq = useRef(0);
  const continuedSeq = useRef(0);
  const transition = useRef<Running[]>([]);
  // Said to screen readers when a question arrives in place.
  const [announce, setAnnounce] = useState('');
  // Question texts already read ahead this visit (M13): each next question is prefetched once.
  const prefetched = useRef(new Set<string>());

  // ── Shared title (M4): a stream row's title grows into the question's title and folds back
  // into it. `capture` runs in the command that swaps the view; the view root's ref callback
  // (landView) plays it, restores the list's scroll position and places focus after a move.
  const morph = useSharedMorph();
  const host = useRef<HTMLDivElement | null>(null);
  const listScroll = useRef(0);
  const focusTitleOnLand = useRef(false);
  const stopTransition = useCallback(() => {
    for (const step of transition.current) step.stop();
    transition.current = [];
  }, []);
  const attachHost = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return undefined;
      host.current = node;
      return () => {
        // The page goes away: a move on its way ends here, with its motion.
        advanceSeq.current += 1;
        stopTransition();
        host.current = null;
      };
    },
    [stopTransition],
  );
  const landView = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return undefined;
      // Back on the list: return to where the reader was, before paint, so the title can fold
      // back into its row (the flight measures after the first frame).
      if (node.dataset.view === 'list' && listScroll.current > 0) {
        window.scrollTo({ top: listScroll.current, behavior: 'instant' });
        listScroll.current = 0;
      }
      // Arrived in place: the old question's button went with it, so focus goes to the new title.
      if (focusTitleOnLand.current) {
        focusTitleOnLand.current = false;
        const active = document.activeElement;
        if (!active || active === document.body) {
          node.querySelector<HTMLElement>('.un-ps-title')?.focus({ preventScroll: true });
        }
      }
      return morph.land(node);
    },
    [morph],
  );

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
    // A scope change also ends a move to the next question still on its way (YUK-1473).
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
    ): Promise<StreamItem | null> {
      let confirmed: StreamItem;
      try {
        ({ item: confirmed } = await advanceStreamItem(item.id, status));
      } catch (error) {
        recordFailure(action, error, () => void commit(item, status, action, onConfirmed));
        return null;
      }

      // PATCH 回执是服务端确认态。先写 cache，再做导航或 refresh；后续 GET 即使失败，
      // 也不能把 UI 退回 mutation 前的状态。
      qc.setQueryData<StreamView>(streamQueryKey, (view) => replaceConfirmedItem(view, confirmed));
      setActionFailure(null);
      await onConfirmed(confirmed);
      return confirmed;
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
          // M4: the row's title grows into the question's; the list's place is kept for back.
          listScroll.current = window.scrollY;
          morph.capture(host.current);
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
    [commitStreamItem, morph],
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

  // ── YUK-1473 — 散题完成后原地换下一题（设计稿：流自动推进；M2/M3/M4/M13）。
  // The finished question stays on screen (its way forward reads 下一题准备中…) while the item is
  // marked done, the stream is read and the next item is started; then its body leaves, the page
  // glides to the top, and the next question takes its place under a title that morphs in place.
  // It never passes through the list. Each question is its own PracticeSolo (keyed by item), so
  // the outgoing one unmounts exactly as before: its draft flushes on unmount and nothing it held
  // (draft, conflict, judgment, hints, timing, mascot) reaches the next one. The next question is
  // issued by its own page when it becomes current — never here, never ahead.
  const endAdvance = useCallback(() => {
    advancingRef.current = false;
    setAdvancing(false);
  }, []);
  const cancelAdvance = useCallback(() => {
    advanceSeq.current += 1;
    stopTransition();
    endAdvance();
  }, [endAdvance, stopTransition]);

  /** Leave the question page for the list, folding its title back into its row. */
  const exitToList = useCallback(() => {
    morph.capture(host.current);
    setMode({ kind: 'list' });
  }, [morph]);

  /** The next question replaces the finished one: leave motion, then the swap (one commit). */
  const swapInPlace = useCallback(
    async (done: StreamItem, next: StreamItem, pos: number, seq: number) => {
      const live = () => seq === advanceSeq.current;
      if (!prefersReducedMotion()) {
        const steps = [glideToTop(), leaveQuestion(host.current)];
        transition.current = steps;
        await Promise.all(steps.map((step) => step.done));
        if (transition.current === steps) transition.current = [];
        // Back during the motion stopped it and gave the question back; nothing else to do.
        if (!live()) return;
      }
      // M4 across questions: the finished title morphs into the next one where it stands.
      const from = practiceMorphKey(done.id);
      const to = practiceMorphKey(next.id);
      morph.capture(host.current, (key) => (key === from ? to : null));
      focusTitleOnLand.current = true;
      endAdvance();
      setAnnounce(`第 ${pos} 题`);
      setMode({ kind: 'solo', item: next });
    },
    [endAdvance, morph],
  );

  const continueInPlace = useCallback(
    async (done: StreamItem, seq: number) => {
      const live = () => seq === advanceSeq.current;
      // Only the move that marked the item done continues, once (a retried PATCH included).
      if (!live() || continuedSeq.current === seq) return;
      continuedSeq.current = seq;
      advancingRef.current = true;
      setAdvancing(true);

      let fresh: StreamView;
      try {
        fresh = await fetchFreshStream();
      } catch (error) {
        if (!live()) return;
        // done is confirmed and cached; reading the next item failed: leave for the list.
        endAdvance();
        exitToList();
        recordFailure('读取下一项', error, () => void continueAfterSolo());
        return;
      }
      if (!live()) return;

      const next = fresh.items.find((it) => it.status === 'pending');
      if (next?.item_kind !== 'question') {
        // The last question (or a paper next): back to the list, as before.
        endAdvance();
        exitToList();
        if (next?.item_kind === 'paper') {
          addToast('下一项是今天的卷——卷内不给即时反馈，准备好了再进。', 'info', 'layers');
        }
        return;
      }

      // Read the next question's text (a GET; usually already prefetched) while it is started,
      // so it arrives without a blank wait; after 8s it moves on and loads in place.
      const ready = Promise.race([
        qc.ensureQueryData(questionDetailQuery(next.ref_id)).then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => setTimeout(resolve, NEXT_READY_FALLBACK_MS)),
      ]);
      // If starting it fails, the page leaves for the list and the error offers a retry; that
      // retry (from the list) opens the question once it is started, as before.
      let leftForList = false;
      const started = await commitStreamItem(next, 'in_progress', '开始下一题', (confirmed) => {
        if (leftForList) setMode({ kind: 'solo', item: confirmed });
      });
      if (!live()) return;
      if (!started) {
        leftForList = true;
        endAdvance();
        exitToList();
        return;
      }
      await ready;
      if (!live()) return;
      const pos = fresh.items.findIndex((it) => it.id === started.id) + 1;
      await swapInPlace(done, started, pos || started.position, seq);
    },
    [
      addToast,
      commitStreamItem,
      continueAfterSolo,
      endAdvance,
      exitToList,
      fetchFreshStream,
      qc,
      recordFailure,
      swapInPlace,
    ],
  );

  const advanceInPlace = useCallback(
    async (item: StreamItem) => {
      // Spamming 下一题 / 先继续 moves exactly one question.
      if (advancingRef.current) return;
      advancingRef.current = true;
      setAdvancing(true);
      const seq = ++advanceSeq.current;
      const ok = await commitStreamItem(item, 'done', '完成练习', () => continueInPlace(item, seq));
      // Marking done failed: stay on the question; the error above offers a retry.
      if (!ok && seq === advanceSeq.current) endAdvance();
    },
    [commitStreamItem, continueInPlace, endAdvance],
  );

  // M13 — while a result is on screen, read the next pending question's text ahead: the same
  // GET (and cache entry) its page will use. A read only: nothing is started or issued here.
  const prefetchNext = useCallback(
    (current: StreamItem) => {
      const next = items.find(
        (it) => it.status === 'pending' && it.item_kind === 'question' && it.id !== current.id,
      );
      if (!next || prefetched.current.has(next.ref_id)) return;
      prefetched.current.add(next.ref_id);
      void qc.prefetchQuery(questionDetailQuery(next.ref_id));
    },
    [items, qc],
  );

  // YUK-432 (Bugbot FINDING 1) — 客观题自动 commit 后「返回流」的退出。review 已落库 → 该 slot
  // 实质 done，必须标 done（否则留下「已判分但 slot 卡 in_progress」的不一致态）。区别于
  // advanceInPlace（「下一项」）：这里**只**标 done + 回列表，不自动推进到下一道 pending——用户按的是
  // 「返回流」而非「下一项」，自动推进会越权。两条出口（advanceInPlace / 此处）都让 auto-commit 后的
  // slot 落到一致的 done 态。
  const markSoloDoneAndExit = useCallback(
    (item: StreamItem) => {
      void commitStreamItem(item, 'done', '完成并返回练习流', async () => {
        exitToList();
        await refreshStream();
      });
    },
    [commitStreamItem, exitToList, refreshStream],
  );

  let body: React.ReactNode;
  if (mode.kind === 'solo') {
    const pos = items.findIndex((it) => it.id === mode.item.id) + 1;
    body = (
      // YUK-1473 — the single-question page (layout 纸面) is the only solo view (owner
      // 2026-10-16: 「纸面 默认新不用开关」); no flag, no layout picker.
      <PracticeSolo
        // key=item.id：换题（含原地换下一题）时强制重挂：作答引擎每题一份，旧题照常卸载（草稿
        // unmount flush），判分/作答/草稿冲突/计时/吉祥物 state 不跨题残留。
        key={mode.item.id}
        item={mode.item}
        sessionId={visibleStream?.scope?.session_id ?? null}
        pos={pos || mode.item.position}
        total={items.length}
        advancing={advancing}
        onDone={() => void advanceInPlace(mode.item)}
        onResultShown={prefetchNext}
        onBack={() => {
          // Back is never blocked: it also cancels a move to the next question on its way.
          cancelAdvance();
          exitToList();
          void refreshStream();
        }}
        // YUK-432 — 客观题自动 commit 后退出回流：标 done（不自动推进），消除卡 in_progress 的 slot。
        // While a move is on its way the item is already being marked done: just leave.
        onCommittedBack={() => {
          if (advancingRef.current) {
            cancelAdvance();
            exitToList();
            void refreshStream();
            return;
          }
          void markSoloDoneAndExit(mode.item);
        }}
        addToast={addToast}
      />
    );
  } else if (mode.kind === 'paper') {
    body = (
      <PfPaper
        // key=artifactId：换卷即换一次作答 visit（YUK-1483），草稿/计时/session 不跨卷残留。
        key={mode.artifactId}
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
        {view === 'shelf' ? (
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
    <main className="page wide pface-loom">
      <div className="pface-root" ref={attachHost}>
        <div aria-live="assertive">
          {actionFailure && (
            <ErrorState text={actionFailure.message} onRetry={actionFailure.retry} compact />
          )}
        </div>
        {/* One root per view (a question, the list, a paper): its ref callback lands the shared
            title, restores the list's scroll and places focus after an in-place move. */}
        <div
          key={mode.kind === 'solo' ? `solo:${mode.item.id}` : mode.kind}
          className="pface-view"
          data-view={mode.kind}
          ref={landView}
        >
          {body}
        </div>
        <p className="visually-hidden" aria-live="polite">
          {announce}
        </p>
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
