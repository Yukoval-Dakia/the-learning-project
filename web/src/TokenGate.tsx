// M0 (YUK-313) — 极简 token 门：单用户不变量在 SPA 侧的最小落地。
// token 写入 localStorage（loom_internal_token），apiFetch 自动注入；
// 工作台/外壳正式形态在 M4 重建，这个门只为示踪弹与开发期使用。
import { getInternalToken, setInternalToken } from '@/ui/lib/api';
import { type ReactNode, useState } from 'react';

export function TokenGate({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => getInternalToken());
  const [draft, setDraft] = useState('');

  if (token) return <>{children}</>;
  return (
    <main className="page view" style={{ maxWidth: 420, margin: '15vh auto' }}>
      <h1 className="page-title serif">Loom</h1>
      <p className="page-lead">输入 internal token 进入（存 localStorage）。</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          setInternalToken(draft.trim());
          setToken(draft.trim());
        }}
      >
        <input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="x-internal-token"
          style={{ width: '100%', padding: 8 }}
        />
      </form>
    </main>
  );
}
