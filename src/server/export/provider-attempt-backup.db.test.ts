import { ProviderRequestIdentity } from '@/core/schema/provider-attempt';
import { provider_attempt, provider_attempt_admission } from '@/db/schema';
import { createProviderAttemptLifecycle } from '@/server/ai/provider-attempt-lifecycle';
import { eq } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memR2 } from '../../../tests/helpers/r2';
import { buildBackupArchive, restoreFromArchive } from './archive';

const ATTEMPT_ID = '00000000-0000-4000-8000-000000000918';

async function buildZipBytes(): Promise<Uint8Array> {
  const { stream } = await buildBackupArchive({
    db: testDb(),
    r2: memR2(),
    includeAssets: false,
  });
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('provider attempt backup lifecycle', () => {
  beforeEach(resetDb);
  afterAll(resetDb);

  it('restores a reserved nonterminal attempt as a recovery-required orphan', async () => {
    // Given a reserved nonterminal provider attempt and its operational owner lease.
    const deadlineAt = new Date(Date.now() + 60_000);
    const identity = ProviderRequestIdentity.parse({
      attemptId: ATTEMPT_ID,
      operationId: '00000000-0000-4000-8000-000000000919',
      attemptKind: 'wire',
      provider: 'xiaomi',
      model: 'mimo-v2.5',
      lane: 'generation',
      protocol: 'anthropic-compatible',
      endpointClass: 'messages',
      caller: 'worker',
      operationKind: 'QuestionGenerateTask',
    });
    const handle = await createProviderAttemptLifecycle({
      mode: 'enforce',
      identity,
      deadlineAt,
      db: testDb(),
    }).acquire();
    await handle.reserveProviderStart();

    // When production archive export and restore run after durable truth is removed.
    const bytes = await buildZipBytes();
    const data = JSON.parse(new TextDecoder().decode(unzipSync(bytes)['data.json'])) as Record<
      string,
      Array<Record<string, unknown>>
    >;
    expect(data.provider_attempt).toHaveLength(1);
    expect(data.provider_attempt?.[0]).toMatchObject({
      attempt_id: ATTEMPT_ID,
      provider_start_reserved_at: expect.any(String),
      terminal_status: null,
      finished_at: null,
    });
    expect(data.provider_attempt_admission).toBeUndefined();
    await testDb().delete(provider_attempt).where(eq(provider_attempt.attempt_id, ATTEMPT_ID));
    const restored = await restoreFromArchive({ db: testDb(), r2: memR2(), bytes });

    // Then durable truth returns without an owner and same-deadline acquisition requires recovery.
    expect(restored.status).toBe(200);
    const restoredAttempt = await testDb()
      .select()
      .from(provider_attempt)
      .where(eq(provider_attempt.attempt_id, ATTEMPT_ID));
    expect(restoredAttempt).toEqual([
      expect.objectContaining({
        attempt_id: ATTEMPT_ID,
        provider_start_reserved_at: expect.any(Date),
        terminal_status: null,
        finished_at: null,
      }),
    ]);
    expect(await testDb().select().from(provider_attempt_admission)).toEqual([]);
    await expect(
      createProviderAttemptLifecycle({
        mode: 'enforce',
        identity,
        deadlineAt,
        db: testDb(),
      }).acquire(),
    ).rejects.toMatchObject({ reason: 'recovery_required' });
    expect(
      await testDb()
        .select()
        .from(provider_attempt)
        .where(eq(provider_attempt.attempt_id, ATTEMPT_ID)),
    ).toEqual(restoredAttempt);
    expect(await testDb().select().from(provider_attempt_admission)).toEqual([]);
  });
});
