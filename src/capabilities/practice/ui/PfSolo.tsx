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

  const q = qQ.data ?? null;
  const isChoice = (q?.choices_md?.length ?? 0) > 0;
  const answerMd = isChoice && sel !== null ? (q?.choices_md?.[sel] ?? '') : text;
  const canSubmit = !judging && (isChoice ? sel !== null : text.trim().length > 0);
  const phase: 'answering' | 'feedback' = preview === null ? 'answering' : 'feedback';

  const runJudge = async () => {
    if (!q || !canSubmit) return;
    setJudging(true);
    try {
      const r = await getAdvice(q.id, answerMd);
      setPreview(r.judge);
      setRating(r.judge.suggested_rating);
    } catch (e) {
      addToast(`判分失败：${(e as Error).message}`, 'info', 'alert');
    } finally {
      setJudging(false);
    }
  };

  const commit = async (withAppeal: boolean) => {
    if (!q || !preview || !rating || committing) return;
    setCommitting(true);
    try {
      const res = await submitReview({
        question_id: q.id,
        rating,
        response_md: answerMd,
        referenced_knowledge_ids: q.labels.map((l) => l.id),
        // YUK-372 L2 — 被答 practice_stream_item.id（流作答的 π_i 直 join 判别子，server hook
        // 用它精确取放置该 slot 的随机抽样事件的 π_i）。
        stream_item_id: item.id,
        judge_result_v2: {
          score: preview.score,
          score_meaning: 'correctness',
          coarse_outcome: preview.coarse_outcome,
          confidence: preview.confidence,
          feedback_md: preview.feedback_md,
          evidence_json: preview.evidence_json,
          capability_ref: preview.capability_ref,
        } as never,
      });
      if (withAppeal) {
        const anchor = res.judge?.judge_event_id;
        if (anchor) {
          await fileAppeal(anchor, appealText.trim());
          addToast('已提交重判——异步跑，结果回来我会提醒你。', 'info', 'clock');
        } else {
          addToast('这次判定没有可申诉的锚点（无服务端判分）。', 'info', 'alert');
        }
      }
      onDone();
    } catch (e) {
      addToast(`提交失败：${(e as Error).message}`, 'info', 'alert');
    } finally {
      setCommitting(false);
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

            <div className="pfs-fb-foot">
              <Btn
                variant="primary"
                icon="arrow"
                disabled={committing}
                onClick={() => void commit(false)}
              >
                {committing ? '提交中…' : '确认评级 · 下一项'}
              </Btn>
              {!appealOpen && (
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
                    disabled={!appealText.trim() || committing}
                    onClick={() => void commit(true)}
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
