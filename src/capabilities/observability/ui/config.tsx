// /admin/config — M3E presentation inside the shared admin frame (YUK-1473,
// docs/design/2026-11-03-admin-write-m3e.md). Presentation only: the query, the save / reset
// routing, the committed-epoch notice and the section / search URL state are unchanged.
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/ui-next/public';
import { type AdminControlClient, httpAdminControlClient } from './admin-control-client';
import {
  ADMIN_LINKS,
  AdminArea,
  type AdminAreaStatus,
  AdminFrame,
  AdminHead,
  AdminNav,
} from './admin-frame';
import { CONFIG_QUERY_KEY, SECTIONS, type SaveConfig, configSection } from './config-model';
import { ConfigSections } from './config-sections';

/** `isPending ? 'loading' : !data ? 'error' : 'ok'`, written out (same order as before). */
function configAreaStatus(q: { isPending: boolean; data: unknown }): AdminAreaStatus {
  if (q.isPending) return 'loading';
  if (!q.data) return 'error';
  return 'ok';
}

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
    return receipt;
  };
  return (
    <AdminFrame>
      <AdminNav links={ADMIN_LINKS} current="/admin/config" navigate={navigate} />
      <AdminHead
        kicker="ADMIN · config"
        title="配置"
        lead="查看真实运行选择，按任务管理模型与输出偏好。"
        actions={
          <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
            <RefreshCw size={16} aria-hidden="true" />
            刷新配置快照
          </Button>
        }
      />
      <div className="adm-toolbar">
        <nav className="adm-tabs" aria-label="配置分区">
          {SECTIONS.map((item) => (
            <button
              type="button"
              key={item.id}
              className="adm-tab un-hit"
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => setQuery('section', item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <label className="adm-search">
          <span className="adm-field-name">搜索配置</span>
          <input
            className="adm-input adm-search-input"
            type="search"
            value={search}
            onChange={(e) => setQuery('q', e.target.value || null)}
            placeholder="名称、模型或说明"
          />
        </label>
      </div>
      {committedEpoch !== null && (
        <p role="status" className="adm-saved">
          {(query.data?.snapshot.epoch ?? -1) >= committedEpoch
            ? '已保存。后台最多 15 秒后读到，这之后发起的运行才用新配置。'
            : '已保存，等待刷新。'}
        </p>
      )}
      {query.isError && query.data && (
        <p role="alert" className="adm-warn-line">
          刷新失败，当前展示上次快照。请重试。
        </p>
      )}
      <AdminArea
        status={configAreaStatus(query)}
        loadingLabel="配置加载中"
        errorText={query.error instanceof Error ? query.error.message : '无法加载配置'}
        onRetry={() => void query.refetch()}
      >
        {query.data && (
          <>
            {!query.data.facts_injected && (
              <p role="status" className="adm-warn-line">
                运行时事实尚未就绪；模型编辑暂不可用。
              </p>
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
      </AdminArea>
    </AdminFrame>
  );
}
