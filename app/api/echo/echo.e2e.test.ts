import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { echo_jobs } from '@/db/schema';
import { readSSEUntil } from '../../../tests/helpers/sse';
import { startTestWorker } from '../../../tests/helpers/worker';
import { POST as enqueueEcho } from './route';
import { GET as openEvents } from './[id]/events/route';

describe('EchoJob E2E (acceptance gate #1)', () => {
  let teardown: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const w = await startTestWorker(db);
    teardown = w.teardown;
  });

  afterAll(async () => {
    if (teardown) await teardown();
  });

  it('POST → worker → DB → SSE end-to-end', async () => {
    const input = 'hello';
    const enqueueResp = await enqueueEcho(
      new Request('http://t/api/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input }),
      }),
    );
    expect(enqueueResp.status).toBe(200);
    const { businessId } = (await enqueueResp.json()) as { businessId: string };
    expect(businessId).toMatch(/^[a-z0-9]+$/i);

    // Open SSE and collect events until echo.completed arrives
    const sseResp = await openEvents(
      new Request(`http://t/api/echo/${businessId}/events`),
      { params: Promise.resolve({ id: businessId }) },
    );
    expect(sseResp.headers.get('Content-Type')).toContain('text/event-stream');

    const events = (await readSSEUntil(
      sseResp,
      (es) =>
        es.some(
          (e): e is { event_type: string; payload: { output: string } } =>
            typeof e === 'object' &&
            e !== null &&
            'event_type' in e &&
            (e as { event_type?: string }).event_type === 'echo.completed',
        ),
      { timeoutMs: 8_000 },
    )) as Array<{ event_id: number; event_type: string; payload: { input: string; output: string } }>;

    const completed = events.find((e) => e.event_type === 'echo.completed');
    expect(completed).toBeTruthy();
    expect(completed?.payload.input).toBe(input);
    expect(completed?.payload.output).toBe('olleh');

    // Verify DB row matches
    const rows = await db.select().from(echo_jobs).where(eq(echo_jobs.id, businessId));
    expect(rows).toHaveLength(1);
    expect(rows[0].output).toBe('olleh');
    expect(rows[0].status).toBe('completed');
  }, 15_000);
});
