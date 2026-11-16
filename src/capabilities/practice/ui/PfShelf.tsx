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

import type { PaperTaskRef } from '../session/public';
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

/**
 * YUK-1633 — 估时文案如实标注 pace 来源：observed 是学习者实测中位数，
 * default 是样本不足的默认口径；null（host 未装估时读口/估时不可得）
 * 不编数字。UI 不得重立系数，分钟数只经 canonical wire。
 */
function estimateLabel(p: PaperListItem): string {
  if (p.estimated_minutes == null || p.estimated_minutes_source == null) {
    return '估时未知';
  }
  const minutes = Math.ceil(p.estimated_minutes);
  return p.estimated_minutes_source === 'observed'
    ? `约 ${minutes} 分钟 · 按你的做题速度`
    : `约 ${minutes} 分钟 · 默认估时`;
}

/** A card's foot: what state the paper is in and its one action (same order as before). */
function paperFoot(
  p: PaperListItem,
  isGen: boolean,
  isDone: boolean,
  openPaper: (artifactId: string, taskRef?: PaperTaskRef) => void,
  openRetro: (artifactId: string, taskRef?: PaperTaskRef) => void,
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
        <Button
          variant="secondary"
          disabled={!p.session?.task_ref}
          onClick={() => openRetro(p.artifact_id, p.session?.task_ref ?? undefined)}
        >
          复盘 · 逐题与去向
          <ArrowRight size={18} aria-hidden="true" />
        </Button>
      </>
    );
  }
  return (
    <>
      {/* 待做态显示估时（设计 pface-shelf.jsx L83 待做卷显示 today.est）。
          YUK-1633：估时走 scheduling owner 的 canonical 值（pace 一次批量读 +
          owner 定价公式），UI 不再套本地系数。observed 与 default 来源分开标注，
          不冒充个人观测；估时不可得（null）如实不显示数字。在做态仍显
          draft（恢复优先于估时）。 */}
      <span className="pf-paper-when">{sess ? '读取此会话已保存的版本' : estimateLabel(p)}</span>
      {/* Resuming is the one filled action; a fresh start stays outlined, as in the queue. */}
      <Button
        variant={sess ? 'primary' : 'secondary'}
        disabled={sess !== null && !sess.task_ref}
        onClick={() => openPaper(p.artifact_id, p.session?.task_ref ?? undefined)}
      >
        {sess ? <RotateCcw size={18} aria-hidden="true" /> : <Zap size={18} aria-hidden="true" />}
        {sess && !sess.task_ref ? '此会话缺少恢复身份' : sess ? '继续' : '开始'}
      </Button>
    </>
  );
}

export function PfShelf({
  openPaper,
  openRetro,
}: {
  openPaper: (artifactId: string, taskRef?: PaperTaskRef) => void;
  openRetro: (artifactId: string, taskRef?: PaperTaskRef) => void;
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
    // Same counts as the paper's summary: only a fully correct answer is 对, out of the graded answers.
    const partial = sess?.partial ?? 0;
    const correct = (sess?.right ?? 0) - partial;
    const graded = (sess?.right ?? 0) + (sess?.wrong ?? 0);
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
              已答 {sess.pos}/{p.total_slots}
            </span>
          </div>
        )}
        {isDone && sess && (
          <div className="pf-dist-row">
            <div className="pf-dist">
              <div className="pf-dist-bar" aria-hidden="true">
                {correct > 0 && <span data-seg="good" style={{ flex: correct }} />}
                {partial > 0 && <span data-seg="hard" style={{ flex: partial }} />}
                {sess.wrong > 0 && <span data-seg="again" style={{ flex: sess.wrong }} />}
              </div>
              <p className="pf-dist-legend">
                <span data-seg="good">{correct} 对</span>
                {partial > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span data-seg="hard">{partial} 部分</span>
                  </>
                )}
                <span aria-hidden="true">·</span>
                <span data-seg="again">{sess.wrong} 错</span>
              </p>
            </div>
            <p className="pf-dist-score">
              <b>{graded > 0 ? Math.round((correct / graded) * 100) : 0}%</b>
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
