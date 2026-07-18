export interface SessionTransitionRequestOptions {
  keepalive?: boolean;
}

/** Small, token-agnostic PATCH body shared by session lifecycle clients. */
export function buildSessionTransitionRequest(
  status: string,
  options: SessionTransitionRequestOptions = {},
): RequestInit {
  return {
    method: 'PATCH',
    body: JSON.stringify({ status }),
    ...(options.keepalive ? { keepalive: true } : {}),
  };
}
