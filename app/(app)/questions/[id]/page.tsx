'use client';

// YUK-288 题库 UI S1 (只读侧) — /questions/[id] detail. Recreates
// screen-question-detail.jsx: back-link → page-head(badges + difficulty) →
// parent 面包屑(若是小题) → kd-grid（左 kd-main：passage / stem+预览 / options /
// answer / 小题列表 / 变体家族；右 kd-side qd-side：属性卡 / 关联状态卡 / 删除卡）→
// DeleteModal（portal）。
//
// S1 红线 (plan §7): 只读。编辑/删除是写操作（PATCH/DELETE = YUK-281）—— 所有
// 编辑/删除控件按设计外形 render 但 disabled + 「YUK-281 接线后启用」注释。

import { ApiAuthError, ApiError, apiJson } from '@/ui/lib/api';
import { formatRelTime } from '@/ui/lib/utils';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomBadge } from '@/ui/primitives/LoomBadge';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful, type StatefulStatus } from '@/ui/primitives/Stateful';
import { QMarkdown } from '@/ui/questions/QMarkdown';
import {
  choiceKey,
  difficultyMeta,
  groundingTierMeta,
  kindMeta,
  sourceMeta,
} from '@/ui/questions/meta';
import type { MasteryDecayBucket, QuestionDetail, QuestionDetailPart } from '@/ui/questions/types';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { type ReactElement, use } from 'react';

// decay bucket → 中文 + tone (mirrors the knowledge-page decay vocabulary).
const DECAY_LABEL: Record<
  MasteryDecayBucket,
  { label: string; tone: 'good' | 'hard' | 'again' | 'neutral' }
> = {
  fresh: { label: '新鲜', tone: 'good' },
  mild: { label: '略旧', tone: 'hard' },
  stale: { label: '陈旧', tone: 'again' },
  untrained: { label: '未训练', tone: 'neutral' },
  unknown: { label: '未知', tone: 'neutral' },
};

// intent_source → 中文 group label for the卷引用 backlinks.
const INTENT_SOURCE_LABEL: Record<string, string> = {
  quiz_gen: 'AI 组卷',
  embedded_check: '随文小测',
  ingestion_paper: '试卷录入',
  manual: '手动',
};

function DiffPips({ d }: { d: number }): ReactElement {
  const meta = difficultyMeta(d);
  return (
    <span className="qb-diff" title={`难度 ${d} · ${meta.word}`}>
      <span className="qb-diff-pips">
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={`qb-pip${i <= d ? ` on tone-${meta.tone}` : ''}`} />
        ))}
      </span>
      <span className="qb-diff-l">{meta.word}</span>
    </span>
  );
}

export default function QuestionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const detailQ = useQuery({
    queryKey: ['question-detail', id],
    queryFn: () => apiJson<QuestionDetail>(`/api/questions/${id}`),
    enabled: !!id,
    refetchOnWindowFocus: false,
  });

  const q = detailQ.data;

  // loading / error / not-found share the back-link + page-head shell with a
  // Stateful body (mirrors knowledge/[id]).
  if (detailQ.isLoading || detailQ.isError || !q) {
    const isNotFound = detailQ.error instanceof ApiError && detailQ.error.status === 404;
    const status: StatefulStatus = detailQ.isLoading
      ? 'loading'
      : isNotFound
        ? 'empty'
        : detailQ.isError
          ? 'error'
          : 'empty';
    const errorText =
      detailQ.error instanceof ApiAuthError
        ? `${detailQ.error.message} — 请重新进入页面输入 token`
        : detailQ.isError
          ? `加载失败：${(detailQ.error as Error).message}`
          : '题目加载失败。';
    return (
      <div className="page questions-loom">
        <Link href="/questions" className="back-link">
          <LoomIcon name="arrowL" size={14} />
          题库
        </Link>
        <div className="page-head">
          <div className="eyebrow meta mono">QUESTION · {id.slice(0, 8)}…</div>
          <h1 className="page-title serif">{detailQ.isLoading ? '加载中…' : '题目'}</h1>
        </div>
        <Stateful
          status={status}
          skeleton={<SkLines rows={6} />}
          errorText={errorText}
          onRetry={() => detailQ.refetch()}
          empty={<EmptyState icon="quiz" title="题目不存在" text="该题目可能已被删除。" />}
        >
          <div />
        </Stateful>
      </div>
    );
  }

  const kind = kindMeta(q.kind);
  const source = sourceMeta(q.source);
  const tier = groundingTierMeta(q.source_tier.tier);
  const isComposite = q.parts.length > 0;
  const isPart = q.parent_question_id !== null;
  const isRoot = q.root_question_id === null;
  const variants = q.family.members.filter((m) => m.id !== q.family.root_question_id);
  const notation = undefined; // S1: per-row subject notation not threaded; default no-latex (wenyan-safe).

  const attempts = q.timeline.filter((t) => t.kind === 'attempt').length;
  const reviewDue =
    q.scheduling.per_knowledge.some((p) => p.due_at_sec !== null) ||
    q.scheduling.legacy_question_fsrs !== null;
  const paperCount = q.backlinks.length;

  return (
    <div className="page view questions-loom">
      <Link href="/questions" className="back-link">
        <LoomIcon name="arrowL" size={14} />
        题库
      </Link>

      <div className="page-head">
        <div className="eyebrow meta mono">
          QUESTION · {q.id.slice(0, 8)}… · {kind.label} · {source.label}
        </div>
        <div className="page-head-row">
          <div className="qd-head-meta">
            <LoomBadge tone={q.draft_status === 'draft' ? 'hard' : 'good'}>
              {q.draft_status === 'draft' ? '草稿' : '正式'}
            </LoomBadge>
            {isComposite && (
              <LoomBadge tone="info">
                <LoomIcon name="layers" size={12} />
                大题 · {q.parts.length} 小题
              </LoomBadge>
            )}
            {!isRoot && (
              <LoomBadge tone="info">
                <LoomIcon name="sparkle" size={12} />
                AI 变体 · 深度 {q.variant_depth}
              </LoomBadge>
            )}
            {isRoot && variants.length > 0 && (
              <LoomBadge tone="coral">
                <LoomIcon name="sparkle" size={12} />
                母题 · {variants.length} 变体
              </LoomBadge>
            )}
            <LoomBadge tone={tier.tone}>{tier.label}</LoomBadge>
            <DiffPips d={q.difficulty} />
          </div>
          <div className="hero-cta">
            {/* phase-deferred: 保存修改 is a write (PATCH) — YUK-281 接线后启用.
                S1 renders the control disabled to preserve the design shape. */}
            <button
              type="button"
              className="btn btn-secondary"
              disabled
              title="编辑功能待 YUK-281 接线"
            >
              <LoomIcon name="check" size={17} />
              保存修改
            </button>
          </div>
        </div>
      </div>

      {/* parent 面包屑 (when THIS question is a小题) */}
      {isPart && q.parent_question_id && (
        <Link
          href={`/questions/${q.parent_question_id}`}
          className="qd-sub"
          style={{ marginBottom: 'var(--s-4)' }}
        >
          <span className="qd-sub-idx">
            <LoomIcon name="arrowL" size={13} />
          </span>
          <span className="qd-sub-body">
            <span className="meta">所属大题 · 第 {(q.part_index ?? 0) + 1} 小题</span>
          </span>
          <LoomIcon name="arrow" size={14} className="thread-arrow" />
        </Link>
      )}

      <div className="kd-grid">
        <div className="kd-main">
          {/* stem + 预览 (S1: read-only — no editable textarea) */}
          <div className="qd-sec">
            <div className="qd-sec-h">
              <LoomIcon name="quiz" size={14} />
              题面 stem · Markdown + LaTeX
            </div>
            <div className="qd-preview">
              <div className="qd-preview-tag">
                <LoomIcon name="eye" size={12} />
                预览
              </div>
              <QMarkdown text={q.prompt_md} notation={notation} />
            </div>
            <QuestionFigures figures={q.figures} imageRefs={q.image_refs} />
          </div>

          {/* options (choice) — choices_md is an ordered string[]; key derived by index. */}
          {q.choices_md && q.choices_md.length > 0 && (
            <div className="qd-sec">
              <div className="qd-sec-h">
                <LoomIcon name="list" size={14} />
                选项
              </div>
              <div className="qd-opts">
                {q.choices_md.map((text, i) => (
                  <div key={choiceKey(i)} className="qd-opt">
                    {/* phase-deferred: clicking a key to set the answer is a write
                        (YUK-281). S1 renders the key as a static badge. */}
                    <span className="qd-opt-key">{choiceKey(i)}</span>
                    <div className="qd-opt-text">
                      <QMarkdown text={text} notation={notation} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 参考答案 */}
          {q.reference_md && (
            <div className="qd-sec">
              <div className="qd-sec-h">
                <LoomIcon name="checkCircle" size={14} />
                参考答案
              </div>
              <div className="qd-answer">
                <QMarkdown text={q.reference_md} notation={notation} />
              </div>
            </div>
          )}

          {/* composite 小题列表 (gap A — parts[]; empty for all phase-1 data today) */}
          {isComposite && (
            <div className="qd-sec">
              <div className="qd-sec-h">
                <LoomIcon name="layers" size={14} />
                小题 · {q.parts.length} 道
              </div>
              <div className="qd-subs">
                {q.parts.map((part: QuestionDetailPart) => (
                  <Link key={part.id} href={`/questions/${part.id}`} className="qd-sub">
                    <span className="qd-sub-idx">{part.part_index + 1}</span>
                    <span className="qd-sub-body">
                      <div className="qd-sub-stem">
                        <QMarkdown text={part.prompt_md} notation={notation} />
                      </div>
                      <div className="qd-sub-meta">
                        <span className="badge tone-neutral">{kindMeta(part.kind).label}</span>
                        {part.draft_status === 'draft' && <LoomBadge tone="hard">草稿</LoomBadge>}
                      </div>
                    </span>
                    <LoomIcon name="arrow" size={14} className="thread-arrow" />
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* 变体家族 lineage (root only; reader returns the full family) */}
          {isRoot && (
            <div className="qd-sec">
              <div className="qd-sec-h">
                <LoomIcon name="sparkle" size={14} />
                变体家族 lineage
              </div>
              {variants.length === 0 ? (
                <LoomCard pad>
                  <EmptyState
                    icon="sparkle"
                    title="尚无变体"
                    text="让 AI 基于此题或它的错因生成同型变体，形成变体家族。"
                  />
                </LoomCard>
              ) : (
                <LoomCard pad>
                  {q.family.members.map((m) => (
                    <div
                      key={m.id}
                      className={`qd-fam-node${m.variant_depth > 0 ? ' variant' : ''}${m.is_self ? ' is-current' : ''}`}
                    >
                      <span className="qd-fam-dot" />
                      {m.is_self ? (
                        <span className="qd-fam-link">
                          <div className="qd-fam-t">{kindMeta(m.kind).label} · 当前</div>
                        </span>
                      ) : (
                        <Link href={`/questions/${m.id}`} className="qd-fam-link">
                          <div className="qd-fam-t">
                            {kindMeta(m.kind).label} · 深度 {m.variant_depth}
                          </div>
                        </Link>
                      )}
                      <span className="badge tone-neutral" style={{ flex: 'none' }}>
                        {kindMeta(m.kind).label}
                      </span>
                      {m.is_self && <span className="qd-fam-cur">当前</span>}
                    </div>
                  ))}
                </LoomCard>
              )}
            </div>
          )}
        </div>

        {/* side rail */}
        <div className="kd-side qd-side">
          <div className="qd-sec-h">
            <LoomIcon name="settings" size={14} />
            属性
          </div>
          <LoomCard pad>
            <div className="qd-prop">
              <div className="qd-prop-l">题型</div>
              <div className="qd-prop-val">
                <LoomIcon name={kind.icon} size={15} />
                {kind.label}
              </div>
            </div>
            <div className="qd-prop">
              <div className="qd-prop-l">难度 1–5</div>
              <DiffPips d={q.difficulty} />
            </div>
            <div className="qd-prop">
              <div className="qd-prop-l">
                知识点 <span className="meta">· 关联知识图谱</span>
              </div>
              <div className="qd-chipset">
                {q.labels.length === 0 ? (
                  <span className="meta">无关联知识点</span>
                ) : (
                  q.labels.map((l) => (
                    <Link key={l.id} href={`/knowledge/${l.id}`} className="qd-chip">
                      {l.name}
                    </Link>
                  ))
                )}
              </div>
            </div>
            <div className="qd-prop">
              <div className="qd-prop-l">来源</div>
              <div className="qd-prop-val">
                <LoomIcon name={source.icon} size={15} />
                {source.label}
              </div>
            </div>
            <div className="qd-prop">
              <div className="qd-prop-l">创建时间</div>
              <div className="qd-prop-time">{formatRelTime(new Date(q.created_at_sec * 1000))}</div>
            </div>
          </LoomCard>

          <div className="qd-sec-h" style={{ marginTop: 'var(--s-4)' }}>
            <LoomIcon name="link" size={14} />
            关联状态
          </div>
          <LoomCard pad>
            <div className="qd-assoc">
              <div className="qd-assoc-cell">
                <span className={`qd-assoc-n${attempts ? ' hot' : ''}`}>{attempts}</span>
                <span className="qd-assoc-l">作答次数</span>
              </div>
              <div className="qd-assoc-cell">
                <span className="qd-assoc-n">{reviewDue ? '✓' : '—'}</span>
                <span className="qd-assoc-l">在复习队列</span>
              </div>
              <div className="qd-assoc-cell">
                <span className="qd-assoc-n">{paperCount}</span>
                <span className="qd-assoc-l">卷引用</span>
              </div>
              <div className="qd-assoc-cell">
                <span
                  className={`qd-assoc-n tone-${DECAY_LABEL[q.scheduling.aggregate_decay_bucket].tone}`}
                >
                  {DECAY_LABEL[q.scheduling.aggregate_decay_bucket].label}
                </span>
                <span className="qd-assoc-l">新鲜度</span>
              </div>
            </div>
            {paperCount > 0 && (
              <div className="qd-paperlist">
                {Object.entries(q.backlinks_by_intent_source).map(([intent, links]) => (
                  <div key={intent}>
                    <div className="meta mono" style={{ marginTop: 'var(--s-2)' }}>
                      {INTENT_SOURCE_LABEL[intent] ?? intent} · {links.length}
                    </div>
                    {links.map((b) => (
                      <div key={b.artifact_id} className="qd-paperrow">
                        <LoomIcon name="doc" size={13} />
                        {b.title}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </LoomCard>

          {/* 删除卡 — phase-deferred: DELETE 是写操作 (YUK-281). S1 renders the
              danger card + disabled trigger to preserve the design shape; the
              DeleteModal is not wired. */}
          <div className="qd-sec-h" style={{ marginTop: 'var(--s-4)', color: 'var(--again-ink)' }}>
            <LoomIcon name="trash" size={14} />
            删除
          </div>
          <LoomCard pad className="qd-danger">
            <div
              className="meta"
              style={{ marginBottom: 'var(--s-3)', lineHeight: 'var(--lh-prose)' }}
            >
              删除题目是写操作，待 YUK-281 接线后启用（会按关联记录约束做软删除并保留事件）。
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled
              title="删除功能待 YUK-281 接线"
            >
              <LoomIcon name="trash" size={15} />
              删除题目…
            </button>
          </LoomCard>
        </div>
      </div>
    </div>
  );
}

// 配图占位 — `figures` is typed `unknown` at the API boundary (runtime FigureRefT[]
// `{asset_id, caption,...}`; plan §4). Narrow defensively rather than mapping it
// as a hard type. Renders one placeholder per figure caption + any raw image_refs.
function QuestionFigures({
  figures,
  imageRefs,
}: {
  figures: unknown;
  imageRefs: string[];
}): ReactElement | null {
  // Narrow each figure to a stable { key, caption }. Key on the real FigureRefT
  // asset_id when present (figures never reorder, but a content-derived key keeps
  // duplicate captions distinct without an array-index key).
  const figs: Array<{ key: string; caption: string }> = Array.isArray(figures)
    ? figures.map((f, i) => {
        const obj = f && typeof f === 'object' ? (f as Record<string, unknown>) : {};
        const caption = typeof obj.caption === 'string' ? obj.caption : '配图';
        const assetId = typeof obj.asset_id === 'string' ? obj.asset_id : null;
        return { key: assetId ?? `${caption}#${i}`, caption };
      })
    : [];
  if (figs.length === 0 && imageRefs.length === 0) return null;
  return (
    <div
      style={{
        marginTop: 'var(--s-3)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-2)',
      }}
    >
      {figs.map((fig) => (
        <div key={fig.key} className="qd-figure">
          <div className="qd-figure-ico">
            <LoomIcon name="image" size={24} />
          </div>
          <div>
            <div className="qd-figure-cap">{fig.caption}</div>
            <div className="qd-figure-sub">figure · 配图（只读）</div>
          </div>
        </div>
      ))}
      {imageRefs.length > 0 && (
        <div className="qd-figure">
          <div className="qd-figure-ico">
            <LoomIcon name="image" size={24} />
          </div>
          <div>
            <div className="qd-figure-cap">附带 {imageRefs.length} 张原图</div>
            <div className="qd-figure-sub">image_refs · 只读</div>
          </div>
        </div>
      )}
    </div>
  );
}
