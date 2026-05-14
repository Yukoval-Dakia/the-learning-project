import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { job_events } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { writeJobEvent } from './writer';

describe('writeJobEvent', () => {
  it('inserts a row into job_events within a transaction', async () => {
    const businessId = `wt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const id = await db.transaction(async (tx) => {
      return await writeJobEvent(tx, {
        business_table: 'test_writer',
        business_id: businessId,
        event_type: 'test.created',
        payload: { hello: 'world' },
      });
    });

    expect(typeof id).toBe('number');

    const rows = await db
      .select()
      .from(job_events)
      .where(
        and(eq(job_events.business_table, 'test_writer'), eq(job_events.business_id, businessId)),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('test.created');
    expect(rows[0].payload).toEqual({ hello: 'world' });
    expect(rows[0].id).toBe(id);
  });

  describe('with separate LISTEN client', () => {
    let listenClient: ReturnType<typeof postgres>;
    const received: string[] = [];

    beforeAll(async () => {
      // biome-ignore lint/style/noNonNullAssertion: tests/global-setup.ts guarantees DATABASE_URL
      const url = process.env.DATABASE_URL!;
      listenClient = postgres(url, { max: 1 });
      await listenClient.listen('job_status', (payload) => {
        received.push(payload);
      });
      // small delay to ensure LISTEN is registered before we trigger
      await new Promise((r) => setTimeout(r, 100));
    });

    afterAll(async () => {
      await listenClient.end({ timeout: 1 });
    });

    it('fires pg_notify on commit (separate LISTEN client receives payload)', async () => {
      const businessId = `wt_notify_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      await db.transaction(async (tx) => {
        await writeJobEvent(tx, {
          business_table: 'test_writer_notify',
          business_id: businessId,
          event_type: 'test.notified',
          payload: { ping: 1 },
        });
      });

      // Wait briefly for NOTIFY to arrive on listen channel
      await new Promise((r) => setTimeout(r, 200));

      const myNotification = received.find((p) => p.includes(businessId));
      expect(myNotification).toBeTruthy();
      if (myNotification) {
        const parsed = JSON.parse(myNotification);
        expect(parsed.business_table).toBe('test_writer_notify');
        expect(parsed.business_id).toBe(businessId);
        expect(typeof parsed.event_id).toBe('number');
      }
    });
  });
});
