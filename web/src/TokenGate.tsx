// M0 (YUK-313) 单用户 token 门；YUK-624 补齐服务端验证、401 re-gate 与可操作表单。

import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState, useSyncExternalStore } from 'react';
import {
  ApiAuthError,
  clearInternalToken,
  getInternalToken,
  setInternalToken,
  subscribeAuthInvalidation,
  validateInternalToken,
} from '@/ui/lib/api';
import { Button } from '@/ui/primitives/Button';

type GateState = 'checking' | 'gate' | 'authed';

interface GateSnapshot {
  state: GateState;
  error: string | null;
  pending: boolean;
  /** 每次鉴权失效 +1；表单按它重挂，从而清空输入框。 */
  epoch: number;
}

// SSR 与 hydration 首帧一律 checking，服务端不读 token。
const SERVER_SNAPSHOT: GateSnapshot = { state: 'checking', error: null, pending: false, epoch: 0 };

function validationErrorMessage(error: unknown): string {
  if (error instanceof ApiAuthError) return error.message;
  return '暂时无法验证访问令牌，请检查服务后重试。';
}

// YUK-1483 — 每个 TokenGate 实例持有一个门控 owner（SPA main.tsx 与 Start
// workbench-shell 各一个，绑各自的 QueryClient）。首个订阅接上 api.ts 的鉴权失效
// 通道并开始校验已存 token；最后一个订阅离开时退订。`generation` 每次失效 +1，
// 失效之前发出的已存 token 校验即使晚到 200 也不再放行。
function createGateOwner(queryClient: QueryClient) {
  let snapshot = SERVER_SNAPSHOT;
  const listeners = new Set<() => void>();
  let stopInvalidation: (() => void) | null = null;
  let started = false;
  let generation = 0;

  const update = (patch: Partial<GateSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };

  const onInvalidated = (message: string) => {
    generation += 1;
    void queryClient.cancelQueries();
    queryClient.clear();
    update({ state: 'gate', error: message, pending: false, epoch: snapshot.epoch + 1 });
  };

  const validateStoredToken = () => {
    const storedToken = getInternalToken();
    if (!storedToken) {
      update({ state: 'gate' });
      return;
    }
    const issuedAt = generation;
    validateInternalToken(storedToken).then(
      () => {
        if (issuedAt === generation) update({ state: 'authed' });
      },
      (err: unknown) => {
        if (issuedAt !== generation) return;
        if (err instanceof ApiAuthError) {
          clearInternalToken(err.message);
          // 失效通知已到本 owner 时 generation 已变；否则在这里补上回到门。
          if (issuedAt === generation) onInvalidated(err.message);
          return;
        }
        update({ state: 'gate', error: validationErrorMessage(err) });
      },
    );
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      stopInvalidation ??= subscribeAuthInvalidation(onInvalidated);
      if (!started) {
        started = true;
        validateStoredToken();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && stopInvalidation) {
          stopInvalidation();
          stopInvalidation = null;
        }
      };
    },
    /** 提交候选 token：先服务端验证，200 后才写 localStorage 并进入应用。 */
    submit: async (candidate: string) => {
      if (snapshot.pending) return;
      update({ pending: true, error: null });
      try {
        await validateInternalToken(candidate);
        setInternalToken(candidate);
        // 新 token 已生效：作废仍在路上的旧 token 校验。
        generation += 1;
        update({ state: 'authed', pending: false });
      } catch (err) {
        if (err instanceof ApiAuthError) clearInternalToken(err.message);
        update({ error: validationErrorMessage(err), pending: false });
      }
    },
  };
}

type GateOwner = ReturnType<typeof createGateOwner>;

export function TokenGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [owner] = useState(() => createGateOwner(queryClient));
  const { state, error, pending, epoch } = useSyncExternalStore(
    owner.subscribe,
    owner.getSnapshot,
    () => SERVER_SNAPSHOT,
  );

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

  return <TokenForm key={epoch} owner={owner} error={error} pending={pending} />;
}

function TokenForm({
  owner,
  error,
  pending,
}: {
  owner: GateOwner;
  error: string | null;
  pending: boolean;
}) {
  const [draft, setDraft] = useState('');

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = draft.trim();
    if (!candidate || pending) return;
    void owner.submit(candidate);
  };

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
          className="field-input"
          style={{ marginTop: 6, boxSizing: 'border-box' }}
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
