import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startListenLoop, stopListenLoop } from './listen_loop';
import { _clearSubscribersForTests, subscribe } from './sse_router';

describe('startListenLoop', () => {
  beforeAll(async () => {
    _clearSubscribersForTests();
    await startListenLoop();
    await new Promise((r) => setTimeout(r, 100));
  });

  afterAll(async () => {
    await stopListenLoop();
    _clearSubscribersForTests();
  });

  it('routes a NOTIFY job_status payload to matching SSE subscriber', async () => {
    const businessTable = 'test_listen';
    const businessId = `ll_${Date.now()}`;
    const received: unknown[] = [];

    const unsub = subscribe(businessTable, businessId, (evt: unknown) => {
      received.push(evt);
    });

    // Fire a NOTIFY via auto-commit client
    // biome-ignore lint/style/noNonNullAssertion: tests/global-setup.ts guarantees DATABASE_URL
    const sender = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const payload = JSON.stringify({
        event_id: 999,
        business_table: businessTable,
        business_id: businessId,
      });
      await sender.unsafe(`SELECT pg_notify('job_status', '${payload}')`);
    } finally {
      await sender.end({ timeout: 1 });
    }

    // Wait for NOTIFY → listen_loop → broadcast → subscriber
    await new Promise((r) => setTimeout(r, 300));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      event_id: 999,
      business_table: businessTable,
      business_id: businessId,
    });

    unsub();
  });

  it('ignores NOTIFY for other (table, id) pairs', async () => {
    const received: unknown[] = [];
    const unsub = subscribe('test_listen', 'never_match', (evt: unknown) => {
      received.push(evt);
    });

    // biome-ignore lint/style/noNonNullAssertion: tests/global-setup.ts guarantees DATABASE_URL
    const sender = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const payload = JSON.stringify({
        event_id: 1,
        business_table: 'test_listen',
        business_id: 'different_id',
      });
      await sender.unsafe(`SELECT pg_notify('job_status', '${payload}')`);
    } finally {
      await sender.end({ timeout: 1 });
    }

    await new Promise((r) => setTimeout(r, 200));

    expect(received).toHaveLength(0);
    unsub();
  });
});
