import { apiJson } from '@/ui/lib/api';
import { Badge } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CSSProperties } from 'react';
import {
  AdminLinks,
  type AdminSurfaceProps,
  ErrorCard,
  Kpi,
  LoadingCard,
  formatTime,
  mutedTextStyle,
  sectionHeadStyle,
  sectionTitleStyle,
  shortId,
} from './observability-shared';

interface FailureCluster {
  key: string;
  finish_reason: string;
  error_prefix: string;
  count: number;
  latest_at: string;
  samples: Array<{
    id: string;
    task_kind: string;
    model: string;
    started_at: string;
    error_message: string | null;
  }>;
}

export function AdminFailuresSurface({ navigate }: AdminSurfaceProps) {
  const queryClient = useQueryClient();
  const failuresQ = useQuery({
    queryKey: ['admin-failures'],
    queryFn: () =>
      apiJson<{ clusters: FailureCluster[]; limit: number }>('/api/admin/failures?limit=200'),
    refetchInterval: 60_000,
  });
  const clusters = failuresQ.data?.clusters ?? [];
  const failureWindow = failuresQ.data?.limit ?? 200;
  const totalFailures = clusters.reduce((sum, cluster) => sum + cluster.count, 0);
  const top = clusters[0];

  return (
    <main className="page wide">
      <PageHeader
        title="Failures"
        eyebrow="ADMIN · failure clusters"
        sub="按 `finish_reason` 与 error message 前缀聚类失败样本，先看重复失败而不是逐条翻日志。"
      >
        <AdminLinks navigate={navigate} />
        <Button
          variant="secondary"
          icon="refresh"
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: ['admin-failures'] });
          }}
        >
          刷新
        </Button>
      </PageHeader>

      <div className="kpi-strip">
        <Kpi
          label="failed runs"
          value={totalFailures}
          note={`in latest ${failureWindow} failed-run window`}
        />
        <Kpi label="clusters" value={clusters.length} note="reason + prefix" />
        <Kpi label="top count" value={top?.count ?? 0} note={top?.finish_reason ?? 'none'} />
        <Kpi
          label="samples"
          value={clusters.reduce((sum, cluster) => sum + cluster.samples.length, 0)}
          note="shown"
        />
      </div>

      {failuresQ.isLoading && <LoadingCard label="failures" />}
      {failuresQ.error && <ErrorCard error={failuresQ.error} />}

      {failuresQ.data && (
        <div style={clusterListStyle}>
          {clusters.map((cluster) => (
            <Card key={cluster.key} pad="lg">
              <div style={sectionHeadStyle}>
                <div style={{ minWidth: 0 }}>
                  <h2 style={sectionTitleStyle}>{cluster.error_prefix}</h2>
                  <p style={mutedTextStyle}>
                    latest {formatTime(cluster.latest_at)} · {cluster.samples.length} samples shown
                  </p>
                </div>
                <Badge tone="again">
                  {cluster.finish_reason} · {cluster.count}
                </Badge>
              </div>
              <div className="admin-sample-grid">
                {cluster.samples.map((sample) => (
                  <div key={sample.id} style={sampleStyle}>
                    <code>{shortId(sample.id)}</code>
                    <span>{sample.task_kind}</span>
                    <span>{sample.model}</span>
                    <span>{formatTime(sample.started_at)}</span>
                  </div>
                ))}
              </div>
            </Card>
          ))}
          {clusters.length === 0 && (
            <Card pad="lg">
              <Badge tone="good">clear</Badge>
              <p style={mutedTextStyle}>No failed AI task runs in the latest window.</p>
            </Card>
          )}
        </div>
      )}
    </main>
  );
}

const clusterListStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr',
  gap: 'var(--s-4)',
};
const sampleStyle: CSSProperties = {
  display: 'contents',
  color: 'var(--ink-3)',
};
