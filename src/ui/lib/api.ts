// API client — adds x-internal-token (from localStorage) to every /api call.
// Plan Step 8 (1c.2) will layer a Token-gate dialog over this; for now the
// helper just throws ApiAuthError when the token is missing or rejected.

export const TOKEN_STORAGE_KEY = 'loom_internal_token';
const AUTH_REQUIRED_MESSAGE = '访问令牌已失效，请重新输入。';

type AuthInvalidationListener = (message: string) => void;
const authInvalidationListeners = new Set<AuthInvalidationListener>();

export class ApiAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiAuthError';
  }
}

export class ApiError extends Error {
  status: number;
  code: string | undefined;
  /**
   * 响应 body 的结构化附加字段（error/message 之外的原样保留）。YUK-601（UI design
   * doc v1.1 owner review P1）：CAS 409 携 currentRevision、fan-out 422 携 issues
   * ——没有它们 UI 的 409 分流（stale refetch vs 撞名直出）实现不了。
   */
  details: Record<string, unknown>;
  constructor(message: string, status: number, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details ?? {};
  }
}

export function getInternalToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setInternalToken(token: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function subscribeAuthInvalidation(listener: AuthInvalidationListener): () => void {
  authInvalidationListeners.add(listener);
  return () => authInvalidationListeners.delete(listener);
}

export function clearInternalToken(message = AUTH_REQUIRED_MESSAGE): void {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
  for (const listener of authInvalidationListeners) listener(message);
}

/** 验证候选 token，不写 localStorage；只有 200 后 TokenGate 才持久化并进入应用。 */
export async function validateInternalToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new ApiAuthError('请输入访问令牌。');
  const res = await fetch('/api/auth/check', {
    method: 'GET',
    headers: { 'x-internal-token': trimmed },
    cache: 'no-store',
  });
  if (res.status === 401) throw new ApiAuthError('访问令牌无效，请重新输入。');
  if (!res.ok) {
    throw new ApiError('暂时无法验证访问令牌，请稍后重试。', res.status);
  }
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getInternalToken();
  if (!token) throw new ApiAuthError('未设置 internal token');
  const headers = new Headers(init.headers);
  headers.set('x-internal-token', token);
  if (!headers.has('content-type') && init.body && typeof init.body === 'string') {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    clearInternalToken('访问令牌无效，请重新输入。');
    throw new ApiAuthError('token 无效或已过期');
  }
  if (!res.ok) {
    let code: string | undefined;
    let message = `${res.status} ${res.statusText}`;
    let details: Record<string, unknown> = {};
    try {
      const body = (await res.clone().json()) as Record<string, unknown> & {
        error?: string;
        message?: string;
      };
      if (body.error) code = body.error;
      if (body.message) message = body.message;
      const { error: _e, message: _m, ...rest } = body;
      details = rest;
    } catch {
      // ignore JSON parse errors; keep status-line message
    }
    throw new ApiError(message, res.status, code, details);
  }
  return res;
}

export async function apiJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(input, init);
  return res.json() as Promise<T>;
}
