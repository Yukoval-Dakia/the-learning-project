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
//   • 状态 tab（全部/正式/草稿）— 真 draft_status（NULL≡正式 / 'draft'≡草稿），随其它
//     过滤、搜索、排序一起由 server 在分页前执行，避免只筛已加载页。
//   • 分页策略 — 每次 20 条 progressive load；response.page.has_more + total 是唯一分页
//     真相。subject/source/kind/difficulty/knowledge/search/status/sort 均跨页走 server。
//   • 省略 attempts/review/mistakes/papers 微指示 — 后端 list 投影无这些聚合（detail 才有
//     timeline/backlinks）；QIndicators 只渲 subject + 知识点 tags，微指示 DEFER（注释标明）。
//   • ribbon「在复习队列」统计同因后端 list 无 review 聚合 → DEFER，ribbon 改渲「含变体」
//     替代（真 variant_depth>0 计数），不 fabricate 假复习数。

import { resolveKnownSubjectId } from '@/subjects/profile';
import { useSubjects } from '@/ui/hooks/useSubjects';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { type SubjectRowLike, listSubjectChoices, subjectDisplayName } from '@/ui/lib/subject';
import { formatCnDateOnly } from '@/ui/lib/utils';
import { Btn } from '@/ui/primitives/Btn';
import { Card } from '@/ui/primitives/Card';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Fragment, memo, useCallback, useEffect, useMemo, useState } from 'react';
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

// subject 派生轴 → label/tone. Label 从注册表派生（subjectDisplayName，alias-aware：
// 旧 wenyan → yuwen），不再硬编码；accent 色留 UI 侧 map-by-id（未知 id 用 neutral
// 默认，不塞进 profile schema）——YUK-249 注册表驱动。真后端派生 subject 是 profile id
// （yuwen/math/physics/general/...）或旧别名，二者都归一到 canonical id 上色。
const SUBJECT_TONE: Record<string, Tone> = {
  yuwen: 'coral',
  math: 'info',
  physics: 'info',
};
function subjMeta(
  subject: string | null,
  rows?: readonly SubjectRowLike[],
): { label: string; tone: Tone } {
  if (!subject) return { label: '未分科', tone: 'neutral' };
  const id = resolveKnownSubjectId(subject) ?? subject;
  // YUK-598：label 行驱动（custom 显示名只有 provider 行认识）；tone 仍本地
  // map-by-id，custom 恒 neutral = v2 已接受的降级（SUBJECT_TONE 不进水合面）。
  return { label: subjectDisplayName(subject, rows), tone: SUBJECT_TONE[id] ?? 'neutral' };
}

// 去 markdown/latex 标记符——仅用于搜索匹配（行 stem 渲染走 QInline 保留 latex）。
function plainText(s: string): string {
  return (s || '').replace(/[*`$＿_]/g, '');
}

const QUESTION_PAGE_SIZE = 20;
const ACCESSIBLE_PROMPT_CHARS = 36;

export function questionRowAccessibleName(
  q: Pick<QBankQuestion, 'prompt_md' | 'is_composite'>,
  isChild = false,
  subIndex?: number,
): string {
  const compact = plainText(q.prompt_md).replace(/\s+/g, ' ').trim();
  const summary =
    compact.length > ACCESSIBLE_PROMPT_CHARS
      ? `${compact.slice(0, ACCESSIBLE_PROMPT_CHARS)}…`
      : compact;
  const kind = isChild
    ? `小题${subIndex != null ? ` ${subIndex}` : ''}`
    : q.is_composite
      ? '大题'
      : '题目';
  return summary ? `打开${kind}：${summary}` : `打开${kind}`;
}

// created_at_sec（unix 秒）→ 日期标签（与 demo q.created 的 YYYY-MM-DD 同形）。
// 本地日历日（formatCnDateOnly），不是 UTC 切片——否则 UTC+8 学习者在本地 00:00–08:00
// 落库的题会显示成前一天。
function dateLabel(sec: number): string {
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return formatCnDateOnly(d);
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
function QInline({ text, notation }: { text: string; notation: string | null }) {
  return (
    <MathMarkdown notation={notation} className="q-md-inline" style={{ display: 'inline' }}>
      {text}
    </MathMarkdown>
  );
}

function QIndicators({
  q,
  subjectRows,
}: {
  q: QBankQuestion;
  subjectRows: readonly SubjectRowLike[];
}) {
  const subj = subjMeta(q.subject, subjectRows);
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
  // YUK-598（review-757 P3-1）：rows 自主组件单次 useSubjects 下传，避免逐行
  // QueryObserver（网络本就去重；省的是长列表的订阅开销）。
  subjectRows: readonly SubjectRowLike[];
  expanded?: boolean;
  // Receives the composite id so the parent can pass one stable callback for all
  // rows (a per-row `() => toggleOpen(q.id)` closure would defeat React.memo).
  onToggle?: (id: string) => void;
  isChild?: boolean;
  subIndex?: number;
}

// YUK-715 — memoized so a search keystroke (which re-renders the whole page but
// leaves this row's props referentially unchanged) does not re-run the row's
// ReactMarkdown parse. Honest memo depends on stable props from the parent: `q`
// (react-query page item), `go`/`subjectRows` (stable refs), `expanded` (bool),
// and `onToggle` (a single useCallback'd `toggleOpen`, not a per-row closure).
export const QRow = memo(function QRow({
  q,
  go,
  subjectRows,
  expanded,
  onToggle,
  isChild,
  subIndex,
}: QRowProps) {
  const isComposite = q.is_composite;
  const lineage = lineageOf(q);
  const glyphCls = lineage === 'variant' ? ' is-variant' : lineage === 'part' ? ' is-part' : '';
  const glyph = lineage === 'variant' ? '◇' : lineage === 'part' ? '▫' : '◆';
  return (
    <div className="qb-row-shell">
      <div
        className={`qb-row${isChild ? ' is-child' : ''}`}
        // 行本身与“展开小题”是并列控件，避免 role=button 内再嵌套 button。
        // biome-ignore lint/a11y/useSemanticElements: row contains rich block layout; sibling expand remains a native button
        role="button"
        tabIndex={0}
        aria-label={questionRowAccessibleName(q, isChild, subIndex)}
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
            <span className="qb-expand-slot" aria-hidden="true" />
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
            <QInline text={q.prompt_md} notation={q.notation} />
          </div>
          <QIndicators q={q} subjectRows={subjectRows} />
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
      {isComposite && (
        <button
          type="button"
          className={`qb-expand qb-expand-action${expanded ? ' open' : ''}`}
          aria-label={expanded ? '收起小题' : '展开小题'}
          aria-expanded={expanded}
          onClick={() => onToggle?.(q.id)}
        >
          <LoomIcon name="arrow" size={13} />
        </button>
      )}
    </div>
  );
});

// ── 主面 ───────────────────────────────────────────────────────────────────

type StatusTab = 'all' | 'active' | 'draft';
type SortBy = 'time' | 'diff';
type SortDir = 'asc' | 'desc';

export interface QuestionsPageProps {
  navigate: (to: string) => void;
}

export default function QuestionsPage({ navigate }: QuestionsPageProps) {
  // YUK-598 — 科目筛选行驱动（provider selectable 视图）。
  const { subjects: subjectRowsForFilter } = useSubjects();
  // 所有会改变结果集的轴都进入 server query key；分页前过滤/排序，避免只处理当前页。
  const [subject, setSubject] = useState('all');
  const [source, setSource] = useState('all');
  const [kind, setKind] = useState('all');

  const [status, setStatus] = useState<StatusTab>('all');
  const [diffs, setDiffs] = useState<number[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [sort, setSort] = useState<SortBy>('time');
  const [dir, setDir] = useState<SortDir>('desc');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [knownLabels, setKnownLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const stableDiffs = useMemo(() => [...diffs].sort((a, b) => a - b), [diffs]);
  const stableLabels = useMemo(() => [...labels].sort(), [labels]);

  const listQ = useInfiniteQuery({
    queryKey: [
      'questions-bank',
      subject,
      source,
      kind,
      status,
      stableDiffs,
      stableLabels,
      debouncedQuery,
      sort,
      dir,
    ],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getQuestionsList({
        subject: subject === 'all' ? undefined : subject,
        source: source === 'all' ? undefined : source,
        kind: kind === 'all' ? undefined : kind,
        status,
        difficulties: stableDiffs,
        knowledgeIds: stableLabels,
        search: debouncedQuery || undefined,
        sortBy: sort === 'diff' ? 'difficulty' : 'created_at',
        sortDir: dir,
        includeDrafts: true,
        limit: QUESTION_PAGE_SIZE,
        offset: pageParam,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.page.has_more ? lastPage.page.offset + lastPage.items.length : undefined,
  });

  const top = useMemo(() => listQ.data?.pages.flatMap((page) => page.items) ?? [], [listQ.data]);
  const total = listQ.data?.pages[0]?.total ?? 0;

  useEffect(() => {
    if (top.length === 0) return;
    setKnownLabels((current) => {
      let changed = false;
      const next = { ...current };
      for (const q of top) {
        for (const k of q.knowledge_labels ?? []) {
          if (next[k.id] !== k.name) {
            next[k.id] = k.name;
            changed = true;
          }
        }
        for (const child of q.children) {
          for (const k of child.knowledge_labels ?? []) {
            if (next[k.id] !== k.name) {
              next[k.id] = k.name;
              changed = true;
            }
          }
        }
      }
      return changed ? next : current;
    });
  }, [top]);

  // 已见知识点在切换 server filter 后仍保留为可撤销 chip；选中后由 API 跨全库过滤。
  const allLabels = useMemo(
    () => Object.entries(knownLabels).map(([id, name]) => ({ id, name })),
    [knownLabels],
  );

  const toggleLabel = (id: string) =>
    setLabels((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  const toggleDiff = (d: number) =>
    setDiffs((xs) => (xs.includes(d) ? xs.filter((x) => x !== d) : [...xs, d]));
  // Stable across renders (setOpen is stable, no deps) so it can be passed as the
  // single `onToggle` for every QRow without breaking their React.memo (YUK-715).
  const toggleOpen = useCallback(
    (id: string) =>
      setOpen((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    [],
  );
  const reset = () => {
    setStatus('all');
    setSubject('all');
    setSource('all');
    setKind('all');
    setDiffs([]);
    setLabels([]);
    setQuery('');
    setSort('time');
    setDir('desc');
    setOpen(new Set());
  };

  const activeFilters =
    (status !== 'all' ? 1 : 0) +
    (subject !== 'all' ? 1 : 0) +
    (source !== 'all' ? 1 : 0) +
    (kind !== 'all' ? 1 : 0) +
    (diffs.length ? 1 : 0) +
    (labels.length ? 1 : 0) +
    (query.trim() ? 1 : 0);

  // ribbon 的 total 来自 server 完整过滤集；其余三项明确标注“已加载”，不把 page 当全集。
  const childCount = useMemo(() => top.reduce((a, q) => a + q.children.length, 0), [top]);
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

  const STATUS_TABS: Array<[StatusTab, string]> = [
    ['all', '全部'],
    ['active', '正式'],
    ['draft', '草稿'],
  ];

  return (
    <div className="page view">
      <div className="page-head">
        <div className="eyebrow">题目总览 · 含变体、大题与各类录入来源</div>
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
                {total}
                <span className="u">题（顶层）</span>
              </span>
              <span className="qb-stat-l">符合当前条件</span>
            </div>
            <div className="qb-stat">
              <span className="qb-stat-n tnum">{top.length}</span>
              <span className="qb-stat-l">已加载题目</span>
            </div>
            <div className="qb-stat accent">
              <span className="qb-stat-n tnum">{childCount}</span>
              <span className="qb-stat-l">已加载小题</span>
            </div>
            <div className="qb-stat">
              <span className="qb-stat-n tnum">{variantN}</span>
              <span className="qb-stat-l">已加载变体</span>
            </div>
          </div>

          {/* toolbar: search + sort */}
          <div className="qb-toolbar">
            <label className="qb-search">
              <LoomIcon name="search" size={16} />
              <input
                aria-label="搜索题目"
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
                  aria-pressed={sort === 'time'}
                  onClick={() => setSort('time')}
                >
                  <LoomIcon name="clock" size={13} />
                  时间
                </button>
                <button
                  type="button"
                  className={sort === 'diff' ? 'on' : ''}
                  aria-pressed={sort === 'diff'}
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
            {STATUS_TABS.map(([s, l]) => (
              <button
                type="button"
                key={s}
                role="tab"
                aria-selected={status === s}
                className={`qb-tab${status === s ? ' on' : ''}`}
                onClick={() => setStatus(s)}
              >
                {l}
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
                  // YUK-249 → YUK-598：科目筛选项行驱动（provider selectable 视图，
                  // custom 科目即时进筛选；断网退化三 builtin）。
                  ...listSubjectChoices(subjectRowsForFilter).map((c) => [c.id, c.label]),
                ].map(([s, l]) => (
                  <button
                    type="button"
                    key={s}
                    className={subject === s ? 'on' : ''}
                    aria-pressed={subject === s}
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
              <select
                aria-label="按来源筛选"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                {SOURCE_OPTIONS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="qf2">
              <span className="qf2-l">题型</span>
              <select
                aria-label="按题型筛选"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
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
                    aria-label={`难度 ${d}`}
                    aria-pressed={diffs.includes(d)}
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
                  aria-pressed={labels.includes(k.id)}
                  onClick={() => toggleLabel(k.id)}
                >
                  {labels.includes(k.id) && <LoomIcon name="check" size={11} />}
                  {k.name}
                </button>
              ))}
            </div>
          )}

          {/* list / empty states */}
          {top.length === 0 && activeFilters === 0 ? (
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
          ) : top.length === 0 ? (
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
              {top.map((q) => (
                <Fragment key={q.id}>
                  <QRow
                    q={q}
                    go={navigate}
                    subjectRows={subjectRowsForFilter}
                    expanded={open.has(q.id)}
                    onToggle={toggleOpen}
                  />
                  {q.is_composite &&
                    open.has(q.id) &&
                    q.children.map((c, i) => (
                      <QRow
                        key={c.id}
                        q={c}
                        go={navigate}
                        subjectRows={subjectRowsForFilter}
                        isChild
                        subIndex={i + 1}
                      />
                    ))}
                </Fragment>
              ))}
            </Card>
          )}

          <div className="qb-count">
            <span className="meta" aria-live="polite">
              已显示 {top.length} / {total} 道顶层题目
            </span>
            {listQ.hasNextPage && (
              <Btn
                size="sm"
                variant="secondary"
                icon="arrow"
                disabled={listQ.isFetchingNextPage}
                onClick={() => void listQ.fetchNextPage()}
              >
                {listQ.isFetchingNextPage ? '加载中…' : '继续加载'}
              </Btn>
            )}
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
