import { eq } from 'drizzle-orm';
import { REJUDGE_SINGLETON_SECONDS } from '@/capabilities/practice/jobs/rejudge-config';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { shouldEnqueueBackgroundJobs } from '@/kernel/background-job-enqueue';
import { errorResponse } from '@/kernel/http';
import { CreateAppealBodySchema } from '../api/contracts';
import { createNativeAppeal } from './assessment/appeal';
import { getPracticeBoss } from './queue-runtime';

/**
 * 申诉自动重判链入口。
 *
 * 判分属软判断层，所以申诉直接触发异步重判（pg-boss `rejudge` job），重判结果
 * 直接生效，correction event 留痕而非 proposal。appeal_request event 照旧写入，
 * 它是 rejudge 的幂等键与 caused_by 锚点。
 *
 * Auth: middleware enforces `x-internal-token` on all `/api/*` except /health.
 */
export async function createPracticeAppeal(
  db: Db,
  loadBody: () => Promise<unknown>,
): Promise<Response> {
  let body: unknown;
  try {
    body = await loadBody();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = CreateAppealBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  if ('evaluation_id' in parsed.data) {
    try {
      const appealEventId = await createNativeAppeal(db, parsed.data);
      if (shouldEnqueueBackgroundJobs()) {
        const boss = await getPracticeBoss();
        await boss.send(
          'rejudge',
          { appeal_event_id: appealEventId },
          { singletonKey: appealEventId, singletonSeconds: REJUDGE_SINGLETON_SECONDS },
        );
      }
      return Response.json({ appeal_event_id: appealEventId });
    } catch (error) {
      return errorResponse(error);
    }
  }
  const { judge_event_id } = parsed.data;

  const [judgeEvent] = await db.select().from(event).where(eq(event.id, judge_event_id));
  if (!judgeEvent) {
    return Response.json({ error: 'judge_event_not_found' }, { status: 404 });
  }
  if (judgeEvent.action !== 'judge') {
    return Response.json({ error: 'evidence_ref_must_be_judge_event' }, { status: 422 });
  }

  // Historical judgments remain readable; no frozen original means no new execution.
  return Response.json({ error: 'historical_unknown' }, { status: 409 });
}
