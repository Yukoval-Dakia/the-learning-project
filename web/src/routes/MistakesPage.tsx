// Usability Step1 (YUK-354) — 错题本 /mistakes 页：实现 loom screen-mistakes.jsx
// ScreenMistakes + MistakeCard（slice-by-slice），闭合 record→see→practice 死链
//（RecordPage onSuccess navigate('/mistakes') 此前 404）。
//
// 数据源：GET /api/mistakes 投影（src/server/records/mistakes.ts L61-72，read-only）：
//   { id(=attempt_event_id), record_id, question_id, prompt_md(≤200), wrong_answer_md(≤200),
//     knowledge_ids[], cause:{source:'user'|'agent', primary_category, secondary_categories,
//     user_notes, confidence}|null, correction_state:EffectiveTruth, created_at(unix 秒) }
//
// CSS：复用 globals.css 既有 `.mistakes-loom` 层（L9740+，YUK-169 wave-2 已 port 自同一
// loom 稿，含 owner-ratified preflight docs/design/2026-06-04-redraw-mistakes-preflight.md）。
// 本 SPA 页是该 CSS 层首个真消费者（旧 Next.js page 随 YUK-321 M5 退场，CSS 留存）。
//
// 偏差（owner-ratified preflight §4 + 本任务 present-if-available 规则；no-mock）：
// ① 正解对照行（loom .cmp-right）：投影无 reference_md → DROP，`.mistake-cmp` 退化为单
//    「误」行（CSS 本就无 .cmp-right）。要补需扩 listMistakeProjectionRows 返 reference_md。
// ② inline 事件链展开（loom .event-chain / expander）：本页无事件 list query → DROP 展开。
//    事件链 footer 保留可读文案但 render 为 disabled——/events route 尚未登记 SPA，不 ship
//    已知 404 导航（graceful defer，同 ProposalCard EvidenceChip：无 route 即 disabled +
//    去 affordance）。/events 登记后撤 disabled + 补 onClick(`/events/{id}`)。
// ③ 归因 badge：复用 CauseBadge primitive（user/agent/pending/conf 全覆盖，语义等价 loom
//    AttributionBadge），不照搬 loom 简化版——避免双套归因展示漂移。
// ④ 知识点 chip：knowledge_ids → 经 getTree fan-out 白话化为节点名（present-if-available；
//    无 name 时降级显 id 前 8 位，不 fabricate）。
// ⑤ 科目轴：knowledge_ids[0] → getTree effective_domain → QSUBJECT（科目=视角派生，非实体
//    列；同 QuestionsPage subjMeta 先例）。

import { getTree } from '@/capabilities/knowledge/ui/knowledge-api';
import { apiJson } from '@/ui/lib/api';
import { Btn } from '@/ui/primitives/Btn';
import { CauseBadge, type CausePrimary } from '@/ui/primitives/CauseBadge';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { Stateful, type StatefulStatus } from '@/ui/primitives/Stateful';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

// ── wire 类型（GET /api/mistakes 投影行；listMistakeProjectionRows） ──
interface MistakeCause {
  source: 'user' | 'agent';
  primary_category: string;
  secondary_categories?: string[] | null;
  user_notes: string | null;
  confidence: number | null;
}

// correction_state 是 EffectiveTruth；本页只消费 terminal_state（active|retracted|
// marked_wrong|missing|cycle）派生「纠错状态」。其余字段（chain 等）本页不渲。
interface MistakeCorrectionState {
  terminal_state: 'active' | 'retracted' | 'marked_wrong' | 'missing' | 'cycle';
}

interface MistakeRow {
  id: string;
  record_id: string;
  question_id: string;
  prompt_md: string;
  wrong_answer_md: string;
  knowledge_ids: string[];
  cause: MistakeCause | null;
  correction_state: MistakeCorrectionState;
  created_at: number;
}

// 投影 limit-based（后端 listMistakeProjectionRows 只有 limit，无 total/cursor）。limit 取
// 200 给余量；rows 触顶时 eyebrow 显「N+」诚实标记可能截断，不把截断计数当真 total 呈现。
// 真分页 / 无限滚 + 后端 total 是 YUK-456 follow-up（错题本长大后；owner day-one 不触及）。
const MISTAKES_LIMIT = 200;
const listMistakes = () => apiJson<{ rows: MistakeRow[] }>(`/api/mistakes?limit=${MISTAKES_LIMIT}`);

// ── 科目派生（effective_domain → label/tone）；同 QuestionsPage QSUBJECT 先例。 ──
type Tone = 'neutral' | 'coral' | 'info' | 'good' | 'hard' | 'again';
const QSUBJECT: Record<string, { label: string; tone: Tone }> = {
  wenyan: { label: '语文', tone: 'coral' },
  yuwen: { label: '语文', tone: 'coral' },
  math: { label: '数学', tone: 'info' },
  suanxue: { label: '数学', tone: 'info' },
  physics: { label: '物理', tone: 'info' },
  eng: { label: '英语', tone: 'good' },
  english: { label: '英语', tone: 'good' },
  general: { label: '通识', tone: 'neutral' },
};
function subjMeta(subject: string | null): { label: string; tone: Tone } {
  if (!subject) return { label: '未分科', tone: 'neutral' };
  return QSUBJECT[subject] ?? { label: subject, tone: 'neutral' };
}

// 科目筛选规范化：把「filter chip key」与「effective_domain」折叠到同一规范桶后比 KEY，
// 不比 label。旧码比 subjMeta(...).label——靠 wenyan/yuwen 共享「语文」标签碰巧对上，但
// physics(物理)/suanxue 等无对应 chip 的科目会被静默错筛（label 永不等任一 chip label，
// 等价于「永远不显示」而非「正确地不匹配」）。SUBJECT_OPTS chip key 是展示用别名
// （yuwen/eng），effective_domain 是 profile id（wenyan/math/physics/general/...），二者
// 词表不同——必须先各自归一到规范桶。规范桶取 profile id 优先（wenyan/math/physics/
// general），英语无 profile 故用 eng 桶。
const SUBJECT_KEY_ALIASES: Record<string, string> = {
  wenyan: 'wenyan',
  yuwen: 'wenyan',
  math: 'math',
  suanxue: 'math',
  physics: 'physics',
  eng: 'eng',
  english: 'eng',
  general: 'general',
};
function subjectKey(subject: string | null): string | null {
  if (!subject) return null;
  return SUBJECT_KEY_ALIASES[subject] ?? subject;
}

// loom 状态轴。投影无显式「已纠正/待重学」枚举——按 correction_state.terminal_state 派生：
// retracted/marked_wrong（原 attempt 已被纠正事件推翻）→ 已纠正；cause 仍 null（归因未落）
// → 归因中…；其余（active 等）→ 待重学。
type MistakeUiState = '待重学' | '已纠正' | '归因中…';
function uiState(m: MistakeRow): MistakeUiState {
  const t = m.correction_state?.terminal_state;
  if (t === 'retracted' || t === 'marked_wrong') return '已纠正';
  if (m.cause === null) return '归因中…';
  return '待重学';
}
function stateTone(s: MistakeUiState): Tone {
  return s === '已纠正' ? 'good' : s === '归因中…' ? 'hard' : 'neutral';
}

// 归因轴：pending(null) 计为 ai（同 loom attrOf——归因中是 AI 通道在跑）；否则按 cause.source。
function attrOf(m: MistakeRow): 'ai' | 'user' {
  if (m.cause === null) return 'ai';
  return m.cause.source === 'agent' ? 'ai' : 'user';
}

// 投影 cause → CauseBadge.Cause（primary 透传，未知值降级原样，不 fabricate）。
function toCauseBadgeInput(cause: MistakeCause | null): {
  actor_kind: 'user' | 'agent';
  primary: CausePrimary | string;
  secondary?: string[] | null;
  confidence?: number | null;
} | null {
  if (!cause) return null;
  return {
    actor_kind: cause.source === 'agent' ? 'agent' : 'user',
    primary: cause.primary_category,
    secondary: cause.secondary_categories ?? null,
    confidence: cause.confidence,
  };
}

// 归因开始至今秒数。唯一消费者是 CauseBadge：仅用于在 <30s「归因中...」与 ≥30s
// 「待归因」间二选一（不渲染活动秒数计数器）。Date.now() 在 render 期取——单凭它，
// 一条 <30s 的 pending 行会卡在「归因中...」永不翻到「待归因」（页面挂着不重渲）。
// 修法：页面级 30s 阈值附近补一个 tick（见 MistakesPage useEffect，仅 pending>0 时跑）
// 触发重渲，让阈值跨越被如实反映。因为没有「看起来在走的冻结数字」，所以不误导。
function pendingSinceSec(m: MistakeRow): number {
  return Math.max(0, Math.floor(Date.now() / 1000) - m.created_at);
}

// 列表态派生：loading > error > empty > ok 优先级。早返回 lookup 替原嵌套三元
// （biome 不报，code-quality 偏好早返回/查表，#508 OCR 重审 nit / YUK-456）。
function statusOf(p: { isLoading: boolean; isError: boolean; isEmpty: boolean }): StatefulStatus {
  if (p.isLoading) return 'loading';
  if (p.isError) return 'error';
  if (p.isEmpty) return 'empty';
  return 'ok';
}

// ── 筛选 chip 行（与 InboxPage / loom FilterRow 同形：.filter-row + .chip.is-on） ──
function FilterRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: [string, string][];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="filter-row">
      <span className="filter-row-l">{label}</span>
      {options.map(([v, l]) => (
        <button
          type="button"
          key={v}
          className={`chip${value === v ? ' is-on' : ''}`}
          onClick={() => onChange(v)}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

const SUBJECT_OPTS: [string, string][] = [
  ['all', '全部'],
  ['yuwen', '语文'],
  ['math', '数学'],
  ['eng', '英语'],
];
const STATE_OPTS: [string, string][] = [
  ['all', '全部'],
  ['待重学', '待重学'],
  ['已纠正', '已纠正'],
  ['归因中…', '归因中'],
];
const ATTR_OPTS: [string, string][] = [
  ['all', '全部'],
  ['ai', 'AI 归因'],
  ['user', '我标注'],
];

// ── 错题卡（loom MistakeCard，L212-262；正解/事件链展开按 §4 DROP） ──
function MistakeCard({
  m,
  subject,
  kpName,
  navigate,
}: {
  m: MistakeRow;
  subject: string | null;
  kpName: (id: string) => string;
  navigate: (to: string) => void;
}) {
  const s = uiState(m);
  const subj = subjMeta(subject);
  return (
    <LoomCard pad className="mistake-card">
      <div className="mistake-top">
        <div className="mistake-q wenyan">{m.prompt_md || '（无题面）'}</div>
        <span className={`badge tone-${stateTone(s)} state-badge`}>
          {s === '已纠正' && <LoomIcon name="check" size={12} />}
          {s}
        </span>
      </div>

      {/* 误 对照（正解行按 owner-ratified preflight §4 DROP——投影无 reference_md） */}
      <div className="mistake-cmp">
        <div className="mistake-cmp-line">
          <span className="cmp-label">误</span>
          <span className="cmp-wrong">{m.wrong_answer_md || '（无作答）'}</span>
        </div>
      </div>

      <div className="mistake-meta-row">
        <div className="kp-badges">
          <span className={`qb-subj tone-${subj.tone}`}>{subj.label}</span>
          {m.knowledge_ids.map((id) => (
            <button
              type="button"
              key={id}
              className="chip chip-k mono kp-chip"
              title="跳到该知识点"
              // loom kp-chip onClick={() => go("knowledge")} 是泛跳；SPA 深链到该 KC 自身
              // 详情页（router.tsx /knowledge/$id → KnowledgeDetailPage useParams().id）。
              onClick={() => navigate(`/knowledge/${id}`)}
            >
              {kpName(id)}
            </button>
          ))}
        </div>
        <CauseBadge
          className="attr-badge"
          cause={toCauseBadgeInput(m.cause)}
          pendingSinceSec={m.cause === null ? pendingSinceSec(m) : undefined}
        />
      </div>

      {/* footer：事件链（inline 展开按 §4 DROP；/events/{id} route 尚未登记 SPA）。
          GRACEFUL DEFER：不 ship 已知 404 导航——同 ProposalCard EvidenceChip 先例
          （src/.../ProposalCard.tsx：route 缺失时 disabled + 去掉「查看 →」affordance），
          保留可读文案，撤掉点击穿透与 `→` 触发暗示。/events 登记后再补 onClick。 */}
      <div className="mistake-foot">
        <button type="button" className="mistake-evlink" title={`事件 events:${m.id}`} disabled>
          <LoomIcon name="clock" size={13} />
          事件链
        </button>
      </div>
    </LoomCard>
  );
}

export interface MistakesPageProps {
  navigate: (to: string) => void;
}

export default function MistakesPage({ navigate }: MistakesPageProps) {
  const [subject, setSubject] = useState('all');
  const [state, setState] = useState('all');
  const [attr, setAttr] = useState('all');

  const q = useQuery({ queryKey: ['mistakes'], queryFn: listMistakes });
  const treeQ = useQuery({ queryKey: ['knowledge-tree'], queryFn: getTree });

  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);

  // knowledge id → name / effective_domain（getTree 行）。复用 ['knowledge-tree']
  // query key → 与 InboxPage / CommandPalette 去重，不增请求。
  const treeById = useMemo(() => {
    const map = new Map<string, { name: string; effective_domain: string | null }>();
    for (const n of treeQ.data?.rows ?? []) {
      map.set(n.id, { name: n.name, effective_domain: n.effective_domain ?? n.domain });
    }
    return map;
  }, [treeQ.data]);

  const kpName = (id: string) => treeById.get(id)?.name ?? id.slice(0, 8);
  // 科目派生：取首个 knowledge_id 的 effective_domain（无则 null → 未分科）。
  const subjectOf = useCallback(
    (m: MistakeRow): string | null =>
      m.knowledge_ids.length > 0
        ? (treeById.get(m.knowledge_ids[0])?.effective_domain ?? null)
        : null,
    [treeById],
  );

  // 每行只算一次派生轴（subject / uiState / attr / 科目规范键），counts + shown + 卡片
  // 都从这里取——旧码对 uiState(m) 跑了 4 趟独立 .filter()（3 个 count + shown），现在单趟。
  const derived = useMemo(
    () =>
      rows.map((m) => {
        const subject = subjectOf(m);
        return {
          m,
          subject,
          ui: uiState(m),
          attr: attrOf(m),
          skey: subjectKey(subject),
        };
      }),
    [rows, subjectOf],
  );

  const pending = derived.filter((d) => d.m.cause === null).length;
  const toRelearn = derived.filter((d) => d.ui === '待重学').length;
  const corrected = derived.filter((d) => d.ui === '已纠正').length;

  // rows 可能在 MISTAKES_LIMIT 处被截断（投影 limit-based）。eyebrow「共 N 条」据此显「N+」
  // 诚实标记，避免把截断计数当真 total 呈现（真 total 待后端 count，见 listMistakes 注释）。
  const totalLabel = rows.length >= MISTAKES_LIMIT ? `${rows.length}+` : String(rows.length);

  // pending 行的 CauseBadge 文案随 Date.now() 派生（<30s「归因中...」/ ≥30s「待归因」）。
  // render 期一次性取的 Date.now() 不会自己走——补一个低频 tick 触发重渲，让阈值跨越如实
  // 反映；只在 pending>0 时跑（无 pending 行时零开销，不挂常驻 interval）。15s 间距保证 30s
  // 阈值在 ~一个周期内被跨过。tick 值本身不渲染（只为 invalidate render），不是冻结的活动计数。
  const [, setTick] = useState(0);
  useEffect(() => {
    if (pending === 0) return;
    const h = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(h);
  }, [pending]);

  // 科目筛选比规范键（subjectKey），不比 label——见 SUBJECT_KEY_ALIASES 注释。
  // shown 保留 derived 条目（含预算 subject），卡片渲染直接复用，不再重算 subjectOf。
  const subjectFilterKey = subject === 'all' ? null : subjectKey(subject);
  const shown = derived.filter((d) => {
    if (subjectFilterKey !== null && d.skey !== subjectFilterKey) return false;
    if (state !== 'all' && d.ui !== state) return false;
    if (attr !== 'all' && d.attr !== attr) return false;
    return true;
  });

  const activeFilters =
    (subject !== 'all' ? 1 : 0) + (state !== 'all' ? 1 : 0) + (attr !== 'all' ? 1 : 0);
  const reset = () => {
    setSubject('all');
    setState('all');
    setAttr('all');
  };

  const status = statusOf({
    isLoading: q.isLoading,
    isError: q.isError,
    isEmpty: rows.length === 0,
  });

  return (
    <main className="page wide mistakes-loom">
      <header className="page-head">
        <div className="eyebrow">
          MISTAKES · 错题归因 · 共 {totalLabel} 条 · 归因中 {pending}
        </div>
        <div className="page-head-row">
          <h1 className="page-title serif">错题本</h1>
          <div className="hero-cta">
            <Btn variant="ghost" size="sm" icon="record" onClick={() => navigate('/record')}>
              录新错题
            </Btn>
            <Btn variant="primary" size="sm" icon="review" onClick={() => navigate('/practice')}>
              重练薄弱点
            </Btn>
          </div>
        </div>
        <p className="page-lead">
          每条错题是一条记录：题面 / 错答 / 知识点 / 归因（AI vs 我）/ 纠错状态。
        </p>
      </header>

      {/* summary + filters */}
      <LoomCard pad sunk style={{ marginBottom: 'var(--s-5)' }}>
        <div className="inbox-summary-row nowrap-meta">
          <span className="card-icon accent">
            <LoomIcon name="mistakes" size={18} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500 }}>
              {shown.length} 条错题{activeFilters ? ' · 已筛选' : ''}
            </div>
            <div className="meta">
              待重学 {toRelearn} · 已纠正 {corrected} · 归因中 {pending}
            </div>
          </div>
          {activeFilters > 0 && (
            <button
              type="button"
              className="qf2-reset"
              style={{ marginLeft: 'auto' }}
              onClick={reset}
            >
              <LoomIcon name="close" size={13} />
              清除筛选
            </button>
          )}
        </div>
        <FilterRow label="科目" options={SUBJECT_OPTS} value={subject} onChange={setSubject} />
        <FilterRow label="状态" options={STATE_OPTS} value={state} onChange={setState} />
        <FilterRow label="归因" options={ATTR_OPTS} value={attr} onChange={setAttr} />
      </LoomCard>

      <Stateful
        status={status}
        onRetry={() => void q.refetch()}
        errorText="错题加载失败。"
        skeleton={
          <div className="grid" style={{ gap: 'var(--s-3)' }}>
            {[1, 2, 3].map((i) => (
              <LoomCard key={i} pad>
                <div className="mistake-q" style={{ height: '1.2em' }} />
              </LoomCard>
            ))}
          </div>
        }
        empty={
          <EmptyState
            icon="mistakes"
            title="还没有错题"
            text="复习答错或手动录入后，错题会聚到这里并自动归因。"
            action={
              <Btn variant="primary" size="sm" icon="record" onClick={() => navigate('/record')}>
                录新错题
              </Btn>
            }
          />
        }
      >
        {shown.length === 0 ? (
          <EmptyState
            icon="filter"
            title="没有匹配的错题"
            text="放宽科目 / 状态 / 归因筛选试试。"
            action={
              <Btn variant="secondary" size="sm" icon="close" onClick={reset}>
                清除筛选
              </Btn>
            }
          />
        ) : (
          <div className="grid stagger" style={{ gap: 'var(--s-3)' }}>
            {shown.map((d) => (
              <MistakeCard
                key={d.m.id}
                m={d.m}
                subject={d.subject}
                kpName={kpName}
                navigate={navigate}
              />
            ))}
          </div>
        )}
      </Stateful>
    </main>
  );
}
