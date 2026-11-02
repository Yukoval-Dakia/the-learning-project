// Onboarding ① · welcome / setup (YUK-473 Slice 1; M3E presentation YUK-1473,
// docs/design/2026-11-03-welcome-m3e.md). Self-report (stage / leanings / pace) is local-only and NOT
// persisted — it only hints later placement ordering (design §6). The goal
// textarea + subject chips drive the real POST /api/goals on fork click; the
// authoritative scopeKnowledgeIds come from that response, so the inline scope
// hint here is a static "已圈定范围" reassurance (we do NOT fabricate a count).

import { ArrowRight, Check, CircleAlert, Layers, Upload } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { createSubjectErrorText, useCreateSubject } from '@/ui/hooks/useCreateSubject';
import { useSubjects } from '@/ui/hooks/useSubjects';
import { listSubjectChoices } from '@/ui/lib/subject';
import { Button, ChipToggle, Mascot, Segmented, UiNextRoot } from '@/ui-next/public';
import { OnboardingSteps } from './OnboardingSteps';
import { useGoalClient } from './placement-client';
import './welcome.css';

// YUK-249 → YUK-598：subject chips 曾是模块级 const（import 期快照，provider 水合
// 后不更新——v2 §9① WelcomePage:23-24 点名的冻结 bug）。现移入组件体、行驱动
// （useSubjects：DB selectable 视图，custom 科目即时进 chips；断网退化三 builtin）。
// `leanings` 值仍是 canonical id——YUK-480 透传合同不变。
// YUK-1009 — stage ids are the canonical DeclaredStage vocabulary (POST /api/goals
// declaredStage); labels stay the learner-facing Chinese copy. The chosen id now
// persists on the created goal (goal.declared_stage) as a curriculum constraint
// consumed by question supply — still never an ability/θ̂ input.
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
  const ids = useId();
  // YUK-598 — 组件体内取行（模块级冻结修复）；SUBJECTS/LEANINGS 同源。
  const { subjects: subjectRows } = useSubjects();
  const SUBJECTS = listSubjectChoices(subjectRows);
  const LEANINGS = SUBJECTS;
  const hasUnconfiguredSubjects = SUBJECTS.some(
    (subject) => subject.configurationStatus === 'unconfigured',
  );
  // YUK-602 §1.2 — 通用模式 badge 的 flag 从原始 subjectRows 按 id join：
  // listSubjectChoices 只投影 {id,label}，isGeneralFallback 在投影里被丢弃（owner
  // review P2 点名的断链）。只认 === true（general 的 null 不挂标）。
  const generalFallbackIds = useMemo(
    () => new Set(subjectRows.filter((r) => r.isGeneralFallback === true).map((r) => r.id)),
    [subjectRows],
  );
  // 自述（轻 · 仅引导排序）。YUK-480：`leanings` + `pace` 现经 query 透传给 placement
  // 探针（leanings → 起始题排序偏好、pace → 探针题量），仅 placement session 持有；
  // 二者只影响排序/题量，绝不喂 θ̂/p(L)。YUK-1009：`stage` 不再是纯显示态——它随
  // createGoal 落库为 goal.declared_stage（学段/课程范围约束，供供给侧消费，
  // 例如 jyeoo grade 过滤）；仍绝不喂 θ̂（stage→θ 先验仍是另案 AutoElicit）。
  const [stage, setStage] = useState<StageId | null>(null);
  const [leanings, setLeanings] = useState<string[]>([]);
  const [pace, setPace] = useState<string>('medium');
  // 目标 · 核心（驱动 POST /api/goals）。
  const [goal, setGoal] = useState('');
  const [subject, setSubject] = useState<string | null>(null);
  // err: false=无错 · 'empty'=未写目标 · 'generic'=建 goal 失败（token/网络/500/校验）。
  // OCR #551：'scope' 变体已删——goal-create 不再对空 scope 报 400（冷启允许空 scope），
  // 故不存在「解析不出范围」这条；任何错都归 generic，不误导用户改目标。
  const [err, setErr] = useState<false | 'empty' | 'generic'>(false);
  const [submitting, setSubmitting] = useState(false);

  const togLean = (id: string) =>
    setLeanings((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const goalReady = goal.trim().length >= 2;

  // 分叉：primary → 上传材料 · secondary → 起始集（定位）。两条都先建 goal。
  const proceed = async (route: string) => {
    if (!goalReady) {
      setErr('empty');
      return;
    }
    if (submitting) return;
    setErr(false);
    setSubmitting(true);
    try {
      // Thread the new goal id through the flow as `?goal=<id>`: the upload screen
      // forwards it and the placement probe (Slice 3) reads it to scope the probe.
      // YUK-1009 — the self-reported stage is no longer display-only: it rides the
      // SAME create-goal mutation (declaredStage) and persists on goal.declared_stage,
      // where supply-side consumers (jyeoo grade filter) read it. Optional → nullable.
      const created = await createGoal({
        title: goal.trim(),
        subjectId: subject,
        declaredStage: stage,
      });
      // YUK-480 — also thread the self-report (leanings + pace) as query params. The placement
      // probe reads them to ORDER starter questions toward leaning subjects + size the probe by
      // pace (ordering/amount only — never θ̂). leanings appended only when non-empty; pace is
      // always present (default 'medium'). URLSearchParams handles encoding. NOTE: these are
      // existing self-report state being transported — no NEW UI element (no design pre-flight).
      const params = new URLSearchParams();
      params.set('goal', created.id);
      if (leanings.length > 0) params.set('leanings', leanings.join(','));
      params.set('pace', pace);
      const sep = route.includes('?') ? '&' : '?';
      navigate(`${route}${sep}${params.toString()}`);
    } catch {
      // goal-create 不再对空 scope 报 400（冷启允许）→ 任何失败都归 generic（不误导用户改目标）。
      setErr('generic');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <UiNextRoot className="un-ob" data-un-m3e="practice-foundation">
      <main className="un-ob-main un-m3e-bridge">
        <OnboardingSteps active="welcome" />
        <header className="un-ob-heading">
          <div>
            <h1>先认识一下你</h1>
            <p>
              带上你的材料，我为你备一套个人化的练习。只问两件事：你大概在什么阶段，和你想学什么。
            </p>
          </div>
          <Mascot />
        </header>

        {/* 自述 · §6 Q1 轻 */}
        <section className="un-ob-section" aria-labelledby={`${ids}-q1`}>
          <h2 id={`${ids}-q1`} className="un-ob-question">
            <span className="un-ob-no" aria-hidden="true">
              01
            </span>
            你大概在哪个阶段？<span className="un-ob-optional">可跳过</span>
          </h2>
          <fieldset className="un-ob-field">
            <legend className="un-sr-only">学习阶段</legend>
            <div className="un-ob-chips">
              {STAGES.map((s) => (
                <ChipToggle
                  key={s.id}
                  pressed={stage === s.id}
                  onPressedChange={() => setStage(s.id)}
                >
                  {stage === s.id && <Check size={16} aria-hidden="true" />}
                  {s.label}
                </ChipToggle>
              ))}
            </div>
          </fieldset>
          <fieldset className="un-ob-field">
            <legend className="un-ob-hint">
              学科倾向（可多选，只用来排起始题的顺序，不限制目标）
            </legend>
            <div className="un-ob-chips">
              {LEANINGS.map((l) => (
                <ChipToggle
                  key={l.id}
                  pressed={leanings.includes(l.id)}
                  onPressedChange={() => togLean(l.id)}
                  disabled={l.configurationStatus === 'unconfigured'}
                  aria-describedby={
                    l.configurationStatus === 'unconfigured' ? `${ids}-leanings-help` : undefined
                  }
                >
                  {leanings.includes(l.id) && <Check size={16} aria-hidden="true" />}
                  {l.label}
                </ChipToggle>
              ))}
            </div>
            {hasUnconfiguredSubjects ? (
              <p id={`${ids}-leanings-help`} className="un-ob-hint">
                {UNCONFIGURED_SUBJECT_HELP}
              </p>
            ) : null}
          </fieldset>
          <div className="un-ob-field">
            <p className="un-ob-hint">每天大概投入</p>
            <Segmented
              label="每日投入"
              value={pace}
              onChange={setPace}
              options={PACES.map((p) => ({
                value: p.id,
                label: (
                  <>
                    {p.label}
                    <span className="un-ob-pace-sub">{p.sub}</span>
                  </>
                ),
              }))}
            />
          </div>
        </section>

        {/* 目标 · 核心 */}
        <section className="un-ob-section" aria-labelledby={`${ids}-q2`}>
          <h2 id={`${ids}-q2`} className="un-ob-question">
            <span className="un-ob-no" aria-hidden="true">
              02
            </span>
            你想学什么？
          </h2>
          <textarea
            className="un-ob-goal"
            rows={2}
            value={goal}
            placeholder="用一句话说说目标，比如「把高中文言文虚词和句式啃下来」"
            onChange={(e) => {
              setGoal(e.target.value);
              setErr(false);
            }}
            aria-label="学习目标"
            aria-invalid={err === 'empty' || undefined}
            aria-describedby={err ? `${ids}-goal-error` : undefined}
          />
          <fieldset className="un-ob-field">
            <legend className="un-ob-hint">学科视角（可选）</legend>
            <div className="un-ob-chips">
              {SUBJECTS.map((s) => (
                <ChipToggle
                  key={s.id}
                  pressed={subject === s.id}
                  onPressedChange={() => setSubject(subject === s.id ? null : s.id)}
                  disabled={s.configurationStatus === 'unconfigured'}
                  aria-describedby={
                    s.configurationStatus === 'unconfigured' ? `${ids}-subjects-help` : undefined
                  }
                >
                  {subject === s.id && <Check size={16} aria-hidden="true" />}
                  {s.label}
                  {generalFallbackIds.has(s.id) && (
                    <span
                      className="un-ob-badge"
                      title="AI 以通用人格教此科目——编辑该科目任一配置后自动消失"
                      aria-label="通用模式：AI 以通用人格教此科目——编辑该科目任一配置后自动消失"
                    >
                      通用
                    </span>
                  )}
                </ChipToggle>
              ))}
              <CreateSubjectChip onCreated={(id) => setSubject(id)} />
            </div>
            {hasUnconfiguredSubjects ? (
              <p id={`${ids}-subjects-help`} className="un-ob-hint">
                {UNCONFIGURED_SUBJECT_HELP}
              </p>
            ) : null}
          </fieldset>
          {goalReady && err === false && (
            <p className="un-ob-note">提交后按这个目标圈定知识范围。</p>
          )}
          {err === 'empty' && (
            <p id={`${ids}-goal-error`} className="un-ob-error" role="alert">
              <CircleAlert size={16} aria-hidden="true" />
              先写一句你想学什么，我才好圈定范围。
            </p>
          )}
          {err === 'generic' && (
            <p id={`${ids}-goal-error`} className="un-ob-error" role="alert">
              <CircleAlert size={16} aria-hidden="true" />
              出了点问题，没能保存目标。稍后再试，或直接上传材料。
            </p>
          )}
        </section>

        {/* 分叉 */}
        <section className="un-ob-section" aria-labelledby={`${ids}-start`}>
          <h2 id={`${ids}-start`} className="un-ob-question">
            怎么开始？
          </h2>
          <div className="un-ob-fork">
            <button
              type="button"
              className="un-ob-fork-card"
              data-primary=""
              disabled={!goalReady || submitting}
              onClick={() => void proceed('/onboarding/upload')}
            >
              <Upload size={24} aria-hidden="true" />
              <span className="un-ob-fork-title">上传我的材料</span>
              <span className="un-ob-fork-text">
                错题本、卷子、课本题，拍照或拖进来，AI 抽题入池。这是最贴合你的一条路。
              </span>
              <span className="un-ob-fork-go">
                去上传 <ArrowRight size={16} aria-hidden="true" />
              </span>
            </button>
            <button
              type="button"
              className="un-ob-fork-card"
              disabled={!goalReady || submitting}
              onClick={() => void proceed('/placement')}
            >
              <Layers size={24} aria-hidden="true" />
              <span className="un-ob-fork-title">从起始集开始</span>
              <span className="un-ob-fork-text">
                手头没有材料？用该学科的起始题直接进定位练习，之后随时再补自己的材料。
              </span>
              <span className="un-ob-fork-go">
                用起始集 <ArrowRight size={16} aria-hidden="true" />
              </span>
            </button>
          </div>
        </section>
      </main>
    </UiNextRoot>
  );
}

// ── YUK-602 §1.1 —— 「+ 新科目」手填入口（design doc 2026-07-11，APPROVED v1.1）──
// 展示件与状态壳分离：CreateSubjectForm 纯 props（SSR 单测直渲），CreateSubjectChip
// 持展开/草稿/mutation 状态。交互红线：收起判定以整个表单容器为界（relatedTarget
// 不在容器内才收）——input 单独 blur 不收，防 blur 先于 click 卸载确认按钮吞掉提交
// （owner review P2）；提交中不收起。服务端幂等/撞名兜底，UI 零去重零归一。

export interface CreateSubjectFormProps {
  name: string;
  onName: (value: string) => void;
  onSubmit: () => void;
  isPending: boolean;
  /** 用户可读错误文案（createSubjectErrorText 产出）；null = 无错。 */
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
        className="un-ob-new-input"
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
      <Button
        size="sm"
        variant="secondary"
        disabled={isPending || name.trim().length === 0}
        onClick={onSubmit}
      >
        {isPending ? '创建中…' : '创建'}
      </Button>
      {error !== null && (
        <span className="un-ob-error" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
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
        // 手填即选中（doc §1.1）；chip 本体经 invalidate → provider 通路出现。
        onCreated(created.id);
        setName('');
        close();
      },
    });
  };

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        + 新科目
      </Button>
    );
  }
  return (
    <span
      ref={boxRef}
      className="un-ob-new-subject"
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
