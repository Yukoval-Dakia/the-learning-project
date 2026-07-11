// API client — adds x-internal-token (from localStorage) to every /api call.
// Plan Step 8 (1c.2) will layer a Token-gate dialog over this; for now the
// helper just throws ApiAuthError when the token is missing or rejected.

export const TOKEN_STORAGE_KEY = 'loom_internal_token';

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

export function clearInternalToken(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
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
    clearInternalToken();
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
