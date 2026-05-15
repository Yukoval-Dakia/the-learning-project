import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { StatusBadge } from '@/ui/primitives/StatusBadge';

interface HealthPayload {
  ok: boolean;
  db_ok: boolean;
  db_error?: { code: string; message: string };
}

async function getHealth(): Promise<HealthPayload> {
  try {
    // Use absolute URL for server-side fetch — falls back to localhost dev port
    const base = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000';
    const res = await fetch(`${base}/api/health`, {
      next: { revalidate: 0 }, // always fresh
    });
    return res.json() as Promise<HealthPayload>;
  } catch {
    return {
      ok: false,
      db_ok: false,
      db_error: { code: 'fetch_error', message: 'Could not reach health endpoint' },
    };
  }
}

export const dynamic = 'force-dynamic';

export default async function HealthPage() {
  const health = await getHealth();
  const overallStatus = health.ok && health.db_ok ? 'done' : 'failed';
  const dbStatus = health.db_ok ? 'done' : 'failed';

  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--paper)',
        padding: '36px 28px',
        maxWidth: 680,
        margin: '0 auto',
      }}
    >
      <PageHeader title="Loom · 状态" eyebrow="health check" sub="服务与数据库存活探针" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
        {/* Overall */}
        <Card pad="lg">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <h3
                style={{
                  margin: 0,
                  fontFamily: 'var(--font-sans)',
                  fontSize: 'var(--fs-h4)',
                  fontWeight: 600,
                  color: 'var(--ink)',
                }}
              >
                服务总体
              </h3>
              <p
                style={{
                  margin: '4px 0 0',
                  fontSize: 'var(--fs-caption)',
                  color: 'var(--ink-3)',
                }}
              >
                {health.ok ? '所有系统正常' : '存在异常，请检查'}
              </p>
            </div>
            <StatusBadge status={overallStatus} />
          </div>
        </Card>

        {/* DB */}
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--fs-meta)',
                  color: 'var(--ink-4)',
                  letterSpacing: 'var(--ls-wide)',
                  display: 'block',
                  marginBottom: 4,
                }}
              >
                数据库
              </span>
              <span style={{ fontSize: 'var(--fs-body)', color: 'var(--ink-2)' }}>
                Postgres · Drizzle ORM
              </span>
            </div>
            <StatusBadge status={dbStatus} />
          </div>

          {health.db_error && (
            <div
              style={{
                marginTop: 'var(--s-2)',
                padding: 'var(--s-3) var(--s-4)',
                background: 'var(--again-soft)',
                border: '1px solid var(--again-line)',
                borderRadius: 'var(--r-2)',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-meta)',
                color: 'var(--again-ink)',
              }}
            >
              <code>
                {health.db_error.code}: {health.db_error.message}
              </code>
            </div>
          )}
        </Card>

        {/* Endpoint link */}
        <p
          style={{
            fontSize: 'var(--fs-meta)',
            color: 'var(--ink-4)',
            fontFamily: 'var(--font-mono)',
            letterSpacing: 'var(--ls-wide)',
          }}
        >
          JSON:{' '}
          <a href="/api/health" style={{ color: 'var(--coral)' }}>
            /api/health
          </a>
        </p>
      </div>
    </main>
  );
}
