'use client';

import { useState } from 'react';

import type { JudgeResultV2T } from '@/core/schema/capability';
import { JudgeResultPanel } from '@/ui/components/JudgeResultPanel';
import { apiFetch } from '@/ui/lib/api';

export interface SolveTutorPanelProps {
  questionId: string;
  /** expected_signals from the question's rubric_json (for JudgeResultPanel zip). */
  expectedSignals?: string[];
  notation?: 'latex' | 'wenyan' | 'plaintext' | 'code';
}

interface JudgeResponse {
  attempt_event_id: string;
  judge: {
    route: string;
    score: number | null;
    coarse_outcome: JudgeResultV2T['coarse_outcome'];
    confidence: number;
    reason_md: string;
    evidence_json: unknown;
  };
  revealed_solution_md: string | null;
  mistake_id?: string;
}

export function SolveTutorPanel({
  questionId,
  expectedSignals = [],
  notation,
}: SolveTutorPanelProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [hints, setHints] = useState<string[]>([]);
  const [result, setResult] = useState<JudgeResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/questions/${questionId}/solve`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const body = (await res.json()) as { session_id: string };
      setSessionId(body.session_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : '开练失败');
    } finally {
      setBusy(false);
    }
  }

  async function requestHint() {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/questions/${questionId}/solve/${sessionId}/hint`, {
        method: 'POST',
        body: JSON.stringify({ hint_index: hints.length }),
      });
      const body = (await res.json()) as { text_md: string };
      setHints((h) => [...h, body.text_md]);
    } catch (e) {
      setError(e instanceof Error ? e.message : '获取提示失败');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/questions/${questionId}/solve/${sessionId}/submit`, {
        method: 'POST',
        body: JSON.stringify({ student_final_answer_text: answer }),
      });
      setResult((await res.json()) as JudgeResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交失败');
    } finally {
      setBusy(false);
    }
  }

  if (!sessionId) {
    return (
      <div className="solve-tutor-panel">
        <button type="button" onClick={start} disabled={busy} className="solve-tutor-panel__start">
          开练
        </button>
        {error && <p className="solve-tutor-panel__error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="solve-tutor-panel">
      {hints.length > 0 && (
        <ol className="solve-tutor-panel__hints">
          {hints.map((h, i) => (
            <li key={`hint-${i}-${h.slice(0, 8)}`}>{h}</li>
          ))}
        </ol>
      )}
      <textarea
        className="solve-tutor-panel__answer"
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="写下你的步骤 / 最终答案"
      />
      <div className="solve-tutor-panel__actions">
        <button type="button" onClick={requestHint} disabled={busy}>
          要个提示
        </button>
        <button type="button" onClick={submit} disabled={busy || answer.trim().length === 0}>
          提交批改
        </button>
      </div>
      {error && <p className="solve-tutor-panel__error">{error}</p>}
      {result && (
        <>
          <JudgeResultPanel
            result={
              {
                score: result.judge.score,
                score_meaning: 'steps_v1_weighted',
                coarse_outcome: result.judge.coarse_outcome,
                confidence: result.judge.confidence,
                capability_ref: { id: result.judge.route, version: '1.0.0' },
                feedback_md: result.judge.reason_md,
                evidence_json: result.judge.evidence_json as JudgeResultV2T['evidence_json'],
              } as JudgeResultV2T
            }
            expectedSignals={expectedSignals}
            appealable={false}
            notation={notation}
          />
          {result.revealed_solution_md && (
            <details className="solve-tutor-panel__solution">
              <summary>查看参考解</summary>
              <div>{result.revealed_solution_md}</div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
