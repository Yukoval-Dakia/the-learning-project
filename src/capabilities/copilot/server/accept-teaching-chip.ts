import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';

import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import type { SuggestionKind } from '@/kernel/capability-contract-schemas';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { wakeHubSyncAfterCommit } from '@/server/boss/hub-sync-wake';
import { acceptAiProposal } from '@/server/proposals/actions';
import { Conversation } from '@/server/session';
import { AcceptTeachingChipBodySchema, CopilotRouteIdParamsSchema } from '../api/contracts';

// ADR-0011 §2.1 — a chip's source_event_id may only anchor to an agent
// message in the same session, so a counted accept_suggestion can never anchor
// to an unrelated agent event.
const TEACH_MESSAGE_ACTION = 'experimental:teach_message';
// Under the single-session merge, a Copilot ask_check turn writes
// `experimental:copilot_reply` (not a teach_message), so the resolver and
// validator accept both; legacy teach_message anchoring must not regress.
const COPILOT_REPLY_ACTION = 'experimental:copilot_reply';
const ANCHOR_ACTIONS = [TEACH_MESSAGE_ACTION, COPILOT_REPLY_ACTION] as const;

/**
 * Resolve `source_event_id` when the caller omits it: the latest agent
 * `explain` turn for a proactive chip, the latest `ask_check` turn for a
 * corrective chip. Falls back to the latest agent anchor of any turn_kind so the
 * required field is always populated.
 */
async function resolveSourceEventId(
  db: Db,
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
    // The row is already filtered to actor_kind='agent'; don't gate on
    // payload.role, because copilot_reply has none. Both anchor shapes resolve here.
    const p = row.payload as { turn_kind?: string } | null;
    if (fallback === null) fallback = row.id;
    if (p?.turn_kind === preferredTurnKind) return row.id;
  }
  return fallback;
}

/**
 * A client-supplied `source_event_id` must reference an agent anchor in THIS
 * session; otherwise a stale or malformed client could write a counted
 * accept_suggestion anchored to an unrelated/nonexistent event.
 */
async function isValidAnchorEvent(db: Db, sessionId: string, eventId: string): Promise<boolean> {
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

type AcceptTeachingChipInput = z.infer<typeof AcceptTeachingChipBodySchema>;

/**
 * Accept a chip against its session's agent anchor and record the learner action.
 * Proposal acceptance and the chip event deliberately keep their original separate
 * commits: accept first, best-effort wake without awaiting, then write the chip event.
 */
export async function acceptTeachingChip(
  db: Db,
  sessionId: string,
  input: AcceptTeachingChipInput,
) {
  // assertActive (409-on-ended, no resume side-effect), NOT
  // assertAcceptingTurns (which would auto-resume idle + write conversation.resumed).
  await Conversation.assertActive(db, sessionId);

  let sourceEventId: string | null;
  if (input.source_event_id) {
    if (!(await isValidAnchorEvent(db, sessionId, input.source_event_id))) {
      throw new ApiError(
        'validation_error',
        'source_event_id must reference an agent teach_message or copilot_reply in this session',
        400,
      );
    }
    sourceEventId = input.source_event_id;
  } else {
    sourceEventId = await resolveSourceEventId(db, sessionId, input.suggestion_kind);
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
    suggestion_kind: input.suggestion_kind,
    chip_label: input.chip_label,
    source_event_id: sourceEventId,
  };
  if (input.target_tool) payload.target_tool = input.target_tool;
  if (input.target_args) payload.target_args = input.target_args;

  // Order matters: run the proposal accept BEFORE persisting the chip event.
  // writeEvent-first + a failing accept would leave a counted accept_suggestion
  // behind, and the retry would write a second one — double-counting the KPI
  // for an action that never completed. Accept-first trades that silent
  // double-count for an under-count on the rare accept-OK / write-fails window:
  // acceptAiProposal is idempotent only for kinds whose dispatch honors
  // `result.idempotent`, so for the others a retry surfaces an error instead of
  // double-counting. Under-count + recoverable is the lesser evil.
  if (input.proposal_id) {
    await acceptAiProposal(db, input.proposal_id);
    // A chip-driven proposal accept is a topology mutation; best-effort
    // hub-sync wake AFTER commit. Fire-and-forget, so the response never waits
    // on pg-boss availability/latency; the seam swallows its own errors.
    void wakeHubSyncAfterCommit();
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
  return { eventId: chipEventId };
}

export async function requestTeachingChipAcceptance(
  db: Db,
  params: Record<string, string>,
  readBody: () => Promise<unknown>,
): Promise<{ ok: true; event_id: string }> {
  const { id: sessionId } = CopilotRouteIdParamsSchema.parse(params);
  const raw = await readBody().catch(() => null);
  const parsed = AcceptTeachingChipBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      'validation_error',
      parsed.error.issues.map((i) => i.message).join('; '),
      400,
    );
  }

  const outcome = await acceptTeachingChip(db, sessionId, parsed.data);
  return { ok: true, event_id: outcome.eventId };
}
