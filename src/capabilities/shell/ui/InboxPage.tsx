// M4-T6 (YUK-319/YUK-318)：收件箱页。YUK-521 (A4 强度轴) 重构为三档分流：
//   A 自动应用（completion；后台静默物化 + 撤销窗口，卡来自 /api/proposals/auto-applied，
//     撤销复用既有 retractProposal —— 无新撤销逻辑）+ 裁决熔断 meter/banner；
//   B 逐条人审（真裁决项，复用既有 ProposalCard；含 breaker 退回 B 的 completion）；
//   C 纯状态（无 accept applier 的 defer/archive/judge_retraction；折叠链到 AI 观察面）。
// tier 映射以 core 强度表为单一真相（inbox-tier.ts），不照抄设计稿 v0 的 INBOX_TIER。
// 设计基准 docs/design/loom-refresh/project/screen-inbox-a4.jsx + inbox-a4.css（PORT 进
// shell.css）。偏差（design pre-flight 预批）：①不渲 demo window 全局数据，A 块走真读模型；
// ②C 块「去向」用 KIND_META label + reason_md（真 wire，非设计 demo 文案）。

import { getTree } from '@/capabilities/knowledge/ui/knowledge-api';
import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful, type StatefulStatus } from '@/ui/primitives/Stateful';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { ProposalCard } from './ProposalCard';
import {
  type AutoAppliedRowWire,
  KIND_META,
  type ProposalInboxRow,
  type VerdictBreakerWire,
  kindMeta,
  listAutoApplied,
  listProposals,
  retractProposal,
} from './inbox-api';
import { TIER_META, autoAppliedState, bucketPendingByTier, undoRemainingMs } from './inbox-tier';
import './shell.css';

function tierIcon(name: string): LoomIconName {
  return name as LoomIconName;
}

function formatWindowLabel(windowMs: number): string {
  const minutes = Math.round(windowMs / 60_000);
  if (minutes % 60 === 0) return `近 ${minutes / 60} 小时`;
  return `近 ${minutes} 分钟`;
}

// A 档卡的窗口脚注文案（早返，避免链式三元 — 项目红线）。
function windowText(state: 'live' | 'consumed' | 'reverted', remainingMinutes: number): string {
  if (state === 'reverted') return '已撤销 · 恢复到应用前';
  if (state === 'consumed') return '已无法干净撤销';
  return `${remainingMinutes} 分钟内可撤销`;
}

function TierHead({ tier, count }: { tier: 'A' | 'B' | 'C'; count: number }) {
  const m = TIER_META[tier];
  return (
    <div className="tier-head">
      <span className={`tier-no tone-${m.tone}`}>{tier}</span>
      <div className="tier-head-txt">
        <div className="tier-title">
          {m.label}
          <span className="tier-count">· {count} 项</span>
        </div>
        <div className="tier-sub">{m.sub}</div>
      </div>
    </div>
  );
}

function BreakerMeter({ breaker }: { breaker: VerdictBreakerWire }) {
  const windowLabel = formatWindowLabel(breaker.window);
  const pct = breaker.cap > 0 ? Math.min(100, (breaker.applied / breaker.cap) * 100) : 0;
  return (
    <div className={`aa-breaker ${breaker.tripped ? 'tripped' : 'ok'}`}>
      <LoomIcon name={breaker.tripped ? 'alert' : 'check'} size={16} className="ico" />
      <div className="aa-breaker-txt">
        {breaker.tripped ? (
          <>
            <b>自动应用已暂停。</b>
            {windowLabel}内自动操作触顶（{breaker.applied}/{breaker.cap}），为防失控已退回全人审 ——
            下面 B 档的项需要你逐条确认。
          </>
        ) : (
          <>
            <b>自动通道正常。</b>auto-apply 在阈值内，安全可逆的小操作不占你的裁决队列。
          </>
        )}
        <div className="aa-breaker-meter">
          <span className="aa-breaker-track">
            <span className="aa-breaker-fill" style={{ width: `${pct}%` }} />
          </span>
          {breaker.applied} / {breaker.cap} · {windowLabel}
        </div>
      </div>
    </div>
  );
}

function AutoAppliedCard({
  row,
  nowMs,
  reverting,
  onRevert,
}: {
  row: AutoAppliedRowWire;
  nowMs: number;
  reverting: boolean;
  onRevert: (proposalId: string) => void;
}) {
  const [trace, setTrace] = useState(false);
  const appliedMs = Date.parse(row.applied_at);
  const state = autoAppliedState(appliedMs, nowMs, row.reverted);
  const consumed = state === 'consumed';
  // A 档当前唯一 kind 是 completion；用其 KIND_META 取 label/icon。
  const meta = kindMeta('completion');
  const remainingMinutes = Math.max(1, Math.ceil(undoRemainingMs(appliedMs, nowMs) / 60_000));
  // 撤销按钮 label（if/else 替链式三元，守项目「禁链式三元」OCR 红线）。
  let revertLabel: string;
  if (consumed) revertLabel = '已无法干净撤销';
  else if (reverting) revertLabel = '撤销中…';
  else revertLabel = '撤销';
  return (
    <div className={`aa-card ${state}`}>
      <span className="aa-ic">
        <LoomIcon name={consumed ? 'lock' : tierIcon(meta.icon)} size={16} />
      </span>
      <div className="aa-body">
        <div className="aa-top">
          <span className="aa-kind">{meta.label}</span>
          <span className="aa-title">{row.title}</span>
        </div>
        <p className="aa-text">自动判定为完成并已记录 · 安全可逆，不放心的窗口内一键撤回即可。</p>
        {trace && (
          <div className="aa-trace">
            来自 <b>completion</b> · 干净可逆 · proposal：
            <code className="evt">{row.proposal_id.slice(0, 10)}</code>
            <br />
            静态可逆性兜底 · 非 confidence 判定（apply 档位 {row.level}）
          </div>
        )}
        <div className="aa-foot">
          {state === 'reverted' ? (
            <span className="aa-window">
              <LoomIcon name="undo" size={13} />
              已撤销 · 恢复到应用前
            </span>
          ) : (
            <>
              <span className={`aa-window ${state}`}>
                <LoomIcon name={consumed ? 'alert' : 'clock'} size={13} />
                {windowText(state, remainingMinutes)}
              </span>
              <button
                type="button"
                className="aa-revert"
                disabled={consumed || reverting}
                onClick={() => onRevert(row.proposal_id)}
              >
                <LoomIcon name="undo" size={13} />
                {revertLabel}
              </button>
            </>
          )}
          <button
            type="button"
            className="aa-link"
            onClick={() => setTrace((v) => !v)}
            style={{ marginLeft: 'auto' }}
          >
            <LoomIcon name="history" size={13} />
            追溯
          </button>
        </div>
      </div>
    </div>
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
  return (
    <div className={`co-fold${open ? ' open' : ''}`}>
      <button
        type="button"
        className="co-bar"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="ec-ic">
          <LoomIcon name="archive" size={16} />
        </span>
        <span>
          <span className="co-t">{items.length} 项纯状态变更已自动处理</span>
          <span className="co-s">
            {open
              ? 'snooze / 软归档 / 移到旁观 —— 都没占你的裁决队列'
              : '展开看它们去哪了 · 不需要你裁决'}
          </span>
        </span>
        <LoomIcon name="chevronDown" size={18} className="co-chev" />
      </button>
      {open && (
        <div className="co-body">
          {items.map((it) => {
            const meta = kindMeta(it.kind);
            return (
              <div key={it.id} className="co-row">
                <span className="co-row-ic">
                  <LoomIcon name={tierIcon(meta.icon)} size={14} />
                </span>
                <div className="co-row-body">
                  <div className="co-row-top">
                    <span className="co-row-title">{meta.label}</span>
                    <span className="co-row-act">已自动处理</span>
                  </div>
                  <div className="co-row-text">{it.payload.reason_md}</div>
                </div>
              </div>
            );
          })}
          <button
            type="button"
            className="aa-link"
            onClick={() => navigate('/today')}
            style={{ alignSelf: 'flex-start' }}
          >
            <LoomIcon name="eye" size={14} />去 AI 观察面回看
          </button>
        </div>
      )}
    </div>
  );
}

export interface InboxPageProps {
  navigate: (to: string) => void;
}

export default function InboxPage({ navigate }: InboxPageProps) {
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const [reverting, setReverting] = useState<Record<string, true>>({});
  const [toast, setToast] = useState<string | null>(null);

  const q = useQuery({ queryKey: ['proposals', 'pending'], queryFn: listProposals });
  const aaQ = useQuery({ queryKey: ['proposals', 'auto-applied'], queryFn: listAutoApplied });
  const treeQ = useQuery({ queryKey: ['knowledge-tree'], queryFn: getTree });

  const nameOf = useMemo(() => {
    const map = new Map((treeQ.data?.rows ?? []).map((n) => [n.id, n.name]));
    return (id: string) => map.get(id) ?? id.slice(0, 8);
  }, [treeQ.data]);

  const showError = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 5000);
  };

  const rows = q.data?.rows ?? [];
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
  const nowMs = Date.now();
  // A 块仅在有 auto-applied 卡或熔断 tripped 时露出（否则不堆叠空 meter）。
  const showTierA = autoApplied.length > 0 || breaker?.tripped === true;

  const onRevert = async (proposalId: string) => {
    setReverting((r) => ({ ...r, [proposalId]: true }));
    try {
      await retractProposal(proposalId);
      await Promise.all([aaQ.refetch(), q.refetch()]);
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

  const status: StatefulStatus = q.isLoading
    ? 'loading'
    : q.isError
      ? 'error'
      : decide.length === 0 && moved.length === 0 && autoApplied.length === 0
        ? 'empty'
        : 'ok';

  const clearedEmpty = (
    <EmptyState
      icon="checkCircle"
      title="收件箱已清空"
      text="所有提议都已裁决或自动处理。新提议会在下次 Dreaming session 后出现。"
      action={
        <Btn variant="secondary" iconEnd="arrow" onClick={() => navigate('/knowledge')}>
          去看知识图
        </Btn>
      }
    />
  );

  return (
    <main className="page wide inbox-loom">
      <header className="page-head">
        <div className="eyebrow">INBOX · AI 提议 · 按出手强度分流</div>
        <h1 className="page-title serif">收件箱</h1>
        <p className="page-lead">
          AI 提议按「可逆性 × 后果」分三档：A 安全可逆的已替你做了（窗口内可撤）、B 真裁决项逐条
          accept / dismiss、C 纯状态变更已移出队列。
        </p>
      </header>

      <Stateful
        status={status}
        onRetry={() => void q.refetch()}
        errorText="提议列表暂不可用。"
        skeleton={<SkLines rows={4} />}
        empty={clearedEmpty}
      >
        {/* ── A 档 · 自动应用 + 熔断 ── */}
        {showTierA && (
          <section>
            <TierHead tier="A" count={autoApplied.length} />
            {breaker && <BreakerMeter breaker={breaker} />}
            {autoApplied.length > 0 && (
              <div className="aa-banner">
                <LoomIcon name="bolt" size={18} className="ico" />
                <div className="aa-banner-txt">
                  <b>这些已经替你做了。</b>
                  都是安全可逆的小操作，没占用你的裁决队列 —— 不放心的，窗口内一键撤回即可。
                </div>
              </div>
            )}
            {autoApplied.map((row) => (
              <AutoAppliedCard
                key={row.proposal_id}
                row={row}
                nowMs={nowMs}
                reverting={reverting[row.proposal_id] === true}
                onRevert={onRevert}
              />
            ))}
          </section>
        )}

        {/* ── B 档 · 逐条人审 ── */}
        <section>
          <TierHead tier="B" count={decideRemaining} />
          {decide.length === 0 ? (
            <LoomCard pad sunk>
              <div className="meta">没有待裁决的提议。</div>
            </LoomCard>
          ) : (
            laneKinds.map((k) => {
              const laneRows = decide.filter((r) => r.kind === k);
              const live = laneRows.filter((r) => !resolved[r.id]).length;
              const meta = kindMeta(k);
              return (
                <section key={k}>
                  <SectionLabel count={live || null}>
                    <span className="inbox-lane-label">
                      <span className={`lane-ic tone-${meta.tone}`}>
                        <LoomIcon name={tierIcon(meta.icon)} size={14} />
                      </span>
                      {meta.label}
                    </span>
                  </SectionLabel>
                  <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
                    {laneRows.map((p, i) => (
                      <ProposalCard
                        key={p.id}
                        p={p}
                        index={i}
                        resolved={resolved[p.id] ?? null}
                        nameOf={nameOf}
                        navigate={navigate}
                        onResolve={(id, label) => setResolved((r) => ({ ...r, [id]: label }))}
                        onError={showError}
                      />
                    ))}
                  </div>
                </section>
              );
            })
          )}
        </section>

        {/* ── C 档 · 纯状态（折叠） ── */}
        {moved.length > 0 && (
          <section>
            <TierHead tier="C" count={moved.length} />
            <TierCBlock items={moved} navigate={navigate} />
          </section>
        )}
      </Stateful>

      {toast && (
        <div className="pf-toasts" aria-live="polite">
          <div className="pf-toast t-info">
            <LoomIcon name="close" size={15} className="ico" />
            <span>{toast}</span>
          </div>
        </div>
      )}
    </main>
  );
}
