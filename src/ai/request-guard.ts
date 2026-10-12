import type { Context, Usage } from '@earendil-works/pi-ai';

/** Optional caller-owned admission at EVERY Pi wire request, after context assembly.
 * No credentials cross this contract. Omitted callers keep existing behavior. */
export interface ModelRequestGuard {
  beforeToolCall(call: { name: string; args: unknown }): void;
  beforeRequest(input: {
    provider: string;
    model: string;
    baseUrl: string;
    contextWindow: number;
    context: Context;
  }): Promise<{
    maxOutputTokens: number;
    settle(usage: Usage | undefined): Promise<void>;
  }>;
}
