// Onboarding ① · welcome / setup (YUK-473 Slice 1).
// Ported from docs/design/loom-refresh/project/screen-onboarding.jsx
// (ScreenWelcome). Self-report (stage / leanings / pace) is local-only and NOT
// persisted — it only hints later placement ordering (design §6). The goal
// textarea + subject chips drive the real POST /api/goals on fork click; the
// authoritative scopeKnowledgeIds come from that response, so the inline scope
// hint here is a static "已圈定范围" reassurance (we do NOT fabricate a count).

import { BrandMark } from '@/ui/primitives/BrandMark';
import { Btn } from '@/ui/primitives/Btn';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useState } from 'react';
import { ObSteps } from './ObSteps';
import { createGoal } from './onboarding-api';
import './onboarding.css';

// Inlined from docs/design/loom-refresh/project/data-onboarding.jsx (OB.*).
const SUBJECTS = [
  { id: 'wenyan', name: '文言文' },
  { id: 'math', name: '数学' },
  { id: 'physics', name: '物理' },
] as const;
const STAGES = ['初中', '高中', '大学', '自定义'] as const;
const LEANINGS = [
  { id: 'wenyan', label: '文言文' },
  { id: 'math', label: '数学' },
  { id: 'physics', label: '物理' },
  { id: 'english', label: '英语' },
] as const;
const PACES = [
  { id: 'light', label: '轻', sub: '≈10 分钟 / 天' },
  { id: 'medium', label: '适中', sub: '≈20 分钟 / 天' },
  { id: 'dense', label: '密集', sub: '≈40 分钟 / 天' },
] as const;

export interface WelcomePageProps {
  navigate: (to: string) => void;
}

export default function WelcomePage({ navigate }: WelcomePageProps) {
  // 自述（轻 · 不落库，仅引导排序）。
  const [stage, setStage] = useState<string | null>(null);
  const [leanings, setLeanings] = useState<string[]>([]);
  const [pace, setPace] = useState<string>('medium');
  // 目标 · 核心（驱动 POST /api/goals）。
  const [goal, setGoal] = useState('');
  const [subject, setSubject] = useState<string | null>(null);
  // err: false=无错 · 'empty'=未写目标 · 'scope'=后端解析不出范围（400）。
  const [err, setErr] = useState<false | 'empty' | 'scope'>(false);
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
      await createGoal({ title: goal.trim(), subjectId: subject });
      navigate(route);
    } catch {
      // 后端解析不出可用范围（400）或其它失败：换说法或直接上传。
      setErr('scope');
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
          <div className="ob-pick">
            {STAGES.map((s) => (
              <button
                key={s}
                type="button"
                className={`ob-pick-btn${stage === s ? ' is-on' : ''}`}
                onClick={() => setStage(s)}
              >
                <div className="ob-pick-l">{s}</div>
              </button>
            ))}
          </div>
          <div className="ob-field-hint">学科倾向（可多选 · 仅用于排序起始题，不限制目标）：</div>
          <div className="ob-subjects" style={{ marginTop: 8 }}>
            {LEANINGS.map((l) => (
              <button
                key={l.id}
                type="button"
                className={`chip${leanings.includes(l.id) ? ' is-on' : ''}`}
                onClick={() => togLean(l.id)}
              >
                {leanings.includes(l.id) && <LoomIcon name="check" size={12} />}
                {l.label}
              </button>
            ))}
          </div>
          <div className="ob-field-hint">每天大概投入：</div>
          <div className="ob-pick" style={{ marginTop: 8, gridTemplateColumns: 'repeat(3, 1fr)' }}>
            {PACES.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`ob-pick-btn${pace === p.id ? ' is-on' : ''}`}
                onClick={() => setPace(p.id)}
              >
                <div className="ob-pick-l">{p.label}</div>
                <div className="ob-pick-s">{p.sub}</div>
              </button>
            ))}
          </div>
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
          <div className="ob-subjects">
            <span className="ob-subjects-lbl">学科视角（可选）：</span>
            {SUBJECTS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`chip${subject === s.id ? ' is-on' : ''}`}
                onClick={() => setSubject(subject === s.id ? null : s.id)}
              >
                {subject === s.id && <LoomIcon name="check" size={12} />}
                {s.name}
              </button>
            ))}
          </div>
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
          {err === 'scope' && (
            <div className="ob-inline-err">
              <LoomIcon name="alert" size={14} />
              这个目标暂时解析不出可用范围。换个说法，或直接上传材料。
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
