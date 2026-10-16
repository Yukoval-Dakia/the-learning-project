// M2 练习面 — 散题作答态（YUK-316）。
// 设计基准 docs/design/loom-refresh/project/pface-solo.jsx：即时反馈（§6.4 着色
// 即判定）· 评级建议可改 · 不服判（异步重判，不阻塞流）· 解题会话（苏格拉底
// 分级提示，不直接给答案）。
//
// 数据流（两段式）：作答 → POST /api/review/advice（判分预览，不写事件）→
// 反馈卡 + 评级三档（默认=建议）→「确认评级 · 下一项」→ POST /api/attempts
// （judge_result_v2 复用预览判分，不重跑 judge；事件 + FSRS + 判定锚点落库）。
// intervention_diagnostic 是刻意的一段式例外：首份答案直接 POST /api/attempts +
// auto_rate，由服务端真实 judge 原子认领并结算；绝不先打可重复的 advice 预览。
// 不服判：提交重判 = 先 submit（当前评级生效）拿锚点 judge_event_id → appeal
// → 流继续（设计稿「重判中 · 不阻塞，先继续」；改判回执经 M4 工作台/通知回流）。
//
// YUK-1473 — this file is the view only. The engine (issuance, draft + autosave,
// conflict, 返回流, judge/submit/appeal, pending poll) lives in usePracticeSubmit.

import { useState } from 'react';
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
  type DraftConflict,
  type Rating,
  VERDICT_OF,
  appealEntryAvailable,
  shouldOfferProcessBox,
  usePracticeSubmit,
} from './use-practice-submit';

const RATING_LABEL: Record<Rating, string> = { again: '再练', hard: '模糊', good: '掌握' };

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
  // How many times the coach has been opened; keys the hint ladder so each opening
  // starts a fresh ladder (YUK-1483).
  const [coachSession, setCoachSession] = useState(0);
  const openCoach = () => {
    setCoach(true);
    setCoachSession((n) => n + 1);
  };
  // YUK-562 (过程框) — 「记下你的思路」默认折叠（showTrace=false，一行触发展开）。
  const [showTrace, setShowTrace] = useState(false);
  const {
    qQ,
    q,
    isInterventionDiagnostic,
    timelineEvents,
    issued,
    frozen,
    accepted,
    issuanceId,
    issuanceMode,
    attachIssuance,
    retryIssuance,
    startSelfRatedIssuance,
    restored,
    nativeResponses,
    evidence,
    isChoice,
    updateNativeResponse,
    updateEvidence,
    setUploading,
    autosave,
    conflictView,
    keepServerVersion,
    keepMyVersion,
    readServerVersion,
    phase,
    canSubmit,
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
    selfConfidence,
    reasoningTrace,
    setReasoningTrace,
    appealOpen,
    setAppealOpen,
    appealText,
    setAppealText,
    runJudge,
    commit,
    revealVerdict,
    submitAutoCommitAppeal,
    startSelfRate,
    handleBack,
    attachAnsweringRoot,
  } = usePracticeSubmit({
    item,
    sessionId,
    onDone,
    onBack,
    onCommittedBack,
    addToast,
    hotkeysSuspended: coach,
  });

  if (qQ.isLoading) return <p className="quiet-empty">取题中…</p>;
  if (qQ.isError || !q)
    return (
      <div className="pfs">
        <Btn size="sm" variant="ghost" icon="arrowL" onClick={onBack}>
          返回流
        </Btn>
        <p className="quiet-empty">题面加载失败：{(qQ.error as Error | null)?.message ?? '未知'}</p>
      </div>
    );

  // The issuance command runs when this placeholder attaches. It is deliberately not on
  // the error view below, so a failed request never retries itself by re-attaching.
  if (!issued)
    return (
      <p className="quiet-empty" ref={attachIssuance}>
        取题中…
      </p>
    );

  if (issued.error || !frozen)
    return (
      <div className="pfs">
        <Btn size="sm" variant="ghost" onClick={onBack}>
          返回流
        </Btn>
        <p className="quiet-empty">{(issued.error as Error | null)?.message ?? '正在恢复作答'}</p>
        {issued.error instanceof ApiError && issued.error.code === 'not_admitted' ? (
          <Btn variant="secondary" onClick={startSelfRatedIssuance}>
            按自行评级练习
          </Btn>
        ) : (
          // Brings back the issuance placeholder, whose attach re-runs the command
          // (read first, POST only on 404; the failed request was already dropped).
          <Btn variant="secondary" onClick={retryIssuance}>
            重试
          </Btn>
        )}
      </div>
    );

  if (!restored) return <p className="quiet-empty">正在恢复作答</p>;

  const verdict = displayedPreview ? VERDICT_OF[displayedPreview.coarse_outcome] : null;

  return (
    <div className="pfs" data-screen-label={`散题作答 · ${q.id}`} ref={attachAnsweringRoot}>
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
          <Btn size="sm" variant="secondary" icon="teach" onClick={openCoach}>
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
        {conflictView ? (
          <DraftConflictPanel
            conflict={conflictView.conflict}
            mine={conflictView.mine}
            server={conflictView.server}
            onKeepServer={keepServerVersion}
            onKeepMine={keepMyVersion}
            onReload={readServerVersion}
          />
        ) : (
          <SaveStateChip state={autosave.state} onRetry={autosave.retry} />
        )}

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
                  disabled={returning || phase !== 'answering' || !!accepted || !!conflictView}
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
              onAttachmentsChange={updateEvidence}
              disabled={returning || phase !== 'answering' || !!accepted || !!conflictView}
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
        session={coachSession}
        onClose={() => setCoach(false)}
        question={q}
        issuanceId={frozen ? issuanceId : undefined}
      />
    </div>
  );
}

// YUK-1489 — the draft conflict panel inside the answer card. Same tone as the question
// detail's 「别处有更新的版本」 notice (.qd-stale): a soft hard-tone strip, plain words,
// two choices; here the two versions are shown side by side so the choice is informed.
function savedClock(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function DraftVersion({
  label,
  text,
  files,
}: {
  label: string;
  text: string;
  files: readonly string[];
}) {
  return (
    <div className="pfs-conflict-side">
      <span className="cmp-label">{label}</span>
      <p className={`pfs-conflict-text${text ? '' : ' is-empty'}`}>{text || '还没写'}</p>
      {files.length > 0 && <span className="pfs-conflict-files">另有 {files.length} 个附件</span>}
    </div>
  );
}

function DraftConflictPanel({
  conflict,
  mine,
  server,
  onKeepServer,
  onKeepMine,
  onReload,
}: {
  conflict: DraftConflict;
  mine: { text: string; files: readonly string[] };
  server: { text: string; files: readonly string[]; savedAt: string | null } | null;
  onKeepServer: () => void;
  onKeepMine: () => void;
  onReload: () => void;
}) {
  const submitted = conflict.status === 'ready' && conflict.submitted;
  const clock = savedClock(server?.savedAt ?? null);
  return (
    <div className="pfs-conflict" aria-live="polite">
      <div className="pfs-conflict-head">
        <LoomIcon name="alert" size={15} className="pfs-conflict-ico" />
        <p className="pfs-conflict-msg">
          {submitted
            ? '这道题已经在别处交过了，你这次写的还没有保存。'
            : '这道题在别处（比如另一个标签页）存了另一份作答，你这次写的还没有保存。选一份留下，再接着写。'}
        </p>
      </div>
      {conflict.status === 'loading' && (
        <p className="pfs-conflict-note">正在读取服务器上的那一份…</p>
      )}
      {conflict.status === 'failed' && (
        <div className="pfs-conflict-act">
          <p className="pfs-conflict-note">没能读到服务器上的那一份。</p>
          <Btn size="sm" variant="secondary" onClick={onReload}>
            再读一次
          </Btn>
        </div>
      )}
      {conflict.status === 'ready' && server && (
        <>
          <div className="pfs-conflict-cmp">
            <DraftVersion label="你这次写的" text={mine.text} files={mine.files} />
            <DraftVersion
              label={
                submitted
                  ? `交过的${clock ? `（${clock}）` : ''}`
                  : `服务器上的${clock ? `（${clock} 保存）` : ''}`
              }
              text={server.text}
              files={server.files}
            />
          </div>
          <p className="pfs-conflict-note">
            {submitted
              ? '交过的作答不能再改，只能载入它；你这次写的会丢掉。'
              : '用服务器上的：你这次写的会丢掉。保留我的：服务器上那一份会被替换。'}
          </p>
          <div className="pfs-conflict-act">
            <Btn size="sm" variant="secondary" onClick={onKeepServer}>
              {submitted ? '载入交过的作答' : '用服务器上的'}
            </Btn>
            {!submitted && (
              <Btn size="sm" variant="primary" onClick={onKeepMine}>
                保留我的
              </Btn>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ── 解题会话 — 6 阶 hint 强度梯（YUK-354 A2，solve 链 API） ──
   抽屉壳（触发/scrim/focus-trap/「会话不计入判分」note/关闭）保留；body 由旧的「无级线性、点一次
   给一条」提示流换成可感知的 6 阶 H0-H5 强度梯（HintLadder）。强度梯本身的状态机 + 形态在 HintLadder。 */
function PfCoach({
  open,
  session,
  onClose,
  question,
  issuanceId,
}: {
  open: boolean;
  /** Opening count; each opening gets a fresh hint ladder (closed content stays for the slide-out). */
  session: number;
  onClose: () => void;
  question: QuestionDetail;
  issuanceId?: string;
}) {
  const trapRef = useFocusTrap(open, onClose);

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
        ref={trapRef}
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
            key={session}
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
