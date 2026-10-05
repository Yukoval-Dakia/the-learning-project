// Copilot's persistent execution owner assembles bounded causal history and
// current learner state here. Native resume encoding happens later, so validators
// and correction contracts always retain the same bounded context.
// Optional state/history read failures degrade to empty/header-only context;
// legacy missing anchors retain their explicitly locked compatibility fallback.

import type { Db } from '@/db/client';
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

// YUK-267 (C2) — the minimal history shape carried in the run input. Every entry
// keeps role + text; AI replies additionally retain their stable event_id so a
// correction can bind one exact prior answer. All other turn-row fields are
// explicitly dropped (防循环 ①/⑤). YUK-574 adds the 'context' role for the pinned
// learner-state header (a deterministic projection, NOT a persisted turn — it is
// prepended fresh from the session-anchored cache and never read back from turns).
export interface CopilotHistoryTurn {
  role: 'user' | 'ai' | 'context';
  text: string;
  event_id?: string;
}

// YUK-267 (C2) — ambient context for THIS message only (防循环 ②). Present only
// when the request carried it; NEVER written to any turn payload, so it is not
// replayed. Structurally mirrors the CopilotChatRequest.ambient_context zod shape.
export interface CopilotAmbientContext {
  route: string;
  focused_entity?: { kind: string; id: string };
}

// The free-form CopilotTask input before native cold/resume encoding.
export interface CopilotRunInput {
  surface: DomainToolSurface;
  triggered_by: CopilotTriggeredBy;
  user_message: string;
  chip_kind?: string;
  proposal_feedback: ScopedProposalFeedbackCell[];
  conversation_history: CopilotHistoryTurn[];
  validator_context_history: CopilotHistoryTurn[];
  learner_state_header?: string;
  correction_contract: CopilotCorrectionContract;
  ambient_context?: CopilotAmbientContext;
}

// YUK-267 (C2) — assemble the bounded, history-only conversation_history from the
// session-scoped turn reader. 防循环 invariants enforced here:
//   ① each entry keeps role + text; AI replies alone also keep event_id. NO
//      skill_turn / skill_context / session_id / reply_event_id / at, and certainly
//      NO prior-run assembly artifact (conversation_history / proposal_feedback /
//      ambient_context). This explicit projection is the structural guarantee.
//   ④ DOUBLE truncation — per-turn char cap, then whole-array char cap dropping the
//      OLDEST turns first until the serialized array fits (recency matters most).
// `turns` arrive oldest→newest (the reader reverses to chronological). We keep the
// newest maxTurns, per-turn truncate, then oldest-first whole-array truncate.
//
// YUK-574 — `pinnedHeaderMd` (the session-anchored learner-state header) is
// prepended as a `{role:'context'}` entry that is PINNED: the oldest-first drop
// loop only ever removes real conversation turns, never the header. The header's
// char cost is reserved FIRST so it is counted against COPILOT_HISTORY_BUDGET yet
// survives truncation (the header is pre-bounded at assembly to
// LEARNER_STATE_HEADER_BUDGET, always well under totalChars). Absent / empty header
// → byte-for-byte the pre-YUK-574 output (no context entry prepended).
export function assembleConversationHistory(
  turns: CopilotTurn[],
  budget: CopilotHistoryBudget,
  pinnedHeaderMd?: string,
): CopilotHistoryTurn[] {
  // Keep the newest `maxTurns` (turns are oldest→newest, so tail-slice). Explicit ALLOWLIST of the
  // two conversational roles (not a `!== 'tombstone'` denylist) as a type-guard predicate, so the
  // compiler narrows `role` here and enforces the invariant at the `role: t.role` assignment below —
  // widening the filter to admit another role becomes a compile error, not a silent cast (YUK-497 wave-2).
  const recent = turns
    .filter(
      (turn): turn is CopilotTurn & { role: 'user' | 'ai' } =>
        turn.role === 'user' || turn.role === 'ai',
    )
    .slice(-budget.maxTurns);
  // 防循环 ① — project role + text and AI event_id only, then per-turn truncate (防循环 ④).
  const mapped: CopilotHistoryTurn[] = recent.map((t) => ({
    role: t.role,
    text: t.text.length > budget.perTurnChars ? t.text.slice(0, budget.perTurnChars) : t.text,
    ...(t.role === 'ai' ? { event_id: t.event_id } : {}),
  }));
  const pinned: CopilotHistoryTurn | null =
    pinnedHeaderMd && pinnedHeaderMd.length > 0 ? { role: 'context', text: pinnedHeaderMd } : null;
  // 防循环 ④ — whole-array cap: drop OLDEST real turn (front) until the serialized
  // array (header included in the accounting) fits. The pinned header is NEVER
  // dropped WHILE there are still real turns to shift, only real turns.
  const serialized = () => JSON.stringify(pinned ? [pinned, ...mapped] : mapped);
  while (mapped.length > 0 && serialized().length > budget.totalChars) {
    mapped.shift();
  }
  // PROGRAMMATIC invariant guard: the loop above only shifts real turns, so if the
  // header ALONE (mapped already drained) still exceeds totalChars, there is nothing
  // left to drop except the header itself. Without this, a future misconfiguration
  // where LEARNER_STATE_HEADER_BUDGET.maxChars grows past COPILOT_HISTORY_BUDGET.
  // totalChars would silently ship an orphaned over-budget header with zero real
  // turns — worse than an empty history. Give up the header too in that case.
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
}

export interface AssembleCopilotRunInputParams {
  sessionId: string;
  userMessage: string;
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

  // YUK-574 — resolve the session-anchored learner-state header FIRST (assemble-once
  // per validity window; cached bytes when fresh). It carries BOTH the pinned header
  // and the migrated Facet A proposal_feedback digest. Additive-input red line: any
  // failure degrades to an empty header + [] digest and never crashes the run.
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

  // YUK-267 (C2) — bounded, history-only conversation context. A read failure
  // degrades to the pinned header alone (pin-in-budget), never crashes the run.
  let rawTurns: CopilotTurn[] = [];
  let historyReadFailed = false;
  try {
    try {
      rawTurns = await loadAnchoredHistory(db, {
        limit: COPILOT_HISTORY_BUDGET.maxTurns,
        sessionId,
        anchorEventId: historyAnchorEventId,
      });
    } catch (err) {
      // YUK-596 locked legacy contract: a genuinely missing anchor predates
      // or lost the new coordinate, so emit a structured alert and preserve
      // the former reusable-session history predicate. An anchor that exists
      // but has the wrong action/session remains an integrity failure and is
      // handled by the outer header-only fail-closed path.
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
      rawTurns = await loadHistory(db, {
        limit: COPILOT_HISTORY_BUDGET.maxTurns,
        now,
        sessionId,
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

  return {
    surface: selectSurface(triggeredBy),
    triggered_by: triggeredBy,
    user_message: userMessage,
    ...(chipKind ? { chip_kind: chipKind } : {}),
    proposal_feedback: learnerState.proposal_feedback,
    conversation_history: conversationHistory,
    validator_context_history: projectedHistory,
    learner_state_header: learnerState.header_md,
    correction_contract: {
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
