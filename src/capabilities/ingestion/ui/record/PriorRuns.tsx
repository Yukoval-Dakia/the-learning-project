import { AgentLines } from './AgentLines';
import { RUN_WORDS, whenWords } from './record-copy';
import type { PriorRun } from './recording-model';

function runLine(run: PriorRun, now: number): string {
  const at = Date.parse(run.at);
  const when = Number.isFinite(at) ? whenWords(at, now) : '时间没记下';
  const n = run.items.length;
  return [when, RUN_WORDS[run.state] ?? '', n > 0 ? `${n} 道题` : '题目没有留下记录']
    .filter(Boolean)
    .join(' · ');
}

/**
 * Earlier runs of the same recording, folded away under one quiet line. Each keeps its own
 * questions and asks exactly as that run left them; nothing here mixes into the latest run.
 */
export function PriorRuns({
  sessionId,
  runs,
  onHoverPage,
}: {
  sessionId: string;
  runs: PriorRun[];
  onHoverPage: (page: number | null) => void;
}) {
  if (runs.length === 0) return null;
  const now = Date.now();
  return (
    <details className="rc-prior">
      <summary className="rc-prior-sum">之前还跑过 {runs.length} 次</summary>
      <ol className="rc-prior-runs">
        {runs.map((run, i) => (
          <li key={run.ref ?? `v1-${i}`} className="rc-prior-run">
            <p className="rc-prior-head">{runLine(run, now)}</p>
            <AgentLines
              sessionId={sessionId}
              items={run.items}
              asks={run.asks}
              onHoverPage={onHoverPage}
            />
          </li>
        ))}
      </ol>
    </details>
  );
}
