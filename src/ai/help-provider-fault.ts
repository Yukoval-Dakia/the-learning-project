// Proven help/copilot faults only: a root HTTP 429 or 502 bound the same way as
// a 400, or a typed parse signal. Error strings are not evidence — one narrow
// exception: telling account-level quota apart from brief 429 congestion reads
// the provider's OWN quota code words inside the sanitized failure body.

import { providerQuotaLimitSigned } from './provider-failure';

export type HelpProviderFault =
  | {
      readonly kind: 'quota';
      readonly httpStatus: 429;
      /**
       * True only when the provider's own quota/limit signature was present in
       * the bound failure body — copy may then name 额度 honestly. Absent or
       * false means an unsigned 429 (brief congestion, or evidence we cannot
       * prove) and copy must not claim quota.
       */
      readonly signed?: boolean;
    }
  | { readonly kind: 'bad_gateway'; readonly httpStatus: 502 }
  | { readonly kind: 'parse' };

export type RootBoundProviderStatus = 400 | 429 | 502;

export type HelpFinishReason = 'help_quota' | 'help_bad_gateway' | 'help_parse';

export interface HelpExitCopy {
  readonly reason: string;
  readonly stopRetryGuidance: string;
  readonly deterministicPractice: string;
}

const DETERMINISTIC_PRACTICE =
  '回到题面，把已知条件和它问的东西各划一遍，然后只写下一步。可以先自己试着写。';

/**
 * A Retry-After that cannot fit the copilot short-retry budget (the collecting
 * runner caps transient-retry waits at 15 s) names a long limit, not brief
 * congestion; copy must not tell the learner to try again in a moment.
 */
export const SHORT_RETRY_WAIT_BOUND_MS = 15_000;

/** Duration text for a provider Retry-After, rounded up so the stated wait is
 * never shorter than the provider asked for. Shared by the sealed exit and the
 * run badge so both name the same recovery time. */
export function quotaWaitDurationText(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 90) return `约 ${Math.max(1, Math.ceil(seconds))} 秒`;
  if (seconds < 60 * 60) return `约 ${Math.ceil(seconds / 60)} 分钟`;
  return `约 ${Math.ceil(seconds / 3600)} 小时`;
}

/** 「约 N后」 only when the wait outlives the short-retry bound; undefined means
 * brief congestion (or no hint) and today's copy stands. */
export function longQuotaRecoveryText(ms: number | undefined): string | undefined {
  if (ms === undefined || ms <= SHORT_RETRY_WAIT_BOUND_MS) return undefined;
  return `${quotaWaitDurationText(ms)}后`;
}

/** Wire-side variant: the public failure shape carries whole seconds. */
export function longQuotaRecoveryTextFromSeconds(seconds: number | undefined): string | undefined {
  return longQuotaRecoveryText(seconds === undefined ? undefined : seconds * 1000);
}

/** Bound provider timing the copy may reflect; absent means unknown, never zero. */
export interface HelpExitTiming {
  readonly retryAfterMs?: number;
}

export function isHelpProviderFault(value: unknown): value is HelpProviderFault {
  if (!value || typeof value !== 'object') return false;
  const record = value as { kind?: unknown; httpStatus?: unknown; signed?: unknown };
  if (record.kind === 'parse') return true;
  if (record.kind === 'quota')
    return (
      record.httpStatus === 429 &&
      (record.signed === undefined || typeof record.signed === 'boolean')
    );
  if (record.kind === 'bad_gateway') return record.httpStatus === 502;
  return false;
}

/** Statuses with a proven root-response binding. 400 stays a rejection, not a help exit. */
export function rootBoundProviderStatus(
  status: number | undefined,
): RootBoundProviderStatus | undefined {
  if (status === 400 || status === 429 || status === 502) return status;
  return undefined;
}

export function helpFaultForRootStatus(
  status: RootBoundProviderStatus,
): HelpProviderFault | undefined {
  if (status === 429) return { kind: 'quota', httpStatus: 429 };
  if (status === 502) return { kind: 'bad_gateway', httpStatus: 502 };
  return undefined;
}

export function helpProviderFaultFromStatus(
  status: number | null | undefined,
): HelpProviderFault | undefined {
  if (status === 429) return { kind: 'quota', httpStatus: 429 };
  if (status === 502) return { kind: 'bad_gateway', httpStatus: 502 };
  return undefined;
}

export function helpProviderFaultFromSdkResult(msg: {
  subtype: string;
  help_provider_fault?: unknown;
  api_error_status?: number | null;
  is_error?: boolean;
  /** Sanitized provider failure lines — where the quota signature lives. */
  errors?: readonly string[];
}): HelpProviderFault | undefined {
  if (isHelpProviderFault(msg.help_provider_fault)) return msg.help_provider_fault;
  if (msg.subtype === 'error_max_structured_output_retries') return { kind: 'parse' };
  if (msg.subtype === 'success' && msg.is_error === true) {
    const fault = helpProviderFaultFromStatus(msg.api_error_status);
    if (fault?.kind === 'quota')
      return { ...fault, signed: providerQuotaLimitSigned(msg.errors ?? []) };
    return fault;
  }
  return undefined;
}

/** Duck-typed so callers do not need the error class. */
export function readHelpProviderFault(error: unknown): HelpProviderFault | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as {
    helpProviderFault?: unknown;
    help_provider_fault?: unknown;
    subtype?: unknown;
    apiErrorStatus?: unknown;
    errors?: unknown;
  };
  if (isHelpProviderFault(record.helpProviderFault)) return record.helpProviderFault;
  if (isHelpProviderFault(record.help_provider_fault)) return record.help_provider_fault;
  if (record.subtype === 'typed_contract_violation') return { kind: 'parse' };
  if (record.subtype === 'error_max_structured_output_retries') return { kind: 'parse' };
  if (record.subtype === 'api_error_result') {
    const fault = helpProviderFaultFromStatus(
      typeof record.apiErrorStatus === 'number' ? record.apiErrorStatus : undefined,
    );
    if (fault?.kind === 'quota' && Array.isArray(record.errors))
      return {
        ...fault,
        signed: providerQuotaLimitSigned(
          record.errors.filter((entry): entry is string => typeof entry === 'string'),
        ),
      };
    return fault;
  }
  return undefined;
}

export function helpExitCopy(fault: HelpProviderFault, timing?: HelpExitTiming): HelpExitCopy {
  if (fault.kind === 'quota') {
    // Only the provider's own quota signature lets copy name 额度 — real quota
    // responses carry no Retry-After, and a long Retry-After on an unsigned
    // 429 is congestion, not quota.
    if (fault.signed === true) {
      const recovery = longQuotaRecoveryText(timing?.retryAfterMs);
      return {
        reason:
          recovery !== undefined
            ? `额度用完了，${recovery}恢复。`
            : '额度用完了，这次没能继续回答。',
        stopRetryGuidance: '恢复之前再问，还是会马上得到同样的回答。',
        deterministicPractice: DETERMINISTIC_PRACTICE,
      };
    }
    return {
      reason: '现在有点忙，这次没能继续回答。',
      stopRetryGuidance:
        timing?.retryAfterMs !== undefined && timing.retryAfterMs > 0
          ? `${quotaWaitDurationText(timing.retryAfterMs)}后再试试吧。`
          : '过一会儿再试试吧。',
      deterministicPractice: DETERMINISTIC_PRACTICE,
    };
  }
  if (fault.kind === 'bad_gateway') {
    return {
      reason: '服务暂时出了点问题。这次没有新的计划、提案或知识。',
      stopRetryGuidance: '这种时候再问一遍，也补不上这次没生成的内容。',
      deterministicPractice: DETERMINISTIC_PRACTICE,
    };
  }
  return {
    reason: '这次的内容没能读出来。这次没有新的计划、提案或知识。',
    stopRetryGuidance: '同样的问题再问一遍，还是会读不出来。',
    deterministicPractice: DETERMINISTIC_PRACTICE,
  };
}

export function helpFinishReason(fault: HelpProviderFault): HelpFinishReason {
  if (fault.kind === 'quota') return 'help_quota';
  if (fault.kind === 'bad_gateway') return 'help_bad_gateway';
  return 'help_parse';
}

/** Reason, stop-retry, and a deterministic step. The continue line is for a sealed reply. */
export function helpExitLead(fault: HelpProviderFault, timing?: HelpExitTiming): string {
  const copy = helpExitCopy(fault, timing);
  return [
    copy.reason,
    '',
    fault.kind === 'quota'
      ? fault.signed === true || longQuotaRecoveryText(timing?.retryAfterMs) !== undefined
        ? '等恢复后再试'
        : '稍后再试'
      : '先别再试',
    copy.stopRetryGuidance,
    '',
    '确定性练习',
    copy.deterministicPractice,
  ].join('\n');
}

export function renderHelpExitMarkdown(fault: HelpProviderFault, timing?: HelpExitTiming): string {
  return [
    helpExitLead(fault, timing),
    '',
    '下一步',
    '可以在这次对话里接着说明卡在哪一步。这次不会自动再试。',
  ].join('\n');
}
