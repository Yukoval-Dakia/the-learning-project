'use client';

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { Badge } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { CauseBadge } from '@/ui/primitives/CauseBadge';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

interface DueRow {
  id: string;
  question_id: string;
  prompt_md: string;
  reference_md: string | null;
  knowledge_ids: string[];
  fsrs_state: unknown;
}

interface MistakeRow {
  question_id: string;
  cause: {
    source?: 'user' | 'agent';
    primary_category: string;
    secondary_categories?: string[];
    user_notes: string | null;
    confidence?: number | null;
  } | null;
}

type Phase = 'answering' | 'feedback';
type Rating = 'again' | 'hard' | 'good' | 'easy';

const RATING_LABELS: Record<Rating, string> = {
  again: '不会 (1)',
  hard: '勉强 (2)',
  good: '会 (3)',
  easy: '熟练 (4)',
};

const RATING_VARIANT: Record<Rating, 'good' | 'hard' | 'coral' | 'danger'> = {
  again: 'danger',
  hard: 'hard',
  good: 'coral',
  easy: 'good',
};

export default function ReviewPage() {
  const qc = useQueryClient();

  const dueQ = useQuery({
    queryKey: ['review-due'],
    queryFn: () => apiJson<{ rows: DueRow[] }>('/api/review/due?limit=50'),
  });

  // Build a question_id -> cause map from /api/mistakes so we can surface
  // the AI cause inline after the user submits each answer.
  const causeMapQ = useQuery({
    queryKey: ['review-cause-map'],
    queryFn: async () => {
      const data = await apiJson<{ rows: MistakeRow[] }>('/api/mistakes?limit=200');
      const map = new Map<string, MistakeRow['cause']>();
      for (const r of data.rows) {
        if (!map.has(r.question_id)) map.set(r.question_id, r.cause);
      }
      return map;
    },
  });

  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('answering');
  const [answer, setAnswer] = useState('');

  const rows = dueQ.data?.rows ?? [];
  const total = rows.length;
  const current = rows[index];
  const isDone = total > 0 && index >= total;

  const submitM = useMutation({
    mutationFn: (rating: Rating) => {
      if (!current) throw new Error('no current question');
      return apiJson<{ next_due_at: number }>('/api/review/submit', {
        method: 'POST',
        body: JSON.stringify({
          mistake_id: current.question_id,
          rating,
          response_md: answer || null,
        }),
      });
    },
    onSuccess: () => {
      setIndex((i) => i + 1);
      setPhase('answering');
      setAnswer('');
      qc.invalidateQueries({ queryKey: ['review-due'] });
    },
  });

  const handleSubmit = useCallback(() => {
    if (phase !== 'answering' || !current) return;
    setPhase('feedback');
  }, [phase, current]);

  const handleRate = useCallback(
    (r: Rating) => {
      if (phase !== 'feedback' || submitM.isPending) return;
      submitM.mutate(r);
    },
    [phase, submitM],
  );

  // Keyboard: Cmd/Ctrl+Enter submits the answer; 1/2/3/4 picks the rating.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase === 'answering' && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
        return;
      }
      if (phase === 'feedback' && !submitM.isPending) {
        if (e.key === '1') handleRate('again');
        else if (e.key === '2') handleRate('hard');
        else if (e.key === '3') handleRate('good');
        else if (e.key === '4') handleRate('easy');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, submitM.isPending, handleSubmit, handleRate]);

  const cause = current ? (causeMapQ.data?.get(current.question_id) ?? null) : null;

  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--paper)',
        padding: '36px 28px',
        maxWidth: 'var(--cap-prose, 780px)',
        margin: '0 auto',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      <PageHeader
        title="复习"
        eyebrow="/review"
        sub={total === 0 ? undefined : `进度 ${Math.min(index + 1, total)} / ${total} · FSRS 队列`}
      />

      {dueQ.isLoading && (
        <Card>
          <p style={loadingStyle}>正在加载复习队列…</p>
        </Card>
      )}

      {dueQ.isError && (
        <Card>
          <p style={errorStyle}>
            {dueQ.error instanceof ApiAuthError
              ? `${dueQ.error.message} — 请重新进入页面输入 token`
              : `加载失败：${(dueQ.error as Error).message}`}
          </p>
        </Card>
      )}

      {dueQ.isSuccess && total === 0 && (
        <Card pad="lg">
          <p style={{ ...emptyStyle, margin: 0 }}>今日没有复习任务。</p>
          <p style={{ ...subEmptyStyle, marginTop: 'var(--s-2)' }}>
            新错题归因后会自动进入这里；或去{' '}
            <a href="/record" style={linkStyle}>
              /record
            </a>{' '}
            录入。
          </p>
        </Card>
      )}

      {dueQ.isSuccess && isDone && (
        <Card pad="lg">
          <p style={{ ...emptyStyle, margin: 0 }}>本轮 {total} 道全部复习完毕。</p>
          <p style={{ ...subEmptyStyle, marginTop: 'var(--s-2)' }}>
            FSRS 已根据评分更新到期时间。可以稍后再回来。
          </p>
        </Card>
      )}

      {current && !isDone && (
        <>
          <ProgressBar current={index + 1} total={total} />

          <Card pad="lg" style={{ marginTop: 'var(--s-4)' }}>
            <SectionLabel>题面</SectionLabel>
            <PreText>{current.prompt_md}</PreText>

            {current.knowledge_ids.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 'var(--s-3)' }}>
                {current.knowledge_ids.map((id) => (
                  <Badge key={id} tone="neutral">
                    {id}
                  </Badge>
                ))}
              </div>
            )}
          </Card>

          {phase === 'answering' && (
            <Card pad="lg" style={{ marginTop: 'var(--s-4)' }}>
              <SectionLabel>你的答案</SectionLabel>
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="回答完按 Cmd/Ctrl + Enter 提交（可留空，直接进入对照）"
                rows={6}
                style={textareaStyle}
              />
              <div
                style={{
                  marginTop: 'var(--s-3)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span style={hintStyle}>Cmd/Ctrl + Enter 提交</span>
                <Button onClick={handleSubmit}>提交 →</Button>
              </div>
            </Card>
          )}

          {phase === 'feedback' && (
            <>
              <Card pad="lg" style={{ marginTop: 'var(--s-4)' }}>
                <div style={splitStyle}>
                  <div style={{ minWidth: 0 }}>
                    <SectionLabel>你的答案</SectionLabel>
                    <PreText>{answer.trim() || '(空)'}</PreText>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <SectionLabel>参考答案</SectionLabel>
                    <PreText>{current.reference_md ?? '(无)'}</PreText>
                  </div>
                </div>
              </Card>

              <Card pad="lg" style={{ marginTop: 'var(--s-4)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)' }}>
                  <SectionLabel>归因</SectionLabel>
                  <CauseBadge
                    cause={
                      cause
                        ? {
                            actor_kind: cause.source === 'user' ? 'user' : 'agent',
                            primary: cause.primary_category,
                            secondary: cause.secondary_categories ?? [],
                            confidence: cause.confidence ?? null,
                          }
                        : null
                    }
                  />
                </div>
                {!cause && (
                  <p style={{ ...subEmptyStyle, marginTop: 'var(--s-2)' }}>
                    这道题暂时还没有归因记录。
                  </p>
                )}
              </Card>

              <Card pad="lg" style={{ marginTop: 'var(--s-4)' }}>
                <SectionLabel>FSRS 评分</SectionLabel>
                <div style={ratingRowStyle}>
                  {(['again', 'hard', 'good', 'easy'] as Rating[]).map((r) => (
                    <Button
                      key={r}
                      variant={RATING_VARIANT[r]}
                      onClick={() => handleRate(r)}
                      disabled={submitM.isPending}
                    >
                      {RATING_LABELS[r]}
                    </Button>
                  ))}
                </div>
                <p style={{ ...hintStyle, marginTop: 'var(--s-3)' }}>键盘 1 / 2 / 3 / 4 也行</p>
                {submitM.isError && (
                  <p style={{ ...errorStyle, marginTop: 'var(--s-2)' }}>
                    提交失败：{(submitM.error as Error).message}
                  </p>
                )}
              </Card>
            </>
          )}
        </>
      )}
    </main>
  );
}

function ProgressBar({ current, total }: { current: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((current / total) * 100);
  return (
    <div
      aria-label={`进度 ${current} / ${total}`}
      style={{
        height: 4,
        background: 'var(--paper-sunk)',
        borderRadius: 'var(--r-pill)',
        overflow: 'hidden',
        marginTop: 'var(--s-3)',
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${pct}%`,
          background: 'var(--coral)',
          transition: 'width var(--dur-base) var(--ease-out)',
        }}
      />
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-meta)',
        color: 'var(--ink-4)',
        letterSpacing: 'var(--ls-wide)',
        display: 'block',
        marginBottom: 'var(--s-2)',
      }}
    >
      {children}
    </span>
  );
}

function PreText({ children }: { children: React.ReactNode }) {
  return (
    <pre
      style={{
        margin: 0,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'var(--font-serif)',
        fontSize: 'var(--fs-body)',
        lineHeight: 'var(--lh-prose)',
        color: 'var(--ink)',
      }}
    >
      {children}
    </pre>
  );
}

const loadingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  color: 'var(--ink-3)',
};

const errorStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  color: 'var(--again-ink)',
};

const emptyStyle: React.CSSProperties = {
  fontSize: 'var(--fs-h4)',
  color: 'var(--ink-2)',
  fontFamily: 'var(--font-serif)',
};

const subEmptyStyle: React.CSSProperties = {
  fontSize: 'var(--fs-caption)',
  color: 'var(--ink-3)',
  margin: 0,
  lineHeight: 'var(--lh-prose)',
};

const linkStyle: React.CSSProperties = {
  color: 'var(--coral)',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 130,
  padding: '12px 14px',
  fontFamily: 'var(--font-serif)',
  fontSize: 'var(--fs-body)',
  lineHeight: 'var(--lh-prose)',
  background: 'var(--paper-sunk)',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-2)',
  outline: 'none',
  boxSizing: 'border-box',
  resize: 'vertical',
};

const splitStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  gap: 'var(--s-4)',
};

const hintStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-4)',
  letterSpacing: 'var(--ls-wide)',
  margin: 0,
};

const ratingRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--s-2)',
};
