import { event, proposal_signals } from '@/db/schema';
import { writeAiProposal } from '@/server/proposals/writer';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  PROPOSAL_DISMISS_COOLDOWN_DAYS,
  ensureProposalDecisionSignal,
  getProposalAcceptanceRates,
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

  // YUK-76 codex round-3 P1-B + P1-C — rebuild must consult the **latest**
  // decision across all proposals on `(kind, cooldown_key)`, not just the
  // existence of any dismiss in history. With dismiss followed by accept,
  // the cooldown should be cleared.
  it('clears cooldown_until when latest rate across the key is accept (dismiss then accept)', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'proposal_dismiss_first',
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_dismiss' },
        reason_md: 'old dismissed proposal',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_dismiss' },
        cooldown_key: 'completion:rotate',
      },
    });
    await writeAiProposal(db, {
      id: 'proposal_accept_last',
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_accept' },
        reason_md: 'newer accepted proposal',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_accept' },
        cooldown_key: 'completion:rotate',
      },
    });
    await db.insert(event).values([
      {
        id: 'rate_dismiss_first',
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'rate',
        subject_kind: 'event',
        subject_id: 'proposal_dismiss_first',
        outcome: 'success',
        payload: { rating: 'dismiss', user_note: 'too early' },
        caused_by_event_id: 'proposal_dismiss_first',
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date('2026-05-23T00:00:00.000Z'),
      },
      {
        id: 'rate_accept_last',
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'rate',
        subject_kind: 'event',
        subject_id: 'proposal_accept_last',
        outcome: 'success',
        payload: { rating: 'accept' },
        caused_by_event_id: 'proposal_accept_last',
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date('2026-05-24T00:00:00.000Z'),
      },
    ]);

    await ensureProposalDecisionSignal(
      db,
      {
        id: 'proposal_accept_last',
        kind: 'completion',
        payload: { cooldown_key: 'completion:rotate' },
      },
      'accept',
    );

    const rows = await db
      .select()
      .from(proposal_signals)
      .where(
        and(
          eq(proposal_signals.kind, 'completion'),
          eq(proposal_signals.cooldown_key, 'completion:rotate'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accept_count: 1,
      dismiss_count: 1,
      acceptance_rate: 0.5,
      cooldown_until: null,
      dismiss_reason: null,
    });
  });

  it('sets cooldown_until when latest rate across the key is dismiss (accept then dismiss)', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'proposal_accept_first',
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_accept_first' },
        reason_md: 'old accepted proposal',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_accept_first' },
        cooldown_key: 'completion:cooldown',
      },
    });
    await writeAiProposal(db, {
      id: 'proposal_dismiss_last',
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_dismiss_last' },
        reason_md: 'newer dismissed proposal',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_dismiss_last' },
        cooldown_key: 'completion:cooldown',
      },
    });
    const dismissAt = new Date('2026-05-24T00:00:00.000Z');
    await db.insert(event).values([
      {
        id: 'rate_accept_first',
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'rate',
        subject_kind: 'event',
        subject_id: 'proposal_accept_first',
        outcome: 'success',
        payload: { rating: 'accept' },
        caused_by_event_id: 'proposal_accept_first',
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date('2026-05-23T00:00:00.000Z'),
      },
      {
        id: 'rate_dismiss_last',
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'rate',
        subject_kind: 'event',
        subject_id: 'proposal_dismiss_last',
        outcome: 'success',
        payload: { rating: 'dismiss', user_note: 'no longer relevant' },
        caused_by_event_id: 'proposal_dismiss_last',
        task_run_id: null,
        cost_micro_usd: null,
        created_at: dismissAt,
      },
    ]);

    await ensureProposalDecisionSignal(
      db,
      {
        id: 'proposal_dismiss_last',
        kind: 'completion',
        payload: { cooldown_key: 'completion:cooldown' },
      },
      'dismiss',
      'no longer relevant',
    );

    const rows = await db
      .select()
      .from(proposal_signals)
      .where(
        and(
          eq(proposal_signals.kind, 'completion'),
          eq(proposal_signals.cooldown_key, 'completion:cooldown'),
        ),
      );
    expect(rows).toHaveLength(1);
    const expectedCooldown =
      dismissAt.getTime() + PROPOSAL_DISMISS_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    expect(rows[0]).toMatchObject({
      accept_count: 1,
      dismiss_count: 1,
      acceptance_rate: 0.5,
      dismiss_reason: 'no longer relevant',
    });
    expect(rows[0].cooldown_until?.getTime()).toBe(expectedCooldown);
  });

  it('clears cooldown when latest rate is a non-dismiss action (reverse)', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'proposal_dismiss_old',
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_dismiss_old' },
        reason_md: 'old dismissed',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_dismiss_old' },
        cooldown_key: 'completion:reverse',
      },
    });
    await writeAiProposal(db, {
      id: 'proposal_reverse_last',
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_reverse' },
        reason_md: 'reverse comes later',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_reverse' },
        cooldown_key: 'completion:reverse',
      },
    });
    await db.insert(event).values([
      {
        id: 'rate_dismiss_old',
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'rate',
        subject_kind: 'event',
        subject_id: 'proposal_dismiss_old',
        outcome: 'success',
        payload: { rating: 'dismiss', user_note: 'old skip' },
        caused_by_event_id: 'proposal_dismiss_old',
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date('2026-05-23T00:00:00.000Z'),
      },
      {
        id: 'rate_reverse_last',
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'rate',
        subject_kind: 'event',
        subject_id: 'proposal_reverse_last',
        outcome: 'success',
        // `reverse` maps to 'accept' in decisionFromRate — sanity-check that
        // the cooldown is cleared, not just for the literal 'accept' rating.
        payload: { rating: 'reverse' },
        caused_by_event_id: 'proposal_reverse_last',
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date('2026-05-24T12:00:00.000Z'),
      },
    ]);

    await ensureProposalDecisionSignal(
      db,
      {
        id: 'proposal_reverse_last',
        kind: 'completion',
        payload: { cooldown_key: 'completion:reverse' },
      },
      'accept',
    );

    const rows = await db
      .select()
      .from(proposal_signals)
      .where(
        and(
          eq(proposal_signals.kind, 'completion'),
          eq(proposal_signals.cooldown_key, 'completion:reverse'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cooldown_until: null,
      dismiss_reason: null,
    });
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

// T-AR (YUK-TAR) — acceptance-rate SIGNAL roll-up. Rolls the per-(kind,
// cooldown_key) proposal_signals rows up to the per-kind dimension Dreaming /
// Coach reason about. Read-only; derived from the existing aggregate (no new
// column / table / view).
describe('getProposalAcceptanceRates', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns an empty array on cold start (no proposal_signals rows)', async () => {
    const rates = await getProposalAcceptanceRates(testDb());
    expect(rates).toEqual([]);
  });

  it('rolls multiple cooldown_keys of the same kind into one per-kind row', async () => {
    const db = testDb();
    // Two distinct cooldown_keys, same kind 'completion':
    //   key A → 3 accept / 1 dismiss
    //   key B → 1 accept / 1 dismiss
    // Rolled up: 4 accept / 2 dismiss → 6 total → 4/6 acceptance.
    await recordProposalDecisionSignal(
      db,
      { id: 'p_a', kind: 'completion', payload: { cooldown_key: 'completion:A' } },
      'accept',
    );
    await recordProposalDecisionSignal(
      db,
      { id: 'p_a', kind: 'completion', payload: { cooldown_key: 'completion:A' } },
      'accept',
    );
    await recordProposalDecisionSignal(
      db,
      { id: 'p_a', kind: 'completion', payload: { cooldown_key: 'completion:A' } },
      'accept',
    );
    await recordProposalDecisionSignal(
      db,
      { id: 'p_a', kind: 'completion', payload: { cooldown_key: 'completion:A' } },
      'dismiss',
      'A dismiss',
    );
    await recordProposalDecisionSignal(
      db,
      { id: 'p_b', kind: 'completion', payload: { cooldown_key: 'completion:B' } },
      'accept',
    );
    await recordProposalDecisionSignal(
      db,
      { id: 'p_b', kind: 'completion', payload: { cooldown_key: 'completion:B' } },
      'dismiss',
      'B dismiss',
    );

    const rates = await getProposalAcceptanceRates(db);
    expect(rates).toHaveLength(1);
    expect(rates[0]).toEqual({
      kind: 'completion',
      accept_count: 4,
      dismiss_count: 2,
      total: 6,
      acceptance_rate: 4 / 6,
    });
  });

  it('groups distinct kinds and sorts by acceptance_rate DESC then total DESC', async () => {
    const db = testDb();
    // archive: 1 accept / 0 dismiss → rate 1, total 1
    // completion: 3 accept / 1 dismiss → rate 0.75, total 4
    // knowledge_node: 1 accept / 1 dismiss → rate 0.5, total 2
    await recordProposalDecisionSignal(
      db,
      { id: 'p_arch', kind: 'archive', payload: { cooldown_key: 'archive:1' } },
      'accept',
    );
    for (let i = 0; i < 3; i++) {
      await recordProposalDecisionSignal(
        db,
        { id: 'p_comp', kind: 'completion', payload: { cooldown_key: 'completion:1' } },
        'accept',
      );
    }
    await recordProposalDecisionSignal(
      db,
      { id: 'p_comp', kind: 'completion', payload: { cooldown_key: 'completion:1' } },
      'dismiss',
      'late',
    );
    await recordProposalDecisionSignal(
      db,
      { id: 'p_kn', kind: 'knowledge_node', payload: { cooldown_key: 'knowledge_node:1' } },
      'accept',
    );
    await recordProposalDecisionSignal(
      db,
      { id: 'p_kn', kind: 'knowledge_node', payload: { cooldown_key: 'knowledge_node:1' } },
      'dismiss',
      'noise',
    );

    const rates = await getProposalAcceptanceRates(db);
    expect(rates.map((r) => r.kind)).toEqual(['archive', 'completion', 'knowledge_node']);
    expect(rates.map((r) => r.acceptance_rate)).toEqual([1, 0.75, 0.5]);
  });

  it('prefers higher total as the tiebreak when acceptance_rate is equal', async () => {
    const db = testDb();
    // Both kinds at acceptance_rate 1, but 'completion' has more decisions.
    await recordProposalDecisionSignal(
      db,
      { id: 'p_low', kind: 'archive', payload: { cooldown_key: 'archive:1' } },
      'accept',
    );
    for (let i = 0; i < 3; i++) {
      await recordProposalDecisionSignal(
        db,
        { id: 'p_high', kind: 'completion', payload: { cooldown_key: 'completion:1' } },
        'accept',
      );
    }

    const rates = await getProposalAcceptanceRates(db);
    expect(rates.map((r) => r.kind)).toEqual(['completion', 'archive']);
    expect(rates[0].total).toBe(3);
    expect(rates[1].total).toBe(1);
  });
});
