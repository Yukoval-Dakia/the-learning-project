// Assemble bounded causal history and current learner state for a run. Native
// resume encoding happens later, so validators and correction contracts always
// see the same bounded context. Read failures degrade to empty/header-only
// context; legacy missing anchors keep their locked compatibility fallback.

import { type DerivationPolicyT, allowsDerivation } from '@/core/schema/derivation-policy';
import type { Db } from '@/db/client';
import { readEventDerivationPolicy } from '@/kernel/events/derivation-policy';
import type { DomainToolSurface } from '@/kernel/tools/allowlists';
import { COPILOT_HISTORY_BUDGET, type CopilotHistoryBudget } from '@/kernel/tools/budgets';

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
  /** Server-resolved current-turn attachment reference only. */
  review_answer?: { original_ref: string };
  chip_kind?: string;
  proposal_feedback: ScopedProposalFeedbackCell[];
  conversation_history: CopilotHistoryTurn[];
  learner_state_header?: string;
  correction_contract: CopilotCorrectionContract;
  ambient_context?: CopilotAmbientContext;
}

// Assemble bounded, history-only conversation_history from the session-scoped
// turn reader. 防循环 invariants: each entry keeps role + text (AI replies also
// keep event_id), while skill_turn / skill_context / session_id / prior-run inputs
// (conversation_history, proposal_feedback, ambient_context) are structurally excluded. DOUBLE truncation: per-turn char
// cap, then whole-array cap dropping the OLDEST real turns first. The pinned
// header is counted and reserved first, and is never dropped while real turns
// remain; an absent/empty header prepends nothing.
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
  // Project role + text and AI event_id only, then per-turn truncate.
  const mapped: CopilotHistoryTurn[] = recent.map((t) => ({
    role: t.role,
    text: t.text.length > budget.perTurnChars ? t.text.slice(0, budget.perTurnChars) : t.text,
    ...(t.role === 'ai' ? { event_id: t.event_id } : {}),
  }));
  const pinned: CopilotHistoryTurn | null =
    pinnedHeaderMd && pinnedHeaderMd.length > 0 ? { role: 'context', text: pinnedHeaderMd } : null;
  // Whole-array cap: drop the OLDEST real turn (front) until the serialized array,
  // header included in the accounting, fits. Only real turns are dropped here.
  const serialized = () => JSON.stringify(pinned ? [pinned, ...mapped] : mapped);
  while (mapped.length > 0 && serialized().length > budget.totalChars) {
    mapped.shift();
  }
  // If the header alone still exceeds totalChars after every real turn is drained,
  // return empty history rather than an orphaned over-budget header.
  if (pinned && mapped.length === 0 && serialized().length > budget.totalChars) {
    return [];
  }
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
  // proposal_feedback digest. Any failure degrades to empty header + [] digest.
  let learnerState: LearnerStateHeader = { header_md: '', proposal_feedback: [] };
  try {
    learnerState = await resolveLearnerState(db, sessionId, { now: () => now });
  } catch (err) {
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
  return {
    derivation_policy: params.derivationPolicy ?? 'allow',
    surface: selectSurface(triggeredBy),
    triggered_by: triggeredBy,
    user_message: userMessage,
    ...(chipKind ? { chip_kind: chipKind } : {}),
    proposal_feedback: learnerState.proposal_feedback,
    conversation_history: conversationHistory,
    learner_state_header: learnerState.header_md,
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
