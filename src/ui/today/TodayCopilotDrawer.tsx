// AF Slice 0 / YUK-169 — /today Copilot drawer with live chat.
//
// Mounts <CopilotDrawer> with three regions:
//   • summary  — /api/today/copilot-summary (Coach + Dreaming digest), preserved
//                verbatim from the prior placeholder build.
//   • chat     — in-memory message list + real request to the existing,
//                NON-STREAMING POST /api/copilot/chat (returns one final reply).
//   • footer   — quick-chips + composer (Enter to send, Shift+Enter newline).
//
// Contract notes (see docs/design/2026-06-04-redraw-composer-preflight.md):
//   • The endpoint is non-streaming (Response.json) — we render a real
//     "thinking" in-flight bubble, then the final reply. No fake typewriter.
//   • The route does NOT return tool-call details (RunTaskResult is text-only),
//     so tool-use cards are phase-deferred (no mock fixtures in production).
//   • No session persistence / rolling summary — that is AF Slice 3. Messages
//     live in component memory for this session only.
//   • Token never touches the client: requests go through apiJson, which adds
//     the x-internal-token header; the Anthropic key stays server-side.

'use client';

import { ApiError, apiJson } from '@/ui/lib/api';
import { useCopilotDwell } from '@/ui/lib/use-copilot-dwell';
import { Btn } from '@/ui/primitives/Btn';
import { Button } from '@/ui/primitives/Button';
import { CopilotDrawer } from '@/ui/primitives/CopilotDrawer';
import { LoomBadge } from '@/ui/primitives/LoomBadge';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

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

// POST /api/copilot/chat response shape — see src/server/copilot/chat.ts
// (CopilotChatResult). `reply` is the complete final text (non-streaming).
interface CopilotChatResponse {
  task_run_id: string;
  reply: string;
  surface: string;
  triggered_by: string;
  user_ask_event_id?: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  text: string;
}

// Quick-chips are user-readable prompts; they send via triggered_by:'chat'
// (the 'chip' surface is a different mistake-action allowlist — see chat.ts
// COPILOT_CHAT_TRIGGER_KINDS — and is NOT what these prefilled prompts mean).
const QUICK_CHIPS = ['今天该复习哪些？', '解释「之」的用法'] as const;

function nextId(): string {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function TodayCopilotDrawer() {
  const { open, openDrawer, closeDrawer } = useCopilotDwell();
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
  // Holds the last user_message so the error-state "重试" button can resend it.
  const lastUserMessageRef = useRef<string | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll the message stream to the bottom on new messages / loading.
  // `sending` is an intentional trigger dep: when it flips true the thinking
  // bubble mounts and we want to scroll to it, even though the effect body
  // only reads the ref.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sending drives the scroll-to-thinking-bubble
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || sending) return;
      lastUserMessageRef.current = text;
      setError(null);
      setInput('');
      setMessages((prev) => [...prev, { id: nextId(), role: 'user', text }]);
      setSending(true);
      try {
        const res = await apiJson<CopilotChatResponse>('/api/copilot/chat', {
          method: 'POST',
          body: JSON.stringify({ user_message: text, triggered_by: 'chat' }),
        });
        setMessages((prev) => [...prev, { id: nextId(), role: 'ai', text: res.reply }]);
      } catch (err) {
        const message =
          err instanceof ApiError
            ? `请求失败（${err.status}）`
            : err instanceof Error
              ? err.message
              : '请求失败';
        setError(message);
      } finally {
        setSending(false);
      }
    },
    [sending],
  );

  const retry = useCallback(() => {
    const last = lastUserMessageRef.current;
    if (last) void send(last);
  }, [send]);

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
            if (e.key === 'Enter' && !e.shiftKey) {
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
        title="Copilot · 今日"
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
                  <div className="msg-text">{m.text}</div>
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
