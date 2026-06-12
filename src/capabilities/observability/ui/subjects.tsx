// U7 (YUK-203) → M5-T4b (YUK-321) — read-only /admin/subjects surface
// (Editable Profile Studio MVP)，迁 observability 包 + SPA 化。
//
// 数据面（M5-T4b 改造）：旧版是纯 RSC 直读 SubjectRegistry；SPA 无服务端渲染，
// 改为 client 数据面——useQuery + apiJson('/api/admin/subjects')（T4 新建端点，
// 服务端做同一 slim 投影）。渲染保持 SLIM, non-sensitive subset——id /
// displayName / version / notation / capability count — NOT the full profile
// blob（R11 over-exposure：promptFragments / noteTemplate / causeCategories
// 细节绝不过线到 client）。
//
// ── RL5 — admin WRITES are forbidden on the page route ──────────────────────────
// This surface is READ-ONLY. Any FUTURE write to a SubjectProfile MUST go through
// `/api/admin/*` (which inherits the `x-internal-token` middleware gate); it must
// NOT be implemented as a page-side mutation outside that gate (spec §9a:379-384).
//
// ── S3 — 读已走 /api/admin/* token gate ─────────────────────────────────────────
// 旧版的 S3 警示（页面 RSC 渲染不受 middleware 保护）已随 SPA 化解除：本面的
// 读取现在经 /api/admin/subjects，由 x-internal-token gate 服务端强制；SPA 的
// TokenGate 仍只是 client-side localStorage render gate，不是服务端防线。
//
// ── RL4 — read-only is SCHEDULING, not field immutability ───────────────────────
// There is no Studio write *entry point* yet — that is a scheduling decision, NOT a
// policy that SubjectProfile fields are fixed/immutable. High-impact edits remain
// "allowed but strongly gated" (spec §0); nothing here implies a field cannot change.
//
// Phase-deferred（壳形态决策点）：设计真理源
// docs/design/loom-refresh/project/app.jsx:106-114 裁决「admin is a separate
// shell — no main app chrome」；与未来 SPA 收编主 chrome 存在形态决策点（见
// docs/audit/2026-06-13-visual-gap.md §5 决策点③），收编 chrome 前须 owner
// 显式拍板。本次平移仅做路由收编，不改壳形态。

import { apiJson } from '@/ui/lib/api';
import { Badge } from '@/ui/primitives/Badge';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { Stateful } from '@/ui/primitives/Stateful';
import { useQuery } from '@tanstack/react-query';
import type { CSSProperties } from 'react';

// Slim, non-sensitive projection（字段对齐 api/admin-subjects.ts 的服务端投影；
// R11 — no promptFragments / noteTemplate / causeCategories detail crosses to
// the client）。
interface SlimSubjectRow {
  id: string;
  displayName: string;
  version: string;
  notation: string | null;
  capabilityCount: number;
}

export function AdminSubjectsSurface({ navigate }: { navigate: (to: string) => void }) {
  const q = useQuery({
    queryKey: ['admin-subjects'],
    queryFn: () => apiJson<{ subjects: SlimSubjectRow[] }>('/api/admin/subjects'),
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
        eyebrow="ADMIN · profile registry"
        sub="已编译 SubjectProfile 的只读视图（id / 名称 / 版本 / notation / 能力数）。编辑入口尚未排期，写操作未来走 /api/admin/*。"
      >
        <div style={linkRowStyle}>
          {link('/admin/runs', 'runs')}
          {link('/admin/cost', 'cost')}
          {link('/admin/failures', 'failures')}
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
                <th style={thStyle}>id</th>
                <th style={thStyle}>名称</th>
                <th style={thStyle}>版本</th>
                <th style={thStyle}>notation</th>
                <th style={thStyle}>能力数</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td style={tdStyle}>
                    <code>{row.id}</code>
                  </td>
                  <td style={tdStyle}>{row.displayName}</td>
                  <td style={tdStyle}>
                    <Badge tone="neutral">{row.version}</Badge>
                  </td>
                  <td style={tdStyle}>{row.notation ?? <span className="meta">—</span>}</td>
                  <td style={tdStyle}>{row.capabilityCount}</td>
                </tr>
              ))}
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

const mutedTextStyle: CSSProperties = {
  margin: 0,
  color: 'var(--ink-3)',
  fontSize: 13,
  lineHeight: 1.55,
};
