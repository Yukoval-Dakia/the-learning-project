// PaperCard — practice paper list card.
// Ported from docs/design/loom-prototype/screen-practice.jsx:13-99.
// Type annotation: 'session.type' is always 'review' (RL1, U5 §5.1).
// No `type='paper'` string ships here.
//
// Source taxonomy: coach=review_plan / custom=quiz_gen / note=embedded_check
// (§4.10 critic #4; matches data-practice.jsx:PRACTICE_SRC and
//  PracticeSource type in src/server/review/practice-read.ts).

import type { PracticePaperItem } from '@/server/review/practice-read';
import { Btn } from '@/ui/primitives/Btn';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import type { LoomIconName } from '@/ui/primitives/LoomIcon';
// PaperStatusPill intentionally NOT mounted here — see comment at card end.

interface SrcMeta {
  label: string;
  icon: LoomIconName;
  tone: string;
}

const PRACTICE_SRC: Record<string, SrcMeta> = {
  coach: { label: 'Coach 排期', icon: 'target', tone: 'good' },
  custom: { label: '用户自建', icon: 'pencil', tone: 'coral' },
  note: { label: '笔记小测', icon: 'doc', tone: 'info' },
  other: { label: '其它', icon: 'items', tone: 'neutral' },
};

export interface PaperCardProps {
  paper: PracticePaperItem;
  onAction: (artifactId: string) => void;
  past?: boolean;
}

export function PaperCard({ paper, onAction, past }: PaperCardProps) {
  const src = PRACTICE_SRC[paper.source] ?? PRACTICE_SRC.other;
  const s = paper.session;
  const generating = paper.generation_status !== 'ready';
  const sessionStatus = s?.status ?? null;

  const failed = paper.generation_status === 'failed';
  // Map real DB session statuses to display states.
  // 'started' | 'paused' → in_progress; 'completed' → done; null/abandoned → not_started
  const displayState: 'failed' | 'generating' | 'in_progress' | 'done' | 'not_started' = failed
    ? 'failed'
    : generating
      ? 'generating'
      : sessionStatus === 'started' || sessionStatus === 'paused'
        ? 'in_progress'
        : sessionStatus === 'completed'
          ? 'done'
          : 'not_started';

  const pct =
    displayState === 'done' && s && s.right + s.wrong > 0
      ? Math.round((s.right / (s.right + s.wrong)) * 100)
      : 0;

  const createdLabel = formatRelativeDate(paper.created_at);

  return (
    <LoomCard
      pad
      hover={
        displayState === 'not_started' || displayState === 'in_progress' || displayState === 'done'
      }
      className={`paper-card${displayState === 'generating' ? ' is-gen' : ''}${past ? ' is-past' : ''}`}
    >
      {/* ── top row: icon / title / meta / count ── */}
      <div className="paper-top">
        <span className={`card-icon paper-src tone-${src.tone}`}>
          <LoomIcon name={src.icon} size={18} />
        </span>
        <div className="paper-head-main">
          <div className="paper-title">{paper.title}</div>
          <div className="paper-meta nowrap-meta">
            <span>{src.label}</span>
            <span className="dot-sep">·</span>
            <span>{createdLabel}</span>
            {displayState === 'done' && s && (
              <>
                <span className="dot-sep">·</span>
                <span>{s.right + s.wrong} 题已批</span>
              </>
            )}
          </div>
        </div>
        <div className="paper-count">
          <b className="tnum">{paper.total_slots}</b>
          <span>题</span>
        </div>
      </div>

      {/* ── knowledge chips — deduped by id ── */}
      {paper.knowledge.length > 0 && (
        <div className="paper-know">
          {[...new Map(paper.knowledge.map((k) => [k.id, k])).values()].map((k) => (
            <span key={k.id} className="chip chip-k">
              {k.name}
            </span>
          ))}
        </div>
      )}

      {/* ── generating shimmer bar ── */}
      {/* gated on displayState (not the raw `generating` flag) so a `failed`
          paper shows only the 生成失败 pill + disabled button — no contradictory
          排卷中 shimmer / dimmed title (re-review LOW finding) */}
      {displayState === 'generating' && (
        <div className="paper-genbar">
          <div className="bar">
            <span style={{ width: '40%' }} />
          </div>
          <span className="paper-gen-label">
            <LoomIcon name="refresh" size={12} className="spin" />
            排卷中…
          </span>
        </div>
      )}

      {/* ── in-progress position bar ── */}
      {displayState === 'in_progress' && s && paper.total_slots > 0 && (
        <div className="paper-prog">
          <div className="bar">
            <span style={{ width: `${(s.pos / paper.total_slots) * 100}%` }} />
          </div>
          <span className="paper-prog-label tnum">
            {s.pos}/{paper.total_slots} · 余 {paper.total_slots - s.pos} 题
          </span>
        </div>
      )}

      {/* ── done summary: dist bar ── */}
      {displayState === 'done' && s && (
        <div className="dist-row">
          <div className="dist-block">
            <div className="dist-bar">
              {/* flex: s.right collapses the green segment when all wrong; that's correct */}
              <span className="dist-seg good" style={{ flex: s.right }} />
              <span className="dist-seg again" style={{ flex: s.wrong }} />
            </div>
            <div className="dist-legend">
              <span className="g-right">{s.right} 对</span>
              <span className="dot-sep">·</span>
              <span className="g-wrong">{s.wrong} 错</span>
            </div>
          </div>
          <div className="dist-score">
            <b className="serif tnum">{pct}%</b>
            <span>正确率</span>
          </div>
        </div>
      )}

      {/* ── footer: status / action ── */}
      <div className="paper-foot">
        {/* left: when / status text */}
        {displayState === 'done' ? (
          <span className="paper-when">{createdLabel} 完成</span>
        ) : displayState === 'in_progress' ? (
          <span className="paper-when mono">已答 {s?.pos ?? 0} 题 · 可恢复</span>
        ) : displayState === 'failed' ? (
          <span className="paper-when" style={{ color: 'var(--again-ink)' }}>
            生成失败
          </span>
        ) : generating ? (
          <span className="paper-when">Coach 排卷中…</span>
        ) : (
          <span className="paper-when">未开始</span>
        )}

        {/* right: action button */}
        {displayState === 'failed' ? (
          <Btn size="sm" variant="ghost" icon="alert" disabled>
            生成失败
          </Btn>
        ) : generating ? (
          <Btn size="sm" variant="ghost" icon="clock" disabled>
            等待生成
          </Btn>
        ) : displayState === 'in_progress' ? (
          <Btn
            size="sm"
            variant="primary"
            icon="review"
            onClick={() => onAction(paper.artifact_id)}
          >
            继续
          </Btn>
        ) : displayState === 'done' ? (
          <Btn
            size="sm"
            variant="secondary"
            iconEnd="arrow"
            onClick={() => onAction(paper.artifact_id)}
          >
            查看回顾
          </Btn>
        ) : (
          <Btn size="sm" variant="primary" icon="bolt" onClick={() => onAction(paper.artifact_id)}>
            开始
          </Btn>
        )}
      </div>

      {/* NO corner status pill: the design source defines PaperStatusPill but
          never mounts it (screen-practice.jsx:5, dead code) — state is conveyed
          via the foot line + action button. The earlier absolute overlay also
          collided with .paper-count (visual loop finding). */}
    </LoomCard>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function formatRelativeDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return '今日';
  if (diffDays === 1) return '昨日';
  if (diffDays < 7) return `${diffDays} 天前`;
  if (diffDays < 14) return '上周';
  return `${Math.floor(diffDays / 7)} 周前`;
}
