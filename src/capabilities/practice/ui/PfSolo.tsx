// M2 练习面 — 散题作答态（YUK-316）。
// 设计基准 docs/design/loom-refresh/project/pface-solo.jsx：即时反馈（§6.4 着色
// 即判定）· 评级建议可改 · 不服判（异步重判，不阻塞流）· 解题会话（苏格拉底
// 分级提示，不直接给答案）。
//
// YUK-1473 — 提交/判分/申诉的状态机与数据流已抽到 ./use-practice-submit（与新设计语言的
// PracticeNextSolo 共用，行为逐字不变）；本文件只负责旧页面的渲染与解题会话抽屉。

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { REASONING_TRACE_MAX_LEN } from '@/kernel/limits';
import { AttemptTimeline } from '@/ui/components/AttemptTimeline';
import { AssetEvidencePreview } from '@/ui/components/response/AssetEvidencePreview';
import { EvidenceComposer } from '@/ui/components/response/EvidenceComposer';
// YUK-1051 — 作答面换成通用 response 组件族（stable option IDs / 原文保留 / 证据附件）；
// 202-pending 成为返回 union + UI 状态（同一次 submission 继续查询，不重交）。
import { ResponseSlotField, nativeSlotFieldSpec } from '@/ui/components/response/ResponseSlotField';
import { nativeResponseEntry, nativeResponseValue } from '@/ui/components/response/response-types';
import { SaveStateChip } from '@/ui/components/response/SaveStateChip';
import { SlotResultBadge } from '@/ui/components/response/SlotResultBadge';
import { ApiError } from '@/ui/lib/api';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { Btn } from '@/ui/primitives/Btn';
import { Card } from '@/ui/primitives/Card';
import { IconBtn } from '@/ui/primitives/IconBtn';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useFocusTrap } from '@/ui/primitives/useFocusTrap';
import { HintLadder } from './HintLadder';
import { PfSrcBadge } from './PfStream';
import type { PfToast } from './PracticeFacePage';
import { type QuestionDetail, type StreamItem, revealStudyReference } from './practice-api';
import {
  RATING_LABEL,
  VERDICT_OF,
  appealEntryAvailable,
  shouldOfferProcessBox,
  usePracticeSubmit,
} from './use-practice-submit';

export {
  appealEntryAvailable,
  buildCaptureFields,
  derivePhase,
  feedbackFromCommittedAttempt,
  feedbackFromCommittedDiagnosticAttempt,
  isInterventionDiagnosticSource,
  isObjectiveQuestion,
  shouldMarkSlotDoneOnBack,
  shouldOfferConfidenceGate,
  shouldOfferProcessBox,
  toSubmittedJudgeResult,
} from './use-practice-submit';

export function PfSolo({
  item,
  sessionId,
  pos,
  total,
  onDone,
  onBack,
  onCommittedBack,
  addToast,
}: {
  item: StreamItem;
  /** YUK-535 — server-resolved KC-scoped review session; null for the daily stream. */
  sessionId?: string | null;
  pos: number;
  total: number;
  onDone: () => void;
  onBack: () => void;
  // YUK-432 (Bugbot FINDING 1) — 客观题自动 commit 后的「返回流」出口：host 标 slot done + 回列表
  // （不自动推进到下一题）。仅 autoCommitted 时走它；未提供时回落 onBack（向后兼容旧调用方）。
  onCommittedBack?: () => void;
  addToast: (text: string, tone?: PfToast['tone'], icon?: string) => void;
}) {
  const [coach, setCoach] = useState(false);
  const {
    qQ,
    q,
    frozenQ,
    frozen,
    accepted,
    issuanceId,
    setIssuanceMode,
    issuanceMode,
    restoredIssuanceId,
    isInterventionDiagnostic,
    timelineEvents,
    nativeResponses,
    updateNativeResponse,
    evidence,
    setEvidence,
    setUploading,
    autosave,
    isChoice,
    canSubmit,
    phase,
    judging,
    committing,
    returning,
    pendingRun,
    pendingPoll,
    displayedPreview,
    committedPreview,
    rating,
    setRating,
    autoCommitted,
    autoCommitJudgeEventId,
    appealOpen,
    setAppealOpen,
    appealText,
    setAppealText,
    showTrace,
    setShowTrace,
    reasoningTrace,
    setReasoningTrace,
    selfConfidence,
    revealVerdict,
    runJudge,
    commit,
    submitAutoCommitAppeal,
    handleBack,
    startSelfRate,
  } = usePracticeSubmit({ item, sessionId, onDone, onBack, onCommittedBack, addToast });

  // 键盘：⌘/Ctrl+Enter 提交。选项数字键（1–9，随选项数）已移进 ChoiceSetResponse 的
  // hotkeys（YUK-1051 组件族一般化，不再硬编码 1–4）；这里不再重复监听。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase !== 'answering' || coach) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void runJudge();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (qQ.isLoading || frozenQ.isLoading) return <p className="quiet-empty">取题中…</p>;
  if (qQ.isError || !q)
    return (
      <div className="pfs">
        <Btn size="sm" variant="ghost" icon="arrowL" onClick={onBack}>
          返回流
        </Btn>
        <p className="quiet-empty">题面加载失败：{(qQ.error as Error | null)?.message ?? '未知'}</p>
      </div>
    );

  if (frozenQ.isError || !frozen)
    return (
      <div className="pfs">
        <Btn size="sm" variant="ghost" onClick={onBack}>
          返回流
        </Btn>
        <p className="quiet-empty">{(frozenQ.error as Error | null)?.message ?? '正在恢复作答'}</p>
        {frozenQ.error instanceof ApiError && frozenQ.error.code === 'not_admitted' && (
          <Btn variant="secondary" onClick={() => setIssuanceMode('manual')}>
            按自行评级练习
          </Btn>
        )}
      </div>
    );

  if (restoredIssuanceId !== issuanceId) return <p className="quiet-empty">正在恢复作答</p>;

  const verdict = displayedPreview ? VERDICT_OF[displayedPreview.coarse_outcome] : null;

  return (
    <div className="pfs" data-screen-label={`散题作答 · ${q.id}`}>
      <div className="pfs-top">
        {/* YUK-432 (FINDING 1) — 自动 commit 后「返回流」走 handleBack（标 slot done），否则 onBack。 */}
        <Btn
          size="sm"
          variant="ghost"
          icon="arrowL"
          disabled={returning}
          onClick={() => void handleBack()}
        >
          返回流
        </Btn>
        <span className="pfs-pos">
          流 · 第 {pos} / {total} 项
        </span>
        <PfSrcBadge source={item.source} />
        <span className="topbar-spacer" />
        {!isInterventionDiagnostic && (
          <Btn size="sm" variant="secondary" icon="teach" onClick={() => setCoach(true)}>
            需要提示？
          </Btn>
        )}
      </div>

      <Card pad="lg">
        <div className="nowrap-meta" style={{ marginBottom: 'var(--s-2)' }}>
          {q.labels.map((l) => (
            <span key={l.id} className="chip chip-k">
              {l.name}
            </span>
          ))}
        </div>

        {/* YUK-1005 — stem/options render through the shared markdown+KaTeX
            pipeline (same convention as QuestionsPage/DraftReviewPage); notation
            comes from the server-resolved subject projection, never assumed. */}
        {frozen.materials.map((material) => (
          <div key={material.material_id}>
            {material.content_md !== undefined ? (
              <MathMarkdown notation={q.notation}>{material.content_md}</MathMarkdown>
            ) : (
              <AssetEvidencePreview
                assetId={material.asset_id}
                label={material.caption ?? material.alt_text}
              />
            )}
          </div>
        ))}
        {frozen.faces.map((face) => (
          <MathMarkdown key={face.part_id} notation={q.notation} className="pfs-stem">
            {face.prompt_md}
          </MathMarkdown>
        ))}
        <SaveStateChip state={autosave.state} onRetry={autosave.retry} />

        {/* YUK-1051 — 作答面 = 通用 response 组件族。选择题：stable option IDs +
            radiogroup 语义不变；对错色仍只在 feedback 相位（§6.4 即时着色即判定），
            作答中（含 confidence 插拍）只有中性选中态。 */}
        {pendingRun ? (
          // 202-pending（durable lane）：作答已持久化，判分在后台。同一 run 轮询中；
          // 可先行推进（solo 202 可继续），结果回来由 pendingPoll effect 揭晓反馈卡。
          <div className="rs-pending" aria-live="polite">
            <SlotResultBadge lifecycle="submitted_pending" />
            {pendingPoll.status === 'failed' || pendingPoll.error ? (
              <p className="rs-pending-text">
                判分暂时没跑成——你的作答已经存住，系统会自动补判，不需要重交。
              </p>
            ) : (
              <p className="rs-pending-text">
                判分在后台进行——同一份作答在排队，不需要重交；可以先继续，结果稍后到。
              </p>
            )}
            <div className="pfs-actions">
              <Btn variant="secondary" icon="arrow" onClick={() => onDone()}>
                先继续
              </Btn>
            </div>
          </div>
        ) : (
          <>
            {frozen.response_spec.slots.map((slot) => {
              const spec = nativeSlotFieldSpec(slot);
              if (!spec) return null;
              const entry = nativeResponses.entries.find((item) => item.slot_id === slot.slot_id);
              return (
                <ResponseSlotField
                  key={slot.slot_id}
                  spec={spec}
                  value={nativeResponseValue(entry)}
                  label={slot.placement?.label}
                  notation={q.notation}
                  disabled={returning || phase !== 'answering' || !!accepted}
                  onChange={(value) =>
                    updateNativeResponse(nativeResponseEntry(slot, value, entry))
                  }
                  feedback={phase === 'feedback' ? 'graded' : 'none'}
                  hotkeys={
                    frozen.response_spec.slots.length === 1 &&
                    isChoice &&
                    phase === 'answering' &&
                    !coach
                  }
                  ariaLabel={slot.placement?.label ?? '作答'}
                />
              );
            })}
            <EvidenceComposer
              text=""
              onTextChange={() => {}}
              showText={false}
              attachments={evidence}
              onAttachmentsChange={setEvidence}
              disabled={returning || phase !== 'answering' || !!accepted}
              onUploadingChange={setUploading}
            />
          </>
        )}

        {/* YUK-562 — 过程框「记下你的思路」：作答面与提交 CTA 之间，仅开放/文本作答题（!isChoice）显示，
            客观（选择）题隐藏。默认折叠（一行触发展开 textarea）。零强制：不挡提交、折叠即跳过、
            空值不发字段（buildCaptureFields 在 commit 时 trim 判空）。vision §8 红线 3：可完全忽略、不打断流。 */}
        {phase === 'answering' && shouldOfferProcessBox(isChoice) && (
          <div className="pfs-trace">
            {showTrace ? (
              <div className="composer pfs-trace-composer">
                <textarea
                  rows={2}
                  value={reasoningTrace}
                  // YUK-562 — 硬闸在 REASONING_TRACE_MAX_LEN（与 server zod .max() 同源），挡住
                  // 越界输入撞 400 软死锁；buildCaptureFields 发送前再防御性截断兜底粘贴/IME 绕过。
                  maxLength={REASONING_TRACE_MAX_LEN}
                  placeholder="随手记下你是怎么想的——不评分，也可以留空。"
                  onChange={(e) => setReasoningTrace(e.target.value)}
                  aria-label="解题思路（可选）"
                />
              </div>
            ) : (
              <button type="button" className="pfs-trace-toggle" onClick={() => setShowTrace(true)}>
                ＋ 记下你的思路（可选）
              </button>
            )}
          </div>
        )}

        {phase === 'answering' && !pendingRun && (
          <div className="pfs-actions">
            {issuanceMode === 'manual' ? (
              (['again', 'hard', 'good'] as const).map((grade) => (
                <Btn
                  key={grade}
                  variant="secondary"
                  disabled={!canSubmit || committing}
                  onClick={() => void commit({ withAppeal: false, rating: grade })}
                >
                  {RATING_LABEL[grade]} · 自行评级
                </Btn>
              ))
            ) : (
              <Btn
                variant="primary"
                icon="check"
                onClick={() => void runJudge()}
                disabled={!canSubmit}
              >
                {judging ? '判分中…' : '提交 · 即时判分'}
              </Btn>
            )}
            <span className="key-hints mono" style={{ marginLeft: 'auto' }}>
              {isChoice ? '数字键直选 · ⌘Enter 提交' : '⌘Enter 提交'}
            </span>
          </div>
        )}

        {/* YUK-444 — 信心自评 in-page interstitial：提交后、判定揭晓前插一拍。1-5 自评 + 「跳过」，
            推迟揭晓——选一档或跳过（revealVerdict）后才 setPreview 渲判定卡（先自评再看结果的元认知语义）。
            observe-only：值只随 commit 落 review event payload.self_confidence，绝不进判分 / FSRS / θ̂。
            零强制：「跳过」= confidence:null → 不发字段。客观题 auto-commit 流不经此（不插拍）。
            aria-live=polite 沿用判定卡的读屏习惯，让插拍出现时被朗读。 */}
        {phase === 'confidence' && (
          <div className="pfs-conf" aria-live="polite">
            <span className="pfs-conf-q">看答案之前——你有几分把握？</span>
            {/* biome-ignore lint/a11y/useSemanticElements: 原生 <fieldset> 自带
                border/margin/legend 布局，与这排 pill 按钮的 flex 形制不兼容；role=group
                + aria-label 是无表单语义的按钮分组的完整 ARIA 模式（同 .pfs-opts radiogroup）。 */}
            <div className="pfs-conf-scale" role="group" aria-label="信心自评，1 到 5">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  type="button"
                  key={n}
                  className={`pfs-conf-btn${selfConfidence === n ? ' on' : ''}`}
                  aria-label={`把握 ${n} 分（共 5 分）`}
                  onClick={() => revealVerdict(n)}
                >
                  {n}
                </button>
              ))}
              <button type="button" className="pfs-conf-skip" onClick={() => revealVerdict(null)}>
                跳过
              </button>
            </div>
            <span className="pfs-conf-hint">1 = 全靠猜 · 5 = 十拿九稳 · 不评分</span>
          </div>
        )}

        {phase === 'feedback' && displayedPreview && verdict && (
          // YUK-718 — 判定卡是即时判分结果，须播报给读屏（对/错 + AI 反馈）。
          // aria-live=polite 沿用仓库 live-region 习惯（.li-intent-preview /
          // .pf-toasts）——不加 role=status，因 biome useSemanticElements 会要求换
          // <output>；polite live region 已足够让读屏在判定卡出现时朗读内容。
          <div className={`pfs-fb v-${verdict.tone}`} aria-live="polite">
            <div className="pfs-fb-head">
              <span className={`badge tone-${verdict.tone}`}>
                <LoomIcon
                  name={
                    verdict.tone === 'good' ? 'check' : verdict.tone === 'again' ? 'close' : 'minus'
                  }
                  size={12}
                />
                {verdict.label}
                {displayedPreview.coarse_outcome === 'partial_unknown' &&
                  `${
                    displayedPreview.partial_units?.length
                      ? `（${displayedPreview.partial_units
                          .map((unit) => `${unit.correct_count}/${unit.total_count}`)
                          .join('、')}）`
                      : ''
                  }，分数未知`}
              </span>
              <span className="ai-tag">
                <LoomIcon name="sparkle" size={12} />
                AI 判定
              </span>
            </div>
            {/* When the system could not grade, feedback_md is a diagnostic for operators, not
                feedback; say so in plain words with a next step instead (YUK-1438). */}
            {displayedPreview.coarse_outcome === 'unsupported' ? (
              <p className="pfs-fb-text">
                {autoCommitted || committedPreview
                  ? '这题暂时没法自动判，这次作答已经存下了。可以继续下一题，或者返回流跳过它。'
                  : '这题暂时没法自动判。可以先自己评一下，或者返回流跳过这题。'}
              </p>
            ) : (
              <MathMarkdown notation={q.notation} className="pfs-fb-text">
                {displayedPreview.feedback_md ?? ''}
              </MathMarkdown>
            )}
            {q.reference_md && (
              <div className="pfs-fb-ref">
                <span className="cmp-label">参考</span>
                <MathMarkdown notation={q.notation}>{q.reference_md}</MathMarkdown>
              </div>
            )}

            {/* YUK-617 W1 — 本题最近 attempt·review 历史（判定卡内、错因旁）。有历史才出，
                首次作答无历史不渲染，避免 clutter。重复错因会自动标红（组件内 ×前缀 + again 色）。 */}
            {timelineEvents.length > 0 && <AttemptTimeline events={timelineEvents} />}

            {/* YUK-432 — 客观题自动判分+自动评级：preview 回来已自动 commit（auto_rate:true），故
                隐藏手动 again/hard/good 评级行；用户仍看到上面的判定反馈卡，按「下一项」推进。
                注意：仅隐藏**手动评级行**——「不服判」入口仍保留（FINDING 2，见下方 footer）。
                开放题：保留现有手动评级行（默认=建议，可改）。 */}
            {!autoCommitted && displayedPreview.coarse_outcome !== 'partial_unknown' && (
              <div className="pfs-rate">
                <span className="pfs-rate-label">评级</span>
                {(['again', 'hard', 'good'] as const).map((g) => (
                  <button
                    type="button"
                    key={g}
                    className={`pfs-rate-btn t-${g}${rating === g ? ' on' : ''}`}
                    onClick={() => setRating(g)}
                  >
                    {RATING_LABEL[g]}
                  </button>
                ))}
                <span className="pfs-rate-advised">
                  建议：
                  {displayedPreview.suggested_rating
                    ? RATING_LABEL[displayedPreview.suggested_rating]
                    : '暂无评级建议'}
                </span>
              </div>
            )}

            <div className="pfs-fb-foot">
              {/* Self-rating only works before a result is recorded; after that this button would
                  do nothing (YUK-1438 review). */}
              {displayedPreview.coarse_outcome === 'unsupported' &&
                !autoCommitted &&
                !committedPreview && (
                  <Btn variant="secondary" onClick={startSelfRate}>
                    自己评一下
                  </Btn>
                )}
              {autoCommitted ? (
                // 客观题：已自动判分+评级，「下一项」只推进（不再二次 commit）。
                <Btn variant="primary" icon="arrow" disabled={committing} onClick={() => onDone()}>
                  {committing ? '判分中…' : '下一项'}
                </Btn>
              ) : displayedPreview.coarse_outcome === 'partial_unknown' ? (
                <Btn
                  variant="primary"
                  icon="arrow"
                  disabled={committing}
                  // Required wire fallback only; auto_rate leaves the actual rating to the server.
                  onClick={() => void commit({ withAppeal: false, rating: 'hard', autoRate: true })}
                >
                  {committing ? '提交中…' : '保存作答 · 下一项'}
                </Btn>
              ) : (
                // 开放题：手动确认评级后 commit（auto_rate 缺省 false → server 用 body.rating）。
                <Btn
                  variant="primary"
                  icon="arrow"
                  disabled={committing || !rating}
                  onClick={() => rating && void commit({ withAppeal: false, rating })}
                >
                  {committing ? '提交中…' : '确认评级 · 下一项'}
                </Btn>
              )}
              {/* YUK-432 (FINDING 2) — 「不服判」入口在客观题自动 commit 后**仍可用**（旧实现错误地
                  用 autoCommitted 隐藏它）：deterministic 判定（exact/keyword）也落了 judge 锚点，可
                  对它发 appeal（如 exact-match 误拒等价答案）。可用性由 appealEntryAvailable 统一判：
                  自动流要求拿到锚点 id，手动流恒可见。 */}
              {appealEntryAvailable({
                phase,
                appealOpen,
                autoCommitted,
                autoCommitJudgeEventId,
              }) && (
                <button
                  type="button"
                  className="pfs-appeal-link"
                  onClick={() => setAppealOpen(true)}
                >
                  不服判？附理由重判
                </button>
              )}
            </div>

            {appealOpen && (
              <div className="pfs-appeal">
                <div className="composer">
                  <textarea
                    rows={2}
                    value={appealText}
                    placeholder="说说为什么——比如「我的表述和参考是等价的」"
                    onChange={(e) => setAppealText(e.target.value)}
                    aria-label="不服判理由"
                  />
                </div>
                <div className="pfs-actions" style={{ marginTop: 'var(--s-3)' }}>
                  {/* 自动 commit 流：review 已落库 → 直接对暂存锚点发 appeal（不再二次 submit）。
                      手动流：commit({ withAppeal:true }) 一次性 submit + appeal（既有行为不变）。 */}
                  {autoCommitted ? (
                    <Btn
                      size="sm"
                      variant="secondary"
                      icon="send"
                      disabled={!appealText.trim() || committing || !autoCommitJudgeEventId}
                      onClick={() => void submitAutoCommitAppeal()}
                    >
                      提交重判 · 先继续
                    </Btn>
                  ) : (
                    <Btn
                      size="sm"
                      variant="secondary"
                      icon="send"
                      disabled={
                        !appealText.trim() ||
                        committing ||
                        (!rating && displayedPreview.coarse_outcome !== 'partial_unknown')
                      }
                      onClick={() => {
                        if (displayedPreview.coarse_outcome === 'partial_unknown') {
                          void commit({ withAppeal: true, rating: 'hard', autoRate: true });
                        } else if (rating) {
                          void commit({ withAppeal: true, rating });
                        }
                      }}
                    >
                      提交重判 · 先继续
                    </Btn>
                  )}
                  <Btn size="sm" variant="ghost" onClick={() => setAppealOpen(false)}>
                    算了
                  </Btn>
                  <span className="key-hints mono" style={{ marginLeft: 'auto' }}>
                    重判在后台进行，不耽误继续做题
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      <PfCoach
        open={coach}
        onClose={() => setCoach(false)}
        question={q}
        issuanceId={frozen ? issuanceId : undefined}
      />
    </div>
  );
}

/* ── 解题会话 — 6 阶 hint 强度梯（YUK-354 A2，solve 链 API） ──
   抽屉壳（触发/scrim/focus-trap/「会话不计入判分」note/关闭）保留；body 由旧的「无级线性、点一次
   给一条」提示流换成可感知的 6 阶 H0-H5 强度梯（HintLadder）。强度梯本身的状态机 + 形态在 HintLadder。 */
function PfCoach({
  open,
  onClose,
  question,
  issuanceId,
}: {
  open: boolean;
  onClose: () => void;
  question: QuestionDetail;
  issuanceId?: string;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  useFocusTrap(open, onClose, panelRef);

  return createPortal(
    <>
      {open && (
        <div
          className="scrim open"
          style={{ zIndex: 35 }}
          onClick={onClose}
          onKeyDown={() => {}}
          role="presentation"
        />
      )}
      <aside
        className={`pfs-coach${open ? ' open' : ''}`}
        ref={panelRef as never}
        // biome-ignore lint/a11y/useSemanticElements: native <dialog> 需要
        // imperative showModal()/close() API，与 CSS-class 驱动的 .open 抽屉
        // + scrim/focus-trap 模式不兼容（同 CopilotDrawer）。
        role="dialog"
        aria-label="解题会话"
        aria-hidden={!open}
      >
        <div className="pfs-coach-head">
          <span className="ai-tag">
            <LoomIcon name="teach" size={13} />
            解题会话
          </span>
          <span className="meta mono">H0–H5 · 逐阶加力</span>
          <span className="topbar-spacer" />
          <IconBtn icon="close" size={16} title="关闭" onClick={onClose} />
        </div>
        <div className="pfs-coach-body">
          <p className="pfs-coach-note">
            一级一级加力，每阶更近一步；想直接看完整解也行（记为非独立完成）。会话不计入判分。
          </p>
          <HintLadder
            open={open}
            question={question}
            onReturnToAnswer={onClose}
            issuanceId={issuanceId}
            requestFullSolution={
              issuanceId
                ? async () => (await revealStudyReference(issuanceId)).reference_md
                : undefined
            }
          />
        </div>
      </aside>
    </>,
    document.body,
  );
}
