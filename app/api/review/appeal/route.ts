import { db } from '@/db/client';
import { event } from '@/db/schema';
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
  if (judgeEvent.action !== 'judge') {
    return NextResponse.json({ error: 'caused_by_must_be_judge_event' }, { status: 400 });
  }

  const appealEventId = createId();
  await db.insert(event).values({
    id: appealEventId,
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
