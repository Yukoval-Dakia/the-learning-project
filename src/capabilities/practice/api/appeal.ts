import { REJUDGE_SINGLETON_SECONDS } from '@/capabilities/practice/jobs/rejudge-config';
import { db } from '@/db/client';
import { event } from '@/db/schema';
import { getStartedBoss } from '@/server/boss/client';
import { writeEvent } from '@/server/events/queries';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const AppealRequestSchema = z.object({
  /** The judge event being appealed (must exist + action='judge'). */
  judge_event_id: z.string().min(1),
  /** Learner-provided objection. D15: 申诉 = 请 AI 带用户理由重判。 */
  reason_md: z.string().max(2000).optional(),
});

/**
 * M2 (YUK-316, D15) — 申诉自动重判链入口。
 *
 * 旧 M2.3 stub 写 appeal_request event 后产出 judge-retraction proposal（人审）。
 * D15 裁决：判分属软判断层 → 申诉直接触发异步重判（pg-boss `rejudge` job），
 * 重判结果直接生效（correction event 留痕，无 proposal）。appeal_request event
 * 照旧写入（它是 rejudge 的幂等键与 caused_by 锚点）。
 *
 * Auth: middleware enforces `x-internal-token` on all `/api/*` except /health.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = AppealRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const { judge_event_id, reason_md } = parsed.data;

  const [judgeEvent] = await db.select().from(event).where(eq(event.id, judge_event_id));
  if (!judgeEvent) {
    return Response.json({ error: 'judge_event_not_found' }, { status: 404 });
  }
  if (judgeEvent.action !== 'judge') {
    return Response.json({ error: 'evidence_ref_must_be_judge_event' }, { status: 422 });
  }

  // ADR-0005 single-owner: all event inserts go through writeEvent.
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

  // 异步重判（不阻塞流——设计稿「重判中 · 不阻塞，先继续」）。singletonKey =
  // appeal event id + singletonSeconds：同一申诉的并发/重复 enqueue 折叠成一个
  // job（YUK-491：standard-policy 队列上裸 singletonKey inert，须配 seconds 才
  // 真去重；handler caused_by 查重是结构性兜底）。测试环境
  // （shouldEnqueueBackgroundJobs false）只写事件，由测试直接调 handler。
  if (shouldEnqueueBackgroundJobs()) {
    const boss = await getStartedBoss();
    await boss.send(
      'rejudge',
      { appeal_event_id: appealEventId },
      { singletonKey: appealEventId, singletonSeconds: REJUDGE_SINGLETON_SECONDS },
    );
  }

  return Response.json({ appeal_event_id: appealEventId });
}
