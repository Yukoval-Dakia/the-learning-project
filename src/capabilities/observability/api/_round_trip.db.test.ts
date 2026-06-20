/**
 * Round-trip test: GET /api/_/export → POST /api/_/import
 * Uses real test DB (postgres-js) + in-memory R2.
 * Verifies that data exported from a seeded DB is fully restored after a wipe.
 */
import {
  difficulty_calibration_label,
  edge_reconciliation_log,
  event,
  item_calibration,
  item_family_calibration,
  knowledge,
  mastery_state,
  selection_observation,
} from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { eq } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memR2 } from '../../../../tests/helpers/r2';
import { GET } from './backup-export';
import { POST } from './backup-import';

const r2 = memR2();
vi.mock('@/server/r2', () => ({
  getR2: () => r2,
  createR2Client: () => r2,
}));

describe('round-trip: export → import → DB state mirrored', () => {
  beforeEach(async () => {
    r2._store.clear();
    await resetDb();
  });

  it('preserves knowledge rows and resets event ingest cursor end-to-end', async () => {
    const db = testDb();

    // 1. Seed DB with fixtures
    const now = new Date('2024-01-01T00:00:00Z');
    await db.insert(knowledge).values({
      id: 'k1',
      name: '虚词',
      domain: 'wenyan',
      parent_id: null,
      merged_from: [],
      archived_at: null,
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await writeEvent(db, {
      id: 'e1',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'failure',
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: [],
      },
      created_at: now,
    });
    await db.update(event).set({ ingest_at: now }).where(eq(event.id, 'e1'));

    // 2. Export
    const exportRes = await GET(new Request('http://localhost/api/_/export'));
    expect(exportRes.status).toBe(200);
    const ab = await exportRes.arrayBuffer();
    const entries = unzipSync(new Uint8Array(ab));
    expect(entries['data.json']).toBeDefined();
    expect(entries['manifest.json']).toBeDefined();

    const data = JSON.parse(new TextDecoder().decode(entries['data.json'])) as {
      event: Array<{ ingest_at: string | null }>;
      knowledge: unknown[];
    };
    expect(data.knowledge).toHaveLength(1);
    expect(data.event[0].ingest_at).not.toBeNull();

    // 3. Wipe DB
    await resetDb();
    const rowsAfterWipe = await db.select().from(knowledge);
    expect(rowsAfterWipe).toHaveLength(0);

    // 4. Import
    const importRes = await POST(
      new Request('http://localhost/api/_/import?confirm=wipe-and-reload', {
        method: 'POST',
        body: new Uint8Array(ab),
        headers: { 'content-type': 'application/zip' },
      }),
    );
    if (importRes.status !== 200) {
      const errBody = await importRes.clone().json();
      console.error('Import failed:', JSON.stringify(errBody, null, 2));
    }
    expect(importRes.status).toBe(200);
    const body = (await importRes.json()) as {
      ok: boolean;
      stats: Record<string, { inserted: number }>;
    };
    expect(body.ok).toBe(true);
    expect(body.stats.knowledge.inserted).toBe(1);

    // 5. Verify DB rows restored
    const rowsAfterImport = await db.select().from(knowledge);
    expect(rowsAfterImport).toHaveLength(1);
    expect(rowsAfterImport[0].id).toBe('k1');
    expect(rowsAfterImport[0].name).toBe('虚词');
    const eventsAfterImport = await db.select().from(event).where(eq(event.id, 'e1'));
    expect(eventsAfterImport).toHaveLength(1);
    expect(eventsAfterImport[0].ingest_at).toBeNull();
  });

  // YUK-356: the round-trip above only proves the knowledge single-table path. The
  // newly-backed-up slow-warming calibration / telemetry / reconciliation tables
  // added to FK_ORDER (mastery_state, item_calibration, item_family_calibration,
  // difficulty_calibration_label, selection_observation, edge_reconciliation_log)
  // carry the failure-prone column shapes: `real` (float4 — precision must survive
  // JS-number → JSON → ::real re-insert) and `jsonb` (nested objects/arrays/unicode
  // must round-trip byte-equal through restoreValue()'s JSON.stringify + bind). None
  // had a dump→restore assertion, so a regression in float4 handling or jsonb
  // serialisation on any of these slow-warming assets would ship silently.
  //
  // Assertion model: compare the DB read AFTER import to the DB read taken BEFORE
  // export. The pre-export read is already float4-rounded by Postgres, so any value
  // that survives the full dump → JSON → wipe → restore path byte-equal will deep-
  // equal it. Seeded literals deliberately include precision-sensitive reals (0.1,
  // negatives, many-digit fractions) and richly-nested jsonb (objects, arrays,
  // unicode, null leaves) so a precision truncation or an object-shape mangle fails.
  it('round-trips jsonb objects + real precision for the slow-warming FK_ORDER tables', async () => {
    const db = testDb();
    const now = new Date('2024-02-02T00:00:00Z');

    // ── Seed one row per newly-backed-up table with populated jsonb + real cols ──

    // mastery_state: 4 real cols + 1 jsonb (theta_grid_json). float4-sensitive values.
    await db.insert(mastery_state).values({
      id: 'ms1',
      subject_kind: 'knowledge',
      subject_id: 'k-ms',
      theta_hat: 0.1, // classic float4 round-trip trap
      evidence_count: 7,
      success_count: 5,
      fail_count: 2,
      last_outcome_at: now,
      theta_precision: 3.140625, // exactly representable in float4
      last_theta_delta: -0.0625, // negative, exactly representable
      theta_grid_json: {
        probs: [0.1, 0.2, 0.30000001192092896, 0.4],
        evidence: 12,
      },
      calibration_residual: 0.123456,
      fluency_illusion_flag: true,
      updated_at: now,
    });

    // item_calibration: 7 real cols + 2 jsonb (cdm_json, kt_json).
    await db.insert(item_calibration).values({
      id: 'ic1',
      question_id: 'q-ic',
      b: -1.5,
      confidence: 0.75,
      track: 'soft',
      source: 'llm_prior',
      b_anchor: -1.25,
      b_calib: -1.375,
      calibration_n: 3,
      calibration_weight: 0.5,
      last_calibrated_at: now,
      irt_a: 1.25,
      irt_c: 0.2,
      cdm_json: { slip: 0.1, guess: 0.2, profile: { nested: ['深', '层'], n: 3 } },
      kt_json: { pInit: 0.3, pTransit: 0.1, params: [1, 2, 3], note: null },
      created_at: now,
      updated_at: now,
    });

    // item_family_calibration: 2 real cols, no jsonb.
    await db.insert(item_family_calibration).values({
      id: 'ifc1',
      family_key: 'wenyan:k-ms:objective:llm_prior',
      b_delta: -0.0625,
      evidence_count: 25,
      calibrated_n: 21,
      confidence: 0.875,
      updated_at: now,
    });

    // difficulty_calibration_label: 3 real cols, no jsonb.
    await db.insert(difficulty_calibration_label).values({
      id: 'dcl1',
      question_id: 'q-ic',
      attempt_event_id: 'evt-dcl',
      theta_snapshot: 0.5,
      outcome: 1,
      b_label: -0.875,
      inclusion_probability: 0.0625, // ∈ (0,1], precision-sensitive
      created_at: now,
    });

    // selection_observation: 1 real col + 1 NOT NULL jsonb (signals).
    await db.insert(selection_observation).values({
      id: 'so1',
      date: '2024-02-02',
      stream_item_id: 'psi-1',
      ref_kind: 'question',
      ref_id: 'q-ic',
      policy: 'mfi_softmax',
      selected: true,
      inclusion_probability: 0.333333, // float4 round-trip
      signals: {
        mfi: 0.42,
        recency: [1, 2, 3],
        meta: { reason: '随机抽样', tags: ['锚', 'π_i'], empty: {} },
      },
      created_at: now,
    });

    // edge_reconciliation_log: 1 real col + 1 jsonb (llm_raw). KEEP_BOTH so the DB
    // CHECK (action ↔ superseded_edge_id) is satisfied with a null superseded id.
    await db.insert(edge_reconciliation_log).values({
      id: 'erl1',
      candidate_from_knowledge_id: 'k-from',
      candidate_to_knowledge_id: 'k-to',
      candidate_relation_type: 'related_to',
      action: 'KEEP_BOTH',
      superseded_edge_id: null,
      confidence: 0.65,
      reason: 'low-confidence keep both',
      llm_raw: { decision: 'KEEP_BOTH', scores: [0.6, 0.65], rationale: { lang: '中文' } },
      planned_at: now,
      applied_at: now,
    });

    // ── Snapshot DB state BEFORE export (already float4-rounded by Postgres) ──
    const before = {
      mastery_state: await db.select().from(mastery_state),
      item_calibration: await db.select().from(item_calibration),
      item_family_calibration: await db.select().from(item_family_calibration),
      difficulty_calibration_label: await db.select().from(difficulty_calibration_label),
      selection_observation: await db.select().from(selection_observation),
      edge_reconciliation_log: await db.select().from(edge_reconciliation_log),
    };

    // ── Export ──
    const exportRes = await GET(new Request('http://localhost/api/_/export'));
    expect(exportRes.status).toBe(200);
    const ab = await exportRes.arrayBuffer();
    const entries = unzipSync(new Uint8Array(ab));
    const data = JSON.parse(new TextDecoder().decode(entries['data.json'])) as Record<
      string,
      unknown[]
    >;
    // Each target table must be present in the dump with exactly its seeded row.
    for (const t of Object.keys(before)) {
      expect(data[t], `data.json missing table ${t}`).toHaveLength(1);
    }
    // jsonb must survive serialisation as a STRUCTURED object in data.json, not a
    // string — proves the dump kept the object shape (the failure mode this guards).
    const dumpedMs = (data.mastery_state as Array<{ theta_grid_json: unknown }>)[0];
    expect(dumpedMs.theta_grid_json).toEqual({
      probs: [0.1, 0.2, 0.30000001192092896, 0.4],
      evidence: 12,
    });
    const dumpedSo = (data.selection_observation as Array<{ signals: unknown }>)[0];
    expect((dumpedSo.signals as { meta: { reason: string } }).meta.reason).toBe('随机抽样');

    // ── Wipe ──
    await resetDb();
    expect(await db.select().from(mastery_state)).toHaveLength(0);
    expect(await db.select().from(item_calibration)).toHaveLength(0);

    // ── Import ──
    const importRes = await POST(
      new Request('http://localhost/api/_/import?confirm=wipe-and-reload', {
        method: 'POST',
        body: new Uint8Array(ab),
        headers: { 'content-type': 'application/zip' },
      }),
    );
    if (importRes.status !== 200) {
      console.error('Import failed:', JSON.stringify(await importRes.clone().json(), null, 2));
    }
    expect(importRes.status).toBe(200);
    const body = (await importRes.json()) as {
      ok: boolean;
      stats: Record<string, { inserted: number }>;
    };
    expect(body.ok).toBe(true);
    for (const t of Object.keys(before)) {
      expect(body.stats[t]?.inserted, `stats.${t}.inserted`).toBe(1);
    }

    // ── Assert byte-equal round-trip vs the pre-export DB read ──
    // Deep-equality covers BOTH failure modes at once: a float4 precision drift would
    // make a `real` column differ, and a jsonb object-shape mangle (string instead of
    // object, reordered/lost keys, unicode corruption) would make the jsonb column
    // differ. Equality against the float4-rounded pre-export read is the strict
    // "restore reproduces the source row exactly" contract.
    const after = {
      mastery_state: await db.select().from(mastery_state),
      item_calibration: await db.select().from(item_calibration),
      item_family_calibration: await db.select().from(item_family_calibration),
      difficulty_calibration_label: await db.select().from(difficulty_calibration_label),
      selection_observation: await db.select().from(selection_observation),
      edge_reconciliation_log: await db.select().from(edge_reconciliation_log),
    };
    for (const t of Object.keys(before) as Array<keyof typeof before>) {
      expect(after[t], `${t} restored row count`).toHaveLength(1);
      expect(after[t][0], `${t} byte-equal round-trip`).toEqual(before[t][0]);
    }

    // Spot-check the precision-sensitive reals explicitly so a failure names the value.
    expect(after.mastery_state[0].theta_hat).toBe(before.mastery_state[0].theta_hat);
    expect(after.difficulty_calibration_label[0].inclusion_probability).toBe(
      before.difficulty_calibration_label[0].inclusion_probability,
    );
    // Spot-check a deeply-nested jsonb leaf survived (object shape + unicode).
    expect(
      (after.item_calibration[0].cdm_json as { profile: { nested: string[] } }).profile.nested,
    ).toEqual(['深', '层']);
  });
});
