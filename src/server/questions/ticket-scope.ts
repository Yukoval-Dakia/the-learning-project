// Ticket-scoped question authority. A ticket-bound preparer run may create a new question
// and repair the questions that same ticket produced, but may not replace an unrelated
// published question's current revision. Checked inside the write transaction; the model
// cannot set or clear the ticket scope (it comes from durable job data).
import { and, eq } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { event } from '@/db/schema';

const ASSESSMENT_PUBLISH_ACTION = 'experimental:assessment_publish';

/** Null when the group has a publication caused by this ticket; otherwise a typed denial. */
export async function ticketScopeIssue(
  tx: Tx,
  ticketEventId: string | null | undefined,
  groupId: string | null,
): Promise<{ code: string; detail: string } | null> {
  if (ticketEventId == null || groupId == null) return null;
  const [publication] = await tx
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, ASSESSMENT_PUBLISH_ACTION),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, groupId),
        eq(event.caused_by_event_id, ticketEventId),
      ),
    )
    .limit(1);
  return publication
    ? null
    : {
        code: 'ticket_scope_denied',
        detail:
          'This ticket did not create this question. Create a new question for the gap instead of editing an existing one.',
      };
}
