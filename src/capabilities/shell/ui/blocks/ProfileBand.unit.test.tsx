// YUK-476 · ProfileBand（/today 起始画像卡片）render 覆盖。SSR（renderToString，node env，无
// jsdom；CTA→navigate 交互路径手工验收）。QueryClient.setQueryData 喂缓存 → 组件零请求。
// 核心回归锁：珊瑚带标记恒落 p_l（0..1 点估计），绝不 theta_hat（logit，可负/>1）——§9-1。

import type { PlacementProfile, ProfileKc } from '@/capabilities/onboarding/ui/profile-api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProfileBand } from './ProfileBand';

const GOAL = { id: 'g_demo', title: '高考文言文' };

function kc(overrides: Partial<ProfileKc> & Pick<ProfileKc, 'id' | 'name'>): ProfileKc {
  return {
    tested: true,
    evidence_count: 5,
    theta_hat: 0.3,
    theta_se: 0.4,
    p_l: 0.6,
    mastery_lo: 0.45,
    mastery_hi: 0.78,
    low_confidence: false,
    success_count: 3,
    fail_count: 2,
    beta: 0.5,
    ...overrides,
  };
}

// Build a realistic payload — mirror the server's full-set derivation of weakest / evidencedCount
// (placement-profile.ts) so the card is tested against the true wire contract, not a stand-in.
// overrides win (lets a test inject a weakest/evidencedCount that diverges from kcs on purpose).
function profile(overrides: Partial<PlacementProfile> = {}): PlacementProfile {
  const kcs = overrides.kcs ?? [];
  const evidenced = kcs.filter(
    (k) => k.tested && (k.evidence_count ?? 0) > 0 && k.p_l !== undefined,
  );
  const weakest = [...evidenced].sort((a, b) => (a.p_l ?? 1) - (b.p_l ?? 1)).slice(0, 5);
  return {
    goalId: GOAL.id,
    title: GOAL.title,
    kcs,
    weakest,
    evidenceCount: kcs.reduce((a, k) => a + (k.tested ? k.evidence_count : 0), 0),
    evidencedCount: evidenced.length,
    testedCount: kcs.filter((k) => k.tested).length,
    totalKcs: kcs.length,
    ...overrides,
  };
}

function render(data: PlacementProfile): string {
  const qc = new QueryClient();
  qc.setQueryData(['placement-profile', GOAL.id], data);
  return renderToString(
    <QueryClientProvider client={qc}>
      <ProfileBand goal={GOAL} navigate={() => {}} />
    </QueryClientProvider>,
  );
}

describe('ProfileBand (/today 起始画像卡片)', () => {
  it('places the band mark at p_l, never theta_hat (§9-1 scale-mix regression guard)', () => {
    // theta_hat 2.5 是 logit（pct → 250%，出轨）；p_l 0.7 是 0..1 点估计（pct → 70%）。
    const html = render(
      profile({
        kcs: [
          kc({
            id: 'k1',
            name: '虚词·之',
            theta_hat: 2.5,
            p_l: 0.7,
            mastery_lo: 0.5,
            mastery_hi: 0.86,
          }),
        ],
      }),
    );
    expect(html).toContain('left:70%'); // 标记落 p_l
    expect(html).not.toContain('250%'); // 绝不落 theta_hat logit（出轨）
  });

  it('renders band-only preview + coverage + deep-read CTA when evidence exists (State C)', () => {
    const html = render(
      profile({
        kcs: [
          kc({ id: 'k1', name: '意动用法', p_l: 0.3 }),
          kc({ id: 'k2', name: '古今异义', p_l: 0.55 }),
        ],
      }),
    );
    expect(html).toContain('查看完整画像');
    // 判词7：覆盖表述用「个知识点有证据」，不把聚合说成「N 题」。
    expect(html).toContain('2 / 2 个知识点有证据');
    // band-only：卡片不露区间轴文字（那是深读面 ScreenProfile 的东西）。
    expect(html).not.toContain('可能区间');
  });

  it('orders the preview weakest-first by p_l', () => {
    const html = render(
      profile({
        kcs: [
          kc({ id: 'strong', name: 'AAA强项', p_l: 0.9 }),
          kc({ id: 'weak', name: 'ZZZ弱项', p_l: 0.2 }),
        ],
      }),
    );
    expect(html.indexOf('ZZZ弱项')).toBeLessThan(html.indexOf('AAA强项'));
  });

  it('shows a soft-prior lead when most preview KCs are low-confidence / thin (State C thin)', () => {
    const html = render(
      profile({
        kcs: [
          kc({ id: 'k1', name: '虚词', low_confidence: true, evidence_count: 2 }),
          kc({ id: 'k2', name: '活用', low_confidence: true, evidence_count: 1 }),
        ],
      }),
    );
    expect(html).toContain('先验起点');
  });

  it('prompts practice when the goal has scope but zero evidence (State B)', () => {
    const html = render(
      profile({
        kcs: [
          kc({ id: 'u1', name: '虚词', tested: false, evidence_count: 0 }),
          kc({ id: 'u2', name: '活用', tested: false, evidence_count: 0 }),
        ],
      }),
    );
    expect(html).toContain('去练习');
    expect(html).not.toContain('查看完整画像');
  });

  it('prompts material ingestion when the knowledge tree is empty (State D)', () => {
    const html = render(profile({ kcs: [], totalKcs: 0 }));
    expect(html).toContain('录入材料');
  });

  it('falls back to the practice prompt when tested KCs carry no evidence (empty-preview guard)', () => {
    // KG-borrow 软层：tested:true 但 evidence_count:0 → 无可展示证据 → State B（不是空 band 列表）。
    const html = render(
      profile({
        kcs: [kc({ id: 'k1', name: '虚词', tested: true, evidence_count: 0 })],
        testedCount: 1,
      }),
    );
    expect(html).toContain('去练习');
    expect(html).not.toContain('查看完整画像');
  });

  it('clamps an out-of-range p_l into the track (never off-track)', () => {
    // p_l 1.4（越界 logit-ish 脏值）→ 标记 clamp 到 100%，绝不产生 >100% 出轨位。
    const html = render(
      profile({
        kcs: [kc({ id: 'k1', name: '越界', p_l: 1.4, mastery_lo: 0.6, mastery_hi: 0.99 })],
      }),
    );
    expect(html).toContain('left:100%');
    expect(html).not.toContain('left:140%');
  });

  it('surfaces server weakest even when that KC is truncated out of kcs (YUK-614)', () => {
    // The true-weakest KC is NOT in kcs (server truncated it past PROFILE_KC_LIMIT) but the
    // server put it in `weakest`; the card must show it, and the footer must use evidencedCount
    // (full set), not the visible-kcs count.
    const truncatedWeak = kc({ id: 'weak', name: '真最弱', p_l: 0.15 });
    const html = render(
      profile({
        kcs: [kc({ id: 'v1', name: '可见强项', p_l: 0.88 })], // the surfaced (truncated) list
        weakest: [truncatedWeak], // server's full-set weakest — not present in kcs
        evidencedCount: 21, // full-set count, larger than kcs.length
        totalKcs: 21,
      }),
    );
    expect(html).toContain('真最弱');
    expect(html).not.toContain('可见强项'); // preview is driven by weakest, not kcs
    expect(html).toContain('21 / 21 个知识点有证据');
  });

  it('renders a non-negative band width on an inverted CI (mastery_hi < mastery_lo)', () => {
    // 退化投影 hi<lo：min/max 兜底 → 宽度非负（CSS 负宽会静默渲成 0，带消失）。
    const html = render(
      profile({
        kcs: [kc({ id: 'k1', name: '退化', mastery_lo: 0.8, mastery_hi: 0.3, p_l: 0.5 })],
      }),
    );
    expect(html).toContain('width:50%'); // lo=0.3→30%，hi=0.8→80%，width=50%
    expect(html).not.toContain('width:-');
  });
});
