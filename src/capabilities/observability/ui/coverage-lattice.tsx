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

import { apiJson } from '@/ui/lib/api';
import { Badge, type BadgeTone } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { Stateful } from '@/ui/primitives/Stateful';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CSSProperties, ReactNode } from 'react';

// 字段对齐 server/coverage-lattice.ts 的读模型输出。
interface GapActivity {
  lastActivityAt: string | null;
  lastStatus: string | null;
  lastDispatchedAt: string | null;
  inCooldown: boolean;
  cooldownUntil: string | null;
}
interface LatticeGap {
  gapKind: string;
  kind: string;
  difficultyBand: string;
  minSourceTier: 1 | 2 | 3;
  desiredCount: number;
  priority: number;
  reason: string;
  fingerprint: string;
  routePreference: string[];
  scaffold: boolean;
  lastActivity: GapActivity | null;
}
interface KcCoverageRow {
  knowledgeId: string;
  thetaHat: number;
  evidenceCount: number;
  usableCount: number;
  depthMet: boolean;
  hasHighTier: boolean | null;
  hasNearThetaAnchor: boolean | null;
  formatDiverse: boolean | null;
  gapKinds: string[];
  gaps: LatticeGap[];
}
interface SubjectCoverage {
  subjectId: string;
  displayName: string | null;
  kcs: KcCoverageRow[];
}
interface CoverageLatticeResponse {
  generated_at: string;
  scan_ms: number;
  coverage_depth_threshold: number;
  near_window: number;
  cooldown_days: number;
  scope_note: string;
  subjects: SubjectCoverage[];
  totals: {
    activeKcs: number;
    kcsWithGaps: number;
    totalGaps: number;
    gapsByKind: Record<string, number>;
  };
}

const NAV: Array<{ to: string; label: string }> = [
  { to: '/admin/runs', label: 'runs' },
  { to: '/admin/cost', label: 'cost' },
  { to: '/admin/failures', label: 'failures' },
  { to: '/admin/subjects', label: 'subjects' },
  { to: '/admin/coverage-lattice', label: 'coverage' },
];

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
    return <Badge tone="neutral">未评估·空池</Badge>;
  }
  return value ? <span style={okMarkStyle}>✓</span> : <Badge tone="again">{gapLabel}</Badge>;
}

function gapTone(gapKind: string): BadgeTone {
  if (gapKind === 'frontier_zero') return 'again';
  if (gapKind === 'diagnostic') return 'coral';
  if (gapKind === 'source_quality') return 'info';
  return 'neutral';
}

// MF1/MF3 activity 注记渲染。
function GapActivityNote({
  activity,
  cooldownDays,
}: { activity: GapActivity | null; cooldownDays: number }) {
  if (!activity || activity.lastActivityAt === null) {
    return <span style={mutedMetaStyle}>无派发记录</span>;
  }
  const now = Date.now();
  return (
    <span style={mutedMetaStyle}>
      {activity.lastStatus ?? 'activity'} · {daysAgo(activity.lastActivityAt, now)}
      {activity.inCooldown && activity.cooldownUntil && (
        <>
          {' · '}
          <span style={cooldownStyle}>cooldown→{formatTime(activity.cooldownUntil)}</span>
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
    <div style={gapRowStyle}>
      <Badge tone={gapTone(gap.gapKind)}>{gap.gapKind}</Badge>
      <div style={{ minWidth: 0 }}>
        {gap.scaffold ? (
          // frontier_zero：坐标是硬编脚手架常量，非扫描依据 → 置灰。
          <div style={scaffoldWantsStyle}>
            default scaffold · not scanned · ×{gap.desiredCount} · p{gap.priority.toFixed(2)}
          </div>
        ) : (
          <div style={wantsStyle}>
            wants: {gap.kind}/{gap.difficultyBand}/tier{gap.minSourceTier} · ×{gap.desiredCount} · p
            {gap.priority.toFixed(2)}
          </div>
        )}
        <div style={gapMetaLineStyle}>
          <GapActivityNote activity={gap.lastActivity} cooldownDays={cooldownDays} />
        </div>
      </div>
    </div>
  );
}

export function AdminCoverageLatticeSurface({ navigate }: { navigate: (to: string) => void }) {
  const queryClient = useQueryClient();
  // MF2：无 refetchInterval（刻意）。owner 用「重新扫描」按钮手动刷。
  const q = useQuery({
    queryKey: ['admin-coverage-lattice'],
    queryFn: () => apiJson<CoverageLatticeResponse>('/api/admin/coverage-lattice'),
  });
  const data = q.data;

  const link = (to: string, label: string) => (
    <a
      key={to}
      href={to}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      {label}
    </a>
  );

  return (
    <main className="page wide">
      <PageHeader
        title="Coverage Lattice"
        eyebrow="ADMIN · question supply"
        sub="覆盖 scanCoverageGaps 四规则（frontier / source-quality / diagnostic / format）的 KC 池级覆盖，非供给系统全量缺口并集（confusable 误区网另计）。每次打开跑一次实时扫描。"
      >
        <div style={linkRowStyle}>{NAV.map((n) => link(n.to, n.label))}</div>
        <Button
          variant="secondary"
          icon="refresh"
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: ['admin-coverage-lattice'] });
          }}
        >
          重新扫描
        </Button>
      </PageHeader>

      {data && (
        <div className="kpi-strip">
          <Kpi
            label="active KCs"
            value={data.totals.activeKcs}
            note={`${data.subjects.length} subjects`}
          />
          <Kpi
            label="KCs with gaps"
            value={data.totals.kcsWithGaps}
            note={data.totals.kcsWithGaps ? 'needs supply' : 'clear'}
          />
          <Kpi
            label="gaps"
            value={data.totals.totalGaps}
            note={gapKindSummary(data.totals.gapsByKind)}
          />
          <Kpi
            label="scan"
            value={`${data.scan_ms}ms`}
            note={`live · ${formatTime(data.generated_at)}`}
          />
        </div>
      )}

      <Stateful
        status={q.isLoading ? 'loading' : q.isError ? 'error' : 'ok'}
        onRetry={() => void q.refetch()}
        errorText="coverage lattice 加载失败。"
        skeleton={
          <Card pad="lg">
            <p style={mutedTextStyle}>覆盖细目扫描中...</p>
          </Card>
        }
      >
        {data && data.subjects.length === 0 && (
          <Card pad="lg">
            <Badge tone="good">no active KCs</Badge>
            <p style={mutedTextStyle}>当前无 active-goal 知识点可扫。</p>
          </Card>
        )}
        {data?.subjects.map((subject) => (
          <Card key={subject.subjectId} pad="lg">
            <div style={sectionHeadStyle}>
              <h2 style={sectionTitleStyle}>{subject.displayName ?? subject.subjectId}</h2>
              <Badge tone="neutral">
                {subject.kcs.filter((k) => k.gaps.length > 0).length} / {subject.kcs.length} with
                gaps
              </Badge>
            </div>
            <div style={tableWrapStyle}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>KC</th>
                    <th style={thStyle}>depth</th>
                    <th style={thStyle}>src</th>
                    <th style={thStyle}>diag</th>
                    <th style={thStyle}>fmt</th>
                    <th style={thStyle}>θ̂</th>
                    <th style={thStyle}>ev</th>
                    <th style={thStyle}>gaps</th>
                  </tr>
                </thead>
                <tbody>
                  {subject.kcs.map((kc) => (
                    <tr key={kc.knowledgeId}>
                      <td style={tdStyle}>
                        <code>{kc.knowledgeId}</code>
                        {kc.gaps.length > 0 && (
                          <div style={gapListStyle}>
                            {kc.gaps.map((gap) => (
                              <GapRow
                                key={gap.fingerprint}
                                gap={gap}
                                cooldownDays={data.cooldown_days}
                              />
                            ))}
                          </div>
                        )}
                      </td>
                      <td style={tdStyle}>
                        {kc.depthMet ? (
                          <span style={okMarkStyle}>
                            {kc.usableCount}/{data.coverage_depth_threshold}
                          </span>
                        ) : (
                          <Badge tone="again">
                            {kc.usableCount}/{data.coverage_depth_threshold}
                          </Badge>
                        )}
                      </td>
                      <td style={tdStyle}>{verdictCell(kc.hasHighTier, 'gap')}</td>
                      <td style={tdStyle}>{verdictCell(kc.hasNearThetaAnchor, 'gap')}</td>
                      <td style={tdStyle}>{verdictCell(kc.formatDiverse, 'gap')}</td>
                      <td style={tdStyle}>{kc.thetaHat.toFixed(2)}</td>
                      <td style={tdStyle}>{kc.evidenceCount}</td>
                      <td style={tdStyle}>{kc.gaps.length || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))}
      </Stateful>
    </main>
  );
}

function Kpi({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-num">{value}</div>
      {note && <div className="kpi-trend">{note}</div>}
    </div>
  );
}

function gapKindSummary(byKind: Record<string, number>): string {
  const entries = Object.entries(byKind);
  if (entries.length === 0) return 'none';
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}:${n}`)
    .join(' · ');
}

// Style authority = the sibling admin chrome（镜像 observability.tsx / subjects.tsx inline tokens）。
const linkRowStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
};
const sectionHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 'var(--s-3)',
  marginBottom: 'var(--s-3)',
};
const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-serif)',
  fontSize: 20,
  fontWeight: 500,
  letterSpacing: 'var(--ls-tight)',
};
const tableWrapStyle: CSSProperties = { overflowX: 'auto' };
const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '0 10px 8px 0',
  color: 'var(--ink-4)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
  fontWeight: 500,
};
const tdStyle: CSSProperties = {
  borderTop: '1px solid var(--line-soft)',
  padding: '10px 10px 10px 0',
  verticalAlign: 'top',
  color: 'var(--ink-2)',
};
const okMarkStyle: CSSProperties = { color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' };
const gapListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  marginTop: 8,
};
const gapRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, max-content) minmax(0, 1fr)',
  gap: 10,
  alignItems: 'start',
};
const wantsStyle: CSSProperties = {
  color: 'var(--ink-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  overflowWrap: 'anywhere',
};
const scaffoldWantsStyle: CSSProperties = {
  ...wantsStyle,
  color: 'var(--ink-4)',
  fontStyle: 'italic',
};
const gapMetaLineStyle: CSSProperties = { marginTop: 2 };
const mutedMetaStyle: CSSProperties = {
  color: 'var(--ink-4)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
};
const cooldownStyle: CSSProperties = { color: 'var(--coral)' };
const mutedTextStyle: CSSProperties = {
  margin: 0,
  color: 'var(--ink-3)',
  fontSize: 13,
  lineHeight: 1.55,
};
