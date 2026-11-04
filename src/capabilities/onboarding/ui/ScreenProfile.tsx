// Onboarding ④ · placement-done starter profile (YUK-473 Slice 4; M3E presentation YUK-1473,
// docs/design/2026-11-03-profile-m3e.md). Originally ported from docs/design/loom-refresh/project/screen-onboarding.jsx (ScreenProfile),
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
//
// YUK-495 #41 — the recompute verify layer (RcVerify bar + per-KC chips + bit-for-bit ledger
// / drift detail + boundary note) hangs off this screen, gated by RECOMPUTE_BADGE_ENABLED.
// It re-derives each displayed KC number ON-DEVICE from the raw evidence (recompute-core →
// src/core/recompute) and checks it against the server. Read-only.

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CircleAlert, Clock, Target, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ApiError } from '@/ui/lib/api';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button, UiNextRoot } from '@/ui-next/public';
import { OnboardingError, OnboardingState } from './OnboardingStatus';
import { OnboardingSteps } from './OnboardingSteps';
import { usePlacementProfileClient } from './placement-client';
import type { PlacementProfile, ProfileKc } from './profile-api';
import {
  RcDetailPanel,
  RcKcChip,
  RcMaturityBadge,
  RcVerify,
} from './recompute/RecomputeComponents';
import {
  RECOMPUTE_BADGE_ENABLED,
  type RcKcVerdict,
  type SigmaMode,
  summarizeMaturity,
  summarizeRecompute,
} from './recompute/recompute-core';
import { useRecompute } from './recompute/useRecompute';
import './onboarding-m3e.css';
import './recompute/recompute.css';

const pct = (v: number) => Math.round(v * 100);

// Clamp a 0..1 band coordinate (mastery_lo/hi, p(L)) into range so a stray projection
// value can't push a band edge or the mark off the track.
const clamp01 = (v: number | undefined, fb: number) => Math.max(0, Math.min(1, v ?? fb));

type Conf = 'none' | 'low' | 'ok';
// Says what the band does, not how far to trust it: a few answers can already narrow it.
const CONF_LABEL: Record<Conf, string> = { none: '未测', low: '区间还宽', ok: '区间已收窄' };
// Confidence bucket for a KC: untested (no evidence) → none; otherwise the projection's
// low_confidence flag decides low vs ok.
const confOf = (kc: ProfileKc): Conf => {
  const untested = !kc.tested || kc.evidence_count === 0;
  if (untested) return 'none';
  return kc.low_confidence ? 'low' : 'ok';
};

export interface ScreenProfileProps {
  navigate: (to: string) => void;
}

export interface ProfilePresentation {
  /** Evidence-sorted server surface plus any full-set weakest KCs missing from that cap. */
  displayedKcs: ProfileKc[];
  /** Weakest KCs appended after the evidence-sorted surface, in server weakest order. */
  weakestExtras: ProfileKc[];
  /** Full-set count with real answer evidence; visible-row fallback only guards stale caches. */
  evidencedCount: number;
}

/**
 * Reconcile the /today weakest preview with the /profile deep-read surface (YUK-616).
 *
 * `kcs` is capped after sorting by evidence, while `weakest` is derived from the full evidenced
 * set by p(L). Their union keeps the deep-read list compact without making the card's highlighted
 * weak point disappear. The server order of both segments is preserved and ids are deduplicated.
 */
export function deriveProfilePresentation(data: PlacementProfile): ProfilePresentation {
  const seen = new Set(data.kcs.map((kc) => kc.id));
  const weakestExtras: ProfileKc[] = [];
  for (const kc of data.weakest ?? []) {
    if (seen.has(kc.id)) continue;
    seen.add(kc.id);
    weakestExtras.push(kc);
  }

  return {
    displayedKcs: [...data.kcs, ...weakestExtras],
    weakestExtras,
    evidencedCount:
      data.evidencedCount ?? data.kcs.filter((kc) => kc.tested && kc.evidence_count > 0).length,
  };
}

export default function ScreenProfile({ navigate }: ScreenProfileProps) {
  const { getPlacementProfile } = usePlacementProfileClient();
  const goalId = new URLSearchParams(window.location.search).get('goal');

  const profileQ = useQuery({
    queryKey: ['placement-profile', goalId],
    queryFn: () => getPlacementProfile(goalId as string),
    // Boolean(goalId) (not `!== null`) so an empty `?goal=` ('' from URLSearchParams) doesn't
    // fire a doomed request — the `!goalId` render guard below already treats '' as no-goal.
    enabled: Boolean(goalId),
  });

  if (!goalId) {
    return (
      <ProfileShell>
        <section className="un-ob-section un-ob-panel">
          <OnboardingState
            icon={<Target size={24} />}
            title="还没有画像"
            text="先设定一个目标、做一轮定位练习，我才好给你一份起始画像。"
            action={
              <Button variant="primary" onClick={() => navigate('/today')}>
                回今日
                <ArrowRight size={18} aria-hidden="true" />
              </Button>
            }
          />
        </section>
      </ProfileShell>
    );
  }

  if (profileQ.isLoading) {
    return (
      <ProfileShell>
        <section className="un-ob-section un-ob-panel">
          <SkeletonLines rows={4} label="正在读取你的画像" />
        </section>
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
        <section className="un-ob-section un-ob-panel">
          <OnboardingError text={msg} onRetry={() => profileQ.refetch()} />
        </section>
      </ProfileShell>
    );
  }

  if (profileQ.data.kcs.length === 0) {
    return (
      <ProfileShell>
        <section className="un-ob-section un-ob-panel">
          <OnboardingState
            icon={<Clock size={24} />}
            title="画像还空着"
            text="这个目标还没有可定位的证据。先上传材料或做一轮定位，画像会随练习长出来。"
            action={
              <Button variant="primary" onClick={() => navigate('/onboarding/upload')}>
                <Upload size={18} aria-hidden="true" />
                去上传材料
              </Button>
            }
          />
        </section>
      </ProfileShell>
    );
  }

  return <ProfileBody data={profileQ.data} navigate={navigate} />;
}

// The data-bearing body — split out so the recompute hooks (useRecompute / detail toggle) run
// unconditionally, after ScreenProfile's data-dependent early returns.
function ProfileBody({
  data,
  navigate,
}: {
  data: PlacementProfile;
  navigate: (to: string) => void;
}) {
  const { kcs, totalKcs } = data;
  const { displayedKcs, weakestExtras, evidencedCount } = useMemo(
    () => deriveProfilePresentation(data),
    [data],
  );
  const shown = displayedKcs.length;
  const truncated = totalKcs > shown;
  const sigmaMode: SigmaMode = data.sigma_mode ?? 'libm';

  // Re-derive every KC on-device and roll up the verify summary (only when the layer is on).
  const summary = useMemo(
    () => (RECOMPUTE_BADGE_ENABLED ? summarizeRecompute(displayedKcs, sigmaMode) : null),
    [displayedKcs, sigmaMode],
  );
  const verdictById = useMemo(
    () => new Map<string, RcKcVerdict>(summary?.verdicts.map((v) => [v.id, v]) ?? []),
    [summary],
  );
  const { state: rcState, run: rcRun } = useRecompute({
    auto: true,
    outcome: summary?.overall ?? 'preview',
  });
  const [detailOpen, setDetailOpen] = useState(false);
  const showVerify = RECOMPUTE_BADGE_ENABLED && summary !== null;

  // D2 (#45) — profile-level calibration-maturity reconciliation. Independent fetch (NOT in
  // the placement payload), gated by the same RECOMPUTE_BADGE_ENABLED dark-ship flag, so the
  // query stays disabled until the layer is visually verified. The query + memo are declared
  // unconditionally here (after ScreenProfile's data-dependent early returns) to keep hook order
  // stable; RcMaturityBadge owns its own useRecompute internally.
  const { getCalibrationMaturity } = usePlacementProfileClient();
  const maturityQ = useQuery({
    queryKey: ['calibration-maturity'],
    queryFn: getCalibrationMaturity,
    enabled: RECOMPUTE_BADGE_ENABLED,
  });
  const maturitySummary = useMemo(
    () => (maturityQ.data ? summarizeMaturity(maturityQ.data) : null),
    [maturityQ.data],
  );

  const narrative =
    evidencedCount > 0
      ? `基于你在 ${evidencedCount} 个知识点上的作答，这是一份初步画像——多数判断证据还少，会随你练习一起收紧。`
      : '还没有作答证据，先做一轮定位或上传材料，画像会随练习长出来。';

  return (
    <ProfileShell>
      <p className="un-ob-prof-narr">{narrative}</p>
      <p className="un-ob-prof-honest">
        <CircleAlert size={16} aria-hidden="true" />
        {evidencedCount > 0 ? (
          <span>
            基于 {evidencedCount} 个知识点的<strong>初步判断</strong>
            。多数还需更多练习确认，下面把不确定一并摆出来。
          </span>
        ) : (
          <span>当前还没有作答证据，下面的范围只是起点，会随练习收紧。</span>
        )}
      </p>

      <section
        className="un-ob-section un-ob-panel"
        aria-label="各知识点的掌握判断"
        {...(showVerify ? { 'data-rc': rcState } : {})}
      >
        {showVerify && maturitySummary && <RcMaturityBadge summary={maturitySummary} />}

        {showVerify && summary && (
          <RcVerify
            state={rcState}
            summary={summary}
            detailOpen={detailOpen}
            onToggleDetail={() => setDetailOpen((o) => !o)}
            onRerun={rcRun}
          />
        )}

        <div className="un-ob-kc-list">
          {kcs.map((k) => (
            <KcRow
              key={k.id}
              kc={k}
              verdict={showVerify ? verdictById.get(k.id) : undefined}
              rcState={rcState}
            />
          ))}
        </div>

        {weakestExtras.length > 0 && (
          <section className="un-ob-prof-weakest" aria-labelledby="ob-prof-weakest-title">
            <h2 id="ob-prof-weakest-title" className="un-ob-question">
              仍需留意的薄弱点
            </h2>
            <p className="un-ob-hint">
              这些知识点的证据较少，但当前判断更薄弱；即使不在上面的高证据列表里，也会保留在这里。
            </p>
            <div className="un-ob-kc-list">
              {weakestExtras.map((k) => (
                <KcRow
                  key={k.id}
                  kc={k}
                  verdict={showVerify ? verdictById.get(k.id) : undefined}
                  rcState={rcState}
                />
              ))}
            </div>
          </section>
        )}

        {showVerify && detailOpen && summary && <RcDetailPanel summary={summary} />}

        <ul className="un-ob-prof-legend">
          <li>
            <i data-swatch="band" aria-hidden="true" />
            色带 = 可能掌握区间（不是分数）
          </li>
          <li>
            <i data-swatch="mark" aria-hidden="true" />
            标记 = 当前最可能的位置
          </li>
          <li>
            <i data-swatch="low" aria-hidden="true" />
            灰带 = 证据少，区间很宽
          </li>
        </ul>

        {truncated && (
          <p className="un-ob-hint">
            {weakestExtras.length > 0 ? `显示 ${shown} 个重点（含当前最弱项）` : `显示前 ${shown}`}
            ，共 {totalKcs} 个知识点
          </p>
        )}
      </section>

      <div className="un-ob-prof-foot">
        <Button variant="primary" onClick={() => navigate('/today')}>
          开始日常练习
          <ArrowRight size={18} aria-hidden="true" />
        </Button>
        <p className="un-ob-hint">
          进入今日后，复习队列、学习项、Coach 都会随你练习一起长出来，画像也会越来越准。
        </p>
      </div>
    </ProfileShell>
  );
}

function ProfileShell({ children }: { children: React.ReactNode }) {
  return (
    <UiNextRoot className="un-ob" data-un-m3e="practice-foundation">
      <main className="un-ob-main un-m3e-bridge">
        <OnboardingSteps active="profile" />
        <header className="un-ob-heading">
          <div>
            <h1>我们现在怎么看你</h1>
            <p>起始画像：当前对每个知识点的掌握判断。</p>
          </div>
        </header>
        {children}
      </main>
    </UiNextRoot>
  );
}

function KcRow({
  kc,
  verdict,
  rcState,
}: {
  kc: ProfileKc;
  verdict?: RcKcVerdict;
  rcState: ReturnType<typeof useRecompute>['state'];
}) {
  const untested = !kc.tested || kc.evidence_count === 0;
  const conf = confOf(kc);
  // Clamp to [0,1] so a stray projection value can't push the band edges or the mark off the
  // track. The mark stays at p(L) (the documented deviation — band mark = p(L) point estimate,
  // not theta_hat logit); clamping only guards the rendered position, not which field drives it.
  // Order the clamped pair so an inverted CI (mastery_hi < mastery_lo from a degenerate
  // projection) can't yield a negative band width (which CSS silently renders as 0 → the band
  // vanishes). Well-formed projections always have hi ≥ lo; this just makes the edge robust.
  const rawLo = clamp01(kc.mastery_lo, 0);
  const rawHi = clamp01(kc.mastery_hi, 0);
  const lo = Math.min(rawLo, rawHi);
  const hi = Math.max(rawLo, rawHi);
  const point = clamp01(kc.p_l, lo);

  // YUK-495 #41 — calm ochre hairline on a KC whose displayed numbers don't re-derive.
  const drifted = verdict?.kind === 'drift';

  return (
    <div
      className={`un-ob-kc${drifted ? ' rc-kc-drift' : ''}`}
      data-lowconf={kc.low_confidence || undefined}
      data-untested={untested || undefined}
    >
      <div className="un-ob-kc-name">{kc.name}</div>
      <div className="un-ob-band">
        {untested ? (
          <div className="un-ob-band-untested">未测，暂无证据</div>
        ) : (
          <>
            <div className="un-ob-band-track">
              <span
                className="un-ob-band-fill"
                style={{ left: `${pct(lo)}%`, width: `${pct(hi - lo)}%` }}
              />
              <span className="un-ob-band-edge" style={{ left: `${pct(lo)}%` }} />
              <span className="un-ob-band-edge" style={{ left: `${pct(hi)}%` }} />
              <span className="un-ob-band-mark" style={{ left: `${pct(point)}%` }} />
            </div>
            <div className="un-ob-band-axis">
              <span>较弱</span>
              <span>
                可能区间 {pct(lo)}–{pct(hi)}
              </span>
              <span>较稳</span>
            </div>
          </>
        )}
      </div>
      <div className="un-ob-kc-conf">
        {verdict && <RcKcChip state={rcState} kind={verdict.kind} />}
        <span className="un-ob-conf" data-conf={conf}>
          {CONF_LABEL[conf]}
        </span>
        <span className="un-ob-kc-ev">{untested ? '0 题' : `${kc.evidence_count} 题记录`}</span>
      </div>
    </div>
  );
}
