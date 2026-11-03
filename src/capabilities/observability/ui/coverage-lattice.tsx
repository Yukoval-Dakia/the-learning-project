// YUK-579 — 供题治理覆盖细目表（coverage lattice）只读观测面（admin 第五页）。
//
// 壳形态：admin 页套主 app chrome（RootShell），非独立壳——见 docs/design/2026-07-07-yuk579-
// coverage-lattice.md §6 决策记录（loom app.jsx 的「separate shell」原型已被 SPA 单一 RootShell
// 取代，owner 已收编）。本文件不复制既有 admin 文件头的陈旧「separate shell」措辞。
//
// MF2：本页 useQuery **不设 refetchInterval** + 顶部「重新扫描」按钮（owner 主动刷）——刻意背离
//   四页 60s 轮询范式，因每次 GET 跑一次 3N-5N 串行活扫描（design §5），60s 自动轮询会反复打单
//   Postgres，与「偶尔打开故不缓存」自相矛盾。
// MF3：desired 坐标渲成**从属其触发规则的获取请求**（wants: kind/band/tier ×N，非 column-aligned
//   矩阵）；frontier_zero 的 scaffold 坐标置灰标「default scaffold · not scanned」；未评估轴渲显式
//   「未评估·空池」chip 而非裸 n/a——把「不撒谎逐格覆盖」编码进渲染 artifact。
// should#1：header 声明本蓝图边界（scanCoverageGaps 四规则的 KC 池覆盖，非全量并集）。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, Chip, type ChipTone } from '@/ui-next/public';
import { type AdminReadClient, httpAdminClient } from './admin-client';
import {
  ADMIN_LINKS_NO_CONFIG,
  AdminArea,
  AdminFrame,
  AdminHead,
  AdminKpi,
  AdminKpis,
  AdminNav,
  AdminPanel,
  adminAreaStatus,
} from './admin-frame';

type CoverageLatticeResponse = Awaited<ReturnType<AdminReadClient['getCoverage']>>;
type SubjectCoverage = CoverageLatticeResponse['subjects'][number];
type KcCoverageRow = SubjectCoverage['kcs'][number];
type LatticeGap = KcCoverageRow['gaps'][number];
type GapActivity = NonNullable<LatticeGap['lastActivity']>;

export type CoverageScanState = 'scanning' | 'failed' | 'unscanned' | 'healthy' | 'degraded';

export function classifyCoverageScanState({
  activeKcs,
  totalGaps,
  isFetching,
  isError,
}: {
  activeKcs: number;
  totalGaps: number;
  isFetching: boolean;
  isError: boolean;
}): CoverageScanState {
  if (isError) return 'failed';
  if (isFetching) return 'scanning';
  if (activeKcs === 0) return 'unscanned';
  return totalGaps > 0 ? 'degraded' : 'healthy';
}

export function coverageScanStateLabel(state: CoverageScanState): string {
  if (state === 'scanning') return 'scanning';
  if (state === 'failed') return 'scan failed';
  if (state === 'unscanned') return 'not scanned';
  if (state === 'degraded') return 'gaps found';
  return 'clear';
}

function coverageScanStateTone(state: CoverageScanState): ChipTone {
  if (state === 'failed') return 'critical';
  if (state === 'scanning') return 'accent';
  if (state === 'healthy') return 'positive';
  if (state === 'degraded') return 'caution';
  return 'neutral';
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function daysAgo(value: string | null, now: number): string {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '';
  const days = Math.floor((now - then) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'today';
  return `${days}d ago`;
}

// MF3 —— 池级判词单格：✓ / gap / 未评估·空池（null）。
function verdictCell(value: boolean | null, gapLabel: string): ReactNode {
  if (value === null) {
    return <Chip>未评估·空池</Chip>;
  }
  return value ? <span className="adm-ok">✓</span> : <Chip tone="critical">{gapLabel}</Chip>;
}

function gapTone(gapKind: string): ChipTone {
  if (gapKind === 'frontier_zero') return 'critical';
  if (gapKind === 'diagnostic') return 'caution';
  if (gapKind === 'source_quality') return 'accent';
  return 'neutral';
}

// MF1/MF3 activity 注记渲染。
function GapActivityNote({
  activity,
  cooldownDays,
}: {
  activity: GapActivity | null;
  cooldownDays: number;
}) {
  if (!activity || activity.lastActivityAt === null) {
    return <span className="adm-gap-meta">无派发记录</span>;
  }
  const now = Date.now();
  return (
    <span className="adm-gap-meta">
      {activity.lastStatus ?? 'activity'} · {daysAgo(activity.lastActivityAt, now)}
      {activity.inCooldown && activity.cooldownUntil && (
        <>
          {' · '}
          <span className="adm-cooldown">cooldown→{formatTime(activity.cooldownUntil)}</span>
        </>
      )}
      {!activity.inCooldown &&
        activity.lastDispatchedAt &&
        ` · dispatched ${daysAgo(activity.lastDispatchedAt, now)} (cooldown ${cooldownDays}d elapsed)`}
    </span>
  );
}

// MF3 —— 一条缺口渲成「从属触发规则的获取请求」，非 column-aligned 矩阵行。
function GapRow({ gap, cooldownDays }: { gap: LatticeGap; cooldownDays: number }) {
  return (
    <li className="adm-gap">
      <Chip tone={gapTone(gap.gapKind)}>{gap.gapKind}</Chip>
      <div className="adm-gap-body">
        {gap.scaffold ? (
          // frontier_zero：坐标是硬编脚手架常量，非扫描依据 → 置灰。
          <div className="adm-wants" data-scaffold="">
            default scaffold · not scanned · ×{gap.desiredCount} · p{gap.priority.toFixed(2)}
          </div>
        ) : (
          <div className="adm-wants">
            wants: {gap.kind}/{gap.difficultyBand}/tier{gap.minSourceTier} · ×{gap.desiredCount} · p
            {gap.priority.toFixed(2)}
          </div>
        )}
        <div className="adm-gap-meta-line">
          <GapActivityNote activity={gap.lastActivity} cooldownDays={cooldownDays} />
        </div>
      </div>
    </li>
  );
}

export function AdminCoverageLatticeSurface({
  navigate,
  client = httpAdminClient,
}: {
  navigate: (to: string) => void;
  client?: AdminReadClient;
}) {
  const queryClient = useQueryClient();
  // MF2：无 refetchInterval（刻意）。owner 用「重新扫描」按钮手动刷。
  const q = useQuery({
    queryKey: ['admin-coverage-lattice'],
    queryFn: () => client.getCoverage(),
  });
  const data = q.data;
  const scanState = classifyCoverageScanState({
    activeKcs: data?.totals.activeKcs ?? 0,
    totalGaps: data?.totals.totalGaps ?? 0,
    isFetching: q.isFetching,
    isError: q.isError,
  });

  return (
    <AdminFrame>
      <AdminNav
        links={ADMIN_LINKS_NO_CONFIG}
        current="/admin/coverage-lattice"
        navigate={navigate}
      />
      <AdminHead
        kicker="ADMIN · question supply"
        title="供题覆盖"
        lead="覆盖 scanCoverageGaps 四规则（frontier / source-quality / diagnostic / format）的 KC 池级覆盖，非供给系统全量缺口并集（confusable 误区网另计）。每次打开跑一次实时扫描。"
        actions={
          <Button
            // CodeRabbit (PR #732): 手动 rescan 每次触发一次 3N-5N 串行活扫描，须给点击态反馈。
            // q.isFetching 覆盖首载 + 手动 rescan 的后台 refetch（isLoading 只覆盖首载）——扫描期
            // 禁用按钮 + 显式「扫描中…」文案，避免用户误以为无效而重复点击。保持 MF2 no-refetchInterval。
            disabled={q.isFetching}
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ['admin-coverage-lattice'] });
            }}
          >
            <RefreshCw size={16} aria-hidden="true" />
            {q.isFetching ? '扫描中…' : '重新扫描'}
          </Button>
        }
      />

      {data && (
        <AdminKpis>
          <AdminKpi
            label="active KCs"
            value={data.totals.activeKcs}
            note={
              scanState === 'unscanned'
                ? 'no active-goal scope'
                : `${data.subjects.length} subjects`
            }
          />
          <AdminKpi
            label="KCs with gaps"
            value={data.totals.kcsWithGaps}
            note={kcsWithGapsNote(scanState, data.totals.kcsWithGaps)}
          />
          <AdminKpi
            label="gaps"
            value={data.totals.totalGaps}
            note={
              scanState === 'unscanned' ? 'not scanned' : gapKindSummary(data.totals.gapsByKind)
            }
          />
          <AdminKpi
            label="scan"
            value={`${data.scan_ms}ms`}
            note={`${coverageScanStateLabel(scanState)} · ${formatTime(data.generated_at)}`}
          />
        </AdminKpis>
      )}

      <AdminArea
        status={adminAreaStatus(q)}
        onRetry={() => void q.refetch()}
        errorText="coverage lattice 加载失败。"
        loadingLabel="覆盖细目扫描中"
      >
        {data && data.subjects.length === 0 && (
          <div className="adm-panel adm-clear">
            <Chip tone={coverageScanStateTone(scanState)}>{coverageScanStateLabel(scanState)}</Chip>
            <p className="adm-empty">
              {scanState === 'unscanned'
                ? '当前没有 active-goal 知识点范围；本次未评估覆盖度，不能据此判定为健康。'
                : '当前扫描范围内没有可展示的知识点。'}
            </p>
          </div>
        )}
        {data?.subjects.map((subject, index) => (
          <AdminPanel
            key={subject.subjectId}
            id={`adm-cov-${index}`}
            title={subject.displayName ?? subject.subjectId}
            flush
            aside={
              <Chip>
                {subject.kcs.filter((k) => k.gaps.length > 0).length} / {subject.kcs.length} with
                gaps
              </Chip>
            }
          >
            <div className="adm-table-scroll">
              <table className="adm-table adm-table-lattice">
                <thead>
                  <tr>
                    <th scope="col">KC</th>
                    <th scope="col">depth</th>
                    <th scope="col">src</th>
                    <th scope="col">diag</th>
                    <th scope="col">fmt</th>
                    <th scope="col" className="adm-num">
                      θ̂
                    </th>
                    <th scope="col" className="adm-num">
                      ev
                    </th>
                    <th scope="col" className="adm-num">
                      gaps
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {subject.kcs.map((kc) => (
                    <tr key={kc.knowledgeId}>
                      <td className="adm-kc">
                        <code className="adm-mono">{kc.knowledgeId}</code>
                        {kc.gaps.length > 0 && (
                          <ul className="adm-gaps">
                            {kc.gaps.map((gap) => (
                              <GapRow
                                key={gap.fingerprint}
                                gap={gap}
                                cooldownDays={data.cooldown_days}
                              />
                            ))}
                          </ul>
                        )}
                      </td>
                      <td>
                        {kc.depthMet ? (
                          <span className="adm-ok">
                            {kc.usableCount}/{data.coverage_depth_threshold}
                          </span>
                        ) : (
                          <Chip tone="critical">
                            {kc.usableCount}/{data.coverage_depth_threshold}
                          </Chip>
                        )}
                      </td>
                      <td>{verdictCell(kc.hasHighTier, 'gap')}</td>
                      <td>{verdictCell(kc.hasNearThetaAnchor, 'gap')}</td>
                      <td>{verdictCell(kc.formatDiverse, 'gap')}</td>
                      <td className="adm-num adm-mono">{kc.thetaHat.toFixed(2)}</td>
                      <td className="adm-num adm-mono">{kc.evidenceCount}</td>
                      <td className="adm-num adm-mono">{kc.gaps.length || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AdminPanel>
        ))}
      </AdminArea>
    </AdminFrame>
  );
}

/** The `KCs with gaps` note: not evaluated → needs supply → clear (same order as before). */
function kcsWithGapsNote(scanState: CoverageScanState, kcsWithGaps: number): string {
  if (scanState === 'unscanned') return 'not evaluated';
  return kcsWithGaps ? 'needs supply' : 'clear';
}

function gapKindSummary(byKind: Record<string, number>): string {
  const entries = Object.entries(byKind);
  if (entries.length === 0) return 'none';
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}:${n}`)
    .join(' · ');
}
