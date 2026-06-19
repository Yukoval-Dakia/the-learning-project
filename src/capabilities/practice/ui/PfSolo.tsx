// M2 练习面 — 散题作答态（YUK-316）。
// 设计基准 docs/design/loom-refresh/project/pface-solo.jsx：即时反馈（§6.4 着色
// 即判定）· 评级建议可改 · 不服判（异步重判，不阻塞流）· 解题会话（苏格拉底
// 分级提示，不直接给答案）。
//
// 数据流（两段式）：作答 → POST /api/review/advice（判分预览，不写事件）→
// 反馈卡 + 评级三档（默认=建议）→「确认评级 · 下一项」→ POST /api/review/submit
// （judge_result_v2 复用预览判分，不重跑 judge；事件 + FSRS + 判定锚点落库）。
// 不服判：提交重判 = 先 submit（当前评级生效）拿锚点 judge_event_id → appeal
// → 流继续（设计稿「重判中 · 不阻塞，先继续」；改判回执经 M4 工作台/通知回流）。

import { Btn } from '@/ui/primitives/Btn';
import { Card } from '@/ui/primitives/Card';
import { IconBtn } from '@/ui/primitives/IconBtn';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useFocusTrap } from '@/ui/primitives/useFocusTrap';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { PfSrcBadge } from './PfStream';
import type { PfToast } from './PracticeFacePage';
import {
  type JudgePreview,
  type QuestionDetail,
  type StreamItem,
  fileAppeal,
  getAdvice,
  getQuestion,
  solveHint,
  solveStart,
  submitReview,
} from './practice-api';

type Rating = 'again' | 'hard' | 'good';

const VERDICT_OF: Record<JudgePreview['coarse_outcome'], { label: string; tone: Rating }> = {
  correct: { label: '对', tone: 'good' },
  partial: { label: '部分对', tone: 'hard' },
  incorrect: { label: '错', tone: 'again' },
  unsupported: { label: '无法判定', tone: 'hard' },
};

const RATING_LABEL: Record<Rating, string> = { again: '再练', hard: '模糊', good: '掌握' };

// YUK-432 — 客观题判别（OWNER DECISION A：客观题自动判分 + 自动评级，跳过手动 again/hard/good）。
//
// gate 的判据：judge 预览 route 是确定性客观路由（exact/keyword）。**只看 route，不看题型 kind。**
// 必须逐字对齐后端 label gate：后端 src/server/mastery/personalized-difficulty.ts 的
// isObjectiveJudgeRoute(judgeRoute) 仅在 route ∈ OBJECTIVE_JUDGE_ROUTES={exact,keyword} 时才写
// difficulty_calibration_label（键于 judge route，与 kind 无关）。UI auto-rate gate 与之同源——
// UI 发 auto_rate:true ⟺ 后端会写 label。
//
// 为何不能再用 kind-OR 兜底（Bugbot Medium 修复）：一道**题型客观但判分路由非客观**的题（例如
// choice/true_false/fill_blank 携带 judge_kind_override=semantic、路由到 semantic）会在旧的 kind-OR
// 下过 UI gate → auto_rate:true 自动 commit、跳过手动评级 —— 但后端 route gate=false → **不写 label**。
// 结果：用户走完自动流，B1 label 从未落库（firm-up 链仍冻结），且一道被语义判分的题被错误跳过手动
// 评级。route-only gate 消除这个 mismatch：semantic-override 的客观题型回到手动评级流（它确实在被
// 语义判分，而非确定性判分），正常 choice/true_false/fill_blank（其 route 本就是 exact/keyword）继续
// auto-rate。
//
// 客观题：preview 回来后直接以 suggested_rating + auto_rate:true 自动 commit（让客观判分流过后端
// difficulty_calibration_label hook 产标签，解冻 B1 难度 firm-up 链）；用户仍看到判定反馈卡再前进。
// 开放题（含 semantic-override 的客观题型）维持现有手动评级流（字节不变）。
const OBJECTIVE_JUDGE_ROUTES = new Set(['exact', 'keyword']);

export function isObjectiveQuestion(route: string): boolean {
  return OBJECTIVE_JUDGE_ROUTES.has(route);
}

// YUK-432 (Bugbot FINDING 1) — 客观题自动 commit 后退出回流（「返回流」）时是否必须把 slot 标 done。
// auto-commit 后 review 已落库（slot 实质 done）；此时点「返回流」若只 onBack（host 仅回列表、不 PATCH
// slot 状态）会留下「已判分但 slot 卡 in_progress」的不一致态。autoCommitted===true → 走
// onCommittedBack（标 done + 回列表）；未自动 commit（作答中 / 开放题手动流）→ false → 走原 onBack
// （review 未提交，slot 应留 in_progress 供 resume）。纯谓词，供单测固定不变式。
export function shouldMarkSlotDoneOnBack(autoCommitted: boolean): boolean {
  return autoCommitted;
}

// YUK-432 (Bugbot FINDING 2) — 反馈卡上「不服判」入口是否可用。客观题自动 commit 同样落了独立 judge
// 锚点 event（后端 submit.ts:550 在 judge_route ∈ JudgeKind {exact,keyword,…} 时写，并经响应
// judge.judge_event_id 回传），故 deterministic 判定**可申诉**（如 exact-match 误拒了等价答案）。
// 入口在反馈相位、当前未展开申诉框、且拿得到锚点 id 时可用——与 autoCommitted 无关（旧实现错误地用
// autoCommitted 隐藏了它）。手动流锚点在用户提交申诉那刻随 commit 落（res.judge.judge_event_id），客观
// 流锚点在 auto-commit 时已落（同一响应字段），暂存后供此谓词判定。
export function appealEntryAvailable(opts: {
  phase: 'answering' | 'feedback';
  appealOpen: boolean;
  autoCommitted: boolean;
  autoCommitJudgeEventId: string | null;
}): boolean {
  if (opts.phase !== 'feedback' || opts.appealOpen) return false;
  // 自动 commit 流：仅当拿到了可申诉锚点才显示入口（无锚点的判定无可申诉对象）。
  if (opts.autoCommitted) return opts.autoCommitJudgeEventId !== null;
  // 手动流：入口恒可见，锚点在用户提交申诉那一刻随 commit 落库（既有行为，不变）。
  return true;
}

export function PfSolo({
  item,
  pos,
  total,
  onDone,
  onBack,
  onCommittedBack,
  addToast,
}: {
  item: StreamItem;
  pos: number;
  total: number;
  onDone: () => void;
  onBack: () => void;
  // YUK-432 (Bugbot FINDING 1) — 客观题自动 commit 后的「返回流」出口：host 标 slot done + 回列表
  // （不自动推进到下一题）。仅 autoCommitted 时走它；未提供时回落 onBack（向后兼容旧调用方）。
  onCommittedBack?: () => void;
  addToast: (text: string, tone?: PfToast['tone'], icon?: string) => void;
}) {
  const qQ = useQuery({
    queryKey: ['question', item.ref_id],
    queryFn: () => getQuestion(item.ref_id),
  });
  const [sel, setSel] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [judging, setJudging] = useState(false);
  const [preview, setPreview] = useState<JudgePreview | null>(null);
  const [rating, setRating] = useState<Rating | null>(null);
  const [appealOpen, setAppealOpen] = useState(false);
  const [appealText, setAppealText] = useState('');
  const [committing, setCommitting] = useState(false);
  const [coach, setCoach] = useState(false);
  // YUK-432 — 客观题在 preview 回来时已自动 commit（auto_rate:true）。记下来：反馈卡保留判定，
  // 「下一项」只 onDone() 推进（不再二次 commit）。开放题恒 false → 现有手动流不变。
  const [autoCommitted, setAutoCommitted] = useState(false);
  // YUK-432 (Bugbot FINDING 2) — 客观题自动 commit 那次 submitReview 回执的 judge 锚点 id。后端为
  // 客观判分（route ∈ JudgeKind）写了独立 judge event 并回传 judge.judge_event_id；存下来，让反馈卡上
  // 的「不服判」入口在自动 commit 后仍能对这个锚点直接发 appeal（不再二次 submit——review 已落库）。
  // null = 这次自动判定没有可申诉锚点（理论上 exact/keyword 恒有，留 null 兜底 → 入口自动隐藏）。
  const [autoCommitJudgeEventId, setAutoCommitJudgeEventId] = useState<string | null>(null);

  const q = qQ.data ?? null;
  const isChoice = (q?.choices_md?.length ?? 0) > 0;
  const answerMd = isChoice && sel !== null ? (q?.choices_md?.[sel] ?? '') : text;
  const canSubmit = !judging && (isChoice ? sel !== null : text.trim().length > 0);
  const phase: 'answering' | 'feedback' = preview === null ? 'answering' : 'feedback';
  // YUK-432 (Bugbot FINDING 1) — 「返回流」出口：自动 commit 后必须标 slot done（onCommittedBack），
  // 否则只 onBack 会留下「已判分但 slot 卡 in_progress」的不一致。未自动 commit → 原 onBack。
  const handleBack = () =>
    shouldMarkSlotDoneOnBack(autoCommitted) && onCommittedBack ? onCommittedBack() : onBack();

  // commit 接受显式 rating + autoRate：客观题自动流不依赖手动 `rating` state（直接用 judge 的
  // suggested_rating + auto_rate:true）；手动流（开放题/申诉）走 body.rating + auto_rate 缺省 false。
  // previewOverride：客观题自动 commit 在 setPreview 同一 tick 内触发，闭包里的 `preview` 仍是旧的
  // null（state 尚未 re-render），故 runJudge 把 fresh judge preview 直接传进来（手动流省略 → 用
  // 已落 state 的 `preview`）。
  const commit = async (opts: {
    withAppeal: boolean;
    rating: Rating;
    autoRate?: boolean;
    advance?: boolean;
    previewOverride?: JudgePreview;
  }) => {
    const pv = opts.previewOverride ?? preview;
    if (!q || !pv || committing) return;
    setCommitting(true);
    try {
      const res = await submitReview({
        question_id: q.id,
        rating: opts.rating,
        response_md: answerMd,
        referenced_knowledge_ids: q.labels.map((l) => l.id),
        // YUK-372 L2 — 被答 practice_stream_item.id（流作答的 π_i 直 join 判别子，server hook
        // 用它精确取放置该 slot 的随机抽样事件的 π_i）。
        stream_item_id: item.id,
        // YUK-432 — 客观题自动判分+自动评级：server 用 judge 的 suggested rating 覆盖 body.rating，
        // 并让客观判分流过 difficulty_calibration_label hook 产标签（B1 难度 firm-up 链解冻）。
        auto_rate: opts.autoRate,
        judge_result_v2: {
          score: pv.score,
          score_meaning: 'correctness',
          coarse_outcome: pv.coarse_outcome,
          confidence: pv.confidence,
          feedback_md: pv.feedback_md,
          evidence_json: pv.evidence_json,
          capability_ref: pv.capability_ref,
        } as never,
      });
      if (opts.withAppeal) {
        const anchor = res.judge?.judge_event_id;
        if (anchor) {
          await fileAppeal(anchor, appealText.trim());
          addToast('已提交重判——异步跑，结果回来我会提醒你。', 'info', 'clock');
        } else {
          addToast('这次判定没有可申诉的锚点（无服务端判分）。', 'info', 'alert');
        }
      }
      // 客观题自动 commit 成功 → 标记 autoCommitted（反馈卡隐藏手动评级、「下一项」只推进）+ 暂存
      // 这次判定的 judge 锚点 id（FINDING 2：让「不服判」入口在自动 commit 后仍能对它发 appeal）。
      // 只在写入成功后置位：失败时保持手动评级行可见，用户可重试/手动评级（不丢答）。
      if (opts.autoRate && opts.advance === false) {
        setAutoCommitted(true);
        setAutoCommitJudgeEventId(res.judge?.judge_event_id ?? null);
      }
      // advance=false（客观题自动 commit）→ 留在反馈卡让用户先看判定，「下一项」再 onDone()。
      if (opts.advance !== false) onDone();
    } catch (e) {
      addToast(`提交失败：${(e as Error).message}`, 'info', 'alert');
    } finally {
      setCommitting(false);
    }
  };

  // YUK-432 (Bugbot FINDING 2) — 客观题自动 commit 后的「不服判」。review 已落库，不能再走 commit（会
  // 重复 submit 一条 review event）；直接对自动 commit 时暂存的 judge 锚点发 appeal。无锚点 → 入口本
  // 就被 appealEntryAvailable 隐藏，这里再兜底一次。
  const submitAutoCommitAppeal = async () => {
    if (!autoCommitJudgeEventId || committing) return;
    setCommitting(true);
    try {
      await fileAppeal(autoCommitJudgeEventId, appealText.trim());
      addToast('已提交重判——异步跑，结果回来我会提醒你。', 'info', 'clock');
      setAppealOpen(false);
    } catch (e) {
      addToast(`提交重判失败：${(e as Error).message}`, 'info', 'alert');
    } finally {
      setCommitting(false);
    }
  };

  const runJudge = async () => {
    if (!q || !canSubmit) return;
    setJudging(true);
    try {
      const r = await getAdvice(q.id, answerMd);
      setPreview(r.judge);
      setRating(r.judge.suggested_rating);
      // YUK-432 — 客观题（route exact/keyword，与后端 isObjectiveJudgeRoute 同源；不看 kind）：preview
      // 回来即自动 commit（auto_rate:true + suggested_rating），跳过手动 again/hard/good。advance:false 让
      // 用户仍看到判定反馈卡，再按「下一项」推进（commit 成功内部置 autoCommitted）。开放题（含
      // semantic-override 的客观题型）：不自动 commit，落到现有手动评级流。
      if (isObjectiveQuestion(r.judge.route)) {
        await commit({
          withAppeal: false,
          rating: r.judge.suggested_rating,
          autoRate: true,
          advance: false,
          previewOverride: r.judge, // 闭包里的 preview state 此刻仍 null，传 fresh judge。
        });
      }
    } catch (e) {
      addToast(`判分失败：${(e as Error).message}`, 'info', 'alert');
    } finally {
      setJudging(false);
    }
  };

  // 键盘：1-4 选项 · ⌘/Ctrl+Enter 提交
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase !== 'answering' || coach) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void runJudge();
        return;
      }
      if (isChoice && /^[1-4]$/.test(e.key) && (e.target as HTMLElement).tagName !== 'TEXTAREA') {
        setSel(Number(e.key) - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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

  const verdict = preview ? VERDICT_OF[preview.coarse_outcome] : null;

  return (
    <div className="pfs" data-screen-label={`散题作答 · ${q.id}`}>
      <div className="pfs-top">
        {/* YUK-432 (FINDING 1) — 自动 commit 后「返回流」走 handleBack（标 slot done），否则 onBack。 */}
        <Btn size="sm" variant="ghost" icon="arrowL" onClick={() => handleBack()}>
          返回流
        </Btn>
        <span className="pfs-pos">
          流 · 第 {pos} / {total} 项
        </span>
        <PfSrcBadge source={item.source} />
        <span className="topbar-spacer" />
        <Btn size="sm" variant="secondary" icon="teach" onClick={() => setCoach(true)}>
          卡住了？解题会话
        </Btn>
      </div>

      <Card pad="lg">
        <div className="nowrap-meta" style={{ marginBottom: 'var(--s-2)' }}>
          {q.labels.map((l) => (
            <span key={l.id} className="chip chip-k">
              {l.name}
            </span>
          ))}
          <span className="meta mono">{q.id.slice(0, 12)}</span>
        </div>

        <div className="pfs-stem">{q.prompt_md}</div>

        {isChoice ? (
          <div className="pfs-opts" role="radiogroup" aria-label="选项">
            {(q.choices_md ?? []).map((c, i) => {
              const graded = phase === 'feedback';
              const isRight = graded && preview?.coarse_outcome === 'correct' && sel === i;
              const isWrong = graded && preview?.coarse_outcome !== 'correct' && sel === i;
              const cls = [
                'pfs-opt',
                !graded && sel === i ? 'is-sel' : '',
                isRight ? 'is-right' : '',
                isWrong ? 'is-wrong' : '',
              ].join(' ');
              return (
                <button
                  type="button"
                  key={c}
                  className={cls}
                  disabled={graded}
                  // biome-ignore lint/a11y/useSemanticElements: 设计稿卡片式选项
                  // （pfs-opt 布局）；native <input type="radio"> 无法承载该布局，
                  // 真 <button> + radiogroup ARIA 模式语义完整（同 PracticeChoiceOptions）。
                  role="radio"
                  aria-checked={sel === i}
                  onClick={() => setSel(i)}
                >
                  <span className="k mono">{String.fromCharCode(65 + i)}</span>
                  <span className="t">{c}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div style={{ marginTop: 'var(--s-5)' }}>
            <div className="composer answer-composer">
              <textarea
                rows={3}
                value={text}
                disabled={phase === 'feedback'}
                placeholder="写下你的解答…"
                onChange={(e) => setText(e.target.value)}
                aria-label="作答"
              />
            </div>
          </div>
        )}

        {phase === 'answering' && (
          <div className="pfs-actions">
            <Btn
              variant="primary"
              icon="check"
              onClick={() => void runJudge()}
              disabled={!canSubmit}
            >
              {judging ? '判分中…' : '提交 · 即时判分'}
            </Btn>
            <span className="key-hints mono" style={{ marginLeft: 'auto' }}>
              {isChoice ? '1-4 选 · ⌘Enter 提交' : '⌘Enter 提交'}
            </span>
          </div>
        )}

        {phase === 'feedback' && preview && verdict && (
          <div className={`pfs-fb v-${verdict.tone}`}>
            <div className="pfs-fb-head">
              <span className={`badge tone-${verdict.tone}`}>
                <LoomIcon
                  name={
                    verdict.tone === 'good' ? 'check' : verdict.tone === 'again' ? 'close' : 'minus'
                  }
                  size={12}
                />
                {verdict.label}
              </span>
              <span className="ai-tag">
                <LoomIcon name="sparkle" size={12} />
                AI 判定
              </span>
              <span className="pfs-fb-meta">
                judge · {preview.route} · {Math.round(preview.confidence * 100)}%
              </span>
            </div>
            <p className="pfs-fb-text">{preview.feedback_md}</p>
            {q.reference_md && (
              <div className="pfs-fb-ref">
                <span className="cmp-label">参考</span>
                {q.reference_md}
              </div>
            )}

            {/* YUK-432 — 客观题自动判分+自动评级：preview 回来已自动 commit（auto_rate:true），故
                隐藏手动 again/hard/good 评级行；用户仍看到上面的判定反馈卡，按「下一项」推进。
                注意：仅隐藏**手动评级行**——「不服判」入口仍保留（FINDING 2，见下方 footer）。
                开放题：保留现有手动评级行（默认=建议，可改）。 */}
            {!autoCommitted && (
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
                  建议：{RATING_LABEL[preview.suggested_rating]}
                </span>
              </div>
            )}

            <div className="pfs-fb-foot">
              {autoCommitted ? (
                // 客观题：已自动判分+评级，「下一项」只推进（不再二次 commit）。
                <Btn variant="primary" icon="arrow" disabled={committing} onClick={() => onDone()}>
                  {committing ? '判分中…' : '下一项'}
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
                      disabled={!appealText.trim() || committing || !rating}
                      onClick={() => rating && void commit({ withAppeal: true, rating })}
                    >
                      提交重判 · 先继续
                    </Btn>
                  )}
                  <Btn size="sm" variant="ghost" onClick={() => setAppealOpen(false)}>
                    算了
                  </Btn>
                  <span className="key-hints mono" style={{ marginLeft: 'auto' }}>
                    re-judge · 异步 · 不阻塞流
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      <PfCoach open={coach} onClose={() => setCoach(false)} question={q} />
    </div>
  );
}

/* ── 解题会话 — 苏格拉底分级提示（solve 链 API） ── */
function PfCoach({
  open,
  onClose,
  question,
}: {
  open: boolean;
  onClose: () => void;
  question: QuestionDetail;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [hints, setHints] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  useFocusTrap(open, onClose, panelRef);

  useEffect(() => {
    if (!open) {
      setSessionId(null);
      setHints([]);
      setExhausted(false);
    }
  }, [open]);

  const nextHint = async () => {
    setLoading(true);
    try {
      let sid = sessionId;
      if (!sid) {
        sid = (await solveStart(question.id)).session_id;
        setSessionId(sid);
      }
      const h = await solveHint(question.id, sid, hints.length);
      if (h.text_md) setHints((arr) => [...arr, h.text_md]);
      else setExhausted(true);
    } catch {
      setExhausted(true);
    } finally {
      setLoading(false);
    }
  };

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
          <span className="meta mono">socratic · 不给答案</span>
          <span className="topbar-spacer" />
          <IconBtn icon="close" size={16} title="关闭" onClick={onClose} />
        </div>
        <div className="pfs-coach-body">
          <p className="pfs-coach-note">
            我不会直接给答案——一级一级来，每级提示更近一步。会话不计入判分。
          </p>
          {hints.map((h, i) => (
            <div key={`${i}-${h.slice(0, 8)}`} className="pfs-hint">
              <span className="pfs-hint-k">提示 {i + 1}</span>
              {h}
            </div>
          ))}
          {!exhausted ? (
            <Btn
              size="sm"
              variant="secondary"
              icon="chevronDown"
              disabled={loading}
              onClick={() => void nextHint()}
            >
              {loading
                ? '想想…'
                : hints.length === 0
                  ? '给我一点提示'
                  : `再提示一点 · ${hints.length + 1}`}
            </Btn>
          ) : (
            <p className="pfs-coach-note">提示用完了。回到题面把你的思路写进作答框试试。</p>
          )}
        </div>
      </aside>
    </>,
    document.body,
  );
}
