// M2 练习面 — 卷模式（YUK-316）。
// 设计基准 docs/design/loom-refresh/project/pface-paper.jsx：§6.4 缓冲反馈——
// 作答全程零语义色（pip 只有「已答」的中性墨点），颜色在交卷瞬间才进场。
// 后端语义：草稿 PUT answer 自动保存；「交卷」= 未提交 slot 逐个 POST submit
//（judge-now-show-later，visible_to_user=false 缓冲）+ session end → 可见性解锁。

import { usePagehideTransition } from '@/ui/hooks/usePagehideTransition';
import { Btn } from '@/ui/primitives/Btn';
import { Card } from '@/ui/primitives/Card';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { PfToast } from './PracticeFacePage';
import {
  type PaperDetail,
  type PaperSlot,
  endPaperSession,
  getPaperDetail,
  pausePaperSession,
  savePaperAnswer,
  startPaperSession,
  submitPaperSlot,
} from './practice-api';

function slotKey(s: PaperSlot): string {
  return `${s.question_id}::${s.part_ref ?? ''}`;
}

export function PfPaper({
  artifactId,
  onExit,
  onSubmitted,
  addToast,
}: {
  artifactId: string;
  onExit: () => void;
  onSubmitted: () => void;
  addToast: (text: string, tone?: PfToast['tone'], icon?: string) => void;
}) {
  const qc = useQueryClient();
  const detailQ = useQuery({
    queryKey: ['paper', artifactId],
    queryFn: () => getPaperDetail(artifactId),
  });
  const detail: PaperDetail | null = detailQ.data ?? null;
  const slots = useMemo(() => detail?.sections.flatMap((s) => s.slots) ?? [], [detail]);

  const [pos, setPos] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Per-slot autosave-failed flags. While any is set the top chip stops claiming
  // 「草稿自动保存」and the exit / foot copy drop their 「进度保留」promise, since the
  // last draft PUT for that slot never landed.
  const [saveFailed, setSaveFailed] = useState<Record<string, boolean>>({});
  // Concurrent draft PUTs for one slot can settle out of order; only the LATEST
  // request may update that slot's failed flag, or an old success would clear a
  // newer failure (and vice versa).
  const saveSeq = useRef<Record<string, number>>({});
  const sessionRef = useRef<string | null>(null);
  const sessionOpenRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 已有 session 复用；没有则开卷即建（answer/submit 都需要 session_id）。
  useEffect(() => {
    if (!detail) return;
    if (detail.session) {
      sessionRef.current = detail.session.id;
      sessionOpenRef.current = ['started', 'paused'].includes(detail.session.status);
      return;
    }
    void startPaperSession(artifactId)
      .then((r) => {
        sessionRef.current = r.session_id;
        sessionOpenRef.current = true;
      })
      .catch((e) => addToast(`开卷失败：${(e as Error).message}`, 'info', 'alert'));
  }, [detail, artifactId, addToast]);

  // 草稿初值：服务端 draft / 已提交 answer 回填。
  useEffect(() => {
    if (slots.length === 0) return;
    setAnswers((cur) => {
      const next = { ...cur };
      for (const s of slots) {
        const k = slotKey(s);
        if (next[k] !== undefined) continue;
        next[k] = s.slot_state.submission?.answer_md ?? s.slot_state.draft?.content_md ?? '';
      }
      return next;
    });
  }, [slots]);

  const pauseCurrentSession = useCallback((keepalive = false) => {
    const sid = sessionRef.current;
    if (!sid || !sessionOpenRef.current) return Promise.resolve();
    // Claim the transition before starting the request so duplicate pagehide
    // events and the explicit exit button cannot emit parallel PATCHes.
    sessionOpenRef.current = false;
    return pausePaperSession(sid, { keepalive }).catch((error) => {
      sessionOpenRef.current = true;
      throw error;
    });
  }, []);

  usePagehideTransition(() => pauseCurrentSession(true));

  const exitPaper = () => {
    void pauseCurrentSession().catch(() => {});
    onExit();
  };

  if (detailQ.isLoading) return <p className="quiet-empty">取卷中…</p>;
  if (detailQ.isError || !detail || slots.length === 0)
    return (
      <div className="pfp">
        <Btn size="sm" variant="ghost" icon="arrowL" onClick={onExit}>
          返回流
        </Btn>
        <p className="quiet-empty">卷加载失败或没有题。</p>
      </div>
    );

  const cur = slots[Math.min(pos, slots.length - 1)];
  const curKey = slotKey(cur);
  const isChoice = (cur.question.choices_md?.length ?? 0) > 0;
  const submittedKeys = new Set(
    slots.filter((s) => s.slot_state.submission?.submitted).map(slotKey),
  );
  const answeredCount = slots.filter((s) => (answers[slotKey(s)] ?? '').trim().length > 0).length;
  const unanswered = slots.length - answeredCount;

  // 草稿 PUT：成功清掉该 slot 的失败标记，失败则点亮——不再静默吞掉错误。
  const runSave = (key: string, questionId: string, partRef: PaperSlot['part_ref'], v: string) => {
    const sid = sessionRef.current;
    if (!sid) return;
    const seq = (saveSeq.current[key] ?? 0) + 1;
    saveSeq.current[key] = seq;
    void savePaperAnswer(artifactId, {
      session_id: sid,
      question_id: questionId,
      part_ref: partRef,
      answer_md: v,
    })
      .then(() => {
        if (saveSeq.current[key] !== seq) return;
        setSaveFailed((f) => (f[key] ? { ...f, [key]: false } : f));
      })
      .catch(() => {
        if (saveSeq.current[key] !== seq) return;
        setSaveFailed((f) => ({ ...f, [key]: true }));
      });
  };

  const anySaveFailed = slots.some((s) => saveFailed[slotKey(s)]);
  const retryFailedSaves = () => {
    for (const s of slots) {
      const k = slotKey(s);
      if (saveFailed[k]) runSave(k, s.question_id, s.part_ref, answers[k] ?? '');
    }
  };

  const setAnswer = (v: string) => {
    setAnswers((a) => ({ ...a, [curKey]: v }));
    // 草稿自动保存（防抖 800ms；已提交的 slot 不再写草稿）。
    if (submittedKeys.has(curKey)) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const key = curKey;
    const questionId = cur.question_id;
    const partRef = cur.part_ref;
    saveTimer.current = setTimeout(() => runSave(key, questionId, partRef, v), 800);
  };

  const goPos = (n: number) => {
    setConfirm(false);
    setPos(Math.max(0, Math.min(slots.length - 1, n)));
  };

  const submitAll = async () => {
    const sid = sessionRef.current;
    if (!sid || submitting) return;
    setSubmitting(true);
    // Claim the terminal transition before any network request so pagehide cannot
    // race a completion attempt with a competing pause PATCH.
    sessionOpenRef.current = false;
    let completionCommitted = false;
    try {
      for (const s of slots) {
        if (submittedKeys.has(slotKey(s))) continue;
        await submitPaperSlot(artifactId, {
          session_id: sid,
          question_id: s.question_id,
          part_ref: s.part_ref,
          answer_md: answers[slotKey(s)] ?? '',
        });
      }
      await endPaperSession(sid);
      completionCommitted = true;
      await qc.invalidateQueries({ queryKey: ['paper', artifactId] });
      onSubmitted();
    } catch (e) {
      // The page is still alive, so let a retry or explicit exit own the session.
      if (!completionCommitted) sessionOpenRef.current = true;
      addToast(`交卷失败：${(e as Error).message}`, 'info', 'alert');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="pfp" data-screen-label={`卷模式 · ${artifactId}`}>
      <div className="pfp-top">
        <Btn size="sm" variant="ghost" icon="arrowL" onClick={exitPaper}>
          {anySaveFailed ? '退出' : '退出 · 进度保留'}
        </Btn>
        <span className="pfp-title">{detail.title}</span>
        {anySaveFailed ? (
          <button type="button" className="pfp-saved is-failed" onClick={retryFailedSaves}>
            <LoomIcon name="alert" size={12} />
            保存失败 · 重试
          </button>
        ) : (
          <span className="pfp-saved">
            <LoomIcon name="check" size={12} />
            草稿自动保存
          </span>
        )}
      </div>

      <div className="pfp-buffer">
        <LoomIcon name="clock" size={14} className="ico" />
        <span>反馈缓冲：这张卷不给即时对错——交卷后统一判分。和散题的节奏是反着的，刻意的。</span>
      </div>

      <div className="pfp-pips" role="tablist" aria-label="题目导航">
        {slots.map((s, i) => {
          const has = (answers[slotKey(s)] ?? '').trim().length > 0;
          return (
            <button
              type="button"
              key={slotKey(s)}
              role="tab"
              aria-selected={i === pos}
              className={`pfp-pip${i === pos ? ' current' : ''}${has ? ' answered' : ''}`}
              onClick={() => goPos(i)}
            >
              {i + 1}
            </button>
          );
        })}
      </div>

      <Card pad="lg">
        <div className="nowrap-meta" style={{ marginBottom: 'var(--s-2)' }}>
          <span className="meta mono">
            {cur.question_id.slice(0, 12)} · {pos + 1}/{slots.length}
          </span>
        </div>
        <div className="pfs-stem">{cur.question.prompt_md}</div>

        {isChoice ? (
          <div className="pfs-opts" role="radiogroup" aria-label="选项">
            {(cur.question.choices_md ?? []).map((c, i) => (
              <button
                type="button"
                key={c}
                // biome-ignore lint/a11y/useSemanticElements: 设计稿卡片式选项
                // （pfs-opt 布局）；native <input type="radio"> 无法承载该布局，
                // 真 <button> + radiogroup ARIA 模式语义完整（同 PracticeChoiceOptions）。
                role="radio"
                aria-checked={answers[curKey] === c}
                className={`pfs-opt${answers[curKey] === c ? ' is-sel' : ''}`}
                disabled={submittedKeys.has(curKey)}
                onClick={() => setAnswer(c)}
              >
                <span className="k mono">{String.fromCharCode(65 + i)}</span>
                <span className="t">{c}</span>
              </button>
            ))}
          </div>
        ) : (
          <div style={{ marginTop: 'var(--s-5)' }}>
            <div className="composer answer-composer">
              <textarea
                rows={3}
                value={answers[curKey] ?? ''}
                disabled={submittedKeys.has(curKey)}
                placeholder="写下你的解答。交卷前都可以改。"
                onChange={(e) => setAnswer(e.target.value)}
                aria-label="作答"
              />
            </div>
          </div>
        )}
      </Card>

      <div className="pfp-foot">
        <Btn
          size="sm"
          variant="secondary"
          icon="arrowL"
          disabled={pos === 0}
          onClick={() => goPos(pos - 1)}
        >
          上一题
        </Btn>
        <Btn
          size="sm"
          variant="secondary"
          iconEnd="arrow"
          disabled={pos === slots.length - 1}
          onClick={() => goPos(pos + 1)}
        >
          下一题
        </Btn>
        <span className="pfp-count tnum">
          已答 {answeredCount} / {slots.length}
        </span>
        {confirm ? (
          <span className="nowrap-meta">
            <span className="meta">还有 {unanswered} 题空着——仍要交？</span>
            <Btn
              size="sm"
              variant="primary"
              icon="send"
              disabled={submitting}
              onClick={() => void submitAll()}
            >
              {submitting ? '判分中…' : '交卷'}
            </Btn>
            <Btn size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              再看看
            </Btn>
          </span>
        ) : (
          <Btn
            size="sm"
            variant="primary"
            icon="send"
            disabled={submitting}
            onClick={() => (unanswered > 0 ? setConfirm(true) : void submitAll())}
          >
            {submitting ? '判分中…' : '交卷 · 统一判分'}
          </Btn>
        )}
      </div>
      <div className="key-hints mono" style={{ marginTop: 'var(--s-3)' }}>
        {anySaveFailed
          ? '有草稿没保存上——退出前先点「保存失败 · 重试」'
          : '中途退出进度保留 · 交卷后到复盘看逐题判定'}
      </div>
    </div>
  );
}
