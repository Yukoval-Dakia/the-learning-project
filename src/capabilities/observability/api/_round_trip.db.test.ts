/**
 * Round-trip test: GET /api/_/export → POST /api/_/import
 * Uses real test DB (postgres-js) + in-memory R2.
 * Verifies that data exported from a seeded DB is fully restored after a wipe.
 */

import { eq, sql } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordJudgeOperationalReceipt } from '@/capabilities/practice/public';
import { hydrateConfigFromDb } from '@/core/config/server/hydrate';
import type { JudgeOperationalEventT } from '@/core/schema/event/judge-operational-events';
import {
  difficulty_calibration_label,
  event,
  item_calibration,
  item_family_calibration,
  knowledge,
  mastery_state,
  selection_observation,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memR2 } from '../../../../tests/helpers/r2';
import { setBackupConfigHydrator } from '../server/backup/config-hydrator';
import { GET } from './backup-export';
import { POST } from './backup-import';

// Production injects this in server/index.ts; the restore route fails closed without it.
setBackupConfigHydrator(hydrateConfigFromDb);

const r2 = memR2();
vi.mock('@/kernel/object-storage', () => ({
  getR2: () => r2,
  createR2Client: () => r2,
}));

describe('round-trip: export → import → DB state mirrored', () => {
  beforeEach(async () => {
    r2._store.clear();
    await resetDb();
  });

  // @invariant data: a whole-database export → restore keeps knowledge rows and each event's memory-ingest state, so restored rows are not re-sent to paid memory extraction
  // @fails-if let restore drop knowledge rows or clear/alter event.ingest_at; the knowledge row equality and restored ingest_at === backed-up value assertions fail
  it('preserves knowledge rows and each event ingest state end-to-end', async () => {
    const db = testDb();

    // 1. Seed DB with fixtures
    const now = new Date('2024-01-01T00:00:00Z');
    await db.insert(knowledge).values({
      id: 'k1',
      name: '虚词',
      domain: 'yuwen',
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
    expect(eventsAfterImport[0].ingest_at?.toISOString()).toBe(now.toISOString());
  });

  // YUK-356: the round-trip above only proves the knowledge single-table path. The
  // newly-backed-up slow-warming calibration / telemetry / reconciliation tables
  // added to FK_ORDER (mastery_state, item_calibration, item_family_calibration,
  // difficulty_calibration_label, selection_observation)
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
  // @invariant data: slow-warming FK_ORDER rows survive export → wipe → import byte-equal, including float4 precision and nested jsonb shape
  // @fails-if a real column loses float4 precision or a jsonb column serialises to a string / reorders or drops keys through dump → restore; the byte-equal deep-equality assertions then fail
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
      family_key: 'yuwen:k-ms:objective:llm_prior',
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

    // ── Snapshot DB state BEFORE export (already float4-rounded by Postgres) ──
    const before = {
      mastery_state: await db.select().from(mastery_state),
      item_calibration: await db.select().from(item_calibration),
      item_family_calibration: await db.select().from(item_family_calibration),
      difficulty_calibration_label: await db.select().from(difficulty_calibration_label),
      selection_observation: await db.select().from(selection_observation),
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

  // Judge operational receipts are immutable to ordinary writers but live on the
  // `event` table inside the restore wipe scope — an archive carrying them used to
  // die on the first `delete from "event"`. The seed writes one receipt per
  // trigger-guarded action through the production writer (zod-validated), the same
  // rows a real judge run leaves; the wipe-then-reinsert may only pass inside the
  // restore transaction's narrow channel, which ends with that transaction.
  // @invariant data: wipe-and-reload restores every guarded receipt row byte-equal
  // @invariant security: after restore, ordinary UPDATE/DELETE on any guarded
  //   receipt action is still rejected — the channel does not leak
  // @fails-if drop the channel check or weaken the guard: import returns 500
  //   'judge operational receipts are immutable', or a post-restore ordinary
  //   update/delete no longer rejects
  it('restores immutable judge operational receipts and keeps them fenced afterwards', async () => {
    const db = testDb();
    const now = new Date('2024-03-03T00:00:00Z');
    const at = now.toISOString();
    const digest = '0'.repeat(64);
    const pendingId = 'jrt_pending';
    const owner = {
      incarnation: '11111111-2222-4333-8444-555555555555',
      epoch: 0,
      backend: 'pg-boss' as const,
    };
    const runEnvelope = {
      actor_kind: 'system' as const,
      actor_ref: 'judge:operational' as const,
      subject_kind: 'event' as const,
      subject_id: pendingId,
      caused_by_event_id: pendingId,
      outcome: null,
      task_run_id: null,
      cost_micro_usd: null,
    };
    const familyEnvelope = {
      ...runEnvelope,
      subject_kind: 'durable_family' as const,
      subject_id: 'judge_run' as const,
      caused_by_event_id: null,
    };
    const coordinate = {
      coordinate: 'native' as const,
      run_id: 'jrt_run',
      pending_id: pendingId,
      pending_digest: digest,
    };
    const receipts: JudgeOperationalEventT[] = [
      {
        ...runEnvelope,
        action: 'experimental:judge_execution_binding',
        payload: {
          ...coordinate,
          version: 1,
          evaluation_group_id: 'jrt_group',
          submission_id: 'jrt_submission',
          execution_key: 'jrt_execution',
          member_submission_ids: ['jrt_submission'],
          input_digest: digest,
          intent_digest: 'jrt_intent',
          attempt: 1,
          admission_snapshot: null,
          execution_policy: { version: 1, paid_retry: 'none', evaluation: {} },
        },
      },
      {
        ...runEnvelope,
        action: 'experimental:judge_ownership',
        payload: {
          ...coordinate,
          version: 1,
          from: null,
          to: owner,
          submitted_at: at,
          source_digest: digest,
          mapped_deliveries: [],
          recovery_history: { kind: 'known', accepted_recovery_ids: [] },
          evidence_refs: [pendingId],
        },
      },
      {
        ...runEnvelope,
        action: 'experimental:judge_delivery_reserved',
        payload: {
          ...coordinate,
          version: 1,
          slot: 0,
          ownership: owner,
          delivery_id: 'jrt_delivery',
          reserved_at: at,
        },
      },
      {
        ...runEnvelope,
        action: 'experimental:judge_delivery_send',
        payload: {
          ...coordinate,
          version: 1,
          reservation_id: 'jrt_reservation',
          send_no: 1,
          ownership: owner,
          gate_checked_at: at,
          authorization_version: 1,
          authorization_digest: digest,
        },
      },
      {
        ...runEnvelope,
        action: 'experimental:judge_delivery_rejected',
        payload: {
          ...coordinate,
          version: 1,
          send_id: 'jrt_send_rejected',
          reason: 'producer_fenced',
          observed_at: at,
          evidence_digest: digest,
        },
      },
      {
        ...runEnvelope,
        action: 'experimental:judge_delivery_accepted',
        payload: {
          ...coordinate,
          version: 1,
          reservation_id: 'jrt_reservation',
          ownership: owner,
          delivery_id: 'jrt_delivery',
          accepted_send_id: 'jrt_send',
          evidence: 'enqueue_ack',
          observed_at: at,
        },
      },
      {
        ...runEnvelope,
        action: 'experimental:judge_delivery_started',
        payload: {
          ...coordinate,
          version: 1,
          reservation_id: 'jrt_reservation',
          ownership: owner,
          started_at: at,
        },
      },
      {
        ...runEnvelope,
        action: 'experimental:judge_disposition',
        payload: {
          ...coordinate,
          version: 1,
          kind: 'manual',
          reason: 'explicit_disposal',
          actor_ref: 'owner:test',
          decided_at: at,
          observed_ownership: owner,
          evidence_refs: [pendingId],
          evidence_digest: digest,
        },
      },
      {
        ...familyEnvelope,
        action: 'experimental:judge_family_transition',
        payload: {
          version: 1,
          incarnation: owner.incarnation,
          prior_phase: 'pg-boss',
          next_phase: 'draining-pg-boss',
          prior_epoch: 0,
          next_epoch: 1,
          actor_ref: 'owner:test',
          evidence_refs: [pendingId],
          evidence_digest: digest,
          recorded_at: at,
        },
      },
      {
        ...familyEnvelope,
        action: 'experimental:judge_reconcile_observation',
        payload: {
          version: 1,
          tick_id: 'jrt_tick',
          ownership: owner,
          sequence: 0,
          admission: 'admitted',
          pending_ids: [pendingId],
          cursor: null,
          recorded_at: at,
        },
      },
    ];
    await db.transaction(async (tx) => {
      for (const [index, receipt] of receipts.entries()) {
        await recordJudgeOperationalReceipt(tx, `jrt_receipt_${index}`, receipt, now);
      }
    });

    const before = await db.select().from(event).orderBy(event.id);
    expect(before).toHaveLength(receipts.length);

    const exportRes = await GET(new Request('http://localhost/api/_/export'));
    expect(exportRes.status).toBe(200);
    const ab = await exportRes.arrayBuffer();

    await resetDb();
    expect(await db.select().from(event)).toHaveLength(0);

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

    // Row count + ordered id/row identity: the restored receipts must be the
    // backed-up rows verbatim, not just the same actions.
    const after = await db.select().from(event).orderBy(event.id);
    expect(after).toEqual(before);

    // The restore channel ended with its transaction: ordinary writes on every
    // guarded action are still fenced.
    const immutableReceiptError = {
      cause: { code: 'P0001', message: 'judge operational receipts are immutable' },
    };
    for (const row of after) {
      await expect(
        db.execute(sql`update event set payload = payload || '{}'::jsonb where id = ${row.id}`),
      ).rejects.toMatchObject(immutableReceiptError);
      await expect(db.delete(event).where(eq(event.id, row.id))).rejects.toMatchObject(
        immutableReceiptError,
      );
    }
    expect(await db.select().from(event).orderBy(event.id)).toEqual(before);
  });

  async function exportZipBytes(): Promise<Uint8Array> {
    const res = await GET(new Request('http://localhost/api/_/export'));
    expect(res.status).toBe(200);
    return new Uint8Array(await res.arrayBuffer());
  }

  function importRequest(body: BodyInit, headers: Record<string, string> = {}): Request {
    return new Request('http://localhost/api/_/import?confirm=wipe-and-reload', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/zip', ...headers },
      ...(body instanceof ReadableStream ? { duplex: 'half' as const } : {}),
    });
  }

  async function seedKnowledgeRow(id = 'k1'): Promise<void> {
    const db = testDb();
    const now = new Date('2024-01-01T00:00:00Z');
    await db.insert(knowledge).values({
      id,
      name: '虚词',
      domain: 'yuwen',
      parent_id: null,
      merged_from: [],
      archived_at: null,
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }

  // @invariant data: a truncated or bit-corrupted archive is rejected before any wipe, so a damaged backup cannot leave the DB empty or half-restored
  // @fails-if the streaming unzipper skipped its own CRC/central-directory checks (fflate's streaming Unzip verifies neither): a flipped data byte or truncated tail would stage garbage rows or half a data.json and still reach the wipe — the surviving knowledge row and 400 assertions fail
  it.each(['truncated', 'bit-corrupted'])(
    'rejects a %s archive before wiping and leaves live rows intact',
    async (mode) => {
      const db = testDb();
      await seedKnowledgeRow();
      const zip = await exportZipBytes();

      const damaged: Uint8Array<ArrayBuffer> =
        mode === 'truncated'
          ? zip.slice(0, Math.floor(zip.length / 2))
          : Uint8Array.from(zip, (b, i) => (i === Math.floor(zip.length / 2) ? b ^ 0xff : b));

      const res = await POST(importRequest(damaged));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid_zip');
      expect(await db.select().from(knowledge)).toHaveLength(1);
    },
  );

  // @invariant data: a chunked request body restores the same rows as a buffered one, so proxies that stream the upload cannot corrupt the restore
  // @fails-if the incremental data.json parser dropped or spliced rows across chunk boundaries: the restored row count or a row field would diverge from the buffered-upload baseline
  it('restores an upload delivered as small stream chunks', async () => {
    const db = testDb();
    await seedKnowledgeRow();
    const zip = await exportZipBytes();

    await resetDb();
    expect(await db.select().from(knowledge)).toHaveLength(0);

    const chunkSize = 4096;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let off = 0; off < zip.length; off += chunkSize) {
          controller.enqueue(zip.subarray(off, off + chunkSize));
        }
        controller.close();
      },
    });
    const res = await POST(importRequest(stream));
    if (res.status !== 200) {
      console.error('Import failed:', JSON.stringify(await res.clone().json(), null, 2));
    }
    expect(res.status).toBe(200);

    const rows = await db.select().from(knowledge);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('k1');
    expect(rows[0].name).toBe('虚词');
  });
});
