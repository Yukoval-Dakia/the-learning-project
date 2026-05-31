'use client';

// Phase 2C — Active Teaching side drawer.
//
// 设计源：docs/design/loom-design-v2.1/pages.jsx CopilotDrawer + app.css .drawer
// .drawer-head / .drawer-feed / .drawer-foot.
//
// Wide screen (≥1280px)：sticky right column 420px。
// Narrow screen：fixed overlay full-height 100vw 占满。
// 同一 LearningItem 一次会话；mounted=open，unmounted=close。父组件控制开关。

import { TEACHING_CORRECTIVE_FAILURE_N, isCorrectiveRedo } from '@/core/teaching';
import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import {
  type SlimSubjectProfile,
  resolveSubjectRenderModel,
  subjectContentProps,
} from '@/ui/lib/subject';
import { Button } from '@/ui/primitives/Button';
import { type SuggestionKind, SuggestionKindTag } from '@/ui/primitives/SuggestionKindTag';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { type EmbeddedCheckQuestion, EmbeddedCheckSection } from './EmbeddedCheckSection';

type TurnKind = 'explain' | 'ask_check' | 'end';

interface ChatMessage {
  id: string;
  role: 'agent' | 'user';
  text_md: string;
  turn_kind: TurnKind | null;
  question?: EmbeddedCheckQuestion | null;
}

interface StartResponse {
  session_id: string;
  initial_message: ChatMessage;
  suggested_next: 'continue' | 'end';
}

// P5.6 / YUK-178 (§4.3) — cumulative attempt totals for the active question.
// `failure` is a total over the question's whole timeline (NOT a streak); it
// drives the corrective redo chip once it reaches TEACHING_CORRECTIVE_FAILURE_N.
interface AttemptCounts {
  success: number;
  partial: number;
  failure: number;
}

interface TurnResponse {
  user_message: ChatMessage;
  agent_message: ChatMessage;
  suggested_next: 'continue' | 'end';
  was_idle?: boolean;
  // P5.6 — lean fix (no DB column): active question + counts ride the response.
  active_question_id?: string | null;
  attempt_counts?: AttemptCounts | null;
}

// YUK-14 — conversation lifecycle status mirrors the server enum
// (ConversationStatus in src/core/schema/learning_session.ts).
type SessionStatus = 'active' | 'idle' | 'ended' | 'abandoned';

interface SessionPoll {
  session: {
    id: string;
    type: 'conversation';
    status: SessionStatus;
    learning_item_id: string | null;
    started_at: string;
    ended_at: string | null;
  };
  // P5.6 / YUK-178 (§4.3, PIN 8) — the GET poll is the PRIMARY source of the
  // failure total that drives the corrective chip (it observes counts after an
  // attempt lands; the question-creation turn has 0).
  active_question_id?: string | null;
  attempt_counts?: AttemptCounts | null;
}

// design doc Open Q #3 default — UI polls every 30s for status changes
// (idle promote runs every 1min server-side, so 30s catches it within ~30s).
const STATUS_POLL_MS = 30 * 1000;

const TURN_KIND_LABEL: Record<TurnKind, string> = {
  explain: '讲解',
  ask_check: '追问',
  end: '收尾',
};

// P5.6 / YUK-178 (§4.3, LD-3) — drawer chips.
//
// The "redo / revisit" chip is the dynamic corrective producer: its kind flips
// proactive → corrective once the active question's CUMULATIVE attempt failure
// total reaches TEACHING_CORRECTIVE_FAILURE_N (=3, total not consecutive). Below
// the threshold it stays a proactive "出题考我" next-step. When corrective, its
// onClick writes an AcceptSuggestionChip via the accept-chip endpoint (NOT the
// chat-turn send) so it flows through the chip-accept KPI exclusion (§5.2).
//
// The remaining chips are static proactive next-steps (a proactive chip-accept
// DOES count toward the KPI). They keep sending a chat turn — they are
// conversational prompts, not structured chip-accepts.
const REDO_CHIP_LABEL_PROACTIVE = '出题考我';
const REDO_CHIP_LABEL_CORRECTIVE = '重做 / 回看前置';
const REDO_CHIP_TEXT = '出一道相关的题考我一下。';

const STATIC_SUGGESTIONS: Array<{
  label: string;
  text: string;
  suggestion_kind: SuggestionKind;
}> = [
  {
    label: '再讲一遍',
    text: '上一段没完全跟上，能不能换一种说法再讲一遍？',
    suggestion_kind: 'proactive',
  },
  { label: '我懂了', text: '我懂了，继续下一个要点吧。', suggestion_kind: 'proactive' },
];

export interface TeachingDrawerProps {
  learningItemId: string;
  learningItemTitle: string;
  subjectProfile?: SlimSubjectProfile | null;
  onClose: () => void;
}

export function TeachingDrawer({
  learningItemId,
  learningItemTitle,
  subjectProfile,
  onClose,
}: TeachingDrawerProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [suggestedNext, setSuggestedNext] = useState<'continue' | 'end'>('continue');
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<SessionStatus>('active');
  const [bootError, setBootError] = useState<string | null>(null);
  // P5.6 / YUK-178 (§4.3) — active question + cumulative attempt counts, fed by
  // the turn response and (primarily, PIN 8) the GET poll.
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(null);
  const [attemptCounts, setAttemptCounts] = useState<AttemptCounts | null>(null);
  const startCalledRef = useRef(false);
  const streamRef = useRef<HTMLDivElement | null>(null);
  // YUK-14 — design §"Pagehide / sendBeacon" E5: pagehide decision needs the
  // *last seen* status (drawer-was-idle → abandoned, otherwise → ended). We
  // mirror status into a ref so the event listener stays stable.
  const statusRef = useRef<SessionStatus>('active');
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const ended = status === 'ended' || status === 'abandoned';

  // Start the session once on mount.
  useEffect(() => {
    if (!learningItemId || startCalledRef.current) return;
    startCalledRef.current = true;
    (async () => {
      try {
        const res = await apiJson<StartResponse>('/api/teaching-sessions', {
          method: 'POST',
          body: JSON.stringify({ learning_item_id: learningItemId }),
        });
        setSessionId(res.session_id);
        setMessages([res.initial_message]);
        setSuggestedNext(res.suggested_next);
        // turn_kind='end' is an LLM hint, not a state transition (design §T8).
        // The session stays 'active' until the user explicitly ends it.
      } catch (err) {
        if (err instanceof ApiAuthError) {
          setBootError(`${err.message} — 请重新进入页面输入 token`);
        } else {
          setBootError(`无法开启教学会话：${(err as Error).message}`);
        }
      }
    })();
  }, [learningItemId]);

  const turnM = useMutation({
    mutationFn: async (text_md: string) => {
      if (!sessionId) throw new Error('session not ready');
      return apiJson<TurnResponse>(`/api/teaching-sessions/${sessionId}/turn`, {
        method: 'POST',
        body: JSON.stringify({ text_md }),
      });
    },
    onMutate: () => {
      // YUK-14 — Optimistic resume: if we last saw the session as idle, the
      // server will auto-resume on this turn (T2b). Flip the local banner
      // immediately so the UI doesn't show "走开了吗" while we're typing.
      if (statusRef.current === 'idle') setStatus('active');
    },
    onSuccess: (data) => {
      setMessages((prev) => [...prev, data.user_message, data.agent_message]);
      setSuggestedNext(data.suggested_next);
      // P5.6 — track the active question + counts off the turn response. On the
      // turn that CREATES an ask_check question this failure total is 0 (no
      // attempts yet, PIN 8); the GET poll is the primary trigger source.
      if (data.active_question_id !== undefined) setActiveQuestionId(data.active_question_id);
      if (data.attempt_counts !== undefined) setAttemptCounts(data.attempt_counts);
      // was_idle: server confirmation that idle→active happened (we already
      // flipped optimistically; this is the receipt). turn_kind='end' is just
      // a coach hint, not a state transition.
      setDraft('');
    },
  });

  const endM = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error('session not ready');
      return apiJson<{ ok: boolean }>(`/api/teaching-sessions/${sessionId}/end`, {
        method: 'POST',
        body: JSON.stringify({ status: 'ended' }),
      });
    },
    onSuccess: () => setStatus('ended'),
  });

  // P5.6 / YUK-178 (§4.3 / §5.2) — accept-chip writer. A corrective redo chip
  // click writes an AcceptSuggestionChip via the new endpoint (NOT a chat turn),
  // so it routes through the chip-accept KPI exclusion.
  const acceptChipM = useMutation({
    mutationFn: async (input: { suggestion_kind: SuggestionKind; chip_label: string }) => {
      if (!sessionId) throw new Error('session not ready');
      return apiJson<{ ok: boolean; event_id: string }>(
        `/api/teaching-sessions/${sessionId}/accept-chip`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    },
  });

  // A corrective chip-accept is a pure KPI signal (no chat turn, §5.2), so the
  // click would otherwise be silent. Surface a transient inline ack and clear it
  // after a few seconds so it doesn't linger.
  useEffect(() => {
    if (!acceptChipM.isSuccess) return;
    const t = window.setTimeout(() => acceptChipM.reset(), 4000);
    return () => window.clearTimeout(t);
  }, [acceptChipM.isSuccess, acceptChipM.reset]);

  // YUK-14 — Poll session GET every 30s for server-side status flips
  // (idle promote, abandoned cron). Stop polling once the session is in a
  // terminal state.
  useEffect(() => {
    if (!sessionId) return;
    if (status === 'ended' || status === 'abandoned') return;
    const poll = async () => {
      try {
        const res = await apiJson<SessionPoll>(`/api/teaching-sessions/${sessionId}`, {
          method: 'GET',
        });
        const next = res.session.status;
        if (next !== statusRef.current) setStatus(next);
        // P5.6 (PIN 8) — the GET poll is the primary source of the failure total
        // that flips the redo chip corrective (it observes counts after attempts
        // land). undefined = field not present (older payload) → leave as-is.
        if (res.active_question_id !== undefined) setActiveQuestionId(res.active_question_id);
        if (res.attempt_counts !== undefined) setAttemptCounts(res.attempt_counts);
      } catch {
        // Network blip — keep last known status, will retry next interval.
      }
    };
    const interval = window.setInterval(poll, STATUS_POLL_MS);
    // Run once immediately in addition to the interval, but skip the first
    // poll for ~5s to avoid races with the start response.
    const initial = window.setTimeout(poll, 5000);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(initial);
    };
  }, [sessionId, status]);

  // YUK-14 — pagehide listener (design §"Pagehide / sendBeacon"): if the
  // drawer was visibly idle, send abandoned; otherwise ended. unmount cleanup
  // (clicking close / leaving page via SPA nav without reload) always sends
  // ended per E5.
  const closeViaBeaconRef = useRef(false);
  useEffect(() => {
    if (!sessionId) return;
    const onPageHide = () => {
      if (closeViaBeaconRef.current) return;
      closeViaBeaconRef.current = true;
      const finalStatus: 'ended' | 'abandoned' =
        statusRef.current === 'idle' ? 'abandoned' : 'ended';
      const body = new Blob([JSON.stringify({ status: finalStatus })], {
        type: 'application/json',
      });
      navigator.sendBeacon(`/api/teaching-sessions/${sessionId}/end`, body);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      // Drawer unmount via SPA nav / parent unmount: send ended best-effort.
      // Skip if already sent a beacon, or session is already terminal.
      if (closeViaBeaconRef.current) return;
      if (statusRef.current === 'ended' || statusRef.current === 'abandoned') return;
      closeViaBeaconRef.current = true;
      void apiJson(`/api/teaching-sessions/${sessionId}/end`, {
        method: 'POST',
        body: JSON.stringify({ status: 'ended' }),
      }).catch(() => {});
    };
  }, [sessionId]);

  // Auto-scroll on each new bubble / typing toggle.
  const msgCount = messages.length;
  const isTyping = turnM.isPending;
  useEffect(() => {
    void msgCount;
    void isTyping;
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgCount, isTyping]);

  const send = (text: string) => {
    if (!text.trim() || turnM.isPending || ended) return;
    turnM.mutate(text.trim());
  };

  // P5.6 / YUK-178 (§4.3) — the redo chip is corrective once the active
  // question's CUMULATIVE failure total reaches TEACHING_CORRECTIVE_FAILURE_N
  // (total, not consecutive). Single-source helper from @/core/teaching.
  const redoIsCorrective = isCorrectiveRedo(attemptCounts?.failure);
  const redoChipLabel = redoIsCorrective ? REDO_CHIP_LABEL_CORRECTIVE : REDO_CHIP_LABEL_PROACTIVE;

  // A corrective redo chip writes an AcceptSuggestionChip (chip-accept KPI path);
  // a proactive redo chip sends a normal chat turn (§4.3).
  const onRedoChipClick = () => {
    if (turnM.isPending || acceptChipM.isPending || ended) return;
    if (redoIsCorrective) {
      acceptChipM.mutate({ suggestion_kind: 'corrective', chip_label: redoChipLabel });
    } else {
      send(REDO_CHIP_TEXT);
    }
  };

  const subjectModel = resolveSubjectRenderModel(subjectProfile);
  const messageBodyProps = subjectContentProps(subjectModel, { className: 'body' });

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(draft);
    }
  };

  return (
    <aside className="teach-drawer">
      <header className="drawer-head">
        <div className="title">
          <span className="brand-mark" aria-hidden>
            ◎
          </span>
          <h3>对话教学</h3>
        </div>
        <span className="context-chip" title={`context = ${learningItemId}`}>
          {learningItemTitle} · {subjectModel.displayName}
        </span>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="关闭抽屉">
          ×
        </button>
      </header>

      <div className="drawer-feed teach-chat-page" ref={streamRef}>
        {bootError && (
          <div className="error-row" style={{ color: 'var(--again-ink)' }}>
            {bootError}
          </div>
        )}

        {!bootError && !sessionId && <div className="session-banner">正在开启会话…</div>}

        {sessionId && (
          <>
            <div
              className={`session-banner${
                status === 'ended' || status === 'abandoned' ? ' ended' : ''
              }${status === 'idle' ? ' is-idle' : ''}${
                status === 'abandoned' ? ' is-abandoned' : ''
              }`}
            >
              ── learning_session(type='conversation', status={status}) ──
            </div>

            {status === 'idle' && (
              <output className="idle-banner">
                <strong>走开了吗？</strong> 敲字继续，或点「结束」收尾。
              </output>
            )}

            <div className="msg-stream">
              {messages.map((m) => (
                <div key={m.id} className={`msg ${m.role}`}>
                  <div className="actor-line">
                    <span>{m.role === 'agent' ? 'agent · TeachingTurnTask' : 'user · self'}</span>
                    {m.turn_kind && <span>· {TURN_KIND_LABEL[m.turn_kind]}</span>}
                  </div>
                  <MathMarkdown
                    notation={
                      (subjectModel.renderConfig.notation ?? undefined) as
                        | 'latex'
                        | 'wenyan'
                        | 'plaintext'
                        | 'code'
                        | undefined
                    }
                    {...messageBodyProps}
                  >
                    {m.text_md}
                  </MathMarkdown>
                  {m.role === 'agent' && m.turn_kind === 'ask_check' && m.question ? (
                    <EmbeddedCheckSection
                      status="ready"
                      questions={[m.question]}
                      notation={
                        (subjectModel.renderConfig.notation ?? undefined) as
                          | 'latex'
                          | 'wenyan'
                          | 'plaintext'
                          | 'code'
                          | undefined
                      }
                      readyLabel="追问题 · 1 题"
                    />
                  ) : null}
                </div>
              ))}
              {turnM.isPending && (
                <div className="msg agent">
                  <div className="actor-line">
                    <span>agent · TeachingTurnTask</span>
                    <span>· 思考中…</span>
                  </div>
                  <div className="typing">
                    <span className="dot" />
                    <span className="dot" style={{ animationDelay: '0.2s' }} />
                    <span className="dot" style={{ animationDelay: '0.4s' }} />
                  </div>
                </div>
              )}
            </div>

            {status === 'ended' && (
              <div className="end-banner">会话已结束。关闭抽屉再点「对话教学」开启新对话。</div>
            )}
            {status === 'abandoned' && (
              <div className="end-banner is-abandoned">
                会话已过期（&gt;6 小时未活动）。关闭抽屉再点「对话教学」开启新对话。
              </div>
            )}
          </>
        )}
      </div>

      {sessionId && !ended && (
        <div className="drawer-foot">
          <div className="suggestions">
            {STATIC_SUGGESTIONS.map((s) => (
              <button
                key={s.label}
                type="button"
                className={`suggest-chip ${s.suggestion_kind === 'corrective' ? 'is-corrective' : ''}`}
                onClick={() => send(s.text)}
                disabled={turnM.isPending}
              >
                {s.label}
                <SuggestionKindTag kind={s.suggestion_kind} />
              </button>
            ))}
            {/* P5.6 / YUK-178 (§4.3, LD-3) — dynamic redo chip: corrective once
                cumulative failure >= TEACHING_CORRECTIVE_FAILURE_N (=3, total). */}
            <button
              type="button"
              className={`suggest-chip ${redoIsCorrective ? 'is-corrective' : ''}`}
              onClick={onRedoChipClick}
              disabled={turnM.isPending || acceptChipM.isPending}
              data-corrective={redoIsCorrective}
              title={
                redoIsCorrective
                  ? `已累计 ${attemptCounts?.failure ?? 0} 次失败（>= ${TEACHING_CORRECTIVE_FAILURE_N}）— 建议重做 / 回看前置`
                  : undefined
              }
            >
              {redoChipLabel}
              <SuggestionKindTag kind={redoIsCorrective ? 'corrective' : 'proactive'} />
            </button>
          </div>
          <div className="composer">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
              disabled={turnM.isPending}
              rows={2}
            />
            <div className="actions">
              <Button onClick={() => send(draft)} disabled={!draft.trim() || turnM.isPending}>
                发送
              </Button>
              <Button onClick={() => endM.mutate()} disabled={endM.isPending} variant="ghost">
                结束
              </Button>
            </div>
          </div>
          <div className="footer-line">
            <span>
              {suggestedNext === 'end' ? (
                <span className="hint">教练建议结束 — 可继续追问或点结束</span>
              ) : (
                <span>session={sessionId.slice(0, 8)}…</span>
              )}
            </span>
            {turnM.isError ? (
              <span className="error">发送失败：{(turnM.error as Error)?.message}</span>
            ) : acceptChipM.isError ? (
              <span className="error">记录失败：{(acceptChipM.error as Error)?.message}</span>
            ) : acceptChipM.isSuccess ? (
              <span className="hint">已记录重做信号 ✓（计入复习信号，不打扰当前对话）</span>
            ) : null}
          </div>
        </div>
      )}
    </aside>
  );
}
