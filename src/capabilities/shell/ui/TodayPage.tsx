// M4-T6 (YUK-319)：工作台页 host（today 重生）。
// 设计基准 docs/design/loom-refresh/project/screen-today.jsx（ScreenToday
// L203-241 布局序列）：hero → kpi-row → 今日之线 → 进行中·待裁决 dash-grid
// 双列 → AgentNotesBoard → 本周编织。数据源 /api/workbench/summary 聚合 +
// agency 包 agent-notes（limit=20 紧凑档）+ notes 包 AI 改动近 24h。
// 偏差（today 重生设计自由）：①「今日之线」真数据无 threads 源，从 summary
// 派生（due>0 复习缕 / proposals>0 裁决缕），全零不渲染该 section；②成本面
// （设计稿 CostRibbon）已于 M5-T4b (YUK-321) 接通 /api/cost/today
// （observability 包端点）；设计稿的预算线（budget + bar 占比）无数据源，
// 见 CostRibbon 组件注释。

import { AgentNotesBoard } from '@/capabilities/agency/ui/AgentNotesBoard';
import type { AgentNotesResponse } from '@/capabilities/agency/ui/types';
import ColdStart from '@/capabilities/onboarding/ui/ColdStart';
import { apiJson } from '@/ui/lib/api';
import { Btn } from '@/ui/primitives/Btn';
import { LoomBadge } from '@/ui/primitives/LoomBadge';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful, type StatefulStatus } from '@/ui/primitives/Stateful';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { PrepDeskConjectures } from './PrepDeskConjectures';
import { ProbeAnswers } from './ProbeAnswers';
import { AiChangesStrip } from './blocks/AiChangesStrip';
import { KpiRow } from './blocks/KpiRow';
import { LoomHero } from './blocks/LoomHero';
import { ProfileBand } from './blocks/ProfileBand';
import { ProposalStrip } from './blocks/ProposalStrip';
import { SessionsStrip } from './blocks/SessionsStrip';
import { WeekHeat } from './blocks/WeekHeat';
import { getActiveProbes } from './probe-answer-api';
import {
  type OvernightDigest,
  type WorkbenchSummary,
  getOvernightDigest,
  getWorkbenchSummary,
} from './workbench-api';
import './shell.css';

export interface TodayPageProps {
  navigate: (to: string) => void;
}

interface Thread {
  id: string;
  label: string;
  title: string;
  sub: string;
  cta: string;
  badge: string;
  icon: LoomIconName;
  tone: 'coral' | 'info' | 'good' | 'hard' | 'neutral';
  route: string;
}

// 「今日之线」派生：设计稿 DATA.threads 是策展假数据；真数据从 summary 聚合
// 派生两缕（复习/裁决），未来夜链交班缕随 M5 task_run 读模型补。
function deriveThreads(s: WorkbenchSummary): Thread[] {
  const threads: Thread[] = [];
  if (s.kpi.due_count > 0) {
    threads.push({
      id: 'review',
      label: '复习',
      title: `${s.kpi.due_count} 个学习项到期`,
      sub: 'FSRS 排程把它们排进了今天的队列。',
      cta: '开始复习',
      badge: `${s.kpi.due_count} 项`,
      icon: 'review',
      tone: 'coral',
      route: '/practice',
    });
  }
  if (s.proposals.total > 0) {
    threads.push({
      id: 'inbox',
      label: '裁决',
      title: `${s.proposals.total} 条 AI 提议待审`,
      sub: '逐条 accept / dismiss，每次裁决写入一条事件。',
      cta: '去收件箱',
      badge: `${s.proposals.total} 条`,
      icon: 'inbox',
      tone: 'info',
      route: '/inbox',
    });
  }
  return threads;
}

// 成本面（设计稿 CostRibbon，screen-today.jsx L153-178）：M5-T4b (YUK-321)
// 接通 /api/cost/today（observability 包）。字段对齐
// src/capabilities/observability/api/cost-today.ts 的 Response.json 形状。
// Phase-deferred：设计稿的预算线（card-head 预算 meta + bar 占比条）无数据源
// ——预算配置尚不存在，不 mock；随预算护栏（warning 水位）落地后补，届时回
// 设计稿 screen-today.jsx CostRibbon 取 DOM。quiet-empty 语义保留：零成本不噪。
// YUK-359: spend is grouped by currency (USD = mimo/runner, CNY = GLM-OCR /
// memory reconcile) — never a single cross-currency sum.
// YUK-330: the per-currency amount key is `cost` (unified with /api/_/admin/cost
// and the cost_ledger.cost source column); cost-today previously sent `spend`.
interface CurrencySpend {
  currency: string;
  cost: number;
}
interface CostTodayResponse {
  window: { from: number; to: number; label: string };
  today: {
    by_currency: CurrencySpend[];
    tokens_in: number;
    tokens_out: number;
    ledger_rows: number;
    tool_calls: number;
    by_task: Array<{ task_kind: string; calls: number; by_currency: CurrencySpend[] }>;
  };
}

const CURRENCY_SYMBOL: Record<string, string> = { USD: '$', CNY: '¥' };

// 成本格式跟设计稿 $X.XX，但 cost_ledger.cost 常见 sub-cent 单价——直接
// toFixed(2) 会把非零花费渲染成 $0.00，与 quiet-empty 的「真零」语义混淆。
// 非零但不足半分时显式标 <{sym}0.01，金额可信度优先于格式统一。
function fmtSpend(spend: number, currency = 'USD'): string {
  const sym = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  if (spend > 0 && spend < 0.005) return `<${sym}0.01`;
  return `${sym}${spend.toFixed(2)}`;
}

// Render per-currency spend list (e.g. "$0.42 · ¥1.20"); empty → 真零 $0.00.
function fmtByCurrency(rows: CurrencySpend[]): string {
  if (rows.length === 0) return fmtSpend(0);
  return rows.map((r) => fmtSpend(r.cost, r.currency)).join(' · ');
}

function CostRibbon() {
  const q = useQuery({
    queryKey: ['cost-today'],
    queryFn: () => apiJson<CostTodayResponse>('/api/cost/today'),
  });
  const t = q.data?.today;
  const isEmpty = t !== undefined && t.ledger_rows === 0 && t.tool_calls === 0;
  const status: StatefulStatus = q.isLoading
    ? 'loading'
    : q.isError
      ? 'error'
      : isEmpty
        ? 'empty'
        : 'ok';
  return (
    <LoomCard pad>
      <div className="card-head">
        <span className="card-icon">
          <LoomIcon name="bolt" size={18} />
        </span>
        <div className="card-title">今日 AI 成本</div>
      </div>
      <Stateful
        status={status}
        onRetry={() => void q.refetch()}
        errorText="成本服务暂不可用。"
        skeleton={<SkLines rows={1} />}
        empty={<div className="quiet-empty">今日尚无 AI 花费。</div>}
      >
        {t && (
          <>
            <div className="cost-top">
              <div className="cost-amt serif tnum">{fmtByCurrency(t.by_currency)}</div>
            </div>
            <div className="cost-tasks">
              {t.by_task.map((row) => (
                <span key={row.task_kind} className="chip">
                  <span className="mono">{row.task_kind}</span>{' '}
                  <b className="mono">{fmtByCurrency(row.by_currency)}</b>
                </span>
              ))}
            </div>
            <div className="cost-foot nowrap-meta mono">
              tokens {(t.tokens_in / 1000).toFixed(1)}k in · {(t.tokens_out / 1000).toFixed(1)}k out
              · {t.tool_calls} tool calls
            </div>
          </>
        )}
      </Stateful>
    </LoomCard>
  );
}

// YUK-520 (A1 夜窗 digest) — 最小交班缕（富叙事缕本期 DEFER，先把数据 + 空夜态通电）。
// 设计参考 docs/design/loom-refresh/project/screen-today-handoff.jsx（HandoffThread / 空夜态）
// + handoff-band.jsx：本期最小化为 LoomCard + 计数 chips + 空夜态，按 Loom primitives 落地
// （不整文件 PORT）。富叙事缕（MasteryBand / 团队复盘 / 追溯 / narrative_threads）二期补。
//
// 红线（YUK-520 ②⑤）：空夜态（has_overnight_activity===false）是一等态，与加载中/失败显式可
// 区分，**绝不落回 ColdStart**——本带是 workbench 块的子组件（仅在非空证据态渲染），其空夜
// 分支只渲染 quiet-empty，永不触发冷开屏。additive 叠加，不动既有 hero/今日之线/双列/热力。

// 链式三元会被 OCR flag（项目规则禁嵌套/链式三元）——用 if/else 函数算状态。
function statefulStatus(isLoading: boolean, isError: boolean): StatefulStatus {
  if (isLoading) return 'loading';
  if (isError) return 'error';
  return 'ok';
}

interface DigestChip {
  key: string;
  icon: LoomIconName;
  label: string;
  count: number;
}

function buildDigestChips(d: OvernightDigest): DigestChip[] {
  const runsTotal = d.runs.reduce((acc, g) => acc + g.count, 0);
  const chips: DigestChip[] = [];
  if (runsTotal > 0)
    chips.push({ key: 'runs', icon: 'sparkle', label: '夜间任务', count: runsTotal });
  if (d.note_changes_count > 0)
    chips.push({ key: 'notes', icon: 'doc', label: '笔记精炼', count: d.note_changes_count });
  if (d.new_proposals_count > 0)
    chips.push({
      key: 'proposals',
      icon: 'inbox',
      label: '图谱提议',
      count: d.new_proposals_count,
    });
  if (d.new_conjectures_count > 0)
    chips.push({
      key: 'conjectures',
      icon: 'teach',
      label: '备课猜想',
      count: d.new_conjectures_count,
    });
  if (d.agent_notes_count > 0)
    chips.push({ key: 'agent_notes', icon: 'eye', label: '代理观察', count: d.agent_notes_count });
  return chips;
}

function OvernightDigestBand({ navigate }: { navigate: (to: string) => void }) {
  // YUK-567 — the 备课猜想 chip toggles an inline 备课台 conjecture panel (pull, not
  // push): the team's prepared conjectures surface only when the owner opens them.
  const [conjOpen, setConjOpen] = useState(false);
  // YUK-567 slice-2 — 待你试做 probe queue: its own query (shared ['prep-desk-probes']
  // key with ProbeAnswers → react-query dedupes), independent of overnight activity so a
  // served probe is always reachable.
  const [probeOpen, setProbeOpen] = useState(false);
  const q = useQuery({ queryKey: ['overnight-digest'], queryFn: getOvernightDigest });
  const probesQ = useQuery({ queryKey: ['prep-desk-probes'], queryFn: getActiveProbes });
  const activeProbes = probesQ.data?.probes ?? [];
  const status = statefulStatus(q.isLoading, q.isError);
  const d = q.data;
  // If accepting/rejecting the last conjecture drops the count to 0, the 备课猜想
  // toggle chip disappears (buildDigestChips gates on >0) — auto-collapse so the
  // panel is never stranded open with no way to close it (CodeRabbit review-782).
  useEffect(() => {
    if (conjOpen && d?.new_conjectures_count === 0) setConjOpen(false);
  }, [d?.new_conjectures_count, conjOpen]);
  useEffect(() => {
    // Auto-collapse when the last probe is answered (mirrors the conjecture panel).
    if (probeOpen && activeProbes.length === 0) setProbeOpen(false);
  }, [activeProbes.length, probeOpen]);
  const chips = d ? buildDigestChips(d) : [];
  const canDecide = !!d && (d.new_proposals_count > 0 || d.new_conjectures_count > 0);
  return (
    <>
      <SectionLabel>夜链 · 交班</SectionLabel>
      <LoomCard pad>
        <div className="card-head">
          <span className="card-icon accent">
            <LoomIcon name="moon" size={18} />
          </span>
          <div className="card-title">昨夜 AI 替你做了什么</div>
        </div>
        <Stateful
          status={status}
          onRetry={() => void q.refetch()}
          errorText="夜链交班暂不可用。"
          skeleton={<SkLines rows={2} />}
        >
          {/* YUK-580：静默失败标红。degraded_kinds 非空时 activity 必为 true（error runs
              计入 runs_total，非独立信号）；这里的「独立渲染」只是指标红 badge 不挂在
              has_overnight_activity 的条件分支下（既有 LoomBadge tone="again" + LoomIcon
              "alert" primitives，同 observability 面 <Badge tone="again">error</Badge>
              口径，无新组件）。marginBottom 仅在下方 activity chips 行也会渲染时补一档
              纵向间距（既有 inline style 约定，见 L437 marginLeft），避免两行 .digest-chips
              贴在一起。 */}
          {d && d.degraded_kinds.length > 0 && (
            <div
              className="digest-chips"
              style={d.has_overnight_activity ? { marginBottom: 'var(--s-2)' } : undefined}
            >
              {d.degraded_kinds.map((dk) => (
                <LoomBadge
                  key={dk.task_kind}
                  tone="again"
                  title={dk.recent_error_messages.join('\n')}
                >
                  <LoomIcon name="alert" size={12} /> {dk.task_kind} 失败 {dk.error_count} 次
                </LoomBadge>
              ))}
            </div>
          )}
          {d && !d.has_overnight_activity && (
            <div className="quiet-empty">
              昨夜没有需要交班的活动 —— 团队会在你持续学习后，开始为你做夜间复盘。
            </div>
          )}
          {d?.has_overnight_activity && (
            <>
              <div className="digest-chips">
                {chips.map((c) =>
                  c.key === 'conjectures' ? (
                    // 备课猜想 chip → toggle the inline 备课台 panel (§3 pull-not-push).
                    <button
                      key={c.key}
                      type="button"
                      className={`chip chip-toggle${conjOpen ? ' is-open' : ''}`}
                      onClick={() => setConjOpen((o) => !o)}
                      aria-expanded={conjOpen}
                    >
                      <LoomIcon name={c.icon} size={14} /> {c.label}{' '}
                      <b className="mono">{c.count}</b>
                      <LoomIcon name="chevronDown" size={13} className="pd-chev" />
                    </button>
                  ) : (
                    <span key={c.key} className="chip">
                      <LoomIcon name={c.icon} size={14} /> {c.label}{' '}
                      <b className="mono">{c.count}</b>
                    </span>
                  ),
                )}
              </div>
              {conjOpen && (
                <div className="prep-desk-expand">
                  <PrepDeskConjectures />
                </div>
              )}
              {canDecide && (
                <div className="digest-foot">
                  <Btn
                    size="sm"
                    variant="secondary"
                    iconEnd="arrow"
                    onClick={() => navigate('/inbox')}
                  >
                    去裁决
                  </Btn>
                </div>
              )}
            </>
          )}
        </Stateful>
      </LoomCard>
      {activeProbes.length > 0 && (
        <div className="probe-queue">
          {/* 待你试做 —— served probes to answer. Chip driven by the probes query
              (not the overnight digest), so it's reachable even after the 备课猜想 panel
              auto-collapses. Answering the last one auto-collapses this too. */}
          <button
            type="button"
            className={`chip chip-toggle${probeOpen ? ' is-open' : ''}`}
            onClick={() => setProbeOpen((o) => !o)}
            aria-expanded={probeOpen}
          >
            <LoomIcon name="quiz" size={14} /> 待你试做{' '}
            <b className="mono">{activeProbes.length}</b>
            <LoomIcon name="chevronDown" size={13} className="pd-chev" />
          </button>
          {probeOpen && (
            <div className="prep-desk-expand">
              <ProbeAnswers />
            </div>
          )}
        </div>
      )}
    </>
  );
}

function ThreadCard({ th, navigate }: { th: Thread; navigate: (to: string) => void }) {
  return (
    <LoomCard hover pad className="thread-card" onClick={() => navigate(th.route)}>
      <div className="thread-top">
        <span className={`card-icon accent thread-ic tone-${th.tone}`}>
          <LoomIcon name={th.icon} size={18} />
        </span>
        <LoomBadge tone={th.tone}>{th.badge}</LoomBadge>
        <LoomIcon name="arrow" size={16} className="thread-arrow" />
      </div>
      <div className="thread-label meta">{th.label}</div>
      <div className="thread-title serif">{th.title}</div>
      <div className="thread-sub">{th.sub}</div>
      <div className="thread-cta">
        {th.cta} <LoomIcon name="arrow" size={14} />
      </div>
    </LoomCard>
  );
}

export default function TodayPage({ navigate }: TodayPageProps) {
  const [active, setActive] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const now = new Date();

  useEffect(() => {
    const id = requestAnimationFrame(() => setActive(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const summaryQ = useQuery({ queryKey: ['workbench-summary'], queryFn: getWorkbenchSummary });
  // queryKey 与 /agent-notes 全量页（['agent-notes','full']，limit=50）分档，
  // 避免互相覆盖缓存。
  const notesQ = useQuery({
    queryKey: ['agent-notes', 'board'],
    queryFn: () => apiJson<AgentNotesResponse>('/api/agents/notes?limit=20'),
    // ColdStart 不渲染 notes；与服务端 cold_start 合同共用一个门，避免 UI 再推导空态。
    enabled: summaryQ.data?.cold_start.is_empty === false,
  });

  const placeholder = (text: string) => {
    setToast(text);
    setTimeout(() => setToast(null), 5000);
  };

  const summaryStatus: StatefulStatus = summaryQ.isLoading
    ? 'loading'
    : summaryQ.isError
      ? 'error'
      : 'ok';
  const s = summaryQ.data;
  const threads = s ? deriveThreads(s) : [];

  // YUK-621：冷启动只认服务端聚合后的「所有学习证据皆空」。没有 active goal
  // 仍可正常查看题库、复习、历史与提议；loading / error 继续走 Stateful。
  if (s?.cold_start.is_empty) {
    return <ColdStart navigate={navigate} />;
  }

  return (
    <main className="page wide today-page today-loom">
      <LoomHero
        navigate={navigate}
        onCopilot={() => placeholder('Copilot 随 M5 收编后在新栈接通——当前请走旧页。')}
      />

      <Stateful
        status={summaryStatus}
        onRetry={() => void summaryQ.refetch()}
        errorText="工作台聚合暂不可用。"
        skeleton={<SkLines rows={4} />}
      >
        {s && (
          <>
            {/* YUK-520 (A1) — 最小交班缕：workbench 块首位（今日之线 layer ①）。仅在非冷启
                （cold_start=false）渲染，空夜态永不落 ColdStart。 */}
            <OvernightDigestBand navigate={navigate} />

            <KpiRow
              kpi={s.kpi}
              proposalsTotal={s.proposals.total}
              active={active}
              navigate={navigate}
              onPlaceholder={placeholder}
            />

            {/* YUK-476 起始画像卡片：active goal 存在时露出 per-KC band 摘要 + /profile 持久入口。
                无 active goal 时只省略画像，不影响其余工作台。 */}
            {s.active_goal && <ProfileBand goal={s.active_goal} navigate={navigate} />}

            {threads.length > 0 && (
              <>
                <SectionLabel count={`${threads.length} 缕`}>今日之线</SectionLabel>
                <div className="threads-grid stagger">
                  {threads.map((th) => (
                    <ThreadCard key={th.id} th={th} navigate={navigate} />
                  ))}
                </div>
              </>
            )}

            <SectionLabel>进行中 · 待裁决</SectionLabel>
            <div className="dash-grid">
              <div className="dash-col">
                <SessionsStrip sessions={s.active_sessions} now={now} navigate={navigate} />
                <AiChangesStrip now={now} />
              </div>
              <div className="dash-col">
                <ProposalStrip proposals={s.proposals} navigate={navigate} />
                <CostRibbon />
              </div>
            </div>
          </>
        )}
      </Stateful>

      <AgentNotesBoard
        notes={notesQ.data?.rows ?? []}
        status={notesQ.isLoading ? 'loading' : notesQ.isError ? 'error' : 'ok'}
        now={now}
        onRetry={() => void notesQ.refetch()}
        onNavigate={navigate}
      />

      {s && (
        <>
          <SectionLabel>本周编织</SectionLabel>
          <LoomCard pad>
            <div className="card-head">
              <span className="card-icon accent">
                <LoomIcon name="target" size={18} />
              </span>
              <div className="card-title">7 天活动热力</div>
              <span className="badge tone-neutral" style={{ marginLeft: 'auto' }}>
                共 {s.week_heat.reduce((acc, d) => acc + d.count, 0)} 次活动
              </span>
            </div>
            <WeekHeat heat={s.week_heat} />
          </LoomCard>
        </>
      )}

      {toast && (
        <div className="pf-toasts" aria-live="polite">
          <div className="pf-toast t-info">
            <LoomIcon name="sparkle" size={15} className="ico" />
            <span>{toast}</span>
          </div>
        </div>
      )}
    </main>
  );
}
