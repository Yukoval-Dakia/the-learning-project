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
// ② inline 事件链展开（loom .event-chain / expander）：本页无事件 list query → DROP 展开，
//    保留 `→ 事件链` 链接指向 /events/{id}（该 route 尚未登记 SPA，点击 404 属预期，同
//    InboxPage evidence-link 既有行为）。
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
import { useMemo, useState } from 'react';

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

const listMistakes = () => apiJson<{ rows: MistakeRow[] }>('/api/mistakes?limit=100');

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

// 归因开始至今秒数（CauseBadge 的 pending<30s「归因中...」vs ≥30s「待归因」分界）。
function pendingSinceSec(m: MistakeRow): number {
  return Math.max(0, Math.floor(Date.now() / 1000) - m.created_at);
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
              title="跳到知识图"
              onClick={() => navigate('/knowledge')}
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

      {/* footer：→ 事件链（inline 展开按 §4 DROP；/events/{id} route 尚未登记 SPA，
          点击 404 属预期，同 InboxPage evidence-link 既有行为）。 */}
      <div className="mistake-foot">
        <button
          type="button"
          className="mistake-evlink"
          title={`事件 events:${m.id}`}
          onClick={() => navigate(`/events/${m.id}`)}
        >
          <LoomIcon name="clock" size={13} />
          查看事件链 →
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
  const subjectOf = (m: MistakeRow): string | null =>
    m.knowledge_ids.length > 0
      ? (treeById.get(m.knowledge_ids[0])?.effective_domain ?? null)
      : null;

  const pending = rows.filter((m) => m.cause === null).length;

  const shown = rows.filter((m) => {
    if (subject !== 'all' && subjMeta(subjectOf(m)).label !== subjMeta(subject).label) return false;
    if (state !== 'all' && uiState(m) !== state) return false;
    if (attr !== 'all' && attrOf(m) !== attr) return false;
    return true;
  });

  const activeFilters =
    (subject !== 'all' ? 1 : 0) + (state !== 'all' ? 1 : 0) + (attr !== 'all' ? 1 : 0);
  const reset = () => {
    setSubject('all');
    setState('all');
    setAttr('all');
  };

  const status: StatefulStatus = q.isLoading
    ? 'loading'
    : q.isError
      ? 'error'
      : rows.length === 0
        ? 'empty'
        : 'ok';

  return (
    <main className="page wide mistakes-loom">
      <header className="page-head">
        <div className="eyebrow">
          MISTAKES · 错题归因 · 共 {rows.length} 条 · 归因中 {pending}
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
              待重学 {rows.filter((m) => uiState(m) === '待重学').length} · 已纠正{' '}
              {rows.filter((m) => uiState(m) === '已纠正').length} · 归因中 {pending}
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
            {shown.map((m) => (
              <MistakeCard
                key={m.id}
                m={m}
                subject={subjectOf(m)}
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
