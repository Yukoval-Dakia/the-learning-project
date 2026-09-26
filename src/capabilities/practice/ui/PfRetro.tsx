// M2 练习面 — 交卷结果 / 复盘（YUK-316，pfr 共用骨架）。
// 设计基准 docs/design/loom-refresh/project/pface-paper.jsx（PfrBody/Result/Retro）：
// 分数 hero + 判定分布条 + AI 整卷小结 + 逐题展开（你的作答 / AI 反馈 / 不服判）。
// 整卷小结 M2 为本地模板（按错数挑选）；M4 夜链接管后改为 AI 生成随卷持久化。
// 错题去向 trace（归因事件 / 变式排期）等 M4 归因链上线后接真数据。

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AssetEvidencePreview } from '@/ui/components/response/AssetEvidencePreview';
import { AttachmentStrip } from '@/ui/components/response/AttachmentStrip';
import { ChoiceSetResponse } from '@/ui/components/response/ChoiceSetResponse';
import { EvidenceLightbox } from '@/ui/components/response/EvidenceLightbox';
import { SlotResultBadge } from '@/ui/components/response/SlotResultBadge';
import {
  COARSE_OUTCOME_META,
  type CoarseOutcome,
  optionsFromChoicesMd,
} from '@/ui/components/response/response-types';
import { ApiError } from '@/ui/lib/api';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { ErrorState } from '@/ui/primitives/ErrorState';
import { LoomIcon } from '@/ui/primitives/LoomIcon';

import { type PaperSlot, getPaperDetail } from './practice-api';

type Verdict = 'good' | 'hard' | 'again';

function verdictOf(outcome: string): Verdict {
  if (outcome === 'correct') return 'good';
  if (outcome === 'partial') return 'hard';
  return 'again';
}

// YUK-1051 — wire outcome → 组件族 CoarseOutcome（未认识的值归 null → 只渲生命周期徽标，
// 不把未知判定硬塞进对错色）。
function coarseOutcomeOf(outcome: string): CoarseOutcome | null {
  return outcome in COARSE_OUTCOME_META ? (outcome as CoarseOutcome) : null;
}

function summaryByWrong(wrongish: number, total: number): string {
  if (wrongish === 0) return `全对（${total} 题）。今天这张卷没有漏的——明天我会把间隔拉长。`;
  if (wrongish === 1) return '只丢一题，整体是稳的。错的那道我已经记下，变式会排进之后的流。';
  if (wrongish === 2) return '对多错少，框架在、细节松。两道错题都已记录，各自的变式之后流里见。';
  return '这张卷错得有点多——不是坏事，正好把没织牢的线都暴露出来了。错题我都记了账，之后的流会围绕它们重排。';
}

export function PfrQRow({
  n,
  slot,
  appealable,
}: {
  n: number;
  slot: PaperSlot;
  appealable: boolean;
}) {
  const sub = slot.slot_state.submission;
  const visible = sub && 'visible_to_user' in sub && sub.visible_to_user === true ? sub : null;
  const verdict: Verdict | null = visible ? verdictOf(visible.outcome) : null;
  const [open, setOpen] = useState(verdict !== 'good');
  // YUK-1051 — 附件放大查看（复盘是 release 后的读面，可放大原图）。
  const [zoomAsset, setZoomAsset] = useState<string | null>(null);

  // YUK-1051 — 真实选项/原图/状态锚点：选择题渲真实选项列表（选中项按 release 后的判定
  // 着色——§6.4 的颜色=判定只出现在复盘/交卷后）；附件证据随作答一同展示；状态徽标换
  // 组件族六态（effective + 对错 / group_tentative=缓冲未解锁 / 未作答）。
  const choiceOptions = optionsFromChoicesMd(slot.question.choices_md ?? [], slot.question.id);
  const answeredText = sub?.answer_md ?? '';
  const selectedIds = choiceOptions.filter((o) => o.text_md === answeredText).map((o) => o.id);
  const isChoice = choiceOptions.length > 0;
  const releasedOutcome = visible ? coarseOutcomeOf(visible.outcome) : null;
  const answerImages = sub?.answer_image_refs ?? [];

  return (
    <div className="pfr-q">
      <button
        type="button"
        className="pfr-q-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="pfr-q-n">{String(n).padStart(2, '0')}</span>
        <span className="pfr-q-stem">{slot.question.prompt_md}</span>
        {sub ? (
          sub.visible_to_user ? (
            <SlotResultBadge lifecycle="effective" releasedOutcome={releasedOutcome} />
          ) : (
            // 交卷缓冲（visible_to_user=false）= 联合组暂定：已提交待全组解锁，无对错色。
            <SlotResultBadge lifecycle="group_tentative" />
          )
        ) : (
          <span className="badge tone-neutral">未作答</span>
        )}
        <LoomIcon
          name={open ? 'chevronDown' : 'arrow'}
          size={15}
          style={{ color: 'var(--ink-4)', flex: 'none' }}
        />
      </button>
      {open && (
        <div className="pfr-q-body">
          {(slot.question.image_refs ?? []).map((assetId) => (
            <AssetEvidencePreview
              key={assetId}
              assetId={assetId}
              label="题目配图"
              variant="inline"
            />
          ))}
          <div className="pfr-q-row">
            <span className="cmp-label">你的作答</span>
            {isChoice && sub ? (
              <ChoiceSetResponse
                options={choiceOptions}
                mode="single"
                value={answeredText ? selectedIds : null}
                onChange={() => {}}
                disabled
                notation={slot.question.notation}
                feedback="graded"
                selectionOutcome={
                  releasedOutcome === null
                    ? null
                    : releasedOutcome === 'correct'
                      ? 'correct'
                      : 'not_correct'
                }
                ariaLabel={`第 ${n} 题选项`}
              />
            ) : sub?.answer_md ? (
              // de-wenyan: PaperSlot carries no subject profile and this is the
              // student's own typed answer (not a classical-Chinese passage), so
              // it renders in the neutral default font.
              <span>{sub.answer_md}</span>
            ) : (
              <span className="quiet-empty" style={{ padding: 0 }}>
                （未作答）
              </span>
            )}
          </div>
          {answerImages.length > 0 && (
            <div className="pfr-q-row">
              <span className="cmp-label">作答附件</span>
              <AttachmentStrip
                attachments={answerImages.map((id) => ({ asset_id: id, slot_ids: null }))}
                onPreview={setZoomAsset}
              />
            </div>
          )}
          {visible?.feedback_md && (
            <div className="pfr-q-row">
              <span className="cmp-label">AI 反馈</span>
              {/* YUK-1005 — markdown+KaTeX for judge feedback / reference answer;
                  the collapsed header stem stays a raw-text preview strip. */}
              <MathMarkdown notation={slot.question.notation}>{visible.feedback_md}</MathMarkdown>
            </div>
          )}
          {visible?.reference_md && (
            <div className="pfr-q-row">
              <span className="cmp-label">参考</span>
              <MathMarkdown notation={slot.question.notation}>{visible.reference_md}</MathMarkdown>
            </div>
          )}
          {appealable && verdict !== null && verdict !== 'good' && (
            <div className="quiet-empty" style={{ padding: 0, alignSelf: 'flex-start' }}
            >
              此处暂不能直接重判；需要申诉时，请从散题反馈卡提交理由。
            </div>
          )}
        </div>
      )}
      <EvidenceLightbox
        open={zoomAsset !== null}
        onClose={() => setZoomAsset(null)}
        assetId={zoomAsset}
        label="作答附件"
      />
    </div>
  );
}

export function PfRetro({ artifactId, onBack }: { artifactId: string; onBack: () => void }) {
  const detailQ = useQuery({
    queryKey: ['paper', artifactId, 'retro'],
    queryFn: () => getPaperDetail(artifactId),
  });

  if (detailQ.isLoading) return <p className="quiet-empty">取卷中…</p>;
  // 三态分离（YUK-732，与 NoteReaderPage 口径一致）：瞬时加载失败 ≠ 真空态。
  // isLoadingError = 无缓存的首次 fetch 失败——示带重试的错误态；已加载后窗口聚焦/重连
  // 触发的后台 refetch 失败会保留旧 data，不落此分支、不整页替换。
  // 404 语义是「卷不存在/已删」= 空，不是「加载失败」——放行到下面的 EmptyState（同
  // NoteReaderPage 口径），只有瞬时错误（网络/5xx）才示带重试的 ErrorState。
  const isNotFound = detailQ.error instanceof ApiError && detailQ.error.status === 404;
  if (detailQ.isLoadingError && !isNotFound)
    return (
      <div className="pfr">
        <Btn size="sm" variant="ghost" icon="arrowL" onClick={onBack}>
          返回卷架
        </Btn>
        <ErrorState text="复盘加载失败。" onRetry={() => void detailQ.refetch()} />
      </div>
    );
  const detail = detailQ.data;
  // 真空态：detail 成功返回但没有可复盘的记录，或 404（卷不存在）——语义上「空」，非「加载失败」。
  if (!detail)
    return (
      <div className="pfr">
        <EmptyState
          icon="doc"
          title="还没有复盘"
          text="这张卷还没有可复盘的作答记录。"
          action={
            <Btn size="sm" variant="ghost" icon="arrowL" onClick={onBack}>
              返回卷架
            </Btn>
          }
        />
      </div>
    );

  const slots = detail.sections.flatMap((s) => s.slots);
  const verdicts = slots.map((s) => {
    const sub = s.slot_state.submission;
    if (sub && 'visible_to_user' in sub && sub.visible_to_user === true)
      return verdictOf(sub.outcome);
    return null;
  });
  const good = verdicts.filter((v) => v === 'good').length;
  const hard = verdicts.filter((v) => v === 'hard').length;
  const again =
    verdicts.filter((v) => v === 'again').length + verdicts.filter((v) => v === null).length;
  const total = slots.length;

  return (
    <div className="pfr" data-screen-label={`复盘 · ${artifactId}`}>
      <div className="pfs-top">
        <Btn size="sm" variant="ghost" icon="arrowL" onClick={onBack}>
          返回卷架
        </Btn>
        <span className="pfp-title">{detail.title} · 复盘</span>
      </div>

      <div className="pfr-hero">
        <div className="pfr-score">
          <b className="tnum">
            {good}
            <span style={{ fontSize: 28, color: 'var(--ink-4)' }}> / {total}</span>
          </b>
          <span>
            对 ·{' '}
            {detail.session?.status === 'completed' ? '已交卷' : (detail.session?.status ?? '')}
          </span>
        </div>
        <div className="pfr-dist">
          <div className="dist-bar" style={{ height: 10 }}>
            {good > 0 && <span className="dist-seg good" style={{ flex: good }} />}
            {hard > 0 && (
              <span className="dist-seg" style={{ flex: hard, background: 'var(--hard)' }} />
            )}
            {again > 0 && <span className="dist-seg again" style={{ flex: again }} />}
          </div>
          <div className="dist-legend">
            <span className="g-right">{good} 对</span>
            {hard > 0 && (
              <>
                <span className="dot-sep">·</span>
                <span style={{ color: 'var(--hard-ink)' }}>{hard} 部分</span>
              </>
            )}
            <span className="dot-sep">·</span>
            <span className="g-wrong">{again} 错/未答</span>
          </div>
        </div>
      </div>

      <div className="pfr-summary">
        <span className="pf-open-ava">
          <LoomIcon name="sparkle" size={16} />
        </span>
        <div>
          <p className="pfr-summary-text">{summaryByWrong(hard + again, total)}</p>
          <div className="pfr-summary-meta">paper.judge · 交卷统一判分</div>
        </div>
      </div>

      <div className="pfr-list">
        {slots.map((s, i) => (
          <PfrQRow key={`${s.question_id}-${s.part_ref ?? ''}`} n={i + 1} slot={s} appealable />
        ))}
      </div>

      <div className="pfr-foot">
        <Btn variant="secondary" icon="arrowL" onClick={onBack}>
          返回卷架
        </Btn>
      </div>
    </div>
  );
}
