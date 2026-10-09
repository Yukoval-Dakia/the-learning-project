import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODE_CONTRACT_EPOCH, gateContractEpoch } from '@/server/contract-epoch/rules';
import { buildHonoApp } from '../app';
import {
  runAuthenticatedStartEventCorrection,
  runAuthenticatedStartEventDetail,
} from './event-read';
import { eventCorrectionInput, eventDetail, eventNow } from './event-test-fixtures';

const seams = vi.hoisted(() => ({
  db: vi.fn(),
  domainImport: vi.fn(),
  parse: vi.fn(),
  read: vi.fn(),
  chain: vi.fn(),
  write: vi.fn(),
}));
vi.mock('@/db/client', () => ({
  get db() {
    seams.db();
    return {};
  },
}));
vi.mock('@/capabilities/observability/public', async () => {
  seams.domainImport();
  const contracts = await import('@/capabilities/observability/api/event-contracts');
  const operations = await import('@/capabilities/observability/server/event-detail');
  return {
    ...operations,
    EventParamsSchema: {
      safeParse: (input: unknown) => {
        seams.parse(input);
        return contracts.EventParamsSchema.safeParse(input);
      },
      extend: contracts.EventParamsSchema.extend.bind(contracts.EventParamsSchema),
    },
    EventCorrectionBodySchema: contracts.EventCorrectionBodySchema,
  };
});
vi.mock('@/kernel/events', () => ({
  getEventById: seams.read,
  getEventChain: seams.chain,
  writeEvent: seams.write,
}));
const request = (token?: string) =>
  new Request('http://isolated.test/_serverFn/event', {
    headers: token === undefined ? {} : { 'x-internal-token': token },
  });
const context = (reason?: 'preparing' | 'ready') => ({
  api: buildHonoApp([], {
    epochGate: async () => {
      const verdict = gateContractEpoch({ epoch: CODE_CONTRACT_EPOCH, state: reason ?? 'active' });
      return { ...verdict, state: verdict.marker.state, epoch: verdict.marker.epoch };
    },
  }),
});
function envelope(row: typeof eventDetail.event) {
  return { ...row, created_at: new Date(row.created_at) };
}
async function denial(call: Promise<unknown>, status: number) {
  const result: unknown = await call.catch((e: unknown) => e);
  if (!(result instanceof Response)) throw new Error('Expected shaped Response');
  expect(result.status).toBe(status);
  return result.json();
}
beforeEach(() => {
  vi.stubEnv('INTERNAL_TOKEN', 'event-unit-token');
  vi.clearAllMocks();
  seams.read.mockReset().mockResolvedValue(envelope(eventDetail.event));
  seams.chain.mockReset().mockResolvedValue({
    caused_by: eventDetail.chain.caused_by && envelope(eventDetail.chain.caused_by),
    caused_events: eventDetail.chain.caused_events.map(envelope),
    corrections: eventDetail.chain.corrections.map(envelope),
  });
  seams.write.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('Start event authorization and unchanged public operations', () => {
  it.each([undefined, '', 'wrong', 'event-unit-token-extra'])(
    'rejects token %s before domain/DB/parse/effects',
    async (token) => {
      const epochGate = vi.fn(async () => ({ runnable: true }));
      const ctx = { api: buildHonoApp([], { epochGate }) };
      for (const operation of [
        runAuthenticatedStartEventDetail,
        runAuthenticatedStartEventCorrection,
      ])
        await denial(operation(ctx, request(token), null), 401);
      expect(epochGate).not.toHaveBeenCalled();
      for (const seam of Object.values(seams)) expect(seam).not.toHaveBeenCalled();
    },
  );
  it.each(['preparing', 'ready'] as const)(
    'fences %s before malformed input and operations',
    async (phase) => {
      for (const operation of [
        runAuthenticatedStartEventDetail,
        runAuthenticatedStartEventCorrection,
      ]) {
        expect(
          await denial(operation(context(phase), request('event-unit-token'), null), 503),
        ).toMatchObject({ error: 'contract_epoch_fenced', reason: 'maintenance', state: phase });
      }
      for (const seam of Object.values(seams)) expect(seam).not.toHaveBeenCalled();
    },
  );
  it('reads the complete ISO chain through the supplied database', async () => {
    const result = await runAuthenticatedStartEventDetail(context(), request('event-unit-token'), {
      id: ' focus / 原件 ',
    });
    expect(result).toEqual(eventDetail);
    expect(JSON.stringify(result)).toBe(JSON.stringify(eventDetail));
    expect(seams.read).toHaveBeenCalledExactlyOnceWith({}, 'focus / 原件');
    expect(seams.chain).toHaveBeenCalledExactlyOnceWith({}, 'focus / 原件');
    expect(seams.db).toHaveBeenCalledOnce();
    expect(seams.write).not.toHaveBeenCalled();
  });
  it.each([null, {}, { id: 12 }, { id: '  ' }])(
    'rejects invalid read input %j before DB',
    async (input) => {
      expect(
        await denial(
          runAuthenticatedStartEventDetail(context(), request('event-unit-token'), input),
          400,
        ),
      ).toMatchObject({ error: 'validation_error' });
      expect(seams.db).not.toHaveBeenCalled();
      expect(seams.read).not.toHaveBeenCalled();
    },
  );
  it.each(['retract', 'mark_wrong', 'restore', 'supersede'] as const)(
    'appends each explicit %s invocation with a fresh ID and canonical receipt',
    async (kind) => {
      const input = {
        ...eventCorrectionInput,
        correction_kind: kind,
        ...(kind === 'supersede' ? { replacement_event_id: 'replacement' } : {}),
      };
      const receipts = [];
      for (let i = 0; i < 2; i++)
        receipts.push(
          await runAuthenticatedStartEventCorrection(
            context(),
            request('event-unit-token'),
            { id: ' focus / 原件 ', input },
            { now: eventNow },
          ),
        );
      expect(receipts[0].correction_event_id).not.toBe(receipts[1].correction_event_id);
      for (const [index, receipt] of receipts.entries()) {
        expect(receipt).toEqual({
          correction_event_id: receipt.correction_event_id,
          status: 201,
          canonicalLocation: `/api/events/${encodeURIComponent(receipt.correction_event_id)}`,
        });
        expect(seams.write.mock.calls[index][1]).toMatchObject({
          id: receipt.correction_event_id,
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'correct',
          subject_kind: 'event',
          subject_id: 'focus / 原件',
          caused_by_event_id: 'focus / 原件',
          payload: { ...input, reason_md: input.reason_md.trim() },
          created_at: eventNow,
        });
      }
      expect(seams.write).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    null,
    {},
    { ...eventCorrectionInput, reason_md: ' ' },
    { ...eventCorrectionInput, reason_md: 'x'.repeat(2001) },
    { ...eventCorrectionInput, affected_refs: [] },
    { ...eventCorrectionInput, affected_refs: [{ kind: 'unknown', id: 'bad' }] },
    { ...eventCorrectionInput, correction_kind: 'supersede' },
    { ...eventCorrectionInput, replacement_event_id: 'replacement' },
  ])('rejects invalid correction %j before DB/effects', async (input) => {
    await denial(
      runAuthenticatedStartEventCorrection(context(), request('event-unit-token'), {
        id: 'focus',
        input,
      }),
      400,
    );
    expect(seams.db).not.toHaveBeenCalled();
    expect(seams.read).not.toHaveBeenCalled();
    expect(seams.write).not.toHaveBeenCalled();
  });
  it('keeps missing404 distinct from corrupt500 for both operations', async () => {
    for (const operation of [
      runAuthenticatedStartEventDetail,
      runAuthenticatedStartEventCorrection,
    ]) {
      seams.read.mockResolvedValueOnce(null);
      expect(
        await denial(
          operation(context(), request('event-unit-token'), {
            id: 'missing',
            input: eventCorrectionInput,
          }),
          404,
        ),
      ).toMatchObject({ error: 'not_found' });
    }
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const operation of [
        runAuthenticatedStartEventDetail,
        runAuthenticatedStartEventCorrection,
      ]) {
        seams.read.mockRejectedValueOnce(new Error('private corrupt payload'));
        expect(
          await denial(
            operation(context(), request('event-unit-token'), {
              id: 'corrupt',
              input: eventCorrectionInput,
            }),
            500,
          ),
        ).toEqual({ error: 'internal_error', message: 'Internal Server Error' });
      }
    } finally {
      log.mockRestore();
    }
    expect(seams.write).not.toHaveBeenCalled();
  });
  it('does not reclassify corrupted causal/correction chains as missing', async () => {
    seams.chain.mockResolvedValueOnce({
      ...eventDetail.chain,
      corrections: [{ ...eventDetail.chain.corrections[0], created_at: new Date('invalid') }],
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await denial(
        runAuthenticatedStartEventDetail(context(), request('event-unit-token'), { id: 'focus' }),
        500,
      );
    } finally {
      log.mockRestore();
    }
    expect(seams.write).not.toHaveBeenCalled();
  });
});
