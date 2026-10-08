import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import type { EnvelopedEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { POST, createCorrectionResource } from '../api/event-correct';
import { GET } from '../api/event-detail';
import {
  EventCorrectionBodySchema,
  type EventCorrectionInput,
  EventDetailResponseSchema,
  createEventCorrection,
  readEventDetail,
} from '../public';

const mocks = vi.hoisted(() => ({
  read: vi.fn<typeof import('@/kernel/events').getEventById>(),
  chain: vi.fn<typeof import('@/kernel/events').getEventChain>(),
  write: vi.fn<typeof import('@/kernel/events').writeEvent>(),
  id: vi.fn(),
}));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/kernel/events', () => ({
  getEventById: mocks.read,
  getEventChain: mocks.chain,
  writeEvent: mocks.write,
}));
vi.mock('@/core/ids', () => ({ newId: mocks.id }));
// The public port is real; unrelated exports do not initialize their DB readers.
vi.mock('./admin-config-facts', () => ({
  __resetAdminConfigRuntimeFactsForTests: vi.fn(),
  getAdminConfigRuntimeFacts: vi.fn(),
  setAdminConfigRuntimeFacts: vi.fn(),
}));
vi.mock('./admin-config-writer', () => ({ setAdminConfigWriter: vi.fn() }));
vi.mock('./config-effective-facts', () => ({ observabilityConfigEffectiveFacts: vi.fn() }));
vi.mock('./hub-sync', () => ({ readHubSyncHealth: vi.fn() }));
vi.mock('./provider-cost-projection', () => ({ readProviderCostWindow: vi.fn() }));
vi.mock('./today-cost', () => ({ loadTodayCost: vi.fn() }));

const now = new Date('2026-10-08T09:10:11.123Z');
const active = { state: 'active', correction_event_id: null, replacement_event_id: null } as const;
const input: EventCorrectionInput = {
  correction_kind: 'retract',
  reason_md: '  保留原始证据，撤回有歧义的判断。\n'.repeat(40).trim(),
  affected_refs: [
    { kind: 'question', id: 'q1' },
    { kind: 'question_part', id: 'q1_part2' },
  ],
};

function envelope(id: string): EnvelopedEvent {
  return {
    id,
    dispatch_seq: 81,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:yuk1380_fixture',
    subject_kind: 'question',
    subject_id: 'q1',
    outcome: null,
    payload: { text: '复杂原始记录。'.repeat(200), nested: { alternatives: [null, false, 7] } },
    caused_by_event_id: undefined,
    created_at: now,
    correction_status: active,
  };
}

function request(body: unknown = input): Request {
  return new Request('http://localhost/api/events/target/corrections', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.read.mockReset().mockResolvedValue(envelope('target'));
  mocks.chain
    .mockReset()
    .mockResolvedValue({ caused_by: null, caused_events: [], corrections: [] });
  mocks.write.mockReset().mockResolvedValue('fresh');
  mocks.id.mockReset().mockReturnValue('fresh');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('public event detail and correction operations', () => {
  it('projects every envelope to ISO, preserves extra fields and matches the HTTP DTO', async () => {
    const focal = {
      ...envelope('target'),
      extra_receipt: { revision: 3 },
      task_run_id: 'run1',
      cost_micro_usd: 0,
    };
    mocks.read.mockResolvedValue(focal);
    mocks.chain.mockResolvedValue({
      caused_by: envelope('parent'),
      caused_events: [envelope('child')],
      corrections: [envelope('correction')],
    });
    const injected = new Proxy(db, {});
    const detail = await readEventDetail(injected, ' target ');
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(injected, 'target');
    expect(mocks.chain).toHaveBeenCalledExactlyOnceWith(injected, 'target');
    expect(detail.event).toEqual({
      ...focal,
      created_at: now.toISOString(),
      caused_by_event_id: undefined,
    });
    expect(Object.hasOwn(detail.event, 'caused_by_event_id')).toBe(false);
    for (const row of [
      detail.event,
      detail.chain.caused_by,
      ...detail.chain.caused_events,
      ...detail.chain.corrections,
    ]) {
      expect(row?.created_at).toBe(now.toISOString());
      expect(row?.dispatch_seq).toBe(81);
    }
    expect(EventDetailResponseSchema.parse(detail)).toEqual(detail);
    const response = await GET(new Request('http://localhost/api/events/target'), {
      id: ' target ',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(detail);
    expect(focal.created_at).toBe(now);
  });

  it('uses the injected database, parsed payload and explicit clock for the sole writer', async () => {
    const injected = new Proxy(db, {});
    const result = await createEventCorrection(
      injected,
      ' target ',
      { ...input, reason_md: '  reason\n  ', extra: true },
      now,
    );
    expect(result).toEqual({ correction_event_id: 'fresh' });
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(injected, 'target');
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith(injected, {
      id: 'fresh',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'target',
      outcome: 'success',
      payload: { ...input, reason_md: 'reason' },
      caused_by_event_id: 'target',
      created_at: now,
    });
  });

  it('samples the default clock once before an asynchronous read crosses the time boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.read.mockImplementation(async () => {
      vi.setSystemTime(new Date(now.getTime() + 5000));
      return envelope('target');
    });
    await createEventCorrection(db, 'target', input);
    expect(mocks.write.mock.calls[0]?.[1].created_at).toEqual(now);
  });

  it.each(['retract', 'mark_wrong', 'restore', 'supersede'] as const)(
    'accepts %s with existing schema rules',
    async (kind) => {
      const body = {
        ...input,
        correction_kind: kind,
        ...(kind === 'supersede' ? { replacement_event_id: 'replacement' } : {}),
      };
      await createEventCorrection(db, 'target', body, now);
      expect(mocks.write.mock.calls[0]?.[1].payload).toEqual(EventCorrectionBodySchema.parse(body));
    },
  );

  it.each([
    null,
    { ...input, reason_md: '   ' },
    { ...input, reason_md: 'x'.repeat(2001) },
    { ...input, affected_refs: [] },
    { ...input, affected_refs: [{ kind: 'unknown', id: 'q1' }] },
    { ...input, correction_kind: 'supersede' },
    { ...input, correction_kind: 'restore', replacement_event_id: 'replacement' },
    { ...input, correction_kind: 'erase' },
  ])('rejects invalid payload without reading or writing (%j)', async (body) => {
    const parsed = EventCorrectionBodySchema.safeParse(body);
    if (parsed.success) throw new Error('fixture must be invalid');
    await expect(createEventCorrection(db, 'target', body, now)).rejects.toMatchObject({
      code: 'validation_error',
      status: 400,
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('accepts a reason of exactly 2000 characters after trimming', async () => {
    await createEventCorrection(
      db,
      'target',
      { ...input, reason_md: `  ${'x'.repeat(2000)}  ` },
      now,
    );
    expect(mocks.write).toHaveBeenCalledOnce();
  });

  it('validates the id before body parsing and performs no kernel calls', async () => {
    await expect(readEventDetail(db, '  ')).rejects.toMatchObject({
      status: 400,
      message: 'event id is required',
    });
    await expect(createEventCorrection(db, '', null, now)).rejects.toMatchObject({
      status: 400,
      message: 'event id is required',
    });
    const req = request();
    const json = vi.spyOn(req, 'json');
    const response = await createCorrectionResource(req, {});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'validation_error',
      message: 'event id is required',
    });
    expect(json).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.chain).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('distinguishes absence from corrupt focal or chain data', async () => {
    mocks.read.mockResolvedValue(null);
    await expect(readEventDetail(db, 'missing')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
      message: 'event missing not found',
    });
    await expect(createEventCorrection(db, 'missing', input, now)).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
    expect(mocks.chain).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    const corrupt = new Error('corrupt stored payload');
    mocks.read.mockRejectedValue(corrupt);
    await expect(readEventDetail(db, 'target')).rejects.toBe(corrupt);
    await expect(createEventCorrection(db, 'target', input, now)).rejects.toBe(corrupt);
    mocks.read.mockResolvedValue(envelope('target'));
    mocks.chain.mockRejectedValue(corrupt);
    await expect(readEventDetail(db, 'target')).rejects.toBe(corrupt);
  });

  it('keeps canonical 201 Location and legacy 200 headers, generating distinct IDs for repeated requests', async () => {
    mocks.id.mockReturnValueOnce('fresh/one').mockReturnValueOnce('fresh_two');
    const canonical = await createCorrectionResource(request(), { id: 'target' });
    expect(canonical.status).toBe(201);
    expect(canonical.headers.get('location')).toBe('/api/events/fresh%2Fone');
    expect(canonical.headers.get('deprecation')).toBeNull();
    expect(await canonical.json()).toEqual({ correction_event_id: 'fresh/one' });
    const legacy = await POST(request(), { id: 'target' });
    expect(legacy.status).toBe(200);
    expect(legacy.headers.get('location')).toBeNull();
    expect(legacy.headers.get('deprecation')).toBe('@1783987200');
    expect(legacy.headers.get('link')).toBe(
      '</api/events/target/corrections>; rel="successor-version"',
    );
    expect(await legacy.json()).toEqual({ correction_event_id: 'fresh_two' });
    expect(mocks.write.mock.calls.map(([, row]) => row.id)).toEqual(['fresh/one', 'fresh_two']);
  });

  it('preserves malformed JSON errors and errorResponse status/headers at both HTTP boundaries', async () => {
    const malformed = await createCorrectionResource(
      new Request('http://localhost', { method: 'POST', body: '{' }),
      { id: 'target' },
    );
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('location')).toBeNull();
    expect(await malformed.json()).toMatchObject({ error: 'validation_error' });
    const failure = new ApiError('temporarily_unavailable', 'wait', 503, { 'Retry-After': '7' });
    mocks.read.mockRejectedValue(failure);
    for (const response of [
      await GET(new Request('http://localhost'), { id: 'target' }),
      await createCorrectionResource(request(), { id: 'target' }),
    ]) {
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('7');
      expect(await response.json()).toEqual({ error: 'temporarily_unavailable', message: 'wait' });
    }
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.read.mockRejectedValue(new Error('private corrupt data'));
    for (const response of [
      await GET(new Request('http://localhost'), { id: 'target' }),
      await POST(request(), { id: 'target' }),
    ]) {
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: 'internal_error',
        message: 'Internal Server Error',
      });
    }
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
