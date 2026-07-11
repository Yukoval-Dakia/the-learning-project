// U7 (YUK-203) → M5-T4b (YUK-321) → YUK-601 (UI design doc v1.1 §2.1) —
// /admin/subjects 列表面扩列：数据源已随 §3.5 扩容（全量含 general 与 retired），
// 列 = 名称 / id / origin / 通用模式 / version 组合串 / →detail 行链接。
//
// 数据面：useQuery + apiJson('/api/admin/subjects')。渲染保持 SLIM（R11：
// promptFragments / noteTemplate / causeCategories 细节绝不过线到 client）。
//
// ── RL5 — 列表页零写按钮 ────────────────────────────────────────────────────────
// This surface is READ-ONLY. 写动作全部集中 detail 页（/admin/subjects/$id），
// 且一律经 /api/admin/*（x-internal-token gate）。design doc v1.1 §2.1 显式裁定
// 「不在列表页放任何写按钮」。
//
// 壳形态：admin 页套主 app chrome（RootShell）——决策记录见
// docs/design/2026-07-07-yuk579-coverage-lattice.md §6。

import { apiJson } from '@/ui/lib/api';
import { Badge } from '@/ui/primitives/Badge';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { Stateful } from '@/ui/primitives/Stateful';
import { useQuery } from '@tanstack/react-query';
import type { CSSProperties } from 'react';

// §3.5 管理枚举投影（字段对齐 api/admin-subjects.ts；R11 slim 红线不变）。
export interface AdminSubjectRow {
  id: string;
  displayName: string;
  origin: 'builtin' | 'custom';
  retiredAt: string | null;
  isGeneralFallback: boolean | null;
  version: string | null;
  subjectRevision: number;
  notation: string | null;
  capabilityCount: number;
}

export function AdminSubjectsSurface({ navigate }: { navigate: (to: string) => void }) {
  const q = useQuery({
    queryKey: ['admin-subjects'],
    queryFn: () => apiJson<{ subjects: AdminSubjectRow[] }>('/api/admin/subjects'),
    refetchInterval: 60_000,
  });
  const rows = q.data?.subjects ?? [];

  const link = (to: string, label: string) => (
    <a
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
        title="Subjects"
        eyebrow="ADMIN · subject control plane"
        sub="全量科目（含 general 与 retired）。行链接进 trait 编辑面；写动作全部在 detail 页经 /api/admin/*。"
      >
        <div style={linkRowStyle}>
          {link('/admin/runs', 'runs')}
          {link('/admin/cost', 'cost')}
          {link('/admin/failures', 'failures')}
          {link('/admin/subjects', 'subjects')}
          {link('/admin/coverage-lattice', 'coverage')}
        </div>
      </PageHeader>

      <Stateful
        status={q.isLoading ? 'loading' : q.isError ? 'error' : 'ok'}
        onRetry={() => void q.refetch()}
        errorText="subjects 加载失败。"
        skeleton={
          <Card pad="lg">
            <p style={mutedTextStyle}>subjects 加载中...</p>
          </Card>
        }
      >
        <Card pad="lg">
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>名称</th>
                <th style={thStyle}>id</th>
                <th style={thStyle}>origin</th>
                <th style={thStyle}>通用模式</th>
                <th style={thStyle}>版本</th>
                <th style={thStyle} aria-label="detail" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const retired = row.retiredAt !== null;
                // origin 权威枚举只有 builtin|custom；general 徽标由 id 派生
                // （owner review 一致性①）。
                const isGeneral = row.id === 'general';
                return (
                  <tr key={row.id} style={retired ? retiredRowStyle : undefined}>
                    <td style={tdStyle}>
                      {row.displayName}
                      {retired && (
                        <span style={badgeGapStyle}>
                          <Badge tone="neutral">retired</Badge>
                        </span>
                      )}
                    </td>
                    <td style={tdStyle}>
                      <code style={monoSmallStyle}>{row.id}</code>
                    </td>
                    <td style={tdStyle}>
                      <Badge tone="neutral">{isGeneral ? 'general' : row.origin}</Badge>
                    </td>
                    <td style={tdStyle}>
                      {isGeneral ? (
                        <span className="meta">—</span>
                      ) : row.isGeneralFallback === true ? (
                        <Badge tone="neutral">通用</Badge>
                      ) : null}
                    </td>
                    <td style={tdStyle}>
                      {row.version ? (
                        <span style={monoSmallStyle} title={row.version}>
                          {row.version.length > 40 ? `${row.version.slice(0, 40)}…` : row.version}
                        </span>
                      ) : (
                        <span className="meta">—</span>
                      )}
                    </td>
                    <td style={tdStyle}>{link(`/admin/subjects/${row.id}`, '→')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </Stateful>
    </main>
  );
}

// Style authority = the legacy admin chrome (no loom稿 for Subjects; plan §7.1).
// Mirrors the sibling observability.tsx's inline token-based table styles.
const linkRowStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
};

const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
};

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

const retiredRowStyle: CSSProperties = { opacity: 0.55 };

const badgeGapStyle: CSSProperties = { marginLeft: 6 };

const monoSmallStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
};

const mutedTextStyle: CSSProperties = {
  margin: 0,
  color: 'var(--ink-3)',
  fontSize: 13,
  lineHeight: 1.55,
};
