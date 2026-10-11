// Prepared only: parent owns the coordinated real-DB backup/restore window.
import { sql } from 'drizzle-orm';
import { unzipSync, zipSync } from 'fflate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type PaidEffectInput,
  type PaidEffectState,
  computePaidEffectIdentity,
  computePaidEffectInputDigest,
} from '@/core/migration/paid-effect-protocol';
import { reservePaidEffect } from '@/db/paid-effect-store';
import { paid_effect, paid_effect_control } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memR2 } from '../../../tests/helpers/r2';
import { buildBackupArchive, restoreFromArchive } from './archive';
import { FK_ORDER } from './constants';

const family = 'backup_paid_family';
const generation = 17;
const created = new Date('2026-10-11T08:00:00.123Z');
const recorded = new Date('2026-10-11T08:01:00.456Z');
const applied = new Date('2026-10-11T08:02:00.789Z');
const updated = new Date('2026-10-11T08:03:00.123Z');
const lease = new Date('2099-01-01T00:00:00.456Z');
const states = ['pending', 'sending', 'unknown', 'receipt_ready', 'applied'] as const;
const archiveData = z.record(z.string(), z.array(z.record(z.string(), z.unknown())));

function effect(state: PaidEffectState) {
  const input: PaidEffectInput = {
    family,
    entityId: `entity_${state}`,
    entityRevision: 'frozen_revision',
    unit: 'feature/rep:2',
    input: {
      question: {
        prompt_md: '分类讨论含参函数，保留边界条件和必要充分性。\n'.repeat(45),
        choices: ['① 条件充分但非必要', '② 条件必要但非充分'],
        knowledge: [{ name: '边界条件', path: ['代数', '函数'], context: { figure: null } }],
      },
      settings: { reps: 3, strict: true, fallback: null },
    },
  };
  const identity = computePaidEffectIdentity(input);
  const result = {
    version: 1,
    outputText: '保留原始付费输出及其证据。\n'.repeat(40),
    evidence: [{ part: { id: 'part_2', labels: ['边界', '分类'] }, confidence: 0.875 }],
    usage: { input: 1234, output: 87 },
    unresolved: null,
  };
  const sent = state !== 'pending';
  const known = state === 'receipt_ready' || state === 'applied';
  const row = {
    family,
    entity_id: identity.entityId,
    entity_revision: identity.entityRevision,
    unit: identity.unit,
    input_digest: identity.inputDigest,
    input_json: input.input,
    state,
    fence: sent ? 8 : 0,
    delivery_id: sent ? `original_${state}` : null,
    delivery_backend: sent ? 'pg-boss' : null,
    delivery_tick: sent ? `original_tick_${state}` : null,
    send_lease_expires_at: state === 'sending' ? lease : null,
    result_json: known ? result : null,
    result_recorded_at: known ? recorded : null,
    application_json:
      state === 'applied'
        ? {
            version: 1,
            identity,
            resultDigest: computePaidEffectInputDigest(result),
            disposition: { status: 'matched', source: 'immutable_historical_receipt' },
            evidence: [{ revisions: ['r0', 'r1'], applied: true }],
          }
        : null,
    applied_at: state === 'applied' ? applied : null,
    application_attempts: known ? 3 : 0,
    last_application_error: state === 'receipt_ready' ? 'application acknowledgement lost' : null,
    unresolved_reason: state === 'unknown' ? 'paid outcome lost after send; never replay' : null,
    created_at: created,
    updated_at: updated,
  } satisfies typeof paid_effect.$inferInsert;
  return { input, identity, row };
}

async function seedLedger() {
  const db = testDb();
  await db.insert(paid_effect_control).values([
    { family, backend: 'pg-boss', generation, created_at: created, updated_at: updated },
    {
      family: 'backup_explicit_dbos',
      backend: 'dbos',
      generation: 29,
      created_at: created,
      updated_at: updated,
    },
  ]);
  await db.insert(paid_effect).values(states.map((state) => effect(state).row));
}

async function ledger() {
  const db = testDb();
  return {
    controls: await db.select().from(paid_effect_control).orderBy(paid_effect_control.family),
    effects: await db.select().from(paid_effect).orderBy(paid_effect.entity_id),
  };
}

async function archive() {
  const { stream } = await buildBackupArchive({ db: testDb(), r2: memR2(), includeAssets: false });
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decode(bytes: Uint8Array) {
  return archiveData.parse(JSON.parse(new TextDecoder().decode(unzipSync(bytes)['data.json'])));
}

describe('paid-effect durable backup contract', () => {
  beforeEach(resetDb);
  afterAll(resetDb);

  // @invariant data: restore preserves paid truth and ownership, so unresolved paid work remains held
  // @fails-if export omits either durable table, restore resets state/fence/owner/generation or a restored unknown can win a new send
  it('round-trips every paid state and control generation without reopening an unknown send', async () => {
    const db = testDb();
    await seedLedger();
    const before = await ledger();
    const rawControls = await db.execute(sql`select * from paid_effect_control`);
    const rawEffects = await db.execute(sql`select * from paid_effect`);
    const bytes = await archive();
    const entries = unzipSync(bytes);
    const manifest = z
      .object({ schema_version: z.string() })
      .parse(JSON.parse(new TextDecoder().decode(entries['manifest.json'])));
    expect(manifest.schema_version).toBe('4.26');
    expect(FK_ORDER.slice(-3)).toEqual(['paid_effect_control', 'paid_effect', 'provider_attempt']);
    const data = decode(bytes);
    // Compare the real exported payload with complete real PG rows, including
    // structured JSON, nullable receipts, owner/fence and timestamp serialization.
    expect(data.paid_effect_control).toEqual(expect.arrayContaining([...rawControls]));
    expect(data.paid_effect_control).toHaveLength(2);
    expect(data.paid_effect).toEqual(expect.arrayContaining([...rawEffects]));
    expect(data.paid_effect).toHaveLength(5);
    await db.delete(paid_effect);
    await db.delete(paid_effect_control);
    const restored = await restoreFromArchive({ db, r2: memR2(), bytes });
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({
      stats: {
        paid_effect_control: { inserted: 2 },
        paid_effect: { inserted: 5 },
      },
    });
    expect(await ledger()).toEqual(before);

    const unknown = effect('unknown');
    const delivery = {
      backend: 'pg-boss',
      deliveryId: 'post_restore_delivery',
      tickId: 'post_restore_tick',
      generation,
      leaseExpiresAt: lease,
    } as const;
    // Both calls use the production reserve entry and its real DB transaction.
    // Same identity is held by its state; changed revision is held by the entity gate.
    expect(await reservePaidEffect(db, unknown.input, delivery)).toEqual({
      kind: 'held',
      identity: unknown.identity,
      state: 'unknown',
      blockedBy: null,
    });
    const changed = { ...unknown.input, entityRevision: 'later_revision' };
    const changedIdentity = computePaidEffectIdentity(changed);
    expect(await reservePaidEffect(db, changed, delivery)).toEqual({
      kind: 'held',
      identity: changedIdentity,
      state: 'pending',
      blockedBy: unknown.identity,
    });
    const after = await ledger();
    expect(after.controls).toEqual(before.controls);
    expect(after.effects.filter((row) => row.entity_revision === 'frozen_revision')).toEqual(
      before.effects,
    );
    expect(after.effects.find((row) => row.entity_revision === 'later_revision')).toMatchObject({
      state: 'pending',
      fence: 0,
      delivery_id: null,
      delivery_backend: null,
      delivery_tick: null,
      send_lease_expires_at: null,
      result_json: null,
      application_json: null,
    });
    expect(after.effects).toHaveLength(6);
  });

  // @invariant data: incomplete current-version archives cannot erase durable paid truth
  // @fails-if absent required keys in an otherwise empty 4.26 archive are treated as empty tables and the live ledger is wiped
  it('rejects missing paid payload in an empty 4.26 archive before wiping live truth', async () => {
    const db = testDb();
    const bytes = await archive();
    const entries = unzipSync(bytes);
    const data = decode(bytes);
    expect(data.paid_effect_control).toEqual([]);
    expect(data.paid_effect).toEqual([]);
    delete data.paid_effect_control;
    delete data.paid_effect;
    entries['data.json'] = new TextEncoder().encode(JSON.stringify(data));
    await seedLedger();
    const before = await ledger();
    const restored = await restoreFromArchive({ db, r2: memR2(), bytes: zipSync(entries) });
    expect(restored).toEqual({
      status: 400,
      body: {
        error: 'data_validation_failed',
        message: 'Paid-effect durability tables are missing; DB was NOT wiped.',
        issues: [
          'paid_effect_control: required durable table missing',
          'paid_effect: required durable table missing',
        ],
      },
    });
    expect(await ledger()).toEqual(before);
  });

  // @invariant data: old backup versions cannot cross the destructive restore boundary
  // @fails-if a structurally complete 4.25 archive is upgraded implicitly or wipes current paid receipts/ownership
  it('rejects a complete old-version archive before wiping live paid rows', async () => {
    const db = testDb();
    await seedLedger();
    const bytes = await archive();
    const entries = unzipSync(bytes);
    const manifest = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(new TextDecoder().decode(entries['manifest.json'])));
    entries['manifest.json'] = new TextEncoder().encode(
      JSON.stringify({ ...manifest, schema_version: '4.25' }),
    );
    // Distinguish the live target from the archived source, so any wipe/reload
    // would erase this new explicit owner even if the original rows reappeared.
    await db.insert(paid_effect_control).values({
      family: 'live_target_canary',
      backend: 'dbos',
      generation: 43,
      created_at: created,
      updated_at: updated,
    });
    const before = await ledger();
    const restored = await restoreFromArchive({ db, r2: memR2(), bytes: zipSync(entries) });
    expect(restored).toEqual({
      status: 400,
      body: {
        error: 'schema_version_mismatch',
        expected: '4.26',
        got: '4.25',
        message: 'schema_version mismatch: expected 4.26, got 4.25',
      },
    });
    expect(await ledger()).toEqual(before);
  });
});
