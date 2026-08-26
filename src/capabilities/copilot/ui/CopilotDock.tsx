// AF Slice 0 / YUK-169 — global Copilot drawer with live chat.
// AF S2a / S3a (YUK-203 U3) — moved out of today/ (CopilotDock, global not
// Today-scoped) + session persistence with replay-last-N.
//
// Mounts <CopilotDrawer> with three regions:
//   • summary  — /api/today/copilot-summary (Coach + Dreaming digest), preserved
//                verbatim. The route stays Today-scoped (the data genuinely IS
//                today's), so the "今日摘要"-style copy in this slot is correct.
//   • chat     — message list + real request to the streaming POST
//                /api/copilot/chat (YUK-266 C1: SSE delta events then a terminal
//                reply event). On open, the list is prefilled from GET
//                /api/copilot/turns (replay-last-N) so the conversation is
//                continuous across drawer reopens / reloads.
//   • footer   — quick-chips + composer (Enter to send, Shift+Enter newline).
//
// Contract notes (see docs/design/2026-06-04-redraw-composer-preflight.md +
// docs/design/2026-06-04-l-copilot-preflight.md):
//   • The endpoint streams over SSE (YUK-266 C1) — a "thinking" bubble covers the
//     pre-first-byte gap, then deltas render incrementally into a live bubble with
//     a typing caret, and the terminal reply event is the authoritative text.
//   • The route never returns child transcript/reasoning. It may expose only the
//     structural public subtask lifecycle used by the progress cards below.
//   • Turn persistence + replay-last-N is AF Slice 3a. Rolling summary is S3b
//     (deferred, NOT built here).
//   • Token never touches the client: requests go through apiJson, which adds
//     the x-internal-token header; the Anthropic key stays server-side.
//   • Replay is best-effort: a turns-fetch failure degrades to the prior
//     in-memory-only behaviour (no error surfaced for the prefill path).

'use client';

import { useQuery } from '@tanstack/react-query';
import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CopilotSkillContextT } from '@/capabilities/copilot/server/chat';
import { ApiError, apiFetch, apiJson } from '@/ui/lib/api';
import {
  DeferredMarkdownRenderer,
  preloadMarkdownRenderer,
} from '@/ui/lib/deferred-markdown-renderer';
import {
  openCopilotForNudge,
  useCopilotDwell,
  useCopilotOpenSignal,
} from '@/ui/lib/use-copilot-dwell';
import { Btn } from '@/ui/primitives/Btn';
import { Button } from '@/ui/primitives/Button';
import { CopilotDrawer } from '@/ui/primitives/CopilotDrawer';
import { IconBtn } from '@/ui/primitives/IconBtn';
import { LoomBadge } from '@/ui/primitives/LoomBadge';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import { ToolUseCard } from '@/ui/primitives/ToolUseCard';
import { CopilotHeroCard } from './CopilotHeroCard';
import { type CopilotSessionListItem, CopilotSessionPanel } from './CopilotSessionPanel';
import {
  type PersistedDurableCopilotReconnect,
  type PersistedPendingCopilotRequestBody,
  type PersistedPendingCopilotTurn,
  clearPersistedDurableCopilotReconnect,
  clearPersistedPendingCopilotTurn,
  discardPersistedPendingCopilotTurn,
  durableRunIdFromLocation,
  loadPersistedDurableCopilotReconnect,
  loadPersistedPendingCopilotTurn,
  persistDurableCopilotReconnect,
  persistPendingCopilotTurn,
} from './durable-reconnect-storage';
import { learnerGlobalBrief } from './learner-global-brief';
import { nextNudgeSessionAfterTurn, resolveTurnAmbientFocus } from './nudge-focus';
import { type ReplayPrimaryView, type ReplayTurn, replayToMessages } from './replay';
import { isOneShotSkill } from './skill-lifecycle';
import {
  type CopilotRunView,
  type CopilotSubtaskView,
  DurablePickupStalledError,
  consumeDurableCopilotRun,
  createCopilotRunView,
  foldCopilotRunFrames,
  parseCopilotSseStream,
  parseInlineSubtaskEvent,
  subtaskEventToFrame,
} from './subtask-events';
import { useCopilotNudges } from './useCopilotNudges';

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

function durableReconnectErrorMessage(error: unknown): string {
  return error instanceof DurablePickupStalledError
    ? '后台任务还在等待开始，可能正在排队；本次任务已保留，可以稍后重新连接。'
    : '后台进度连接仍未恢复；任务可能仍在运行，可以再次连接。';
}

// AF S4 / YUK-203 U6 — UI-side mirror of the server CopilotSkillTurn carrier
// (src/capabilities/copilot/server/chat.ts). Set only when a teaching/solve skill ran a
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

// POST /api/copilot/chat response shape — see src/capabilities/copilot/server/chat.ts
// (CopilotChatResult). `reply` is the complete final text (non-streaming).
interface CopilotChatResponse {
  task_run_id: string;
  reply: string;
  surface: string;
  triggered_by: string;
  session_id: string;
  reply_event_id: string;
  checkpoint_event_id?: string;
  user_ask_event_id?: string;
  // AF S4 / YUK-203 U6 — additive optional structured-turn carrier.
  skill_turn?: SkillTurn;
  // YUK-266 (C1) — set only when the SSE stream errored mid-flight but partial
  // text was still persisted (graceful degrade). The Dock keeps the partial reply
  // and surfaces its existing error affordance.
  error?: string;
  // YUK-307 (presentation layer §2.3) — the agent's per-reply hero nomination,
  // carried verbatim on the terminal `reply` SSE event (chat.ts sets
  // CopilotChatResult.primary_view). Absent = no hero (the common case).
  primary_view?: ReplayPrimaryView;
}

interface DurableCopilotReconnect extends PersistedDurableCopilotReconnect {
  /** Last safely folded cursor/view, so a manual retry resumes rather than replays from zero. */
  view: CopilotRunView;
}

type CopilotProgressStage = 'dispatch' | 'generation' | 'evidence-review';

const COPILOT_PROGRESS_LABELS: Record<CopilotProgressStage, string> = {
  dispatch: '调度中…',
  generation: '生成中…',
  'evidence-review': '证据审阅中…',
};

function progressStageForLabel(label: string): CopilotProgressStage {
  return /证据|审阅|审查|核对|验证|校验|review|evidence|audit|validat/i.test(label)
    ? 'evidence-review'
    : 'generation';
}

function copilotProgressStage(view: CopilotRunView): CopilotProgressStage {
  if (view.phase === 'queued') return 'dispatch';

  const latestStep = [...view.frames]
    .reverse()
    .find((frame) => frame.event_type === 'copilot_run.step');
  const latestLabel = latestStep?.payload.label;
  if (typeof latestLabel === 'string' && latestLabel.length > 0) {
    return progressStageForLabel(latestLabel);
  }

  const latestSubtask = view.subtasks.at(-1);
  return latestSubtask ? progressStageForLabel(latestSubtask.label) : 'generation';
}

// GET /api/copilot/turns response shape — see src/capabilities/copilot/server/turns.ts.
interface CopilotTurnsResponse {
  turns: ReplayTurn[];
}

interface CopilotSessionResponse {
  id: string;
  status: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

interface CopilotSessionsResponse {
  sessions: CopilotSessionResponse[];
}

interface CopilotCreateSessionResponse {
  session: CopilotSessionResponse;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'ai' | 'tombstone';
  text: string;
  checkpoint_event_id?: string;
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
  // YUK-266 (C1) — true while SSE deltas are still flowing into this AI message;
  // drives the typing caret affordance. Cleared on the terminal `reply` event.
  streaming?: boolean;
  // YUK-307 (presentation layer §2.5) — the agent's hero nomination for this AI
  // turn, rendered below the reply text by CopilotHeroCard. Forwarded from the
  // terminal reply event (live) or replayToMessages (reopen). Absent = no hero.
  primary_view?: ReplayPrimaryView;
  // YUK-757 — public child lifecycle only. The raw nested-agent transcript,
  // prompt and reasoning never enter ChatMessage.
  subtasks?: CopilotSubtaskView[];
  // YUK-457 — per-call tool-use records from live SSE and replay prefill.
  // Appended on `tool_use`, enriched on `tool_result`, preserved on the terminal
  // `reply` event so the full call log stays on the AI turn after finalize.
  tool_calls?: ToolCallRecord[];
}

/** YUK-457 — a single tool-use record (live stream or replay). */
export interface ToolCallRecord {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  summary?: string;
  status?: 'running' | 'done' | 'failed';
  errorReason?: string;
}

const LEARNER_TOOL_LABELS: Readonly<Record<string, string>> = {
  query_mistakes: '错题整理',
  get_review_due: '复习安排',
  knowledge_mutation: '学习内容建议',
};

function learnerToolLabel(toolName: string): string {
  return LEARNER_TOOL_LABELS[toolName] ?? '学习辅助任务';
}

type ToolCallCardStatus = 'running' | 'done' | 'failed';

function toolCallCardStatus(call: ToolCallRecord): ToolCallCardStatus {
  if (call.status === 'failed') return 'failed';
  if (call.status === 'running') return 'running';
  return 'done';
}

/**
 * YUK-913 — the streaming runner emits raw SDK block names (`mcp__<server>__<tool>`)
 * on tool_use, while tool_result frames and replay mirrors carry the DOMAIN tool
 * name. Normalize at the parse boundary so one logical call correlates across
 * the live + replay lanes (and `LEARNER_TOOL_LABELS` resolves on both).
 */
function normalizeToolName(name: string): string {
  const match = /^mcp__[a-z0-9_-]+__(.+)$/i.exec(name);
  return match ? match[1] : name;
}

function parseToolUseSse(data: string): ToolCallRecord | null {
  try {
    const raw = JSON.parse(data) as {
      toolName?: unknown;
      input?: unknown;
      toolUseId?: unknown;
    };
    if (typeof raw.toolName !== 'string') return null;
    return {
      toolName: normalizeToolName(raw.toolName),
      input:
        raw.input !== null && typeof raw.input === 'object' && !Array.isArray(raw.input)
          ? (raw.input as Record<string, unknown>)
          : {},
      ...(typeof raw.toolUseId === 'string' ? { toolUseId: raw.toolUseId } : {}),
      status: 'running',
    };
  } catch {
    return null;
  }
}

function parseToolResultSse(data: string): ToolCallRecord | null {
  try {
    const raw = JSON.parse(data) as {
      toolName?: unknown;
      input?: unknown;
      summary?: unknown;
      errorReason?: unknown;
      toolUseId?: unknown;
    };
    if (typeof raw.toolName !== 'string') return null;
    const summary = typeof raw.summary === 'string' ? raw.summary : undefined;
    const errorReason =
      typeof raw.errorReason === 'string' && raw.errorReason.length > 0
        ? raw.errorReason
        : undefined;
    return {
      toolName: normalizeToolName(raw.toolName),
      input:
        raw.input !== null && typeof raw.input === 'object' && !Array.isArray(raw.input)
          ? (raw.input as Record<string, unknown>)
          : {},
      ...(typeof raw.toolUseId === 'string' ? { toolUseId: raw.toolUseId } : {}),
      ...(summary ? { summary } : {}),
      ...(errorReason ? { errorReason } : {}),
      status: errorReason ? 'failed' : 'done',
    };
  } catch {
    return null;
  }
}

/**
 * YUK-913 — fold a tool_use frame into the call list WITHOUT ever creating a
 * second card for one logical call: an id-carrying duplicate frame (same
 * toolUseId) is a no-op; an id-less duplicate while the same tool is already
 * running is treated as the same call (a second 调用中 card would strand
 * forever). A genuinely new call — distinct toolUseId, or no running same-name
 * card — appends.
 */
function mergeToolUseEvent(calls: ToolCallRecord[], call: ToolCallRecord): ToolCallRecord[] {
  if (call.toolUseId !== undefined && calls.some((c) => c.toolUseId === call.toolUseId)) {
    return calls;
  }
  if (
    call.toolUseId === undefined &&
    calls.some((c) => c.toolName === call.toolName && c.status === 'running')
  ) {
    return calls;
  }
  return [...calls, call];
}

/**
 * YUK-913 — resolve ONE running call IN PLACE (never append beside it): prefer
 * the stable toolUseId correlation; an id-less result (the current wire
 * contract) resolves the OLDEST running call of the same normalized tool name
 * (serial execution order). With no running match, the result still lands as
 * its own single terminal card (result-before-call / lost tool_use frame).
 */
function applyToolResult(calls: ToolCallRecord[], result: ToolCallRecord): ToolCallRecord[] {
  const idx = calls.findIndex(
    (call) =>
      call.status === 'running' &&
      (result.toolUseId !== undefined
        ? call.toolUseId === result.toolUseId
        : call.toolName === result.toolName),
  );
  if (idx === -1) {
    return [...calls, result];
  }
  const next = [...calls];
  next[idx] = { ...next[idx], ...result };
  return next;
}

// YUK-913 — one COMPRESSED card per tool call: a single-line row (label +
// status pill + one-line summary) whose state evolves IN PLACE 谓用中 → 已完成/失败,
// with the full detail collapsed behind the row itself. Replaces the previous
// two-band rich card (header band + result band) that read as a large block.
const TOOL_ROW_PILL: Record<'running' | 'done' | 'failed', string> = {
  running: '调用中',
  done: '已完成',
  failed: '失败',
};

function toolRowIcon(status: 'running' | 'done' | 'failed'): LoomIconName {
  if (status === 'running') return 'refresh';
  if (status === 'failed') return 'alert';
  return 'check';
}

function CopilotToolCallRow({ call }: { call: ToolCallRecord }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const status = toolCallCardStatus(call);
  const label = learnerToolLabel(call.toolName);
  // Learner-facing one-line copy: done → the tool's summary (when the server
  // sent one); failed → the fixed retry sentence (internal errorReason never
  // renders — see the leak test); running → nothing beyond the pill.
  const lineText =
    status === 'failed'
      ? `${label}暂时未完成，请稍后再试。`
      : status === 'done' && call.summary
        ? call.summary
        : undefined;
  const lineContent = (
    <>
      <LoomIcon
        name={toolRowIcon(status)}
        size={13}
        className={status === 'running' ? 'spin' : ''}
      />
      <span className="copilot-tool-name">{label}</span>
      <span className={`tuc-pill is-${status}`} data-testid="copilot-tool-use-status">
        {TOOL_ROW_PILL[status]}
      </span>
      {lineText ? <span className="copilot-tool-summary">{lineText}</span> : null}
    </>
  );
  return (
    <div
      className="copilot-tool-row"
      data-testid="copilot-tool-use-card"
      data-status={status}
      aria-live="polite"
    >
      {lineText ? (
        <button
          type="button"
          className="copilot-tool-line"
          data-testid="copilot-tool-use-toggle"
          aria-expanded={expanded}
          aria-controls={detailId}
          aria-label={expanded ? `收起${label}详情` : `展开${label}详情`}
          onClick={() => setExpanded((open) => !open)}
        >
          {lineContent}
        </button>
      ) : (
        <div className="copilot-tool-line is-static">{lineContent}</div>
      )}
      {expanded && lineText ? (
        <div className="copilot-tool-detail" id={detailId} data-testid="copilot-tool-use-detail">
          {lineText}
        </div>
      ) : null}
    </div>
  );
}

function CopilotToolUseList({ calls }: { calls: ToolCallRecord[] }) {
  return (
    <div className="copilot-tool-list" data-testid="copilot-tool-use-list">
      {calls.map((call, idx) => (
        <CopilotToolCallRow key={call.toolUseId ?? `${call.toolName}-${idx}`} call={call} />
      ))}
    </div>
  );
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

export interface CopilotDockProps {
  /** M5-T3 (YUK-321) — current route, forwarded to ambient_context.route (C2). */
  pathname: string;
  /** M5-T3 (YUK-321) — route push, forwarded to CopilotHeroCard for hero href jumps. */
  navigate: (to: string) => void;
  /** Keep the visible shell launcher in sync with pending proactive nudges. */
  onNudgeCountChange?: (count: number) => void;
}

interface MessageRowProps {
  message: ChatMessage;
  navigate: (to: string) => void;
  onAcceptCorrective: (sessionId: string, questionId: string, replyEventId?: string) => void;
  onSelectCorrection?: (turnId: string, turnNumber: number) => void;
  correctionTurnNumber?: number;
  correctionSelected?: boolean;
  onRevert?: (checkpointEventId: string) => void;
  // Per-row (not global) chip flags so a corrective-chip click on ONE message
  // does not re-render every other row: only the matching row sees its flag flip.
  chipPending: boolean;
  chipAcked: boolean;
  // Per-row in-flight flag for THIS message's revert POST (mirrors chipPending) so a
  // second click cannot fire a duplicate revert while the first is still in flight.
  revertPending: boolean;
}

// YUK-715 — one chat row, memoized so an SSE delta (which rebuilds only the
// growing message object and leaves every other message referentially unchanged)
// does not re-run the static rows' ReactMarkdown parse. Default shallow prop
// comparison is the honest render-input check here: `setMessages` map updates
// preserve the reference of unchanged messages, `navigate`/`onAcceptCorrective`
// are stable, and the chip flags are per-row booleans — so an unchanged row's
// props are all reference-equal and it skips re-rendering.
export const MessageRow = memo(function MessageRow({
  message: m,
  navigate,
  onAcceptCorrective,
  onSelectCorrection,
  correctionTurnNumber,
  correctionSelected = false,
  onRevert,
  chipPending,
  chipAcked,
  revertPending,
}: MessageRowProps) {
  const correctionTurnId = m.role === 'ai' ? m.reply_event_id : undefined;
  return (
    <div
      className={`msg msg-${m.role}${m.streaming ? ' is-streaming' : ''}`}
      data-testid={`copilot-msg-${m.role}`}
    >
      {m.role === 'tombstone' ? null : (
        <div className="msg-avatar">
          {m.role === 'ai' ? <LoomIcon name="sparkle" size={14} /> : '知'}
        </div>
      )}
      <div className="msg-body">
        {m.role === 'tombstone' ? null : (
          <div className="msg-name">{m.role === 'ai' ? '编排者' : '我'}</div>
        )}
        {/* YUK-457 / YUK-913 — compact tool-call rows sit between the user ask
            and the assistant reply (design stack order). Replay + live SSE both
            feed tool_calls; ONE row per logical call, state evolving in place. */}
        {m.role === 'ai' && m.tool_calls && m.tool_calls.length > 0 ? (
          <CopilotToolUseList calls={m.tool_calls} />
        ) : null}
        {/* The Markdown parser is warmed only when the drawer opens. Until
            its chunk arrives, DeferredMarkdownRenderer keeps escaped plain
            text visible instead of blanking or crashing the conversation.
            Copilot has no subject profile, so dollar syntax stays plain. */}
        <DeferredMarkdownRenderer className="msg-text">{m.text}</DeferredMarkdownRenderer>
        {correctionTurnId &&
        correctionTurnNumber !== undefined &&
        !m.streaming &&
        onSelectCorrection ? (
          <button
            type="button"
            className={`chip${correctionSelected ? ' is-corrective' : ''}`}
            aria-pressed={correctionSelected}
            onClick={() => onSelectCorrection(correctionTurnId, correctionTurnNumber)}
          >
            更正这轮
          </button>
        ) : null}
        {m.role === 'ai' && m.checkpoint_event_id && !m.streaming && onRevert ? (
          <button
            type="button"
            className="chip"
            data-testid="copilot-revert-button"
            // Disabled while THIS row's revert POST is in flight — prevents a duplicate
            // revert (mirrors the corrective chip's disabled={chipPending || chipAcked}).
            disabled={revertPending}
            onClick={() => {
              if (m.checkpoint_event_id) onRevert(m.checkpoint_event_id);
            }}
          >
            {revertPending ? '撤回中…' : '撤回本轮更改'}
          </button>
        ) : null}
        {m.streaming ? (
          <span className="chat-caret" data-testid="copilot-msg-streaming" aria-hidden="true">
            ▍
          </span>
        ) : null}
        {/* AF S4 / YUK-203 U6 — teaching skill turn carrier. explain is
            already covered by msg-text above; ask_check renders the
            materialized question + a corrective accept-chip; end shows a
            close-out notice. Reuses the Dock chat tokens — no new visual
            system (§5.1). */}
        {m.skill_turn?.kind === 'ask_check' && m.skill_turn.structured_question ? (
          <div className="skill-turn-check" data-testid="copilot-skill-ask-check">
            <DeferredMarkdownRenderer className="skill-turn-q-prompt">
              {m.skill_turn.structured_question.prompt_md}
            </DeferredMarkdownRenderer>
            {m.skill_turn.structured_question.choices_md &&
            m.skill_turn.structured_question.choices_md.length > 0 ? (
              <ol className="skill-turn-q-choices">
                {m.skill_turn.structured_question.choices_md.map((choice) => (
                  <li key={`${m.skill_turn?.structured_question?.id}-${choice}`}>
                    <DeferredMarkdownRenderer>{choice}</DeferredMarkdownRenderer>
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
                disabled={chipPending || chipAcked}
                onClick={() => {
                  const sid = m.session_id;
                  const qid = m.skill_turn?.structured_question?.id;
                  if (sid && qid) void onAcceptCorrective(sid, qid, m.reply_event_id);
                }}
              >
                重做 / 回看前置
              </button>
            ) : null}
            {chipAcked ? <output className="skill-turn-ack">已记录（不计入接受率）</output> : null}
          </div>
        ) : null}
        {m.skill_turn?.kind === 'end' ? (
          <div className="skill-turn-end" data-testid="copilot-skill-end">
            本轮教学已结束，继续提问将回到自由对话。
          </div>
        ) : null}
        {/* YUK-307 (presentation layer §2.5) — the agent's hero
            nomination for this turn, below the reply text. Only AI
            turns carry one; absent ⇒ nothing rendered (the common
            case). T5 ribbon dosage: no technical ribbon on a hero. */}
        {m.role === 'ai' && m.primary_view ? (
          <CopilotHeroCard primaryView={m.primary_view} navigate={navigate} />
        ) : null}
        {m.role === 'ai' && m.subtasks && m.subtasks.length > 0 ? (
          <div className="flex flex-col gap-[6px]" data-testid="copilot-subtask-list">
            {m.subtasks.map((subtask) => (
              <div key={subtask.id} data-testid="copilot-subtask-card">
                <ToolUseCard
                  toolName="后台子任务"
                  summary={subtask.label}
                  actor={null}
                  status={
                    subtask.status === 'completed'
                      ? 'done'
                      : subtask.status === 'failed'
                        ? 'failed'
                        : 'running'
                  }
                  running={<span>正在处理…</span>}
                  result={subtask.summary ? <span>{subtask.summary}</span> : <span>已完成</span>}
                  errorView={<span>{subtask.error ?? '这项子任务未能完成。'}</span>}
                />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
});

export function CopilotDock({ pathname, navigate, onNudgeCountChange }: CopilotDockProps) {
  // YUK-577 — proactive-nudge state. A pending nudge is rendered as a badge/bar; the drawer itself
  // opens only after the user clicks it. The legacy blind dwell/revisit auto-open path is gone.
  const {
    nudges,
    dismiss: dismissNudge,
    markOpened,
    isMutating: nudgeMutating,
  } = useCopilotNudges();
  useEffect(() => {
    onNudgeCountChange?.(nudges.length);
  }, [nudges.length, onNudgeCountChange]);
  const { open, openDrawer, closeDrawer: closeDrawerDwell } = useCopilotDwell();
  const prepareAndOpenDrawer = useCallback(() => {
    preloadMarkdownRenderer();
    openDrawer();
  }, [openDrawer]);
  const summaryQ = useQuery({
    queryKey: ['copilot-summary'],
    queryFn: () => apiJson<CopilotSummary>('/api/today/copilot-summary'),
    enabled: open,
    refetchInterval: open ? 60_000 : false,
  });
  const sessionsQ = useQuery({
    queryKey: ['copilot-sessions'],
    queryFn: () => apiJson<CopilotSessionsResponse>('/api/copilot/sessions'),
    enabled: open,
  });

  const [restoredDurableHandle] = useState<DurableCopilotReconnect | null>(() => {
    const persisted = loadPersistedDurableCopilotReconnect();
    return persisted ? { ...persisted, view: createCopilotRunView() } : null;
  });
  const [restoredPendingTurn] = useState<PersistedPendingCopilotTurn | null>(() => {
    if (restoredDurableHandle) {
      // The accepted Location is strictly stronger than a pre-acceptance
      // handoff. Never revive an older uncertain POST beside a durable run.
      discardPersistedPendingCopilotTurn();
      return null;
    }
    return loadPersistedPendingCopilotTurn();
  });
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    restoredDurableHandle
      ? [
          {
            id: restoredDurableHandle.userMessageId,
            role: 'user',
            text: restoredDurableHandle.userMessage,
          },
          {
            id: restoredDurableHandle.aiMessageId,
            role: 'ai',
            text: '正在重新连接这次已受理的后台任务；不会重复提交。',
            streaming: true,
          },
        ]
      : [],
  );
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(
    restoredDurableHandle?.sessionId ?? restoredPendingTurn?.requestBody.session_id ?? null,
  );
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;
  const [sessionPanelOpen, setSessionPanelOpen] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [optimisticSession, setOptimisticSession] = useState<CopilotSessionResponse | null>(() => {
    const recoverySessionId =
      restoredDurableHandle?.sessionId ?? restoredPendingTurn?.requestBody.session_id;
    if (!recoverySessionId) return null;
    const recoveredAt = new Date().toISOString();
    return {
      id: recoverySessionId,
      status: 'active',
      title: '正在恢复的对话',
      created_at: recoveredAt,
      updated_at: recoveredAt,
    };
  });
  const [sending, setSending] = useState(restoredDurableHandle !== null);
  const [durableRunning, setDurableRunning] = useState(restoredDurableHandle !== null);
  const [progressStage, setProgressStage] = useState<CopilotProgressStage | null>(
    restoredDurableHandle ? copilotProgressStage(restoredDurableHandle.view) : null,
  );
  const [stopPending, setStopPending] = useState(false);
  const [awaitingFirstFrame, setAwaitingFirstFrame] = useState(false);
  const [error, setError] = useState<string | null>(() =>
    restoredPendingTurn
      ? '上次请求的受理状态未知：它可能尚未执行，也可能已经完成。请先查看现有结果，再决定是否恢复这次请求。'
      : null,
  );
  const [pendingAcceptanceUnknown, setPendingAcceptanceUnknown] = useState(
    restoredPendingTurn !== null,
  );
  // Per-checkpoint in-flight id for the revert POST (disables that row's button), and a
  // distinct "revert landed but the refresh failed" flag so a post-revert refetch error is
  // never surfaced as a revert failure (F5).
  const [revertPendingId, setRevertPendingId] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  // TchmY — a refetch that was SKIPPED (a send is streaming, so refetchTurns deferred rather than
  // failed) is distinct from a real refetch FAILURE. Same "revert landed, screen not yet refreshed"
  // family, but the skip is not an error — it gets a calmer copy (no alert tone).
  const [refreshSkipped, setRefreshSkipped] = useState(false);
  const [input, setInput] = useState('');
  const [correctionTarget, setCorrectionTarget] = useState<{
    turnId: string;
    turnNumber: number;
  } | null>(null);
  const correctionTargetRef = useRef(correctionTarget);
  correctionTargetRef.current = correctionTarget;
  // YUK-267 (C2) — the current page route, sent as ambient_context.route so the
  // agent can scope its answer to where the user is. Held in a ref + synced each
  // render so `send` stays stable (its deps are []), matching the activeSkillRef
  // pattern. M5-T3 (YUK-321) — pathname is now a prop (no usePathname import;
  // the old-tree mount passes usePathname() and the SPA root shell passes
  // useRouterState().location.pathname).
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  // YUK-272 (C3) — the in-scope knowledge node id, when one exists. The quiz chip
  // needs a real knowledge id to send a meaningful quiz request (ref.id is a
  // knowledge node id per the quiz-skill contract). Sourced from the active skill
  // context when it points at a knowledge entity (set by the open-with-context
  // signal / replay restore). When null, the quiz chip falls back to the normal
  // free-form Copilot path instead of fabricating a ref. State (not a ref) so the
  // chip's visible scope label re-renders when the in-scope entity changes.
  const [focusedKnowledgeId, setFocusedKnowledgeId] = useState<string | null>(null);
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
  // YUK-577 — the ingestion session a nudge 「看看」opened, injected into ambient_context so the
  // user's first reply is context-aware ("about the material I just processed").
  const nudgeSessionRef = useRef<string | null>(null);
  // AF S4 / YUK-203 U6 — wrap closeDrawer to also clear the active skill context
  // so that re-opening the Dock after closing does not resume a stale skill.
  const closeDrawer = useCallback(() => {
    activeSkillRef.current = null;
    nudgeSessionRef.current = null;
    // YUK-272 (C3) — also drop the quiz-chip's in-scope knowledge entity so a
    // re-open does not offer a quiz for a stale knowledge node.
    setFocusedKnowledgeId(null);
    correctionTargetRef.current = null;
    setCorrectionTarget(null);
    closeDrawerDwell();
  }, [closeDrawerDwell]);
  // A logical turn keeps one stable key until it is accepted. If the server
  // committed a durable job but its 202 was lost, manual retry replays this key
  // and recovers the original handle instead of creating a second paid run.
  const lastUserTurnRef = useRef<{
    text: string;
    idempotencyKey: string;
    /** Reuse only while server acceptance is unknown or explicitly ambiguous. */
    retryWithSameKey: boolean;
    userMessageId: string;
    requestBody: PersistedPendingCopilotRequestBody;
  } | null>(
    restoredPendingTurn
      ? {
          text: restoredPendingTurn.userMessage,
          idempotencyKey: restoredPendingTurn.idempotencyKey,
          retryWithSameKey: true,
          userMessageId: restoredPendingTurn.userMessageId,
          requestBody: restoredPendingTurn.requestBody,
        }
      : null,
  );
  // A 202 means the paid durable run already exists. If its progress stream later
  // exhausts automatic reconnects, the error button must resume THIS handle — never
  // POST the user message again and accidentally create a second run.
  const durableReconnectRef = useRef<DurableCopilotReconnect | null>(restoredDurableHandle);
  const restoredReconnectStartedRef = useRef(false);
  const activeTransportAbortRef = useRef<AbortController | null>(null);
  const stoppingRunRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      activeTransportAbortRef.current?.abort();
      activeTransportAbortRef.current = null;
    },
    [],
  );
  // Synchronous single-flight guard: `sending` state lags a re-render behind,
  // so rapid double-Enter could fire duplicate POSTs from the stale closure.
  const sendingRef = useRef(false);
  const streamRef = useRef<HTMLDivElement | null>(null);
  // AF S3a — replay runs once per open; guard so a refetch / re-render does not
  // clobber the live in-memory list with a stale prefill.
  const replayedRef = useRef(false);
  const sessionBootstrapRef = useRef(false);

  const resetRecoveryForSessionChange = useCallback(() => {
    discardPersistedPendingCopilotTurn();
    const reconnect = durableReconnectRef.current;
    if (reconnect) clearPersistedDurableCopilotReconnect(reconnect.runId);
    lastUserTurnRef.current = null;
    durableReconnectRef.current = null;
    setPendingAcceptanceUnknown(false);
    setError(null);
  }, []);

  const createConversation = useCallback(async () => {
    if (creatingSession || sendingRef.current || pendingAcceptanceUnknown) return;
    setCreatingSession(true);
    setError(null);
    try {
      const response = await apiJson<CopilotCreateSessionResponse>('/api/copilot/sessions', {
        method: 'POST',
      });
      resetRecoveryForSessionChange();
      activeSkillRef.current = null;
      setFocusedKnowledgeId(null);
      correctionTargetRef.current = null;
      setCorrectionTarget(null);
      setMessages([]);
      replayedRef.current = false;
      setOptimisticSession(response.session);
      setCurrentSessionId(response.session.id);
      void sessionsQ.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : '新对话创建失败');
    } finally {
      setCreatingSession(false);
    }
  }, [creatingSession, pendingAcceptanceUnknown, resetRecoveryForSessionChange, sessionsQ]);

  const selectConversation = useCallback(
    (sessionId: string) => {
      if (sendingRef.current) return;
      resetRecoveryForSessionChange();
      activeSkillRef.current = null;
      setFocusedKnowledgeId(null);
      correctionTargetRef.current = null;
      setCorrectionTarget(null);
      setMessages([]);
      replayedRef.current = false;
      setOptimisticSession(null);
      setCurrentSessionId(sessionId);
    },
    [resetRecoveryForSessionChange],
  );

  useEffect(() => {
    if (!open || !sessionsQ.data) return;
    const sessions = sessionsQ.data.sessions;
    if (sessions.length === 0) {
      if (sessionBootstrapRef.current) return;
      sessionBootstrapRef.current = true;
      void createConversation();
      return;
    }
    sessionBootstrapRef.current = false;
    if (optimisticSession?.id === currentSessionId) {
      if (sessions.some((session) => session.id === currentSessionId)) {
        setOptimisticSession(null);
      } else {
        return;
      }
    }
    if (!currentSessionId || !sessions.some((session) => session.id === currentSessionId)) {
      setCurrentSessionId(sessions[0].id);
    }
  }, [createConversation, currentSessionId, open, optimisticSession, sessionsQ.data]);

  // AF S4 / YUK-203 U6 — restore skill state from a replayed message list: adopt the
  // latest non-end AI skill_context as activeSkillRef, and surface the latest in-scope
  // knowledge entity for the quiz chip. Newest-first scan (replayed is oldest→newest).
  // Set-if-found (no reset) so the drawer-open prefill keeps its exact semantics; callers
  // that must drop stale context (post-revert refetch) reset the refs before calling.
  const restoreSkillStateFromReplay = useCallback(
    (replayed: ReturnType<typeof replayToMessages>) => {
      for (let i = replayed.length - 1; i >= 0; i--) {
        const m = replayed[i];
        if (m.role !== 'ai' || !m.skill_turn) continue;
        if (m.skill_turn.kind === 'end') break; // ended session → leave ref null
        if (m.skill_context) activeSkillRef.current = m.skill_context;
        break; // found the latest skill turn — done either way
      }
      for (let i = replayed.length - 1; i >= 0; i--) {
        const sc = replayed[i].skill_context;
        if (sc?.ref.kind === 'knowledge') {
          setFocusedKnowledgeId(sc.ref.id);
          break;
        }
      }
    },
    [],
  );

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
    if (!currentSessionId) return;
    if (replayedRef.current) return;
    replayedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiJson<CopilotTurnsResponse>(
          `/api/copilot/turns?limit=${REPLAY_LIMIT}&session_id=${encodeURIComponent(currentSessionId)}`,
        );
        if (cancelled) return;
        const replayed = replayToMessages(res.turns ?? []);
        if (replayed.length === 0 && !restoredPendingTurn) return;
        // Only prefill if the user has not already started typing/sending in this
        // open (don't stomp a live exchange that raced the fetch). An uncertain
        // pre-202 handoff deliberately waits for this replay first: the inline
        // server path may already have completed, and hiding that real reply
        // behind a local pending row would steer the user toward a duplicate run.
        setMessages((prev) => {
          if (prev.length !== 0) return prev;
          if (!restoredPendingTurn) return replayed;
          const pendingAlreadyVisible = replayed.some(
            (message) =>
              message.role === 'user' && message.text === restoredPendingTurn.userMessage,
          );
          return pendingAlreadyVisible
            ? replayed
            : [
                ...replayed,
                {
                  id: restoredPendingTurn.userMessageId,
                  role: 'user' as const,
                  text: restoredPendingTurn.userMessage,
                },
              ];
        });
        // Restore activeSkillRef + the quiz chip's in-scope knowledge entity from the
        // replayed turns so composer answers / the quiz chip survive a page refresh.
        restoreSkillStateFromReplay(replayed);
      } catch {
        // Replay is best-effort — stay on the in-memory list.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentSessionId, open, restoreSkillStateFromReplay, restoredPendingTurn]);

  // Returns true when it actually replaced the message list, false when it SKIPPED (a send is in
  // flight). Callers use the flag so they don't report a refresh as done when it was skipped
  // (YUK-497 wave-3).
  const refetchTurns = useCallback(async (): Promise<boolean> => {
    if (!currentSessionId) return false;
    const res = await apiJson<CopilotTurnsResponse>(
      `/api/copilot/turns?limit=${REPLAY_LIMIT}&session_id=${encodeURIComponent(currentSessionId)}`,
    );
    const replayed = replayToMessages(res.turns ?? []);
    // Don't clobber a live exchange. The revert button on a PRIOR AI message is clickable even
    // while a NEW send is streaming; a full setMessages(replayed) here would drop the locally
    // tracked streaming message (its aiId is not yet in the server replay), and send()'s later
    // `map(m => m.id === aiId ? finalized : m)` would silently no-op — the reply vanishes. Skip the
    // replace while a send is in flight (mirrors the prefill's prev.length===0 guard). The revert
    // already landed server-side; the tombstone shows on the next refresh (YUK-497 wave-2, major).
    if (sendingRef.current) return false;
    setMessages(replayed);
    // A revert may have removed the turn that owned the active teaching skill / focused
    // knowledge — reset both, then recompute from the refreshed list (the same scan the
    // drawer-open prefill runs) so stale skill context never survives a revert.
    activeSkillRef.current = null;
    setFocusedKnowledgeId(null);
    restoreSkillStateFromReplay(replayed);
    return true;
  }, [currentSessionId, restoreSkillStateFromReplay]);

  const revertCheckpoint = useCallback(
    async (checkpointEventId: string) => {
      setRevertPendingId(checkpointEventId);
      setError(null);
      setRefreshFailed(false);
      setRefreshSkipped(false);
      try {
        try {
          await apiJson(
            `/api/copilot/checkpoints/${encodeURIComponent(checkpointEventId)}/revert`,
            { method: 'POST' },
          );
        } catch (err) {
          // The revert POST itself failed — nothing landed. A cascade REFUSAL body ({ ok:false,
          // refusal, reason }) carries no top-level message, so ApiError.message is only the generic
          // "409 Conflict"; the actionable explanation (irreversible / conflict / …) lives in
          // details.reason. Prefer it so the user sees WHY and doesn't blindly retry an irreversible
          // revert (YUK-497 wave-2, codex P2). The per-message 撤回 button re-enables (pending
          // cleared) so a genuinely retriable failure can still be retried.
          const refusalReason =
            err instanceof ApiError && typeof err.details?.reason === 'string'
              ? err.details.reason
              : undefined;
          setError(refusalReason ?? (err instanceof Error ? err.message : '撤回失败'));
          return;
        }
        // Revert LANDED. A refetch failure from here must NOT read as '撤回失败' — the change
        // was reverted, only the on-screen refresh failed. Distinct state drives a refresh-only
        // retry (retryRefresh below), never a second revert. A SKIP (refetchTurns → false, a send
        // is streaming) also surfaces the refresh-pending banner so the user has a cue to retry
        // rather than thinking the revert did nothing (YUK-497 wave-3).
        try {
          const refreshed = await refetchTurns();
          // false = SKIPPED (a send is streaming) — deferred, not failed → the calmer skip banner.
          if (!refreshed) setRefreshSkipped(true);
        } catch {
          // The refetch itself threw → a real failure.
          setRefreshFailed(true);
        }
      } finally {
        // Guarded clear (mirrors chipPending): only clear if THIS checkpoint is still the
        // pending one, so a newer revert of a different checkpoint isn't cleared by our finally.
        setRevertPendingId((cur) => (cur === checkpointEventId ? null : cur));
      }
    },
    [refetchTurns],
  );

  // Retry affordance for the "revert landed, refresh failed" state — re-runs the turns
  // refetch ONLY (the revert already committed server-side); clears the banner on success.
  const retryRefresh = useCallback(async () => {
    try {
      // Only clear the banners when the refresh actually ran — a skip (a send started during the
      // retry) must keep them up rather than misleading the user that it refreshed (YUK-497 wave-3).
      const refreshed = await refetchTurns();
      if (refreshed) {
        setRefreshFailed(false);
        setRefreshSkipped(false);
      }
    } catch {
      // Keep the banner up; the revert is already durable, only the refresh is still failing.
    }
  }, [refetchTurns]);

  const applyRunViewToMessage = useCallback(
    (aiMessageId: string, view: CopilotRunView, fallbackText: string) => {
      const terminal = view.phase === 'completed' || view.phase === 'failed';
      setProgressStage(terminal ? null : copilotProgressStage(view));
      setMessages((prev) => {
        const existing = prev.find((message) => message.id === aiMessageId);
        const next: ChatMessage = {
          ...(existing ?? { id: aiMessageId, role: 'ai' as const }),
          text:
            view.replyText ||
            (view.phase === 'failed' ? fallbackText : existing?.text || fallbackText),
          checkpoint_event_id:
            view.failureReason === 'ambiguous_execution'
              ? undefined
              : (view.checkpointEventId ?? existing?.checkpoint_event_id),
          subtasks: view.subtasks,
          streaming: !terminal,
        };
        return existing
          ? prev.map((message) => (message.id === aiMessageId ? next : message))
          : [...prev, next];
      });
    },
    [],
  );

  const reportSendError = useCallback((msg: string) => {
    // F2 (TdZCB) — a send failure is a fresh, actionable error. A revert that
    // interleaved with it may have set a refresh banner; clear both so this error
    // is never masked.
    setRefreshFailed(false);
    setRefreshSkipped(false);
    setError(msg);
  }, []);

  const reconnectDurable = useCallback(
    async (handle: DurableCopilotReconnect) => {
      if (sendingRef.current) return;
      sendingRef.current = true;
      const abortController = new AbortController();
      activeTransportAbortRef.current?.abort();
      activeTransportAbortRef.current = abortController;
      setError(null);
      setRefreshFailed(false);
      setRefreshSkipped(false);
      setSending(true);
      setDurableRunning(true);
      setProgressStage(copilotProgressStage(handle.view));
      setAwaitingFirstFrame(false);
      setMessages((prev) =>
        prev.map((message) =>
          message.id === handle.aiMessageId ? { ...message, streaming: true } : message,
        ),
      );

      try {
        const durable = await consumeDurableCopilotRun({
          location: handle.location,
          fetchResponse: apiFetch,
          initialState: handle.view,
          signal: abortController.signal,
          onUpdate: (view) => {
            handle.view = view;
            applyRunViewToMessage(
              handle.aiMessageId,
              view,
              '正在重新连接这次后台任务；不会重复提交。',
            );
          },
        });
        handle.view = durable;
        if (durableReconnectRef.current?.runId === handle.runId) {
          durableReconnectRef.current = null;
        }
        clearPersistedDurableCopilotReconnect(handle.runId);
        if (durable.phase === 'failed') {
          applyRunViewToMessage(
            handle.aiMessageId,
            durable,
            '这次后台运行没有完成。可以换个更聚焦的问法再试。',
          );
          if (durable.failureReason === 'ambiguous_execution') {
            // The live copy asks the owner to inspect potentially committed
            // effects first. Do not pair it with a blind one-click redispatch.
            lastUserTurnRef.current = null;
          }
          reportSendError('后台运行未完成');
        }
      } catch (error) {
        if (stoppingRunRef.current === handle.runId) {
          stoppingRunRef.current = null;
          return;
        }
        // Keep the accepted handle and its latest cursor. The next click resumes
        // the same Location; it never falls through to a fresh chat dispatch.
        durableReconnectRef.current = handle;
        setMessages((prev) =>
          prev.map((message) =>
            message.id === handle.aiMessageId ? { ...message, streaming: false } : message,
          ),
        );
        reportSendError(durableReconnectErrorMessage(error));
      } finally {
        if (activeTransportAbortRef.current === abortController) {
          activeTransportAbortRef.current = null;
        }
        sendingRef.current = false;
        setSending(false);
        setDurableRunning(false);
        if (durableReconnectRef.current?.runId !== handle.runId) setProgressStage(null);
        setAwaitingFirstFrame(false);
      }
    },
    [applyRunViewToMessage, reportSendError],
  );

  const stopDurableRun = useCallback(async () => {
    const handle = durableReconnectRef.current;
    if (!handle || stopPending) return;
    setStopPending(true);
    try {
      const result = await apiJson<{
        ok: true;
        run_id: string;
        status: 'cancel_requested' | 'cancelled' | 'already_requested' | 'already_settled';
      }>(`/api/copilot/runs/${encodeURIComponent(handle.runId)}/cancel`, { method: 'POST' });
      if (result.status === 'already_settled') return;

      stoppingRunRef.current = handle.runId;
      activeTransportAbortRef.current?.abort();
      activeTransportAbortRef.current = null;
      durableReconnectRef.current = null;
      clearPersistedDurableCopilotReconnect(handle.runId);
      const pending = lastUserTurnRef.current;
      if (pending) clearPersistedPendingCopilotTurn(pending.idempotencyKey);
      lastUserTurnRef.current = null;
      setPendingAcceptanceUnknown(false);
      setError(null);
      setRefreshFailed(false);
      setRefreshSkipped(false);
      setProgressStage(null);
      setMessages((prev) =>
        prev.map((message) =>
          message.id === handle.aiMessageId
            ? { ...message, text: '已停止这次运行。', streaming: false, subtasks: [] }
            : message,
        ),
      );
    } catch (err) {
      reportSendError(
        err instanceof ApiError ? `停止失败（${err.status}）` : '停止失败，请稍后重试。',
      );
    } finally {
      setStopPending(false);
    }
  }, [reportSendError, stopPending]);

  // A 202 accepted before a page reload/unmount is restored from sessionStorage.
  // Start from cursor zero so job_events, not browser state, rebuilds the view.
  useEffect(() => {
    if (!open || !restoredDurableHandle || restoredReconnectStartedRef.current) return;
    restoredReconnectStartedRef.current = true;
    void reconnectDurable(restoredDurableHandle);
  }, [open, reconnectDurable, restoredDurableHandle]);

  // Auto-scroll the message stream to the bottom on new messages / loading.
  // `sending` is an intentional trigger dep: when it flips true the thinking
  // bubble mounts and we want to scroll to it, even though the effect body
  // only reads the ref.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sending drives the scroll-to-thinking-bubble
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: helpers are stable for this component lifetime; refs carry live turn context
  const send = useCallback(async (raw: string, retryIdempotencyKey?: string) => {
    const text = raw.trim();
    if (!text || sendingRef.current) return;
    const selectedSessionId = currentSessionIdRef.current;
    if (!selectedSessionId) {
      setError('对话仍在加载，请稍后再试。');
      return;
    }
    sendingRef.current = true;
    const turnAbortController = new AbortController();
    activeTransportAbortRef.current?.abort();
    activeTransportAbortRef.current = turnAbortController;
    // A deliberate new message supersedes this single-run reconnect affordance.
    // The old server run/reply stays durable, but its live progress is no longer
    // pinned in this Dock; multi-active-run recovery belongs to YUK-596.
    const supersededDurable = durableReconnectRef.current;
    if (supersededDurable) clearPersistedDurableCopilotReconnect(supersededDurable.runId);
    durableReconnectRef.current = null;
    const idempotencyKey = retryIdempotencyKey ?? crypto.randomUUID();
    const priorLogicalTurn =
      retryIdempotencyKey && lastUserTurnRef.current?.idempotencyKey === retryIdempotencyKey
        ? lastUserTurnRef.current
        : null;
    const userMessageId = priorLogicalTurn?.userMessageId ?? nextId();
    // A retry must replay the exact normalized body as well as the key. The
    // drawer can stay open while navigation/skill focus changes; recomputing
    // ambient_context here would correctly trigger a server 409 but prevent
    // recovery of the already accepted original turn.
    const selectedCorrectionTarget = correctionTargetRef.current;
    const currentSkillContext = selectedCorrectionTarget ? null : activeSkillRef.current;
    const route = pathnameRef.current;
    const focusedEntity = currentSkillContext?.ref;
    const ambientFocus = resolveTurnAmbientFocus(focusedEntity, nudgeSessionRef.current);
    const ambientContext = route
      ? { route, ...(ambientFocus ? { focused_entity: ambientFocus } : {}) }
      : undefined;
    const requestBody = priorLogicalTurn?.requestBody ?? {
      session_id: selectedSessionId,
      user_message: text,
      triggered_by: 'chat' as const,
      ...(currentSkillContext ? { skill_context: currentSkillContext } : {}),
      ...(ambientContext ? { ambient_context: ambientContext } : {}),
      ...(selectedCorrectionTarget
        ? { correction_target_turn_id: selectedCorrectionTarget.turnId }
        : {}),
    };
    const skillContext = requestBody.skill_context;
    lastUserTurnRef.current = {
      text,
      idempotencyKey,
      retryWithSameKey: true,
      userMessageId,
      requestBody,
    };
    // Persist before the POST begins. If this component unmounts before response
    // headers arrive, the next mount can present an explicit human-controlled
    // recovery using this exact key + body. It never auto-POSTs: automatic
    // dispatch may have completed inline, whose current server path is not
    // idempotently replayable.
    persistPendingCopilotTurn({
      v: 1,
      idempotencyKey,
      userMessageId,
      userMessage: text,
      requestBody,
    });
    setPendingAcceptanceUnknown(false);
    setError(null);
    // Clear the "revert landed, refresh failed/skipped" banners when starting a new send: otherwise
    // they stay set (only retryRefresh success / a new revert clears them) and their suppression of
    // the generic error banner would mask a failure from THIS send (YUK-497 wave-2).
    setRefreshFailed(false);
    setRefreshSkipped(false);
    setInput('');
    correctionTargetRef.current = null;
    setCorrectionTarget(null);
    if (priorLogicalTurn) {
      // Same-key recovery may already be visible from replay under a different
      // server event id. Avoid duplicating that one logical turn.
      setMessages((prev) =>
        prev.some(
          (message) =>
            message.id === userMessageId || (message.role === 'user' && message.text === text),
        )
          ? prev
          : [...prev, { id: userMessageId, role: 'user', text }],
      );
    } else {
      // A terminal failure retry owns a fresh key and therefore a fresh domain
      // ask, even when the user-visible text is identical.
      setMessages((prev) => [...prev, { id: userMessageId, role: 'user', text }]);
    }
    setSending(true);
    setProgressStage('dispatch');
    setAwaitingFirstFrame(true);
    // YUK-266 (C1) — the AI message id is minted up-front so the incremental SSE
    // deltas can target the SAME message as it grows; the terminal `reply` event
    // then overwrites its text with the authoritative reply + attaches the
    // structured fields.
    const aiId = nextId();
    let aiCreated = false;
    let durableAccepted = false;
    let durableHandleMissing = false;
    let durableHandle: DurableCopilotReconnect | null = null;
    let inlineReplyStarted = false;
    let inlineSubtaskVersion = 0;
    let inlineRunView = createCopilotRunView();
    const inlineToolCalls: ToolCallRecord[] = [];
    let dispatchResponseReceived = false;
    // YUK-913 — one publisher for the folded tool-call list: creates the AI row
    // on the first frame, then updates it in place so each card's state evolves
    // 调用中 → 已完成/失败 without ever appending a second card.
    const publishToolCalls = () => {
      const snapshot = [...inlineToolCalls];
      if (!aiCreated) {
        aiCreated = true;
        setAwaitingFirstFrame(false);
        setMessages((prev) => [
          ...prev,
          {
            id: aiId,
            role: 'ai',
            text: '',
            streaming: true,
            subtasks: inlineRunView.subtasks,
            tool_calls: snapshot,
          },
        ]);
      } else {
        setMessages((prev) =>
          prev.map((m) => (m.id === aiId ? { ...m, tool_calls: snapshot } : m)),
        );
      }
    };
    try {
      const res = await apiFetch('/api/copilot/chat', {
        method: 'POST',
        signal: turnAbortController.signal,
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(requestBody),
      });
      dispatchResponseReceived = true;
      // YUK-757/YUK-596 bridge — durable dispatch returns 202 JSON + a generic
      // authenticated job-events Location instead of inline chat SSE. Consume it
      // with explicit Last-Event-ID reconnects; every update patches the SAME AI
      // row, so replay cannot create duplicate cards or a ghost reply.
      if (res.status === 202) {
        // 202 is the authoritative acceptance boundary. Prefer Location, but a
        // proxy may strip it while preserving the JSON run_id. Reconstruct only
        // the same-origin canonical job-events path; if neither carrier is
        // usable, retain the exact key + body for explicit same-key recovery.
        durableAccepted = true;
        let location = res.headers.get('Location');
        let runId = durableRunIdFromLocation(location);
        if (runId) {
          // A valid header is sufficient even if the informational JSON body is
          // truncated after headers. Do not let body parsing weaken acceptance.
          void res.body?.cancel().catch(() => undefined);
        } else {
          try {
            const acceptedBody = (await res.json()) as { run_id?: unknown };
            if (typeof acceptedBody.run_id === 'string') {
              const reconstructedLocation = `/api/jobs/copilot_run/${encodeURIComponent(acceptedBody.run_id)}/events`;
              if (durableRunIdFromLocation(reconstructedLocation) === acceptedBody.run_id) {
                runId = acceptedBody.run_id;
                location = reconstructedLocation;
              }
            }
          } catch {
            // The human-controlled recovery below replays the exact key/body.
          }
        }
        aiCreated = true;
        applyRunViewToMessage(
          aiId,
          inlineRunView,
          '这件事需要多步处理，我已转到后台；进度会在这里持续更新。',
        );
        if (!location || !runId) {
          // Acceptance is known, but the stable reconnect handle is not. Keep
          // lastUserTurnRef + sessionStorage intact: the only safe redispatch is
          // an explicit replay of this exact key and normalized body.
          durableHandleMissing = true;
          throw new Error('后台任务已受理，但没有返回进度地址；请用原请求恢复进度。');
        }
        durableHandle = {
          v: 1,
          sessionId: requestBody.session_id ?? selectedSessionId,
          runId,
          location,
          userMessageId,
          aiMessageId: aiId,
          userMessage: text,
          view: inlineRunView,
        };
        durableReconnectRef.current = durableHandle;
        if (persistDurableCopilotReconnect(durableHandle)) {
          // The stable accepted Location supersedes the uncertain POST record.
          clearPersistedPendingCopilotTurn(idempotencyKey);
        }
        if (lastUserTurnRef.current?.idempotencyKey === idempotencyKey) {
          lastUserTurnRef.current.retryWithSameKey = false;
        }
        setDurableRunning(true);
        setAwaitingFirstFrame(false);
        const durable = await consumeDurableCopilotRun({
          location,
          fetchResponse: apiFetch,
          signal: turnAbortController.signal,
          onUpdate: (view) => {
            if (durableHandle) durableHandle.view = view;
            applyRunViewToMessage(
              aiId,
              view,
              '这件事需要多步处理，我已转到后台；进度会在这里持续更新。',
            );
          },
        });
        if (durable.phase === 'failed') {
          applyRunViewToMessage(aiId, durable, '这次后台运行没有完成。可以换个更聚焦的问法再试。');
          if (durable.failureReason === 'ambiguous_execution') {
            lastUserTurnRef.current = null;
          }
          reportSendError('后台运行未完成');
        }
        if (durableReconnectRef.current?.runId === durableHandle.runId) {
          durableReconnectRef.current = null;
        }
        clearPersistedDurableCopilotReconnect(durableHandle.runId);
        clearPersistedPendingCopilotTurn(idempotencyKey);
        nudgeSessionRef.current = nextNudgeSessionAfterTurn(nudgeSessionRef.current, true);
        return;
      }
      // A concrete inline response settles the POST acceptance question. Clear
      // the pre-acceptance handoff before consuming the body: a later stream
      // disconnect must not be mistaken for a never-answered dispatch.
      clearPersistedPendingCopilotTurn(idempotencyKey);
      if (lastUserTurnRef.current?.idempotencyKey === idempotencyKey) {
        lastUserTurnRef.current.retryWithSameKey = false;
      }
      const body = res.body;
      // Graceful degrade (red line): no streamable body → read the whole thing
      // and treat it as a single terminal reply. The terminal `reply` event is the
      // source of truth, so even zero deltas render correctly.
      let finalReply: CopilotChatResponse | null = null;
      if (!body) {
        finalReply = (await res.json()) as CopilotChatResponse;
      } else {
        for await (const evt of parseCopilotSseStream(body)) {
          if (evt.event === 'delta') {
            let chunk = '';
            try {
              chunk = (JSON.parse(evt.data) as { text?: string }).text ?? '';
            } catch {
              chunk = '';
            }
            if (!chunk) continue;
            // First delta swaps the "thinking" bubble for a live streaming AI
            // message; subsequent deltas grow its text.
            if (!aiCreated) {
              aiCreated = true;
              inlineReplyStarted = true;
              setAwaitingFirstFrame(false);
              setProgressStage('generation');
              setMessages((prev) => [
                ...prev,
                {
                  id: aiId,
                  role: 'ai',
                  text: chunk,
                  streaming: true,
                  subtasks: inlineRunView.subtasks,
                },
              ]);
            } else {
              const appendToReply = inlineReplyStarted;
              inlineReplyStarted = true;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === aiId ? { ...m, text: appendToReply ? m.text + chunk : chunk } : m,
                ),
              );
            }
          } else if (evt.event === 'subtask') {
            const subtask = parseInlineSubtaskEvent(evt.data);
            if (!subtask) continue;
            inlineSubtaskVersion += 1;
            inlineRunView = foldCopilotRunFrames(inlineRunView, [
              subtaskEventToFrame(subtask, inlineSubtaskVersion),
            ]);
            if (!aiCreated) {
              aiCreated = true;
              setAwaitingFirstFrame(false);
            }
            applyRunViewToMessage(
              aiId,
              inlineRunView,
              '我正在协调这些子任务，完成后会在这里统一收口。',
            );
          } else if (evt.event === 'tool_use') {
            const call = parseToolUseSse(evt.data);
            if (call) {
              // YUK-913 — merge (never blind-append): duplicate frames for one
              // logical call must not open a second 调用中 card.
              const merged = mergeToolUseEvent(inlineToolCalls, call);
              if (merged !== inlineToolCalls) {
                inlineToolCalls.splice(0, inlineToolCalls.length, ...merged);
                publishToolCalls();
              }
            }
          } else if (evt.event === 'tool_result') {
            const result = parseToolResultSse(evt.data);
            if (result) {
              inlineToolCalls.splice(
                0,
                inlineToolCalls.length,
                ...applyToolResult(inlineToolCalls, result),
              );
              publishToolCalls();
            }
          } else if (evt.event === 'reply') {
            try {
              finalReply = JSON.parse(evt.data) as CopilotChatResponse;
            } catch {
              finalReply = null;
            }
          }
        }
      }

      if (!finalReply || typeof finalReply.reply !== 'string') {
        // No usable terminal payload — degrade to the error affordance. If a
        // partial bubble was created, drop it so we don't strand a half message.
        if (aiCreated) setMessages((prev) => prev.filter((m) => m.id !== aiId));
        reportSendError(finalReply?.error ?? '请求失败');
        return;
      }

      const res2 = finalReply;
      // AF S4 / YUK-203 U6 — clear the active skill on end turn so subsequent
      // free-form messages are not re-routed to the stale skill context.
      if (res2.skill_turn?.kind === 'end') {
        activeSkillRef.current = null;
      }
      // YUK-272 (C3) / YUK-213 F2 — one-shot-stuck minimal fix. quiz + solve return
      // NO terminal skill_turn, so the `end`-turn clear above never fires for them
      // and the stale skill_context would re-send on every follow-up. Clear it after
      // a SUCCESSFUL one-shot send (a failed send keeps the context so 重试 reuses
      // it). The server-side skill_turn redesign is the real fix (YUK-213); this is
      // the Dock-only guard. If YUK-213 later makes solve multi-turn, the server will
      // emit a non-`end` skill_turn and this rule must be revisited.
      if (skillContext && isOneShotSkill(skillContext.skill)) {
        activeSkillRef.current = null;
      }
      // YUK-577 (Codex P2-1) — one-shot nudge focus: the ingestion-session anchor a 「看看」click
      // seeded only applies to the FIRST turn after the click, then clears. Same rule as the
      // one-shot skill clear above — a FAILED send never reaches here (it early-returns at the
      // no-terminal-payload guard / throws to catch), so 重试 keeps the anchor. Without this, every
      // later free-form turn would keep re-sending the stale learning_session focus until the
      // drawer closes (the nudge anchor should not stick to the whole session).
      nudgeSessionRef.current = nextNudgeSessionAfterTurn(nudgeSessionRef.current, true);
      const finalized: ChatMessage = {
        id: aiId,
        role: 'ai',
        // The terminal reply is authoritative (reconciles any delta drift).
        text: res2.reply,
        checkpoint_event_id: res2.checkpoint_event_id,
        skill_turn: res2.skill_turn,
        session_id: res2.session_id,
        reply_event_id: res2.reply_event_id,
        // Store the originating skill_context on the message so the replay
        // path can reconstruct activeSkillRef on next open without waiting
        // for the turns API to echo it back.
        skill_context: skillContext ?? undefined,
        streaming: false,
        // YUK-307 — the hero nomination from the terminal reply event (chat.ts
        // CopilotChatResult.primary_view). Undefined ⇒ no hero rendered.
        primary_view: res2.primary_view,
        subtasks: inlineRunView.subtasks,
        // YUK-457 / YUK-913 — preserve accumulated tool-use records; mark any still-running
        // calls done when the terminal reply lands (remote MCP paths may skip tool_result).
        // No synthetic summary: the compact row's 已完成 pill needs none.
        ...(inlineToolCalls.length > 0
          ? {
              tool_calls: inlineToolCalls.map((call) =>
                call.status === 'running' ? { ...call, status: 'done' as const } : call,
              ),
            }
          : {}),
      };
      setMessages((prev) =>
        aiCreated ? prev.map((m) => (m.id === aiId ? finalized : m)) : [...prev, finalized],
      );
      // YUK-266 (C1) — a partial-degrade reply still rendered (text persisted);
      // surface the error affordance alongside it so the user knows it was cut.
      if (res2.error) reportSendError(res2.error);
    } catch (err) {
      if (durableHandle && stoppingRunRef.current === durableHandle.runId) {
        stoppingRunRef.current = null;
        return;
      }
      // Network / stream error mid-flight. Drop any partial bubble and show the
      // existing 重试 affordance — the inline turn was best-effort. A durable
      // 202 was already accepted server-side, so keep its row whenever a stable
      // handle exists. With no usable handle, drop only the placeholder; the
      // exact same-key recovery will rebuild one authoritative row.
      if (aiCreated && (!durableAccepted || durableHandleMissing)) {
        setMessages((prev) => prev.filter((m) => m.id !== aiId));
      } else if (durableAccepted) {
        setMessages((prev) => prev.map((m) => (m.id === aiId ? { ...m, streaming: false } : m)));
        if (durableHandle) durableReconnectRef.current = durableHandle;
      }
      let message = '请求失败';
      // A structured server error is definitive except for the explicit
      // accepted-but-queue-unknown contract. Transport loss keeps same-key
      // recovery because the 202 itself may have been lost in flight.
      if (
        !durableAccepted &&
        err instanceof ApiError &&
        err.code !== 'copilot_enqueue_ambiguous' &&
        lastUserTurnRef.current?.idempotencyKey === idempotencyKey
      ) {
        lastUserTurnRef.current.retryWithSameKey = false;
        clearPersistedPendingCopilotTurn(idempotencyKey);
      }
      setPendingAcceptanceUnknown(
        durableHandleMissing ||
          (!dispatchResponseReceived &&
            (!(err instanceof ApiError) || err.code === 'copilot_enqueue_ambiguous')),
      );
      if (durableHandleMissing) {
        message = '后台任务已受理，但没有返回进度地址；请用原请求恢复进度。';
      } else if (durableAccepted) {
        message = durableReconnectErrorMessage(err);
      } else if (err instanceof ApiError) {
        message = `请求失败（${err.status}）`;
      } else if (err instanceof Error) {
        message = err.message;
      }
      reportSendError(message);
    } finally {
      if (activeTransportAbortRef.current === turnAbortController) {
        activeTransportAbortRef.current = null;
      }
      sendingRef.current = false;
      setSending(false);
      setDurableRunning(false);
      if (durableReconnectRef.current?.runId !== durableHandle?.runId) setProgressStage(null);
      setAwaitingFirstFrame(false);
    }
  }, []);

  const retry = useCallback(() => {
    const durable = durableReconnectRef.current;
    if (durable) {
      void reconnectDurable(durable);
      return;
    }
    const last = lastUserTurnRef.current;
    if (last) void send(last.text, last.retryWithSameKey ? last.idempotencyKey : undefined);
  }, [reconnectDurable, send]);

  const discardPendingRecovery = useCallback(() => {
    const pending = lastUserTurnRef.current;
    if (pending) clearPersistedPendingCopilotTurn(pending.idempotencyKey);
    lastUserTurnRef.current = null;
    setPendingAcceptanceUnknown(false);
    setError(null);
  }, []);

  // YUK-272 (C3) — quiz quick-chip. When a knowledge node is in scope, seed a quiz
  // skill turn with that real id; `send` clears the one-shot context afterwards via
  // isOneShotSkill. ADR-0031 / YUK-304 retired the hard quiz intercept, so without a
  // focused node the same user-readable prompt deliberately follows normal Copilot
  // routing and lets the model clarify/orchestrate instead of becoming a dead chip.
  const sendQuiz = useCallback(() => {
    // YUK-266 — single-flight guard. On the first SSE delta `send` flips `sending`
    // false (to re-open the composer for the live reply) while `sendingRef.current`
    // stays true until the turn settles. In that window the quiz chip re-enables;
    // without this guard a click would mutate activeSkillRef to {skill:'quiz',…}
    // and then `send('出题')` would early-return on its own sendingRef guard — the
    // quiz turn is dropped BUT activeSkillRef is left polluted, mis-routing the
    // user's NEXT free-form message as a quiz turn. No-op while a send is in flight.
    if (sendingRef.current) return;
    if (focusedKnowledgeId) {
      activeSkillRef.current = {
        skill: 'quiz',
        ref: { kind: 'knowledge', id: focusedKnowledgeId },
      };
    } else {
      // Replay can restore a long-lived teaching/solve context without a knowledge
      // ref. The global quiz prompt is a deliberate context switch: clear that
      // stale behavior-pack route so the no-scope fallback reaches free-form
      // Copilot, which can clarify what the learner wants to practise.
      activeSkillRef.current = null;
    }
    void send('出题');
  }, [focusedKnowledgeId, send]);

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
    activeSkillRef.current = openRequest.skill_context ?? null;
    // YUK-272 (C3) — if the open-with-context signal carried a knowledge entity,
    // expose it as the quiz-chip's in-scope knowledge id. YUK-266 — else CLEAR it:
    // without this, opening the Dock with a non-knowledge context (e.g. a learning
    // item) after a prior knowledge open would leave the stale knowledge id, so the
    // quiz chip stays enabled and would generate a quiz for a no-longer-in-scope
    // knowledge node.
    if (openRequest.skill_context?.ref.kind === 'knowledge') {
      setFocusedKnowledgeId(openRequest.skill_context.ref.id);
    } else {
      setFocusedKnowledgeId(null);
    }
    // YUK-577 — nudge 「看看」open: the deterministic headline IS the agent opening turn (seeded
    // client-side as an `ai` message — never an owner user bubble, MF1 / A3:88). Remember the
    // ingestion session so the user's reply carries it in ambient_context. Only seed into an empty
    // stream (never clobber an in-progress conversation).
    if (openRequest.nudge) {
      const n = openRequest.nudge;
      nudgeSessionRef.current = n.session_id;
      setMessages((prev) =>
        prev.length === 0 ? [{ id: nextId(), role: 'ai', text: n.headline }] : prev,
      );
    }
    prepareAndOpenDrawer();
    const prefill = openRequest.prefill;
    clearRequest();
    if (prefill) {
      // A cross-surface handoff must never disappear while a prior turn is streaming. Keep it
      // in the visible composer for the user to send next instead of letting send() early-return.
      if (sendingRef.current) setInput(prefill);
      else void send(prefill);
    }
  }, [openRequest, prepareAndOpenDrawer, clearRequest, send]);

  // YUK-577 — proactive-nudge bar at the top of the summary slot (② owner-approved落点, above
  // daily_focus). Agent-tone (invitation, NOT alert-red): subtle left border + sparkle + headline +
  // 看看 / ×. 看看 → seed the headline as the agent opening + open drawer + mark opened (KPI);
  // × → dismiss (kind-wide daily fuse server-side). Isolated from footer/composer + message list.
  const nudgeBar =
    nudges.length > 0 ? (
      <div className="flex flex-col gap-[6px]" data-testid="copilot-nudge-bar">
        {nudges.map((n) => (
          <div
            key={n.id}
            className="flex items-start gap-[8px] border-l-2 border-[var(--ink-3)] pl-[8px] py-[3px]"
          >
            <LoomIcon name="sparkle" size={14} />
            <p className="flex-1 text-[12.5px] text-[var(--ink)] leading-[1.5]">{n.headline}</p>
            <button
              type="button"
              className="chip"
              data-testid="copilot-nudge-open"
              disabled={nudgeMutating}
              onClick={() => {
                void markOpened(n.id);
                openCopilotForNudge({
                  nudge_event_id: n.id,
                  session_id: n.subject_id,
                  headline: n.headline,
                });
              }}
            >
              看看
            </button>
            <IconBtn
              icon="close"
              size={14}
              title="忽略"
              aria-label="忽略"
              data-testid="copilot-nudge-dismiss"
              disabled={nudgeMutating}
              onClick={() => void dismissNudge(n.id)}
            />
          </div>
        ))}
      </div>
    ) : null;

  const learnerBriefGlobal = learnerGlobalBrief(summaryQ.data?.brief_global_md);
  const summaryBody = summaryQ.data ? (
    // 4-slot order per Wave 5 ready-to-launch lock §Human decision points:
    // Coach focus → review_due → brief → dreaming → footer.
    <div className="flex flex-col gap-[6px]">
      {/* 在线徽标已上移到 drawer-head（copilot.jsx L107）；摘要直接从 daily_focus 起。 */}
      <p className="text-[13px] text-[var(--ink)] leading-[1.55]">{summaryQ.data.daily_focus}</p>
      {summaryQ.data.review_due_count > 0 ? (
        <p className="text-[12.5px] text-[var(--ink-2)]" data-testid="copilot-summary-review-due">
          今日待复习 <strong>{summaryQ.data.review_due_count}</strong> 题
        </p>
      ) : null}
      {learnerBriefGlobal ? (
        <p
          className="text-[12px] text-[var(--ink-3)] italic leading-[1.5]"
          data-testid="copilot-summary-brief-global"
        >
          {learnerBriefGlobal}
        </p>
      ) : null}
      {summaryQ.data.dreaming_preview.length > 0 ? (
        <ul className="list-disc list-inside text-[12.5px] text-[var(--ink-2)]">
          {summaryQ.data.dreaming_preview.map((row) => (
            <li key={row.proposal_id}>{row.brief}</li>
          ))}
        </ul>
      ) : null}
      {summaryQ.data.pending_proposals_total > 0 ? (
        <p className="text-[11.5px] text-[var(--ink-3)]">更多建议已整理到收件箱。</p>
      ) : null}
    </div>
  ) : summaryQ.isLoading ? (
    <p className="text-[12.5px] text-[var(--ink-3)]">加载摘要…</p>
  ) : (
    <p className="text-[12.5px] text-[var(--ink-3)]">摘要暂不可用。</p>
  );

  const listedSessions = sessionsQ.data?.sessions ?? [];
  const visibleSessions =
    optimisticSession && !listedSessions.some((session) => session.id === optimisticSession.id)
      ? [optimisticSession, ...listedSessions]
      : listedSessions;
  const sessionItems: CopilotSessionListItem[] = visibleSessions.map((session) => ({
    id: session.id,
    status: session.status,
    title: `${
      session.title?.trim() ||
      `对话 · ${new Date(session.updated_at).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })}`
    }${session.status === 'active' || session.status === 'idle' ? '' : ' · 已结束'}`,
    updated_at: session.updated_at,
  }));
  const selectedSession = visibleSessions.find((session) => session.id === currentSessionId);
  const conversationReady =
    !creatingSession &&
    (selectedSession?.status === 'active' || selectedSession?.status === 'idle');

  const selectCorrectionTarget = useCallback((turnId: string, turnNumber: number) => {
    const target = { turnId, turnNumber };
    correctionTargetRef.current = target;
    setCorrectionTarget(target);
  }, []);

  const clearCorrectionTarget = useCallback(() => {
    correctionTargetRef.current = null;
    setCorrectionTarget(null);
  }, []);

  // YUK-577 — nudge bar rides above the summary body (shows even while summary loads/unavailable).
  const summary = (
    <>
      {sessionPanelOpen ? (
        <CopilotSessionPanel
          sessions={sessionItems}
          currentSessionId={currentSessionId}
          creating={creatingSession}
          disabled={sending || pendingAcceptanceUnknown}
          onSelect={selectConversation}
          onCreate={() => void createConversation()}
        />
      ) : null}
      {nudgeBar}
      {summaryBody}
    </>
  );

  const footer = (
    <div className="copilot-loom">
      {durableReconnectRef.current ? (
        <div className="mb-[8px] flex items-center justify-between gap-[8px]">
          <span className="text-[12px] text-[var(--ink-3)]" data-testid="copilot-run-stage-footer">
            {COPILOT_PROGRESS_LABELS[progressStage ?? 'dispatch']}
          </span>
          <Btn
            variant="ghost"
            size="sm"
            aria-label="停止这次运行"
            data-testid="copilot-stop-run"
            disabled={stopPending}
            onClick={() => void stopDurableRun()}
          >
            {stopPending ? '停止中…' : '停止'}
          </Btn>
        </div>
      ) : null}
      {correctionTarget ? (
        <div className="chat-chips" data-testid="copilot-correction-target">
          <button
            type="button"
            className="chip is-corrective"
            aria-label="取消更正目标"
            onClick={clearCorrectionTarget}
          >
            将更正第 {correctionTarget.turnNumber} 轮<span aria-hidden="true">×</span>
          </button>
        </div>
      ) : null}
      <div className="chat-chips">
        {QUICK_CHIPS.map((chip) => (
          <button
            key={chip}
            type="button"
            className="chip"
            disabled={sending || !conversationReady}
            onClick={() => void send(chip)}
          >
            {chip}
          </button>
        ))}
        {/* YUK-272 (C3) / YUK-169 — quiz quick-chip. A focused knowledge node
            gets an explicit scope label; otherwise the prompt follows the normal
            Copilot clarification path. Reuses .chip — no new visual system. */}
        <button
          type="button"
          className="chip"
          data-testid="copilot-quiz-chip"
          disabled={sending || !conversationReady}
          onClick={sendQuiz}
        >
          {focusedKnowledgeId ? '出题 · 当前知识点' : '出题'}
        </button>
      </div>
      <div className="composer">
        <textarea
          rows={1}
          value={input}
          placeholder="问 Loom 任何事…"
          aria-label="问 Loom 任何事"
          data-testid="copilot-composer-input"
          disabled={sending || !conversationReady}
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
          disabled={sending || !conversationReady || input.trim().length === 0}
          onClick={() => void send(input)}
        />
      </div>
    </div>
  );

  return (
    <>
      {/* The shell drives this internal launcher programmatically and hides the
          whole wrapper. YUK-577's visible nudge count lives on AppTopbar's real
          launcher, fed through onNudgeCountChange. */}
      <span className="copilot-launcher relative inline-flex">
        <Button
          variant="quiet"
          size="sm"
          onClick={prepareAndOpenDrawer}
          data-testid="copilot-drawer-trigger"
          icon="bot"
        >
          召唤 Copilot
        </Button>
      </span>
      <CopilotDrawer
        open={open}
        onClose={closeDrawer}
        title="编排者"
        icon="copilot"
        headBadge={
          <LoomBadge tone="good" dot pulse>
            在线
          </LoomBadge>
        }
        headActions={
          <>
            <IconBtn
              icon="history"
              size={16}
              title={sessionPanelOpen ? '收起对话记录' : '对话记录'}
              aria-label={sessionPanelOpen ? '收起对话记录' : '对话记录'}
              aria-pressed={sessionPanelOpen}
              onClick={() => setSessionPanelOpen((value) => !value)}
              data-testid="copilot-session-list-toggle"
            />
            {/* 教学模式（copilot.jsx L110）：教学是服务端 skill 驱动（skill_context），
                客户端无持久「模式」开关——此按钮发一条教学意图消息触发既有教学 skill，
                语义同 QUICK_CHIPS，不是死按钮也不伪造客户端状态。 */}
            <IconBtn
              icon="teach"
              size={16}
              title="教学模式"
              aria-label="教学模式"
              disabled={sending || !conversationReady}
              onClick={() => void send('我想进入教学模式，请带我一步步学习当前内容')}
            />
          </>
        }
        summary={summary}
        footer={footer}
      >
        <div className="copilot-loom" data-testid="copilot-chat">
          <div className="chat-stream" ref={streamRef}>
            {messages.length === 0 && !sending ? (
              // YUK-340 — 空线程开场白回写设计稿手稿语气（copilot.jsx L135-141
              // cop-blank 文案逐字），copy 层零结构改动：仍走 .chat-empty。
              <>
                <p className="chat-empty">我是你的编排者</p>
                <p className="chat-empty">
                  前台和昨夜后台的我是同一个 ——
                  我能引用它为你备的东西。问我今天该学什么、为什么这么排，或让我改动；每一句话我都给你一份可留可撤的改动。
                </p>
              </>
            ) : null}
            {messages.map((m, messageIndex) => {
              // Per-row chip flags: only the message whose structured question is
              // pending/acked flips, so a corrective-chip state change re-renders
              // that one row instead of every memoized row.
              const qid = m.skill_turn?.structured_question?.id;
              return (
                <MessageRow
                  key={m.id}
                  message={m}
                  navigate={navigate}
                  onAcceptCorrective={acceptCorrectiveChip}
                  onSelectCorrection={selectCorrectionTarget}
                  correctionTurnNumber={
                    m.role === 'ai'
                      ? messages
                          .slice(0, messageIndex + 1)
                          .filter((message) => message.role === 'ai').length
                      : undefined
                  }
                  correctionSelected={
                    m.reply_event_id != null && correctionTarget?.turnId === m.reply_event_id
                  }
                  onRevert={revertCheckpoint}
                  chipPending={qid != null && chipPending === qid}
                  chipAcked={qid != null && chipAcked === qid}
                  revertPending={
                    m.checkpoint_event_id != null && revertPendingId === m.checkpoint_event_id
                  }
                />
              );
            })}
            {progressStage && (awaitingFirstFrame || sending || durableRunning) ? (
              <div className="msg msg-ai" data-testid="copilot-run-stage-message">
                <div className="msg-avatar">
                  <LoomIcon name="sparkle" size={14} />
                </div>
                <div className="msg-body">
                  <div className="msg-name">编排者</div>
                  <div className="chat-thinking">
                    <LoomIcon name="refresh" size={13} className="spin" />
                    <span data-testid="copilot-run-stage" role="status" aria-live="polite">
                      {COPILOT_PROGRESS_LABELS[progressStage]}
                    </span>
                  </div>
                </div>
              </div>
            ) : null}
            {error && !refreshFailed && !refreshSkipped ? (
              <div className="chat-error" data-testid="copilot-error" role="alert">
                <LoomIcon name="alert" size={14} />
                <span>{error}</span>
                {pendingAcceptanceUnknown && lastUserTurnRef.current ? (
                  <>
                    <Btn variant="ghost" size="sm" onClick={discardPendingRecovery}>
                      不再恢复
                    </Btn>
                    <Btn variant="ghost" size="sm" icon="refresh" onClick={retry}>
                      恢复
                    </Btn>
                  </>
                ) : durableReconnectRef.current || lastUserTurnRef.current ? (
                  <Btn variant="ghost" size="sm" icon="refresh" onClick={retry}>
                    {durableReconnectRef.current ? '重新连接' : '重试'}
                  </Btn>
                ) : null}
              </div>
            ) : null}
            {/* F5 (TdY96) — independent conditionals, not a nested ternary. The two are mutually
                exclusive: refreshFailed wins via the !refreshFailed guard on the skip banner. */}
            {refreshFailed ? (
              <div className="chat-error" data-testid="copilot-refresh-error" role="alert">
                <LoomIcon name="alert" size={14} />
                <span>撤回已完成，但刷新对话失败。</span>
                <Btn variant="ghost" size="sm" icon="refresh" onClick={() => void retryRefresh()}>
                  刷新
                </Btn>
              </div>
            ) : null}
            {!refreshFailed && refreshSkipped ? (
              // TchmY — a SKIP is not an error: the revert landed, the on-screen refresh was just
              // deferred because a reply is streaming. Calmer copy (no failure wording) + a polite
              // role="status" live region (vs the failure banner's role="alert"), same 刷新 retry. The
              // div keeps styling parity with the sibling chat-error banner (hence role, not <output>).
              <div className="chat-error" data-testid="copilot-refresh-skipped" role="status">
                <LoomIcon name="refresh" size={14} />
                <span>撤回已生效，当前回复结束后可刷新查看。</span>
                <Btn variant="ghost" size="sm" icon="refresh" onClick={() => void retryRefresh()}>
                  刷新
                </Btn>
              </div>
            ) : null}
          </div>
        </div>
      </CopilotDrawer>
    </>
  );
}
