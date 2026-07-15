import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/client', () => ({ db: {} }));

const computeReplay = vi.fn();
vi.mock('@/server/events/sse_replay', () => ({
  computeReplay: (...args: unknown[]) => computeReplay(...args),
}));

const unsubscribe = vi.fn();
vi.mock('@/server/events/sse_router', () => ({
  subscribe: vi.fn(() => unsubscribe),
}));

import { IngestionEventStreamResponseSchema } from './contracts';
import { GET } from './events';

describe('GET /api/ingestion/[id]/events contract', () => {
  beforeEach(() => {
    computeReplay.mockReset();
    unsubscribe.mockReset();
  });

  it('returns an SSE response and emits replay frames using the declared representation', async () => {
    computeReplay.mockResolvedValue([
      {
        id: 7,
        event_type: 'ingestion.extraction_completed',
        payload: { status: 'extracted' },
      },
    ]);
    const controller = new AbortController();
    const request = new Request('http://localhost/api/ingestion/session_1/events', {
      headers: { 'Last-Event-ID': '6' },
      signal: controller.signal,
    });

    const response = await GET(request, { id: 'session_1' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    const frame = new TextDecoder().decode(first?.value);
    expect(() => IngestionEventStreamResponseSchema.parse(frame)).not.toThrow();
    expect(frame).toContain('id: 7');
    expect(frame).toContain('ingestion.extraction_completed');
    expect(computeReplay).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ businessId: 'session_1', lastEventId: 6 }),
    );

    controller.abort();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
