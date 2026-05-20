'use client';

import { apiJson } from '@/ui/lib/api';
import { useState } from 'react';

export interface EmbeddedCheckQuestion {
  id: string;
  kind: string;
  prompt_md: string;
  choices_md: string[] | null;
}

type EmbeddedCheckStatus = 'not_required' | 'pending' | 'ready' | 'failed';

type AttemptOutcome = 'success' | 'failure';

interface AttemptResult {
  outcome: AttemptOutcome;
  judge: {
    route: string;
    score: number | null;
    reason_md?: string;
  };
  mistake_id?: string;
}

interface EmbeddedCheckSectionProps {
  status: EmbeddedCheckStatus;
  questions: EmbeddedCheckQuestion[];
}

export function EmbeddedCheckSection({ status, questions }: EmbeddedCheckSectionProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, AttemptResult>>({});
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

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
            <p className="embedded-check-question__prompt">{question.prompt_md}</p>
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
            {currentFeedback && (
              <div className={`embedded-check-feedback outcome-${currentFeedback.outcome}`}>
                {currentFeedback.outcome === 'success' ? '答对了' : '需复习'} · score{' '}
                {currentFeedback.judge.score ?? 'n/a'}
                {currentFeedback.judge.reason_md && <p>{currentFeedback.judge.reason_md}</p>}
              </div>
            )}
            {errors[question.id] && <p className="embedded-check-error">{errors[question.id]}</p>}
          </div>
        );
      })}
    </div>
  );
}
