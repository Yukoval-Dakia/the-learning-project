import { beforeEach, describe, expect, it } from 'vitest';

import { resetDb, testDb } from '../../../tests/helpers/db';
import { createToolOperations } from './tool-operations';

describe('ToolOperations', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('does not recover a live owner and eventually recovers an expired lease', async () => {
    let clock = new Date('2026-08-27T12:00:00Z');
    const oldOperations = createToolOperations(testDb(), {
      processId: 'api_boot_live_owner',
      now: () => clock,
      leaseDurationMs: 30_000,
    });
    await oldOperations.start(
      {
        id: 'toolop_leased_write',
        toolName: 'remote_write',
        effect: 'write',
        input: { mutation: { title: 'Held by a live process lease' } },
      },
      async () => new Promise<never>(() => undefined),
    );

    const recoveringProcess = createToolOperations(testDb(), {
      processId: 'api_boot_recovering',
      now: () => clock,
    });
    await expect(recoveringProcess.recoverLost()).resolves.toEqual([]);
    clock = new Date(clock.getTime() + 30_001);
    await expect(recoveringProcess.recoverLost()).resolves.toEqual([
      expect.objectContaining({
        id: 'toolop_leased_write',
        status: 'lost',
        sideEffectRisk: 'possible',
      }),
    ]);
  });
});
