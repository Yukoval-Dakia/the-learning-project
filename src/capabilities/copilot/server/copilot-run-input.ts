// Assemble bounded causal history and current learner state for a run. Native
// resume encoding happens later, so validators and correction contracts always
// see the same bounded context. Read failures degrade to empty/header-only
// context; legacy missing anchors keep their locked compatibility fallback.

import { learnerLocalDay } from '@/core/learner-day';
import { type DerivationPolicyT, allowsDerivation } from '@/core/schema/derivation-policy';
import { learnerDayWithWeekday } from '@/core/steering';
import type { Db } from '@/db/client';
import { readEventDerivationPolicy } from '@/kernel/events/derivation-policy';
import { HostOperationNotInstalledError } from '@/kernel/host-operation';
import { readBacktraceContext } from '@/kernel/read-models/backtrace';
import type { DomainToolSurface } from '@/kernel/tools/allowlists';
import {
  COPILOT_HISTORY_BUDGET,
  type CopilotHistoryBudget,
  estimateContextTokens,
} from '@/kernel/tools/budgets';
import type { CopilotCorrectionContract } from './correction-contract';
import {
  type LearnerStateHeader,
  type ScopedProposalFeedbackCell,
  resolveLearnerStateHeader,
} from './learner-state';
import {
  CopilotHistoryAnchorError,
  type CopilotTurn,
  getCopilotReplyPoliciesBeforeAnchor,
  getCopilotTurnsBeforeAnchor,
  getRecentCopilotTurns,
} from './turns';

/** Chat and chip share execution; only their tool surface and actor differ. */
export type CopilotTriggeredBy = 'chat' | 'chip';

export function selectSurface(triggeredBy: CopilotTriggeredBy): DomainToolSurface {
  return triggeredBy === 'chip' ? 'copilot_user_suggested_mistake_action' : 'copilot';
}

export function selectActorRef(triggeredBy: CopilotTriggeredBy): string {
  return triggeredBy === 'chip' ? 'agent:copilot_chip' : 'agent:copilot';
}

// Minimal history shape carried in the run input. Every entry keeps role + text;
// AI replies also keep their stable event_id so a correction can bind one exact
// prior answer, and all other turn-row fields are dropped (防循环). The 'context'
// role carries the pinned learner-state header, prepended fresh from the
// session-anchored cache and never read back from turns.
export interface CopilotHistoryTurn {
  role: 'user' | 'ai' | 'context';
  text: string;
  event_id?: string;
}

// Ambient context for THIS message only (防循环): present only when the request
// carried it, never written to a turn payload, so it is never replayed. Mirrors
// the CopilotChatRequest.ambient_context zod shape.
export interface CopilotAmbientContext {
  route: string;
  focused_entity?: { kind: string; id: string };
}

// The free-form CopilotTask input before native cold/resume encoding.
export interface CopilotRunInput {
  derivation_policy?: DerivationPolicyT;
  surface: DomainToolSurface;
  triggered_by: CopilotTriggeredBy;
  user_message: string;
  /** YUK-1770 — learner-local (Asia/Shanghai) today line 'YYYY-MM-DD（周X）'. */
  today: string;
  /** Server-resolved current-turn attachment reference only. */
  review_answer?: { original_ref: string };
  chip_kind?: string;
  proposal_feedback: ScopedProposalFeedbackCell[];
  conversation_history: CopilotHistoryTurn[];
  learner_state_header?: string;
  backtrace_digest?: string;
  /** 「自上条消息以来：……」 — only when the cached header predates new activity. */
  since_last_message?: string;
  correction_contract: CopilotCorrectionContract;
  ambient_context?: CopilotAmbientContext;
  /**
   * Event ids of the turn rows this history window was projected from. Server
   * provenance only — the prompt compiler never reads it, and derivations bind
   * it as the authoritative read set (drawing source ledger, YUK-1548).
   */
  bound_turn_event_ids?: string[];
}

// Assemble bounded, history-only conversation_history from the session-scoped
// turn reader. Each entry keeps role + text (AI replies also keep event_id),
// while skill_turn / skill_context / session_id / prior-run inputs are
// structurally excluded. Turns stay whole. The token ceiling drops the oldest
// whole turn first and does not charge the pinned header; an absent/empty
// header prepends nothing. The newest turn is kept even when it alone exceeds
// the ceiling, so a long reply is not sliced or discarded.
export function assembleConversationHistory(
  turns: CopilotTurn[],
  budget: CopilotHistoryBudget,
  pinnedHeaderMd?: string,
): CopilotHistoryTurn[] {
  // Tail-slice the newest `maxTurns`. The explicit role allowlist is a type guard,
  // so widening it to admit another role is a compile error, not a silent cast.
  const recent = turns
    .filter(
      (turn): turn is CopilotTurn & { role: 'user' | 'ai' } =>
        (turn.role === 'user' || turn.role === 'ai') && allowsDerivation(turn),
    )
    .slice(-budget.maxTurns);
  const mapped: CopilotHistoryTurn[] = recent.map((t) => ({
    role: t.role,
    text: t.text,
    ...(t.role === 'ai' ? { event_id: t.event_id } : {}),
  }));
  const pinned: CopilotHistoryTurn | null =
    pinnedHeaderMd && pinnedHeaderMd.length > 0 ? { role: 'context', text: pinnedHeaderMd } : null;
  const tokens = () => estimateContextTokens(JSON.stringify(mapped));
  while (mapped.length > 1 && tokens() > budget.totalTokens) mapped.shift();
  return pinned ? [pinned, ...mapped] : mapped;
}

/** Read adapters for bounded context assembly. */
export interface AssembleCopilotRunInputDeps {
  resolveLearnerStateHeaderFn?: (
    db: Db,
    sessionId: string,
    opts: { now?: () => Date },
  ) => Promise<LearnerStateHeader>;
  /** Compatibility reader only for legacy missing anchors. */
  loadHistoryFn?: typeof getRecentCopilotTurns;
  /** Fixed-session causal reader for persistent pickup assembly. */
  loadAnchoredHistoryFn?: typeof getCopilotTurnsBeforeAnchor;
  loadCorrectionPoliciesFn?: typeof getCopilotReplyPoliciesBeforeAnchor;
}

export interface AssembleCopilotRunInputParams {
  sessionId: string;
  userMessage: string;
  derivationPolicy?: DerivationPolicyT;
  triggeredBy: CopilotTriggeredBy;
  chipKind?: string;
  ambient?: CopilotAmbientContext;
  now: Date;
  /** Accepted run_id (= persisted input event id). */
  historyAnchorEventId: string;
  correctionTargetTurnId?: string;
}

/** Resolve current state once and project history before this accepted input. */
export async function assembleCopilotRunInput(
  db: Db,
  params: AssembleCopilotRunInputParams,
  deps: AssembleCopilotRunInputDeps = {},
): Promise<CopilotRunInput> {
  const { sessionId, userMessage, triggeredBy, chipKind, ambient, now, historyAnchorEventId } =
    params;
  const resolveLearnerState =
    deps.resolveLearnerStateHeaderFn ??
    ((d: Db, sid: string, opts: { now?: () => Date }) =>
      resolveLearnerStateHeader(d, sid, { now: opts.now }));
  const loadHistory = deps.loadHistoryFn ?? getRecentCopilotTurns;
  const loadAnchoredHistory = deps.loadAnchoredHistoryFn ?? getCopilotTurnsBeforeAnchor;

  // Resolve the session-anchored header first (assembled once per validity window;
  // cached bytes when fresh). It carries both the pinned header and the scoped
  // proposal_feedback digest. Read failures degrade to empty header + [] digest; a
  // port that was never installed is a host wiring defect and propagates.
  let learnerState: LearnerStateHeader = { header_md: '', proposal_feedback: [] };
  try {
    learnerState = await resolveLearnerState(db, sessionId, { now: () => now });
  } catch (err) {
    if (err instanceof HostOperationNotInstalledError) throw err;
    learnerState = { header_md: '', proposal_feedback: [] };
    console.error('[assembleCopilotRunInput] resolveLearnerState failed; degrading to empty', {
      session_id: sessionId,
      err,
    });
  }

  // A history read failure degrades to the pinned header alone, never crashes.
  let rawTurns: CopilotTurn[] = [];
  let historyReadFailed = false;
  let historyAnchorMissing = false;
  try {
    try {
      rawTurns = await loadAnchoredHistory(db, {
        limit: COPILOT_HISTORY_BUDGET.maxTurns,
        sessionId,
        anchorEventId: historyAnchorEventId,
        forModel: true,
      });
    } catch (err) {
      // Locked legacy contract: a genuinely missing anchor predates the
      // coordinate, so alert and fall back to reusable-session history. An anchor
      // that exists with the wrong action/session is an integrity failure and
      // stays on the outer header-only fail-closed path.
      if (!(err instanceof CopilotHistoryAnchorError) || err.reason !== 'missing_anchor') {
        throw err;
      }
      console.error(
        '[assembleCopilotRunInput] history anchor missing; falling back to reusable-session history',
        {
          session_id: sessionId,
          history_anchor_event_id: historyAnchorEventId,
          err,
        },
      );
      historyAnchorMissing = true;
      rawTurns = await loadHistory(db, {
        limit: COPILOT_HISTORY_BUDGET.maxTurns,
        now,
        sessionId,
        forModel: true,
      });
    }
  } catch (err) {
    historyReadFailed = true;
    console.error('[assembleCopilotRunInput] loadHistory failed; degrading to header-only', {
      session_id: sessionId,
      history_anchor_event_id: historyAnchorEventId,
      err,
    });
  }

  const projectedHistory = assembleConversationHistory(
    rawTurns,
    COPILOT_HISTORY_BUDGET,
    historyReadFailed ? learnerState.header_md : undefined,
  );
  const conversationHistory = assembleConversationHistory(
    rawTurns,
    COPILOT_HISTORY_BUDGET,
    learnerState.header_md,
  );

  let correctionPolicies = rawTurns.filter((turn) => turn.role === 'ai');
  let correctionPositionsUnavailable = false;
  if (!deps.loadAnchoredHistoryFn || deps.loadCorrectionPoliciesFn) {
    try {
      const policies = await (deps.loadCorrectionPoliciesFn ?? getCopilotReplyPoliciesBeforeAnchor)(
        db,
        { sessionId, anchorEventId: historyAnchorMissing ? undefined : historyAnchorEventId, now },
      );
      // Only policy/id metadata crosses this boundary. Never retrieve excluded text.
      correctionPolicies = policies.map((policy) => ({ ...policy, role: 'ai', text: '', at: '' }));
    } catch {
      correctionPositionsUnavailable = true;
    }
  }
  const restrictedCorrectionTarget = params.correctionTargetTurnId
    ? (await readEventDerivationPolicy(db, params.correctionTargetTurnId)) !== 'allow'
    : false;
  const focused = ambient?.focused_entity;
  // Optional context: compositions without the practice host (crisis-guard subset
  // tests, standalone copilot) have no backtrace reader — degrade to no digest.
  let backtrace: Awaited<ReturnType<typeof readBacktraceContext>> | undefined;
  try {
    backtrace = await readBacktraceContext(db, {
      ...(focused?.kind === 'question'
        ? { question_id: focused.id }
        : focused?.kind === 'event' || focused?.kind === 'attempt'
          ? { attempt_event_id: focused.id }
          : {}),
      session_id: !focused ? sessionId : undefined,
    });
  } catch (error) {
    if (!(error instanceof HostOperationNotInstalledError)) throw error;
  }
  return {
    ...(backtrace ? { backtrace_digest: backtrace } : {}),
    derivation_policy: params.derivationPolicy ?? 'allow',
    surface: selectSurface(triggeredBy),
    triggered_by: triggeredBy,
    user_message: userMessage,
    today: learnerDayWithWeekday(learnerLocalDay(now)),
    ...(chipKind ? { chip_kind: chipKind } : {}),
    proposal_feedback: learnerState.proposal_feedback,
    conversation_history: conversationHistory,
    // The whole fetched window, not the token-dropped survivor set: binding a
    // few extra turn ids is fail-closed, binding fewer would be a leak.
    bound_turn_event_ids: rawTurns.flatMap((t) => (t.event_id ? [t.event_id] : [])),
    learner_state_header: learnerState.header_md,
    ...(learnerState.since_last_message
      ? { since_last_message: learnerState.since_last_message }
      : {}),
    correction_contract: {
      ...(restrictedCorrectionTarget ? { restricted_target: true } : {}),
      ...(correctionPositionsUnavailable ? { positions_unavailable: true } : {}),
      prior_turn_order: correctionPolicies.map((turn) => turn.event_id),
      restricted_prior_turn_ids: correctionPolicies
        .filter((turn) => !allowsDerivation(turn))
        .map((turn) => turn.event_id),
      ...(params.correctionTargetTurnId
        ? { target_prior_turn_id: params.correctionTargetTurnId }
        : {}),
      available_prior_turn_ids: projectedHistory.flatMap((turn) =>
        turn.role === 'ai' && turn.event_id !== undefined ? [turn.event_id] : [],
      ),
      prior_turn_summaries: projectedHistory.reduce<Record<string, string>>(
        (summaries, turn, index) => {
          if (turn.role === 'ai' && turn.event_id !== undefined) {
            const priorUserTurn = projectedHistory
              .slice(0, index)
              .findLast((candidate) => candidate.role === 'user');
            summaries[turn.event_id] = (priorUserTurn?.text ?? turn.text)
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 40);
          }
          return summaries;
        },
        {},
      ),
      required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'],
    },
    ...(ambient ? { ambient_context: ambient } : {}),
  };
}
