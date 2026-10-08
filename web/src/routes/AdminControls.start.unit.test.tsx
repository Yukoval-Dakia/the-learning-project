// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminConfigSurface } from '@/capabilities/observability/ui/config';
import { AdminSubjectTraitsSurface } from '@/capabilities/observability/ui/subject-traits';
import { AdminSubjectsSurface } from '@/capabilities/observability/ui/subjects';
import { ApiError } from '@/ui/lib/api';
import { startAdminControlClient } from '../../../server/start/admin-control-client';
import {
  controlConfig,
  controlJournal,
  controlReceipt,
  controlSubjects,
  controlTraits,
} from '../../../server/start/admin-control-test-fixtures';

const rpc = vi.hoisted(() => ({
  getStartAdminConfig: vi.fn(),
  patchStartAdminConfig: vi.fn(),
  resetStartAdminConfig: vi.fn(),
  getStartAdminSubjects: vi.fn(),
  getStartAdminSubjectTraits: vi.fn(),
  getStartAdminTraits: vi.fn(),
  getStartAdminTraitJournal: vi.fn(),
  renameStartAdminSubject: vi.fn(),
  retireStartAdminSubject: vi.fn(),
  restoreStartAdminSubject: vi.fn(),
  resetStartAdminSubject: vi.fn(),
  validateStartAdminSubject: vi.fn(),
  editStartAdminSubjectTrait: vi.fn(),
  forkStartAdminSubjectTrait: vi.fn(),
  rebindStartAdminSubjectTrait: vi.fn(),
  editStartAdminSharedTrait: vi.fn(),
  rollbackStartAdminTrait: vi.fn(),
  resetStartAdminTraitToSeed: vi.fn(),
}));
vi.mock('../../../server/start/admin-control-function', () => rpc);

const clients: QueryClient[] = [];
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected HTTP fallback');
    }),
  );
  rpc.getStartAdminConfig.mockResolvedValue(JSON.stringify(controlConfig()));
  rpc.getStartAdminSubjects.mockResolvedValue(controlSubjects);
  rpc.getStartAdminSubjectTraits.mockResolvedValue(JSON.stringify(controlTraits));
  rpc.getStartAdminTraits.mockResolvedValue({
    traits: [
      {
        traitId: 'target',
        origin: 'custom',
        ownerSubjectId: 'retired',
        seedVersion: null,
        revision: 2,
        boundBy: ['retired'],
      },
    ],
  });
  rpc.getStartAdminTraitJournal.mockResolvedValue(controlJournal);
  rpc.validateStartAdminSubject.mockResolvedValue({
    valid: false,
    errors: ['候选不兼容'],
    warnings: ['保留'],
  });
  rpc.patchStartAdminConfig.mockResolvedValue(controlReceipt);
  rpc.resetStartAdminConfig.mockResolvedValue(controlReceipt);
  for (const name of [
    'renameStartAdminSubject',
    'retireStartAdminSubject',
    'restoreStartAdminSubject',
    'resetStartAdminSubject',
  ] as const)
    rpc[name].mockResolvedValue({ subjectRevision: 9 });
  for (const name of [
    'editStartAdminSubjectTrait',
    'forkStartAdminSubjectTrait',
    'rebindStartAdminSubjectTrait',
    'editStartAdminSharedTrait',
    'rollbackStartAdminTrait',
    'resetStartAdminTraitToSeed',
  ] as const)
    rpc[name].mockResolvedValue({
      traitId: 'seed/charter',
      revision: 4,
      forked: false,
      status: 200,
    });
});
afterEach(() => {
  cleanup();
  for (const c of clients.splice(0)) c.clear();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
function mount(page: 'config' | 'subjects' | 'detail', section = 'locale') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const navigate = vi.fn();
  render(
    <QueryClientProvider client={client}>
      {page === 'config' ? (
        <AdminConfigSurface
          navigate={navigate}
          getQuery={(key) => (key === 'section' ? section : null)}
          setQuery={vi.fn()}
          client={startAdminControlClient}
        />
      ) : page === 'subjects' ? (
        <AdminSubjectsSurface navigate={navigate} client={startAdminControlClient} />
      ) : (
        <AdminSubjectTraitsSurface
          subjectId="custom"
          navigate={navigate}
          client={startAdminControlClient}
        />
      )}
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), navigate, client };
}
describe('existing admin visuals and behavior through injected Start clients', () => {
  it('records config receipt before refresh failure and refresh retry never replays the write', async () => {
    const { user } = mount('config');
    await screen.findByText('AI 输出语言');
    await user.selectOptions(screen.getByRole('combobox', { name: '输出语言' }), 'en');
    await user.click(screen.getByRole('button', { name: '保存语言' }));
    rpc.getStartAdminConfig.mockRejectedValueOnce(new Error('read refresh failed'));
    await user.click(screen.getByRole('button', { name: '确认变更' }));
    expect(await screen.findByText(/已保存，等待刷新/)).toBeTruthy();
    expect(await screen.findByText('刷新失败，当前展示上次快照。请重试。')).toBeTruthy();
    expect(rpc.patchStartAdminConfig).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '刷新配置' }).hasAttribute('disabled')).toBe(false),
    );
    await user.click(screen.getByRole('button', { name: '刷新配置' }));
    await waitFor(() => expect(rpc.getStartAdminConfig).toHaveBeenCalledTimes(3));
    expect(rpc.patchStartAdminConfig).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses grouped reset and keeps model editing facts gate and settings links', async () => {
    const { user } = mount('config', 'ai-models');
    await user.click(await screen.findByRole('button', { name: '编辑 QuizGenTask' }));
    await user.click(screen.getByRole('button', { name: '恢复默认模型' }));
    await user.click(screen.getByRole('button', { name: '确认变更' }));
    expect(rpc.resetStartAdminConfig).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        data: { keys: ['task.QuizGenTask.provider', 'task.QuizGenTask.model'] },
      }),
    );
    expect(rpc.patchStartAdminConfig).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: '配置' }).getAttribute('href')).toBe('/admin/config');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('retains the slim read-only subject list, retired rows, and detail navigation', async () => {
    const { user, navigate } = mount('subjects');
    await screen.findByText('含条件与歧义的科目');
    expect(screen.getByText('历史科目')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '创建' })).toBeNull();
    const link = screen
      .getAllByRole('link', { name: '→' })
      .find((e) => e.getAttribute('href') === '/admin/subjects/custom');
    if (!link) throw new Error('Detail link required');
    await user.click(link);
    expect(navigate).toHaveBeenCalledWith('/admin/subjects/custom');
    expect(rpc.getStartAdminSubjects).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['retire', 'restore', 'reset'] as const)(
    'routes confirmed %s through the canonical RPC with the subject CAS axis',
    async (action) => {
      if (action === 'restore')
        rpc.getStartAdminSubjects.mockResolvedValue({
          subjects: controlSubjects.subjects.map((s) =>
            s.id === 'custom' ? { ...s, retiredAt: '2026-10-09T00:00:00Z' } : s,
          ),
        });
      const { user } = mount('detail');
      await screen.findByText('seed/charter');
      await user.click(screen.getByRole('button', { name: action }));
      await user.click(screen.getByRole('button', { name: '确认' }));
      const command =
        action === 'retire'
          ? rpc.retireStartAdminSubject
          : action === 'restore'
            ? rpc.restoreStartAdminSubject
            : rpc.resetStartAdminSubject;
      await waitFor(() =>
        expect(command).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ data: { subjectId: 'custom', expectedRevision: 8 } }),
        ),
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('keeps rename collision draft and CAS notice/refetch separate without replay', async () => {
    const { user } = mount('detail');
    await screen.findByText('seed/charter');
    await user.click(screen.getByRole('button', { name: 'rename' }));
    await user.type(screen.getByRole('textbox', { name: '新科目名' }), '保留草稿');
    rpc.renameStartAdminSubject.mockRejectedValueOnce(
      new ApiError('409 Conflict', 409, 'name already used'),
    );
    await user.click(screen.getByRole('button', { name: '确认改名' }));
    expect(await screen.findByText('name already used')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '新科目名' })).toHaveProperty('value', '保留草稿');
    expect(rpc.getStartAdminSubjectTraits).toHaveBeenCalledOnce();
    rpc.renameStartAdminSubject.mockRejectedValueOnce(
      new ApiError('stale subject revision', 409, 'stale_revision', { currentRevision: 9 }),
    );
    await user.click(screen.getByRole('button', { name: '确认改名' }));
    expect(await screen.findByText(/配置已被其他会话更新/)).toBeTruthy();
    await waitFor(() => expect(rpc.getStartAdminSubjectTraits).toHaveBeenCalledTimes(2));
    expect(rpc.renameStartAdminSubject).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('textbox', { name: '新科目名' })).toHaveProperty('value', '保留草稿');
  });
  it('routes preflight, COW edit and shared edit through different operations and keeps fanout errors/draft', async () => {
    const { user } = mount('detail');
    await screen.findByText('seed/charter');
    await user.click(screen.getByRole('button', { name: '编辑' }));
    await user.click(screen.getByRole('button', { name: '预检' }));
    expect(await screen.findByText('预检失败：候选不兼容')).toBeTruthy();
    expect(rpc.validateStartAdminSubject).toHaveBeenCalledOnce();
    rpc.editStartAdminSubjectTrait.mockRejectedValueOnce(
      new ApiError('422', 422, 'invalid payload'),
    );
    await user.click(screen.getByRole('button', { name: '保存（自动 fork 本科副本）' }));
    expect(await screen.findByText('invalid payload')).toBeTruthy();
    expect(rpc.editStartAdminSubjectTrait).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        data: {
          subjectId: 'custom',
          kind: 'charter',
          expectedSubjectRevision: 8,
          expectedTraitRevision: 3,
          payload: controlTraits.bindings[0].payload,
        },
      }),
    );
    rpc.editStartAdminSharedTrait.mockRejectedValueOnce(
      new ApiError('422', 422, 'fanout invalid', {
        issues: [{ subjectId: 'retired', errors: ['条件不兼容'] }],
      }),
    );
    await user.click(screen.getByRole('button', { name: '编辑共享面（影响 3 科）' }));
    expect(rpc.editStartAdminSharedTrait).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '确认写入' }));
    expect(await screen.findByText('retired: 条件不兼容')).toBeTruthy();
    expect(rpc.editStartAdminSharedTrait).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox', { name: 'methodology' })).toHaveProperty(
      'value',
      controlTraits.bindings[0].payload.methodology,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('injects fork, kind-filtered catalog/rebind, bounded journal/rollback and seed reset into nested panels', async () => {
    const { user } = mount('detail');
    await screen.findByText('seed/charter');
    await user.click(screen.getByRole('button', { name: 'fork' }));
    await user.click(screen.getByRole('button', { name: '确认 fork' }));
    await waitFor(() => expect(rpc.forkStartAdminSubjectTrait).toHaveBeenCalledOnce());
    await user.click(screen.getByRole('button', { name: '换绑' }));
    await user.click(await screen.findByRole('button', { name: '选择' }));
    await user.click(screen.getByRole('button', { name: '确认换绑' }));
    await waitFor(() => expect(rpc.rebindStartAdminSubjectTrait).toHaveBeenCalledOnce());
    expect(rpc.getStartAdminTraits).toHaveBeenCalledWith(
      expect.objectContaining({ data: { kind: 'charter' } }),
    );
    await user.click(screen.getByRole('button', { name: '历史' }));
    await user.click(await screen.findByRole('button', { name: '回滚到此' }));
    await user.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() =>
      expect(rpc.rollbackStartAdminTrait).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          data: { traitId: 'seed/charter', expectedRevision: 3, targetRevision: 2 },
        }),
      ),
    );
    expect(rpc.getStartAdminTraitJournal).toHaveBeenCalledWith(
      expect.objectContaining({ data: { traitId: 'seed/charter' } }),
    );
    await user.click(screen.getByRole('button', { name: '编辑' }));
    await user.click(screen.getByRole('button', { name: '恢复出厂' }));
    await user.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => expect(rpc.resetStartAdminTraitToSeed).toHaveBeenCalledOnce());
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['admin.config.tsx', 'admin.subjects.tsx', 'admin.subjects.$id.tsx'])(
    'registers the real non-SSR route and control client in %s',
    (file) => {
      const source = readFileSync(`server/start/routes/${file}`, 'utf8');
      expect(source).toContain('ssr: false');
      expect(source).toContain('client={startAdminControlClient}');
      expect(source).toContain('StartWorkbenchShell');
      const router = readFileSync('web/src/router.tsx', 'utf8');
      expect(router.match(/import.meta.env.PROD\s*\? StartPageEntry/g)?.length).toBe(11);
    },
  );
});
