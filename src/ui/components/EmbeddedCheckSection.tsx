'use client';

import type { JudgeResultV2T } from '@/core/schema/capability';
import { apiJson } from '@/ui/lib/api';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { useState } from 'react';
import { JudgeResultPanel } from './JudgeResultPanel';

export interface EmbeddedCheckQuestion {
  id: string;
  kind: string;
  prompt_md: string;
  choices_md: string[] | null;
}

type EmbeddedCheckStatus = 'not_required' | 'pending' | 'ready' | 'failed';

type AttemptOutcome = 'success' | 'partial' | 'failure';

interface AttemptResult {
  outcome: AttemptOutcome;
  judge: {
    route: string;
    score: number | null;
    coarse_outcome?: string;
    confidence?: number;
    reason_md?: string;
    evidence_json?: Record<string, unknown>;
  };
  /** M2.3: attempt event id — used as appeal target. */
  attempt_event_id?: string;
  mistake_id?: string;
}

interface EmbeddedCheckSectionProps {
  status: EmbeddedCheckStatus;
  questions: EmbeddedCheckQuestion[];
  /** Subject's renderConfig.notation — passed through to MathMarkdown for KaTeX gating. */
  notation?: 'latex' | 'wenyan' | 'plaintext' | 'code';
}

export function EmbeddedCheckSection({ status, questions, notation }: EmbeddedCheckSectionProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, AttemptResult>>({});
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // M2.3: track which questions have been appealed (per-session optimistic UI).
  const [appealed, setAppealed] = useState<Record<string, boolean>>({});

  if (status === 'not_required') return null;

  if (status === 'pending') {
    return (
      <div className="embedded-check-section">
        <span className="embedded-check-status pending">自检题生成中…</span>
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className="embedded-check-section">
        <span className="embedded-check-status failed">自检题暂未生成（生成失败）</span>
      </div>
    );
  }

  if (questions.length === 0) {
    return (
      <div className="embedded-check-section">
        <span className="embedded-check-status pending">自检题暂未生成</span>
      </div>
    );
  }

  async function submit(question: EmbeddedCheckQuestion) {
    const answer = answers[question.id]?.trim();
    if (!answer) {
      setErrors((prev) => ({ ...prev, [question.id]: '请先作答。' }));
      return;
    }
    setSubmitting((prev) => ({ ...prev, [question.id]: true }));
    setErrors((prev) => ({ ...prev, [question.id]: '' }));
    try {
      const result = await apiJson<AttemptResult>('/api/embedded-check/attempt', {
        method: 'POST',
        body: JSON.stringify({ question_id: question.id, answer_md: answer }),
      });
      setFeedback((prev) => ({ ...prev, [question.id]: result }));
    } catch (err) {
      setErrors((prev) => ({
        ...prev,
        [question.id]: err instanceof Error ? err.message : '提交失败',
      }));
    } finally {
      setSubmitting((prev) => ({ ...prev, [question.id]: false }));
    }
  }

  return (
    <div className="embedded-check-section">
      <span className="embedded-check-status ready">自检题 · {questions.length} 题</span>
      {questions.map((question) => {
        const currentFeedback = feedback[question.id];
        const disabled = submitting[question.id] || currentFeedback !== undefined;
        return (
          <div key={question.id} className="embedded-check-question">
            <MathMarkdown notation={notation} className="embedded-check-question__prompt">
              {question.prompt_md}
            </MathMarkdown>
            {question.kind === 'choice' || question.kind === 'single_choice' ? (
              <div className="embedded-check-question__choices">
                {(question.choices_md ?? []).map((choice) => (
                  <label key={choice}>
                    <input
                      type="radio"
                      name={`embedded-check-${question.id}`}
                      value={choice}
                      checked={answers[question.id] === choice}
                      disabled={disabled}
                      onChange={() => setAnswers((prev) => ({ ...prev, [question.id]: choice }))}
                    />{' '}
                    {choice}
                  </label>
                ))}
              </div>
            ) : question.kind === 'fill_blank' ? (
              <input
                className="embedded-check-question__answer"
                value={answers[question.id] ?? ''}
                disabled={disabled}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [question.id]: e.target.value }))}
              />
            ) : (
              <textarea
                className="embedded-check-question__answer"
                rows={3}
                value={answers[question.id] ?? ''}
                disabled={disabled}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [question.id]: e.target.value }))}
              />
            )}
            <button
              type="button"
              className="embedded-check-question__submit"
              disabled={disabled}
              onClick={() => void submit(question)}
            >
              {currentFeedback ? '已提交' : submitting[question.id] ? '提交中…' : '提交'}
            </button>
            {currentFeedback &&
              (currentFeedback.judge.route === 'steps' ? (
                <JudgeResultPanel
                  result={
                    {
                      score: currentFeedback.judge.score,
                      score_meaning: 'steps_v1_weighted',
                      coarse_outcome:
                        (currentFeedback.judge.coarse_outcome as
                          | 'correct'
                          | 'partial'
                          | 'incorrect'
                          | 'unsupported') ?? 'unsupported',
                      confidence: currentFeedback.judge.confidence ?? 0,
                      capability_ref: { id: currentFeedback.judge.route, version: '1.0.0' },
                      feedback_md: currentFeedback.judge.reason_md ?? '',
                      evidence_json: currentFeedback.judge.evidence_json ?? {},
                    } as JudgeResultV2T
                  }
                  /**
                   * M2.3: signal text comes from rubric_json.reference_solution.expected_signals,
                   * which the EmbeddedCheckQuestion shape doesn't currently carry. Pass [] so
                   * JudgeResultPanel skips the per-signal list; score / outcome / route /
                   * extracted_final_answer / feedback still render. Extending the question
                   * shape with expected_signals is a follow-up.
                   */
                  expectedSignals={[]}
                  notation={notation}
                  appealable={
                    !appealed[question.id] && currentFeedback.attempt_event_id !== undefined
                  }
                  onAppeal={async () => {
                    if (!currentFeedback.attempt_event_id) return;
                    try {
                      await apiJson('/api/review/appeal', {
                        method: 'POST',
                        body: JSON.stringify({
                          judge_event_id: currentFeedback.attempt_event_id,
                          reason_md: '',
                        }),
                      });
                      setAppealed((prev) => ({ ...prev, [question.id]: true }));
                    } catch (err) {
                      setErrors((prev) => ({
                        ...prev,
                        [question.id]: err instanceof Error ? err.message : '申诉失败',
                      }));
                    }
                  }}
                />
              ) : (
                <div className={`embedded-check-feedback outcome-${currentFeedback.outcome}`}>
                  {currentFeedback.outcome === 'success'
                    ? '答对了'
                    : currentFeedback.outcome === 'partial'
                      ? '部分正确'
                      : '需复习'}{' '}
                  · score {currentFeedback.judge.score ?? 'n/a'}
                  {currentFeedback.judge.reason_md && (
                    <MathMarkdown notation={notation}>
                      {currentFeedback.judge.reason_md}
                    </MathMarkdown>
                  )}
                </div>
              ))}
            {errors[question.id] && <p className="embedded-check-error">{errors[question.id]}</p>}
          </div>
        );
      })}
    </div>
  );
}
