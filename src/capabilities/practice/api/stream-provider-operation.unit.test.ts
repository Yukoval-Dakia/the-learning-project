import { beforeEach, describe, expect, it, vi } from 'vitest';

type ComposeOptions = {
  composeDeps?: {
    providerInvocation?: {
      caller: 'api' | 'worker';
      deadlineAt: Date;
      operationAnchor: string;
    };
  };
};

const mocks = vi.hoisted(() => ({
  composeNightly: vi.fn(async (_db: unknown, _date: string, _opts: ComposeOptions) => 2),
  getStream: vi.fn(async (_db: unknown, _date: string, _opts: ComposeOptions) => ({
    items: [],
    progress: { total: 0, done: 0 },
  })),
  recomposeStream: vi.fn(async (_db: unknown, _date: string, _opts: ComposeOptions) => 1),
}));

vi.mock('@/db/client', () => ({ db: { testDb: true } }));
vi.mock('@/server/http/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('../server/selection-seed', () => ({ buildSeededSelectionRng: () => () => 0.5 }));
vi.mock('../server/stream-store', () => ({
  advanceStreamItem: vi.fn(),
  composeNightly: mocks.composeNightly,
  getStream: mocks.getStream,
  getStreamViewItem: vi.fn(),
  recomposeStream: mocks.recomposeStream,
  streamLocalDate: () => '2026-08-09',
}));

import { runStreamComposeNightly } from '../jobs/practice_stream_compose_nightly';
import { GET, POST } from './stream';

beforeEach(() => vi.clearAllMocks());

describe('Practice L2 Mem0 provider operation contexts', () => {
  it('threads fresh API invocation identities through lazy compose and recompose', async () => {
    // Given two separate API product invocations on the same date.
    await GET(new Request('http://test/api/practice/stream?date=today'));
    await POST(
      new Request('http://test/api/practice/stream/recompose', {
        method: 'POST',
        body: JSON.stringify({ date: '2026-08-09' }),
      }),
    );

    // When each route hands its L2 composition dependencies to the shared store.
    const lazyContext = mocks.getStream.mock.calls[0]?.[2]?.composeDeps?.providerInvocation;
    const recomposeContext =
      mocks.recomposeStream.mock.calls[0]?.[2]?.composeDeps?.providerInvocation;

    // Then both carry the actual API caller while separate clicks stay separate operations.
    expect(lazyContext).toMatchObject({ caller: 'api' });
    expect(recomposeContext).toMatchObject({ caller: 'api' });
    expect(lazyContext?.operationAnchor).not.toBe(recomposeContext?.operationAnchor);
    expect(lazyContext?.deadlineAt).toBeInstanceOf(Date);
    expect(recomposeContext?.deadlineAt).toBeInstanceOf(Date);
  });

  it('threads the pg-boss invocation anchor into nightly L2 composition', async () => {
    // Given one concrete nightly job invocation anchor.
    await runStreamComposeNightly({ testDb: true } as never, 'nightly-job-852');

    // When nightly composition receives its dependencies.
    const context = mocks.composeNightly.mock.calls[0]?.[2]?.composeDeps?.providerInvocation;

    // Then the context is worker-owned and stable for the invocation.
    expect(context).toMatchObject({ caller: 'worker' });
    expect(context?.operationAnchor).toBe('nightly-job-852');
    expect(context?.deadlineAt).toBeInstanceOf(Date);
  });
});
