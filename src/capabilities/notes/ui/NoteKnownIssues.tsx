// YUK-1772 — what the note's author left unresolved when the run ended. Nothing shows for a clean
// note: this section exists only while there are issues to read. Older rows carry a verdict too;
// it is not shown, and they are read the same way.
import { TriangleAlert } from 'lucide-react';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import type { NotePage } from './notes-api';

const CATEGORY_WORDS: Readonly<Record<string, string>> = {
  factuality: '内容准确',
  coverage: '覆盖范围',
  clarity: '讲得清楚',
  subject_fit: '学科贴合',
  format: '格式',
  safety: '安全',
};

export function NoteKnownIssues({ summary }: { summary: NotePage['verification_summary'] }) {
  if (!summary || !Array.isArray(summary.issues) || summary.issues.length === 0) return null;
  return (
    <section className="nt-issues" aria-labelledby="nt-issues-title">
      <h2 id="nt-issues-title" className="nt-issues-title">
        <TriangleAlert size={16} aria-hidden="true" />
        已知问题
      </h2>
      {summary.summary_md ? (
        <MathMarkdown className="nt-issues-summary">{summary.summary_md}</MathMarkdown>
      ) : null}
      <ul className="nt-issues-list">
        {summary.issues.map((issue) => (
          <li
            key={`${issue.category}-${issue.block_id ?? ''}-${issue.message}`}
            className="nt-issue"
          >
            <span className="nt-issue-kind">
              {CATEGORY_WORDS[issue.category] ?? issue.category}
            </span>
            <MathMarkdown className="nt-issue-text">{issue.message}</MathMarkdown>
            {issue.suggested_fix_md ? (
              <div className="nt-issue-fix">
                <span className="nt-issue-kind">建议</span>
                <MathMarkdown className="nt-issue-text">{issue.suggested_fix_md}</MathMarkdown>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
