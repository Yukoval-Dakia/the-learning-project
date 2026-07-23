// YUK-575 (A1, PR1) — shared Copilot run-input assembler.
//
// SINGLE execution point for the free-form CopilotTask run input, shared by the
// inline path (`runCopilotChatImpl`, chat.ts) and the durable path (the
// copilot_run pg-boss handler). Before this module the assembly logic lived only
// in chat.ts; the durable handler shipped a minimal `{user_message, triggered_by}`
// run input with NO conversation_history / learner-state header / proposal_feedback
// / ambient — so a durable turn would lose the session memory + YUK-574 learner
// state + ambient the inline turn has. Extracting the assembly here makes the two
// paths byte-parity by construction (OQ-D → A1: the panel upgraded this from a
// taste question to a correctness requirement — the drift it prevents is in the
// ASSEMBLY logic: history budget / learner-state header / proposal_feedback shape).
//
// Time-model adaptation (coordinator ruling 2026-07-07): the two paths exclude the
// CURRENT ask differently, and that difference is NOT drift — it is the correct
// minimal adaptation to two real orderings:
//   • inline  — reads history BEFORE writing the ask (chat.ts read-before-write),
//               so the ask is structurally excluded; OMITS `excludeUserAskEventId`.
//   • durable — the dispatch writes the user_ask FIRST (api/chat.ts), then the
//               worker picks the job up later, so at pickup the ask is already
//               persisted; passes `excludeUserAskEventId = run_id` to drop it.
//
// Additive-input red line (preserved verbatim from chat.ts): every read here
// degrades to an empty result on failure and NEVER crashes the run — a learner-
// state read failure → empty header + [] digest; a history read failure → header-
// only (pinned header still rides).

import type { Db } from '@/db/client';
import type { DomainToolSurface } from '@/server/ai/tools/allowlists';
import { COPILOT_HISTORY_BUDGET, type CopilotHistoryBudget } from '@/server/ai/tools/budgets';

import {
  type LearnerStateHeader,
  type ScopedProposalFeedbackCell,
  resolveLearnerStateHeader,
} from './learner-state';
import { type CopilotTurn, getRecentCopilotTurns } from './turns';

/** chat trigger surface selector — single source (was module-private in chat.ts). */
export type CopilotTriggeredBy = 'chat' | 'chip';

export function selectSurface(triggeredBy: CopilotTriggeredBy): DomainToolSurface {
  return triggeredBy === 'chip' ? 'copilot_user_suggested_mistake_action' : 'copilot';
}

export function selectActorRef(triggeredBy: CopilotTriggeredBy): string {
  return triggeredBy === 'chip' ? 'agent:copilot_chip' : 'agent:copilot';
}

// YUK-267 (C2) — the minimal history shape carried in the run input. ONLY role +
// text (the persisted ask原文 / reply正文); everything else from the turn row is
// EXPLICITLY dropped (防循环 ①/⑤). YUK-574 adds the 'context' role for the pinned
// learner-state header (a deterministic projection, NOT a persisted turn — it is
// prepended fresh from the session-anchored cache and never read back from turns).
export interface CopilotHistoryTurn {
  role: 'user' | 'ai' | 'context';
  text: string;
}

// YUK-267 (C2) — ambient context for THIS message only (防循环 ②). Present only
// when the request carried it; NEVER written to any turn payload, so it is not
// replayed. Structurally mirrors the CopilotChatRequest.ambient_context zod shape.
export interface CopilotAmbientContext {
  route: string;
  focused_entity?: { kind: string; id: string };
}

// The free-form CopilotTask run input (byte-parity with chat.ts:1101-1122).
export interface CopilotRunInput {
  surface: DomainToolSurface;
  triggered_by: CopilotTriggeredBy;
  user_message: string;
  chip_kind?: string;
  proposal_feedback: ScopedProposalFeedbackCell[];
  conversation_history: CopilotHistoryTurn[];
  ambient_context?: CopilotAmbientContext;
}

// YUK-267 (C2) — assemble the bounded, history-only conversation_history from the
// session-scoped turn reader. 防循环 invariants enforced here:
//   ① each entry is {role, text} ONLY — NO skill_turn / skill_context / session_id
//      / reply_event_id / event_id / at, and certainly NO prior-run assembly
//      artifact (conversation_history / proposal_feedback / ambient_context). The
//      reader only exposes role+text (turns.ts), so this map is the structural
//      guarantee (防循环 ⑤ test feeds a polluted row and asserts {role,text} only).
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
  // Keep the newest `maxTurns` (turns are oldest→newest, so tail-slice).
  const recent = turns.filter((turn) => turn.role !== 'tombstone').slice(-budget.maxTurns);
  // 防循环 ① — strip to {role, text} ONLY, then per-turn truncate (防循环 ④).
  const mapped: CopilotHistoryTurn[] = recent.map((t) => ({
    role: t.role as 'user' | 'ai',
    text: t.text.length > budget.perTurnChars ? t.text.slice(0, budget.perTurnChars) : t.text,
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

/** Swappable seams so unit tests never touch a live DB (mirrors CopilotChatDeps). */
export interface AssembleCopilotRunInputDeps {
  resolveLearnerStateHeaderFn?: (
    db: Db,
    sessionId: string,
    opts: { now?: () => Date },
  ) => Promise<LearnerStateHeader>;
  loadHistoryFn?: typeof getRecentCopilotTurns;
}

export interface AssembleCopilotRunInputParams {
  sessionId: string;
  userMessage: string;
  triggeredBy: CopilotTriggeredBy;
  chipKind?: string;
  ambient?: CopilotAmbientContext;
  now: Date;
  /**
   * YUK-575 (MF-B) — durable pickup passes the run_id (= user_ask event id) to
   * exclude the current ask, which the dispatch already persisted. Inline OMITS
   * it (its read-before-write ordering excludes the ask structurally). See module
   * docblock.
   */
  excludeUserAskEventId?: string;
}

/**
 * Assemble the free-form CopilotTask run input (byte-parity with chat.ts:1101-1122).
 * Resolves the session-anchored learner-state header ONCE (supplying BOTH the
 * pinned header and the migrated Facet A proposal_feedback digest), loads the
 * bounded session history (optionally excluding the current ask by id), and returns
 * the run input the runner serializes.
 */
export async function assembleCopilotRunInput(
  db: Db,
  params: AssembleCopilotRunInputParams,
  deps: AssembleCopilotRunInputDeps = {},
): Promise<CopilotRunInput> {
  const { sessionId, userMessage, triggeredBy, chipKind, ambient, now, excludeUserAskEventId } =
    params;
  const resolveLearnerState =
    deps.resolveLearnerStateHeaderFn ??
    ((d: Db, sid: string, opts: { now?: () => Date }) =>
      resolveLearnerStateHeader(d, sid, { now: opts.now }));
  const loadHistory = deps.loadHistoryFn ?? getRecentCopilotTurns;

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
  let conversationHistory: CopilotHistoryTurn[];
  try {
    const rawTurns = await loadHistory(db, {
      limit: COPILOT_HISTORY_BUDGET.maxTurns,
      now,
      ...(excludeUserAskEventId ? { excludeEventId: excludeUserAskEventId } : {}),
    });
    conversationHistory = assembleConversationHistory(
      rawTurns,
      COPILOT_HISTORY_BUDGET,
      learnerState.header_md,
    );
  } catch (err) {
    conversationHistory = assembleConversationHistory(
      [],
      COPILOT_HISTORY_BUDGET,
      learnerState.header_md,
    );
    console.error('[assembleCopilotRunInput] loadHistory failed; degrading to header-only', {
      session_id: sessionId,
      err,
    });
  }

  return {
    surface: selectSurface(triggeredBy),
    triggered_by: triggeredBy,
    user_message: userMessage,
    ...(chipKind ? { chip_kind: chipKind } : {}),
    proposal_feedback: learnerState.proposal_feedback,
    conversation_history: conversationHistory,
    ...(ambient ? { ambient_context: ambient } : {}),
  };
}
