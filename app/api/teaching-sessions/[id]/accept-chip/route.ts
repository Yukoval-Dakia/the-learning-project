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
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { SuggestionKind } from '@/core/schema/event/known';
import { db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';
import { acceptAiProposal } from '@/server/proposals/actions';
import { Conversation } from '@/server/session';

export const runtime = 'nodejs';

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

/**
 * Determine an agent event id to use as the `source_event_id` when the caller omits it.
 *
 * Chooses a preferred agent teach_message event based on `kind` — for `corrective` prefer a turn with `turn_kind === 'ask_check'`, otherwise prefer `turn_kind === 'explain'` — and falls back to the latest agent event if no preferred match exists.
 *
 * @param sessionId - The teaching session id to search events within
 * @param kind - The suggestion kind which selects the preferred turn kind (`'corrective'` → prefer `'ask_check'`, otherwise prefer `'explain'`)
 * @returns The resolved event id to use as the source anchor, or `null` if no suitable agent event is found
 */
async function resolveSourceEventId(
  sessionId: string,
  kind: z.infer<typeof SuggestionKind>,
): Promise<string | null> {
  const rows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(and(eq(event.session_id, sessionId), eq(event.actor_kind, 'agent')))
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(50);

  const preferredTurnKind = kind === 'corrective' ? 'ask_check' : 'explain';
  let fallback: string | null = null;
  for (const row of rows) {
    const p = row.payload as { role?: string; turn_kind?: string } | null;
    if (p?.role !== 'agent') continue;
    if (fallback === null) fallback = row.id;
    if (p.turn_kind === preferredTurnKind) return row.id;
  }
  return fallback;
}

/**
 * Handle POST /api/teaching-sessions/[id]/accept-chip: validate the request, ensure the session is active,
 * resolve or verify the source event anchor, record an `accept_suggestion` chip event, and optionally accept a proposal.
 *
 * Validates the request body against the expected schema, uses the provided or derived `source_event_id`
 * (returns 409 if it cannot be resolved), writes an event with `action: 'accept_suggestion'` and `subject_kind: 'chip'`,
 * and, if `proposal_id` is present, invokes the proposal acceptance path.
 *
 * @returns An HTTP Response whose JSON body is `{ ok: true, event_id: string }` on success, or an error response on failure.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id: sessionId } = await ctx.params;
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

    const sourceEventId =
      parsed.data.source_event_id ??
      (await resolveSourceEventId(sessionId, parsed.data.suggestion_kind));
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

    // If the chip materializes a proposal accept, run it through the proposal
    // accept path so §5.1's KPI gate applies (Lane 1). The gates compose: a
    // corrective signal is excluded at whichever path it takes (ND-SK-4).
    if (parsed.data.proposal_id) {
      await acceptAiProposal(db, parsed.data.proposal_id);
    }

    return Response.json({ ok: true, event_id: chipEventId });
  } catch (err) {
    return errorResponse(err);
  }
}
