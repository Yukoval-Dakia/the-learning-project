// U7 (YUK-203) — read-only /admin/subjects surface (Editable Profile Studio MVP).
//
// This is a PURE-READ React Server Component (no 'use client'). It reads the
// SubjectRegistry directly (zero round-trip; the registry has no DB dependency) and
// renders a SLIM, non-sensitive subset of each profile — id / displayName / version
// / notation / capability count — NOT the full profile blob (R11 over-exposure).
//
// It BORROWS the visual shell of the sibling observability surface (`page wide` +
// PageHeader + Card) but NOT its data flow: observability.tsx is a 'use client' +
// TanStack-Query surface hitting /api/admin/*; this surface stays a pure-read RSC
// off the registry (Q6 / Cross-统合 S2). Do not copy that file wholesale — it would
// wrongly drag in 'use client' + a non-existent API call.
//
// ── RL5 — admin WRITES are forbidden on the page route ──────────────────────────
// This surface is READ-ONLY. Any FUTURE write to a SubjectProfile MUST go through
// `/api/admin/*` (which inherits the `x-internal-token` middleware gate); it must
// NOT be implemented as a page Server Action. The middleware matcher only covers
// `/api/:path*`, so a page-route Server Action would bypass the entire trust
// boundary and run unauthenticated (spec §9a:379-384).
//
// ── S3 — TokenGate is NOT a server guard ────────────────────────────────────────
// The inherited (admin)-layout `TokenGate` is a CLIENT-SIDE localStorage render
// gate, not a server-enforced auth check; the middleware matcher only covers
// `/api/:path*`, so this page route renders with no server token (spec §9a:374-377).
// A slim, non-sensitive read straight off the registry is acceptable here — but any
// SENSITIVE read or any WRITE must move behind `/api/admin/*` (RL5). Do not mistake
// the client gate for server protection.
//
// ── RL4 — read-only is SCHEDULING, not field immutability ───────────────────────
// There is no Studio write *entry point* yet — that is a scheduling decision, NOT a
// policy that SubjectProfile fields are fixed/immutable. High-impact edits remain
// "allowed but strongly gated" (spec §0); nothing here implies a field cannot change.

import { getDefaultSubjectRegistry } from '@/subjects/profile';
import { Badge } from '@/ui/primitives/Badge';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import Link from 'next/link';
import type { CSSProperties } from 'react';

// Slim, non-sensitive projection (extends the existing SlimSubjectProfile shape with
// version + a capability count; R11 — no promptFragments / noteTemplate /
// causeCategories detail crosses to the client).
interface SlimSubjectRow {
  id: string;
  displayName: string;
  version: string;
  notation: string | null;
  capabilityCount: number;
}

function toSlimRow(
  profile: ReturnType<ReturnType<typeof getDefaultSubjectRegistry>['listProfiles']>[number],
): SlimSubjectRow {
  return {
    id: profile.id,
    displayName: profile.displayName,
    version: profile.version,
    notation: profile.renderConfig.notation,
    capabilityCount: profile.judgeCapabilities.length,
  };
}

export function AdminSubjectsSurface() {
  const rows = getDefaultSubjectRegistry().listProfiles().map(toSlimRow);

  return (
    <main className="page wide">
      <PageHeader
        title="Subjects"
        eyebrow="ADMIN · profile registry"
        sub="已编译 SubjectProfile 的只读视图（id / 名称 / 版本 / notation / 能力数）。编辑入口尚未排期，写操作未来走 /api/admin/*。"
      >
        <div style={linkRowStyle}>
          <Link href="/admin/runs">runs</Link>
          <Link href="/admin/cost">cost</Link>
          <Link href="/admin/failures">failures</Link>
        </div>
      </PageHeader>

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
    </main>
  );
}

// Style authority = the legacy admin chrome (no loom稿 for Subjects; plan §7.1).
// Mirrors src/ui/admin/observability.tsx's inline token-based table styles.
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
