// M2 练习面 — 交卷结果 / 复盘（YUK-316）。
// 设计基准 docs/design/loom-refresh/project/pface-paper.jsx（PfrBody/Result/Retro）：
// 分数 hero + 判定分布条 + 系统小结 + 逐题展开（你的作答 / AI 反馈 / 不服判）。
// 系统小结只陈述这张卷的判分计数：它不是模型写的，也不承诺之后的排程（YUK-1768）。
// 错题去向 trace（归因事件 / 变式排期）等 M4 归因链上线后接真数据。
// M3E 呈现：docs/design/2026-11-03-practice-face-m3e.md（样式 practice-face-m3e.css）。

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { AssetEvidencePreview } from '@/ui/components/response/AssetEvidencePreview';
import { AttachmentStrip } from '@/ui/components/response/AttachmentStrip';
import { ChoiceSetResponse } from '@/ui/components/response/ChoiceSetResponse';
import { EvidenceLightbox } from '@/ui/components/response/EvidenceLightbox';
import {
  COARSE_OUTCOME_META,
  type CoarseOutcome,
  optionsFromChoicesMd,
} from '@/ui/components/response/response-types';
import { SlotResultBadge } from '@/ui/components/response/SlotResultBadge';
import { ApiError } from '@/ui/lib/api';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { Button, Chip } from '@/ui-next/public';

import type { PaperSlot } from './practice-api';
import { usePracticeClient } from './practice-client';

type Verdict = 'good' | 'hard' | 'again';

function verdictOf(outcome: string): Verdict {
  if (outcome === 'correct') return 'good';
  if (outcome === 'partial' || outcome === 'partial_unknown') return 'hard';
  return 'again';
}

// YUK-1051 — wire outcome → 组件族 CoarseOutcome（未认识的值归 null → 只渲生命周期徽标，
// 不把未知判定硬塞进对错色）。
function coarseOutcomeOf(outcome: string): CoarseOutcome | null {
  return outcome in COARSE_OUTCOME_META ? (outcome as CoarseOutcome) : null;
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
    <div className="pf-rq">
      <button
        type="button"
        className="pf-rq-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="pf-rq-n">{String(n).padStart(2, '0')}</span>
        <span className="pf-rq-stem">{slot.question.prompt_md}</span>
        {sub ? (
          sub.visible_to_user ? (
            <SlotResultBadge
              lifecycle="effective"
              releasedOutcome={releasedOutcome}
              partialUnits={visible?.partial_units}
            />
          ) : (
            // 交卷缓冲（visible_to_user=false）= 联合组暂定：已提交待全组解锁，无对错色。
            <SlotResultBadge lifecycle="group_tentative" />
          )
        ) : (
          <Chip>未作答</Chip>
        )}
        <ChevronDown size={18} aria-hidden="true" className="pf-rq-chev" />
      </button>
      {open && (
        <div className="pf-rq-body">
          {(slot.question.image_refs ?? []).map((assetId) => (
            <AssetEvidencePreview
              key={assetId}
              assetId={assetId}
              label="题目配图"
              variant="inline"
            />
          ))}
          <div className="pf-rq-row">
            <span className="pf-rq-label">你的作答</span>
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
              <span className="pf-rq-none">（未作答）</span>
            )}
          </div>
          {answerImages.length > 0 && (
            <div className="pf-rq-row">
              <span className="pf-rq-label">作答附件</span>
              <AttachmentStrip
                attachments={answerImages.map((id) => ({ asset_id: id, slot_ids: null }))}
                onPreview={setZoomAsset}
              />
            </div>
          )}
          {visible?.feedback_md && (
            <div className="pf-rq-row">
              <span className="pf-rq-label">AI 反馈</span>
              {/* YUK-1005 — markdown+KaTeX for judge feedback / reference answer;
                  the collapsed header stem stays a raw-text preview strip. */}
              <MathMarkdown notation={slot.question.notation}>{visible.feedback_md}</MathMarkdown>
            </div>
          )}
          {visible?.reference_md && (
            <div className="pf-rq-row">
              <span className="pf-rq-label">参考</span>
              <MathMarkdown notation={slot.question.notation}>{visible.reference_md}</MathMarkdown>
            </div>
          )}
          {appealable && verdict !== null && verdict !== 'good' && (
            <p className="pf-rq-note">此处暂不能直接重判；需要申诉时，请从散题反馈卡提交理由。</p>
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
  const { getPaperDetail } = usePracticeClient();
  const detailQ = useQuery({
    queryKey: ['paper', artifactId, 'retro'],
    queryFn: () => getPaperDetail(artifactId),
  });

  if (detailQ.isLoading)
    return (
      <p className="pf-m3-state un-m3e-bridge" role="status">
        取卷中…
      </p>
    );
  // 三态分离（YUK-732，与 NoteReaderPage 口径一致）：瞬时加载失败 ≠ 真空态。
  // isLoadingError = 无缓存的首次 fetch 失败——示带重试的错误态；已加载后窗口聚焦/重连
  // 触发的后台 refetch 失败会保留旧 data，不落此分支、不整页替换。
  // 404 语义是「卷不存在/已删」= 空，不是「加载失败」——放行到下面的空态（同
  // NoteReaderPage 口径），只有瞬时错误（网络/5xx）才示带重试的出错行。
  const isNotFound = detailQ.error instanceof ApiError && detailQ.error.status === 404;
  if (detailQ.isLoadingError && !isNotFound)
    return (
      <div className="pf-retro un-m3e-bridge">
        <div className="pf-retro-top">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft size={18} aria-hidden="true" />
            返回卷架
          </Button>
        </div>
        <div className="pf-m3-error">
          <RetryLine message="复盘加载失败。" onRetry={() => void detailQ.refetch()} />
        </div>
      </div>
    );
  const detail = detailQ.data;
  // 真空态：detail 成功返回但没有可复盘的记录，或 404（卷不存在）——语义上「空」，非「加载失败」。
  if (!detail)
    return (
      <div className="pf-retro un-m3e-bridge">
        <div className="pf-m3-state">
          <h2>还没有复盘</h2>
          <p>这张卷还没有可复盘的作答记录。</p>
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft size={18} aria-hidden="true" />
            返回卷架
          </Button>
        </div>
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
  const unknownScores = slots.filter(
    (slot) =>
      slot.slot_state.submission?.visible_to_user &&
      slot.slot_state.submission.outcome === 'partial_unknown',
  ).length;

  return (
    <div className="pf-retro un-m3e-bridge" data-screen-label={`复盘 · ${artifactId}`}>
      <div className="pf-retro-top">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft size={18} aria-hidden="true" />
          返回卷架
        </Button>
        <h1 className="pf-retro-title">{detail.title} · 复盘</h1>
      </div>

      <div className="pf-retro-hero">
        <p className="pf-retro-score">
          <b>
            {good}
            <span> / {total}</span>
          </b>
          <span>
            对 ·{' '}
            {detail.session?.status === 'completed' ? '已交卷' : (detail.session?.status ?? '')}
          </span>
        </p>
        <div className="pf-retro-dist">
          <div className="pf-dist-bar pf-dist-bar-lg" aria-hidden="true">
            {good > 0 && <span data-seg="good" style={{ flex: good }} />}
            {hard > 0 && <span data-seg="hard" style={{ flex: hard }} />}
            {again > 0 && <span data-seg="again" style={{ flex: again }} />}
          </div>
          <p className="pf-dist-legend">
            <span data-seg="good">{good} 对</span>
            {hard > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span data-seg="hard">{hard} 部分</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span data-seg="again">{again} 错/未答</span>
          </p>
        </div>
      </div>

      <div className="pf-retro-summary">
        <p className="pf-retro-summary-text">
          {good} 题完整正确，{hard} 题部分正确，{again} 题错或未答。
          {unknownScores > 0 ? `其中 ${unknownScores} 题分数未知。` : ''}
        </p>
        <p className="pf-retro-summary-meta">系统小结 · 按这张卷的判分统计</p>
      </div>

      <div className="pf-retro-list">
        {slots.map((s, i) => (
          <PfrQRow key={`${s.question_id}-${s.part_ref ?? ''}`} n={i + 1} slot={s} appealable />
        ))}
      </div>

      <div className="pf-retro-foot">
        <Button variant="secondary" onClick={onBack}>
          <ArrowLeft size={18} aria-hidden="true" />
          返回卷架
        </Button>
      </div>
    </div>
  );
}
