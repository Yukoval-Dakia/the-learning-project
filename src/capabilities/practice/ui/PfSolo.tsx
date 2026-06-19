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
// 任一命中即客观：
//   1. judge 预览 route 是确定性客观路由（exact/keyword，与后端 server/mastery/personalized-difficulty.ts
//      OBJECTIVE_JUDGE_ROUTES 同源——纯字符串/集合匹配、零 LLM）。
//   2. 题型本身是封闭客观题（choice/true_false/fill_blank）。
// 客观题：preview 回来后直接以 suggested_rating + auto_rate:true 自动 commit（让客观判分流过后端
// difficulty_calibration_label hook 产标签，解冻 B1 难度 firm-up 链）；用户仍看到判定反馈卡再前进。
// 开放题维持现有手动评级流（字节不变）。
const OBJECTIVE_JUDGE_ROUTES = new Set(['exact', 'keyword']);
const OBJECTIVE_QUESTION_KINDS = new Set(['choice', 'true_false', 'fill_blank']);

export function isObjectiveQuestion(route: string, questionKind: string | undefined): boolean {
  if (OBJECTIVE_JUDGE_ROUTES.has(route)) return true;
  return questionKind != null && OBJECTIVE_QUESTION_KINDS.has(questionKind);
}

export function PfSolo({
  item,
  pos,
  total,
  onDone,
  onBack,
  addToast,
}: {
  item: StreamItem;
  pos: number;
  total: number;
  onDone: () => void;
  onBack: () => void;
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
  // YUK-432 — 客观题在 preview 回来时已自动 commit（auto_rate:true）。记下来：反馈卡隐藏手动评级
  // 按钮，「下一项」只 onDone() 推进（不再二次 commit）。开放题恒 false → 现有手动流不变。
  const [autoCommitted, setAutoCommitted] = useState(false);

  const q = qQ.data ?? null;
  const isChoice = (q?.choices_md?.length ?? 0) > 0;
  const answerMd = isChoice && sel !== null ? (q?.choices_md?.[sel] ?? '') : text;
  const canSubmit = !judging && (isChoice ? sel !== null : text.trim().length > 0);
  const phase: 'answering' | 'feedback' = preview === null ? 'answering' : 'feedback';

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
      // 客观题自动 commit 成功 → 标记 autoCommitted（反馈卡隐藏手动评级、「下一项」只推进）。
      // 只在写入成功后置位：失败时保持手动评级行可见，用户可重试/手动评级（不丢答）。
      if (opts.autoRate && opts.advance === false) setAutoCommitted(true);
      // advance=false（客观题自动 commit）→ 留在反馈卡让用户先看判定，「下一项」再 onDone()。
      if (opts.advance !== false) onDone();
    } catch (e) {
      addToast(`提交失败：${(e as Error).message}`, 'info', 'alert');
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
      // YUK-432 — 客观题（route exact/keyword 或 kind choice/true_false/fill_blank）：preview 回来即
      // 自动 commit（auto_rate:true + suggested_rating），跳过手动 again/hard/good。advance:false 让用户
      // 仍看到判定反馈卡，再按「下一项」推进（commit 成功内部置 autoCommitted）。开放题：不自动
      // commit，落到现有手动评级流。
      if (isObjectiveQuestion(r.judge.route, q.kind)) {
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
        <Btn size="sm" variant="ghost" icon="arrowL" onClick={onBack}>
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
              {!autoCommitted && !appealOpen && (
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
                  <Btn
                    size="sm"
                    variant="secondary"
                    icon="send"
                    disabled={!appealText.trim() || committing || !rating}
                    onClick={() => rating && void commit({ withAppeal: true, rating })}
                  >
                    提交重判 · 先继续
                  </Btn>
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
