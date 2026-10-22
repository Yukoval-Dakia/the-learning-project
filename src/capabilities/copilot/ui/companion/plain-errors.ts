// Learner-facing error copy. Status codes, error codes and server reasons never reach the screen;
// each known case gets a sentence that says what happened and what to do.

import { ApiAuthError, ApiError } from '@/ui/lib/api';

export const TOKEN_EXPIRED_COPY = '访问令牌已失效，请重新输入。';

/** A send (or any request) that the server refused or that failed outright. */
export function plainError(cause: unknown, fallback = '这次没有成功，稍后再试。'): string {
  if (cause instanceof ApiAuthError) return TOKEN_EXPIRED_COPY;
  if (!(cause instanceof ApiError)) return fallback;
  if (cause.code === 'copilot_backlog_full') return '前面还有请求在处理，等一会儿再发。';
  if (cause.status === 429) return '刚才发得有点快，等几秒再发。';
  if (cause.status === 401 || cause.status === 403) return TOKEN_EXPIRED_COPY;
  if (cause.status === 413) return '这条消息太长了，分成几段再发。';
  if (cause.status >= 500) return '服务暂时没有响应，稍后再试。';
  return fallback;
}

export function plainSendError(cause: unknown): string {
  return plainError(cause, '这条消息没有发出去，稍后再试。');
}

const REVERT_REFUSALS: Readonly<Record<string, string>> = {
  no_checkpoint: '这一轮没有可以撤回的改动。',
  irreversible: '这一轮里有改动已经无法撤回。',
  conflict: '这一轮之后又有新的改动，先撤回后面的那轮再试。',
  truncated: '这一轮的记录不完整，没法撤回。',
  legacy_snapshot: '这一轮是旧格式的记录，没法撤回。',
};

export function plainRevertError(cause: unknown): string {
  if (cause instanceof ApiError) {
    const refusal = cause.details?.refusal;
    if (typeof refusal === 'string' && REVERT_REFUSALS[refusal]) return REVERT_REFUSALS[refusal];
  }
  return plainError(cause, '撤回没有成功，稍后再试。');
}

/** The 202 boundary is unknown: the exact request is kept and can be replayed safely. */
export const ACCEPTANCE_UNKNOWN_COPY =
  '这条消息是否已送达还不能确认；恢复时会用原来的请求，不会重复执行。';

export const RESTORED_PENDING_COPY =
  '上次有一条消息没确认送达；恢复时会用原来的请求，不会重复执行。';

export const ANSWER_ONLY_UNAVAILABLE_COPY =
  '现在没法确认是否支持「仅用于本次回答」，这条没有发出，内容还在。';
