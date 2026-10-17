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
  /**
   * YUK-1510 — `?item=`: the stream item whose question is open, so a refresh lands back on it.
   * The host keeps it out of getQuery, so writing it is never a scope change.
   */
  itemParam: string | null;
  /** Writes `?item=`: 'push' when a question is opened from the list (browser Back returns there). */
  writeItemParam: (id: string | null, how: 'push' | 'replace') => void;
  historyBack: () => void;
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

/**
 * YUK-1510 — the live URL, read at the moment of a write: its scope (path plus every param but
 * `item`) and the item it names. Writes from a flow that started in another scope are dropped.
 */
function liveUrl(): { scope: string; item: string | null } {
  const search = new URLSearchParams(window.location.search);
  const item = search.get('item');
  search.delete('item');
  return { scope: `${window.location.pathname}?${search}`, item };
}

// navigate 暂未消费（M3 知识面挂上后，复盘 trace 的知识点链接会用它跳转）。
export default function PracticeFacePage({
  getQuery,
  setQuery,
  itemParam,
  writeItemParam,
  historyBack,
}: PracticeFacePageProps) {
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
  // turns away repeated presses; `advanceSeq` is bumped by anything that ends a move on its way
  // (back, the question's view root detaching — which every scope change causes — or the page
  // unmounting), and every await of the move re-checks it; `transition` holds the running leave
  // motion so it can be stopped.
  // The question being moved on from (its id), so only that question shows 下一题准备中….
  const [advancing, setAdvancing] = useState<string | null>(null);
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
  // Set by the command that leaves a question for the list (exitToList): only then does the list
  // return to its old place. A list reached any other way (a scope change resets the page to the
  // list) keeps the top of the page, never the old scope's position.
  const restoreListOnLand = useRef(false);
  const focusTitleOnLand = useRef(false);
  // YUK-1510 — the open question's `?item=` entry was pushed by opening it from the list, so
  // leaving it in-page steps back to the list entry instead of stacking another one.
  const itemEntryPushed = useRef(false);
  // A question's view went away; the next list to land re-reads the stream unless the page
  // already does (an in-page exit refreshes it itself).
  const questionLeft = useRef(false);
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
      const view = node.dataset.view;
      const fromQuestion = questionLeft.current;
      questionLeft.current = false;
      // Back on the list: return to where the reader was, before paint, so the title can fold
      // back into its row (the flight measures after the first frame).
      if (view === 'list') {
        const exitedInPage = restoreListOnLand.current;
        if (exitedInPage && listScroll.current > 0) {
          window.scrollTo({ top: listScroll.current, behavior: 'instant' });
        }
        restoreListOnLand.current = false;
        listScroll.current = 0;
        if (!exitedInPage) itemEntryPushed.current = false;
        // YUK-1510 — the page decided the `?item=` it was following cannot open (not a started
        // question of this stream): this list root exists for that decision (data-rejected-item),
        // so drop the param quietly, if the URL still names that item. A list reached any other
        // way never touches `?item=` (an in-page exit writes the URL itself; on a cold load the
        // item is still being looked up).
        const rejected = node.dataset.rejectedItem;
        if (rejected && new URLSearchParams(window.location.search).get('item') === rejected) {
          writeItemParam(null, 'replace');
        }
        // Reached by browser Back (not an in-page exit): the list re-reads the stream so an
        // answer just submitted shows as 已交.
        if (fromQuestion && !exitedInPage) {
          void qc.invalidateQueries({ queryKey: ['practice-stream'] });
        }
      }
      // Arrived in place: the old question's button went with it, so focus goes to the new title.
      if (focusTitleOnLand.current) {
        focusTitleOnLand.current = false;
        const active = document.activeElement;
        if (!active || active === document.body) {
          node.querySelector<HTMLElement>('.un-ps-title')?.focus({ preventScroll: true });
        }
      }
      const landed = morph.land(node);
      if (view !== 'solo') return landed;
      return () => {
        landed?.();
        questionLeft.current = true;
        // YUK-1473 — this question's view is going away. Whatever took it away (back, a scope
        // change through a click, the URL or history — the scope sync resets the page to the
        // list — or the page itself unmounting), a move to the next question that is still on
        // its way ends here: every await of the move re-checks advanceSeq, so it sends no
        // further PATCH, runs no glide and never pulls a question back in. After a normal
        // in-place swap the move has already ended, so this changes nothing.
        advanceSeq.current += 1;
        stopTransition();
        advancingRef.current = false;
        setAdvancing(null);
      };
    },
    [morph, qc, stopTransition, writeItemParam],
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

  // YUK-1510 — the page follows `?item=` when it changes from outside the page: a refresh or
  // direct link (open that question once this scope's stream is read), browser Back (to the
  // list) or Forward (back to the question). The page's own writes name the question it already
  // shows, so they change nothing here. Only an item of the stream for the current scope that is
  // already started can open; anything else stays on the list, which drops the stale `?item=`.
  const [followedItem, setFollowedItem] = useState<string | null>(null);
  // The last `?item=` that could not open; `n` gives each rejection its own list root, so its
  // ref callback drops the param every time (a second Forward to the same stale item included).
  const [rejectedItem, setRejectedItem] = useState<{ id: string; n: number } | null>(null);
  const streamRead = visibleStream !== undefined && streamQ.isFetchedAfterMount && !streamQ.isError;
  if (itemParam !== followedItem && (itemParam === null || streamRead)) {
    setFollowedItem(itemParam);
    const target = itemParam === null ? undefined : items.find((it) => it.id === itemParam);
    if (target?.item_kind === 'question' && target.status === 'in_progress') {
      if (rejectedItem?.id === target.id) setRejectedItem(null);
      if (mode.kind !== 'solo' || mode.item.id !== target.id)
        setMode({ kind: 'solo', item: target });
    } else if (itemParam === null) {
      if (mode.kind === 'solo') setMode({ kind: 'list' });
    } else if (mode.kind !== 'solo' || mode.item.id !== itemParam) {
      if (mode.kind === 'solo') setMode({ kind: 'list' });
      setRejectedItem({ id: itemParam, n: (rejectedItem?.n ?? 0) + 1 });
    }
  }
  // The item named on load is still being looked up: the list waits (and keeps `?item=`).
  const itemOpening = mode.kind === 'list' && itemParam !== null && itemParam !== followedItem;

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

  // YUK-1510 — a question opened from the list gets its own history entry, so browser Back from
  // it returns to the list.
  // Only in the scope the opening started in (`scope`), and only if the URL does not name it yet.
  const openQuestionUrl = useCallback(
    (id: string, scope: string) => {
      const here = liveUrl();
      if (here.scope !== scope || here.item === id) return;
      writeItemParam(id, 'push');
      itemEntryPushed.current = true;
    },
    [writeItemParam],
  );

  const openItem = useCallback(
    (item: StreamItem) => {
      if (item.status === 'done') {
        if (item.item_kind === 'paper') setMode({ kind: 'retro', artifactId: item.ref_id });
        return;
      }

      // YUK-1510 — opened from this scope's list; if the scope changes before the start is
      // confirmed, the question does not open over the new scope.
      const scope = liveUrl().scope;
      const enter = (confirmed: StreamItem) => {
        if (liveUrl().scope !== scope) return;
        if (confirmed.item_kind === 'paper') {
          setMode({ kind: 'paper', artifactId: confirmed.ref_id });
        } else {
          // M4: the row's title grows into the question's; the list's place is kept for back.
          listScroll.current = window.scrollY;
          morph.capture(host.current);
          setMode({ kind: 'solo', item: confirmed });
          openQuestionUrl(confirmed.id, scope);
        }
      };

      // 已在做的项重进不再 PATCH（LEGAL_TRANSITIONS 不含 same-state，会 409）。
      if (item.status === 'in_progress') {
        enter(item);
        return;
      }
      void commitStreamItem(item, 'in_progress', '开始练习', enter);
    },
    [commitStreamItem, morph, openQuestionUrl],
  );

  const continueAfterSolo = useCallback(
    async function continueNext() {
      const scope = liveUrl().scope;
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
          if (liveUrl().scope !== scope) return;
          setMode({ kind: 'solo', item: confirmed });
          openQuestionUrl(confirmed.id, scope);
        });
        return;
      }

      if (liveUrl().scope !== scope) return;
      setMode({ kind: 'list' });
      if (next?.item_kind === 'paper') {
        addToast('下一项是今天的卷——卷内不给即时反馈，准备好了再进。', 'info', 'layers');
      }
    },
    [addToast, commitStreamItem, fetchFreshStream, openQuestionUrl, recordFailure],
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
    setAdvancing(null);
  }, []);
  const cancelAdvance = useCallback(() => {
    advanceSeq.current += 1;
    stopTransition();
    endAdvance();
  }, [endAdvance, stopTransition]);
  // YUK-1510 — a move to the next question is live while it is the latest move AND the URL is
  // still in the scope it started in. A scope change (click, URL or history) can land before the
  // question's view detaches; the move ends there through the cancel path, so it sends no further
  // PATCH, writes no URL and never pulls a question back in.
  const advanceLive = useCallback(
    (seq: number, scope: string) => {
      if (seq !== advanceSeq.current) return false;
      if (liveUrl().scope === scope) return true;
      cancelAdvance();
      return false;
    },
    [cancelAdvance],
  );

  /**
   * Leave the question page for the list, folding its title back into its row. `scope` is the
   * URL scope the leaving started in (a click: now; a confirmed PATCH: when it was asked for).
   */
  const exitToList = useCallback(
    (scope: string = liveUrl().scope) => {
      const here = liveUrl();
      // YUK-1510 — the URL scope changed on the way (the scope sync already reset the page to
      // the new scope's list): nothing to leave, and the new scope's URL is never touched.
      if (here.scope !== scope) return;
      morph.capture(host.current);
      restoreListOnLand.current = true;
      setAnnounce('');
      setMode({ kind: 'list' });
      // The URL stops naming the question: step back to the list's own entry when opening
      // pushed one, otherwise drop `?item=` in place.
      const pushed = itemEntryPushed.current;
      itemEntryPushed.current = false;
      if (here.item === null) return;
      if (pushed) historyBack();
      else writeItemParam(null, 'replace');
    },
    [historyBack, morph, writeItemParam],
  );

  /** The next question replaces the finished one: leave motion, then the swap (one commit). */
  const swapInPlace = useCallback(
    async (done: StreamItem, next: StreamItem, pos: number, seq: number, scope: string) => {
      const live = () => advanceLive(seq, scope);
      if (!live()) return;
      if (!prefersReducedMotion()) {
        const steps = [glideToTop(), leaveQuestion(host.current)];
        transition.current = steps;
        await Promise.all(steps.map((step) => step.done));
        if (transition.current === steps) transition.current = [];
        // Back (or the view going away) during the motion stopped it; nothing else to do.
        if (!live()) return;
      }
      // M4 across questions: the finished title morphs into the next one where it stands.
      const from = practiceMorphKey(done.id);
      const to = practiceMorphKey(next.id);
      morph.capture(host.current, (key) => (key === from ? to : null));
      focusTitleOnLand.current = true;
      endAdvance();
      setAnnounce(`第 ${pos} 题`);
      // Lands only on the question it is replacing: if anything already moved the page (the
      // scope sync above resets it to the list), that wins.
      setMode((current) =>
        current.kind === 'solo' && current.item.id === done.id
          ? { kind: 'solo', item: next }
          : current,
      );
      // YUK-1510 — the URL follows the question in place (no new history entry); live() above
      // has just checked the URL is still in this advance's scope.
      if (liveUrl().item !== next.id) writeItemParam(next.id, 'replace');
    },
    [advanceLive, endAdvance, morph, writeItemParam],
  );

  const continueInPlace = useCallback(
    async (done: StreamItem, seq: number, scope: string) => {
      const live = () => advanceLive(seq, scope);
      // Only the move that marked the item done continues, once (a retried PATCH included).
      if (continuedSeq.current === seq || !live()) return;
      continuedSeq.current = seq;
      advancingRef.current = true;
      setAdvancing(done.id);

      let fresh: StreamView;
      try {
        fresh = await fetchFreshStream();
      } catch (error) {
        if (!live()) return;
        // done is confirmed and cached; reading the next item failed: leave for the list.
        endAdvance();
        exitToList(scope);
        recordFailure('读取下一项', error, () => void continueAfterSolo());
        return;
      }
      if (!live()) return;

      const next = fresh.items.find((it) => it.status === 'pending');
      if (next?.item_kind !== 'question') {
        // The last question (or a paper next): back to the list, as before.
        endAdvance();
        exitToList(scope);
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
        if (!leftForList || liveUrl().scope !== scope) return;
        setMode({ kind: 'solo', item: confirmed });
        openQuestionUrl(confirmed.id, scope);
      });
      if (!live()) return;
      if (!started) {
        leftForList = true;
        endAdvance();
        exitToList(scope);
        return;
      }
      await ready;
      if (!live()) return;
      const pos = fresh.items.findIndex((it) => it.id === started.id) + 1;
      await swapInPlace(done, started, pos || started.position, seq, scope);
    },
    [
      addToast,
      advanceLive,
      commitStreamItem,
      continueAfterSolo,
      endAdvance,
      exitToList,
      fetchFreshStream,
      openQuestionUrl,
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
      setAdvancing(item.id);
      const seq = ++advanceSeq.current;
      // YUK-1510 — the URL scope this move belongs to; see advanceLive.
      const scope = liveUrl().scope;
      const ok = await commitStreamItem(item, 'done', '完成练习', () =>
        continueInPlace(item, seq, scope),
      );
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
      const scope = liveUrl().scope;
      void commitStreamItem(item, 'done', '完成并返回练习流', async () => {
        exitToList(scope);
        await refreshStream();
      });
    },
    [commitStreamItem, exitToList, refreshStream],
  );

  let viewKey: string = mode.kind;
  if (mode.kind === 'solo') viewKey = `solo:${mode.item.id}`;
  else if (itemOpening) viewKey = 'list:opening';
  else if (mode.kind === 'list' && rejectedItem) viewKey = `list:rejected:${rejectedItem.n}`;

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
        advancing={advancing === mode.item.id}
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
          if (advancing === mode.item.id) {
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
          key={viewKey}
          className="pface-view"
          data-view={mode.kind}
          data-opening={itemOpening ? '' : undefined}
          data-rejected-item={mode.kind === 'list' ? rejectedItem?.id : undefined}
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
