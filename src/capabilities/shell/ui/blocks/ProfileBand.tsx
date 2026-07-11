// YUK-476 · /today 起始画像卡片。把已上线但成孤儿的 placement profile（ScreenProfile @
// /profile ← GET /api/placement/profile）在冷启 /today 露出一张 band-only 摘要，并给 /profile
// 一个持久入口。设计 docs/design/2026-07-11-yuk476-diagnostic-surface.md（owner 判词 §10）。
//
// 判词落地：
//  ① band-only —— 卡片不露裸点 %/SE（裸数字留深读面 hover，见 ScreenProfile）。
//  ② 标记恒落 p_l（0..1 点估计），绝不 theta_hat（logit，可负/>1，混尺度会把标记推出轨道）。
//     见 §9-1 build-note；profile-band.unit 有回归断言锁死。
//  ③ 软/硬来源派生（后端无 per-KC source 字段）：low_confidence || evidence<3 → 软轨（淡/斜纹）。
//  ④ 覆盖表述用「N/M 个知识点有证据」，不把聚合 evidenceCount 说成「N 题」。
//
// active goal id 由 /api/workbench/summary 的 active_goal 提供（TodayPage 传入）；卡片只在
// active_goal 非 null 时挂载，故这里 goal 必非空。数据源 getPlacementProfile 是 live 端点，
// 与 placement probe 是否启用无关（PLACEMENT_PROBE_ENABLED dark-ship 不影响本读路径）。

import {
  type PlacementProfile,
  type ProfileKc,
  getPlacementProfile,
} from '@/capabilities/onboarding/ui/profile-api';
import { Btn } from '@/ui/primitives/Btn';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful, type StatefulStatus } from '@/ui/primitives/Stateful';
import { useQuery } from '@tanstack/react-query';

const PREVIEW_KC_LIMIT = 3;

// Clamp a 0..1 band coordinate so a stray projection value can't push a band edge or the mark
// off the track（同 ScreenProfile clamp01 口径）。
const clamp01 = (v: number | undefined, fb: number) => Math.max(0, Math.min(1, v ?? fb));
const pct = (v: number) => Math.round(v * 100);

// 软轨先验 vs 硬轨校准，派生自后端字段（判词3 v1 规则）：低置信或证据不足 → 软轨（未经真实
// 作答校准的先验回吐）。后端无 per-KC source/calibrated 字段时的诚实近似。
function isSoft(kc: ProfileKc): boolean {
  return Boolean(kc.low_confidence) || (kc.evidence_count ?? 0) < 3;
}

// 预览取「最弱优先」：tested KC 按 p_l 升序取前 N；未测不进预览（留给深读面完整列表）。
function weakestTested(kcs: ProfileKc[]): ProfileKc[] {
  return kcs
    .filter((k) => k.tested && k.evidence_count > 0)
    .sort((a, b) => (a.p_l ?? 1) - (b.p_l ?? 1))
    .slice(0, PREVIEW_KC_LIMIT);
}

// 链式三元会被 OCR flag（项目规则）——用 if/else 算状态。
function queryStatus(isLoading: boolean, isError: boolean): StatefulStatus {
  if (isLoading) return 'loading';
  if (isError) return 'error';
  return 'ok';
}

// 单条 mini band（band-only：coral 可能区间 + p_l 标记，无裸数字/轴文字）。
// 标记恒落 p_l——§9-1 build-note，不用 theta_hat。inverted CI 也不产生负宽（min/max 兜底）。
function MiniBand({ kc }: { kc: ProfileKc }) {
  const rawLo = clamp01(kc.mastery_lo, 0);
  const rawHi = clamp01(kc.mastery_hi, 0);
  const lo = Math.min(rawLo, rawHi);
  const hi = Math.max(rawLo, rawHi);
  const point = clamp01(kc.p_l, lo);
  return (
    <div className={`pf-band-row${isSoft(kc) ? ' is-soft' : ''}`}>
      <span className="pf-band-name">{kc.name}</span>
      <span className="pf-band-track" aria-hidden="true">
        <span className="pf-band-fill" style={{ left: `${pct(lo)}%`, width: `${pct(hi - lo)}%` }} />
        <span className="pf-band-mark" style={{ left: `${pct(point)}%` }} />
      </span>
    </div>
  );
}

function ProfileBandBody({
  data,
  goalId,
  navigate,
}: {
  data: PlacementProfile;
  goalId: string;
  navigate: (to: string) => void;
}) {
  const { testedCount, totalKcs } = data;

  // State D — 空知识树（无可评估 KC）：先录入材料。永不落 ColdStart（本就在 goal>0 分支内，
  // 守 YUK-520 红线：workbench 子块的空态只 quiet-empty）。
  if (totalKcs === 0) {
    return (
      <div className="pf-empty">
        <p className="pf-lead">这个目标还没有可评估的知识点 —— 先录入材料，画像会随之长出来。</p>
        <Btn size="sm" variant="primary" icon="record" onClick={() => navigate('/record')}>
          录入材料
        </Btn>
      </div>
    );
  }

  // State B — 有 scope 但零证据：练几道点亮画像（placement probe dark-ship，练习是 live 证据源）。
  if (testedCount === 0) {
    return (
      <div className="pf-empty">
        <p className="pf-lead">{`这个目标的 ${totalKcs} 个知识点还没有作答证据 —— 练几道，画像会随练习长出来。`}</p>
        <Btn size="sm" variant="primary" iconEnd="arrow" onClick={() => navigate('/practice')}>
          去练习
        </Btn>
      </div>
    );
  }

  // State C/E — 有证据：band-only 预览（最弱几条）+ 覆盖表述 + 深读入口。
  const preview = weakestTested(data.kcs);
  const softLead = preview.filter(isSoft).length > preview.length / 2;
  return (
    <>
      {softLead && <p className="pf-lead">这还只是先验起点 —— 练几轮，区间会收窄。</p>}
      <div className="pf-band-list">
        {preview.map((k) => (
          <MiniBand key={k.id} kc={k} />
        ))}
      </div>
      <div className="pf-band-foot">
        <span className="meta">{`${testedCount} / ${totalKcs} 个知识点有证据`}</span>
        <Btn
          size="sm"
          variant="secondary"
          iconEnd="arrow"
          onClick={() => navigate(`/profile?goal=${encodeURIComponent(goalId)}`)}
        >
          查看完整画像
        </Btn>
      </div>
    </>
  );
}

export function ProfileBand({
  goal,
  navigate,
}: {
  goal: { id: string; title: string };
  navigate: (to: string) => void;
}) {
  const q = useQuery({
    queryKey: ['placement-profile', goal.id],
    queryFn: () => getPlacementProfile(goal.id),
  });
  return (
    <>
      <SectionLabel>起始画像</SectionLabel>
      <LoomCard pad>
        <div className="card-head">
          <span className="card-icon accent">
            <LoomIcon name="target" size={18} />
          </span>
          <div className="card-title">你的起始画像</div>
        </div>
        <Stateful
          status={queryStatus(q.isLoading, q.isError)}
          onRetry={() => void q.refetch()}
          errorText="起始画像暂不可用。"
          skeleton={<SkLines rows={3} />}
        >
          {q.data && <ProfileBandBody data={q.data} goalId={goal.id} navigate={navigate} />}
        </Stateful>
      </LoomCard>
    </>
  );
}
