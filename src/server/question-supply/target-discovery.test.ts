// YUK-361 Phase 8 (Task 13 Step 5) — 纯扫描器 + 路由规划单测（无 DB）。

import { describe, expect, it } from 'vitest';

import { planSupplyRoutes } from './route-planner';
import {
  type FrontierKnowledgeInput,
  type PoolQuestion,
  type QuestionSupplyTarget,
  type ScanInput,
  acquisitionTierForQuestion,
  difficultyBandFor,
  scanCoverageGaps,
  seedRoutePreference,
} from './target-discovery';

// 确定性 id 工厂（测试可断言 id 序列稳定）。
function seqIds(): () => string {
  let n = 0;
  return () => `tgt-${n++}`;
}

function frontier(
  knowledgeId: string,
  overrides: Partial<FrontierKnowledgeInput> = {},
): FrontierKnowledgeInput {
  return {
    knowledgeId,
    subjectId: 'wenyan',
    thetaHat: 0,
    thetaPrecision: 1,
    evidenceCount: 0,
    ...overrides,
  };
}

function poolQuestion(overrides: Partial<PoolQuestion> = {}): PoolQuestion {
  return {
    id: `q-${Math.random().toString(36).slice(2)}`,
    kind: 'short_answer',
    source: 'manual',
    metadata: null,
    difficulty: 3,
    calibrationB: null,
    knowledgeIds: ['k1'],
    ...overrides,
  };
}

function emptyScan(over: Partial<ScanInput> = {}): ScanInput {
  return {
    frontier: [],
    questions: [],
    routePreferenceBySubject: {},
    ...over,
  };
}

describe('scanCoverageGaps — R1 frontier zero questions', () => {
  it('emits ONE target with desiredCount=2 for a frontier KC with zero questions', () => {
    const targets = scanCoverageGaps(
      emptyScan({ frontier: [frontier('k-new')], questions: [] }),
      seqIds(),
    );
    expect(targets).toHaveLength(1);
    const t = targets[0];
    expect(t.gapKind).toBe('frontier_zero');
    expect(t.desiredCount).toBe(2);
    expect(t.knowledgeIds).toEqual(['k-new']);
    expect(t.difficultyBand).toBe('near');
    expect(t.reason).toContain('zero questions');
  });

  it('frontier-zero does NOT also emit R2/R3/R4 (no pool to analyze)', () => {
    const targets = scanCoverageGaps(
      emptyScan({ frontier: [frontier('k-new')], questions: [] }),
      seqIds(),
    );
    expect(targets.map((t) => t.gapKind)).toEqual(['frontier_zero']);
  });

  it('two frontier KCs with zero questions → two frontier_zero targets', () => {
    const targets = scanCoverageGaps(
      emptyScan({ frontier: [frontier('k-a'), frontier('k-b')], questions: [] }),
      seqIds(),
    );
    const frontierTargets = targets.filter((t) => t.gapKind === 'frontier_zero');
    expect(frontierTargets).toHaveLength(2);
    expect(frontierTargets.flatMap((t) => t.knowledgeIds).sort()).toEqual(['k-a', 'k-b']);
  });
});

describe('scanCoverageGaps — R2 low-tier-only pool', () => {
  it('emits a higher-tier target (minSourceTier=2) when only llm-only/draft questions exist', () => {
    // 一道近-θ̂ application 题，但 source=quiz_gen（provenance tier 4 → 获取档 3 低档）。
    const lowTierNearQ = poolQuestion({
      id: 'q-low',
      source: 'quiz_gen',
      metadata: { quiz_gen: { generation_method: 'closed_book' } },
      kind: 'short_answer',
      calibrationB: 0, // b=0=θ̂ → near band，掩掉 R3 诊断缺口
      knowledgeIds: ['k1'],
    });
    const targets = scanCoverageGaps(
      emptyScan({ frontier: [frontier('k1')], questions: [lowTierNearQ] }),
      seqIds(),
    );
    const sq = targets.find((t) => t.gapKind === 'source_quality');
    expect(sq).toBeDefined();
    expect(sq?.minSourceTier).toBe(2);
    expect(sq?.constraints.avoidDuplicateOfQuestionIds).toEqual(['q-low']);
    // 已有近-θ̂ 题 → 无诊断缺口。
    expect(targets.find((t) => t.gapKind === 'diagnostic')).toBeUndefined();
  });

  it('does NOT emit source_quality when a tier-1 manual question exists', () => {
    const manualNearQ = poolQuestion({
      source: 'manual',
      kind: 'short_answer',
      calibrationB: 0,
      knowledgeIds: ['k1'],
    });
    const targets = scanCoverageGaps(
      emptyScan({ frontier: [frontier('k1')], questions: [manualNearQ] }),
      seqIds(),
    );
    expect(targets.find((t) => t.gapKind === 'source_quality')).toBeUndefined();
  });

  // review FINDING #3 — source='embedded' rows are AI-generated practice checks
  // (provenance tier 4 'generated'), NOT high-trust. A KC covered ONLY by embedded
  // checks must still get a source_quality (R2) gap for a real high-tier item.
  it('treats source=embedded as LOW tier → R2 source_quality fires when only embedded questions exist', () => {
    const embeddedNearQ = poolQuestion({
      id: 'q-embedded',
      source: 'embedded', // AI-generated check, no ingestion marker → tier 4 → acquisition tier 3.
      metadata: null,
      kind: 'short_answer',
      calibrationB: 0, // near band → suppresses R3 so we isolate R2.
      knowledgeIds: ['k1'],
    });
    const targets = scanCoverageGaps(
      emptyScan({ frontier: [frontier('k1')], questions: [embeddedNearQ] }),
      seqIds(),
    );
    const sq = targets.find((t) => t.gapKind === 'source_quality');
    expect(sq).toBeDefined();
    expect(sq?.minSourceTier).toBe(2);
    expect(sq?.constraints.avoidDuplicateOfQuestionIds).toEqual(['q-embedded']);
  });
});

describe('scanCoverageGaps — R3 repeated diagnostic gap (calibrationCandidate)', () => {
  it('emits a calibrationCandidate target when no near-theta_hat item exists', () => {
    // θ̂=0；唯一一道题 b=3（far above near window）→ 无近-θ̂ 题。tier-1 manual 掩掉 R2。
    const farQ = poolQuestion({
      source: 'manual',
      kind: 'short_answer',
      calibrationB: 3,
      knowledgeIds: ['k1'],
    });
    const targets = scanCoverageGaps(
      emptyScan({ frontier: [frontier('k1', { thetaHat: 0 })], questions: [farQ] }),
      seqIds(),
    );
    const diag = targets.find((t) => t.gapKind === 'diagnostic');
    expect(diag).toBeDefined();
    expect(diag?.constraints.calibrationCandidate).toBe(true);
    expect(diag?.difficultyBand).toBe('near');
    expect(diag?.reason).toContain('near-theta_hat');
  });

  it('does NOT emit diagnostic when a near-theta_hat item already exists', () => {
    const nearQ = poolQuestion({
      source: 'manual',
      kind: 'short_answer',
      calibrationB: 0.2, // |0.2 - 0| ≤ 0.75 → near
      knowledgeIds: ['k1'],
    });
    const targets = scanCoverageGaps(
      emptyScan({ frontier: [frontier('k1', { thetaHat: 0 })], questions: [nearQ] }),
      seqIds(),
    );
    expect(targets.find((t) => t.gapKind === 'diagnostic')).toBeUndefined();
  });

  // review FINDING #4 — R3 must NOT trust difficulty_proxy as a band anchor.
  // A proxy-only item whose proxy b happens to land 'near' must NOT suppress the
  // diagnostic gap (we still lack a RELIABLE near-theta_hat anchor → R3 fires).
  it('emits diagnostic when the only near-band item is proxy-only (no real item_calibration.b)', () => {
    // difficulty=3 → difficultyToLogitB(3)=0 → proxy b=0=θ̂ would land 'near' under the
    // OLD proxy-trusting logic and falsely suppress R3. With calibrationB=null it does NOT.
    const proxyOnlyQ = poolQuestion({
      source: 'manual', // tier-1 manual suppresses R2 so we isolate R3.
      kind: 'short_answer',
      difficulty: 3,
      calibrationB: null, // proxy-only — not a reliable anchor.
      knowledgeIds: ['k1'],
    });
    const targets = scanCoverageGaps(
      emptyScan({ frontier: [frontier('k1', { thetaHat: 0 })], questions: [proxyOnlyQ] }),
      seqIds(),
    );
    const diag = targets.find((t) => t.gapKind === 'diagnostic');
    expect(diag).toBeDefined();
    expect(diag?.constraints.calibrationCandidate).toBe(true);
  });

  // review FINDING #4 (other direction) — a proxy b that lands OUTSIDE near must NOT
  // fire a calibrationCandidate off the unreliable proxy. With ONLY a proxy-only item,
  // R3 fires because there is no reliable anchor at all — that is correct (we want a
  // real near anchor); the point is the proxy's classification never DRIVES the decision.
  it('R3 decision ignores proxy band classification entirely (proxy far-band still yields diagnostic)', () => {
    const proxyFarQ = poolQuestion({
      source: 'manual',
      kind: 'short_answer',
      difficulty: 5, // proxy b = 1.7 → 'above'/'stretch'; irrelevant — proxy is ignored.
      calibrationB: null,
      knowledgeIds: ['k1'],
    });
    const targets = scanCoverageGaps(
      emptyScan({ frontier: [frontier('k1', { thetaHat: 0 })], questions: [proxyFarQ] }),
      seqIds(),
    );
    // Still a diagnostic gap (no reliable near anchor); proxy band did not drive anything.
    expect(targets.find((t) => t.gapKind === 'diagnostic')).toBeDefined();
  });
});

describe('scanCoverageGaps — R4 recall-only pool', () => {
  it('emits an application/transfer target when only recall-style items exist', () => {
    // fill_blank + translation 都是 recall（rotationClassForKind）。给一道近-θ̂ recall 掩掉 R3。
    const recallQ = poolQuestion({
      source: 'manual',
      kind: 'fill_blank',
      calibrationB: 0,
      knowledgeIds: ['k1'],
    });
    const targets = scanCoverageGaps(
      emptyScan({ frontier: [frontier('k1', { thetaHat: 0 })], questions: [recallQ] }),
      seqIds(),
    );
    const fmt = targets.find((t) => t.gapKind === 'format_diversity');
    expect(fmt).toBeDefined();
    expect(fmt?.kind).toBe('short_answer');
    expect(fmt?.reason).toContain('recall');
  });

  it('does NOT emit format_diversity when an application item exists', () => {
    const appQ = poolQuestion({
      source: 'manual',
      kind: 'short_answer',
      calibrationB: 0,
      knowledgeIds: ['k1'],
    });
    const targets = scanCoverageGaps(
      emptyScan({ frontier: [frontier('k1', { thetaHat: 0 })], questions: [appQ] }),
      seqIds(),
    );
    expect(targets.find((t) => t.gapKind === 'format_diversity')).toBeUndefined();
  });
});

describe('scanCoverageGaps — priority ordering', () => {
  it('frontier_zero outranks lower-priority gaps', () => {
    const lowTierQ = poolQuestion({
      source: 'quiz_gen',
      metadata: { quiz_gen: { generation_method: 'closed_book' } },
      calibrationB: 0,
      knowledgeIds: ['k-has'],
    });
    const targets = scanCoverageGaps(
      emptyScan({
        frontier: [frontier('k-has'), frontier('k-zero')],
        questions: [lowTierQ],
      }),
      seqIds(),
    );
    // frontier_zero (priority 1.0) 应排在 source_quality (0.5) 前。
    expect(targets[0].gapKind).toBe('frontier_zero');
  });
});

describe('acquisitionTierForQuestion — 4-tier provenance → 3-tier acquisition', () => {
  it('manual question → acquisition tier 1', () => {
    expect(acquisitionTierForQuestion(poolQuestion({ source: 'manual' }))).toBe(1);
  });
  it('ingested authentic question (ingestion_session_id) → acquisition tier 1', () => {
    expect(
      acquisitionTierForQuestion(
        poolQuestion({ source: 'vision_paper', metadata: { ingestion_session_id: 'sess-1' } }),
      ),
    ).toBe(1);
  });
  it('web_sourced active question → acquisition tier 2', () => {
    expect(
      acquisitionTierForQuestion(
        poolQuestion({
          source: 'web_sourced',
          metadata: {
            source_ref_kind: 'url',
            web_sourced: {
              url: 'https://example.com/q',
              title: 'T',
              fetched_at: '2026-06-15T00:00:00Z',
              whitelist_match: true,
              extract: 'some extracted text',
            },
          },
        }),
      ),
    ).toBe(2);
  });
  it('llm-only quiz_gen closed_book → acquisition tier 3', () => {
    expect(
      acquisitionTierForQuestion(
        poolQuestion({
          source: 'quiz_gen',
          metadata: { quiz_gen: { generation_method: 'closed_book' } },
        }),
      ),
    ).toBe(3);
  });

  // review FINDING #3 — source='embedded' (AI-generated practice check, no ingestion
  // marker → provenance tier 4 'generated') is LOW acquisition tier 3, NOT high tier 1.
  it('embedded AI-check question → acquisition tier 3 (NOT high tier 1)', () => {
    expect(acquisitionTierForQuestion(poolQuestion({ source: 'embedded', metadata: null }))).toBe(
      3,
    );
  });

  // 'imported' stays high tier 1 (legitimately human-curated existing questions).
  it('imported question → acquisition tier 1', () => {
    expect(acquisitionTierForQuestion(poolQuestion({ source: 'imported', metadata: null }))).toBe(
      1,
    );
  });
});

describe('difficultyBandFor', () => {
  it('classifies below / near / above / stretch around theta_hat', () => {
    expect(difficultyBandFor(-2, 0)).toBe('below');
    expect(difficultyBandFor(0, 0)).toBe('near');
    expect(difficultyBandFor(0.5, 0)).toBe('near');
    expect(difficultyBandFor(1.2, 0)).toBe('above');
    expect(difficultyBandFor(2.5, 0)).toBe('stretch');
  });
});

describe('seedRoutePreference — profile sourcingRoutePreference → SupplyRoute[]', () => {
  it('maps legacy route tokens, dedupes, preserves order', () => {
    const profile = {
      sourcingRoutePreference: {
        reading: ['material', 'sourced'],
        short_answer: ['sourced', 'closed_book'],
      },
    } as never; // 只用到 sourcingRoutePreference 字段
    const seeded = seedRoutePreference(profile);
    // material→quiz_gen, sourced→sourcing_web, closed_book→quiz_gen(dup removed)
    expect(seeded).toEqual(['quiz_gen', 'sourcing_web']);
  });

  it('returns empty array when profile has no sourcingRoutePreference', () => {
    expect(seedRoutePreference({} as never)).toEqual([]);
  });
});

// ── route-planner cases (Task 13 Step 3 判据) ─────────────────────────────────

function target(overrides: Partial<QuestionSupplyTarget> = {}): QuestionSupplyTarget {
  return {
    id: 't',
    fingerprint: 'fp',
    gapKind: 'frontier_zero',
    subjectId: 'wenyan',
    knowledgeIds: ['k1'],
    kind: 'any',
    difficultyBand: 'near',
    desiredCount: 2,
    minSourceTier: 3,
    routePreference: [],
    priority: 1,
    reason: 'r',
    constraints: {},
    ...overrides,
  };
}

describe('planSupplyRoutes', () => {
  it('needsImage → image_candidate first', () => {
    expect(planSupplyRoutes(target({ constraints: { needsImage: true } }))).toEqual([
      'image_candidate',
      'ingest_existing',
      'sourcing_web',
    ]);
  });

  it('needsImage wins even over minSourceTier<=2', () => {
    expect(
      planSupplyRoutes(target({ minSourceTier: 1, constraints: { needsImage: true } })),
    ).toEqual(['image_candidate', 'ingest_existing', 'sourcing_web']);
  });

  it('minSourceTier<=2 → sourcing_web first', () => {
    expect(planSupplyRoutes(target({ minSourceTier: 2 }))).toEqual([
      'sourcing_web',
      'ingest_existing',
      'author_question',
    ]);
  });

  it('objectiveOnly (tier 3) → sourcing_web then author_question', () => {
    expect(
      planSupplyRoutes(target({ minSourceTier: 3, constraints: { objectiveOnly: true } })),
    ).toEqual(['sourcing_web', 'author_question']);
  });

  it('minSourceTier<=2 takes precedence over objectiveOnly', () => {
    expect(
      planSupplyRoutes(target({ minSourceTier: 2, constraints: { objectiveOnly: true } })),
    ).toEqual(['sourcing_web', 'ingest_existing', 'author_question']);
  });

  it('falls back to routePreference when set and no hard constraint', () => {
    expect(
      planSupplyRoutes(target({ minSourceTier: 3, routePreference: ['quiz_gen', 'sourcing_web'] })),
    ).toEqual(['quiz_gen', 'sourcing_web']);
  });

  it('falls back to default when routePreference empty and no hard constraint', () => {
    expect(planSupplyRoutes(target({ minSourceTier: 3, routePreference: [] }))).toEqual([
      'author_question',
      'sourcing_web',
    ]);
  });
});
