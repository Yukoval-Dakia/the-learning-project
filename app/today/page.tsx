// Placeholder for /today — the canonical home redirect target.
//
// app/page.tsx redirects '/' here. Full implementation (4 KPI / 三 lane /
// Dreaming inbox strip / cost ribbon — per v2.1 design) lands in Phase 1c.2.
// This stub exists so the root redirect doesn't 404 and so visual smoke tests
// can hit the v2.1 palette end-to-end.

import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';

export const dynamic = 'force-static';

export default function TodayPage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--paper)',
        padding: '36px 28px',
        maxWidth: 'var(--cap-prose)',
        margin: '0 auto',
      }}
    >
      <PageHeader title="Loom · Today" eyebrow="placeholder" sub="Phase 1c.2 will land 4 KPI、三 lane、Dreaming inbox 与 cost ribbon。" />

      <Card pad="lg">
        <p
          style={{
            margin: 0,
            fontSize: 'var(--fs-body)',
            color: 'var(--ink-2)',
            lineHeight: 'var(--lh-prose)',
          }}
        >
          骨架页面在位 —— 后续阶段填进真实内容。
        </p>
        <p
          style={{
            margin: 'var(--s-3) 0 0',
            fontSize: 'var(--fs-caption)',
            color: 'var(--ink-3)',
          }}
        >
          状态探针：{' '}
          <a href="/health" style={{ color: 'var(--coral)' }}>
            /health
          </a>
        </p>
      </Card>
    </main>
  );
}
