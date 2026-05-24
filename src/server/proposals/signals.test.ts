import { event, proposal_signals } from '@/db/schema';
import { writeAiProposal } from '@/server/proposals/writer';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  PROPOSAL_DISMISS_COOLDOWN_DAYS,
  ensureProposalDecisionSignal,
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

  it('backfills the current proposal decision when the same key already has history', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'proposal_old',
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_old' },
        reason_md: 'old proposal',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_old' },
        cooldown_key: 'completion:li1',
      },
    });
    await writeAiProposal(db, {
      id: 'proposal_current',
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_current' },
        reason_md: 'current proposal',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_current' },
        cooldown_key: 'completion:li1',
      },
    });
    await db.insert(event).values([
      {
        id: 'rate_old',
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'rate',
        subject_kind: 'event',
        subject_id: 'proposal_old',
        outcome: 'success',
        payload: { rating: 'accept' },
        caused_by_event_id: 'proposal_old',
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date('2026-05-23T00:00:00.000Z'),
      },
      {
        id: 'rate_current',
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'rate',
        subject_kind: 'event',
        subject_id: 'proposal_current',
        outcome: 'success',
        payload: { rating: 'dismiss', user_note: 'skip' },
        caused_by_event_id: 'proposal_current',
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date('2026-05-24T00:00:00.000Z'),
      },
    ]);
    await recordProposalDecisionSignal(
      db,
      {
        id: 'proposal_old',
        kind: 'completion',
        payload: { cooldown_key: 'completion:li1' },
      },
      'accept',
    );

    await ensureProposalDecisionSignal(
      db,
      {
        id: 'proposal_current',
        kind: 'completion',
        payload: { cooldown_key: 'completion:li1' },
      },
      'dismiss',
      'skip',
    );

    const rows = await db
      .select()
      .from(proposal_signals)
      .where(
        and(
          eq(proposal_signals.kind, 'completion'),
          eq(proposal_signals.cooldown_key, 'completion:li1'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accept_count: 1,
      dismiss_count: 1,
      acceptance_rate: 0.5,
      dismiss_reason: 'skip',
    });
  });
});
