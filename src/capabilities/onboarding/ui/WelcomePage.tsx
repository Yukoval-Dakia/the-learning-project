// Leanings order the probe. Pace caps its length. Neither feeds theta or p(L).
// Stage is declaredStage on the goal, a curriculum constraint for supply, never a theta prior.
// The scope hint does not invent a count. scopeKnowledgeIds come from the create response.

import { useMemo, useRef, useState } from 'react';
import { createSubjectErrorText, useCreateSubject } from '@/ui/hooks/useCreateSubject';
import { useSubjects } from '@/ui/hooks/useSubjects';
import { listSubjectChoices } from '@/ui/lib/subject';
import { BrandMark } from '@/ui/primitives/BrandMark';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { ObSteps } from './ObSteps';
import { useGoalClient } from './placement-client';
import './onboarding.css';

// Chips are read inside the component. A module-level list would freeze before subject hydration.
// Stage ids are DeclaredStage. Labels stay learner-facing copy.
const STAGES = [
  { id: 'middle_school', label: '初中' },
  { id: 'high_school', label: '高中' },
  { id: 'university', label: '大学' },
  { id: 'custom', label: '自定义' },
] as const;
type StageId = (typeof STAGES)[number]['id'];
const PACES = [
  { id: 'light', label: '轻', sub: '≈10 分钟 / 天' },
  { id: 'medium', label: '适中', sub: '≈20 分钟 / 天' },
  { id: 'dense', label: '密集', sub: '≈40 分钟 / 天' },
] as const;
const UNCONFIGURED_SUBJECT_HELP = '标为“未配置学科”的选项暂不可选择；请先完成学科配置。';

export interface WelcomePageProps {
  navigate: (to: string) => void;
}

export default function WelcomePage({ navigate }: WelcomePageProps) {
  const { createGoal } = useGoalClient();
  // Same rows as the chips, so a custom subject appears without a reload.
  const { subjects: subjectRows } = useSubjects();
  const SUBJECTS = listSubjectChoices(subjectRows);
  const LEANINGS = SUBJECTS;
  const hasUnconfiguredSubjects = SUBJECTS.some(
    (subject) => subject.configurationStatus === 'unconfigured',
  );
  // The choice projection drops isGeneralFallback. Join the raw rows. Only true gets the badge.
  const generalFallbackIds = useMemo(
    () => new Set(subjectRows.filter((r) => r.isGeneralFallback === true).map((r) => r.id)),
    [subjectRows],
  );
  // Leanings and pace size and order the probe. Stage is stored on the goal. None of them feed theta.
  const [stage, setStage] = useState<StageId | null>(null);
  const [leanings, setLeanings] = useState<string[]>([]);
  const [pace, setPace] = useState<string>('medium');
  const [goal, setGoal] = useState('');
  const [subject, setSubject] = useState<string | null>(null);
  // empty is a missing title. generic is any create failure. An empty scope is allowed, so it is not its own error.
  const [err, setErr] = useState<false | 'empty' | 'generic'>(false);
  const [submitting, setSubmitting] = useState(false);

  const togLean = (id: string) =>
    setLeanings((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const goalReady = goal.trim().length >= 2;

  // Both forks create the goal first.
  const proceed = async (route: string) => {
    if (!goalReady) {
      setErr('empty');
      return;
    }
    if (submitting) return;
    setErr(false);
    setSubmitting(true);
    try {
      // declaredStage persists on the goal for supply. It is optional.
      const created = await createGoal({
        title: goal.trim(),
        subjectId: subject,
        declaredStage: stage,
      });
      // Leanings and pace travel as query params. They order and size the probe. They do not feed theta.
      const params = new URLSearchParams();
      params.set('goal', created.id);
      if (leanings.length > 0) params.set('leanings', leanings.join(','));
      params.set('pace', pace);
      const sep = route.includes('?') ? '&' : '?';
      navigate(`${route}${sep}${params.toString()}`);
    } catch {
      // An empty scope is allowed, so every failure stays generic.
      setErr('generic');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page ob-welcome">
      <ObSteps active="welcome" />
      <div className="ob-hero ob-rise">
        <div className="ob-hero-mark">
          <BrandMark size={36} />
        </div>
        <div>
          <h1 className="ob-hero-title serif">先认识一下你</h1>
          <p className="ob-hero-sub">
            带上你的材料，我为你备一套个人化的练习。 只问两件事——你大概在什么阶段，和你想学什么。
          </p>
        </div>
      </div>

      <LoomCard pad padLg className="ob-rise">
        {/* 自述 · §6 Q1 轻 */}
        <div className="ob-field">
          <div className="ob-field-head">
            <span className="ob-field-q">
              <span className="ob-q-no">01</span>你大概在哪个阶段？
            </span>
            <span className="ob-field-opt">· 轻引导，可跳过</span>
          </div>
          <fieldset
            className="ob-pick"
            aria-label="学习阶段"
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          >
            {STAGES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`ob-pick-btn${stage === s.id ? ' is-on' : ''}`}
                aria-pressed={stage === s.id}
                onClick={() => setStage(s.id)}
              >
                <div className="ob-pick-l">{s.label}</div>
              </button>
            ))}
          </fieldset>
          <div className="ob-field-hint">学科倾向（可多选 · 仅用于排序起始题，不限制目标）：</div>
          <fieldset
            className="ob-subjects"
            aria-label="学科倾向"
            style={{ border: 0, padding: 0, margin: '8px 0 0', minWidth: 0 }}
          >
            {LEANINGS.map((l) => (
              <button
                key={l.id}
                type="button"
                className={`chip${leanings.includes(l.id) ? ' is-on' : ''}`}
                aria-pressed={leanings.includes(l.id)}
                disabled={l.configurationStatus === 'unconfigured'}
                aria-describedby={
                  l.configurationStatus === 'unconfigured'
                    ? 'onboarding-leanings-unconfigured-help'
                    : undefined
                }
                onClick={() => togLean(l.id)}
              >
                {leanings.includes(l.id) && <LoomIcon name="check" size={12} />}
                {l.label}
              </button>
            ))}
          </fieldset>
          {hasUnconfiguredSubjects ? (
            <p id="onboarding-leanings-unconfigured-help" className="ob-field-hint">
              {UNCONFIGURED_SUBJECT_HELP}
            </p>
          ) : null}
          <div className="ob-field-hint">每天大概投入：</div>
          <fieldset
            className="ob-pick"
            aria-label="每日投入"
            style={{
              border: 0,
              padding: 0,
              margin: '8px 0 0',
              minWidth: 0,
              gridTemplateColumns: 'repeat(3, 1fr)',
            }}
          >
            {PACES.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`ob-pick-btn${pace === p.id ? ' is-on' : ''}`}
                aria-pressed={pace === p.id}
                onClick={() => setPace(p.id)}
              >
                <div className="ob-pick-l">{p.label}</div>
                <div className="ob-pick-s">{p.sub}</div>
              </button>
            ))}
          </fieldset>
        </div>

        {/* 目标 · 核心 */}
        <div className="ob-field" style={{ marginBottom: 0 }}>
          <div className="ob-field-head">
            <span className="ob-field-q">
              <span className="ob-q-no">02</span>你想学什么？
            </span>
          </div>
          <div className="ob-goal-box">
            <div className="composer">
              <textarea
                rows={2}
                value={goal}
                placeholder="用一句话说说目标——比如「把高中文言文虚词和句式啃下来」"
                onChange={(e) => {
                  setGoal(e.target.value);
                  setErr(false);
                }}
                aria-label="学习目标"
              />
            </div>
          </div>
          <fieldset
            className="ob-subjects"
            aria-label="目标学科视角"
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          >
            <span className="ob-subjects-lbl">学科视角（可选）：</span>
            {SUBJECTS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`chip${subject === s.id ? ' is-on' : ''}`}
                aria-pressed={subject === s.id}
                disabled={s.configurationStatus === 'unconfigured'}
                aria-describedby={
                  s.configurationStatus === 'unconfigured'
                    ? 'onboarding-subjects-unconfigured-help'
                    : undefined
                }
                onClick={() => setSubject(subject === s.id ? null : s.id)}
              >
                {subject === s.id && <LoomIcon name="check" size={12} />}
                {s.label}
                {generalFallbackIds.has(s.id) && (
                  <span
                    className="ob-chip-badge"
                    title="AI 以通用人格教此科目——编辑该科目任一配置后自动消失"
                    aria-label="通用模式：AI 以通用人格教此科目——编辑该科目任一配置后自动消失"
                  >
                    通用
                  </span>
                )}
              </button>
            ))}
            <CreateSubjectChip onCreated={(id) => setSubject(id)} />
          </fieldset>
          {hasUnconfiguredSubjects ? (
            <p id="onboarding-subjects-unconfigured-help" className="ob-field-hint">
              {UNCONFIGURED_SUBJECT_HELP}
            </p>
          ) : null}
          {goalReady && err === false && (
            <div className="ob-scope-note">
              <LoomIcon name="knowledge" size={13} />
              已圈定范围 · 提交后由 scopeKnowledgeIds 定位
            </div>
          )}
          {err === 'empty' && (
            <div className="ob-inline-err">
              <LoomIcon name="alert" size={14} />
              先写一句你想学什么，我才好圈定范围。
            </div>
          )}
          {err === 'generic' && (
            <div className="ob-inline-err">
              <LoomIcon name="alert" size={14} />
              出了点问题，没能保存目标。稍后再试，或直接上传材料。
            </div>
          )}
        </div>
      </LoomCard>

      {/* 分叉 */}
      <div style={{ marginTop: 'var(--s-5)' }} className="ob-rise">
        <div className="ob-field-head">
          <span className="ob-field-q">怎么开始？</span>
        </div>
        <div className="ob-fork">
          <button
            type="button"
            className="ob-fork-card is-primary"
            disabled={!goalReady || submitting}
            onClick={() => void proceed('/onboarding/upload')}
          >
            <div className="ob-fork-ic">
              <LoomIcon name="record" size={20} />
            </div>
            <div className="ob-fork-t">上传我的材料</div>
            <div className="ob-fork-d">
              错题本 / 卷子 / 课本题——拍照或拖入，AI 抽题入池。这是最贴合你的一条路。
            </div>
            <span className="ob-fork-go">
              去上传 <LoomIcon name="arrow" size={14} />
            </span>
          </button>
          <button
            type="button"
            className="ob-fork-card"
            disabled={!goalReady || submitting}
            onClick={() => void proceed('/placement')}
          >
            <div className="ob-fork-ic">
              <LoomIcon name="layers" size={20} />
            </div>
            <div className="ob-fork-t">从起始集开始</div>
            <div className="ob-fork-d">
              手头没有材料？用该学科的起始题直接进定位练习，之后随时再补自己的材料。
            </div>
            <span className="ob-fork-go">
              用起始集 <LoomIcon name="arrow" size={14} />
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

// Collapse uses the form container. An input blur would unmount the confirm button before its click.
// A pending submit does not collapse. The server owns idempotency and name clashes. This UI does not dedupe.

export interface CreateSubjectFormProps {
  name: string;
  onName: (value: string) => void;
  onSubmit: () => void;
  isPending: boolean;
  /** Learner-facing create error. null means none. */
  error: string | null;
}

export function CreateSubjectForm({
  name,
  onName,
  onSubmit,
  isPending,
  error,
}: CreateSubjectFormProps) {
  return (
    <>
      <input
        className="ob-new-subject-input"
        value={name}
        placeholder="科目名，如：化学"
        maxLength={32}
        // biome-ignore lint/a11y/noAutofocus: 展开即输入是该 inline 入口的设计意图（doc §1.1）
        autoFocus
        readOnly={isPending}
        aria-label="新科目名"
        onChange={(e) => onName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit();
        }}
      />
      <button
        type="button"
        className="chip is-on"
        disabled={isPending || name.trim().length === 0}
        onClick={onSubmit}
      >
        {isPending ? '创建中…' : '创建'}
      </button>
      {error !== null && (
        <span className="ob-inline-err ob-new-subject-err">
          <LoomIcon name="alert" size={13} />
          {error}
        </span>
      )}
    </>
  );
}

export function CreateSubjectChip({ onCreated }: { onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const mutation = useCreateSubject();
  const boxRef = useRef<HTMLSpanElement | null>(null);

  const close = () => {
    setOpen(false);
    mutation.reset();
  };
  const submit = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || mutation.isPending) return;
    mutation.mutate(trimmed, {
      onSuccess: (created) => {
        // Selecting a typed name happens now. The chip appears after the provider refreshes.
        onCreated(created.id);
        setName('');
        close();
      },
    });
  };

  if (!open) {
    return (
      <button type="button" className="chip ob-new-subject" onClick={() => setOpen(true)}>
        + 新科目
      </button>
    );
  }
  return (
    <span
      ref={boxRef}
      className="ob-new-subject-form"
      onBlur={(e) => {
        if (mutation.isPending) return;
        const next = e.relatedTarget;
        if (next instanceof Node && boxRef.current?.contains(next)) return;
        close();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      <CreateSubjectForm
        name={name}
        onName={(value) => {
          setName(value);
          if (mutation.isError) mutation.reset();
        }}
        onSubmit={submit}
        isPending={mutation.isPending}
        error={mutation.isError ? createSubjectErrorText(mutation.error) : null}
      />
    </span>
  );
}
