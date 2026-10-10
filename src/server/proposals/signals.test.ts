import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { proposal_signals } from '@/db/schema';
import { recordProposalDecisionSignal } from '@/kernel/proposals/signals';
import { resetDb, testDb } from '../../../tests/helpers/db';

const source = {
  id: 'proposal_1',
  kind: 'completion',
  payload: { cooldown_key: 'completion:li1' },
};

describe('proposal signals', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('applies concurrent decision updates atomically', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        recordProposalDecisionSignal(testDb(), source, 'dismiss', `dismiss ${index}`),
      ),
    );

    const rows = await testDb()
      .select()
      .from(proposal_signals)
      .where(eq(proposal_signals.cooldown_key, 'completion:li1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accept_count: 0,
      dismiss_count: 10,
      acceptance_rate: 0,
    });
  });
});
