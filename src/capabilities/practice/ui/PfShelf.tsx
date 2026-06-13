// M2 练习面 — 卷架（YUK-316）。
// 设计基准 docs/design/loom-refresh/project/pface-shelf.jsx：卷的持久收藏与复盘。
// 三区（待做 / 在做 / 已完成·可复盘）× 来源筛选；唯一写操作 = 从待做/在做卷发起
// 作答。数据 = GET /api/practice（papers + session 状态 + 分布），分区在前端做。

import { Btn } from '@/ui/primitives/Btn';
import { Card } from '@/ui/primitives/Card';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { type PaperListItem, getPapers } from './practice-api';

// intent_source → 设计稿来源三类（AI 打包 / 点播 / 导入）。
function shelfSource(p: PaperListItem): 'paper' | 'on_demand' | 'import' {
  if (p.intent_source === 'ingestion_paper') return 'import';
  if (p.intent_source === 'quiz_gen') return 'on_demand';
  return 'paper';
}

const SRC_LABEL: Record<string, string> = {
  paper: 'AI 打包',
  on_demand: '点播',
  import: '导入',
};

export function PfShelf({
  openPaper,
  openRetro,
}: {
  openPaper: (artifactId: string) => void;
  openRetro: (artifactId: string) => void;
}) {
  const papersQ = useQuery({ queryKey: ['papers'], queryFn: getPapers });
  const [src, setSrc] = useState<'all' | 'paper' | 'on_demand' | 'import'>('all');

  if (papersQ.isLoading) return <p className="quiet-empty">取卷架…</p>;
  if (papersQ.isError)
    return <p className="quiet-empty">卷架加载失败：{(papersQ.error as Error).message}</p>;

  const papers = papersQ.data?.papers ?? [];
  const fil = (arr: PaperListItem[]) =>
    src === 'all' ? arr : arr.filter((p) => shelfSource(p) === src);

  const generating = papers.filter((p) => p.generation_status !== 'ready');
  const ready = papers.filter((p) => p.generation_status === 'ready');
  const todo = ready.filter((p) => p.session === null);
  const doing = ready.filter((p) => p.session !== null && p.session.status !== 'completed');
  const done = ready.filter((p) => p.session?.status === 'completed');

  const counts: Record<string, number> = {};
  for (const p of papers) {
    const s = shelfSource(p);
    counts[s] = (counts[s] ?? 0) + 1;
  }

  const card = (p: PaperListItem) => {
    const s = shelfSource(p);
    const sess = p.session;
    const isDone = sess?.status === 'completed';
    const isGen = p.generation_status !== 'ready';
    return (
      <Card
        pad="default"
        key={p.artifact_id}
        className={`paper-card${isDone ? ' is-past' : ''}${isGen ? ' is-gen' : ''}`}
      >
        <div className="paper-top">
          <span
            className={`card-icon paper-src tone-${s === 'paper' ? 'coral' : s === 'import' ? 'info' : 'neutral'}`}
          >
            <LoomIcon
              name={s === 'paper' ? 'layers' : s === 'import' ? 'record' : 'send'}
              size={18}
            />
          </span>
          <div className="paper-head-main">
            <div className="paper-title">{p.title}</div>
            <div className="paper-meta nowrap-meta">
              <span>{SRC_LABEL[s]}</span>
              <span className="dot-sep">·</span>
              <span>{new Date(p.created_at).toLocaleDateString('zh-CN')}</span>
            </div>
          </div>
          <div className="paper-count">
            <b className="tnum">{p.total_slots}</b>
            <span>题</span>
          </div>
        </div>
        {p.knowledge.length > 0 && (
          <div className="paper-know">
            {p.knowledge.slice(0, 4).map((k) => (
              <span key={k.id} className="chip chip-k">
                {k.name}
              </span>
            ))}
          </div>
        )}

        {sess && !isDone && (
          <div className="paper-prog">
            <div className="bar">
              <span style={{ width: `${(sess.pos / Math.max(p.total_slots, 1)) * 100}%` }} />
            </div>
            <span className="paper-prog-label tnum">
              已答 {sess.pos}/{p.total_slots} · 草稿已存
            </span>
          </div>
        )}
        {isDone && sess && (
          <div className="dist-row">
            <div className="dist-block">
              <div className="dist-bar">
                {sess.right > 0 && <span className="dist-seg good" style={{ flex: sess.right }} />}
                {sess.wrong > 0 && <span className="dist-seg again" style={{ flex: sess.wrong }} />}
              </div>
              <div className="dist-legend">
                <span className="g-right">{sess.right} 对</span>
                <span className="dot-sep">·</span>
                <span className="g-wrong">{sess.wrong} 待巩固</span>
              </div>
            </div>
            <div className="dist-score">
              <b className="serif tnum">
                {p.total_slots > 0 ? Math.round((sess.right / p.total_slots) * 100) : 0}%
              </b>
              <span>正确率</span>
            </div>
          </div>
        )}

        <div className="paper-foot">
          {isGen ? (
            <>
              <span className="paper-when">排卷中…</span>
              <Btn size="sm" variant="ghost" icon="clock" disabled>
                等待生成
              </Btn>
            </>
          ) : isDone ? (
            <>
              <span className="paper-when">已完成</span>
              <Btn
                size="sm"
                variant="secondary"
                iconEnd="arrow"
                onClick={() => openRetro(p.artifact_id)}
              >
                复盘 · 逐题与去向
              </Btn>
            </>
          ) : (
            <>
              {/* 待做态显示估时（设计 pface-shelf.jsx L83 待做卷显示 today.est）。
                  估算依据：PaperListItem wire 无 est/duration 字段（仅 total_slots），按题数
                  × 1.5 分钟/题估算——沿用 PfStream etaMin 的题数系数惯例（设计点播卷示例
                  8 题≈12 分钟，即 1.5 分钟/题）。FOLLOW-UP（phase-deferred）：补 paper 读模型
                  est 真值后接真值，见报告。在做态仍显 draft（恢复优先于估时）。 */}
              <span className="paper-when mono">
                {sess ? 'draft · 可恢复' : `约 ${Math.ceil(p.total_slots * 1.5)} 分钟`}
              </span>
              <Btn
                size="sm"
                variant="primary"
                icon={sess ? 'review' : 'bolt'}
                onClick={() => openPaper(p.artifact_id)}
              >
                {sess ? '继续' : '开始'}
              </Btn>
            </>
          )}
        </div>
      </Card>
    );
  };

  const section = (label: string, arr: PaperListItem[]) => {
    const list = fil(arr);
    if (list.length === 0) return null;
    return (
      <div key={label}>
        <SectionLabel count={list.length}>{label}</SectionLabel>
        <div className="paper-grid">{list.map(card)}</div>
      </div>
    );
  };

  const FILTERS: Array<['all' | 'paper' | 'on_demand' | 'import', string]> = [
    ['all', '全部'],
    ['paper', 'AI 打包'],
    ['on_demand', '点播'],
    ['import', '导入'],
  ];

  return (
    <div className="pface" data-screen-label="卷架">
      <div className="pfh-filter">
        <span className="filter-row-l mono">来源</span>
        {FILTERS.map(([k, label]) => (
          <button
            type="button"
            key={k}
            className={`chip${src === k ? ' chip-k' : ''}`}
            onClick={() => setSrc(k)}
          >
            {label}
            {k !== 'all' && counts[k] ? (
              <span className="tnum" style={{ opacity: 0.7 }}>
                {counts[k]}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {section('待做', [...todo, ...generating])}
      {section('在做', doing)}
      {section('已完成 · 可复盘', done)}

      {fil(papers).length === 0 && (
        <EmptyState
          icon="archive"
          title="这个来源下还没有卷"
          text="换个筛选，或回到流里看看今天排了什么。"
        />
      )}
    </div>
  );
}
