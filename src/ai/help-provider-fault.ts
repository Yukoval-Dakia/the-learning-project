// Proven help/copilot faults only: a root HTTP 429 or 502 bound the same way as
// a 400, or a typed parse signal. Error strings are not evidence.

export type HelpProviderFault =
  | { readonly kind: 'quota'; readonly httpStatus: 429 }
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
  '回到题面，把已知条件和它问的东西各划一遍，然后只写下一步。这一步不调用模型。';

export function isHelpProviderFault(value: unknown): value is HelpProviderFault {
  if (!value || typeof value !== 'object') return false;
  const record = value as { kind?: unknown; httpStatus?: unknown };
  if (record.kind === 'parse') return true;
  if (record.kind === 'quota') return record.httpStatus === 429;
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
}): HelpProviderFault | undefined {
  if (isHelpProviderFault(msg.help_provider_fault)) return msg.help_provider_fault;
  if (msg.subtype === 'error_max_structured_output_retries') return { kind: 'parse' };
  if (msg.subtype === 'success' && msg.is_error === true) {
    return helpProviderFaultFromStatus(msg.api_error_status);
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
  };
  if (isHelpProviderFault(record.helpProviderFault)) return record.helpProviderFault;
  if (isHelpProviderFault(record.help_provider_fault)) return record.help_provider_fault;
  if (record.subtype === 'typed_contract_violation') return { kind: 'parse' };
  if (record.subtype === 'error_max_structured_output_retries') return { kind: 'parse' };
  if (record.subtype === 'api_error_result') {
    return helpProviderFaultFromStatus(
      typeof record.apiErrorStatus === 'number' ? record.apiErrorStatus : undefined,
    );
  }
  return undefined;
}

export function helpExitCopy(fault: HelpProviderFault): HelpExitCopy {
  if (fault.kind === 'quota') {
    return {
      reason: '模型额度已用完（429）。这次没有新的计划、提案或知识。',
      stopRetryGuidance: '请停止重试。额度恢复前，再发同样的请求还会立刻失败。',
      deterministicPractice: DETERMINISTIC_PRACTICE,
    };
  }
  if (fault.kind === 'bad_gateway') {
    return {
      reason: '模型服务返回了 502。这次没有新的计划、提案或知识。',
      stopRetryGuidance: '请停止重试。网关故障时，重复请求补不上这次没生成的内容。',
      deterministicPractice: DETERMINISTIC_PRACTICE,
    };
  }
  return {
    reason: '模型返回的内容无法按约定读出。这次没有新的计划、提案或知识。',
    stopRetryGuidance: '请停止重试。同样的请求还会得到读不出来的结果。',
    deterministicPractice: DETERMINISTIC_PRACTICE,
  };
}

export function helpFinishReason(fault: HelpProviderFault): HelpFinishReason {
  if (fault.kind === 'quota') return 'help_quota';
  if (fault.kind === 'bad_gateway') return 'help_bad_gateway';
  return 'help_parse';
}

/** Reason, stop-retry, and a deterministic step. The continue line is for a sealed reply. */
export function helpExitLead(fault: HelpProviderFault): string {
  const copy = helpExitCopy(fault);
  return [
    copy.reason,
    '',
    '停止重试',
    copy.stopRetryGuidance,
    '',
    '确定性练习',
    copy.deterministicPractice,
  ].join('\n');
}

export function renderHelpExitMarkdown(fault: HelpProviderFault): string {
  return [
    helpExitLead(fault),
    '',
    '下一步',
    '可以在这次对话里接着说明卡在哪一步。这次不会自动再请求模型。',
  ].join('\n');
}
