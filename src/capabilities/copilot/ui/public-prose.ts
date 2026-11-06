/** Public-channel text is independent of authoritative replies and tool receipts. */
export type PublicProseFailureKind =
  | 'provider_rejected'
  | 'rate_limited'
  | 'provider_error'
  | 'timeout'
  | 'connection'
  | 'execution_failed'
  | 'finalization_failed'
  | 'cancelled'
  | 'execution_unknown';

const FAILURE_KINDS: readonly PublicProseFailureKind[] = [
  'provider_rejected',
  'rate_limited',
  'provider_error',
  'timeout',
  'connection',
  'execution_failed',
  'finalization_failed',
  'cancelled',
  'execution_unknown',
];

export interface PublicProse {
  version: 1;
  text: string;
  status: 'streaming' | 'completed' | 'interrupted' | 'failed';
  last_event_id: number;
  failure?: {
    kind: PublicProseFailureKind;
    /** Provider HTTP status bound to the failing request (100..599). */
    http_status?: number;
    /** The provider's own Retry-After in whole seconds; absent when it sent none. */
    retry_after_seconds?: number;
  };
}

function isFailureKind(value: unknown): value is PublicProseFailureKind {
  return FAILURE_KINDS.includes(value as PublicProseFailureKind);
}

function parseFailure(value: unknown): PublicProse['failure'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const f = value as Record<string, unknown>;
  if (!isFailureKind(f.kind)) return undefined;
  const status = f.http_status;
  const retry = f.retry_after_seconds;
  return {
    kind: f.kind,
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? { http_status: status }
      : {}),
    ...(typeof retry === 'number' && Number.isFinite(retry) && retry >= 0
      ? { retry_after_seconds: retry }
      : {}),
  };
}

export function parsePublicProse(value: unknown): PublicProse | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (
    v.version !== 1 ||
    typeof v.text !== 'string' ||
    !['streaming', 'completed', 'interrupted', 'failed'].includes(String(v.status)) ||
    typeof v.last_event_id !== 'number' ||
    !Number.isSafeInteger(v.last_event_id) ||
    v.last_event_id < 0
  )
    return undefined;
  const failure = parseFailure(v.failure);
  return {
    version: 1,
    text: v.text,
    status: v.status as PublicProse['status'],
    last_event_id: v.last_event_id,
    ...(failure ? { failure } : {}),
  };
}

/** Snapshot replaces its covered prefix; only later unique, same-run deltas remain. */
export function mergePublicProse(
  snapshot: PublicProse,
  deltas: ReadonlyMap<number, string>,
): PublicProse {
  const suffix = [...deltas]
    .filter(([id]) => id > snapshot.last_event_id)
    .sort(([a], [b]) => a - b);
  return {
    ...snapshot,
    text: snapshot.text + suffix.map(([, text]) => text).join(''),
    last_event_id: suffix.at(-1)?.[0] ?? snapshot.last_event_id,
  };
}

/**
 * "约 40 秒" / "约 3 分钟" / "约 2 小时" for a provider's Retry-After. Rounds up, so the
 * stated wait is never shorter than the provider asked for.
 */
function retryWait(seconds: number): string {
  if (seconds < 90) return `约 ${Math.max(1, Math.ceil(seconds))} 秒`;
  if (seconds < 60 * 60) return `约 ${Math.ceil(seconds / 60)} 分钟`;
  return `约 ${Math.ceil(seconds / 3600)} 小时`;
}

/** When to try again, from the provider's own Retry-After only; never a guess. */
function retryAfterText(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) return '过一会儿再试试。';
  return `${retryWait(seconds)}后可以再试。`;
}

/** Partial text the failed run already produced stays above the status line. */
function keptText(prose: PublicProse): string {
  return prose.text ? '已生成的部分保留在上方。' : '';
}

type Failure = NonNullable<PublicProse['failure']>;

function providerFailureText(prose: PublicProse, failure: Failure): string | undefined {
  const kept = keptText(prose);
  switch (failure.kind) {
    case 'rate_limited':
      return `现在有点忙，这次没答完。${retryAfterText(failure.retry_after_seconds)}${kept}`;
    case 'provider_rejected':
      return `这次没答成，可以换个说法再试一次。${kept}`;
    case 'provider_error': {
      const wait =
        failure.retry_after_seconds === undefined
          ? ''
          : retryAfterText(failure.retry_after_seconds);
      return `服务暂时出了点问题，这次没答完。${wait}${kept}`;
    }
    case 'timeout':
      return `等得太久了，这次没答完。${kept}`;
    case 'connection':
      return `连接断了一下，这次没答完。${kept}`;
    default:
      return undefined;
  }
}

/**
 * Short label for a run that completed with its sealed help exit but still carries a provider
 * failure: the reply body is the exit copy, this only says why.
 */
export function publicProseFailureBadge(prose: PublicProse): string | undefined {
  if (prose.status !== 'completed' || !prose.failure) return undefined;
  switch (prose.failure.kind) {
    case 'rate_limited':
      return prose.failure.retry_after_seconds
        ? `现在有点忙 · ${retryWait(prose.failure.retry_after_seconds)}后可再试`
        : '现在有点忙';
    case 'provider_rejected':
      return '这次没答成';
    case 'provider_error':
      return '服务出了点问题';
    case 'timeout':
      return '等得太久了';
    case 'connection':
      return '连接断了一下';
    default:
      return undefined;
  }
}

export function publicProseStatusText(prose: PublicProse): string | undefined {
  if (prose.status === 'streaming') return '正在回复';
  if (prose.status === 'completed') return undefined;
  const provider = prose.failure ? providerFailureText(prose, prose.failure) : undefined;
  if (provider) return provider;
  switch (prose.failure?.kind) {
    case 'cancelled':
      return '回复已停止。';
    case 'execution_unknown':
      return '回复已中断，尚不能确认本次操作的最终结果。';
    case 'finalization_failed':
      return prose.text
        ? '本次回复未能完成确认，已生成的内容保留在上方。'
        : '本次回复未能完成确认。';
    case 'execution_failed':
      // A stopped or aborted run also lands here (neutral kind); don't call it a failure.
      return prose.status === 'interrupted'
        ? `回复已中断。${keptText(prose)}`
        : `回复生成失败。${keptText(prose)}`;
    default:
      return prose.status === 'interrupted' ? '回复已中断。' : '本次回复未能完成。';
  }
}
