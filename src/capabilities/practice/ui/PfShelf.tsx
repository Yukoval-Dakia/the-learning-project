// M2 练习面 — 卷架（YUK-316）。
// 设计基准 docs/design/loom-refresh/project/pface-shelf.jsx：卷的持久收藏与复盘。
// 三区（待做 / 在做 / 已完成·可复盘）× 来源筛选；唯一写操作 = 从待做/在做卷发起
// 作答。数据 = GET /api/papers（papers + session 状态 + 分布），分区在前端做。
// M3E 呈现：docs/design/2026-11-03-practice-face-m3e.md（样式 practice-face-m3e.css）。

import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Clock,
  Download,
  Layers,
  type LucideIcon,
  RotateCcw,
  Send,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import { Button, Chip, ChipToggle } from '@/ui-next/public';

import type { PaperListItem } from './practice-api';
import { usePracticeClient } from './practice-client';

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

/** The source's icon and the tint of its icon disc. */
const SRC_LOOK: Record<'paper' | 'on_demand' | 'import', { icon: LucideIcon; tone: string }> = {
  paper: { icon: Layers, tone: 'accent' },
  import: { icon: Download, tone: 'info' },
  on_demand: { icon: Send, tone: 'neutral' },
};

/** A card's foot: what state the paper is in and its one action (same order as before). */
function paperFoot(
  p: PaperListItem,
  isGen: boolean,
  isDone: boolean,
  openPaper: (artifactId: string) => void,
  openRetro: (artifactId: string) => void,
) {
  const sess = p.session;
  if (isGen) {
    return (
      <>
        <span className="pf-paper-when">排卷中…</span>
        <Button variant="ghost" disabled>
          <Clock size={18} aria-hidden="true" />
          等待生成
        </Button>
      </>
    );
  }
  if (isDone) {
    return (
      <>
        <span className="pf-paper-when">已完成</span>
        <Button variant="secondary" onClick={() => openRetro(p.artifact_id)}>
          复盘 · 逐题与去向
          <ArrowRight size={18} aria-hidden="true" />
        </Button>
      </>
    );
  }
  return (
    <>
      {/* 待做态显示估时（设计 pface-shelf.jsx L83 待做卷显示 today.est）。
          估算依据：PaperListItem wire 无 est/duration 字段（仅 total_slots），按题数
          × 1.5 分钟/题估算——沿用 PfStream etaMin 的题数系数惯例（设计点播卷示例
          8 题≈12 分钟，即 1.5 分钟/题）。FOLLOW-UP（phase-deferred）：补 paper 读模型
          est 真值后接真值，见报告。在做态仍显 draft（恢复优先于估时）。 */}
      <span className="pf-paper-when">
        {sess ? 'draft · 可恢复' : `约 ${Math.ceil(p.total_slots * 1.5)} 分钟`}
      </span>
      {/* Resuming is the one filled action; a fresh start stays outlined, as in the queue. */}
      <Button variant={sess ? 'primary' : 'secondary'} onClick={() => openPaper(p.artifact_id)}>
        {sess ? <RotateCcw size={18} aria-hidden="true" /> : <Zap size={18} aria-hidden="true" />}
        {sess ? '继续' : '开始'}
      </Button>
    </>
  );
}

export function PfShelf({
  openPaper,
  openRetro,
}: {
  openPaper: (artifactId: string) => void;
  openRetro: (artifactId: string) => void;
}) {
  const { getPapers } = usePracticeClient();
  const papersQ = useQuery({ queryKey: ['papers'], queryFn: getPapers });
  const [src, setSrc] = useState<'all' | 'paper' | 'on_demand' | 'import'>('all');

  if (papersQ.isLoading)
    return (
      <p className="pf-m3-state un-m3e-bridge" role="status">
        取卷架…
      </p>
    );
  if (papersQ.isError)
    return (
      <p className="pf-m3-state un-m3e-bridge" role="alert">
        卷架加载失败：{(papersQ.error as Error).message}
      </p>
    );

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
    const look = SRC_LOOK[s];
    const SrcIcon = look.icon;
    let state: string | undefined;
    if (isGen) state = 'gen';
    else if (isDone) state = 'done';
    return (
      <article key={p.artifact_id} className="pf-paper" data-state={state}>
        <div className="pf-paper-top">
          <span className="pf-paper-src" data-tone={look.tone} aria-hidden="true">
            <SrcIcon size={20} />
          </span>
          <div className="pf-paper-head">
            <h3 className="pf-paper-title">{p.title}</h3>
            <p className="pf-paper-meta">
              <span>{SRC_LABEL[s]}</span>
              <span aria-hidden="true">·</span>
              <span>{new Date(p.created_at).toLocaleDateString('zh-CN')}</span>
            </p>
          </div>
          <p className="pf-paper-count">
            <b>{p.total_slots}</b>
            <span>题</span>
          </p>
        </div>
        {p.knowledge.length > 0 && (
          <div className="pf-paper-know">
            {p.knowledge.slice(0, 4).map((k) => (
              <Chip key={k.id}>{k.name}</Chip>
            ))}
          </div>
        )}

        {sess && !isDone && (
          <div className="pf-paper-prog">
            <div className="pf-bar" aria-hidden="true">
              <span style={{ width: `${(sess.pos / Math.max(p.total_slots, 1)) * 100}%` }} />
            </div>
            <span className="pf-paper-prog-label">
              已答 {sess.pos}/{p.total_slots} · 草稿已存
            </span>
          </div>
        )}
        {isDone && sess && (
          <div className="pf-dist-row">
            <div className="pf-dist">
              <div className="pf-dist-bar" aria-hidden="true">
                {sess.right > 0 && <span data-seg="good" style={{ flex: sess.right }} />}
                {sess.wrong > 0 && <span data-seg="again" style={{ flex: sess.wrong }} />}
              </div>
              <p className="pf-dist-legend">
                <span data-seg="good">{sess.right} 对</span>
                <span aria-hidden="true">·</span>
                <span data-seg="again">{sess.wrong} 待巩固</span>
              </p>
            </div>
            <p className="pf-dist-score">
              <b>{p.total_slots > 0 ? Math.round((sess.right / p.total_slots) * 100) : 0}%</b>
              <span>正确率</span>
            </p>
          </div>
        )}

        <div className="pf-paper-foot">{paperFoot(p, isGen, isDone, openPaper, openRetro)}</div>
      </article>
    );
  };

  const section = (label: string, arr: PaperListItem[]) => {
    const list = fil(arr);
    if (list.length === 0) return null;
    return (
      <section key={label} className="pf-shelf-section">
        <h2 className="pf-shelf-h2">
          {label} <span className="pf-shelf-h2-n">{list.length}</span>
        </h2>
        <div className="pf-shelf-grid">{list.map(card)}</div>
      </section>
    );
  };

  const FILTERS: Array<['all' | 'paper' | 'on_demand' | 'import', string]> = [
    ['all', '全部'],
    ['paper', 'AI 打包'],
    ['on_demand', '点播'],
    ['import', '导入'],
  ];

  return (
    <div className="pf-shelf un-m3e-bridge" data-screen-label="卷架">
      <div className="pf-shelf-filter">
        <span className="pf-shelf-filter-l">来源</span>
        {FILTERS.map(([k, label]) => (
          <ChipToggle
            key={k}
            className="un-m3e-control"
            pressed={src === k}
            onPressedChange={() => setSrc(k)}
          >
            {label}
            {k !== 'all' && counts[k] ? <span className="pf-shelf-n">{counts[k]}</span> : null}
          </ChipToggle>
        ))}
      </div>

      {section('待做', [...todo, ...generating])}
      {section('在做', doing)}
      {section('已完成 · 可复盘', done)}

      {fil(papers).length === 0 && (
        <div className="pf-m3-state">
          <h2>这个来源下还没有卷</h2>
          <p>换个筛选，或回到流里看看今天排了什么。</p>
        </div>
      )}
    </div>
  );
}
