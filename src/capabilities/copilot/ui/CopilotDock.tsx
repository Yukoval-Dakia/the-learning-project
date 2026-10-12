// AF Slice 0 / YUK-169 — global Copilot drawer with live chat.
// AF S2a / S3a (YUK-203 U3) — moved out of today/ (CopilotDock, global not
// Today-scoped) + session persistence with replay-last-N.
//
// Mounts <CopilotDrawer> with three regions:
//   • summary  — /api/today/copilot-summary (Coach + Dreaming digest), preserved
//                verbatim. The route stays Today-scoped (the data genuinely IS
//                today's), so the "今日摘要"-style copy in this slot is correct.
//   • chat     — message list + durable 202 acceptance via /api/copilot/chat.
//                Each accepted run has an independent reconnectable job-event
//                subscription. GET /api/copilot/turns restores persisted turns
//                and every active run after reopen/reload.
//   • footer   — quick-chips + composer (Enter to send, Shift+Enter newline).
//
// Contract notes (see docs/design/2026-06-04-redraw-composer-preflight.md +
// docs/design/2026-06-04-l-copilot-preflight.md):
//   • POST never owns execution or streams an inline reply. The authenticated
//     job-event Location streams progress; terminal reply metadata is authoritative.
//   • The route never returns child transcript/reasoning. It may expose only the
//     structural public subtask lifecycle used by the progress cards below.
//   • Turn persistence + replay-last-N is AF Slice 3a. Rolling summary is S3b
//     (deferred, NOT built here).
//   • Token never touches the client: requests go through apiJson, which adds
//     the x-internal-token header; the Anthropic key stays server-side.
//   • Replay is best-effort: a turns-fetch failure degrades to the prior
//     in-memory-only behaviour (no error surfaced for the prefill path).

'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { memo, useCallback, useId, useRef, useState } from 'react';
import { DerivationPolicy, type DerivationPolicyT } from '@/core/schema/derivation-policy';
import { ApiAuthError, ApiError, apiJson } from '@/ui/lib/api';
import {
  DeferredMarkdownRenderer,
  preloadMarkdownRenderer,
} from '@/ui/lib/deferred-markdown-renderer';
import { randomId } from '@/ui/lib/random-id';
import {
  type CopilotOpenRequest,
  openCopilotForNudge,
  subscribeCopilotOpenRequests,
  useCopilotDwell,
} from '@/ui/lib/use-copilot-dwell';
import { Btn } from '@/ui/primitives/Btn';
import { Button } from '@/ui/primitives/Button';
import { CopilotDrawer } from '@/ui/primitives/CopilotDrawer';
import { IconBtn } from '@/ui/primitives/IconBtn';
import { LoomBadge } from '@/ui/primitives/LoomBadge';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import { ToolUseCard } from '@/ui/primitives/ToolUseCard';
import { isWithinCopilotReuseWindow } from '../session-reuse';
import { CopilotHeroCard } from './CopilotHeroCard';
import { type CopilotSessionListItem, CopilotSessionPanel } from './CopilotSessionPanel';
import {
  type CopilotSessionsResponse,
  type CopilotTurnsResponse,
  useCopilotClient,
} from './copilot-client';
import {
  type PersistedPendingCopilotRequestBody,
  type PersistedPendingCopilotTurn,
  clearPersistedPendingCopilotTurn,
  discardLegacyDurableCopilotReconnect,
  durableRunIdFromLocation,
  loadCopilotDerivationPreference,
  loadPersistedPendingCopilotTurns,
  persistPendingCopilotTurn,
  saveCopilotDerivationPreference,
} from './durable-reconnect-storage';
import { learnerGlobalBrief } from './learner-global-brief';
import {
  type ChatMessage,
  type ToolCallRecord,
  acceptPendingCopilotRun,
  copilotRunReplyMessageId,
  projectCopilotRunUpdate,
  projectPendingCopilotMessagePair,
  reconcileCopilotSnapshotMessages,
} from './message-projection';
import { nextNudgeSessionAfterTurn, resolveTurnAmbientFocus } from './nudge-focus';
import {
  type ReplaySkillContext as CopilotSkillContextT,
  type ReplaySubagentRun,
  type ReplayToolOperation,
  replayToMessages,
} from './replay';
import { restoreSkillContext } from './skill-lifecycle';
import {
  type CopilotRunView,
  DurablePickupStalledError,
  consumeDurableCopilotRun,
  createCopilotRunView,
} from './subtask-events';
import { useCopilotNudges } from './useCopilotNudges';

export type { ChatMessage, ToolCallRecord } from './message-projection';

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
    ? '任务还在等待开始，可能正在排队；本次请求已保留，可以稍后重新连接。'
    : '进度连接仍未恢复；任务可能仍在运行，可以再次连接。';
}

interface ActiveCopilotRun {
  runId: string;
  sessionId: string;
  location: string;
  userMessage?: string;
  derivationPolicy?: DerivationPolicyT;
  view: CopilotRunView;
  controller?: AbortController;
  connectionError?: string;
  stopPending: boolean;
  cancelRequested: boolean;
}

interface PendingCopilotTurn extends PersistedPendingCopilotTurn {
  dispatching: boolean;
  error?: string;
}

type CopilotProgressStage = 'dispatch' | 'generation' | 'evidence-review';

function isTerminalRunView(view: CopilotRunView): boolean {
  return view.phase === 'completed' || view.phase === 'failed';
}

const COPILOT_PROGRESS_LABELS: Record<CopilotProgressStage, string> = {
  dispatch: '准备中…',
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

function supportsAnswerOnly(policies: unknown): boolean {
  const parsed = DerivationPolicy.array().safeParse(policies);
  return parsed.success && parsed.data.includes('answer_only');
}

type CopilotSessionResponse = CopilotSessionsResponse['sessions'][number];

function hasServerTime(
  snapshot: CopilotSessionsResponse | undefined,
): snapshot is CopilotSessionsResponse {
  return snapshot !== undefined && Number.isFinite(Date.parse(snapshot.server_time));
}

/** Automatic selection may only land on a live session inside the reuse window. */
function isReusableSession(session: CopilotSessionResponse, serverNow: Date): boolean {
  return (
    (session.status === 'active' || session.status === 'idle') &&
    isWithinCopilotReuseWindow(session.updated_at, serverNow)
  );
}

/** Best-effort reads: a failure is already visible through the query's error state. */
function swallow(): undefined {
  return undefined;
}

const LEARNER_TOOL_LABELS: Readonly<Record<string, string>> = {
  query_mistakes: '错题整理',
  get_review_due: '复习安排',
  knowledge_mutation: '学习内容建议',
};

function learnerToolLabel(toolName: string): string {
  return LEARNER_TOOL_LABELS[toolName] ?? '学习辅助任务';
}

function subtaskErrorMessage(error: string | undefined): string {
  if (!error) return '这一步未能完成。';
  return error.replaceAll('子任务', '这一步');
}

type LifecycleStatus = ReplayToolOperation['status'] | ReplaySubagentRun['status'];

function lifecycleCardStatus(status: LifecycleStatus): 'running' | 'done' | 'failed' {
  if (status === 'running') return 'running';
  return status === 'succeeded' ? 'done' : 'failed';
}

function lifecycleErrorMessage(status: LifecycleStatus): string {
  if (status === 'cancelled') return '已取消。';
  if (status === 'lost') return '结果暂时无法确认，请查看回复后再试。';
  return '这一步未完成，请稍后再试。';
}

type ToolCallCardStatus = 'running' | 'done' | 'failed';

function toolCallCardStatus(call: ToolCallRecord): ToolCallCardStatus {
  if (call.status === 'failed') return 'failed';
  if (call.status === 'running') return 'running';
  return 'done';
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

function CopilotLifecycleCard({ toolName, status }: { toolName: string; status: LifecycleStatus }) {
  const cardStatus = lifecycleCardStatus(status);
  return (
    <ToolUseCard
      toolName={toolName}
      actor={null}
      status={cardStatus}
      running={<span>正在处理…</span>}
      result={<span>已完成，结果已整理到回复中。</span>}
      errorView={<span>{lifecycleErrorMessage(status)}</span>}
    />
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
        {m.derivation_policy === 'answer_only' && !m.idempotency_key ? (
          <LoomBadge tone="neutral">仅用于本次回答</LoomBadge>
        ) : null}
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
                  toolName="处理步骤"
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
                  errorView={<span>{subtaskErrorMessage(subtask.error)}</span>}
                />
              </div>
            ))}
          </div>
        ) : null}
        {m.role === 'ai' && m.tool_operations && m.tool_operations.length > 0 ? (
          <div className="flex flex-col gap-[6px]" data-testid="copilot-tool-operation-list">
            {m.tool_operations.map((operation) => (
              <div key={operation.id} data-testid="copilot-tool-operation-card">
                <CopilotLifecycleCard
                  toolName={learnerToolLabel(operation.tool_name)}
                  status={operation.status}
                />
              </div>
            ))}
          </div>
        ) : null}
        {m.role === 'ai' && m.subagent_runs && m.subagent_runs.length > 0 ? (
          <div className="flex flex-col gap-[6px]" data-testid="copilot-subagent-run-list">
            {m.subagent_runs.map((run) => (
              <div key={run.id} data-testid="copilot-subagent-run-card">
                <CopilotLifecycleCard toolName="处理步骤" status={run.status} />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
});

export function CopilotDock({ pathname, navigate }: CopilotDockProps) {
  // Transport seam (YUK-1473); read through a ref so the memoized callbacks below keep their deps.
  const copilotClient = useCopilotClient();
  const clientRef = useRef(copilotClient);
  clientRef.current = copilotClient;
  const queryClient = useQueryClient();
  // YUK-577 — proactive-nudge state. A pending nudge is rendered as a badge/bar; the drawer itself
  // opens only after the user clicks it. The legacy blind dwell/revisit auto-open path is gone.
  // RootShell reads the visible badge count from this same ['copilot','nudges'] query cache.
  const {
    nudges,
    dismiss: dismissNudge,
    markOpened,
    isMutating: nudgeMutating,
  } = useCopilotNudges();
  const {
    open,
    epoch: drawerEpoch,
    openDrawer,
    closeDrawer: closeDrawerDwell,
    currentVisit,
  } = useCopilotDwell();
  const summaryQ = useQuery({
    queryKey: ['copilot-summary'],
    queryFn: () => apiJson<CopilotSummary>('/api/today/copilot-summary'),
    enabled: open,
    refetchInterval: open ? 60_000 : false,
  });
  // Each opening owns a query key, so cached or late responses from another visit
  // can populate history but cannot authorize automatic reuse. The query is a
  // read-only view: fetches are explicit commands (loadVisitSessions), because a
  // fresh list is what decides automatic reuse or creation for the visit.
  const sessionQueryInstance = useId();
  const sessionsKey = useCallback(
    (epoch: number) => ['copilot-sessions', sessionQueryInstance, epoch] as const,
    [sessionQueryInstance],
  );
  const sessionsQ = useQuery({
    queryKey: sessionsKey(drawerEpoch),
    queryFn: ({ signal }) => clientRef.current.listSessions(signal),
    enabled: false,
    placeholderData: (previous) => previous,
  });
  // Last successful list, kept by the fetch command so history stays readable
  // when a later visit's read fails. Display only; never a reuse authorization.
  const [retainedSessions, setRetainedSessions] = useState<CopilotSessionResponse[]>([]);
  const freshSessions =
    open && sessionsQ.isSuccess && !sessionsQ.isPlaceholderData && hasServerTime(sessionsQ.data)
      ? sessionsQ.data
      : null;
  /** The current visit's fresh list as the query cache holds it right now. */
  const currentFreshSessions = useCallback((): CopilotSessionsResponse | null => {
    const visit = currentVisit();
    if (!visit.open) return null;
    const data = queryClient.getQueryData<CopilotSessionsResponse>(sessionsKey(visit.epoch));
    return data && hasServerTime(data) ? data : null;
  }, [currentVisit, queryClient, sessionsKey]);

  // Read from localStorage by the attach-time init command (initializeFromStorage).
  const [derivationPolicy, setDerivationPolicy] = useState<DerivationPolicyT>('allow');
  const derivationPolicyRef = useRef(derivationPolicy);
  derivationPolicyRef.current = derivationPolicy;
  // An explicit support check only stands for the visit and fresh list it was
  // made against; a new visit or a new fresh response falls back to the list's
  // own capability. An in-flight check always shows.
  const [policyCheck, setPolicyCheck] = useState<{
    result: 'checking' | 'unsupported' | 'supported';
    epoch: number;
    fresh: CopilotSessionsResponse | null;
  } | null>(null);
  const checkingPolicyRef = useRef(false);
  const recordPolicyCheck = useCallback(
    (result: 'checking' | 'unsupported' | 'supported') => {
      setPolicyCheck({ result, epoch: currentVisit().epoch, fresh: currentFreshSessions() });
    },
    [currentFreshSessions, currentVisit],
  );
  const policySupportCheck =
    policyCheck &&
    (policyCheck.result === 'checking' ||
      (policyCheck.epoch === drawerEpoch && policyCheck.fresh === freshSessions))
      ? policyCheck.result
      : null;
  const policySupport =
    policySupportCheck ??
    (freshSessions
      ? supportsAnswerOnly(freshSessions.supported_derivation_policies)
        ? 'supported'
        : 'unsupported'
      : sessionsQ.isError
        ? 'unsupported'
        : 'checking');
  // Pre-202 retry tuples are restored by the attach-time init command.
  // Writes go through setPendingTurns so pendingTurnsRef is current the moment a
  // turn is added or removed (isRecoveringSession reads it synchronously).
  const [pendingTurns, setPendingTurnsState] = useState<PendingCopilotTurn[]>([]);
  const pendingTurnsRef = useRef(pendingTurns);
  const setPendingTurns = useCallback(
    (next: PendingCopilotTurn[] | ((previous: PendingCopilotTurn[]) => PendingCopilotTurn[])) => {
      const value = typeof next === 'function' ? next(pendingTurnsRef.current) : next;
      pendingTurnsRef.current = value;
      setPendingTurnsState(value);
    },
    [],
  );
  // AF S4 / YUK-203 U6 — the active skill context (teaching/solve). When set, the
  // next turn(s) route to the skill (single-session model, §4.2). Held in a ref
  // so the composer's `send` reads the live value without re-creating `send`.
  // Lifecycle:
  //   SET   — when the open-with-context signal fires (cross-tree button click)
  //           OR when replay finds the last non-end skill turn with a
  //           skill_context (restores teaching continuity after page refresh).
  //   CLEAR — on closeDrawer, or when the skill returns kind==='end', so
  //           free-form turns after a session end are not re-routed to a stale
  //           skill. A replayed end turn correctly leaves the ref null.
  const activeSkillRef = useRef<CopilotSkillContextT | null>(null);
  // Every message write goes through updateMessages. Separate subscriptions may
  // observe FIFO terminals in different network order, so each write folds the
  // complete message order into the skill context: a later teaching end always
  // wins over an earlier turn regardless of callback arrival order.
  const [messages, setMessagesState] = useState<ChatMessage[]>([]);
  const messagesRef = useRef(messages);
  const updateMessages = useCallback(
    (next: ChatMessage[] | ((previous: ChatMessage[]) => ChatMessage[])) => {
      const value = typeof next === 'function' ? next(messagesRef.current) : next;
      if (value === messagesRef.current) return;
      messagesRef.current = value;
      activeSkillRef.current = restoreSkillContext(value, activeSkillRef.current);
      setMessagesState(value);
    },
    [],
  );
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [selectionOrigin, setSelectionOriginState] = useState<
    'automatic' | 'explicit' | 'recovery'
  >('automatic');
  const selectionOriginRef = useRef(selectionOrigin);
  const setSelectionOrigin = useCallback((origin: 'automatic' | 'explicit' | 'recovery') => {
    selectionOriginRef.current = origin;
    setSelectionOriginState(origin);
  }, []);
  const selectionRevisionRef = useRef(0);
  const automaticCreatedOpenRef = useRef<number | null>(null);
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;
  const [sessionPanelOpen, setSessionPanelOpen] = useState(false);
  const [creatingSession, setCreatingSessionState] = useState(false);
  const creatingSessionRef = useRef(false);
  const setCreatingSession = useCallback((creating: boolean) => {
    creatingSessionRef.current = creating;
    setCreatingSessionState(creating);
  }, []);
  const [optimisticSession, setOptimisticSessionState] = useState<CopilotSessionResponse | null>(
    null,
  );
  const optimisticSessionRef = useRef(optimisticSession);
  const setOptimisticSession = useCallback((session: CopilotSessionResponse | null) => {
    optimisticSessionRef.current = session;
    setOptimisticSessionState(session);
  }, []);
  const activeRunsRef = useRef(new Map<string, ActiveCopilotRun>());
  const snapshotRequestSeqRef = useRef(new Map<string, number>());
  const snapshotAppliedSeqRef = useRef(new Map<string, number>());
  const [, setRunRevision] = useState(0);
  const bumpRunRevision = useCallback(() => setRunRevision((revision) => revision + 1), []);
  const [error, setError] = useState<string | null>(null);
  // Per-checkpoint in-flight id for the revert POST (disables that row's button), and a
  // distinct "revert landed but the refresh failed" flag so a post-revert refetch error is
  // never surfaced as a revert failure (F5).
  const [revertPendingId, setRevertPendingId] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
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
  // YUK-577 — the ingestion session a nudge 「看看」opened, injected into ambient_context so the
  // user's first reply is context-aware ("about the material I just processed").
  const nudgeSessionRef = useRef<string | null>(null);

  const detachSubscriptions = useCallback(
    (sessionId?: string, notify = true) => {
      let changed = false;
      for (const run of activeRunsRef.current.values()) {
        if (sessionId && run.sessionId !== sessionId) continue;
        if (!run.controller) continue;
        const controller = run.controller;
        run.controller = undefined;
        controller.abort();
        changed = true;
      }
      if (changed && notify) bumpRunRevision();
    },
    [bumpRunRevision],
  );

  // AF S4 / YUK-203 U6 — wrap closeDrawer to also clear the active skill context
  // so that re-opening the Dock after closing does not resume a stale skill.
  const closeDrawer = useCallback(() => {
    // Closing is unsubscribe-only. Server-owned execution and queued successors
    // remain intact and will be rediscovered on the next snapshot.
    detachSubscriptions();
    activeSkillRef.current = null;
    nudgeSessionRef.current = null;
    // YUK-272 (C3) — also drop the quiz-chip's in-scope knowledge entity so a
    // re-open does not offer a quiz for a stale knowledge node.
    setFocusedKnowledgeId(null);
    correctionTargetRef.current = null;
    setCorrectionTarget(null);
    closeDrawerDwell();
  }, [closeDrawerDwell, detachSubscriptions]);
  const sessionBootstrapRef = useRef<number | null>(null);

  const pendingMessagesForSession = useCallback((sessionId: string): ChatMessage[] => {
    return pendingTurnsRef.current
      .filter((turn) => turn.requestBody.session_id === sessionId)
      .reduce<ChatMessage[]>(
        (current, turn) =>
          projectPendingCopilotMessagePair(current, {
            idempotencyKey: turn.idempotencyKey,
            sessionId,
            userMessageId: turn.userMessageId,
            aiMessageId: turn.aiMessageId,
            userMessage: turn.userMessage,
            derivationPolicy: turn.requestBody.derivation_policy ?? 'allow',
            dispatching: turn.dispatching,
          }),
        [],
      );
  }, []);

  /** Read the visit's session list (one cache entry per visit) and keep the last success. */
  const fetchVisitSessions = useCallback(
    async (epoch: number): Promise<CopilotSessionsResponse> => {
      const snapshot = await queryClient.fetchQuery({
        queryKey: sessionsKey(epoch),
        queryFn: ({ signal }) => clientRef.current.listSessions(signal),
        staleTime: 0,
        // Same retry budget the auto-fetching query had before this became a command.
        retry: 3,
      });
      setRetainedSessions(snapshot.sessions);
      return snapshot;
    },
    [queryClient, sessionsKey],
  );

  const isRecoveringSession = useCallback(
    (sessionId: string | null): boolean =>
      pendingTurnsRef.current.some((turn) => turn.requestBody.session_id === sessionId) ||
      [...activeRunsRef.current.values()].some(
        (run) =>
          run.sessionId === sessionId &&
          run.view.phase !== 'completed' &&
          run.view.phase !== 'failed',
      ),
    [],
  );

  const createConversation = useCallback(
    async (origin: 'automatic' | 'explicit' = 'explicit') => {
      if (creatingSessionRef.current) return;
      // YUK-1340 — bootstrap 可能异步开新对话；若发起后学员显式改选了别的会话，
      // 保留学员的选择，新会话只进列表，不抢占当前视图。
      const selectionAtRequest = ++selectionRevisionRef.current;
      const openAtRequest = currentVisit().epoch;
      if (origin === 'explicit') setSelectionOrigin('explicit');
      setCreatingSession(true);
      setError(null);
      try {
        const response = await clientRef.current.createSession();
        const visit = currentVisit();
        if (
          selectionRevisionRef.current === selectionAtRequest &&
          (origin === 'explicit' || (visit.open && visit.epoch === openAtRequest))
        ) {
          if (currentSessionIdRef.current) detachSubscriptions(currentSessionIdRef.current);
          activeSkillRef.current = null;
          setFocusedKnowledgeId(null);
          correctionTargetRef.current = null;
          setCorrectionTarget(null);
          updateMessages([]);
          currentSessionIdRef.current = response.session.id;
          setSelectionOrigin(origin);
          automaticCreatedOpenRef.current = origin === 'automatic' ? openAtRequest : null;
          setOptimisticSession(response.session);
          setCurrentSessionId(response.session.id);
        }
        // Re-read the list so the new session appears; once it is listed, an
        // automatic selection no longer needs its optimistic placeholder.
        const refreshEpoch = currentVisit().epoch;
        void fetchVisitSessions(refreshEpoch).then((snapshot) => {
          const optimistic = optimisticSessionRef.current;
          if (
            selectionOriginRef.current === 'automatic' &&
            optimistic &&
            optimistic.id === currentSessionIdRef.current &&
            snapshot.sessions.some((session) => session.id === optimistic.id)
          ) {
            setOptimisticSession(null);
            sessionBootstrapRef.current = null;
          }
        }, swallow);
      } catch (err) {
        setError(err instanceof Error ? err.message : '新对话创建失败');
      } finally {
        setCreatingSession(false);
      }
    },
    [
      currentVisit,
      detachSubscriptions,
      fetchVisitSessions,
      setCreatingSession,
      setOptimisticSession,
      setSelectionOrigin,
      updateMessages,
    ],
  );

  const selectConversation = useCallback(
    (sessionId: string, origin: 'automatic' | 'explicit' = 'explicit') => {
      selectionRevisionRef.current += 1;
      setSelectionOrigin(origin);
      const previousSessionId = currentSessionIdRef.current;
      if (previousSessionId && previousSessionId !== sessionId) {
        detachSubscriptions(previousSessionId);
      }
      activeSkillRef.current = null;
      setFocusedKnowledgeId(null);
      correctionTargetRef.current = null;
      setCorrectionTarget(null);
      updateMessages(pendingMessagesForSession(sessionId));
      setOptimisticSession(null);
      setError(null);
      currentSessionIdRef.current = sessionId;
      setCurrentSessionId(sessionId);
    },
    [
      detachSubscriptions,
      pendingMessagesForSession,
      setOptimisticSession,
      setSelectionOrigin,
      updateMessages,
    ],
  );

  // A visit's fresh list arrived: keep a still-reusable automatic selection, else
  // resume the newest reusable session, else create one session for this visit.
  // Explicit and recovery selections are never overridden.
  const bootstrapVisitSession = useCallback(
    function bootstrap(epoch: number, snapshot: CopilotSessionsResponse): void {
      const visit = currentVisit();
      if (!visit.open || visit.epoch !== epoch || !hasServerTime(snapshot)) return;
      if (selectionOriginRef.current !== 'automatic') return;
      const sessionId = currentSessionIdRef.current;
      if (isRecoveringSession(sessionId)) return;
      const serverNow = new Date(snapshot.server_time);
      const optimistic = optimisticSessionRef.current;
      const automaticSession =
        snapshot.sessions.find((session) => session.id === sessionId) ??
        (automaticCreatedOpenRef.current === epoch ? optimistic : null);
      if (automaticSession && isReusableSession(automaticSession, serverNow)) {
        if (optimistic && snapshot.sessions.some((session) => session.id === optimistic.id)) {
          setOptimisticSession(null);
        }
        sessionBootstrapRef.current = null;
        return;
      }
      if (creatingSessionRef.current) return;
      const resumable = snapshot.sessions.find((session) => isReusableSession(session, serverNow));
      if (resumable) {
        sessionBootstrapRef.current = null;
        selectConversation(resumable.id, 'automatic');
        return;
      }
      if (sessionBootstrapRef.current === epoch) return;
      sessionBootstrapRef.current = epoch;
      // When the create settles (even if a reopen made its result stale),
      // re-check the visit that is open now. The per-visit guard above still
      // allows at most one automatic create per visit.
      void createConversation('automatic').finally(() => {
        const current = currentVisit();
        const fresh = currentFreshSessions();
        if (current.open && fresh) bootstrap(current.epoch, fresh);
      });
    },
    [
      createConversation,
      currentFreshSessions,
      currentVisit,
      isRecoveringSession,
      selectConversation,
      setOptimisticSession,
    ],
  );

  /** Fresh read for a visit (open, or the retry button), then automatic selection. */
  const loadVisitSessions = useCallback(
    (epoch: number) => {
      void fetchVisitSessions(epoch).then(
        (snapshot) => bootstrapVisitSession(epoch, snapshot),
        swallow,
      );
    },
    [bootstrapVisitSession, fetchVisitSessions],
  );

  // A recovery or pending turn just ended: the automatic selection is no longer
  // carried by "recovering", so re-run the visit's bootstrap against the visit's
  // fresh list (keep it, resume another reusable session, or create once).
  const revalidateAutomaticSelection = useCallback(() => {
    const visit = currentVisit();
    const fresh = currentFreshSessions();
    if (visit.open && fresh) bootstrapVisitSession(visit.epoch, fresh);
  }, [bootstrapVisitSession, currentFreshSessions, currentVisit]);

  const prepareAndOpenDrawer = useCallback(() => {
    preloadMarkdownRenderer();
    const epoch = openDrawer();
    if (epoch !== null) loadVisitSessions(epoch);
  }, [loadVisitSessions, openDrawer]);

  const listedSessions = sessionsQ.data?.sessions ?? retainedSessions;
  const visibleSessions =
    optimisticSession && !listedSessions.some((session) => session.id === optimisticSession.id)
      ? [optimisticSession, ...listedSessions]
      : listedSessions;
  const selectedSession = visibleSessions.find((session) => session.id === currentSessionId);
  const recoveringCurrentSession =
    pendingTurns.some((turn) => turn.requestBody.session_id === currentSessionId) ||
    [...activeRunsRef.current.values()].some(
      (run) =>
        run.sessionId === currentSessionId &&
        run.view.phase !== 'completed' &&
        run.view.phase !== 'failed',
    );
  const automaticSession =
    freshSessions?.sessions.find((session) => session.id === currentSessionId) ??
    (automaticCreatedOpenRef.current === drawerEpoch ? optimisticSession : null);
  const selectionValidated =
    selectionOrigin !== 'automatic' ||
    recoveringCurrentSession ||
    Boolean(
      freshSessions &&
        automaticSession &&
        isReusableSession(automaticSession, new Date(freshSessions.server_time)),
    );
  const selectionValidatedRef = useRef(selectionValidated);
  selectionValidatedRef.current = selectionValidated;
  const conversationReady =
    !creatingSession &&
    selectionValidated &&
    (selectedSession?.status === 'active' || selectedSession?.status === 'idle');

  // Fold explicit mode transitions oldest→newest, including end barriers. The
  // quiz chip independently keeps the latest in-scope knowledge entity. A full
  // post-revert refresh resets both before restoring the remaining history.
  const restoreSkillStateFromReplay = useCallback(
    (replayed: ReturnType<typeof replayToMessages>) => {
      activeSkillRef.current = restoreSkillContext(replayed, activeSkillRef.current);
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

  const applyRunViewToMessage = useCallback(
    (run: ActiveCopilotRun) => {
      // A detached/background session may still finish a delayed acceptance or
      // callback. Keep its server-owned handle, but never project it into the
      // currently selected conversation or mutate that conversation's mode.
      if (currentSessionIdRef.current !== run.sessionId) return;
      const terminal = run.view.phase === 'completed' || run.view.phase === 'failed';
      const fallbackText =
        run.view.phase === 'queued'
          ? '正在等待处理这次请求。'
          : run.view.phase === 'cancel_requested' || run.cancelRequested
            ? '正在停止这次运行。'
            : '正在处理你的请求，结果会在这里显示。';
      updateMessages((previous) =>
        projectCopilotRunUpdate(previous, {
          runId: run.runId,
          sessionId: run.sessionId,
          view: run.view,
          derivationPolicy: run.derivationPolicy,
          fallbackText,
          ...(run.userMessage ? { userMessage: run.userMessage } : {}),
        }),
      );
      if (run.view.phase === 'completed') {
        nudgeSessionRef.current = nextNudgeSessionAfterTurn(nudgeSessionRef.current, true);
      }
      if (terminal) run.connectionError = undefined;
    },
    [updateMessages],
  );

  const reportSendError = useCallback((message: string) => {
    setRefreshFailed(false);
    setError(message);
  }, []);

  const subscribeRun = useCallback(
    (runId: string) => {
      const run = activeRunsRef.current.get(runId);
      if (
        !run ||
        run.controller ||
        run.view.phase === 'completed' ||
        run.view.phase === 'failed' ||
        !currentVisit().open ||
        currentSessionIdRef.current !== run.sessionId
      ) {
        return;
      }
      const controller = new AbortController();
      run.controller = controller;
      run.connectionError = undefined;
      bumpRunRevision();
      void consumeDurableCopilotRun({
        location: run.location,
        fetchResponse: (input, init) => clientRef.current.fetchRunEvents(input, init),
        initialState: run.view,
        signal: controller.signal,
        onUpdate: (view) => {
          const current = activeRunsRef.current.get(runId);
          if (!current || current.controller !== controller) return;
          current.view = view;
          applyRunViewToMessage(current);
          bumpRunRevision();
          if (isTerminalRunView(view)) revalidateAutomaticSelection();
        },
      })
        .then((view) => {
          const current = activeRunsRef.current.get(runId);
          if (!current || current.controller !== controller) return;
          current.view = view;
          applyRunViewToMessage(current);
          if (isTerminalRunView(view)) revalidateAutomaticSelection();
        })
        .catch((cause) => {
          const current = activeRunsRef.current.get(runId);
          if (!current || current.controller !== controller || controller.signal.aborted) return;
          current.connectionError = durableReconnectErrorMessage(cause);
          updateMessages((previous) =>
            previous.map((message) =>
              message.id === copilotRunReplyMessageId(runId)
                ? { ...message, streaming: false }
                : message,
            ),
          );
        })
        .finally(() => {
          const current = activeRunsRef.current.get(runId);
          if (current?.controller === controller) current.controller = undefined;
          bumpRunRevision();
        });
    },
    [
      applyRunViewToMessage,
      bumpRunRevision,
      currentVisit,
      revalidateAutomaticSelection,
      updateMessages,
    ],
  );

  const synchronizeSnapshot = useCallback(
    (
      sessionId: string,
      snapshot: CopilotTurnsResponse,
      runsKnownWhenRequested: ReadonlySet<string>,
    ) => {
      if (snapshot.session_id !== null && snapshot.session_id !== sessionId) return;
      const replayed = replayToMessages(snapshot.turns ?? []);
      const activeRunIds = new Set<string>();
      for (const item of snapshot.active_runs ?? []) {
        if (item.session_id !== sessionId) continue;
        if (durableRunIdFromLocation(item.events_url) !== item.run_id) continue;
        activeRunIds.add(item.run_id);
        const userMessage = replayed.find(
          (message) => message.role === 'user' && message.id === item.run_id,
        )?.text;
        const existing = activeRunsRef.current.get(item.run_id);
        if (existing) {
          existing.location = item.events_url;
          existing.derivationPolicy = item.derivation_policy ?? 'allow';
          if (userMessage) existing.userMessage = userMessage;
          if (item.status === 'cancel_requested') existing.cancelRequested = true;
        } else {
          const view = createCopilotRunView();
          if (item.status === 'started' || item.status === 'running') view.phase = 'running';
          if (item.status === 'cancel_requested') view.phase = 'cancel_requested';
          activeRunsRef.current.set(item.run_id, {
            runId: item.run_id,
            sessionId,
            location: item.events_url,
            derivationPolicy: item.derivation_policy ?? 'allow',
            ...(userMessage ? { userMessage } : {}),
            view,
            stopPending: false,
            cancelRequested: item.status === 'cancel_requested',
          });
        }
      }

      for (const [runId, run] of activeRunsRef.current) {
        if (
          run.sessionId !== sessionId ||
          activeRunIds.has(runId) ||
          !runsKnownWhenRequested.has(runId)
        ) {
          continue;
        }
        run.controller?.abort();
        activeRunsRef.current.delete(runId);
      }
      const retainedRunIds = new Set(activeRunIds);
      for (const run of activeRunsRef.current.values()) {
        if (run.sessionId === sessionId && !runsKnownWhenRequested.has(run.runId)) {
          retainedRunIds.add(run.runId);
        }
      }
      // Restore the replayed mode first; updateMessages then folds the full
      // reconciled order (including retained live runs) on top of it.
      restoreSkillStateFromReplay(replayed);
      updateMessages((previous) => {
        let next = reconcileCopilotSnapshotMessages(previous, replayed, sessionId, retainedRunIds);
        for (const runId of retainedRunIds) {
          const run = activeRunsRef.current.get(runId);
          if (!run) continue;
          const fallbackText =
            run.view.phase === 'queued'
              ? '正在等待处理这次请求。'
              : run.cancelRequested
                ? '正在停止这次运行。'
                : '正在处理你的请求，结果会在这里显示。';
          next = projectCopilotRunUpdate(next, {
            runId,
            sessionId,
            view: run.view,
            derivationPolicy: run.derivationPolicy,
            fallbackText,
            ...(run.userMessage ? { userMessage: run.userMessage } : {}),
          });
        }
        return next;
      });
      bumpRunRevision();
      for (const runId of retainedRunIds) subscribeRun(runId);
      // Runs the snapshot no longer lists were just dropped; recovery may be over.
      revalidateAutomaticSelection();
    },
    [
      bumpRunRevision,
      restoreSkillStateFromReplay,
      revalidateAutomaticSelection,
      subscribeRun,
      updateMessages,
    ],
  );

  const refetchTurns = useCallback(async (): Promise<boolean> => {
    const sessionId = currentSessionIdRef.current;
    if (!sessionId) return false;
    const requestSequence = (snapshotRequestSeqRef.current.get(sessionId) ?? 0) + 1;
    snapshotRequestSeqRef.current.set(sessionId, requestSequence);
    const runsKnownWhenRequested = new Set(
      [...activeRunsRef.current.values()]
        .filter((run) => run.sessionId === sessionId)
        .map((run) => run.runId),
    );
    const snapshot = await clientRef.current.listTurns(sessionId, REPLAY_LIMIT);
    if (currentSessionIdRef.current !== sessionId) return false;
    if ((snapshotAppliedSeqRef.current.get(sessionId) ?? 0) >= requestSequence) return false;
    snapshotAppliedSeqRef.current.set(sessionId, requestSequence);
    synchronizeSnapshot(sessionId, snapshot, runsKnownWhenRequested);
    return true;
  }, [synchronizeSnapshot]);

  // While the drawer shows a validated session, Query owns the read schedule:
  // an immediate read when the session (or drawer) becomes visible, then every
  // 5s. Each read applies its snapshot through refetchTurns (per-session request
  // order + runsKnownWhenRequested). Run streams are detached by the commands
  // that leave the view: closeDrawer, selectConversation, createConversation and
  // the Dock's detach. A failed read is retried by the next tick, as before.
  useQuery({
    queryKey: ['copilot-turns', sessionQueryInstance, currentSessionId],
    queryFn: () => refetchTurns().catch(() => false),
    enabled: open && currentSessionId !== null && selectionValidated,
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: false,
    retry: false,
    gcTime: 0,
  });

  const revertCheckpoint = useCallback(
    async (checkpointEventId: string) => {
      setRevertPendingId(checkpointEventId);
      setError(null);
      setRefreshFailed(false);
      try {
        try {
          await clientRef.current.revertCheckpoint(checkpointEventId);
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
          // A successful revert may have removed the skill-owning turn. Reset
          // before the authoritative snapshot rebuilds the remaining state.
          activeSkillRef.current = null;
          setFocusedKnowledgeId(null);
          await refetchTurns();
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
      activeSkillRef.current = null;
      setFocusedKnowledgeId(null);
      const refreshed = await refetchTurns();
      if (refreshed) {
        setRefreshFailed(false);
      }
    } catch {
      // Keep the banner up; the revert is already durable, only the refresh is still failing.
    }
  }, [refetchTurns]);

  const stopDurableRun = useCallback(
    async (runId: string) => {
      const run = activeRunsRef.current.get(runId);
      if (!run || run.stopPending || run.cancelRequested) return;
      run.stopPending = true;
      bumpRunRevision();
      try {
        const result = await clientRef.current.cancelRun(runId);
        if (result.run_id !== runId) throw new Error('stop response run mismatch');
        if (result.status === 'already_settled') {
          await refetchTurns().catch(() => undefined);
          return;
        }
        run.cancelRequested = true;
        applyRunViewToMessage(run);
        // Keep the per-run subscription attached until the durable cancelled
        // terminal arrives; Stop is not a transport abort.
      } catch (err) {
        reportSendError(
          err instanceof ApiError ? `停止失败（${err.status}）` : '停止失败，请稍后重试。',
        );
      } finally {
        const current = activeRunsRef.current.get(runId);
        if (current) current.stopPending = false;
        bumpRunRevision();
      }
    },
    [applyRunViewToMessage, bumpRunRevision, refetchTurns, reportSendError],
  );

  // Stick-to-bottom for the message stream. The stream node exists only while
  // the drawer is open and owns its observers. While the reader is at (or
  // within 48px of) the bottom, a row added/removed or the LAST row growing
  // (streaming text, terminal replacement, late Markdown, images) keeps it at
  // the end; once they scroll up to read, nothing pulls them down. Expanding an
  // older row never scrolls. The learner's own send re-sticks (see send).
  const stickToBottomRef = useRef(true);
  const attachStream = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const scrollToEnd = () => {
      node.scrollTop = node.scrollHeight;
    };
    const onScroll = () => {
      stickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 48;
    };
    const resize = new ResizeObserver((entries) => {
      if (!stickToBottomRef.current) return;
      if (entries.some((entry) => entry.target === node.lastElementChild)) scrollToEnd();
    });
    for (const child of node.children) resize.observe(child);
    const rows = new MutationObserver((records) => {
      for (const record of records) {
        for (const added of record.addedNodes) {
          if (added instanceof Element) resize.observe(added);
        }
        for (const removed of record.removedNodes) {
          if (removed instanceof Element) resize.unobserve(removed);
        }
      }
      if (stickToBottomRef.current) scrollToEnd();
    });
    rows.observe(node, { childList: true });
    node.addEventListener('scroll', onScroll, { passive: true });
    stickToBottomRef.current = true;
    scrollToEnd();
    return () => {
      node.removeEventListener('scroll', onScroll);
      rows.disconnect();
      resize.disconnect();
    };
  }, []);

  const send = useCallback(
    async (raw: string, recovery?: PersistedPendingCopilotTurn) => {
      const text = recovery?.userMessage ?? raw.trim();
      const selectedSessionId = recovery?.requestBody.session_id ?? currentSessionIdRef.current;
      if (!text || (!recovery && !selectionValidatedRef.current)) return;
      if (!selectedSessionId) {
        setError('对话仍在加载，请稍后再试。');
        return;
      }
      const idempotencyKey = recovery?.idempotencyKey ?? randomId();
      const userMessageId = recovery?.userMessageId ?? nextId();
      const aiMessageId = recovery?.aiMessageId ?? nextId();
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
      const requestBody: PersistedPendingCopilotRequestBody = recovery?.requestBody ?? {
        session_id: selectedSessionId,
        user_message: text,
        derivation_policy: derivationPolicyRef.current,
        triggered_by: 'chat' as const,
        ...(currentSkillContext && derivationPolicyRef.current === 'allow'
          ? { skill_context: currentSkillContext }
          : {}),
        ...(ambientContext ? { ambient_context: ambientContext } : {}),
        ...(selectedCorrectionTarget
          ? { correction_target_turn_id: selectedCorrectionTarget.turnId }
          : {}),
      };
      if (requestBody.derivation_policy === 'answer_only') {
        if (checkingPolicyRef.current) return;
        checkingPolicyRef.current = true;
        recordPolicyCheck('checking');
        try {
          // Read the current server before every dispatch, including original-key
          // retries. A previous drawer query cannot authorize restricted content.
          const current = await clientRef.current.listSessions();
          if (!supportsAnswerOnly(current.supported_derivation_policies)) {
            throw new Error('answer_only unsupported');
          }
          recordPolicyCheck('supported');
        } catch {
          recordPolicyCheck('unsupported');
          const message =
            '当前服务器不支持“仅用于本次回答”，或支持信息暂时无法确认。本次未发送，原内容已保留。';
          setError(message);
          if (recovery) {
            setPendingTurns((previous) =>
              previous.map((turn) =>
                turn.idempotencyKey === idempotencyKey
                  ? { ...turn, dispatching: false, error: message }
                  : turn,
              ),
            );
          }
          return;
        } finally {
          checkingPolicyRef.current = false;
        }
      }
      const pending: PendingCopilotTurn = {
        v: 2,
        idempotencyKey,
        userMessageId,
        aiMessageId,
        userMessage: text,
        requestBody,
        dispatching: true,
      };
      persistPendingCopilotTurn(pending);
      setPendingTurns((previous) =>
        previous.some((turn) => turn.idempotencyKey === idempotencyKey)
          ? previous.map((turn) => (turn.idempotencyKey === idempotencyKey ? pending : turn))
          : [...previous, pending],
      );
      setError(null);
      setRefreshFailed(false);
      setInput((current) => (!recovery && current === raw ? '' : current));
      correctionTargetRef.current = null;
      setCorrectionTarget(null);
      // The learner's own message always brings the stream back to the bottom.
      stickToBottomRef.current = true;
      updateMessages((previous) =>
        projectPendingCopilotMessagePair(previous, {
          idempotencyKey,
          sessionId: selectedSessionId,
          userMessageId,
          aiMessageId,
          userMessage: text,
          derivationPolicy: requestBody.derivation_policy ?? 'allow',
          dispatching: true,
        }),
      );
      try {
        const res = await clientRef.current.sendChat(requestBody, idempotencyKey);
        if (res.status !== 202) {
          throw new Error(`Copilot acceptance protocol failed (${res.status}); retry the same key`);
        }
        let acceptedPolicy: DerivationPolicyT = 'allow';
        let acceptedBody: unknown;
        let responseRunId: string | undefined;
        try {
          acceptedBody = await res.json();
        } catch {
          // Legacy allow responses can recover through Location and server snapshot.
        }
        if (acceptedBody !== null && typeof acceptedBody === 'object') {
          if ('run_id' in acceptedBody && typeof acceptedBody.run_id === 'string')
            responseRunId = acceptedBody.run_id;
          if ('derivation_policy' in acceptedBody) {
            const policy = DerivationPolicy.safeParse(acceptedBody.derivation_policy);
            if (!policy.success) throw new Error('受理用途暂时无法确认，请用原请求恢复。');
            acceptedPolicy = policy.data;
          }
        }
        if (requestBody.derivation_policy === 'answer_only' && acceptedPolicy !== 'answer_only') {
          throw new Error('受理用途暂时无法确认，请用原请求恢复。');
        }
        let location = res.headers.get('Location');
        let runId = durableRunIdFromLocation(location);
        if (!runId && responseRunId) {
          const reconstructed = `/api/jobs/copilot_run/${encodeURIComponent(responseRunId)}/events`;
          if (durableRunIdFromLocation(reconstructed) === responseRunId) {
            runId = responseRunId;
            location = reconstructed;
          }
        }
        if (!runId || !location) {
          throw new Error('请求可能已受理，但响应缺少稳定句柄；请用原请求恢复。');
        }

        clearPersistedPendingCopilotTurn(idempotencyKey);
        setPendingTurns((previous) =>
          previous.filter((turn) => turn.idempotencyKey !== idempotencyKey),
        );
        updateMessages((previous) =>
          currentSessionIdRef.current === selectedSessionId
            ? acceptPendingCopilotRun(previous, {
                idempotencyKey,
                sessionId: selectedSessionId,
                runId,
                derivationPolicy: acceptedPolicy,
              })
            : previous,
        );
        const run = activeRunsRef.current.get(runId) ?? {
          runId,
          sessionId: selectedSessionId,
          location,
          userMessage: text,
          view: createCopilotRunView(),
          stopPending: false,
          cancelRequested: false,
        };
        run.location = location;
        run.userMessage = text;
        run.derivationPolicy = acceptedPolicy;
        activeRunsRef.current.set(runId, run);
        applyRunViewToMessage(run);
        bumpRunRevision();
        subscribeRun(runId);
        revalidateAutomaticSelection();
      } catch (err) {
        const acceptanceUnknown =
          (!(err instanceof ApiError) && !(err instanceof ApiAuthError)) ||
          (err instanceof ApiError && err.code === 'copilot_enqueue_ambiguous');
        if (!acceptanceUnknown) {
          clearPersistedPendingCopilotTurn(idempotencyKey);
          setPendingTurns((previous) =>
            previous.filter((turn) => turn.idempotencyKey !== idempotencyKey),
          );
          updateMessages((previous) =>
            previous.map((message) =>
              message.idempotency_key === idempotencyKey && message.role === 'ai'
                ? {
                    ...message,
                    text:
                      err instanceof ApiError
                        ? `请求失败（${err.status}）`
                        : '访问令牌已失效，请重新输入。',
                    streaming: false,
                    idempotency_key: undefined,
                    derivation_policy: undefined,
                  }
                : message.idempotency_key === idempotencyKey
                  ? { ...message, idempotency_key: undefined, derivation_policy: undefined }
                  : message,
            ),
          );
          reportSendError(
            err instanceof ApiError ? `请求失败（${err.status}）` : '访问令牌已失效，请重新输入。',
          );
          revalidateAutomaticSelection();
          return;
        }
        const message = err instanceof Error ? err.message : '请求受理状态暂时无法确认。';
        setPendingTurns((previous) =>
          previous.map((turn) =>
            turn.idempotencyKey === idempotencyKey
              ? { ...turn, dispatching: false, error: message }
              : turn,
          ),
        );
        updateMessages((previous) =>
          previous.map((item) =>
            item.idempotency_key === idempotencyKey && item.role === 'ai'
              ? { ...item, text: '受理状态暂时无法确认。', streaming: false }
              : item,
          ),
        );
      }
    },
    [
      applyRunViewToMessage,
      bumpRunRevision,
      recordPolicyCheck,
      reportSendError,
      revalidateAutomaticSelection,
      setPendingTurns,
      subscribeRun,
      updateMessages,
    ],
  );

  const retryPendingTurn = useCallback(
    (idempotencyKey: string) => {
      const pending = pendingTurnsRef.current.find(
        (turn) => turn.idempotencyKey === idempotencyKey,
      );
      if (pending && !pending.dispatching) void send(pending.userMessage, pending);
    },
    [send],
  );

  const discardPendingRecovery = useCallback(
    (idempotencyKey: string) => {
      clearPersistedPendingCopilotTurn(idempotencyKey);
      setPendingTurns((previous) =>
        previous.filter((turn) => turn.idempotencyKey !== idempotencyKey),
      );
      updateMessages((previous) =>
        previous.filter((message) => message.idempotency_key !== idempotencyKey),
      );
      revalidateAutomaticSelection();
    },
    [revalidateAutomaticSelection, setPendingTurns, updateMessages],
  );

  const reconnectRun = useCallback(
    (runId: string) => {
      const run = activeRunsRef.current.get(runId);
      if (!run) return;
      run.connectionError = undefined;
      updateMessages((previous) =>
        previous.map((message) =>
          message.id === copilotRunReplyMessageId(runId)
            ? { ...message, streaming: true }
            : message,
        ),
      );
      subscribeRun(runId);
      bumpRunRevision();
    },
    [bumpRunRevision, subscribeRun, updateMessages],
  );

  // YUK-272 (C3) — quiz quick-chip. When a knowledge node is in scope, seed a quiz
  // skill turn with that real id; `send` clears context only on explicit server
  // end state. ADR-0031 / YUK-304 retired the hard quiz intercept, so without a
  // focused node the same user-readable prompt deliberately follows normal Copilot
  // routing and lets the model clarify/orchestrate instead of becoming a dead chip.
  const sendQuiz = useCallback(() => {
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

  // AF S4 / YUK-203 U6 — handle one cross-tree open-with-context request. A button
  // in another subtree (learning-items 「对话教学」, practice handoff, a nudge)
  // publishes it; the Dock claims it exactly once (see attachDock), adopts the
  // skill context, opens, and sends a prefill through the original send path.
  const handleOpenRequest = useCallback(
    (request: CopilotOpenRequest) => {
      activeSkillRef.current = request.skill_context ?? null;
      // YUK-272 (C3) — if the open-with-context signal carried a knowledge entity,
      // expose it as the quiz-chip's in-scope knowledge id. YUK-266 — else CLEAR it:
      // without this, opening the Dock with a non-knowledge context (e.g. a learning
      // item) after a prior knowledge open would leave the stale knowledge id, so the
      // quiz chip stays enabled and would generate a quiz for a no-longer-in-scope
      // knowledge node.
      if (request.skill_context?.ref.kind === 'knowledge') {
        setFocusedKnowledgeId(request.skill_context.ref.id);
      } else {
        setFocusedKnowledgeId(null);
      }
      // YUK-577 — nudge 「看看」open: the deterministic headline IS the agent opening turn (seeded
      // client-side as an `ai` message — never an owner user bubble, MF1 / A3:88). Remember the
      // ingestion session so the user's reply carries it in ambient_context. Only seed into an empty
      // stream (never clobber an in-progress conversation).
      if (request.nudge) {
        const n = request.nudge;
        nudgeSessionRef.current = n.session_id;
        updateMessages((prev) =>
          prev.length === 0 ? [{ id: nextId(), role: 'ai', text: n.headline }] : prev,
        );
      }
      prepareAndOpenDrawer();
      const prefill = request.prefill;
      if (!prefill) return;
      if (request.prefill_mode !== 'compose' && selectionValidatedRef.current) {
        // Every turn is independently accepted and server-serialized, so a
        // cross-surface handoff can be sent while earlier work is still active.
        void send(prefill);
      } else {
        // Compose-only handoffs (the practice ask) never auto-send, and a 'send'
        // handoff on a cold open cannot be sent yet. Either way the text goes to
        // the composer, appended so an unsent draft is never overwritten.
        setInput((current) => (current.trim() ? `${current}\n${prefill}` : prefill));
      }
    },
    [prepareAndOpenDrawer, send, updateMessages],
  );

  // Attach-time init command: restore the browser-owned state once per Dock
  // instance (the derivation preference and every exact pre-202 retry tuple).
  // Accepted v1 handles are intentionally ignored: the server snapshot is the
  // only accepted-run inventory. Nothing auto-retries here; the learner chooses
  // 恢复 (same key + body + message ids) or 不再恢复.
  const storageInitializedRef = useRef(false);
  const initializeFromStorage = useCallback(() => {
    if (storageInitializedRef.current) return;
    storageInitializedRef.current = true;
    setDerivationPolicy(loadCopilotDerivationPreference());
    discardLegacyDurableCopilotReconnect();
    const restored = loadPersistedPendingCopilotTurns();
    const recoverySessionId = restored.at(-1)?.requestBody.session_id;
    if (!recoverySessionId) return;
    const turns: PendingCopilotTurn[] = restored.map((turn) => ({
      ...turn,
      dispatching: false,
      error: '这次请求的受理状态还不能确认；恢复时会复用原请求，不会创建第二次执行。',
    }));
    setPendingTurns(turns);
    updateMessages(pendingMessagesForSession(recoverySessionId));
    currentSessionIdRef.current = recoverySessionId;
    setCurrentSessionId(recoverySessionId);
    setSelectionOrigin('recovery');
    const recoveredAt = new Date().toISOString();
    setOptimisticSession({
      id: recoverySessionId,
      status: 'active',
      title: '正在恢复的对话',
      created_at: recoveredAt,
      updated_at: recoveredAt,
    });
  }, [
    pendingMessagesForSession,
    setOptimisticSession,
    setPendingTurns,
    setSelectionOrigin,
    updateMessages,
  ]);

  // The Dock's always-present root node (the launcher wrapper) owns the Dock's
  // browser lifetime: attach restores storage and starts claiming open requests;
  // detach unsubscribes and stops reading run streams without notifying the
  // gone view. Detach never sends a cancel — only Stop does.
  const attachDock = useCallback(
    (node: HTMLSpanElement | null) => {
      if (!node) return;
      initializeFromStorage();
      const unsubscribe = subscribeCopilotOpenRequests(handleOpenRequest);
      return () => {
        unsubscribe();
        detachSubscriptions(undefined, false);
      };
    },
    [detachSubscriptions, handleOpenRequest, initializeFromStorage],
  );

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
            <p className="flex-1 text-[14px] text-[var(--ink)] leading-[1.5]">{n.headline}</p>
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
        <p className="text-[14px] text-[var(--ink-2)]" data-testid="copilot-summary-review-due">
          今日待复习 <strong>{summaryQ.data.review_due_count}</strong> 题
        </p>
      ) : null}
      {learnerBriefGlobal ? (
        <p
          className="text-[14px] text-[var(--ink-3)] italic leading-[1.5]"
          data-testid="copilot-summary-brief-global"
        >
          {learnerBriefGlobal}
        </p>
      ) : null}
      {summaryQ.data.dreaming_preview.length > 0 ? (
        <ul className="list-disc list-inside text-[14px] text-[var(--ink-2)]">
          {summaryQ.data.dreaming_preview.map((row) => (
            <li key={row.proposal_id}>{row.brief}</li>
          ))}
        </ul>
      ) : null}
      {summaryQ.data.pending_proposals_total > 0 ? (
        <p className="text-[14px] text-[var(--ink-3)]">更多建议已整理到收件箱。</p>
      ) : null}
    </div>
  ) : summaryQ.isLoading ? (
    <p className="text-[14px] text-[var(--ink-3)]">加载摘要…</p>
  ) : (
    <p className="text-[14px] text-[var(--ink-3)]">摘要暂不可用。</p>
  );

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
  const currentRuns = [...activeRunsRef.current.values()].filter(
    (run) =>
      run.sessionId === currentSessionId &&
      run.view.phase !== 'completed' &&
      run.view.phase !== 'failed',
  );
  const currentPendingTurns = pendingTurns.filter(
    (turn) => turn.requestBody.session_id === currentSessionId,
  );
  const sending =
    currentPendingTurns.some((turn) => turn.dispatching) ||
    currentRuns.some((run) => run.controller !== undefined);

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
          disabled={false}
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
      {currentRuns.map((run) => (
        <div
          key={run.runId}
          className="mb-[8px] flex items-center justify-between gap-[8px]"
          data-run-id={run.runId}
          data-run-status={run.cancelRequested ? 'cancel_requested' : run.view.phase}
        >
          <span className="text-[14px] text-[var(--ink-3)]" data-testid="copilot-run-stage-footer">
            {run.cancelRequested
              ? '停止中…'
              : COPILOT_PROGRESS_LABELS[copilotProgressStage(run.view)]}
          </span>
          <Btn
            variant="ghost"
            size="sm"
            aria-label={`停止这次运行 ${run.runId}`}
            data-testid="copilot-stop-run"
            disabled={run.stopPending || run.cancelRequested}
            onClick={() => void stopDurableRun(run.runId)}
          >
            {run.stopPending || run.cancelRequested ? '停止中…' : '停止'}
          </Btn>
        </div>
      ))}
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
      {/* YUK-1340 — 会话不可继续（ended/abandoned 或尚无会话）时，禁用控件旁必须有
          可见的「开始新对话」入口（不再依赖隐藏的「对话记录」菜单）；历史保持只读。 */}
      {!conversationReady ? (
        <div
          className="mb-[8px] flex items-center justify-between gap-[8px]"
          data-testid="copilot-readonly-notice"
        >
          <span className="text-[14px] text-[var(--ink-3)]">
            {creatingSession
              ? '正在准备新对话…'
              : !selectionValidated
                ? sessionsQ.isError
                  ? '对话记录加载失败，请重试或开始新对话。'
                  : '正在加载对话记录…'
                : selectedSession
                  ? '这段对话已结束，仅供回看。'
                  : '还没有可继续的对话。'}
          </span>
          {!selectionValidated && sessionsQ.isError ? (
            <Btn
              variant="ghost"
              size="sm"
              data-testid="copilot-sessions-retry"
              onClick={() => loadVisitSessions(drawerEpoch)}
            >
              重试加载
            </Btn>
          ) : null}
          <Btn
            variant="primary"
            size="sm"
            icon="plus"
            data-testid="copilot-start-new"
            disabled={creatingSession}
            onClick={() => void createConversation()}
          >
            {creatingSession ? '创建中…' : '开始新对话'}
          </Btn>
        </div>
      ) : null}
      <div className="chat-chips">
        {QUICK_CHIPS.map((chip) => (
          <button
            key={chip}
            type="button"
            className="chip"
            disabled={!conversationReady}
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
          disabled={!conversationReady}
          onClick={sendQuiz}
        >
          {focusedKnowledgeId ? '出题 · 当前知识点' : '出题'}
        </button>
      </div>
      <div className="px-[16px] py-[8px] text-[14px] text-[var(--ink-2)]">
        <label className="flex items-center gap-[8px]">
          本轮用途
          <select
            aria-label="本轮用途"
            data-testid="copilot-derivation-policy"
            value={derivationPolicy}
            className="rounded-[var(--r-2)] border border-[var(--line-soft)] bg-[var(--paper)] px-[8px] py-[4px] text-[var(--ink)]"
            onChange={(event) => {
              const policy = DerivationPolicy.parse(event.target.value);
              setDerivationPolicy(policy);
              saveCopilotDerivationPreference(policy);
            }}
          >
            <option value="allow">日常学习</option>
            <option value="answer_only">
              {policySupport === 'checking'
                ? '仅用于本次回答（检查中…）'
                : policySupport === 'unsupported'
                  ? '仅用于本次回答（当前不可用）'
                  : '仅用于本次回答'}
            </option>
          </select>
        </label>
        {derivationPolicy === 'answer_only' ? (
          <p className="mt-[8px] leading-relaxed" role="status">
            {policySupport === 'checking'
              ? '正在检查当前服务器是否支持“仅用于本次回答”，原内容会保留。'
              : policySupport === 'unsupported'
                ? '当前服务器不支持“仅用于本次回答”，或支持信息暂时无法确认。此用途的内容不会发送，选择与原内容会保留。'
                : '聊天和必要运行记录仍会保存。本轮不进入长期记忆、学情判断或后续安排，也不会自动带入下一轮。可读取已有学习资料并回答，不创建练习、笔记或计划。'}
          </p>
        ) : null}
      </div>
      <div className="composer">
        <textarea
          rows={1}
          value={input}
          placeholder="问 Loom 任何事…"
          aria-label="问 Loom 任何事"
          data-testid="copilot-composer-input"
          disabled={!conversationReady}
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
          disabled={
            !conversationReady ||
            input.trim().length === 0 ||
            (derivationPolicy === 'answer_only' && policySupport === 'checking')
          }
          onClick={() => void send(input)}
        />
      </div>
    </div>
  );

  return (
    <>
      {/* The shell drives this internal launcher programmatically and hides the
          whole wrapper. YUK-577's visible nudge count lives on AppTopbar's real
          launcher, which RootShell feeds from the shared nudges query cache. This
          always-mounted wrapper is also the Dock's attach point (attachDock). */}
      <span ref={attachDock} className="copilot-launcher relative inline-flex">
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
              disabled={!conversationReady}
              onClick={() => void send('我想进入教学模式，请带我一步步学习当前内容')}
            />
          </>
        }
        summary={summary}
        footer={footer}
      >
        <div className="copilot-loom" data-testid="copilot-chat">
          <div className="chat-stream" ref={attachStream}>
            {messages.length === 0 && !sending ? (
              // YUK-340 — 空线程开场白回写设计稿手稿语气（copilot.jsx L135-141
              // cop-blank 文案逐字），copy 层零结构改动：仍走 .chat-empty。
              <>
                <p className="chat-empty">我是你的编排者</p>
                <p className="chat-empty">
                  问我今天该学什么、为什么这么排，或让我改动；每一句话我都给你一份可留可撤的改动。
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
            {error && !refreshFailed ? (
              <div className="chat-error" data-testid="copilot-error" role="alert">
                <LoomIcon name="alert" size={14} />
                <span>{error}</span>
              </div>
            ) : null}
            {currentPendingTurns
              .filter((turn) => turn.error)
              .map((turn) => (
                <div
                  key={turn.idempotencyKey}
                  className="chat-error"
                  data-testid="copilot-pending-recovery"
                  data-idempotency-key={turn.idempotencyKey}
                  role="alert"
                >
                  <LoomIcon name="alert" size={14} />
                  <span>{turn.error}</span>
                  <Btn
                    variant="ghost"
                    size="sm"
                    disabled={turn.dispatching}
                    onClick={() => discardPendingRecovery(turn.idempotencyKey)}
                  >
                    不再恢复
                  </Btn>
                  <Btn
                    variant="ghost"
                    size="sm"
                    icon="refresh"
                    disabled={turn.dispatching}
                    onClick={() => retryPendingTurn(turn.idempotencyKey)}
                  >
                    {turn.dispatching ? '恢复中…' : '恢复'}
                  </Btn>
                </div>
              ))}
            {currentRuns
              .filter((run) => run.connectionError)
              .map((run) => (
                <div
                  key={run.runId}
                  className="chat-error"
                  data-testid="copilot-run-reconnect"
                  data-run-id={run.runId}
                  role="alert"
                >
                  <LoomIcon name="alert" size={14} />
                  <span>{run.connectionError}</span>
                  <Btn
                    variant="ghost"
                    size="sm"
                    icon="refresh"
                    onClick={() => reconnectRun(run.runId)}
                  >
                    重新连接
                  </Btn>
                </div>
              ))}
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
          </div>
        </div>
      </CopilotDrawer>
    </>
  );
}
