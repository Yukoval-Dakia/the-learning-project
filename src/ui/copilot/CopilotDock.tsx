// AF Slice 0 / YUK-169 — global Copilot drawer with live chat.
// AF S2a / S3a (YUK-203 U3) — moved out of today/ (CopilotDock, global not
// Today-scoped) + session persistence with replay-last-N.
//
// Mounts <CopilotDrawer> with three regions:
//   • summary  — /api/today/copilot-summary (Coach + Dreaming digest), preserved
//                verbatim. The route stays Today-scoped (the data genuinely IS
//                today's), so the "今日摘要"-style copy in this slot is correct.
//   • chat     — message list + real request to the existing, NON-STREAMING POST
//                /api/copilot/chat (returns one final reply). On open, the list
//                is prefilled from GET /api/copilot/turns (replay-last-N) so the
//                conversation is continuous across drawer reopens / reloads.
//   • footer   — quick-chips + composer (Enter to send, Shift+Enter newline).
//
// Contract notes (see docs/design/2026-06-04-redraw-composer-preflight.md +
// docs/design/2026-06-04-l-copilot-preflight.md):
//   • The endpoint is non-streaming (Response.json) — we render a real
//     "thinking" in-flight bubble, then the final reply. No fake typewriter.
//   • The route does NOT return tool-call details (RunTaskResult is text-only),
//     so tool-use cards are phase-deferred (no mock fixtures in production).
//   • Turn persistence + replay-last-N is AF Slice 3a. Rolling summary is S3b
//     (YAGNI-gated, NOT built here).
//   • Token never touches the client: requests go through apiJson, which adds
//     the x-internal-token header; the Anthropic key stays server-side.
//   • Replay is best-effort: a turns-fetch failure degrades to the prior
//     in-memory-only behaviour (no error surfaced for the prefill path).

'use client';

import type { CopilotSkillContextT } from '@/server/copilot/chat';
import { ApiError, apiJson } from '@/ui/lib/api';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { useCopilotDwell, useCopilotOpenSignal } from '@/ui/lib/use-copilot-dwell';
import { Btn } from '@/ui/primitives/Btn';
import { Button } from '@/ui/primitives/Button';
import { CopilotDrawer } from '@/ui/primitives/CopilotDrawer';
import { LoomBadge } from '@/ui/primitives/LoomBadge';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ReplayTurn, replayToMessages } from './replay';

interface DreamingPreviewRow {
  proposal_id: string;
  kind: string;
  brief: string;
  proposed_at: string;
}

interface CopilotSummary {
  daily_focus: string;
  plan_adjustments_count: number | null;
  review_due_count: number;
  brief_global_md: string | null;
  dreaming_preview: DreamingPreviewRow[];
  pending_proposals_total: number;
  coach_last_run_at: string | null;
  dreaming_last_run_at: string | null;
}

// AF S4 / YUK-203 U6 — UI-side mirror of the server CopilotSkillTurn carrier
// (src/server/copilot/chat.ts). Set only when a teaching/solve skill ran a
// structured turn; absent for free-form chat (so the existing text-only render
// path is untouched). The Dock reads `structured_question` + `suggested_next`
// to render the inline question card + corrective chip.
interface SkillTurn {
  kind: 'explain' | 'ask_check' | 'end';
  structured_question?: {
    id: string;
    kind: string;
    prompt_md: string;
    choices_md: string[] | null;
  };
  // Contract mirror of the server CopilotSkillTurn.suggested_next field.
  // Reserved for future chip-level UX (e.g. auto-suggest "继续" / "结束" chips).
  // End-of-session rendering is driven by kind==='end', not this field.
  suggested_next?: 'continue' | 'end';
}

// POST /api/copilot/chat response shape — see src/server/copilot/chat.ts
// (CopilotChatResult). `reply` is the complete final text (non-streaming).
interface CopilotChatResponse {
  task_run_id: string;
  reply: string;
  surface: string;
  triggered_by: string;
  session_id: string;
  reply_event_id: string;
  user_ask_event_id?: string;
  // AF S4 / YUK-203 U6 — additive optional structured-turn carrier.
  skill_turn?: SkillTurn;
}

// GET /api/copilot/turns response shape — see src/server/copilot/turns.ts.
interface CopilotTurnsResponse {
  turns: ReplayTurn[];
}

interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  text: string;
  // AF S4 / YUK-203 U6 — set on an AI message produced by a teaching/solve
  // skill turn. `skill_turn` drives the structured-question card + chips;
  // `session_id` is the Copilot session id the corrective accept-chip posts to;
  // `reply_event_id` is the precise anchor for the corrective chip resolver
  // (PR #305 — avoids wrong-anchor on multi-card sessions);
  // `skill_context` is the originating skill selector, forwarded from the turns
  // API (round-2) so activeSkillRef can be restored on replay.
  skill_turn?: SkillTurn;
  session_id?: string;
  reply_event_id?: string;
  skill_context?: CopilotSkillContextT;
}

// Quick-chips are user-readable prompts; they send via triggered_by:'chat'
// (the 'chip' surface is a different mistake-action allowlist — see chat.ts
// COPILOT_CHAT_TRIGGER_KINDS — and is NOT what these prefilled prompts mean).
const QUICK_CHIPS = ['今天该复习哪些？', '解释「之」的用法'] as const;

// replay-last-N window (matches the turns route default).
const REPLAY_LIMIT = 20;

function nextId(): string {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function CopilotDock() {
  const { open, openDrawer, closeDrawer: closeDrawerDwell } = useCopilotDwell();
  const summaryQ = useQuery({
    queryKey: ['copilot-summary'],
    queryFn: () => apiJson<CopilotSummary>('/api/today/copilot-summary'),
    enabled: open,
    refetchInterval: open ? 60_000 : false,
  });

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  // AF S4 / YUK-203 U6 — the active skill context (teaching/solve). When set, the
  // next turn(s) route to the skill (single-session model, §4.2). Held in a ref
  // so the composer's `send` reads the live value without re-creating `send`.
  // Lifecycle:
  //   SET   — when the open-with-context signal fires (cross-tree button click)
  //           OR when the replay effect finds the last non-end skill turn with a
  //           skill_context (restores teaching continuity after page refresh).
  //   CLEAR — on closeDrawer, or when the skill returns kind==='end', so
  //           free-form turns after a session end are not re-routed to a stale
  //           skill. A replayed end turn correctly leaves the ref null.
  const activeSkillRef = useRef<CopilotSkillContextT | null>(null);
  // AF S4 / YUK-203 U6 — wrap closeDrawer to also clear the active skill context
  // so that re-opening the Dock after closing does not resume a stale skill.
  const closeDrawer = useCallback(() => {
    activeSkillRef.current = null;
    closeDrawerDwell();
  }, [closeDrawerDwell]);
  // Holds the last user_message so the error-state "重试" button can resend it.
  const lastUserMessageRef = useRef<string | null>(null);
  // Synchronous single-flight guard: `sending` state lags a re-render behind,
  // so rapid double-Enter could fire duplicate POSTs from the stale closure.
  const sendingRef = useRef(false);
  const streamRef = useRef<HTMLDivElement | null>(null);
  // AF S3a — replay runs once per open; guard so a refetch / re-render does not
  // clobber the live in-memory list with a stale prefill.
  const replayedRef = useRef(false);

  // AF S3a — on open, prefill the message list from GET /api/copilot/turns
  // (replay-last-N). Best-effort: on failure we keep the current in-memory list
  // (graceful degradation to pre-S3a behaviour) and surface no error for the
  // prefill path. Only replays into an empty list, and only once per open.
  //
  // AF S4 / YUK-203 U6 (round-2) — after prefilling, scan replayed messages for
  // the latest AI turn whose skill_turn.kind !== 'end' and that carries a
  // skill_context. If found, restore activeSkillRef so composer answers after a
  // page refresh continue through the teaching/solve skill. If the last skill turn
  // is 'end' (or there is none), the ref stays null → free-form.
  useEffect(() => {
    if (!open) {
      replayedRef.current = false;
      return;
    }
    if (replayedRef.current) return;
    replayedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiJson<CopilotTurnsResponse>(`/api/copilot/turns?limit=${REPLAY_LIMIT}`);
        if (cancelled) return;
        const replayed = replayToMessages(res.turns ?? []);
        if (replayed.length === 0) return;
        // Only prefill if the user has not already started typing/sending in this
        // open (don't stomp a live exchange that raced the fetch).
        setMessages((prev) => (prev.length === 0 ? replayed : prev));
        // Restore the active skill context from the last non-end skill turn so
        // composer answers after a page refresh still route to the skill.
        // Scan newest-first (replayed is oldest→newest, so reverse-iterate).
        for (let i = replayed.length - 1; i >= 0; i--) {
          const m = replayed[i];
          if (m.role !== 'ai' || !m.skill_turn) continue;
          if (m.skill_turn.kind === 'end') break; // ended session → stop, leave ref null
          if (m.skill_context) {
            activeSkillRef.current = m.skill_context;
          }
          break; // found the latest skill turn — done either way
        }
      } catch {
        // Replay is best-effort — stay on the in-memory list.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Auto-scroll the message stream to the bottom on new messages / loading.
  // `sending` is an intentional trigger dep: when it flips true the thinking
  // bubble mounts and we want to scroll to it, even though the effect body
  // only reads the ref.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sending drives the scroll-to-thinking-bubble
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || sendingRef.current) return;
    sendingRef.current = true;
    lastUserMessageRef.current = text;
    setError(null);
    setInput('');
    setMessages((prev) => [...prev, { id: nextId(), role: 'user', text }]);
    setSending(true);
    // AF S4 / YUK-203 U6 — when a skill context is active, route this turn to the
    // teaching/solve skill (additive optional body field; absent → unchanged
    // free-form chat). The Copilot session id is unchanged (single-session, §4.2).
    const skillContext = activeSkillRef.current;
    try {
      const res = await apiJson<CopilotChatResponse>('/api/copilot/chat', {
        method: 'POST',
        body: JSON.stringify({
          user_message: text,
          triggered_by: 'chat',
          ...(skillContext ? { skill_context: skillContext } : {}),
        }),
      });
      // AF S4 / YUK-203 U6 — clear the active skill on end turn so subsequent
      // free-form messages are not re-routed to the stale skill context.
      if (res.skill_turn?.kind === 'end') {
        activeSkillRef.current = null;
      }
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'ai',
          text: res.reply,
          skill_turn: res.skill_turn,
          session_id: res.session_id,
          reply_event_id: res.reply_event_id,
          // Store the originating skill_context on the message so the replay
          // path can reconstruct activeSkillRef on next open without waiting
          // for the turns API to echo it back.
          skill_context: skillContext ?? undefined,
        },
      ]);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `请求失败（${err.status}）`
          : err instanceof Error
            ? err.message
            : '请求失败';
      setError(message);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, []);

  const retry = useCallback(() => {
    const last = lastUserMessageRef.current;
    if (last) void send(last);
  }, [send]);

  // AF S4 / YUK-203 U6 — corrective accept-chip writer. A corrective chip click
  // on an ask_check turn posts an AcceptSuggestionChip to the accept-chip
  // endpoint with the COPILOT session id (single-session, §4.2) so it routes
  // through the chip-accept KPI exclusion (§5.2). It is NOT a chat turn.
  //
  // PR #305 fixes:
  //   • chipPending — in-flight lock (set on click, cleared on settle) so
  //     double-clicks within the network round-trip cannot write duplicate events.
  //   • source_event_id — the reply_event_id from this specific AI message turn
  //     is forwarded to the accept-chip POST body as an optional precise anchor
  //     for the server resolver; if absent the resolver falls back to its
  //     existing heuristic (backward-compatible).
  const [chipAcked, setChipAcked] = useState<string | null>(null);
  const [chipPending, setChipPending] = useState<string | null>(null);
  const acceptCorrectiveChip = useCallback(
    async (sessionId: string, questionId: string, replyEventId?: string) => {
      setChipPending(questionId);
      try {
        await apiJson<{ ok: boolean; event_id: string }>(
          `/api/teaching-sessions/${sessionId}/accept-chip`,
          {
            method: 'POST',
            body: JSON.stringify({
              suggestion_kind: 'corrective',
              chip_label: '重做 / 回看前置',
              ...(replyEventId ? { source_event_id: replyEventId } : {}),
            }),
          },
        );
        setChipAcked(questionId);
        window.setTimeout(() => setChipAcked((cur) => (cur === questionId ? null : cur)), 4000);
      } catch {
        // The chip-accept is a pure KPI signal — a transient failure is silent
        // (no chat turn to retry); clearing pending lets the user click again.
      } finally {
        setChipPending((cur) => (cur === questionId ? null : cur));
      }
    },
    [],
  );

  // AF S4 / YUK-203 U6 — subscribe to the cross-tree open-with-context signal.
  // A button in another subtree (learning-items 「对话教学」) publishes a
  // skill_context; here we adopt it as the active skill, open the Dock, and (if
  // a prefill is given) send the first turn through the skill. `seq` guards
  // against re-processing the same request on re-render.
  const openRequest = useCopilotOpenSignal((s) => s.request);
  const clearRequest = useCopilotOpenSignal((s) => s.clearRequest);
  const lastHandledSeqRef = useRef(0);
  useEffect(() => {
    if (!openRequest) return;
    if (openRequest.seq === lastHandledSeqRef.current) return;
    lastHandledSeqRef.current = openRequest.seq;
    activeSkillRef.current = openRequest.skill_context;
    openDrawer();
    const prefill = openRequest.prefill;
    clearRequest();
    if (prefill) void send(prefill);
  }, [openRequest, openDrawer, clearRequest, send]);

  const summary = summaryQ.data ? (
    // 4-slot order per Wave 5 ready-to-launch lock §Human decision points:
    // Coach focus → review_due → brief → dreaming → footer.
    <div className="flex flex-col gap-[6px]">
      <div className="flex items-center gap-[8px] mb-[2px]">
        <LoomBadge tone="good" dot pulse>
          在线
        </LoomBadge>
      </div>
      <p className="text-[13px] text-[var(--ink)] leading-[1.55]">{summaryQ.data.daily_focus}</p>
      {summaryQ.data.review_due_count > 0 ? (
        <p className="text-[12.5px] text-[var(--ink-2)]" data-testid="copilot-summary-review-due">
          今日待复习 <strong>{summaryQ.data.review_due_count}</strong> 题
        </p>
      ) : null}
      {summaryQ.data.brief_global_md ? (
        <p
          className="text-[12px] text-[var(--ink-3)] italic leading-[1.5]"
          data-testid="copilot-summary-brief-global"
        >
          {summaryQ.data.brief_global_md}
        </p>
      ) : null}
      {summaryQ.data.dreaming_preview.length > 0 ? (
        <ul className="list-disc list-inside text-[12.5px] text-[var(--ink-2)]">
          {summaryQ.data.dreaming_preview.map((row) => (
            <li key={row.proposal_id}>
              <span className="font-mono text-[var(--ink-3)]">{row.kind}</span> {row.brief}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-[11.5px] text-[var(--ink-3)]">
        共 {summaryQ.data.pending_proposals_total} 条 pending 提案
        {summaryQ.data.coach_last_run_at
          ? ` · Coach ${new Date(summaryQ.data.coach_last_run_at).toLocaleString()}`
          : ''}
      </p>
    </div>
  ) : summaryQ.isLoading ? (
    <p className="text-[12.5px] text-[var(--ink-3)]">加载摘要…</p>
  ) : (
    <p className="text-[12.5px] text-[var(--ink-3)]">摘要暂不可用。</p>
  );

  const footer = (
    <div className="copilot-loom">
      <div className="chat-chips">
        {QUICK_CHIPS.map((chip) => (
          <button
            key={chip}
            type="button"
            className="chip"
            disabled={sending}
            onClick={() => void send(chip)}
          >
            {chip}
          </button>
        ))}
      </div>
      <div className="composer">
        <textarea
          rows={1}
          value={input}
          placeholder="问 Loom 任何事…"
          data-testid="copilot-composer-input"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // isComposing guard: Enter during IME composition (中文选词确认)
            // must not submit.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <Btn
          variant="primary"
          size="sm"
          icon="send"
          aria-label="发送"
          data-testid="copilot-composer-send"
          disabled={sending || input.trim().length === 0}
          onClick={() => void send(input)}
        />
      </div>
    </div>
  );

  return (
    <>
      <Button
        variant="quiet"
        size="sm"
        onClick={openDrawer}
        data-testid="copilot-drawer-trigger"
        icon="bot"
      >
        召唤 Copilot
      </Button>
      <CopilotDrawer
        open={open}
        onClose={closeDrawer}
        title="Copilot"
        summary={summary}
        footer={footer}
      >
        <div className="copilot-loom" data-testid="copilot-chat">
          <div className="chat-stream" ref={streamRef}>
            {messages.length === 0 && !sending ? (
              <p className="chat-empty">
                问 Loom 任何事 —— 它会读你的错题、知识图谱与今日计划来回答。
              </p>
            ) : null}
            {messages.map((m) => (
              <div key={m.id} className={`msg msg-${m.role}`} data-testid={`copilot-msg-${m.role}`}>
                <div className="msg-avatar">
                  {m.role === 'ai' ? <LoomIcon name="sparkle" size={14} /> : '知'}
                </div>
                <div className="msg-body">
                  <div className="msg-name">{m.role === 'ai' ? 'Loom Copilot' : '我'}</div>
                  {/* MathMarkdown inherits react-markdown's built-in XSS safety
                      (no raw HTML by default). notation=undefined → no KaTeX;
                      GFM bold/italic/code/lists render correctly. Copilot
                      replies have no subject-profile context so latex gating
                      is deliberately off (matches free-form path intention). */}
                  <MathMarkdown className="msg-text">{m.text}</MathMarkdown>
                  {/* AF S4 / YUK-203 U6 — teaching skill turn carrier. explain is
                      already covered by msg-text above; ask_check renders the
                      materialized question + a corrective accept-chip; end shows a
                      close-out notice. Reuses the Dock chat tokens — no new visual
                      system (§5.1). */}
                  {m.skill_turn?.kind === 'ask_check' && m.skill_turn.structured_question ? (
                    <div className="skill-turn-check" data-testid="copilot-skill-ask-check">
                      <MathMarkdown className="skill-turn-q-prompt">
                        {m.skill_turn.structured_question.prompt_md}
                      </MathMarkdown>
                      {m.skill_turn.structured_question.choices_md &&
                      m.skill_turn.structured_question.choices_md.length > 0 ? (
                        <ol className="skill-turn-q-choices">
                          {m.skill_turn.structured_question.choices_md.map((choice, i) => (
                            <li key={`${m.skill_turn?.structured_question?.id}-${i}`}>
                              <MathMarkdown>{choice}</MathMarkdown>
                            </li>
                          ))}
                        </ol>
                      ) : null}
                      {m.session_id ? (
                        <button
                          type="button"
                          className="chip is-corrective"
                          data-testid="copilot-corrective-chip"
                          // Disabled while in-flight (pending) or already acked —
                          // prevents duplicate AcceptSuggestionChip KPI events.
                          disabled={
                            chipPending === m.skill_turn.structured_question.id ||
                            chipAcked === m.skill_turn.structured_question.id
                          }
                          onClick={() => {
                            const sid = m.session_id;
                            const qid = m.skill_turn?.structured_question?.id;
                            if (sid && qid) void acceptCorrectiveChip(sid, qid, m.reply_event_id);
                          }}
                        >
                          重做 / 回看前置
                        </button>
                      ) : null}
                      {chipAcked === m.skill_turn.structured_question.id ? (
                        <output className="skill-turn-ack">已记录（不计入接受率）</output>
                      ) : null}
                    </div>
                  ) : null}
                  {m.skill_turn?.kind === 'end' ? (
                    <div className="skill-turn-end" data-testid="copilot-skill-end">
                      本轮教学已结束，继续提问将回到自由对话。
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
            {sending ? (
              <div className="msg msg-ai" data-testid="copilot-thinking">
                <div className="msg-avatar">
                  <LoomIcon name="sparkle" size={14} />
                </div>
                <div className="msg-body">
                  <div className="msg-name">Loom Copilot</div>
                  <div className="chat-thinking">
                    <LoomIcon name="refresh" size={13} className="spin" />
                    思考中…
                  </div>
                </div>
              </div>
            ) : null}
            {error ? (
              <div className="chat-error" data-testid="copilot-error" role="alert">
                <LoomIcon name="alert" size={14} />
                <span>{error}</span>
                <Btn variant="ghost" size="sm" icon="refresh" onClick={retry}>
                  重试
                </Btn>
              </div>
            ) : null}
          </div>
        </div>
      </CopilotDrawer>
    </>
  );
}
