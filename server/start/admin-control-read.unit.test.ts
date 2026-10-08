import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminControlClient } from '@/capabilities/observability/ui-public';
import { buildHonoApp } from '../app';
import { runAuthenticatedStartAdminControl } from './admin-control-read';

const loading = vi.hoisted(() => ({ database: vi.fn(), domain: vi.fn() }));
vi.mock('@/db/client', () => {
  loading.database();
  return { db: {} };
});
vi.mock('@/capabilities/observability/public', () => {
  loading.domain();
  throw new Error('Unauthorized domain import');
});
const names = [
  'getConfig',
  'patchConfig',
  'resetConfig',
  'getSubjects',
  'getSubjectTraits',
  'getTraits',
  'getTraitJournal',
  'renameSubject',
  'retireSubject',
  'restoreSubject',
  'resetSubject',
  'validateSubject',
  'editSubjectTrait',
  'forkSubjectTrait',
  'rebindSubjectTrait',
  'editSharedTrait',
  'rollbackTrait',
  'resetTraitToSeed',
] satisfies Array<keyof AdminControlClient>;
const request = (token?: string) =>
  new Request('http://unit.test/_serverFn/control', {
    headers: token === undefined ? {} : { 'x-internal-token': token },
  });
beforeEach(() => {
  vi.stubEnv('INTERNAL_TOKEN', 'control-token');
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());
describe('all admin control requests gate before resolving canonical operations or parsing', () => {
  it.each([undefined, '', 'wrong', 'control-token-extra'])(
    'denies token %s without epoch or any operation/import',
    async (token) => {
      const epochGate = vi.fn(async () => ({ runnable: true }));
      const adminControls = vi.fn(async (): Promise<AdminControlClient> => {
        throw new Error('Should not resolve');
      });
      const context = { api: buildHonoApp([], { epochGate }), adminControls };
      for (const name of names) {
        const operation = vi.fn(async (controls: AdminControlClient) => controls[name]);
        const error: unknown = await runAuthenticatedStartAdminControl(
          context,
          request(token),
          operation,
        ).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Response);
        if (!(error instanceof Response)) throw new Error('Expected Response');
        expect(error.status).toBe(401);
        expect(operation).not.toHaveBeenCalled();
      }
      expect(epochGate).not.toHaveBeenCalled();
      expect(adminControls).not.toHaveBeenCalled();
      expect(loading.domain).not.toHaveBeenCalled();
      expect(loading.database).not.toHaveBeenCalled();
    },
  );
  it('preserves the real epoch fence before malformed input and unavailable controls', async () => {
    const adminControls = vi.fn(async (): Promise<AdminControlClient> => {
      throw new Error('Should not resolve');
    });
    const context = {
      api: buildHonoApp([], {
        epochGate: async () => ({ runnable: false, reason: 'unavailable' }),
      }),
      adminControls,
    };
    for (const name of names) {
      const operation = vi.fn(async (controls: AdminControlClient) => controls[name]);
      const error: unknown = await runAuthenticatedStartAdminControl(
        context,
        request('control-token'),
        operation,
      ).catch((e: unknown) => e);
      if (!(error instanceof Response)) throw new Error('Expected Response');
      expect(error.status).toBe(503);
      expect(await error.json()).toMatchObject({
        error: 'contract_epoch_fenced',
        reason: 'unavailable',
      });
      expect(operation).not.toHaveBeenCalled();
    }
    expect(adminControls).not.toHaveBeenCalled();
    expect(loading.domain).not.toHaveBeenCalled();
    expect(loading.database).not.toHaveBeenCalled();
  });
});
