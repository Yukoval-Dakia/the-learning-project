// YUK-604 — live learner entry for the existing Learning Intent planner.
// A plan waits for the learner in the shared proposal inbox. With auto-apply on, a plan on knowledge
// that already exists applies by itself; one that needs new knowledge still waits there.
// YUK-1713 — M3E presentation (learning-intent.css; ui-next Button / Chip, lucide). The topic
// state, Enter-to-submit form, trim + pending guard, disabled rules, error reset on edit and
// the /inbox targets are unchanged.

import { useMutation } from '@tanstack/react-query';
import { ArrowRight, RefreshCw, Sparkles, Target } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Button, Chip } from '@/ui-next/public';
import { createLearningIntentProposal } from './learning-intent-api';
import './learning-intent.css';

export interface LearningIntentComposerProps {
  initialTopic?: string;
  pendingCount?: number;
  /** Proposals apply by themselves right now. Unknown reads as off: it never promises too much. */
  autoApplyEnabled?: boolean;
  createProposal?: typeof createLearningIntentProposal;
  navigate: (to: string) => void;
}

export function LearningIntentComposer({
  initialTopic = '',
  pendingCount = 0,
  autoApplyEnabled = false,
  createProposal = createLearningIntentProposal,
  navigate,
}: LearningIntentComposerProps) {
  const [topic, setTopic] = useState(initialTopic);
  const mutation = useMutation({
    mutationFn: (nextTopic: string) => createProposal(nextTopic),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = topic.trim();
    if (!normalized || mutation.isPending) return;
    mutation.mutate(normalized);
  };

  const plan = mutation.data;
  const appliesItself = autoApplyEnabled && plan?.plan_case === '3c_existing_graph';

  return (
    <section className="li-intent un-m3e-bridge">
      <h2 className="un-today-section-title">下一条学习主线</h2>
      <div className="li-intent-card">
        <div className="li-intent-copy">
          <span className="li-intent-ic" aria-hidden="true">
            <Target size={18} />
          </span>
          <div>
            <h3 className="li-intent-title">把“我想学什么”拆成可执行路径</h3>
            <p className="li-intent-help">
              {autoApplyEnabled
                ? 'AI 先生成主线与原子学习项。知识点都已经有的，会自动创建学习项和配套笔记；要新建知识点的，等你在收件箱确认。'
                : 'AI 先生成主线与原子学习项；只有你在收件箱确认后，才会创建学习项和配套笔记。'}
            </p>
          </div>
        </div>

        {pendingCount > 0 && !plan ? (
          <div className="li-intent-existing">
            <p>已有 {pendingCount} 条学习路径等待你确认。先处理现有提议，再生成下一条主线。</p>
            <Button variant="secondary" onClick={() => navigate('/inbox')}>
              去收件箱
              <ArrowRight size={16} aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <form className="li-intent-form" onSubmit={submit}>
            <label className="un-sr-only" htmlFor="learning-intent-topic">
              想学习的主题
            </label>
            <input
              id="learning-intent-topic"
              className="li-intent-input"
              value={topic}
              maxLength={120}
              placeholder="例如：系统掌握概率论"
              disabled={mutation.isPending || Boolean(plan)}
              onChange={(event) => {
                setTopic(event.target.value);
                if (mutation.isError) mutation.reset();
              }}
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={!topic.trim() || mutation.isPending || Boolean(plan)}
            >
              {mutation.isPending ? (
                <RefreshCw size={16} aria-hidden="true" />
              ) : (
                <Sparkles size={16} aria-hidden="true" />
              )}
              {mutation.isPending ? '正在生成…' : '生成学习路径'}
            </Button>
          </form>
        )}

        {mutation.isError && (
          <p className="li-intent-error" role="alert">
            学习路径暂时没有生成，请稍后重试。你的现有目标和学习数据没有变化。
          </p>
        )}

        {plan && (
          <div className="li-intent-preview" aria-live="polite">
            <div className="li-intent-preview-head">
              <div>
                <p className="li-intent-kicker">
                  {appliesItself ? '马上会创建的主线' : '待你确认的主线'}
                </p>
                <p className="li-intent-hub">{plan.hub.title}</p>
              </div>
              <Chip tone="positive">已生成提议</Chip>
            </div>
            <p className="li-intent-summary">{plan.hub.summary_md}</p>
            <ol className="li-intent-steps">
              {plan.atomics.map((item) => (
                <li key={`${item.title}:${item.one_line_intent}`}>
                  <b>{item.title}</b>
                  <span>{item.one_line_intent}</span>
                </li>
              ))}
              {plan.longs.map((item) => (
                <li key={`${item.title}:${item.one_line_intent}`} className="is-long">
                  <b>{item.title}</b>
                  <span>{item.one_line_intent}</span>
                </li>
              ))}
            </ol>
            <div className="li-intent-actions">
              <p className="li-intent-help">
                {appliesItself
                  ? '约一分钟内会自动创建，不用确认，可以到收件箱查看和撤销。没创建成的会留在收件箱等你确认。'
                  : '确认前不会改动知识图或学习项。'}
              </p>
              <Button variant="primary" onClick={() => navigate('/inbox')}>
                {appliesItself ? '去收件箱看看' : '去收件箱确认'}
                <ArrowRight size={16} aria-hidden="true" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
