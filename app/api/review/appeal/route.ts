import { db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const AppealRequestSchema = z.object({
  /** The judge event being appealed (must exist + action='judge'). */
  judge_event_id: z.string().min(1),
  /** Optional learner-provided note. */
  reason_md: z.string().max(2000).optional(),
});

/**
 * M2.3 (2026-05-22): Appeal flow stub.
 *
 * Writes an `experimental:appeal_request` event chained off the judge event
 * (caused_by_event_id). DOES NOT trigger a rejudge — spec §3 M2 #8 explicitly
 * defers actual rejudge to M3+. The event records the user's intent; downstream
 * dreaming / review jobs may consume it.
 *
 * Auth: middleware enforces `x-internal-token` on all `/api/*` except /health.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = AppealRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { judge_event_id, reason_md } = parsed.data;

  const [judgeEvent] = await db.select().from(event).where(eq(event.id, judge_event_id));
  if (!judgeEvent) {
    return NextResponse.json({ error: 'judge_event_not_found' }, { status: 404 });
  }
  // M2.3: also accept 'attempt' events. The embedded-check flow
  // (app/api/embedded-check/attempt/route.ts) embeds judge result inside
  // the attempt event payload rather than writing a separate judge event.
  // M3+ may split this if a dedicated judge-event chain is needed.
  if (judgeEvent.action !== 'judge' && judgeEvent.action !== 'attempt') {
    return NextResponse.json({ error: 'caused_by_must_be_judge_or_attempt' }, { status: 400 });
  }

  // ADR-0005 single-owner: all event inserts go through writeEvent
  // (which calls parseEvent() against the experimental:* schema and
  // throws on shape mismatch).
  const appealEventId = await writeEvent(db, {
    id: createId(),
    session_id: judgeEvent.session_id,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:appeal_request',
    subject_kind: 'event',
    subject_id: judge_event_id,
    outcome: null,
    payload: { reason_md: reason_md ?? '' },
    caused_by_event_id: judge_event_id,
  });

  return NextResponse.json({ appeal_event_id: appealEventId });
}
