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
// 呈现：M3E 管理后台外壳（YUK-1473，docs/design/2026-11-03-admin-write-m3e.md）。

import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Chip } from '@/ui-next/public';
import { type AdminControlClient, httpAdminControlClient } from './admin-control-client';
import {
  ADMIN_LINKS_NO_CONFIG,
  AdminArea,
  AdminFrame,
  AdminHead,
  AdminNav,
  AdminPanel,
  adminAreaStatus,
} from './admin-frame';

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

/** The 通用模式 cell: general itself shows —, a fallback subject a chip, the rest nothing. */
function generalModeCell(isGeneral: boolean, isGeneralFallback: boolean | null): ReactNode {
  if (isGeneral) return <span className="adm-quiet">—</span>;
  if (isGeneralFallback === true) return <Chip>通用</Chip>;
  return null;
}

export function AdminSubjectsSurface({
  navigate,
  client = httpAdminControlClient,
}: {
  navigate: (to: string) => void;
  client?: AdminControlClient;
}) {
  const q = useQuery({
    queryKey: ['admin-subjects'],
    queryFn: () => client.getSubjects(),
    refetchInterval: 60_000,
  });
  const rows = q.data?.subjects ?? [];

  const link = (to: string, label: string) => (
    <a
      href={to}
      className="adm-row-link un-hit"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      <ChevronRight size={16} aria-hidden="true" />
    </a>
  );

  return (
    <AdminFrame>
      <AdminNav links={ADMIN_LINKS_NO_CONFIG} current="/admin/subjects" navigate={navigate} />
      <AdminHead
        kicker="ADMIN · subject control plane"
        title="学科配置"
        lead="全量科目（含 general 与 retired）。行链接进 trait 编辑面；写动作全部在 detail 页经 /api/admin/*。"
      />

      <AdminArea
        status={adminAreaStatus(q)}
        loadingLabel="subjects 加载中"
        errorText="subjects 加载失败。"
        onRetry={() => void q.refetch()}
      >
        <AdminPanel id="adm-subjects" title="全部科目" aside={<Chip>{rows.length}</Chip>} flush>
          <div className="adm-table-scroll">
            <table className="adm-table">
              <thead>
                <tr>
                  <th scope="col">名称</th>
                  <th scope="col">id</th>
                  <th scope="col">origin</th>
                  <th scope="col">通用模式</th>
                  <th scope="col">版本</th>
                  <th scope="col" aria-label="detail" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const retired = row.retiredAt !== null;
                  // origin 权威枚举只有 builtin|custom；general 徽标由 id 派生
                  // （owner review 一致性①）。
                  const isGeneral = row.id === 'general';
                  return (
                    <tr key={row.id} data-retired={retired ? '' : undefined}>
                      <td>
                        <span className="adm-subject-name">
                          <span className="adm-strong">{row.displayName}</span>
                          {retired && <Chip>retired</Chip>}
                        </span>
                      </td>
                      <td>
                        <code className="adm-mono">{row.id}</code>
                      </td>
                      <td>
                        <Chip>{isGeneral ? 'general' : row.origin}</Chip>
                      </td>
                      <td>{generalModeCell(isGeneral, row.isGeneralFallback)}</td>
                      <td>
                        {row.version ? (
                          <span className="adm-mono" title={row.version}>
                            {row.version.length > 40 ? `${row.version.slice(0, 40)}…` : row.version}
                          </span>
                        ) : (
                          <span className="adm-quiet">—</span>
                        )}
                      </td>
                      <td className="adm-num">
                        {link(`/admin/subjects/${row.id}`, `打开 ${row.displayName}`)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </AdminPanel>
      </AdminArea>
    </AdminFrame>
  );
}
