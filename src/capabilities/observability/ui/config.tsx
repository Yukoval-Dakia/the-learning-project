import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/ui/primitives/Button';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { Stateful } from '@/ui/primitives/Stateful';
import { TabBar } from '@/ui/primitives/TabBar';
import { type AdminControlClient, httpAdminControlClient } from './admin-control-client';
import {
  CONFIG_QUERY_KEY,
  SECTIONS,
  type SaveConfig,
  configSection,
  inputClass,
} from './config-model';
import { ConfigSections } from './config-sections';
import { AdminLinks } from './observability-shared';

export function AdminConfigSurface({
  navigate,
  getQuery,
  setQuery,
  client = httpAdminControlClient,
}: {
  navigate: (to: string) => void;
  getQuery: (key: string) => string | null;
  setQuery: (key: string, value: string | null) => void;
  client?: AdminControlClient;
}) {
  const query = useQuery({
    queryKey: CONFIG_QUERY_KEY,
    queryFn: () => client.getConfig(),
    refetchInterval: 15_000,
  });
  const [committedEpoch, setCommittedEpoch] = useState<number | null>(null);
  const section = configSection(getQuery('section'));
  const search = getQuery('q') ?? '';
  const save: SaveConfig = async (changes) => {
    const receipt = changes.every((change) => change.action === 'clear')
      ? await client.resetConfig({ keys: changes.map((change) => change.key) })
      : await client.patchConfig({ changes });
    setCommittedEpoch(receipt.committed_epoch);
    // A refresh failure must not turn an acknowledged write into a reported write failure.
    await query.refetch();
  };
  return (
    <div className="page min-w-0 w-full space-y-5">
      <PageHeader title="配置" eyebrow="ADMIN" sub="查看运行配置，管理 AI 模型与输出偏好。">
        <AdminLinks navigate={navigate} />
      </PageHeader>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 max-w-full overflow-x-auto">
          <TabBar
            items={SECTIONS}
            active={section}
            onSelect={(value) => setQuery('section', value)}
          />
        </div>
        <Button
          variant="secondary"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          刷新配置
        </Button>
      </div>
      <label className="block">
        搜索配置{' '}
        <input
          className={inputClass}
          type="search"
          value={search}
          onChange={(e) => setQuery('q', e.target.value || null)}
          placeholder="名称、模型或说明"
        />
      </label>
      {committedEpoch !== null && (
        <p role="status" className="text-[var(--good-ink)]">
          {(query.data?.snapshot.epoch ?? -1) >= committedEpoch
            ? '配置已保存，当前进程已刷新；后续调用按新配置解析。'
            : '已保存，等待刷新。'}{' '}
          不代表 worker 已确认。
        </p>
      )}
      {query.isError && query.data && <p role="alert">刷新失败，当前展示上次快照。请重试。</p>}
      <Stateful
        status={query.isPending ? 'loading' : !query.data ? 'error' : 'ok'}
        errorText={query.error instanceof Error ? query.error.message : '无法加载配置'}
        onRetry={() => void query.refetch()}
      >
        {query.data && (
          <>
            {!query.data.facts_injected && (
              <p role="status">运行时事实尚未就绪；模型编辑暂不可用。</p>
            )}
            <ConfigSections
              key={section}
              section={section}
              data={query.data}
              query={search}
              save={save}
              navigate={navigate}
            />
          </>
        )}
      </Stateful>
    </div>
  );
}
