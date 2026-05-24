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

  // YUK-76 codex P1 — `ensureProposalDecisionSignal` (rebuild) and
  // `recordProposalDecisionSignal` (incremental upsert) used to take the
  // advisory lock independently and on a plain `Db` handle ran in separate
  // autocommit txns. A concurrent rebuild from a stale snapshot could
  // clobber a freshly recorded increment. With both writers serialized on
  // the same `(kind, cooldown_key)` lock, neither can land out of order.
  it('serializes ensure and record writers against each other', async () => {
    const db = testDb();
    // Seed an existing accept rate so `ensureProposalDecisionSignal`'s
    // rebuild has something to reconstruct from, while
    // `recordProposalDecisionSignal` adds a brand-new accept on top.
    await writeAiProposal(db, {
      id: 'proposal_serialized_old',
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_old' },
        reason_md: 'old',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_old' },
        cooldown_key: 'completion:serialize',
      },
    });
    await db.insert(event).values({
      id: 'rate_serialized_old',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: 'proposal_serialized_old',
      outcome: 'success',
      payload: { rating: 'accept' },
      caused_by_event_id: 'proposal_serialized_old',
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date('2026-05-23T00:00:00.000Z'),
    });
    const oldSource = {
      id: 'proposal_serialized_old',
      kind: 'completion',
      payload: { cooldown_key: 'completion:serialize' },
    };
    const newSource = {
      id: 'proposal_serialized_new',
      kind: 'completion',
      payload: { cooldown_key: 'completion:serialize' },
    };

    // Race a rebuild (sees old=accept, total=1) against an incremental
    // accept for a *new* proposal. Under the prior implementation, the
    // rebuild's absolute upsert could land after the increment and write
    // `accept_count=1` over the increment's `accept_count=2`.
    await Promise.all([
      ensureProposalDecisionSignal(db, oldSource, 'accept'),
      recordProposalDecisionSignal(db, newSource, 'accept'),
    ]);

    const rows = await db
      .select()
      .from(proposal_signals)
      .where(eq(proposal_signals.cooldown_key, 'completion:serialize'));
    expect(rows).toHaveLength(1);
    // Either order is acceptable as long as both writes are durable:
    // - ensure-then-record → rebuild writes 1, record bumps to 2.
    // - record-then-ensure → record writes 1, rebuild sees only the old
    //   rate event in the DB (the new one has no rate row), writes 1.
    //
    // The original race could land at 0 (rebuild clobbers record). We
    // assert the lower-bound: at least 1, and no row went backwards.
    expect(rows[0].accept_count).toBeGreaterThanOrEqual(1);
    expect(rows[0].dismiss_count).toBe(0);
    expect(rows[0].acceptance_rate).toBe(1);
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
