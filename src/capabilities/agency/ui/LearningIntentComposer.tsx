// YUK-604 — live learner entry for the existing Learning Intent planner.
// Planning creates a B-tier proposal only; the owner confirms it in the shared
// proposal inbox, where acceptance materializes the learning-item/note tree.

import { Btn } from '@/ui/primitives/Btn';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { createLearningIntentProposal } from './learning-intent-api';
import './learning-intent.css';

export interface LearningIntentComposerProps {
  initialTopic?: string;
  pendingCount?: number;
  navigate: (to: string) => void;
}

export function LearningIntentComposer({
  initialTopic = '',
  pendingCount = 0,
  navigate,
}: LearningIntentComposerProps) {
  const [topic, setTopic] = useState(initialTopic);
  const mutation = useMutation({
    mutationFn: (nextTopic: string) => createLearningIntentProposal(nextTopic),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = topic.trim();
    if (!normalized || mutation.isPending) return;
    mutation.mutate(normalized);
  };

  const plan = mutation.data;

  return (
    <section className="li-intent-section">
      <SectionLabel>下一条学习主线</SectionLabel>
      <LoomCard pad className="li-intent-card">
        <div className="li-intent-copy">
          <span className="card-icon accent">
            <LoomIcon name="target" size={18} />
          </span>
          <div>
            <div className="card-title">把“我想学什么”拆成可执行路径</div>
            <p className="meta li-intent-help">
              AI 先生成主线与原子学习项；只有你在收件箱确认后，才会创建学习项和配套笔记。
            </p>
          </div>
        </div>

        {pendingCount > 0 && !plan ? (
          <div className="li-intent-existing">
            <span>
              已有 {pendingCount} 条学习路径等待你确认。先处理现有提议，再生成下一条主线。
            </span>
            <Btn variant="secondary" iconEnd="arrow" onClick={() => navigate('/inbox')}>
              去收件箱
            </Btn>
          </div>
        ) : (
          <form className="li-intent-form" onSubmit={submit}>
            <label className="sr-only" htmlFor="learning-intent-topic">
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
            <Btn
              type="submit"
              variant="secondary"
              icon={mutation.isPending ? 'refresh' : 'sparkle'}
              disabled={!topic.trim() || mutation.isPending || Boolean(plan)}
            >
              {mutation.isPending ? '正在生成…' : '生成学习路径'}
            </Btn>
          </form>
        )}

        {mutation.isError && (
          <div className="li-intent-error" role="alert">
            学习路径暂时没有生成，请稍后重试。你的现有目标和学习数据没有变化。
          </div>
        )}

        {plan && (
          <div className="li-intent-preview" aria-live="polite">
            <div className="li-intent-preview-head">
              <div>
                <span className="meta">待你确认的主线</span>
                <div className="li-intent-hub serif">{plan.hub.title}</div>
              </div>
              <span className="badge tone-good">已生成提议</span>
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
              <span className="meta">确认前不会改动知识图或学习项。</span>
              <Btn variant="good" iconEnd="arrow" onClick={() => navigate('/inbox')}>
                去收件箱确认
              </Btn>
            </div>
          </div>
        )}
      </LoomCard>
    </section>
  );
}
