// M0 (YUK-313) 单用户 token 门；YUK-624 补齐服务端验证、401 re-gate 与可操作表单。
import {
  ApiAuthError,
  clearInternalToken,
  getInternalToken,
  setInternalToken,
  subscribeAuthInvalidation,
  validateInternalToken,
} from '@/ui/lib/api';
import { Button } from '@/ui/primitives/Button';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';

type GateState = 'checking' | 'gate' | 'authed';

function validationErrorMessage(error: unknown): string {
  if (error instanceof ApiAuthError) return error.message;
  return '暂时无法验证访问令牌，请检查服务后重试。';
}

export function TokenGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<GateState>('checking');
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribeAuthInvalidation((message) => {
      void queryClient.cancelQueries();
      queryClient.clear();
      setDraft('');
      setPending(false);
      setError(message);
      setState('gate');
    });

    const storedToken = getInternalToken();
    if (!storedToken) {
      setState('gate');
      return unsubscribe;
    }

    void validateInternalToken(storedToken)
      .then(() => {
        if (!cancelled) setState('authed');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiAuthError) {
          clearInternalToken(err.message);
          return;
        }
        setError(validationErrorMessage(err));
        setState('gate');
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [queryClient]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = draft.trim();
    if (!candidate || pending) return;
    setPending(true);
    setError(null);
    try {
      await validateInternalToken(candidate);
      setInternalToken(candidate);
      setDraft('');
      setState('authed');
    } catch (err) {
      if (err instanceof ApiAuthError) clearInternalToken(err.message);
      setError(validationErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  if (state === 'authed') return <>{children}</>;

  if (state === 'checking') {
    return (
      <main className="page view" style={{ maxWidth: 420, margin: '15vh auto' }} aria-busy="true">
        <h1 className="page-title serif">Loom</h1>
        <output className="page-lead" style={{ display: 'block' }}>
          正在验证已保存的访问令牌…
        </output>
      </main>
    );
  }

  return (
    <main className="page view" style={{ maxWidth: 420, margin: '15vh auto' }}>
      <h1 className="page-title serif">Loom</h1>
      <p className="page-lead">输入访问令牌继续。验证通过后，仅保存在此浏览器。</p>
      <form onSubmit={submit} aria-busy={pending}>
        <label htmlFor="loom-internal-token" className="meta" style={{ display: 'block' }}>
          访问令牌
        </label>
        <input
          id="loom-internal-token"
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoComplete="off"
          disabled={pending}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'token-gate-error' : undefined}
          placeholder="粘贴访问令牌"
          style={{ width: '100%', padding: 10, marginTop: 6, boxSizing: 'border-box' }}
        />
        {error && (
          <p id="token-gate-error" role="alert" style={{ color: 'var(--again)', marginTop: 8 }}>
            {error}
          </p>
        )}
        <Button
          type="submit"
          disabled={!draft.trim() || pending}
          style={{ width: '100%', marginTop: 12 }}
        >
          {pending ? '正在验证…' : '进入 Loom'}
        </Button>
      </form>
    </main>
  );
}
