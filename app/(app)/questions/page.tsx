'use client';

// YUK-288 题库 UI S1 (只读侧) — /questions list. Recreates screen-questions.jsx:
// summary ribbon → search+sort toolbar → status tabs → subject tabs (SPEC 补轴) →
// filter bar (来源 / 题型 / 难度) → knowledge label chips → Stateful list → count
// footer + empty states. Read-only: rows link to the detail route; no write paths.
//
// Field mapping (mock → API) lives in src/ui/questions/meta.ts + the plan §4.
// Two axes degrade client-side (plan §3): 题面搜索 (gap C) and 草稿-only tab
// (gap D) — see src/ui/questions/filter.ts.

import { subjectProfiles, toSlimSubjectProfile } from '@/subjects/profile';
import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { resolveSubjectRenderModel } from '@/ui/lib/subject';
import { formatRelTime } from '@/ui/lib/utils';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful, type StatefulStatus } from '@/ui/primitives/Stateful';
import { QuestionRow } from '@/ui/questions/QuestionRow';
import {
  type SortDir,
  type SortKey,
  type StatusTab,
  isDraft,
  matchQuery,
  matchStatusTab,
  sortItems,
} from '@/ui/questions/filter';
import { kindMeta, sourceMeta } from '@/ui/questions/meta';
import type { ListQuestionsResult, QuestionListItem } from '@/ui/questions/types';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';

// The canonical kind / source vocabularies for the filter selects (real enums).
// Kept in render order; the labels come from meta.ts (single source of truth).
const KIND_OPTIONS = [
  'choice',
  'true_false',
  'fill_blank',
  'short_answer',
  'essay',
  'computation',
  'reading',
  'translation',
  'derivation',
];
const SOURCE_OPTIONS = [
  'manual',
  'vision_paper',
  'vision_single',
  'quiz_gen',
  'mistake_variant',
  'web_sourced',
  'teaching_check',
  'daily',
  'final',
  'dreaming',
];

// Subject tabs (SPEC 补轴) from the SubjectProfile registry. `__all` is the
// no-subject-filter pseudo-tab.
const SUBJECT_TABS: Array<{ id: string; label: string }> = [
  { id: '__all', label: '全部科目' },
  ...Object.values(subjectProfiles).map((p) => ({ id: p.id, label: p.displayName })),
];

// knowledge id → label. The list reader returns only ids (no names — plan §4); we
// surface the id text as the chip label (matching /mistakes behaviour). A
// server-side name join is a follow-up. Hoisted to module scope so it has a stable
// identity (no useMemo dependency churn). The single resolver for chips + search.
const labelFor = (id: string): string => id;

export default function QuestionsPage() {
  const [status, setStatus] = useState<StatusTab>('all');
  const [subject, setSubject] = useState('__all');
  const [source, setSource] = useState('all');
  const [kind, setKind] = useState('all');
  const [diffs, setDiffs] = useState<number[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('time');
  const [dir, setDir] = useState<SortDir>('desc');

  // Build the server query string from the SQL-backed axes. 题面搜索 (gap C) and
  // 草稿 tab (gap D) are NOT sent — they filter client-side. 来源/题型/难度/知识点/
  // 科目 map to real reader params. include_drafts is always true so the client
  // can split 全部 / 正式 / 草稿 locally without a re-fetch per tab.
  const queryString = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set('include_drafts', 'true');
    sp.set('limit', '200');
    if (subject !== '__all') sp.set('subject', subject);
    if (source !== 'all') sp.set('source', source);
    if (kind !== 'all') sp.set('kind', kind);
    // A single difficulty is a server axis; multiple selected pips degrade to a
    // client filter (the reader takes one difficulty). Send when exactly one.
    if (diffs.length === 1) sp.set('difficulty', String(diffs[0]));
    for (const k of labels) sp.append('knowledge_id', k);
    return sp.toString();
  }, [subject, source, kind, diffs, labels]);

  const q = useQuery({
    queryKey: ['questions', queryString],
    queryFn: () => apiJson<ListQuestionsResult>(`/api/questions?${queryString}`),
    refetchOnWindowFocus: false,
  });

  const allItems = q.data?.items ?? [];

  // notation per active subject (gap: list rows have no per-row subject). S1 uses
  // the selected subject tab's render model; 全部科目 falls back to the default
  // (wenyan → no latex). math/physics → latex. Only 'latex' must enable KaTeX
  // (PR #83); any other notation string renders `$...$` as raw text.
  const notation = useMemo<'latex' | undefined>(() => {
    const profile =
      subject !== '__all' && subjectProfiles[subject]
        ? toSlimSubjectProfile(subjectProfiles[subject])
        : null;
    return resolveSubjectRenderModel(profile).renderConfig.notation === 'latex'
      ? 'latex'
      : undefined;
  }, [subject]);

  // Client-side pipeline (gap C + gap D + multi-difficulty + sort).
  const filtered = useMemo(() => {
    const out = allItems
      .filter((item) => matchStatusTab(item, status))
      .filter((item) => diffs.length <= 1 || diffs.includes(item.difficulty))
      .filter((item) => matchQuery(item, query, labelFor));
    return sortItems(out, sort, dir);
  }, [allItems, status, diffs, query, sort, dir]);

  // Summary ribbon counts (over the fetched set, before search/sort).
  const total = allItems.length;
  const draftN = allItems.filter(isDraft).length;
  const activeN = total - draftN;

  // All knowledge ids present in the fetched page → the label-chip filter row.
  const allLabels = useMemo(
    () => [...new Set(allItems.flatMap((i) => i.knowledge_ids))],
    [allItems],
  );

  const activeFilters =
    (status !== 'all' ? 1 : 0) +
    (subject !== '__all' ? 1 : 0) +
    (source !== 'all' ? 1 : 0) +
    (kind !== 'all' ? 1 : 0) +
    (diffs.length ? 1 : 0) +
    (labels.length ? 1 : 0) +
    (query.trim() ? 1 : 0);

  const reset = () => {
    setStatus('all');
    setSubject('__all');
    setSource('all');
    setKind('all');
    setDiffs([]);
    setLabels([]);
    setQuery('');
  };
  const toggleLabel = (k: string) =>
    setLabels((xs) => (xs.includes(k) ? xs.filter((x) => x !== k) : [...xs, k]));
  const toggleDiff = (d: number) =>
    setDiffs((xs) => (xs.includes(d) ? xs.filter((x) => x !== d) : [...xs, d]));

  const dataStatus: StatefulStatus = q.isLoading
    ? 'loading'
    : q.isError
      ? 'error'
      : total === 0
        ? 'empty'
        : 'ok';
  const errorText =
    q.error instanceof ApiAuthError
      ? `${q.error.message} — 请重新进入页面输入 token`
      : q.error
        ? `加载失败：${(q.error as Error).message}`
        : '题库加载失败。';

  return (
    <main className="page view questions-loom">
      <div className="page-head">
        <div className="eyebrow">QUESTIONS · question 全集 · 含变体 / 大题-小题 / 各录入来源</div>
        <div className="page-head-row">
          <h1 className="page-title serif">题库</h1>
          <div className="hero-cta">
            <Link href="/record" className="btn btn-primary btn-sm">
              <LoomIcon name="plus" size={15} />
              新建题目
            </Link>
          </div>
        </div>
      </div>

      {/* summary ribbon */}
      <div className="qb-ribbon">
        <div className="qb-stat">
          <span className="qb-stat-n tnum">
            {total}
            <span className="u">题</span>
          </span>
          <span className="qb-stat-l">题库总量</span>
        </div>
        <div className="qb-stat">
          <span className="qb-stat-n tnum">{activeN}</span>
          <span className="qb-stat-l">正式</span>
        </div>
        <div className="qb-stat accent">
          <span className="qb-stat-n tnum">{draftN}</span>
          <span className="qb-stat-l">草稿待审</span>
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
              className={sort === 'difficulty' ? 'on' : ''}
              onClick={() => setSort('difficulty')}
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

      {/* status tabs (全部 / 正式 / 草稿 — gap D client split) */}
      <div className="qb-tabs" role="tablist">
        {(
          [
            ['all', '全部', total],
            ['active', '正式', activeN],
            ['draft', '草稿', draftN],
          ] as Array<[StatusTab, string, number]>
        ).map(([s, l, n]) => (
          <button
            key={s}
            type="button"
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

      {/* subject tabs (SPEC 补轴 → ?subject= 派生轴) */}
      <div className="qb-tabs qb-subject-tabs" role="tablist">
        {SUBJECT_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={subject === t.id}
            className={`qb-tab${subject === t.id ? ' on' : ''}`}
            onClick={() => setSubject(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* filter bar: 来源 / 题型 / 难度 pips */}
      <div className="qb-filterbar">
        <div className="qf2">
          <span className="qf2-l">来源</span>
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">全部来源</option>
            {SOURCE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {sourceMeta(s).label}
              </option>
            ))}
          </select>
        </div>
        <div className="qf2">
          <span className="qf2-l">题型</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="all">全部题型</option>
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {kindMeta(k).label}
              </option>
            ))}
          </select>
        </div>
        <div className="qf2">
          <span className="qf2-l">难度</span>
          <span className="qf2-diff">
            {[1, 2, 3, 4, 5].map((d) => (
              <button
                key={d}
                type="button"
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

      {/* knowledge label filter chips */}
      {allLabels.length > 0 && (
        <div className="qb-klabel">
          <span className="qb-klabel-l">知识点</span>
          {allLabels.map((k) => (
            <button
              key={k}
              type="button"
              className={`kchip${labels.includes(k) ? ' on' : ''}`}
              onClick={() => toggleLabel(k)}
            >
              {labels.includes(k) && <LoomIcon name="check" size={11} />}
              {labelFor(k)}
            </button>
          ))}
        </div>
      )}

      <Stateful
        status={dataStatus}
        onRetry={() => q.refetch()}
        errorText={errorText}
        skeleton={
          <LoomCard pad>
            <SkLines rows={6} />
          </LoomCard>
        }
        empty={
          <LoomCard padLg>
            <EmptyState
              icon="quiz"
              title="题库还是空的"
              text="拍一道题、上传一张试卷，或让 AI 从你的错题生成变体，题目会自动入库。"
              action={
                <div style={{ display: 'flex', gap: 'var(--s-2)', marginTop: 'var(--s-3)' }}>
                  <Link href="/record" className="btn btn-primary btn-sm">
                    <LoomIcon name="camera" size={15} />
                    拍照录入
                  </Link>
                  <Link href="/record" className="btn btn-secondary btn-sm">
                    <LoomIcon name="record" size={15} />
                    上传试卷
                  </Link>
                </div>
              }
            />
          </LoomCard>
        }
      >
        {filtered.length === 0 ? (
          <LoomCard padLg>
            <EmptyState
              icon="search"
              title="没有匹配的题目"
              text="放宽筛选条件或清除搜索。"
              action={
                <button type="button" className="btn btn-secondary btn-sm" onClick={reset}>
                  <LoomIcon name="close" size={15} />
                  清除全部
                </button>
              }
            />
          </LoomCard>
        ) : (
          <LoomCard className="qb-list">
            {filtered.map((item: QuestionListItem) => (
              <QuestionRow
                key={item.id}
                item={item}
                labelFor={labelFor}
                notation={notation}
                formatTime={(sec) => formatRelTime(new Date(sec * 1000))}
              />
            ))}
          </LoomCard>
        )}
        <div className="qb-count">
          <span className="meta">
            显示 {filtered.length} / {total} 道题目
            {q.data?.truncated ? '（已截断，请缩小筛选范围）' : ''}
          </span>
          {activeFilters > 0 && (
            <button type="button" className="qf2-reset" style={{ margin: 0 }} onClick={reset}>
              <LoomIcon name="refresh" size={13} />
              重置
            </button>
          )}
        </div>
      </Stateful>
    </main>
  );
}
