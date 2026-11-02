import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Mascot } from '@/ui-next/public';
import '@/ui-next/config/config.css';
import { Stateful } from '@/ui/primitives/Stateful';
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
    <main data-ui-next="" data-un-m3e="practice-foundation" className="un-root un-config">
      <header className="un-config-heading">
        <div>
          <h1>配置</h1>
          <p>查看真实运行选择，按任务管理模型与输出偏好。</p>
          <AdminLinks navigate={navigate} />
        </div>
        <Mascot />
      </header>
      <div className="un-config-toolbar">
        <nav className="un-config-sections" aria-label="配置分区">
          {SECTIONS.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => setQuery('section', item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <Button
          variant="secondary"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          刷新配置快照
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
    </main>
  );
}
