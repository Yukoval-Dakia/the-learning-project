export type VerificationBadgeStatus =
  | 'not_required'
  | 'not_started'
  | 'pending'
  | 'queued'
  | 'verified'
  | 'needs_review'
  | 'failed'
  | 'outdated';

export interface VerificationBadgeIssue {
  section_id: string | null;
  severity: 'info' | 'warn' | 'error';
  category: string;
  message: string;
}

interface VerificationBadgeProps {
  status: VerificationBadgeStatus;
  summary?: string | null;
  issues?: VerificationBadgeIssue[];
}

const STATUS_META: Record<
  VerificationBadgeStatus,
  { label: string; tone: 'neutral' | 'info' | 'good' | 'warn' | 'again'; description: string }
> = {
  not_required: {
    label: '无需验证',
    tone: 'neutral',
    description: '这类 artifact 当前不需要 NoteVerifyTask。',
  },
  not_started: {
    label: '待验证',
    tone: 'info',
    description: '内容已生成，等待进入验证队列。',
  },
  pending: {
    label: '待验证',
    tone: 'info',
    description: '内容已生成，等待进入验证队列。',
  },
  queued: {
    label: '验证中',
    tone: 'info',
    description: 'NoteVerifyTask 已排队或正在执行。',
  },
  verified: {
    label: '已验证',
    tone: 'good',
    description: 'AI 二次检查通过，未发现需要阻塞阅读的问题。',
  },
  needs_review: {
    label: '需复核',
    tone: 'warn',
    description: 'AI 二次检查发现疑点，建议先看 issues。',
  },
  failed: {
    label: '验证失败',
    tone: 'again',
    description: '验证任务失败或输出不可用，不能把这条 note 当作已核内容。',
  },
  outdated: {
    label: '已过期',
    tone: 'warn',
    description: '内容在上次验证后发生变化，需要重新验证。',
  },
};

export function VerificationBadge({ status, summary, issues = [] }: VerificationBadgeProps) {
  const meta = STATUS_META[status];
  const issueCount = issues.length;

  return (
    <details className={`verification-badge verification-badge--${meta.tone}`} data-status={status}>
      <summary className="verification-badge__summary">
        <span className="verification-badge__dot" aria-hidden="true" />
        <span>{meta.label}</span>
        {issueCount > 0 && <span className="verification-badge__count">{issueCount}</span>}
      </summary>
      <div className="verification-badge__panel">
        <p>{meta.description}</p>
        {summary && <p className="verification-badge__report">{summary}</p>}
        {issueCount > 0 && (
          <ul className="verification-badge__issues">
            {issues.map((issue, idx) => (
              <li key={`${issue.section_id ?? 'global'}-${idx}`}>
                <span className={`verification-badge__severity ${issue.severity}`}>
                  {issue.severity}
                </span>
                <span className="verification-badge__category">{issue.category}</span>
                <p>{issue.message}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
