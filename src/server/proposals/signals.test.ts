import { proposal_signals } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  PROPOSAL_DISMISS_COOLDOWN_DAYS,
  loadProposalSignalsForRows,
  recordProposalDecisionSignal,
} from './signals';

const source = {
  id: 'proposal_1',
  kind: 'completion',
  payload: { cooldown_key: 'completion:li1' },
};

describe('proposal signals', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates an accept signal with acceptance_rate=1', async () => {
    await recordProposalDecisionSignal(testDb(), source, 'accept');

    const rows = await testDb().select().from(proposal_signals);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'completion',
      cooldown_key: 'completion:li1',
      accept_count: 1,
      dismiss_count: 0,
      acceptance_rate: 1,
      cooldown_until: null,
    });
  });

  it('records dismiss reason, recomputes rate, and starts a seven day cooldown', async () => {
    await recordProposalDecisionSignal(testDb(), source, 'accept');
    const beforeDismiss = Date.now();
    await recordProposalDecisionSignal(testDb(), source, 'dismiss', 'too early');

    const rows = await testDb()
      .select()
      .from(proposal_signals)
      .where(eq(proposal_signals.cooldown_key, 'completion:li1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accept_count: 1,
      dismiss_count: 1,
      acceptance_rate: 0.5,
      dismiss_reason: 'too early',
    });
    expect(rows[0].cooldown_until).toBeInstanceOf(Date);
    const minCooldown = beforeDismiss + PROPOSAL_DISMISS_COOLDOWN_DAYS * 24 * 60 * 60 * 1000 - 1000;
    expect(rows[0].cooldown_until?.getTime()).toBeGreaterThanOrEqual(minCooldown);
  });

  it('loads signals by proposal id and ignores rows without cooldown keys', async () => {
    await recordProposalDecisionSignal(testDb(), source, 'dismiss', 'skip');

    const signals = await loadProposalSignalsForRows(testDb(), [
      source,
      { id: 'proposal_2', kind: 'completion', payload: {} },
    ]);

    expect(signals.get('proposal_1')).toMatchObject({
      dismiss_count: 1,
      acceptance_rate: 0,
      dismiss_reason: 'skip',
    });
    expect(signals.has('proposal_2')).toBe(false);
  });
});
