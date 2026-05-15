import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { job_events } from '@/db/schema';
import { runPruneJobEvents } from './prune_job_events';

describe('prune_job_events handler', () => {
  it('deletes events older than 30 days, keeps recent ones', async () => {
    const tag = `prune_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Insert old event (35 days ago) and recent event (1 hour ago)
    const longAgo = new Date(Date.now() - 35 * 86400 * 1000);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    await db.insert(job_events).values({
      business_table: tag,
      business_id: 'old_id',
      event_type: 'test.old',
      payload: {},
      occurred_at: longAgo,
    });
    await db.insert(job_events).values({
      business_table: tag,
      business_id: 'recent_id',
      event_type: 'test.recent',
      payload: {},
      occurred_at: oneHourAgo,
    });

    // Verify both present
    const before = await db
      .select()
      .from(job_events)
      .where(sql`${job_events.business_table} = ${tag}`);
    expect(before).toHaveLength(2);

    await runPruneJobEvents(db);

    const after = await db
      .select()
      .from(job_events)
      .where(sql`${job_events.business_table} = ${tag}`);
    expect(after).toHaveLength(1);
    expect(after[0].business_id).toBe('recent_id');

    // Cleanup
    await db.delete(job_events).where(sql`${job_events.business_table} = ${tag}`);
  });
});
