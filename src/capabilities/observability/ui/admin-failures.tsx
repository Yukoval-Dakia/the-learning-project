import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Button, Chip } from '@/ui-next/public';
import { type AdminReadClient, httpAdminClient } from './admin-client';
import {
  ADMIN_LINKS,
  AdminError,
  AdminFrame,
  AdminHead,
  AdminKpi,
  AdminKpis,
  AdminLoading,
  AdminNav,
  AdminPanel,
} from './admin-frame';
import { type AdminSurfaceProps, formatTime, shortId } from './observability-shared';

export function AdminFailuresSurface({
  navigate,
  client = httpAdminClient,
}: AdminSurfaceProps & { client?: AdminReadClient }) {
  const queryClient = useQueryClient();
  const failuresQ = useQuery({
    queryKey: ['admin-failures'],
    queryFn: () => client.getFailures({ limit: '200' }),
    refetchInterval: 60_000,
  });
  const clusters = failuresQ.data?.clusters ?? [];
  const failureWindow = failuresQ.data?.limit ?? 200;
  const totalFailures = clusters.reduce((sum, cluster) => sum + cluster.count, 0);
  const top = clusters[0];

  return (
    <AdminFrame>
      <AdminNav links={ADMIN_LINKS} current="/admin/failures" navigate={navigate} />
      <AdminHead
        kicker="ADMIN · failure clusters"
        title="Failures"
        lead="按 `finish_reason` 与 error message 前缀聚类失败样本，先看重复失败而不是逐条翻日志。"
        actions={
          <Button
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ['admin-failures'] });
            }}
          >
            <RefreshCw size={16} aria-hidden="true" />
            刷新
          </Button>
        }
      />

      <AdminKpis>
        <AdminKpi
          label="failed runs"
          value={totalFailures}
          note={`in latest ${failureWindow} failed-run window`}
        />
        <AdminKpi label="clusters" value={clusters.length} note="reason + prefix" />
        <AdminKpi label="top count" value={top?.count ?? 0} note={top?.finish_reason ?? 'none'} />
        <AdminKpi
          label="samples"
          value={clusters.reduce((sum, cluster) => sum + cluster.samples.length, 0)}
          note="shown"
        />
      </AdminKpis>

      {failuresQ.isLoading && <AdminLoading label="failures 加载中" />}
      {failuresQ.error && <AdminError error={failuresQ.error} />}

      {failuresQ.data && (
        <div className="adm-stack">
          {clusters.map((cluster, index) => (
            <AdminPanel
              key={cluster.key}
              // Cluster keys hold raw error text, so the heading id is positional.
              id={`adm-fail-${index}`}
              title={cluster.error_prefix}
              titleClassName="adm-mono"
              flush
              sub={`latest ${formatTime(cluster.latest_at)} · ${cluster.samples.length} samples shown`}
              aside={
                <Chip tone="critical">
                  {cluster.finish_reason} · {cluster.count}
                </Chip>
              }
            >
              <div className="adm-table-scroll">
                <table className="adm-table adm-table-compact">
                  <thead>
                    <tr>
                      <th scope="col">run</th>
                      <th scope="col">task</th>
                      <th scope="col">model</th>
                      <th scope="col">started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cluster.samples.map((sample) => (
                      <tr key={sample.id}>
                        <td className="adm-mono">{shortId(sample.id)}</td>
                        <td>{sample.task_kind}</td>
                        <td className="adm-mono">{sample.model}</td>
                        <td className="adm-mono adm-quiet">{formatTime(sample.started_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </AdminPanel>
          ))}
          {clusters.length === 0 && (
            <div className="adm-panel adm-clear">
              <Chip tone="positive">clear</Chip>
              <p className="adm-empty">No failed AI task runs in the latest window.</p>
            </div>
          )}
        </div>
      )}
    </AdminFrame>
  );
}
