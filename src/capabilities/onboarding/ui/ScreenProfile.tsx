// Onboarding ④ · placement-done starter profile (YUK-473 Slice 4).
// Ported from docs/design/loom-refresh/project/screen-onboarding.jsx (ScreenProfile),
// made real over GET /api/placement/profile (per-KC mastery_state projection). The
// placement probe's `settling` lands here (?goal threaded through); "开始日常练习" → /today.
//
// DEVIATIONS from the prototype, grounded in the real model:
//  - The band MARK sits at `p_l` (the 0..1 p(L) point estimate), NOT `theta_hat` — real
//    theta_hat is a logit (can be negative / >1), so it can't be a 0..1 bar position. The
//    prototype's mock conflated them; the real 0..1 quantity is p_l (= mastery point).
//  - Narrative is templated from the data (honest, deterministic) — no AI call. The richer
//    prototype narrative is a later enrich.
//  - `track` (KC category chip) is omitted — real knowledge nodes carry no track field yet.

import { ApiError } from '@/ui/lib/api';
import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { ErrorState } from '@/ui/primitives/ErrorState';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { useQuery } from '@tanstack/react-query';
import { ObSteps } from './ObSteps';
import { type ProfileKc, getPlacementProfile } from './profile-api';
import './onboarding.css';

const pct = (v: number) => Math.round(v * 100);

export interface ScreenProfileProps {
  navigate: (to: string) => void;
}

export default function ScreenProfile({ navigate }: ScreenProfileProps) {
  const goalId = new URLSearchParams(window.location.search).get('goal');

  const profileQ = useQuery({
    queryKey: ['placement-profile', goalId],
    queryFn: () => getPlacementProfile(goalId as string),
    enabled: goalId !== null,
  });

  if (!goalId) {
    return (
      <ProfileShell>
        <LoomCard pad padLg>
          <EmptyState
            icon="target"
            title="还没有画像"
            text="先设定一个目标、做一轮定位练习，我才好给你一份起始画像。"
            action={
              <Btn variant="primary" iconEnd="arrow" onClick={() => navigate('/today')}>
                回今日
              </Btn>
            }
          />
        </LoomCard>
      </ProfileShell>
    );
  }

  if (profileQ.isLoading) {
    return (
      <ProfileShell>
        <LoomCard pad padLg>
          <SkLines rows={4} />
        </LoomCard>
      </ProfileShell>
    );
  }

  if (profileQ.isError || !profileQ.data) {
    const err = profileQ.error;
    const msg =
      err instanceof ApiError && err.status === 404
        ? '找不到这个目标的画像。'
        : `画像加载失败：${(err as Error | null)?.message ?? '未知'}`;
    return (
      <ProfileShell>
        <LoomCard pad padLg>
          <ErrorState text={msg} onRetry={() => profileQ.refetch()} />
        </LoomCard>
      </ProfileShell>
    );
  }

  const { kcs, answeredCount } = profileQ.data;

  if (kcs.length === 0) {
    return (
      <ProfileShell>
        <LoomCard pad padLg>
          <EmptyState
            icon="clock"
            title="画像还空着"
            text="这个目标还没有可定位的证据。先上传材料或做一轮定位，画像会随练习长出来。"
            action={
              <Btn variant="primary" icon="record" onClick={() => navigate('/onboarding/upload')}>
                去上传材料
              </Btn>
            }
          />
        </LoomCard>
      </ProfileShell>
    );
  }

  const narrative =
    answeredCount > 0
      ? `基于你答的 ${answeredCount} 道题，这是一份初步画像——多数判断证据还少，会随你练习一起收紧。`
      : '还没有作答证据，先做一轮定位或上传材料，画像会随练习长出来。';

  return (
    <ProfileShell>
      <p className="ob-prof-narr ob-rise">{narrative}</p>
      <div className="ob-prof-honest ob-rise">
        <LoomIcon name="alert" size={13} />
        基于 {answeredCount} 道答题的<b style={{ margin: '0 3px' }}>初步信念</b> ·
        多数还需更多练习确认，下面把不确定一并摆出来
      </div>

      <LoomCard pad padLg className="ob-rise">
        <div className="ob-kc-list">
          {kcs.map((k) => (
            <KcRow key={k.id} kc={k} />
          ))}
        </div>

        <div className="ob-prof-legend">
          <span>
            <i style={{ background: 'color-mix(in oklab, var(--coral) 26%, transparent)' }} />
            珊瑚带 = 可能掌握区间（不是分数）
          </span>
          <span>
            <i style={{ background: 'var(--coral)', width: 8, height: 14, borderRadius: 6 }} />
            标记 = 当前最可能值 p(L)
          </span>
          <span>
            <i style={{ background: 'color-mix(in oklab, var(--ink-4) 20%, transparent)' }} />
            灰带 = 低置信，区间很宽
          </span>
        </div>
      </LoomCard>

      <div className="ob-prof-foot">
        <Btn variant="primary" size="lg" iconEnd="arrow" onClick={() => navigate('/today')}>
          开始日常练习
        </Btn>
        <span className="meta">
          进入今日后，复习队列、学习项、Coach 都会随你练习一起长出来——画像也会越来越准。
        </span>
      </div>
    </ProfileShell>
  );
}

function ProfileShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="page ob-prof">
      <div className="page-head">
        <div className="eyebrow">PROFILE · per-KC mastery_state · SE = 1/√precision</div>
        <ObSteps active="profile" />
        <div className="page-head-row">
          <h1 className="page-title serif">我们现在怎么看你</h1>
        </div>
      </div>
      {children}
    </div>
  );
}

function KcRow({ kc }: { kc: ProfileKc }) {
  const untested = !kc.tested || kc.evidence_count === 0;
  const conf = untested ? 'none' : kc.low_confidence ? 'low' : 'ok';
  const lo = kc.mastery_lo ?? 0;
  const hi = kc.mastery_hi ?? 0;
  const point = kc.p_l ?? lo;

  return (
    <div
      className={`ob-kc${kc.low_confidence ? ' is-lowconf' : ''}${untested ? ' is-untested' : ''}`}
    >
      <div className="ob-kc-id">
        <span className="ob-kc-name">{kc.name}</span>
      </div>
      <div className="ob-band">
        {untested ? (
          <div className="ob-band-untested">未测 · 暂无证据</div>
        ) : (
          <>
            <div className="ob-band-track">
              <span
                className="ob-band-fill"
                style={{ left: `${pct(lo)}%`, width: `${pct(hi - lo)}%` }}
              />
              <span className="ob-band-lo" style={{ left: `${pct(lo)}%` }} />
              <span className="ob-band-hi" style={{ left: `${pct(hi)}%` }} />
              <span className="ob-band-mark" style={{ left: `${pct(point)}%` }} />
            </div>
            <div className="ob-band-axis">
              <span>较弱</span>
              <span>
                可能区间 {pct(lo)}–{pct(hi)}
              </span>
              <span>较稳</span>
            </div>
          </>
        )}
      </div>
      <div className="ob-kc-conf">
        <span className={`ob-conf-pill t-${conf}`}>
          {conf === 'none' ? '未测' : conf === 'low' ? '低置信' : '较可信'}
        </span>
        <span className="ob-kc-ev">
          {untested ? '0 题' : `${kc.evidence_count} 题 · SE ${(kc.theta_se ?? 0).toFixed(2)}`}
        </span>
      </div>
    </div>
  );
}
