import { describe, expect, it } from 'vitest';

import {
  type AiProposalKindT,
  acceptSupportedProposalKinds,
  aiProposalKindStrength,
  aiProposalKinds,
  kindStrength,
} from './proposal';

// YUK-521 (A4 出手强度轴 / ADR-0039 A 档 strength tier) — 强度轴是与 accept-applier
// 轴 (acceptSupportedProposalKinds, YUK-44) 正交的第三轴。本测钉住三件事：
//   ① 强度表 keys 穷举 aiProposalKinds 全集（无遗漏 / 无幽灵 kind）；
//   ② C 档集合 ⟺ aiProposalKinds ∖ acceptSupportedProposalKinds（防双 SoT 漂移：
//      谁动了 acceptSupportedProposalKinds 而忘了同步强度表，这里 fail）；
//   ③ A=={completion}，两个 LEGACY tombstone (record_links/record_promotion) 在 B。

describe('aiProposalKindStrength', () => {
  it('exhaustively covers every aiProposalKinds member (no missing / phantom keys)', () => {
    const tableKeys = new Set(Object.keys(aiProposalKindStrength));
    const kinds = new Set<string>(aiProposalKinds);
    expect(tableKeys).toEqual(kinds);
    expect(tableKeys.size).toBe(aiProposalKinds.length);
  });

  it('every value is a valid A | B | C strength', () => {
    for (const kind of aiProposalKinds) {
      expect(['A', 'B', 'C']).toContain(aiProposalKindStrength[kind]);
    }
  });

  it('A tier === exactly {completion}', () => {
    const aTier = aiProposalKinds.filter((k) => aiProposalKindStrength[k] === 'A');
    expect(aTier).toEqual(['completion']);
  });

  // The double-SoT drift guard: the observe-only (C) set must equal the set of
  // kinds with no accept applier. Either list drifting without the other trips this.
  it('C tier ⟺ aiProposalKinds ∖ acceptSupportedProposalKinds (= {defer,archive,judge_retraction})', () => {
    const supported = new Set<string>(acceptSupportedProposalKinds);
    const noApplier = new Set(aiProposalKinds.filter((k) => !supported.has(k)));
    const cTier = new Set<AiProposalKindT>(
      aiProposalKinds.filter((k) => aiProposalKindStrength[k] === 'C'),
    );
    expect(cTier).toEqual(noApplier);
    expect([...cTier].sort()).toEqual(['archive', 'defer', 'judge_retraction']);
  });

  it('LEGACY tombstones record_links / record_promotion are B (never auto-applied)', () => {
    expect(aiProposalKindStrength.record_links).toBe('B');
    expect(aiProposalKindStrength.record_promotion).toBe('B');
  });

  it('kindStrength() reads the table', () => {
    expect(kindStrength('completion')).toBe('A');
    expect(kindStrength('defer')).toBe('C');
    expect(kindStrength('note_update')).toBe('B');
  });
});
