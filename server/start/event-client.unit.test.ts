// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiAuthError, ApiError, TOKEN_STORAGE_KEY, subscribeAuthInvalidation } from '@/ui/lib/api';
import { startEventDetailClient } from './event-client';
import { eventCorrectionInput, eventDetail } from './event-test-fixtures';

const rpc = vi.hoisted(() => ({ getStartEventDetail: vi.fn(), postStartEventCorrection: vi.fn() }));
vi.mock('./event-function', () => rpc);
beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'event-token');
  vi.stubGlobal('fetch', vi.fn());
  for (const [name, call] of Object.entries(rpc))
    call.mockImplementation(async (options) => {
      const response = await options.fetch(`/_serverFn/${name}`, {
        method: name === 'getStartEventDetail' ? 'GET' : 'POST',
        headers: { 'x-tsr-serverFn': 'true' },
        ...(name === 'postStartEventCorrection' ? { body: JSON.stringify(options.data) } : {}),
      });
      return response.json();
    });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
});
describe('event client uses the authenticated browser transport', () => {
  it('preserves the complete JSON/ISO detail including own prototype keys and the created resource receipt', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json(JSON.stringify(eventDetail)))
      .mockResolvedValueOnce(
        Response.json({
          correction_event_id: 'created / 纠正',
          status: 201,
          canonicalLocation: '/api/events/created%20%2F%20%E7%BA%A0%E6%AD%A3',
        }),
      );
    const dto = await startEventDetailClient.getEventDetail(eventDetail.event.id);
    expect(dto).toEqual(eventDetail);
    expect(JSON.stringify(dto)).toBe(JSON.stringify(eventDetail));
    expect(Object.hasOwn(Object(dto.event.payload), '__proto__')).toBe(true);
    expect(Object.hasOwn({}, 'must_be_own')).toBe(false);
    const receipt = await startEventDetailClient.createEventCorrection(
      dto.event.id,
      eventCorrectionInput,
    );
    expect(receipt.status).toBe(201);
    expect(receipt.canonicalLocation).toBe(
      `/api/events/${encodeURIComponent(receipt.correction_event_id)}`,
    );
    expect(rpc.getStartEventDetail.mock.calls[0][0].data).toEqual({ id: dto.event.id });
    expect(rpc.postStartEventCorrection.mock.calls[0][0].data).toEqual({
      id: dto.event.id,
      input: eventCorrectionInput,
    });
    expect(vi.mocked(fetch).mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST']);
    for (const [, init] of vi.mocked(fetch).mock.calls) {
      expect(new Headers(init?.headers).get('x-internal-token')).toBe('event-token');
      expect(new Headers(init?.headers).get('x-tsr-serverFn')).toBe('true');
    }
  });
  it('makes no request with no token', async () => {
    window.localStorage.clear();
    await expect(startEventDetailClient.getEventDetail('focus')).rejects.toBeInstanceOf(
      ApiAuthError,
    );
    await expect(
      startEventDetailClient.createEventCorrection('focus', eventCorrectionInput),
    ).rejects.toBeInstanceOf(ApiAuthError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('re-gates a401 from either operation', async () => {
    const invalidated = vi.fn();
    const unsubscribe = subscribeAuthInvalidation(invalidated);
    try {
      for (const operation of [
        () => startEventDetailClient.getEventDetail('focus'),
        () => startEventDetailClient.createEventCorrection('focus', eventCorrectionInput),
      ]) {
        window.localStorage.setItem(TOKEN_STORAGE_KEY, 'event-token');
        vi.mocked(fetch).mockResolvedValueOnce(
          Response.json({ error: 'unauthorized' }, { status: 401 }),
        );
        await expect(operation()).rejects.toBeInstanceOf(ApiAuthError);
        expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
      }
      expect(invalidated).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });
  it.each([400, 404, 500, 503])(
    'preserves ApiError/status/details %s without retries or token loss',
    async (status) => {
      for (const operation of [
        () => startEventDetailClient.getEventDetail('focus'),
        () => startEventDetailClient.createEventCorrection('focus', eventCorrectionInput),
      ]) {
        vi.mocked(fetch).mockResolvedValueOnce(
          Response.json(
            {
              error: 'fixture_code',
              message: 'visible failure',
              reason: 'ready',
              original: { nested: [null, false] },
            },
            { status },
          ),
        );
        const error: unknown = await operation().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ApiError);
        expect(error).toMatchObject({
          status,
          code: 'fixture_code',
          message: 'visible failure',
          details: { reason: 'ready', original: { nested: [null, false] } },
        });
      }
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('event-token');
    },
  );
  it('propagates an unknown write outcome once without replay', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('network lost after commit'));
    await expect(
      startEventDetailClient.createEventCorrection('focus', eventCorrectionInput),
    ).rejects.toThrow('network lost after commit');
    expect(fetch).toHaveBeenCalledOnce();
    expect(rpc.postStartEventCorrection).toHaveBeenCalledOnce();
  });
});
