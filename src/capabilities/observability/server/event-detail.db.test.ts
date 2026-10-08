import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EventCorrectionBodySchema,
  type EventCorrectionInput,
  EventCorrectionResponseSchema,
  EventDetailResponseSchema,
  createEventCorrection,
  readEventDetail,
} from '@/capabilities/observability/public';
import * as ids from '@/core/ids';
import { type Db, type Tx, db as singletonDb } from '@/db/client';
import { event } from '@/db/schema';
import { getEventById, getEventChain, writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST, createCorrectionResource } from '../api/event-correct';
import { GET } from '../api/event-detail';

const now = new Date('2026-10-08T09:10:11.123Z');
const body: EventCorrectionInput = {
  correction_kind: 'retract',
  reason_md: '保留原件，记录歧义与更正依据。\n'.repeat(80).trim(),
  affected_refs: [
    { kind: 'question', id: 'q1' },
    { kind: 'question_part', id: 'q1_part2' },
  ],
};

async function attempt(db: Db | Tx, id: string, parent?: string): Promise<void> {
  await writeEvent(db, {
    id,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q1',
    outcome: 'failure',
    payload: {
      answer_md: '设条件一成立，但第二个分支的边界仍不明确。\n'.repeat(200),
      answer_image_refs: ['asset_answer_1', 'asset_answer_2'],
      referenced_knowledge_ids: ['k1', 'k2'],
    },
    caused_by_event_id: parent,
    task_run_id: `run_${id}`,
    cost_micro_usd: 0,
    created_at: now,
  });
}

function request(input: unknown = body): Request {
  return new Request('http://localhost/api/events/target/corrections', {
    method: 'POST',
    body: JSON.stringify(input),
    headers: { 'content-type': 'application/json' },
  });
}

async function rows(db: Db | Tx = testDb()) {
  return db.select().from(event).orderBy(event.dispatch_seq);
}

describe('event domain real database fixtures', () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it('reads nonzero uncommitted causal and correction evidence only through the injected Tx, then rolls it back', async () => {
    const rollback = new Error('intentional fixture rollback');
    let correctionId = '';
    await expect(
      testDb().transaction(async (tx) => {
        await attempt(tx, 'parent');
        await attempt(tx, 'target', 'parent');
        await attempt(tx, 'child', 'target');
        correctionId = (await createEventCorrection(tx, 'target', body, now)).correction_event_id;
        const result = await readEventDetail(tx, ' target ');
        expect(result.event).toMatchObject({
          id: 'target',
          created_at: now.toISOString(),
          task_run_id: 'run_target',
          cost_micro_usd: 0,
        });
        expect(result.event.dispatch_seq).toBeGreaterThan(0);
        expect(result.chain.caused_by?.id).toBe('parent');
        expect(result.chain.caused_events.map((e) => e.id)).toEqual(['child']);
        expect(result.chain.corrections.map((e) => e.id)).toEqual([correctionId]);
        expect(result.correction_status).toEqual({
          state: 'retracted',
          correction_event_id: correctionId,
          replacement_event_id: null,
        });
        expect(await rows(tx)).toHaveLength(4);
        expect(await getEventById(singletonDb, 'target')).toBeNull();
        expect(await rows(singletonDb)).toHaveLength(0);
        await expect(readEventDetail(singletonDb, 'target')).rejects.toMatchObject({
          code: 'not_found',
          status: 404,
        });
        expect((await GET(new Request('http://localhost'), { id: 'target' })).status).toBe(404);
        expect(
          (await tx.select().from(event).where(eq(event.id, correctionId)))[0]?.ingest_at,
        ).toBeNull();
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await rows()).toEqual([]);
    expect(await getEventById(singletonDb, correctionId)).toBeNull();
  });

  it('folds sequential retract/mark_wrong/restore/supersede by dispatch_seq at tied timestamps without changing original rows', async () => {
    // Deliberately reverse lexical ID order to prove insertion chronology wins.
    vi.spyOn(ids, 'newId')
      .mockReturnValueOnce('z_retract')
      .mockReturnValueOnce('y_mark_wrong')
      .mockReturnValueOnce('x_restore')
      .mockReturnValueOnce('a_supersede');
    await testDb().transaction(async (tx) => {
      await attempt(tx, 'target');
      await attempt(tx, 'replacement');
      const originals = await rows(tx);
      const ids: string[] = [];
      for (const kind of ['retract', 'mark_wrong', 'restore', 'supersede'] as const) {
        const input = {
          ...body,
          correction_kind: kind,
          ...(kind === 'supersede' ? { replacement_event_id: 'replacement' } : {}),
        };
        const { correction_event_id: id } = await createEventCorrection(tx, 'target', input, now);
        ids.push(id);
        const detail = await readEventDetail(tx, 'target');
        expect(detail.correction_status).toEqual(
          kind === 'restore'
            ? { state: 'active', correction_event_id: null, replacement_event_id: null }
            : {
                state:
                  kind === 'retract'
                    ? 'retracted'
                    : kind === 'mark_wrong'
                      ? 'marked_wrong'
                      : 'superseded',
                correction_event_id: id,
                replacement_event_id: kind === 'supersede' ? 'replacement' : null,
              },
        );
        expect(detail.chain.corrections.map((e) => e.id)).toEqual([...ids].reverse());
        const dispatch = detail.chain.corrections.map((e) => e.dispatch_seq);
        expect(dispatch).toEqual([...dispatch].sort((a, b) => Number(b) - Number(a)));
        expect(detail.chain.corrections.every((e) => e.created_at === now.toISOString())).toBe(
          true,
        );
        expect(detail.chain.caused_events).toEqual([]);
        const persisted = (await tx.select().from(event).where(eq(event.id, id)))[0];
        expect(persisted).toMatchObject({
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'correct',
          subject_kind: 'event',
          subject_id: 'target',
          outcome: 'success',
          caused_by_event_id: 'target',
          payload: EventCorrectionBodySchema.parse(input),
          created_at: now,
          ingest_at: null,
        });
        expect(persisted?.affected_scopes).toContain('global');
        expect((await rows(tx)).filter((e) => e.action === 'attempt')).toEqual(originals);
      }
      expect(new Set(ids).size).toBe(4);
      expect(ids).toEqual(['z_retract', 'y_mark_wrong', 'x_restore', 'a_supersede']);
    });
  });

  it('matches the established kernel-to-HTTP wire DTO for focal, parent, child and correction envelopes', async () => {
    await attempt(testDb(), 'parent');
    await attempt(testDb(), 'target', 'parent');
    await attempt(testDb(), 'child', 'target');
    await createEventCorrection(testDb(), 'target', body, now);
    const focal = await getEventById(testDb(), 'target');
    const chain = await getEventChain(testDb(), 'target');
    // Serialization here is the old HTTP contract oracle, not the domain implementation.
    const previousHttp = await Response.json({
      event: focal,
      correction_status: focal?.correction_status,
      chain,
    }).json();
    const detail = await readEventDetail(testDb(), 'target');
    expect(detail).toEqual(previousHttp);
    expect(EventDetailResponseSchema.parse(detail)).toEqual(detail);
    const http = await GET(new Request('http://localhost/api/events/target'), { id: ' target ' });
    expect(http.status).toBe(200);
    expect(await http.json()).toEqual(detail);
    expect(detail.chain.caused_by).not.toHaveProperty('caused_by_event_id');
    for (const row of [
      detail.event,
      detail.chain.caused_by,
      ...detail.chain.caused_events,
      ...detail.chain.corrections,
    ]) {
      expect(row?.created_at).toBe(now.toISOString());
      expect(row?.dispatch_seq).toBeGreaterThan(0);
    }
  });

  it.each([
    { ...body, reason_md: '  ' },
    { ...body, reason_md: 'x'.repeat(2001) },
    { ...body, affected_refs: [] },
    { ...body, correction_kind: 'supersede' },
    { ...body, correction_kind: 'restore', replacement_event_id: 'replacement' },
  ])('rejects invalid input and appends no rows', async (input) => {
    await attempt(testDb(), 'target');
    const before = await rows();
    await expect(createEventCorrection(testDb(), 'target', input, now)).rejects.toMatchObject({
      code: 'validation_error',
      status: 400,
    });
    expect(await rows()).toEqual(before);
    const http = await createCorrectionResource(request(input), { id: 'target' });
    expect(http.status).toBe(400);
    expect(http.headers.get('location')).toBeNull();
    expect(await rows()).toEqual(before);
  });

  it('distinguishes missing and corrupted stored focal payloads without appending', async () => {
    await expect(readEventDetail(testDb(), 'missing')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
    await expect(createEventCorrection(testDb(), 'missing', body, now)).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
    await expect(createEventCorrection(testDb(), '  ', body, now)).rejects.toMatchObject({
      code: 'validation_error',
      status: 400,
    });
    expect(await rows()).toEqual([]);
    // Deliberately bypass the validated writer to model existing stored corruption.
    await testDb()
      .insert(event)
      .values({
        id: 'corrupt',
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q1',
        outcome: 'failure',
        payload: { answer_md: 42 },
        created_at: now,
      });
    const before = await rows();
    await expect(readEventDetail(testDb(), 'corrupt')).rejects.toThrow();
    await expect(createEventCorrection(testDb(), 'corrupt', body, now)).rejects.toThrow();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const response of [
        await GET(new Request('http://localhost'), { id: 'corrupt' }),
        await createCorrectionResource(request(), { id: 'corrupt' }),
      ]) {
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          error: 'internal_error',
          message: 'Internal Server Error',
        });
      }
    } finally {
      log.mockRestore();
    }
    expect(await rows()).toEqual(before);
  });

  it('preserves a malformed correction skipped by the status fold but rejected by chain parsing', async () => {
    await attempt(testDb(), 'target');
    await testDb()
      .insert(event)
      .values({
        id: 'bad_correction',
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'correct',
        subject_kind: 'event',
        subject_id: 'target',
        outcome: 'success',
        caused_by_event_id: 'target',
        payload: { correction_kind: 'retract', reason_md: '', affected_refs: [] },
        created_at: now,
      });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await getEventById(testDb(), 'target'))?.correction_status).toEqual({
        state: 'active',
        correction_event_id: null,
        replacement_event_id: null,
      });
      await expect(readEventDetail(testDb(), 'target')).rejects.toThrow();
      const response = await GET(new Request('http://localhost'), { id: 'target' });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: 'internal_error',
        message: 'Internal Server Error',
      });
    } finally {
      warning.mockRestore();
      log.mockRestore();
    }
  });

  it('retains canonical/legacy response contracts and fresh correction IDs for identical HTTP requests', async () => {
    await attempt(testDb(), 'target');
    const original = (await rows())[0];
    const canonical = await createCorrectionResource(request(), { id: 'target' });
    const first = EventCorrectionResponseSchema.parse(await canonical.json());
    expect(canonical.status).toBe(201);
    expect(canonical.headers.get('location')).toBe(`/api/events/${first.correction_event_id}`);
    expect(canonical.headers.get('deprecation')).toBeNull();
    const legacy = await POST(request(), { id: 'target' });
    const second = EventCorrectionResponseSchema.parse(await legacy.json());
    expect(legacy.status).toBe(200);
    expect(legacy.headers.get('location')).toBeNull();
    expect(legacy.headers.get('deprecation')).toBe('@1783987200');
    expect(legacy.headers.get('link')).toBe(
      '</api/events/target/corrections>; rel="successor-version"',
    );
    expect(second.correction_event_id).not.toBe(first.correction_event_id);
    const all = await rows();
    expect(all).toHaveLength(3);
    expect(all[0]).toEqual(original);
    expect(
      all.slice(1).every((e) => e.ingest_at === null && e.caused_by_event_id === 'target'),
    ).toBe(true);
    const malformed = await createCorrectionResource(
      new Request('http://localhost', { method: 'POST', body: '{' }),
      { id: 'target' },
    );
    expect(malformed.status).toBe(400);
    expect(await rows()).toEqual(all);
  });
});
