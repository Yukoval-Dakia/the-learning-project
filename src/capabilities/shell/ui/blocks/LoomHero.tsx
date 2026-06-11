// M4-T6 (YUK-319)：工作台 hero（设计稿 screen-today.jsx LoomHero）。
// 偏差：eyebrow 去掉假 phase 戳；lead 句中性化——设计稿写死「昨晚 Dreaming
// agent 跑过」，真数据源（task_run 交班）M5 Copilot 收编后才可判定，不写死
// 假话；greet 不带用户名（单用户工具无 profile）。Copilot CTA 由宿主注入
// （M4 占位 toast，M5 接 CopilotDrawer）。

import { Btn } from '@/ui/primitives/Btn';
import { LoomCard } from '@/ui/primitives/LoomCard';

export function LoomHero({
  navigate,
  onCopilot,
}: {
  navigate: (to: string) => void;
  onCopilot: () => void;
}) {
  const hour = new Date().getHours();
  const greet =
    hour < 5
      ? '夜深了'
      : hour < 11
        ? '早上好'
        : hour < 14
          ? '午安'
          : hour < 18
            ? '下午好'
            : '晚上好';
  return (
    <LoomCard className="loom-hero" padLg>
      <svg
        className="hero-weave"
        viewBox="0 0 600 180"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path className="wv wv1" d="M0 60 C 150 60, 150 100, 300 100 S 450 60, 600 60" />
        <path className="wv wv2" d="M0 90 C 150 90, 150 130, 300 130 S 450 90, 600 90" />
        <path className="wv wv3" d="M0 120 C 150 120, 150 160, 300 160 S 450 120, 600 120" />
      </svg>
      <div className="hero-inner">
        <div className="eyebrow">
          <span className="dot-sep">●</span>TODAY · {new Date().toISOString().slice(0, 10)}
        </div>
        <h1 className="page-title hero-title">{greet}。</h1>
        <p className="page-lead">这是你的工作台：复习队列、AI 的提议与改动都汇在这里。</p>
        <div className="hero-cta">
          <Btn variant="primary" icon="review" onClick={() => navigate('/practice')}>
            开始今日复习
          </Btn>
          <Btn variant="secondary" icon="record" onClick={() => navigate('/record')}>
            录入
          </Btn>
          <Btn variant="ghost" icon="copilot" onClick={onCopilot}>
            打开 Copilot
          </Btn>
        </div>
      </div>
    </LoomCard>
  );
}
