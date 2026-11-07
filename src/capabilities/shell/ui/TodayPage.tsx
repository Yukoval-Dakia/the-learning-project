// YUK-1713 / YUK-1473 — Today (/today), M3E presentation: the overnight band, the AI failure
// flags, the cost card, the week heat and the page frame moved off the old base. Styles in
// today-m3e.css; design record docs/design/2026-11-03-today-finish-m3e.md. Queries, keys,
// counts, navigation targets and the cold-start gate are unchanged.

import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  ChevronDown,
  CircleAlert,
  Eye,
  FileQuestion,
  FileText,
  GraduationCap,
  Inbox,
  type LucideIcon,
  Moon,
  Sparkles,
  Target,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import type {
  AgentNoteClient,
  AgentNotesBoard,
  LearningIntentComposer,
} from '@/capabilities/agency/ui-public';
import type { ColdStart } from '@/capabilities/onboarding/ui-public';
import { describeCosts } from '@/ui/lib/cost-presentation';
import { openCopilot } from '@/ui/lib/use-copilot-dwell';
import { queryKeys } from '@/ui/lib/write-invalidation';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button } from '@/ui-next/public';
import { TodayHeader } from '@/ui-next/today/TodayHeader';
import { AreaGate, type AreaStatus } from './AreaGate';
import { AiChangesStrip } from './blocks/AiChangesStrip';
import { KpiRow } from './blocks/KpiRow';
import { type PlacementProfileReader, ProfileBand } from './blocks/ProfileBand';
import { ProposalStrip } from './blocks/ProposalStrip';
import { SessionsStrip } from './blocks/SessionsStrip';
import { WeekHeat } from './blocks/WeekHeat';
import { OvernightCostSummary } from './OvernightCostSummary';
import { PrepDeskConjectures } from './PrepDeskConjectures';
import { ProbeAnswers } from './ProbeAnswers';
import { TeachingBriefBand } from './TeachingBrief';
import type { OvernightDigest, WorkbenchSummary } from './workbench-api';
import { useWorkbenchClient } from './workbench-client';
import './today-m3e.css';

// agency / onboarding 的读函数与组件由路由壳（Start
// server/start/routes/today.tsx）注入；shell 只编排页面，不 value-import 它们。
export interface TodayPageProps {
  navigate: (to: string) => void;
  getAgentNoteBoard: AgentNoteClient['getAgentNoteBoard'];
  getPlacementProfile: PlacementProfileReader;
  AgentNotesBoard: typeof AgentNotesBoard;
  LearningIntentComposer: typeof LearningIntentComposer;
  ColdStart: typeof ColdStart;
}

interface Thread {
  id: string;
  label: string;
  title: string;
  sub: string;
  cta: string;
  badge: string;
  icon: 'review' | 'inbox';
  tone: 'coral' | 'info' | 'good' | 'hard' | 'neutral';
  route: string;
}

// 「今日之线」派生：设计稿 DATA.threads 是策展假数据；真数据从 summary 聚合
// 派生两缕（复习/裁决），未来夜链交班缕随 M5 task_run 读模型补。
export function deriveThreads(s: WorkbenchSummary): Thread[] {
  const threads: Thread[] = [];
  if (s.kpi.due_count > 0) {
    threads.push({
      id: 'review',
      label: '复习',
      title:
        s.kpi.due_count_scope === 'actionable_queue_sample'
          ? `本批可复习 ${s.kpi.due_count} 项`
          : `${s.kpi.due_count} 个学习项到期`,
      sub:
        s.kpi.due_count_scope === 'actionable_queue_sample'
          ? '当前这批可以开始复习'
          : '根据复习间隔，它们已进入今天的队列。',
      cta: '开始复习',
      badge: `${s.kpi.due_count} 项`,
      icon: 'review',
      tone: 'coral',
      route: '/practice',
    });
  }
  if (s.proposals.decision_total > 0 || s.proposals.has_more) {
    const countKnown = s.proposals.decision_total > 0;
    const countLabel = s.proposals.has_more
      ? countKnown
        ? `≥${s.proposals.decision_total} 条`
        : '待检查'
      : `${s.proposals.decision_total} 条`;
    threads.push({
      id: 'inbox',
      label: '裁决',
      title: countKnown ? `${countLabel} AI 提议待审` : '提议队列需要检查',
      sub: s.proposals.has_more
        ? '计数已达扫描上限，可能仍有待裁决项。'
        : '逐条查看，再决定采用或暂不采用。',
      cta: '去收件箱',
      badge: countLabel,
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

export function aiTaskLabel(taskKind: string): string {
  const kind = taskKind.toLowerCase();
  if (kind.includes('copilot')) return 'Copilot';
  if (kind.includes('memory') || kind.includes('summary')) return '学习摘要';
  if (kind.includes('vision') || kind.includes('structure') || kind.includes('block')) {
    return '材料识别';
  }
  if (kind.includes('judge') || kind.includes('verify')) return '判题与核对';
  if (kind.includes('knowledge') || kind.includes('attribution') || kind.includes('frontier')) {
    return '知识整理';
  }
  if (kind.includes('note')) return '笔记整理';
  if (
    kind.includes('quiz') ||
    kind.includes('question') ||
    kind.includes('variant') ||
    kind.includes('solution')
  ) {
    return '题目准备';
  }
  if (
    kind.includes('coach') ||
    kind.includes('review') ||
    kind.includes('teaching') ||
    kind.includes('learning')
  ) {
    return '学习辅导';
  }
  return '其他 AI 工作';
}

export function learnerFailureSummary(messages: readonly string[]): string {
  const detail = messages.join(' ');
  if (/timeout|timed out|deadline exceeded/i.test(detail)) {
    return 'AI 处理超时，任务没有完成。';
  }
  if (/rate.?limit|too many requests|\b429\b/i.test(detail)) {
    return 'AI 服务当前繁忙，任务没有完成。';
  }
  if (/unauthori[sz]ed|forbidden|invalid api.?key|\b(?:401|403)\b/i.test(detail)) {
    return 'AI 服务连接配置异常，任务没有完成。';
  }
  if (/network|fetch failed|econn|socket|tls/i.test(detail)) {
    return 'AI 服务连接中断，任务没有完成。';
  }
  if (/process exited|exit code|terminated|killed|signal/i.test(detail)) {
    return 'AI 运行环境中断，任务没有完成。';
  }
  if (/parse|invalid json|structured output/i.test(detail)) {
    return 'AI 返回的内容无法读取，任务没有完成。';
  }
  return 'AI 运行失败；技术详情已保留在管理页。';
}

function CostRibbon() {
  const client = useWorkbenchClient();
  const q = useQuery({
    queryKey: ['cost-today'],
    queryFn: client.getTodayCost,
  });
  const t = q.data?.today;
  const cost = describeCosts(t?.by_currency ?? []);
  const isEmpty = t !== undefined && t.ledger_rows === 0 && t.tool_calls === 0;
  const status = costStatus(q.isLoading, q.isError, isEmpty);
  return (
    <section className="td-card">
      <div className="td-card-head">
        <span className="td-card-ic" aria-hidden="true">
          <Zap size={18} />
        </span>
        <h3 className="td-card-title">今日 AI 成本</h3>
      </div>
      <AreaGate
        status={status}
        onRetry={() => void q.refetch()}
        errorText="成本服务暂不可用。"
        loading={<SkeletonLines rows={1} label="正在读取今日 AI 成本" />}
        empty={<p className="td-quiet">今日尚无 AI 花费。</p>}
      >
        {t && (
          <div className="td-cost">
            <p className="td-cost-amt un-num">{cost.amount}</p>
            <p className="td-cost-note">{cost.note}</p>
            <div className="td-chips">
              {t.by_task.map((row) => {
                const taskCost = describeCosts(row.by_currency);
                return (
                  <span key={row.task_kind} className="td-chip" title={taskCost.note}>
                    <span>{aiTaskLabel(row.task_kind)}</span>{' '}
                    <b className="un-num">{taskCost.amount}</b>
                  </span>
                );
              })}
            </div>
            <p className="td-quiet un-num">
              共 {t.by_task.reduce((sum, row) => sum + row.calls, 0)} 次 AI 工作
            </p>
          </div>
        )}
      </AreaGate>
    </section>
  );
}

// The cost card's state, in the order it always had: loading → error → empty → content.
function costStatus(isLoading: boolean, isError: boolean, isEmpty: boolean): AreaStatus {
  if (isLoading) return 'loading';
  if (isError) return 'error';
  if (isEmpty) return 'empty';
  return 'ok';
}

// YUK-520 (A1 夜窗 digest) — 最小交班缕（富叙事缕本期 DEFER，先把数据 + 空夜态通电）。
// 设计参考 docs/design/loom-refresh/project/screen-today-handoff.jsx（HandoffThread / 空夜态）
// + handoff-band.jsx：本期最小化为一张卡 + 计数 chips + 空夜态（不整文件 PORT；YUK-1713 起为
// M3E 呈现）。富叙事缕（MasteryBand / 团队复盘 / 追溯 / narrative_threads）二期补。
//
// 红线（YUK-520 ②⑤）：空夜态（has_overnight_activity===false）是一等态，与加载中/失败显式可
// 区分，**绝不落回 ColdStart**——本带是 workbench 块的子组件（仅在非空证据态渲染），其空夜
// 分支只渲染安静的一行说明，永不触发冷开屏。additive 叠加，不动既有 hero/今日之线/双列/热力。

// 链式三元会被 OCR flag（项目规则禁嵌套/链式三元）——用 if/else 函数算状态。
function statefulStatus(isLoading: boolean, isError: boolean): Exclude<AreaStatus, 'empty'> {
  if (isLoading) return 'loading';
  if (isError) return 'error';
  return 'ok';
}

type DigestIcon = 'sparkle' | 'doc' | 'inbox' | 'teach' | 'eye';

// The digest's icon names (kept as data) → lucide.
const DIGEST_ICON: Record<DigestIcon, LucideIcon> = {
  sparkle: Sparkles,
  doc: FileText,
  inbox: Inbox,
  teach: GraduationCap,
  eye: Eye,
};

interface DigestChip {
  key: string;
  icon: DigestIcon;
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
    chips.push({ key: 'agent_notes', icon: 'eye', label: 'AI 观察', count: d.agent_notes_count });
  return chips;
}

// Single source for the ['overnight-digest'] query config — DegradedKindsFlags and
// OvernightDigestBand both read it; react-query dedupes the shared key (zero extra
// network) and this hook keeps their queryFn/key from drifting apart.
function useOvernightDigest() {
  const { getOvernightDigest } = useWorkbenchClient();
  return useQuery({ queryKey: queryKeys.overnightDigest, queryFn: getOvernightDigest });
}

// YUK-707 · [裁决 1] — degraded_kinds silent-failure red flags, HOISTED out of the
// overnight band to workbench position 1 (above the teaching brief), so they stay
// directly visible and are never hidden behind the narrative card. Same ['overnight-
// digest'] query (via useOvernightDigest) as OvernightDigestBand → react-query dedupes it
// (zero extra network). Silent degrade: it renders null — no skeleton, no error surface —
// until real degraded facts exist; the red strip is a cross-cutting flag, not a primary
// surface. Reuses the module-level learnerFailureSummary / aiTaskLabel (unchanged). M3E: one
// critical-tone line per failed task kind; the plain-language reason, once only a hover title,
// is now visible text so touch users can read it too.
function DegradedKindsFlags() {
  const q = useOvernightDigest();
  const d = q.data;
  if (!d || d.degraded_kinds.length === 0) return null;
  return (
    <div className="td-flags">
      {d.degraded_kinds.map((dk) => (
        <p key={dk.task_kind} className="td-flag">
          <CircleAlert size={16} aria-hidden="true" className="td-flag-ic" />
          <span className="td-flag-t">
            {aiTaskLabel(dk.task_kind)}失败 {dk.error_count} 次
          </span>
          <span className="td-flag-s">{learnerFailureSummary(dk.recent_error_messages)}</span>
        </p>
      ))}
    </div>
  );
}

// YUK-1738 — one generic line when some AI task kind keeps failing (observability's read).
// Learner copy only: never the task kind, counts or run ids — those live at the top of
// /admin/runs. Silent while loading, on error, and when there is no alert. An `unsealed` alert
// stays off this line: the reply reached the learner, only its closing record is incomplete.
// A dependency notice is its own line: replies keep succeeding without that dependency, so it is
// not a failed task, and its words come from the server.
const TASK_FAILURE_ALERTS_KEY = ['task-failure-alerts'] as const;
function TaskFailureNotice() {
  const { getTaskFailureAlerts } = useWorkbenchClient();
  const q = useQuery({ queryKey: TASK_FAILURE_ALERTS_KEY, queryFn: getTaskFailureAlerts });
  if (!q.data) return null;
  const tasksFailing = q.data.alerts.some((alert) => alert.rule !== 'unsealed');
  return (
    <>
      {tasksFailing ? (
        <p className="td-flag td-flag-caution" role="status">
          <CircleAlert size={16} aria-hidden="true" className="td-flag-ic" />
          <span className="td-flag-t">有一部分 AI 工作最近连续没有成功</span>
          <span className="td-flag-s">相关的结果可能暂时缺失或来得慢一些。</span>
        </p>
      ) : null}
      {q.data.dependency_notices.map((notice) => (
        <p key={notice.dependency} className="td-flag td-flag-caution" role="status">
          <CircleAlert size={16} aria-hidden="true" className="td-flag-ic" />
          <span className="td-flag-t">{notice.learner_title}</span>
          <span className="td-flag-s">{notice.learner_detail}</span>
        </p>
      ))}
    </>
  );
}

// Exported for the probe-queue independence regression test (YUK-707 round-2 [major]):
// the 待你试做 queue must stay reachable while the overnight-digest query is loading/errored.
export function OvernightDigestBand({ navigate }: { navigate: (to: string) => void }) {
  const { getActiveProbes } = useWorkbenchClient();
  // YUK-567 — the 备课猜想 chip toggles an inline 备课台 conjecture panel (pull, not
  // push): the team's prepared conjectures surface only when the owner opens them.
  const [conjOpen, setConjOpen] = useState(false);
  // YUK-567 slice-2 — 待你试做 probe queue: its own ['prep-desk-probes'] query (shared with
  // ProbeAnswers → react-query dedupes), independent of overnight activity so a served
  // probe is always reachable.
  const [probeOpen, setProbeOpen] = useState(false);
  // YUK-707 · [裁决 5] — the overnight ACTIVITY surface (activity chips + 备课猜想 / 去裁决)
  // is DEMOTED into one default-collapsed disclosure now that the teaching brief is the
  // primary "为你而备" delivery. demote-not-delete: the 备课猜想 二级 toggle is preserved,
  // only the hierarchy drops a level. The 待你试做 probe queue is NOT folded in here — it
  // rides its own independent query and stays a first-class sibling below (see the return).
  const [activityOpen, setActivityOpen] = useState(false);
  const q = useOvernightDigest();
  const probesQ = useQuery({ queryKey: queryKeys.prepDeskProbes, queryFn: getActiveProbes });
  const activeProbes = probesQ.data?.probes ?? [];
  const status = statefulStatus(q.isLoading, q.isError);
  const d = q.data;
  // If accepting/rejecting the last conjecture drops the count to 0, the 备课猜想
  // toggle chip disappears (buildDigestChips gates on >0) — auto-collapse so the
  // panel is never stranded open with no way to close it (CodeRabbit review-782).
  // Adjusted during render: the collapse is stored, so a later non-zero count stays closed.
  if (conjOpen && d?.new_conjectures_count === 0) setConjOpen(false);
  // Auto-collapse when the last probe is answered (mirrors the conjecture panel).
  if (probeOpen && activeProbes.length === 0) setProbeOpen(false);
  const chips = d ? buildDigestChips(d) : [];
  const canDecide = !!d && (d.new_proposals_count > 0 || d.new_conjectures_count > 0);
  const hasActivity = !!d?.has_overnight_activity;
  const hasProbes = activeProbes.length > 0;
  return (
    <section className="td-night">
      <h2 className="un-today-section-title">夜链 · 交班</h2>
      <div className="td-card">
        <div className="td-card-head">
          <span className="td-card-ic" data-tone="accent" aria-hidden="true">
            <Moon size={18} />
          </span>
          <h3 className="td-card-title">昨夜 AI 替你做了什么</h3>
        </div>
        <AreaGate
          status={status}
          onRetry={() => void q.refetch()}
          errorText="夜链交班暂不可用。"
          loading={<SkeletonLines rows={2} label="正在读取昨夜交班" />}
        >
          {/* degraded_kinds red flags moved to <DegradedKindsFlags/> (position 1, [裁决 1]).
              A quiet night (no overnight activity) shows the calm empty line. A served probe
              is NOT overnight activity, so it never suppresses this line — it renders in its
              own sibling below, independent of this digest query's state. */}
          {d && !hasActivity && (
            <p className="td-quiet">
              昨夜没有需要交班的活动 —— 团队会在你持续学习后，开始为你做夜间复盘。
            </p>
          )}
          {d && hasActivity && (
            <>
              <button
                type="button"
                className="td-toggle un-hit"
                onClick={() => setActivityOpen((o) => !o)}
                aria-expanded={activityOpen}
              >
                <Moon size={14} aria-hidden="true" /> 昨夜 AI 还替你做了这些
                <ChevronDown size={14} aria-hidden="true" className="td-chev" />
              </button>
              {activityOpen && (
                <div className="td-reveal">
                  <div className="td-chips">
                    {chips.map((c) =>
                      c.key === 'conjectures' ? (
                        // 备课猜想 chip → toggle the inline 备课台 panel (§3 pull-not-push).
                        <button
                          key={c.key}
                          type="button"
                          className="td-toggle un-hit"
                          onClick={() => setConjOpen((o) => !o)}
                          aria-expanded={conjOpen}
                        >
                          <DigestGlyph name={c.icon} /> {c.label}{' '}
                          <b className="un-num">{c.count}</b>
                          <ChevronDown size={14} aria-hidden="true" className="td-chev" />
                        </button>
                      ) : (
                        <span key={c.key} className="td-chip">
                          <DigestGlyph name={c.icon} /> {c.label}{' '}
                          <b className="un-num">{c.count}</b>
                        </span>
                      ),
                    )}
                  </div>
                  {conjOpen && (
                    <div className="td-reveal">
                      <PrepDeskConjectures />
                    </div>
                  )}
                  {canDecide && (
                    <div className="td-foot">
                      <Button size="sm" variant="secondary" onClick={() => navigate('/inbox')}>
                        去裁决
                        <ArrowRight size={16} aria-hidden="true" />
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {d && <OvernightCostSummary cost={d.cost} window={d.window} />}
        </AreaGate>
      </div>
      {hasProbes && (
        <div className="td-probes">
          {/* 待你试做 —— served probes to answer. Driven by its own ['prep-desk-probes']
              query and rendered as an independent sibling (NOT inside the digest AreaGate or
              the activity disclosure), so it stays one-click reachable whenever a probe is
              served — even while the overnight digest is loading or errored (YUK-707 round-2
              [major]). Answering the last one auto-collapses this. */}
          <button
            type="button"
            className="td-toggle un-hit"
            onClick={() => setProbeOpen((o) => !o)}
            aria-expanded={probeOpen}
          >
            <FileQuestion size={14} aria-hidden="true" /> 待你试做{' '}
            <b className="un-num">{activeProbes.length}</b>
            <ChevronDown size={14} aria-hidden="true" className="td-chev" />
          </button>
          {probeOpen && (
            <div className="td-reveal">
              <ProbeAnswers />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function DigestGlyph({ name }: { name: DigestIcon }) {
  const Icon = DIGEST_ICON[name];
  return <Icon size={14} aria-hidden="true" />;
}

function ThreadCard({ th, navigate }: { th: Thread; navigate: (to: string) => void }) {
  return (
    <button type="button" className="un-today-task" onClick={() => navigate(th.route)}>
      <span className="un-today-meta">
        {th.label} · {th.badge}
      </span>
      <strong>{th.title}</strong>
      <span>{th.sub}</span>
      <span className="un-today-task-action">
        {th.cta}
        <ArrowRight size={18} aria-hidden="true" />
      </span>
    </button>
  );
}

export default function TodayPage({
  navigate,
  getAgentNoteBoard,
  getPlacementProfile,
  AgentNotesBoard,
  LearningIntentComposer,
  ColdStart,
}: TodayPageProps) {
  const { getWorkbenchSummary } = useWorkbenchClient();
  const now = new Date();

  const summaryQ = useQuery({ queryKey: queryKeys.workbenchSummary, queryFn: getWorkbenchSummary });
  // queryKey 与 /agent-notes 全量页（['agent-notes','full']，limit=50）分档，
  // 避免互相覆盖缓存。
  const notesQ = useQuery({
    queryKey: ['agent-notes', 'board'],
    queryFn: () => getAgentNoteBoard(20),
    // ColdStart 不渲染 notes；与服务端 cold_start 合同共用一个门，避免 UI 再推导空态。
    enabled: summaryQ.data?.cold_start.is_empty === false,
  });

  const summaryStatus = statefulStatus(summaryQ.isLoading, summaryQ.isError);
  const s = summaryQ.data;
  const threads = s ? deriveThreads(s) : [];

  // YUK-621：冷启动只认服务端聚合后的「所有学习证据皆空」。没有 active goal
  // 仍可正常查看题库、复习、历史与提议；loading / error 继续走 AreaGate。
  if (s?.cold_start.is_empty) {
    return <ColdStart navigate={navigate} />;
  }

  return (
    <main data-ui-next="" data-un-m3e="practice-foundation" className="un-root un-today-page">
      <TodayHeader navigate={navigate} onCompanion={() => openCopilot()} />

      <div className="td-flow un-m3e-bridge">
        <AreaGate
          status={summaryStatus}
          onRetry={() => void summaryQ.refetch()}
          errorText="工作台聚合暂不可用。"
          loading={<SkeletonLines rows={4} label="正在读取今日工作台" />}
        >
          {s && (
            <>
              {/* YUK-707 · workbench 位置 1 — degraded_kinds 红旗上提，永在 brief 之前直显
                ([裁决 1])；无 degraded 事实时渲 null。 */}
              <DegradedKindsFlags />
              <TaskFailureNotice />

              {/* YUK-707 · workbench 位置 2 — 唯一「为你而备」主 handoff 交付，default-visible
                ([裁决 主]，contract §0/§5）。navigate 供 YUK-709 confirmed → KC-scoped
                practice 的 CTA 跳转。 */}
              <TeachingBriefBand navigate={navigate} />

              {/* YUK-520 (A1) — 最小交班缕：workbench 块（今日之线 layer ①）。仅在非冷启
                （cold_start=false）渲染，空夜态永不落 ColdStart。YUK-707 起降级为 brief 之下
                的二级折叠盘（[裁决 5]），保留全部夜间活动事实。 */}
              <OvernightDigestBand navigate={navigate} />

              <KpiRow kpi={s.kpi} proposals={s.proposals} navigate={navigate} />

              {/* YUK-476 起始画像卡片：active goal 存在时露出 per-KC band 摘要 + /profile 持久入口。
                无 active goal 时只省略画像，不影响其余工作台。 */}
              {s.active_goal && (
                <ProfileBand
                  goal={s.active_goal}
                  navigate={navigate}
                  getPlacementProfile={getPlacementProfile}
                />
              )}

              <LearningIntentComposer
                initialTopic={s.active_goal?.title ?? ''}
                pendingCount={s.proposals.by_kind.learning_item ?? 0}
                autoApplyEnabled={s.auto_apply_enabled}
                navigate={navigate}
              />

              {threads.length > 0 && (
                <>
                  <h2 className="un-today-section-title">接下来做什么</h2>
                  <div className="un-today-tasks">
                    {threads.map((th) => (
                      <ThreadCard key={th.id} th={th} navigate={navigate} />
                    ))}
                  </div>
                </>
              )}

              <h2 className="un-today-section-title">继续学习与检查改动</h2>
              <div className="un-today-columns">
                <div className="un-today-column">
                  <SessionsStrip sessions={s.active_sessions} now={now} navigate={navigate} />
                  <AiChangesStrip now={now} />
                </div>
                <div className="un-today-column">
                  <ProposalStrip proposals={s.proposals} navigate={navigate} />
                  <CostRibbon />
                </div>
              </div>
            </>
          )}
        </AreaGate>

        <AgentNotesBoard
          notes={notesQ.data?.rows ?? []}
          status={statefulStatus(notesQ.isLoading, notesQ.isError)}
          now={now}
          onRetry={() => void notesQ.refetch()}
          onNavigate={navigate}
        />

        {s && (
          <section className="td-week">
            <h2 className="un-today-section-title">过去 7 天</h2>
            <div className="td-card">
              <div className="td-card-head">
                <span className="td-card-ic" data-tone="accent" aria-hidden="true">
                  <Target size={18} />
                </span>
                <h3 className="td-card-title">7 天活动热力</h3>
                <span className="td-card-aside td-chip un-num">
                  共 {s.week_heat.reduce((acc, d) => acc + d.count, 0)} 次活动
                </span>
              </div>
              <WeekHeat heat={s.week_heat} />
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
