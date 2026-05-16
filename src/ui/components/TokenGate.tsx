'use client';

import { getInternalToken, setInternalToken } from '@/ui/lib/api';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { type ReactNode, useEffect, useState } from 'react';

type GateState = 'loading' | 'gate' | 'authed';

export function TokenGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>('loading');
  const [input, setInput] = useState('');

  useEffect(() => {
    setState(getInternalToken() ? 'authed' : 'gate');
  }, []);

  if (state === 'loading') return null;
  if (state === 'authed') return <>{children}</>;

  const onSave = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setInternalToken(trimmed);
    setState('authed');
  };

  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--paper)',
        padding: '40px 24px',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
      }}
    >
      <div style={{ maxWidth: 460, width: '100%' }}>
        <PageHeader
          title="设置 Internal Token"
          eyebrow="setup"
          sub="一次性配置；保存在本地浏览器 localStorage 内。"
        />
        <Card pad="lg">
          <label
            htmlFor="token-input"
            style={{
              fontSize: 'var(--fs-meta)',
              color: 'var(--ink-3)',
              fontFamily: 'var(--font-mono)',
              letterSpacing: 'var(--ls-wide)',
              display: 'block',
              marginBottom: 'var(--s-2)',
            }}
          >
            INTERNAL_TOKEN
          </label>
          <input
            id="token-input"
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSave();
            }}
            autoComplete="off"
            placeholder="从 .env.local 复制 INTERNAL_TOKEN 值"
            style={{
              width: '100%',
              padding: '10px 12px',
              fontSize: 'var(--fs-body)',
              fontFamily: 'var(--font-mono)',
              background: 'var(--paper-sunk)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--r-2)',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ marginTop: 'var(--s-4)', display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={onSave} disabled={!input.trim()}>
              保存
            </Button>
          </div>
          <p
            style={{
              marginTop: 'var(--s-3)',
              fontSize: 'var(--fs-caption)',
              color: 'var(--ink-4)',
              lineHeight: 'var(--lh-prose)',
            }}
          >
            UI 调用 /api/* 时会自动带上这个 token。token 不会上传到服务器以外的地方。
          </p>
        </Card>
      </div>
    </main>
  );
}
