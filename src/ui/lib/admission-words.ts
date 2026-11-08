// Where the automatic answer check of a question stands, in one sentence the learner can act on:
// still checking (and when it tries again), or not checked and why. Shared by the record page and
// the question pages so a question held back reads the same everywhere.

export interface AdmissionFacts {
  status: 'pending' | 'admitted' | 'failed' | 'undecided';
  wait?: {
    reason: 'quota' | 'login' | 'not_sent' | 'provider';
    retry_at: string | null;
    recovery_action: 'wait_for_retry' | 'reauthenticate' | 'confirm_recovery';
  } | null;
  cause?: 'outcome_unconfirmed' | 'purpose_denied' | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 14:30 today, 明天 08:00, or 11月10日 08:00, in the viewer's own clock. */
export function retryWhen(iso: string, now: number = Date.now()): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  if (at.getTime() <= now) return '马上';
  const time = at.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const today = new Date(now);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(at) - startOf(today)) / DAY_MS);
  if (days === 0) return `约 ${time}`;
  if (days === 1) return `明天 ${time}`;
  return `${at.getMonth() + 1}月${at.getDate()}日 ${time}`;
}

const WAIT_CAUSE: Record<NonNullable<AdmissionFacts['wait']>['reason'], string> = {
  quota: '核对答案用的额度暂时用完了',
  login: '核对答案用的账号要重新登录',
  not_sent: '核对请求还没发出去',
  provider: '核对答案用的服务暂时出了问题',
};

/**
 * The sentence for a question whose check is not done, or null once it passed. Always ends by
 * saying it is not given out until the check is done, so 「已进题库」 is never read as 「能练了」.
 */
export function admissionSentence(
  admission: AdmissionFacts,
  now: number = Date.now(),
): string | null {
  if (admission.status === 'admitted') return null;
  if (admission.status === 'failed') return '两次独立解出的答案对不上，先不出给你练。';
  if (admission.status === 'undecided') {
    if (admission.cause === 'purpose_denied') {
      return '这份资料按你选的用途不能拿去核对答案，所以先不出给你练。';
    }
    if (admission.cause === 'outcome_unconfirmed') {
      return '这次核对没拿到确定的结果，不会自动重查，先不出给你练。';
    }
    return '暂时没查成，先不出给你练。';
  }
  const wait = admission.wait;
  if (!wait) return '答案还在核对，核对完才出给你练。';
  if (wait.recovery_action === 'reauthenticate') {
    return '核对答案用的账号要重新登录，登录后接着查；查完才出给你练。';
  }
  if (wait.recovery_action === 'confirm_recovery') {
    return `${WAIT_CAUSE[wait.reason]}，等确认恢复后接着查；查完才出给你练。`;
  }
  const when = wait.retry_at ? retryWhen(wait.retry_at, now) : null;
  return when
    ? `${WAIT_CAUSE[wait.reason]}，${when}${when === '马上' ? '' : ' '}再查；查完才出给你练。`
    : `${WAIT_CAUSE[wait.reason]}，恢复后接着查；查完才出给你练。`;
}
