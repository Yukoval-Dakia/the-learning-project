'use client';

import { ApiAuthError, clearInternalToken } from '@/ui/lib/api';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useEffect } from 'react';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (error instanceof ApiAuthError) {
      clearInternalToken();
    }
    console.error('[app/error.tsx]', error);
  }, [error]);

  const isAuth = error instanceof ApiAuthError;

  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--paper)',
        padding: '40px 24px',
        maxWidth: 'var(--cap-prose, 560px)',
        margin: '0 auto',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      <PageHeader
        title={isAuth ? '需要重新输入 token' : '页面出错了'}
        eyebrow={isAuth ? 'unauthorized' : 'error'}
        sub={isAuth ? '清除 token 后请刷新重新登录。' : error.message}
      />

      <Card pad="lg">
        <p style={{ margin: 0, fontSize: 'var(--fs-body)', color: 'var(--ink-2)' }}>
          {isAuth ? 'token 无效或已过期。' : '前端渲染抛出了未捕获的异常。可以重试当前页面。'}
        </p>
        {!isAuth && error.digest && (
          <p style={{ marginTop: 'var(--s-2)', ...digestStyle }}>digest: {error.digest}</p>
        )}
        <div style={{ marginTop: 'var(--s-4)', display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={() => (isAuth ? window.location.reload() : reset())}>
            {isAuth ? '刷新重新输入' : '重试'}
          </Button>
        </div>
      </Card>
    </main>
  );
}

const digestStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-4)',
  letterSpacing: 'var(--ls-wide)',
};
