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
import { apiJson } from '@/ui/lib/api';
import { LoomBadge } from '@/ui/primitives/LoomBadge';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful, type StatefulStatus } from '@/ui/primitives/Stateful';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { AiChangesStrip } from './blocks/AiChangesStrip';
import { KpiRow } from './blocks/KpiRow';
import { LoomHero } from './blocks/LoomHero';
import { ProposalStrip } from './blocks/ProposalStrip';
import { SessionsStrip } from './blocks/SessionsStrip';
import { WeekHeat } from './blocks/WeekHeat';
import { type WorkbenchSummary, getWorkbenchSummary } from './workbench-api';
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
interface CurrencySpend {
  currency: string;
  spend: number;
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
  return rows.map((r) => fmtSpend(r.spend, r.currency)).join(' · ');
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
            <KpiRow
              kpi={s.kpi}
              proposalsTotal={s.proposals.total}
              active={active}
              navigate={navigate}
              onPlaceholder={placeholder}
            />

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
