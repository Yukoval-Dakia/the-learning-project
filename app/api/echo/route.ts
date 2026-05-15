import { createId } from '@paralleldrive/cuid2';
import { z } from 'zod';

import { db } from '@/db/client';
import { echo_jobs } from '@/db/schema';
import { createBoss } from '@/server/boss/client';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

const Body = z.object({
  input: z.string().min(1, 'input is required'),
});

/**
 * EchoJob endpoint —— Sub 0c golden E2E acceptance gate #1。
 *
 * 流程：
 *   1. INSERT echo_jobs(id=businessId, input, status='queued')
 *   2. boss.send('echo', { businessId, input }) → pg-boss 入队
 *   3. 返回 { businessId, jobId }
 *
 * 客户端拿 businessId 开 SSE：GET /api/echo/[id]/events
 * worker 跑完后通过 LISTEN/NOTIFY 推给 SSE。
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const { input } = parsed.data;
    const businessId = createId();
    const now = new Date();

    await db.insert(echo_jobs).values({
      id: businessId,
      input,
      status: 'queued',
      created_at: now,
      updated_at: now,
    });

    const boss = createBoss();
    const jobId = await boss.send('echo', { businessId, input });

    return Response.json({ businessId, jobId });
  } catch (err) {
    return errorResponse(err);
  }
}
