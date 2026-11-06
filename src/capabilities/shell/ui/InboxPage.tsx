// M4-T6 (YUK-319/YUK-318)：收件箱页。YUK-521 (A4 强度轴) 重构为三档分流：
//   A 自动应用（strength A；后台静默物化 + 撤销窗口，卡来自 /api/proposals/auto-applied，
//     撤销复用既有 retractProposal —— 无新撤销逻辑）+ 裁决熔断 meter/banner；
//   B 逐条人审（真裁决项，复用既有 ProposalCard；含 breaker 退回 B 的 strength-A 行）；
//   C 纯状态（无 accept applier 的 defer/archive/judge_retraction；折叠链到 AI 观察面）。
// tier 映射以 core 强度表为单一真相（inbox-tier.ts），不照抄设计稿 v0 的 INBOX_TIER。
// M3E 呈现（YUK-1473）：外壳 UiNextRoot.ib-page + main.un-m3e-bridge，样式在 inbox-m3e.css，
// 设计记录 docs/design/2026-11-03-inbox-agent-notes-events-m3e.md。查询、分页补齐、撤销与
// 裁决逻辑未动；页级错误提示改走 ui-next 的 showToast / ToastHost。

import {
  type InfiniteData,
  InfiniteQueryObserver,
  type InfiniteQueryObserverResult,
  type QueryClient,
  infiniteQueryOptions,
  notifyManager,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  Eye,
  History,
  Lock,
  Network,
  Undo2,
  Zap,
} from 'lucide-react';
import { type ReactNode, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { invalidateAfterProposalRetract, queryKeys } from '@/ui/lib/write-invalidation';
import { ToastHost } from '@/ui-next/feedback/ToastHost';
import { showToast } from '@/ui-next/feedback/toast-store';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button, ChipToggle, UiNextRoot } from '@/ui-next/public';
import {
  type AutoAppliedRetractResultWire,
  type AutoAppliedRowWire,
  KIND_META,
  type ProposalInboxRow,
  type ProposalPageWire,
  type VerdictBreakerWire,
  decisionPaginationDiagnostics,
  getNextDecisionPageParam,
  kindMeta,
  mergeProposalPages,
  reasonWithoutIds,
} from './inbox-api';
import { inboxTone, kindIcon } from './inbox-look';
import {
  AUTO_APPLIED_WINDOWS,
  type AutoAppliedWindowKey,
  TIER_C_COPY,
  TIER_META,
  autoAppliedWindow,
  bucketPendingByTier,
} from './inbox-tier';
import { ProposalCard } from './ProposalCard';
import { type WorkbenchClient, useWorkbenchClient } from './workbench-client';
import './inbox-m3e.css';

const DECISION_QUERY_KEY = queryKeys.decisionProposals;
const EMPTY_DECISION_PAGES: readonly ProposalPageWire[] = [];
const EMPTY_DECISION_PAGE_PARAMS: readonly (string | null)[] = [];

function decisionQueryOptions(listPage: WorkbenchClient['listDecisionProposalPage']) {
  return infiniteQueryOptions<
    ProposalPageWire,
    Error,
    InfiniteData<ProposalPageWire, string | null>,
    typeof DECISION_QUERY_KEY,
    string | null
  >({
    queryKey: DECISION_QUERY_KEY,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => listPage(pageParam),
    getNextPageParam: getNextDecisionPageParam,
  });
}

type DecisionBacklog = InfiniteQueryObserverResult<
  InfiniteData<ProposalPageWire, string | null>,
  Error
>;

/**
 * Owns the background drain of the decision backlog for one mounted inbox. It watches the same
 * cached query as the page through its own observer, which never fetches on its own
 * (`enabled: false`) and only asks for the next page. Its snapshot is the continuation state the
 * page shows (still loading / failed / more pages).
 *
 * The drain acts only when the gate (has next page, fetching next page, next page failed) changes,
 * and asks for at most one page at a time. A failed page stops the drain until the learner presses
 * 继续加载. Unsubscribing removes the observer, so nothing outlives the page.
 */
class DecisionBacklogDrain {
  readonly #observer: InfiniteQueryObserver<
    ProposalPageWire,
    Error,
    InfiniteData<ProposalPageWire, string | null>,
    typeof DECISION_QUERY_KEY,
    string | null
  >;
  #lastGate: string | null = null;

  constructor(client: QueryClient, listPage: WorkbenchClient['listDecisionProposalPage']) {
    this.#observer = new InfiniteQueryObserver(client, {
      ...decisionQueryOptions(listPage),
      enabled: false,
    });
  }

  subscribe = (onChange: () => void): (() => void) => {
    const unsubscribe = this.#observer.subscribe(
      notifyManager.batchCalls((result: DecisionBacklog) => {
        this.#drain(result);
        onChange();
      }),
    );
    // Catch up on anything that changed between creating the observer and subscribing.
    this.#observer.updateResult();
    this.#drain(this.#observer.getCurrentResult());
    return () => {
      unsubscribe();
      this.#lastGate = null;
    };
  };

  getSnapshot = (): DecisionBacklog => this.#observer.getCurrentResult();

  /** Explicit 继续加载 after a failed page. */
  continueLoading = (): void => {
    void this.#observer.fetchNextPage();
  };

  #drain(result: DecisionBacklog): void {
    const gate = `${result.hasNextPage}|${result.isFetchingNextPage}|${result.isFetchNextPageError}`;
    if (gate === this.#lastGate) return;
    this.#lastGate = gate;
    if (!result.hasNextPage) return;
    if (result.isFetchingNextPage || result.isFetchNextPageError) return;
    void this.#observer.fetchNextPage();
  }
}

/**
 * Wall clock for the A-tier undo countdown, owned by one mounted inbox. The interval only runs
 * while subscribed, and the page subscribes only while it shows auto-applied cards. The
 * remaining window is always computed from the real applied time, so the tick rate never
 * stretches or resets the window.
 */

function formatWindowLabel(windowMs: number): string {
  const minutes = Math.round(windowMs / 60_000);
  if (minutes % 60 === 0) return `近 ${minutes / 60} 小时`;
  return `近 ${minutes} 分钟`;
}

function autoAppliedHeadline(
  rows: readonly AutoAppliedRowWire[],
  loading: boolean,
  windowKey: AutoAppliedWindowKey,
): string {
  const when = AUTO_APPLIED_WINDOWS.find(({ key }) => key === windowKey)?.label ?? '';
  if (loading) return `正在看${when}替你做了什么。`;
  if (rows.length === 0) return `${when}没有替你做什么。`;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const { label } = kindMeta(row.kind);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts].map(([label, count]) => `${label} ${count} 件`).join('，');
  return `${when}替你做了 ${rows.length} 件：${parts}。`;
}

function batchResultWords(summary: AutoAppliedRetractResultWire['summary']): string {
  const parts = [
    summary.reverted > 0 ? `撤销了 ${summary.reverted} 件` : null,
    summary.blocked > 0 ? `${summary.blocked} 件不能撤，原因写在各自下面` : null,
    summary.already_reverted > 0 ? `${summary.already_reverted} 件之前已经撤过` : null,
    summary.failed > 0 ? `${summary.failed} 件这次没撤成，可以再试一次` : null,
  ].filter(Boolean);
  const done = parts.length > 0 ? `${parts.join('，')}。` : '这次没有可撤的。';
  return summary.truncated ? `${done}一次最多处理 200 件，还有没处理的，可以再点一次。` : done;
}

function TierHead({ tier, count, id }: { tier: 'A' | 'B' | 'C'; count: number; id: string }) {
  const m = TIER_META[tier];
  return (
    <header className="ib-tier-head" data-tone={inboxTone(m.tone)}>
      <span className="ib-tier-mark">{tier}</span>
      <div className="ib-tier-text">
        <h2 id={id} className="ib-tier-title">
          {m.label}
          <span className="ib-tier-count">{count} 项</span>
        </h2>
        <p className="ib-tier-sub">{m.sub}</p>
      </div>
    </header>
  );
}

function BreakerMeter({ breaker }: { breaker: VerdictBreakerWire }) {
  const windowLabel = formatWindowLabel(breaker.window);
  const pct = breaker.cap > 0 ? Math.min(100, (breaker.applied / breaker.cap) * 100) : 0;
  return (
    <div className="ib-breaker" data-state={breaker.tripped ? 'tripped' : 'ok'}>
      <span className="ib-breaker-ic" aria-hidden="true">
        {breaker.tripped ? <CircleAlert size={16} /> : <Check size={16} />}
      </span>
      <div className="ib-breaker-text">
        {breaker.tripped ? (
          <>
            <b>自动应用已暂停。</b>
            {windowLabel}内自动操作触顶（{breaker.applied}/{breaker.cap}），为防失控已退回全人审 ——
            下面 B 档的项需要你逐条确认。
          </>
        ) : (
          <>
            <b>自动处理正常。</b>没到上限，安全可撤的小操作不占你的裁决队列。
          </>
        )}
        <div className="ib-breaker-meter">
          <span className="ib-breaker-track" aria-hidden="true">
            <span className="ib-breaker-fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="un-num">
            {breaker.applied} / {breaker.cap} · {windowLabel}
          </span>
        </div>
      </div>
    </div>
  );
}

function AutoAppliedCard({
  row,
  reverting,
  onRevert,
}: {
  row: AutoAppliedRowWire;
  reverting: boolean;
  onRevert: (proposalId: string) => void;
}) {
  const [trace, setTrace] = useState(false);
  const traceId = useId();
  const { undo } = row;
  // Cards from before auto-apply have no undo here, and the server's sentence does not fit them.
  const blockReason =
    undo.status === 'blocked' && undo.code !== 'not_auto_applied' ? undo.reason_md : null;
  // A 档卡的 kind 由读模型给出（首批含建知识点/学习项/错因类目）。
  const meta = kindMeta(row.kind);
  const KindIcon = undo.status === 'blocked' ? Lock : kindIcon(meta.icon);
  return (
    <article className="ib-aa" data-state={undo.status}>
      <span className="ib-aa-ic" aria-hidden="true">
        <KindIcon size={16} />
      </span>
      <div className="ib-aa-body">
        <div className="ib-aa-top">
          <span className="ib-tag" data-tone="positive">
            {meta.label}
          </span>
          <span className="ib-aa-title">{row.title}</span>
        </div>
        <p className="ib-aa-text">
          {reasonWithoutIds(row.summary ?? '') || '自动处理了这条提议。'}
        </p>
        {trace && (
          <div id={traceId} className="ib-aa-trace">
            {row.summary ? <p className="ib-aa-trace-full">{row.summary}</p> : null}
            来自 <b>{meta.label}</b>
            <br />
            静态可逆性兜底 · 非 confidence 判定（apply 档位 {row.level}）
          </div>
        )}
        <div className="ib-acts ib-aa-foot">
          {undo.status === 'reverted' ? (
            <span className="ib-aa-window">
              <Undo2 size={13} aria-hidden="true" />
              已撤销 · 恢复到应用前
            </span>
          ) : null}
          {undo.status === 'revertable' ? (
            <Button size="sm" disabled={reverting} onClick={() => onRevert(row.proposal_id)}>
              <Undo2 size={14} aria-hidden="true" />
              {reverting ? '撤销中…' : '撤销'}
            </Button>
          ) : null}
          {blockReason ? (
            <span className="ib-aa-window" data-state="blocked">
              <CircleAlert size={13} aria-hidden="true" />
              {blockReason}
            </span>
          ) : null}
          <Button
            size="sm"
            variant="quiet"
            className="ib-aa-trace-btn"
            aria-expanded={trace}
            aria-controls={trace ? traceId : undefined}
            onClick={() => setTrace((v) => !v)}
          >
            <History size={14} aria-hidden="true" />
            追溯
          </Button>
        </div>
      </div>
    </article>
  );
}

function TierCBlock({
  items,
  navigate,
}: {
  items: ProposalInboxRow[];
  navigate: (to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className="ib-fold" data-open={open}>
      <button
        type="button"
        className="ib-fold-bar"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
      >
        <span className="ib-fold-ic" aria-hidden="true">
          <Eye size={16} />
        </span>
        <span className="ib-fold-text">
          <span className="ib-fold-t">{TIER_C_COPY.summary(items.length)}</span>
          <span className="ib-fold-s">{open ? TIER_C_COPY.expanded : TIER_C_COPY.collapsed}</span>
        </span>
        <ChevronDown size={18} aria-hidden="true" className="ib-fold-chev" />
      </button>
      {open && (
        <div id={bodyId} className="ib-fold-body">
          <ul className="ib-fold-list">
            {items.map((it) => {
              const meta = kindMeta(it.kind);
              const ItemIcon = kindIcon(meta.icon);
              return (
                <li key={it.id} className="ib-fold-row">
                  <span className="ib-fold-row-ic" aria-hidden="true">
                    <ItemIcon size={14} />
                  </span>
                  <div className="ib-fold-row-body">
                    <div className="ib-fold-row-top">
                      <span className="ib-fold-row-title">{meta.label}</span>
                      <span className="ib-fold-row-state">{TIER_C_COPY.itemState}</span>
                    </div>
                    <div className="ib-fold-row-text">{it.payload.reason_md}</div>
                  </div>
                </li>
              );
            })}
          </ul>
          <Button size="sm" variant="ghost" onClick={() => navigate('/today')}>
            <Eye size={14} aria-hidden="true" />去 AI 观察面回看
          </Button>
        </div>
      )}
    </div>
  );
}

/** One line of status inside a tier (still loading, partial, limit reached …). */
function TierNote({ children }: { children: ReactNode }) {
  return <div className="ib-note">{children}</div>;
}

export interface InboxPageProps {
  navigate: (to: string) => void;
}

export type InboxStatus = 'loading' | 'empty' | 'error' | 'ok';

export function resolveInboxStatus(input: {
  loading: boolean;
  error: boolean;
  hasVisibleContent: boolean;
  hasDiagnostic: boolean;
}): InboxStatus {
  if (input.loading) return 'loading';
  if (input.error) return 'error';
  if (!input.hasVisibleContent && !input.hasDiagnostic) return 'empty';
  return 'ok';
}

/** Loading → error → empty → content, one at a time (the order the page always had). */
function InboxGate({
  status,
  onRetry,
  empty,
  children,
}: {
  status: InboxStatus;
  onRetry: () => void;
  empty: ReactNode;
  children: ReactNode;
}) {
  if (status === 'loading') return <SkeletonLines rows={4} label="正在读取收件箱" />;
  if (status === 'error') return <RetryLine message="提议列表暂不可用。" onRetry={onRetry} />;
  if (status === 'empty') return empty;
  return children;
}

export default function InboxPage({ navigate }: InboxPageProps) {
  const {
    listDecisionProposalPage,
    listObservationProposalPreview,
    listAutoApplied,
    retractAutoApplied,
    retractProposal,
  } = useWorkbenchClient();
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const [reverting, setReverting] = useState<Record<string, true>>({});

  const queryClient = useQueryClient();
  const decisionQ = useInfiniteQuery(decisionQueryOptions(listDecisionProposalPage));
  const observationQ = useQuery({
    queryKey: queryKeys.observationProposals,
    queryFn: listObservationProposalPreview,
  });
  const [aaWindow, setAaWindow] = useState<AutoAppliedWindowKey>('today');
  const aaQ = useQuery({
    queryKey: [...queryKeys.autoAppliedProposals, aaWindow],
    queryFn: () => listAutoApplied(autoAppliedWindow(aaWindow)),
  });

  // 第一页 commit 后才开始逐页补齐；每次只发一个 continuation。失败时停住并把重试权交给
  // 用户，避免瞬时错误形成请求风暴。已加载卡片始终保持可操作。
  const [drain] = useState(() => new DecisionBacklogDrain(queryClient, listDecisionProposalPage));
  const backlog = useSyncExternalStore(drain.subscribe, drain.getSnapshot, drain.getSnapshot);

  // Errors go to the app-wide ui-next toast (ToastHost below; it closes itself after 4.5 s).
  const showError = (msg: string) => {
    showToast({ message: msg });
  };

  const decisionPages = decisionQ.data?.pages ?? EMPTY_DECISION_PAGES;
  const decisionPageParams = decisionQ.data?.pageParams ?? EMPTY_DECISION_PAGE_PARAMS;
  const decisionDiagnostics = useMemo(
    () => decisionPaginationDiagnostics(decisionPages, decisionPageParams),
    [decisionPages, decisionPageParams],
  );
  const rows = useMemo(() => {
    const pages = observationQ.data ? [...decisionPages, observationQ.data] : decisionPages;
    return mergeProposalPages(pages);
  }, [decisionPages, observationQ.data]);
  const observationTruncated =
    observationQ.data !== undefined && observationQ.data.next_cursor !== null;
  const observationUnavailable = observationQ.isError;
  // 强度分桶：C-strength → moved（C 块折叠），其余 → decide（B 块逐条人审）。
  const { decide, moved } = useMemo(() => bucketPendingByTier(rows), [rows]);

  // B 块 lane 顺序：按 KIND_META 键序稳定排列，未知 kind 追加在尾（绝不丢卡）。
  const laneKinds = useMemo(() => {
    const present = new Set(decide.map((r) => r.kind));
    const known = Object.keys(KIND_META).filter((k) => present.has(k));
    const unknown = [...present].filter((k) => !(k in KIND_META));
    return [...known, ...unknown];
  }, [decide]);

  const decideRemaining = decide.filter((r) => !resolved[r.id]).length;

  const autoApplied = aaQ.data?.rows ?? [];
  const breaker = aaQ.data?.breaker;
  // A 块在有 auto-applied 卡、熔断 tripped、或读模型出错（surface 错误而非静默空）时露出。
  // With the switch off nothing new applies, so only cards from before it can still need undoing.
  const autoApplyOn = decisionPages[0]?.auto_apply_enabled === true;
  const showTierA =
    autoApplied.length > 0 ||
    aaQ.isError ||
    aaWindow !== 'today' ||
    (autoApplyOn && (aaQ.isLoading || breaker?.tripped === true));

  const revertable = autoApplied.filter((row) => row.undo.status === 'revertable');
  const [confirmingBatch, setConfirmingBatch] = useState(false);
  const batch = useMutation({
    mutationFn: () => retractAutoApplied(revertable.map((row) => row.proposal_id).slice(0, 200)),
    onSettled: () => {
      setConfirmingBatch(false);
      return invalidateAfterProposalRetract(queryClient);
    },
  });

  const onRevert = async (proposalId: string) => {
    setReverting((r) => ({ ...r, [proposalId]: true }));
    try {
      await retractProposal(proposalId);
      // Retract turns the auto-applied proposal stale (never pending): only the A-lane digest
      // changes, and the infinite decision query is left alone.
      await invalidateAfterProposalRetract(queryClient);
    } catch (err) {
      showError(err instanceof Error ? err.message : '撤销失败，请重试。');
    } finally {
      setReverting((r) => {
        const next = { ...r };
        delete next[proposalId];
        return next;
      });
    }
  };

  // 只有裁决第一页阻塞整页；A 档与 C 档各自渐进加载。这样用户能先处理第一批待裁决项，
  // 同时 empty 仍须等补充读模型 settle，避免把“尚未返回”误报成“已清空”。
  const status = resolveInboxStatus({
    loading: decisionQ.isLoading,
    error: decisionQ.isError && decisionPages.length === 0,
    hasVisibleContent:
      decide.length > 0 || moved.length > 0 || autoApplied.length > 0 || aaQ.isError,
    hasDiagnostic:
      backlog.hasNextPage ||
      backlog.isFetchingNextPage ||
      backlog.isFetchNextPageError ||
      decisionDiagnostics.incomplete ||
      aaQ.isLoading ||
      observationQ.isLoading ||
      observationTruncated ||
      observationUnavailable,
  });

  const clearedEmpty = (
    <div className="ib-empty">
      <span className="ib-empty-icon" aria-hidden="true">
        <Check size={20} />
      </span>
      <p className="ib-empty-title">收件箱已清空</p>
      <p className="ib-empty-text">
        {autoApplyOn
          ? '所有提议都已裁决或自动处理。新提议会在下次 Dreaming session 后出现。'
          : '所有提议都已裁决。新提议会在下次 Dreaming session 后出现。'}
      </p>
      <Button onClick={() => navigate('/knowledge')}>
        <Network size={16} aria-hidden="true" />
        去看知识图
        <ArrowRight size={16} aria-hidden="true" />
      </Button>
    </div>
  );

  return (
    <UiNextRoot className="ib-page">
      <main className="ib-main un-m3e-bridge">
        <header className="ib-head">
          <h1 className="ib-title">收件箱</h1>
          <p className="ib-lead">
            {autoApplyOn
              ? 'AI 提议会按影响自动分流：安全可撤的建议已替你处理，需要判断的留在这里，提醒类信息归入 AI 观察。'
              : '需要判断的提议留在这里，提醒类信息归入 AI 观察。'}
          </p>
        </header>

        <InboxGate
          status={status}
          onRetry={() => {
            void decisionQ.refetch();
            void observationQ.refetch();
            void aaQ.refetch();
          }}
          empty={clearedEmpty}
        >
          {/* ── A 档 · 自动应用 + 熔断 ── */}
          {showTierA && (
            <section className="ib-tier" aria-labelledby="ib-tier-a">
              <TierHead tier="A" count={autoApplied.length} id="ib-tier-a" />
              {autoApplyOn && aaQ.isLoading && (
                <TierNote>
                  <output aria-live="polite">自动应用记录正在加载；待裁决提议不受影响。</output>
                </TierNote>
              )}
              {/* aaQ 失败显式 surface（CodeRabbit #2）：否则 A 档卡 + breaker 被当空数据静默
                  吞掉，用户以为没有自动应用项，实则 fetch 失败、撤销入口也丢了。 */}
              {aaQ.isError && (
                <RetryLine message="自动应用列表暂不可用。" onRetry={() => void aaQ.refetch()} />
              )}
              {autoApplyOn && breaker && <BreakerMeter breaker={breaker} />}
              <div className="ib-aa-summary">
                <fieldset className="ib-aa-windows">
                  <legend className="un-sr-only">看哪段时间</legend>
                  {AUTO_APPLIED_WINDOWS.map(({ key, label }) => (
                    <ChipToggle
                      key={key}
                      pressed={aaWindow === key}
                      onPressedChange={() => {
                        setAaWindow(key);
                        setConfirmingBatch(false);
                        batch.reset();
                      }}
                    >
                      {label}
                    </ChipToggle>
                  ))}
                </fieldset>
                <p className="ib-aa-banner">
                  <Zap size={16} aria-hidden="true" />
                  <span>
                    <b>{autoAppliedHeadline(autoApplied, aaQ.isLoading, aaWindow)}</b>
                    撤销只撤还没被用到的内容，已经被用到的会留着，并写明原因。
                  </span>
                </p>
                {revertable.length > 0 && !confirmingBatch ? (
                  <div className="ib-acts">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={batch.isPending}
                      onClick={() => {
                        batch.reset();
                        setConfirmingBatch(true);
                      }}
                    >
                      <Undo2 size={14} aria-hidden="true" />
                      撤销全部可撤的（{revertable.length}）
                    </Button>
                  </div>
                ) : null}
                {confirmingBatch ? (
                  <div className="ib-aa-confirm">
                    <p>撤销这 {revertable.length} 件？撤销时才确认有没有被用到，被用到的不会动。</p>
                    <div className="ib-acts">
                      <Button size="sm" disabled={batch.isPending} onClick={() => batch.mutate()}>
                        {batch.isPending ? '正在撤销…' : '确认撤销'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={batch.isPending}
                        onClick={() => setConfirmingBatch(false)}
                      >
                        先不撤
                      </Button>
                    </div>
                  </div>
                ) : null}
                {batch.data ? (
                  <p className="ib-aa-result" role="status">
                    {batchResultWords(batch.data.summary)}
                  </p>
                ) : null}
                {batch.isError ? (
                  <p className="ib-aa-result" role="alert">
                    这次没撤成，可以再试一次。
                  </p>
                ) : null}
              </div>
              {autoApplied.length > 0 && (
                <div className="ib-aa-list">
                  {autoApplied.map((row) => (
                    <AutoAppliedCard
                      key={row.proposal_id}
                      row={row}
                      reverting={reverting[row.proposal_id] === true}
                      onRevert={onRevert}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* ── B 档 · 逐条人审 ── */}
          <section className="ib-tier" aria-labelledby="ib-tier-b">
            <TierHead tier="B" count={decideRemaining} id="ib-tier-b" />
            {backlog.isFetchingNextPage && (
              <TierNote>
                <output aria-live="polite">
                  正在继续加载待裁决提议；已显示 {decide.length} 条，可以先处理。
                </output>
              </TierNote>
            )}
            {backlog.isFetchNextPageError && (
              <TierNote>
                <span>后续待裁决提议暂时无法加载；已显示的 {decide.length} 条仍可处理。</span>
                <button
                  type="button"
                  className="ib-note-btn un-hit"
                  onClick={drain.continueLoading}
                >
                  继续加载
                </button>
              </TierNote>
            )}
            {decisionDiagnostics.cursorRepeated && (
              <TierNote>
                <output>
                  待裁决分页返回了重复游标，已停止自动加载以免重复请求；当前 {decide.length}{' '}
                  条仍可处理，刷新后可重试。
                </output>
              </TierNote>
            )}
            {decisionDiagnostics.pageLimitReached && (
              <TierNote>
                <output>
                  待裁决积压超过本次安全加载上限；当前 {decide.length}{' '}
                  条仍可处理，处理后刷新即可继续。
                </output>
              </TierNote>
            )}
            {decide.length === 0 &&
              !backlog.isFetchingNextPage &&
              !backlog.isFetchNextPageError &&
              !decisionDiagnostics.incomplete && <TierNote>没有待裁决的提议。</TierNote>}
            {decide.length > 0 &&
              laneKinds.map((k) => {
                const laneRows = decide.filter((r) => r.kind === k);
                const live = laneRows.filter((r) => !resolved[r.id]).length;
                const meta = kindMeta(k);
                const LaneIcon = kindIcon(meta.icon);
                return (
                  <section key={k} className="ib-lane" aria-labelledby={`ib-lane-${k}`}>
                    <h3 id={`ib-lane-${k}`} className="ib-lane-head">
                      <span
                        className="ib-lane-ic"
                        data-tone={inboxTone(meta.tone)}
                        aria-hidden="true"
                      >
                        <LaneIcon size={14} />
                      </span>
                      {meta.label}
                      {live > 0 && <span className="ib-lane-count un-num">{live}</span>}
                    </h3>
                    <div className="ib-lane-cards">
                      {laneRows.map((p, i) => (
                        <ProposalCard
                          key={p.id}
                          p={p}
                          index={i}
                          resolved={resolved[p.id] ?? null}
                          navigate={navigate}
                          onResolve={(id, label) => setResolved((r) => ({ ...r, [id]: label }))}
                          onError={showError}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
          </section>

          {/* ── C 档 · 纯状态（折叠） ── */}
          {(observationQ.isLoading ||
            moved.length > 0 ||
            observationTruncated ||
            observationUnavailable) && (
            <section className="ib-tier" aria-labelledby="ib-tier-c">
              <TierHead tier="C" count={moved.length} id="ib-tier-c" />
              {observationQ.isLoading && (
                <TierNote>
                  <output aria-live="polite">AI 观察记录正在加载；上方待裁决提议不受影响。</output>
                </TierNote>
              )}
              {observationUnavailable && (
                <TierNote>
                  <output>AI 观察记录暂时无法加载；上方待裁决提议不受影响，可以继续处理。</output>
                </TierNote>
              )}
              {observationTruncated && (
                <TierNote>
                  AI 观察当前显示前 {moved.length}{' '}
                  条，还有更多记录未在本页展开；待裁决提议不受影响。
                </TierNote>
              )}
              {moved.length > 0 && <TierCBlock items={moved} navigate={navigate} />}
            </section>
          )}
        </InboxGate>
      </main>
      <ToastHost />
    </UiNextRoot>
  );
}
