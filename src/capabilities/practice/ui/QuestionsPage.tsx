// YUK-409 — 题库面 /questions。把 loom docs/design/loom-refresh/project/screen-questions.jsx
// 像素级复刻为真 React，接真后端 GET /api/questions?enrich=true（多轴 list + variant
// lineage + composite 大题小题 + prompt 预览）。questions.css 直接 port（同目录 import）。
//
// 与设计 demo 的真数据取舍（demo 用 data-questions.jsx 内存模型，这里全接真投影）：
//   • QKIND — 用真 QuestionKind enum（choice/reading/computation/...，9 值）而非 demo 的
//     mcq/short/trans/cloze/reading 5 值；canonical 词表见 core/schema/business.ts。
//   • QSOURCE — 用真 QuestionSource enum（13 值）而非 demo 的 seed/quiz/exam/variant 4 值；
//     AI 生成类→coral/sparkle，采集/拍照类→info/camera|download，人工/教学类→neutral。
//   • subject — 真后端派生（list enrich：knowledge_ids[0] → effectiveDomain → subject
//     profile id），非 demo 的 knowledge-id 前缀启发式。tone 按 profile id 上色。
//   • knowledge_labels — 真后端解析（非归档 knowledge.name）；缺名的 id 不渲 kchip。
//   • variant lineage glyph ◆◇▫ — 从真 root_question_id（null→母题◆ / 非 null→变体◇）+
//     parent_question_id/part_index（小题▫）派生，不需后端新字段。
//   • composite 大题展开 — 真后端 enrich.children（question_part 子行，part_index 序）。
//   • 状态 tab（全部/正式/草稿）— 真 draft_status（NULL≡正式 / 'draft'≡草稿）；list
//     默认排除草稿，故题库面请求 include_drafts=true 拉全集，client 按 draft_status 分。
//   • 筛选策略 — API 支持的轴（subject/source/kind/difficulty）走 server-side 传参（filters
//     变 → query key 变 → 重新 fetch）；search + 知识点多选走 client-side（同 DraftReviewPage
//     的搜索约定，知识点是 enrich.knowledge_labels 的本地集合，无需再往返）。
//   • 省略 attempts/review/mistakes/papers 微指示 — 后端 list 投影无这些聚合（detail 才有
//     timeline/backlinks）；QIndicators 只渲 subject + 知识点 tags，微指示 DEFER（注释标明）。
//   • ribbon「在复习队列」统计同因后端 list 无 review 聚合 → DEFER，ribbon 改渲「含变体」
//     替代（真 variant_depth>0 计数），不 fabricate 假复习数。

import { MathMarkdown } from '@/ui/lib/math-markdown';
import { Btn } from '@/ui/primitives/Btn';
import { Card } from '@/ui/primitives/Card';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useCallback, useMemo, useState } from 'react';
import './questions.css';

import { type QBankQuestion, getQuestionsList } from './practice-api';

// ── 映射（内联 const，对照 data-questions.jsx，但用真 enum）──────────────────

type Tone = 'neutral' | 'info' | 'coral' | 'good' | 'hard' | 'again';

// 真 QuestionKind enum（core/schema/business.ts，9 值）→ label/icon。
const QKIND: Record<string, { label: string; icon: LoomIconName }> = {
  choice: { label: '选择', icon: 'list' },
  true_false: { label: '判断', icon: 'check' },
  fill_blank: { label: '填空', icon: 'hash' },
  short_answer: { label: '简答', icon: 'pencil' },
  essay: { label: '论述', icon: 'doc' },
  computation: { label: '计算', icon: 'hash' },
  reading: { label: '阅读', icon: 'book' },
  translation: { label: '翻译', icon: 'book' },
  derivation: { label: '推导', icon: 'fx' },
};
const QKIND_FALLBACK = { label: '题', icon: 'quiz' as LoomIconName };
function kindMeta(kind: string) {
  return QKIND[kind] ?? QKIND_FALLBACK;
}

// 真 QuestionSource enum（core/schema/business.ts，13 值）→ label/tone/icon。
const QSOURCE: Record<string, { label: string; tone: Tone; icon: LoomIconName }> = {
  quiz_gen: { label: 'AI 生成', tone: 'coral', icon: 'sparkle' },
  dreaming: { label: 'Dreaming', tone: 'coral', icon: 'sparkle' },
  mistake_variant: { label: '错题变体', tone: 'coral', icon: 'sparkle' },
  copilot_authored: { label: 'Copilot 拟题', tone: 'coral', icon: 'sparkle' },
  web_sourced: { label: 'web 采集', tone: 'info', icon: 'download' },
  vision_single: { label: '拍照录入', tone: 'info', icon: 'camera' },
  vision_paper: { label: '拍照整卷', tone: 'info', icon: 'camera' },
  embedded: { label: '内嵌题', tone: 'info', icon: 'layers' },
  teaching_check: { label: '教学检查', tone: 'info', icon: 'teach' },
  daily: { label: '每日检查', tone: 'neutral', icon: 'clock' },
  final: { label: '终测', tone: 'neutral', icon: 'target' },
  reverse_mark: { label: '反向标记', tone: 'neutral', icon: 'reverse' },
  manual: { label: '手动录入', tone: 'neutral', icon: 'pencil' },
};
const QSOURCE_FALLBACK = {
  label: '其它来源',
  tone: 'neutral' as Tone,
  icon: 'doc' as LoomIconName,
};
function srcMeta(source: string) {
  return QSOURCE[source] ?? QSOURCE_FALLBACK;
}

// difficulty 1-5 → tone + word（data-questions.jsx QDIFF）。
const QDIFF: Record<number, { tone: Tone; word: string }> = {
  1: { tone: 'good', word: '易' },
  2: { tone: 'good', word: '较易' },
  3: { tone: 'hard', word: '中等' },
  4: { tone: 'again', word: '较难' },
  5: { tone: 'again', word: '难' },
};
function diffMeta(d: number) {
  return QDIFF[d] ?? { tone: 'hard' as Tone, word: `难度 ${d}` };
}

// subject profile id → label/tone（data-questions.jsx QSUBJECT，但 key 用真 profile id）。
// 真后端派生 subject 是 profile id（wenyan/math/general/physics/...）；这里把已知 id
// 上色，未知 id 用 fallback（neutral + id 原样），不 fabricate。
const QSUBJECT: Record<string, { label: string; tone: Tone }> = {
  wenyan: { label: '语文', tone: 'coral' },
  yuwen: { label: '语文', tone: 'coral' },
  math: { label: '数学', tone: 'info' },
  physics: { label: '物理', tone: 'info' },
  eng: { label: '英语', tone: 'good' },
  english: { label: '英语', tone: 'good' },
  general: { label: '通识', tone: 'neutral' },
};
function subjMeta(subject: string | null): { label: string; tone: Tone } {
  if (!subject) return { label: '未分科', tone: 'neutral' };
  return QSUBJECT[subject] ?? { label: subject, tone: 'neutral' };
}

// 去 markdown/latex 标记符——行 stem 与搜索匹配都用纯文本（避免 *`$ 干扰）。
function plainText(s: string): string {
  return (s || '').replace(/[*`$＿_]/g, '');
}

// created_at_sec（unix 秒）→ 日期标签（与 demo q.created 的 YYYY-MM-DD 同形）。
function dateLabel(sec: number): string {
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

// 题号搜索/排序辅助。
function isDraft(q: QBankQuestion): boolean {
  return q.draft_status === 'draft';
}

// variant lineage glyph：母题 ◆ / AI 变体 ◇ / 小题 ▫。
function lineageOf(q: QBankQuestion): 'root' | 'variant' | 'part' {
  if (q.parent_question_id) return 'part';
  if (q.root_question_id) return 'variant';
  return 'root';
}

// ── 小组件 ─────────────────────────────────────────────────────────────────

function QDiffPips({ d }: { d: number }) {
  const { tone, word } = diffMeta(d);
  return (
    <span className="qb-diff" title={`难度 ${d} · ${word}`}>
      <span className="qb-diff-pips">
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={`qb-pip${i <= d ? ` on tone-${tone}` : ''}`} />
        ))}
      </span>
      <span className="qb-diff-l">{word}</span>
    </span>
  );
}

function QKindBadge({ kind }: { kind: string }) {
  const k = kindMeta(kind);
  return (
    <span className="qb-kind">
      <LoomIcon name={k.icon} size={13} />
      {k.label}
    </span>
  );
}

function QSourceTag({ source }: { source: string }) {
  const s = srcMeta(source);
  return (
    <span className={`qb-source tone-${s.tone}`}>
      <LoomIcon name={s.icon} size={13} />
      {s.label}
    </span>
  );
}

// 题面文本内嵌 markdown/latex（design QInline → MathMarkdown 单段 unwrap，同 DraftReviewPage）。
function QInline({ text }: { text: string }) {
  return (
    <MathMarkdown notation="latex" className="q-md-inline" style={{ display: 'inline' }}>
      {text}
    </MathMarkdown>
  );
}

function QIndicators({ q }: { q: QBankQuestion }) {
  const subj = subjMeta(q.subject);
  // knowledge_labels 是 enrich 投影（缺名 id 已被后端落选）；null（未 enrich）→ 用裸 id 兜底。
  const labels = q.knowledge_labels ?? q.knowledge_ids.map((id) => ({ id, name: id }));
  return (
    <div className="qb-tags">
      <span className={`qb-subj tone-${subj.tone}`}>{subj.label}</span>
      {labels.map((k) => (
        <span key={k.id} className="qb-ktag">
          <LoomIcon name="tag" size={11} />
          {k.name}
        </span>
      ))}
      <span style={{ flex: 1 }} />
      {/* 微指示 attempts/review/mistakes/papers DEFER：后端 list 投影无这些聚合
          （detail 才有 timeline/backlinks），不渲也不 fabricate。下一刀接 list 聚合时回填。 */}
    </div>
  );
}

interface QRowProps {
  q: QBankQuestion;
  go: (to: string) => void;
  expanded?: boolean;
  onToggle?: () => void;
  isChild?: boolean;
  subIndex?: number;
}

function QRow({ q, go, expanded, onToggle, isChild, subIndex }: QRowProps) {
  const isComposite = q.is_composite;
  const lineage = lineageOf(q);
  const glyphCls = lineage === 'variant' ? ' is-variant' : lineage === 'part' ? ' is-part' : '';
  const glyph = lineage === 'variant' ? '◇' : lineage === 'part' ? '▫' : '◆';
  return (
    <div
      className={`qb-row${isChild ? ' is-child' : ''}`}
      // biome-ignore lint/a11y/useSemanticElements: 行内嵌套展开 <button>，<button> 不可含 interactive 子元素；div+role 是正确 ARIA 形态（同 DraftReviewPage 先例）
      role="button"
      tabIndex={0}
      onClick={() => go(`/questions/${q.id}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          go(`/questions/${q.id}`);
        }
      }}
    >
      <div className="qb-rail">
        {isComposite ? (
          <button
            type="button"
            className={`qb-expand${expanded ? ' open' : ''}`}
            title={expanded ? '收起小题' : '展开小题'}
            onClick={(e) => {
              e.stopPropagation();
              onToggle?.();
            }}
          >
            <LoomIcon name="arrow" size={13} />
          </button>
        ) : isChild ? (
          <span className="qb-subidx">{subIndex}</span>
        ) : (
          <span
            className={`qb-glyph${glyphCls}`}
            title={lineage === 'variant' ? 'AI 变体' : '母题'}
          >
            {glyph}
          </span>
        )}
      </div>

      <div className="qb-main">
        <div className="qb-stem">
          {isComposite && (
            <span className="qb-ktag" style={{ marginRight: 6, verticalAlign: 1 }}>
              <LoomIcon name="layers" size={11} />
              大题 · {q.children.length} 小题
            </span>
          )}
          <QInline text={plainText(q.prompt_md)} />
        </div>
        <QIndicators q={q} />
      </div>

      <div className="qb-aside">
        <QKindBadge kind={q.kind} />
        <QDiffPips d={q.difficulty} />
        <QSourceTag source={q.source} />
        <span className="qb-time">
          {isDraft(q) && <span className="qb-draftdot" style={{ marginRight: 4 }} />}
          {dateLabel(q.created_at_sec)}
        </span>
      </div>
    </div>
  );
}

// ── 主面 ───────────────────────────────────────────────────────────────────

type StatusTab = 'all' | 'active' | 'draft';
type SortBy = 'time' | 'diff';
type SortDir = 'asc' | 'desc';

export interface QuestionsPageProps {
  navigate: (to: string) => void;
}

export default function QuestionsPage({ navigate }: QuestionsPageProps) {
  // server-side 轴 state（变 → query key 变 → 重新 fetch）。题库面恒拉 include_drafts=true
  // 取全集（状态 tab 在 client 按 draft_status 分），server 不带 difficulty（多选 pips 在 client 过）。
  const [subject, setSubject] = useState('all');
  const [source, setSource] = useState('all');
  const [kind, setKind] = useState('all');

  // client-side state（搜索 / 状态 tab / 难度多选 / 知识点多选 / 排序 / 展开集）。
  const [status, setStatus] = useState<StatusTab>('all');
  const [diffs, setDiffs] = useState<number[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortBy>('time');
  const [dir, setDir] = useState<SortDir>('desc');
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  // list query：server-side 轴入 query key。limit=200（后端封顶）。
  const listQ = useQuery({
    queryKey: ['questions-bank', subject, source, kind],
    queryFn: () =>
      getQuestionsList({
        subject: subject === 'all' ? undefined : subject,
        source: source === 'all' ? undefined : source,
        kind: kind === 'all' ? undefined : kind,
        includeDrafts: true,
        limit: 200,
      }),
  });

  const top = useMemo(() => listQ.data?.items ?? [], [listQ.data]);

  // 知识点全集（kchip 来源）——从当前 page 实际出现的 enrich.knowledge_labels 动态生成。
  const allLabels = useMemo(() => {
    const seen = new Map<string, string>();
    for (const q of top) {
      for (const k of q.knowledge_labels ?? []) if (!seen.has(k.id)) seen.set(k.id, k.name);
      for (const c of q.children)
        for (const k of c.knowledge_labels ?? []) if (!seen.has(k.id)) seen.set(k.id, k.name);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [top]);

  const toggleLabel = (id: string) =>
    setLabels((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  const toggleDiff = (d: number) =>
    setDiffs((xs) => (xs.includes(d) ? xs.filter((x) => x !== d) : [...xs, d]));
  const toggleOpen = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const reset = () => {
    setStatus('all');
    setSubject('all');
    setSource('all');
    setKind('all');
    setDiffs([]);
    setLabels([]);
    setQuery('');
  };

  // search（client，同 DraftReviewPage 约定）：题面预览 + 题号 + 知识点名；composite
  // 也匹配任一子题（题面/题号）。useCallback 钉稳定身份，作 useMemo 的真实依赖（避免
  // 内联闭包让 Biome 看不见 query 依赖）。
  const matchQuery = useCallback(
    (q: QBankQuestion): boolean => {
      const needle = query.trim().toLowerCase();
      if (!needle) return true;
      const kLabels = (q.knowledge_labels ?? []).map((k) => k.name);
      const hay = [plainText(q.prompt_md), q.id, ...kLabels].join(' ').toLowerCase();
      const kids = q.children.some(
        (c) => plainText(c.prompt_md).toLowerCase().includes(needle) || c.id.includes(needle),
      );
      return hay.includes(needle) || kids;
    },
    [query],
  );

  const filtered = useMemo(() => {
    const out = top.filter(
      (q) =>
        (status === 'all' || (status === 'draft' ? isDraft(q) : !isDraft(q))) &&
        (diffs.length === 0 || diffs.includes(q.difficulty)) &&
        (labels.length === 0 ||
          (q.knowledge_labels ?? []).some((k) => labels.includes(k.id)) ||
          q.children.some((c) => (c.knowledge_labels ?? []).some((k) => labels.includes(k.id)))) &&
        matchQuery(q),
    );
    return [...out].sort((a, b) => {
      const v = sort === 'diff' ? a.difficulty - b.difficulty : a.created_at_sec - b.created_at_sec;
      return dir === 'asc' ? v : -v;
    });
  }, [top, status, diffs, labels, sort, dir, matchQuery]);

  const activeFilters =
    (status !== 'all' ? 1 : 0) +
    (subject !== 'all' ? 1 : 0) +
    (source !== 'all' ? 1 : 0) +
    (kind !== 'all' ? 1 : 0) +
    (diffs.length ? 1 : 0) +
    (labels.length ? 1 : 0) +
    (query.trim() ? 1 : 0);

  // ribbon 统计（对 top 全集）。childCount = 题库总小题数（含变体不计——variant 是顶层）。
  const childCount = useMemo(() => top.reduce((a, q) => a + q.children.length, 0), [top]);
  const draftN = top.filter(isDraft).length;
  const activeN = top.length - draftN;
  // 「在复习队列」DEFER（后端 list 无 review 聚合）→ 改渲「含变体」（真 variant_depth>0 计数）。
  const variantN = top.filter((q) => q.variant_depth > 0).length;

  // 来源 / 题型 select 选项——铺真 enum 全集（select 是 server-side 轴，需可选未在 page 出现的值）。
  const SOURCE_OPTIONS: Array<[string, string]> = [
    ['all', '全部来源'],
    ...Object.entries(QSOURCE).map(([k, v]) => [k, v.label] as [string, string]),
  ];
  const KIND_OPTIONS: Array<[string, string]> = [
    ['all', '全部题型'],
    ...Object.entries(QKIND).map(([k, v]) => [k, v.label] as [string, string]),
  ];

  const STATUS_TABS: Array<[StatusTab, string, number]> = [
    ['all', '全部', top.length],
    ['active', '正式', activeN],
    ['draft', '草稿', draftN],
  ];

  return (
    <div className="page view">
      <div className="page-head">
        <div className="eyebrow">QUESTIONS · question 全集 · 含变体 / 大题-小题 / 各录入来源</div>
        <div className="page-head-row">
          <h1 className="page-title serif">题库</h1>
          <div className="hero-cta">
            <Btn variant="ghost" icon="sparkle" onClick={() => navigate('/drafts')}>
              草稿审核
            </Btn>
            <Btn variant="primary" icon="plus" onClick={() => navigate('/record')}>
              新建题目
            </Btn>
          </div>
        </div>
      </div>

      {listQ.isError ? (
        <Card pad="lg">
          <EmptyState
            icon="alert"
            title="题库加载失败"
            text={(listQ.error as Error)?.message ?? '请稍后重试。'}
          />
        </Card>
      ) : listQ.isLoading ? (
        <Card pad="default">
          <SkLines rows={6} />
        </Card>
      ) : (
        <>
          {/* summary ribbon */}
          <div className="qb-ribbon">
            <div className="qb-stat">
              <span className="qb-stat-n tnum">
                {top.length}
                <span className="u">题（顶层）</span>
              </span>
              <span className="qb-stat-l">含 {childCount} 道小题</span>
            </div>
            <div className="qb-stat">
              <span className="qb-stat-n tnum">{activeN}</span>
              <span className="qb-stat-l">正式</span>
            </div>
            <div className="qb-stat accent">
              <span className="qb-stat-n tnum">{draftN}</span>
              <span className="qb-stat-l">草稿待审</span>
            </div>
            <div className="qb-stat">
              <span className="qb-stat-n tnum">{variantN}</span>
              <span className="qb-stat-l">AI 变体</span>
            </div>
          </div>

          {/* toolbar: search + sort */}
          <div className="qb-toolbar">
            <label className="qb-search">
              <LoomIcon name="search" size={16} />
              <input
                placeholder="搜索题面文本、知识点、题号…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button
                  type="button"
                  className="qb-search-clear"
                  onClick={() => setQuery('')}
                  aria-label="清除"
                >
                  <LoomIcon name="close" size={14} />
                </button>
              )}
            </label>
            <div className="qb-sort">
              <span className="qb-sort-l">排序</span>
              <div className="qb-seg">
                <button
                  type="button"
                  className={sort === 'time' ? 'on' : ''}
                  onClick={() => setSort('time')}
                >
                  <LoomIcon name="clock" size={13} />
                  时间
                </button>
                <button
                  type="button"
                  className={sort === 'diff' ? 'on' : ''}
                  onClick={() => setSort('diff')}
                >
                  <LoomIcon name="bolt" size={13} />
                  难度
                </button>
              </div>
              <button
                type="button"
                className="qb-seg"
                onClick={() => setDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                title="切换升降序"
                style={{ cursor: 'pointer' }}
              >
                <span className="qb-dir" style={{ padding: '5px 9px' }}>
                  {dir === 'asc' ? '↑ 升' : '↓ 降'}
                </span>
              </button>
            </div>
          </div>

          {/* status tabs */}
          <div className="qb-tabs" role="tablist">
            {STATUS_TABS.map(([s, l, n]) => (
              <button
                type="button"
                key={s}
                role="tab"
                aria-selected={status === s}
                className={`qb-tab${status === s ? ' on' : ''}`}
                onClick={() => setStatus(s)}
              >
                {l}
                <span className="qb-tab-n">{n}</span>
              </button>
            ))}
          </div>

          {/* filter bar */}
          <div className="qb-filterbar">
            <div className="qf2">
              <span className="qf2-l">科目</span>
              <div className="qb-seg">
                {[
                  ['all', '全部'],
                  ['wenyan', '语文'],
                  ['math', '数学'],
                  ['eng', '英语'],
                ].map(([s, l]) => (
                  <button
                    type="button"
                    key={s}
                    className={subject === s ? 'on' : ''}
                    onClick={() => setSubject(s)}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <span className="qb-filter-div" />
            <div className="qf2">
              <span className="qf2-l">来源</span>
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                {SOURCE_OPTIONS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="qf2">
              <span className="qf2-l">题型</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {KIND_OPTIONS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="qf2">
              <span className="qf2-l">难度</span>
              <span className="qf2-diff">
                {[1, 2, 3, 4, 5].map((d) => (
                  <button
                    type="button"
                    key={d}
                    className={`qf2-pip${diffs.includes(d) ? ' on' : ''}`}
                    onClick={() => toggleDiff(d)}
                  >
                    {d}
                  </button>
                ))}
              </span>
            </div>
            {activeFilters > 0 && (
              <button type="button" className="qf2-reset" onClick={reset}>
                <LoomIcon name="close" size={13} />
                清除 {activeFilters} 项筛选
              </button>
            )}
          </div>

          {/* knowledge label filter */}
          {allLabels.length > 0 && (
            <div className="qb-klabel">
              <span className="qb-klabel-l">知识点</span>
              {allLabels.map((k) => (
                <button
                  type="button"
                  key={k.id}
                  className={`kchip${labels.includes(k.id) ? ' on' : ''}`}
                  onClick={() => toggleLabel(k.id)}
                >
                  {labels.includes(k.id) && <LoomIcon name="check" size={11} />}
                  {k.name}
                </button>
              ))}
            </div>
          )}

          {/* list / empty states */}
          {top.length === 0 ? (
            <Card pad="lg">
              <EmptyState
                icon="quiz"
                title="题库还是空的"
                text="拍一道题、上传一张试卷，或让 AI 从你的错题生成变体，题目会自动入库。"
                action={
                  <div style={{ display: 'flex', gap: 'var(--s-2)', marginTop: 'var(--s-3)' }}>
                    <Btn variant="primary" icon="camera" onClick={() => navigate('/record')}>
                      拍照录入
                    </Btn>
                    <Btn variant="secondary" icon="record" onClick={() => navigate('/record')}>
                      上传试卷
                    </Btn>
                  </div>
                }
              />
            </Card>
          ) : filtered.length === 0 ? (
            <Card pad="lg">
              <EmptyState
                icon="search"
                title="没有匹配的题目"
                text="放宽筛选条件或清除搜索。"
                action={
                  <Btn size="sm" variant="secondary" icon="close" onClick={reset}>
                    清除全部
                  </Btn>
                }
              />
            </Card>
          ) : (
            <Card className="qb-list" pad="default">
              {filtered.map((q) => (
                <Fragment key={q.id}>
                  <QRow
                    q={q}
                    go={navigate}
                    expanded={open.has(q.id)}
                    onToggle={() => toggleOpen(q.id)}
                  />
                  {q.is_composite &&
                    open.has(q.id) &&
                    q.children.map((c, i) => (
                      <QRow key={c.id} q={c} go={navigate} isChild subIndex={i + 1} />
                    ))}
                </Fragment>
              ))}
            </Card>
          )}

          <div className="qb-count">
            <span className="meta">
              显示 {filtered.length} / {top.length} 道顶层题目
            </span>
            {activeFilters > 0 && (
              <button type="button" className="qf2-reset" style={{ margin: 0 }} onClick={reset}>
                <LoomIcon name="refresh" size={13} />
                重置
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
