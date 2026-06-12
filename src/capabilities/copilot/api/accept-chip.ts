// M5-T3 (YUK-321) — POST /api/teaching-sessions/[id]/accept-chip 等价平移
// （自 app/api/teaching-sessions/[id]/accept-chip/route.ts；仅签名 / params 取法 /
// runtime 行三处机械变换，body schema / 事件写入 / acceptAiProposal 逻辑逐字保留）。
//
// P5.6 / YUK-178 (call-site 12, §5.2 / §6) — accept-chip writer.
//
// POST /api/teaching-sessions/[id]/accept-chip
//   { suggestion_kind, chip_label, source_event_id?, target_tool?, target_args?,
//     proposal_id? }
//   → 200 { ok, event_id }
//
// This is the FIRST code that ever writes `action:'accept_suggestion'` (the
// AcceptSuggestionChip event was a dead letterbox since ADR-0011 v2 §1.5). On
// click it:
//  - re-validates session ownership + state via Conversation.assertActive — PIN
//    9: NOT assertAcceptingTurns (that auto-resumes an idle session + writes
//    conversation.resumed as a side-effect, undesirable for a chip click).
//    assertActive returns 409-on-ended with no resume side-effect.
//  - writes the AcceptSuggestionChip event with payload { suggestion_kind,
//    chip_label, source_event_id } (ND-SK-3: a corrective chip-accept is still a
//    full event — only the KPI aggregate excludes it, §5.2 reader).
//  - resolves source_event_id per ADR-0011 §2.1 when the caller omits it: the
//    latest agent `explain` teach_message for a proactive chip, the latest agent
//    `tool_use`-shaped (ask_check) teach_message for a corrective chip.
//  - if target_tool materializes a proposal accept (proposal_id present), also
//    calls acceptAiProposal so Lane 1's §5.1 gate applies on the proposal-signal
//    side (the two gates compose — a corrective signal is excluded at whichever
//    path it takes; ND-SK-4).

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { SuggestionKind } from '@/core/schema/event/known';
import { db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';
import { acceptAiProposal } from '@/server/proposals/actions';
import { Conversation } from '@/server/session';

const Body = z.object({
  suggestion_kind: SuggestionKind,
  chip_label: z.string().min(1).max(200),
  // Optional — when omitted we resolve it per ADR-0011 §2.1 from the session's
  // latest agent teach_message (explain for proactive, tool_use for corrective).
  source_event_id: z.string().optional(),
  target_tool: z.string().optional(),
  target_args: z.record(z.string(), z.unknown()).optional(),
  // When the chip materializes a proposal accept (e.g. a corrective
  // propose_variant chip), the proposal id to run through acceptAiProposal so
  // §5.1's KPI gate applies on the proposal-signal side.
  proposal_id: z.string().optional(),
});

// ADR-0011 §2.1 — a chip's source_event_id may only anchor to an agent
// teach_message in the same session (explain / tool_use shape). Both the
// resolver and the explicit-id validator enforce this structural constraint so a
// counted accept_suggestion can never anchor to an unrelated agent event.
const TEACH_MESSAGE_ACTION = 'experimental:teach_message';
// AF S4 / YUK-203 U6 (R1, Cross-统合 §4.2) — under the single-session merge a
// teaching ask_check turn inside Copilot writes an `experimental:copilot_reply`
// event (not a teach_message). The resolver/validator are ADDITIVELY widened to
// also anchor on copilot_reply so an accept-chip click posted with the COPILOT
// session id finds the right agent reply. The endpoint identity, the
// `action='accept_suggestion'` write, and the §5.2 KPI-exclusion reader are
// UNCHANGED — spec :527 freezes the endpoint + KPI separation, not the resolver
// internals. R3: legacy `teach_message` anchoring MUST NOT regress.
const COPILOT_REPLY_ACTION = 'experimental:copilot_reply';
const ANCHOR_ACTIONS = [TEACH_MESSAGE_ACTION, COPILOT_REPLY_ACTION] as const;

/**
 * Resolve `source_event_id` per ADR-0011 §2.1 when the caller did not supply it:
 *  - proactive chip → the agent `explain` event (turn_kind === 'explain'),
 *  - corrective chip → the agent `tool_use` event, modeled here as the latest
 *    agent `ask_check` event (the failure-retry context).
 * Anchors on agent teach_message OR copilot_reply events (AF S4 single-session).
 * Falls back to the latest agent anchor of any turn_kind so the REQUIRED
 * `source_event_id` is always populated.
 */
async function resolveSourceEventId(
  sessionId: string,
  kind: z.infer<typeof SuggestionKind>,
): Promise<string | null> {
  const rows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.session_id, sessionId),
        eq(event.actor_kind, 'agent'),
        inArray(event.action, [...ANCHOR_ACTIONS]),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(50);

  const preferredTurnKind = kind === 'corrective' ? 'ask_check' : 'explain';
  let fallback: string | null = null;
  for (const row of rows) {
    // The event row is already actor_kind='agent' (filtered above). teach_message
    // carries payload.role='agent'; copilot_reply has no role — match on the row's
    // actor_kind instead, so both anchor shapes resolve.
    const p = row.payload as { turn_kind?: string } | null;
    if (fallback === null) fallback = row.id;
    if (p?.turn_kind === preferredTurnKind) return row.id;
  }
  return fallback;
}

/**
 * Validate a client-supplied `source_event_id`: it must reference an agent
 * teach_message OR copilot_reply in THIS session. Without this a stale or
 * malformed client could write a counted accept_suggestion anchored to an
 * unrelated/nonexistent event.
 */
async function isValidAnchorEvent(sessionId: string, eventId: string): Promise<boolean> {
  const rows = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.id, eventId),
        eq(event.session_id, sessionId),
        eq(event.actor_kind, 'agent'),
        inArray(event.action, [...ANCHOR_ACTIONS]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const { id: sessionId } = z.object({ id: z.string().min(1) }).parse(params);
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => i.message).join('; '),
        400,
      );
    }

    // PIN 9 — assertActive (409-on-ended, no resume side-effect), NOT
    // assertAcceptingTurns (which auto-resumes idle + writes conversation.resumed).
    await Conversation.assertActive(db, sessionId);

    let sourceEventId: string | null;
    if (parsed.data.source_event_id) {
      if (!(await isValidAnchorEvent(sessionId, parsed.data.source_event_id))) {
        throw new ApiError(
          'validation_error',
          'source_event_id must reference an agent teach_message or copilot_reply in this session',
          400,
        );
      }
      sourceEventId = parsed.data.source_event_id;
    } else {
      sourceEventId = await resolveSourceEventId(sessionId, parsed.data.suggestion_kind);
    }
    if (!sourceEventId) {
      throw new ApiError(
        'invalid_state',
        'cannot resolve source_event_id — session has no agent message to anchor the chip',
        409,
      );
    }

    const chipEventId = createId();
    const payload: {
      suggestion_kind: z.infer<typeof SuggestionKind>;
      chip_label: string;
      source_event_id: string;
      target_tool?: string;
      target_args?: Record<string, unknown>;
    } = {
      suggestion_kind: parsed.data.suggestion_kind,
      chip_label: parsed.data.chip_label,
      source_event_id: sourceEventId,
    };
    if (parsed.data.target_tool) payload.target_tool = parsed.data.target_tool;
    if (parsed.data.target_args) payload.target_args = parsed.data.target_args;

    // Order matters: run the proposal accept BEFORE persisting the chip event.
    // writeEvent-first + a failing accept would leave a counted accept_suggestion
    // behind, and the retry would write a second — double-counting §5.1's KPI for
    // an action that never completed (P5.6 review finding). The accept-first order
    // trades that silent double-count for an under-count on the (rare) accept-OK /
    // write-fails window: acceptAiProposal is idempotent only for the kinds whose
    // dispatchAccept honors `result.idempotent` (learning_item / variant_question /
    // completion / goal_scope); for the others a re-accept throws, so a retry
    // surfaces an error rather than double-counting. Under-count + recoverable is
    // the lesser evil. NOTE: this branch is latent today — the only caller
    // (TeachingDrawer) sends no proposal_id. Gates compose: a corrective signal is
    // excluded on either path (ND-SK-4).
    if (parsed.data.proposal_id) {
      await acceptAiProposal(db, parsed.data.proposal_id);
    }

    await writeEvent(db, {
      id: chipEventId,
      session_id: sessionId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'accept_suggestion',
      subject_kind: 'chip',
      subject_id: chipEventId,
      outcome: 'success',
      payload,
    });

    return Response.json({ ok: true, event_id: chipEventId });
  } catch (err) {
    return errorResponse(err);
  }
}
