'use client';

import { Button } from '@/ui/primitives/Button';

type Rating = 'again' | 'hard' | 'good';

export interface RatingAdvisorAdvice {
  rating: Rating | null;
  reason: string;
  evidence_score: number | null;
}

export interface RatingAdvisorProps {
  advice: RatingAdvisorAdvice | null;
  error: string | null;
  loading: boolean;
  disabled?: boolean;
  onRequest: () => void;
}

const ADVICE_LABEL: Record<Rating, string> = {
  again: '不会',
  hard: '模糊',
  good: '会了',
};

const ADVICE_TONE: Record<Rating, string> = {
  again: 'again',
  hard: 'hard',
  good: 'good',
};

export function RatingAdvisor({
  advice,
  error,
  loading,
  disabled = false,
  onRequest,
}: RatingAdvisorProps) {
  const rating = advice?.rating ?? null;
  const score =
    typeof advice?.evidence_score === 'number'
      ? `${Math.round(advice.evidence_score * 100)}%`
      : null;

  return (
    <section
      className={`rating-advisor${rating ? ` rating-advisor--${ADVICE_TONE[rating]}` : ''}`}
      aria-label="AI 评分建议"
    >
      <div className="rating-advisor__head">
        <div>
          <div className="label-mono">AI 评分建议</div>
          <p className="rating-advisor__copy">
            {advice
              ? '建议已生成。最终评分仍以你点选的档位为准。'
              : '先让 AI 看一眼你的答案，再按你的判断点选最终评分。'}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onRequest} disabled={disabled || loading}>
          {loading ? '生成中…' : advice ? '重新建议' : '生成建议'}
        </Button>
      </div>

      {advice && (
        <div className="rating-advisor__result">
          <span className={`rating-advisor__badge ${rating ? ADVICE_TONE[rating] : 'neutral'}`}>
            {rating ? ADVICE_LABEL[rating] : '无建议'}
          </span>
          {score && <span className="rating-advisor__score">score {score}</span>}
          <p className="rating-advisor__reason">{advice.reason}</p>
        </div>
      )}

      {error && <p className="rating-advisor__error">{error}</p>}
    </section>
  );
}
