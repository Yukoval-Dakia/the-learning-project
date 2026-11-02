/** Public-channel text is independent of authoritative replies and tool receipts. */
export interface PublicProse {
  version: 1;
  text: string;
  status: 'streaming' | 'completed' | 'interrupted' | 'failed';
  last_event_id: number;
  failure?: {
    kind:
      | 'provider_rejected'
      | 'execution_failed'
      | 'finalization_failed'
      | 'cancelled'
      | 'execution_unknown';
    http_status?: 400;
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
  const rawFailure = v.failure;
  let failure: PublicProse['failure'];
  if (rawFailure && typeof rawFailure === 'object' && !Array.isArray(rawFailure)) {
    const f = rawFailure as Record<string, unknown>;
    if (
      [
        'provider_rejected',
        'execution_failed',
        'finalization_failed',
        'cancelled',
        'execution_unknown',
      ].includes(String(f.kind))
    ) {
      failure = {
        kind: f.kind as NonNullable<PublicProse['failure']>['kind'],
        ...(f.kind === 'provider_rejected' && f.http_status === 400
          ? { http_status: 400 as const }
          : {}),
      };
    }
  }
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

export function publicProseStatusText(prose: PublicProse): string | undefined {
  if (prose.status === 'streaming') return '正在回复';
  if (prose.status === 'completed') return undefined;
  switch (prose.failure?.kind) {
    case 'provider_rejected':
      return prose.failure.http_status === 400
        ? '模型服务拒绝了请求（400），具体参数原因尚未定位，本次未完成回答。'
        : '模型服务拒绝了请求，本次未完成回答。';
    case 'cancelled':
      return '回复已停止。';
    case 'execution_unknown':
      return '回复已中断，尚不能确认本次操作的最终结果。';
    case 'finalization_failed':
      return prose.text
        ? '本次回复未能完成确认，已生成的内容保留在上方。'
        : '本次回复未能完成确认。';
    case 'execution_failed':
      return '回复生成失败。';
    default:
      return prose.status === 'interrupted' ? '回复已中断。' : '本次回复未能完成。';
  }
}
