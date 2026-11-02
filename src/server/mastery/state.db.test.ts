// B1-W1 (ADR-0035) — mastery_state single-owner + θ̂ 接线层 db tests.

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A1 (YUK-433) — SRT_ENABLED is a module-level const (dark-ship default false). To
// exercise the flag-ON branch in updateThetaForAttempt we mock just that one export
// of @/core/theta and keep every other export (conjunctiveCredits, eloK, Fisher math,
// …) as the REAL implementation via importOriginal. The default-flag (false) tests
// below run against the real const through the same mock factory returning false.
//
// A2 (YUK-434) — HIERARCHICAL_ELO_ENABLED is mocked the same way (dark-ship default
// false). The flag-OFF tests run against the real const (false) through this factory;
// the flag-ON tests opt in via hierFlag.value = true. ELO_K_GLOBAL stays the REAL
// const (we assert the slow-drift split with its real value).
const srtFlag = { value: false };
const hierFlag = { value: false };
const fisherFlag = { value: false };
vi.mock('@/core/theta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/theta')>();
  return {
    ...actual,
    get SRT_ENABLED() {
      return srtFlag.value;
    },
    get HIERARCHICAL_ELO_ENABLED() {
      return hierFlag.value;
    },
    get SRT_FISHER_WEIGHT_ENABLED() {
      return fisherFlag.value;
    },
  };
});

// A4 (YUK-436) — THETA_GRID_ENABLED is a module-level const (dark-ship default false),
// mocked the same way. The flag-OFF regression anchor runs against the real const
// (false) through this factory; the flag-ON shadow test opts in via gridFlag.value=true.
// Everything else in @/core/theta-grid (gridUpdate / posteriorMean / …) stays REAL.
const gridFlag = { value: false };
vi.mock('@/core/theta-grid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/theta-grid')>();
  return {
    ...actual,
    get THETA_GRID_ENABLED() {
      return gridFlag.value;
    },
  };
});

// A5 (YUK-441) GRAPH_LAPLACIAN_ENABLED + A6 (YUK-442) PREREQ_THETA_PROPAGATION_ENABLED are
// module-level consts (dark-ship default false), mocked the same way. The flag-OFF
// byte-identical anchors run against the real consts (false) through these factories;
// the flag-ON tests opt in via laplFlag.value / prereqFlag.value = true. Everything
// else in each module (buildLaplacian / gmrfPosteriorMean / prereqAdjustments / …)
// stays the REAL implementation.
const laplFlag = { value: false };
// YUK-559 (S4) — override the A5 component cap so a small seeded related_to component
// can trip the fail-safe (null = use the real GRAPH_SMOOTH_COMPONENT_CAP=256).
const smoothCapOverride: { value: number | null } = { value: null };
vi.mock('@/core/graph-laplacian', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/graph-laplacian')>();
  return {
    ...actual,
    get GRAPH_LAPLACIAN_ENABLED() {
      return laplFlag.value;
    },
    get GRAPH_SMOOTH_COMPONENT_CAP() {
      return smoothCapOverride.value ?? actual.GRAPH_SMOOTH_COMPONENT_CAP;
    },
  };
});
const prereqFlag = { value: false };
vi.mock('@/core/prereq-propagation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/prereq-propagation')>();
  return {
    ...actual,
    get PREREQ_THETA_PROPAGATION_ENABLED() {
      return prereqFlag.value;
    },
  };
});

import { newId } from '@/core/ids';
import type { ThetaGridPosterior } from '@/core/theta-grid';
import { db } from '@/db/client';
import { knowledge, mastery_state, question } from '@/db/schema';
import { updateThetaForAttempt } from '@/kernel/records/mastery-state';
import { resetDb } from '../../../tests/helpers/db';

async function seedKnowledge(id: string) {
  const now = new Date();
  await db
    .insert(knowledge)
    .values({
      id,
      name: `K-${id}`,
      domain: 'yuwen',
      parent_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

async function seedQuestion(id: string, knowledgeIds: string[], difficulty = 3) {
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `Prompt ${id}`,
    reference_md: null,
    knowledge_ids: knowledgeIds,
    difficulty,
    source: 'manual',
    variant_depth: 0,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function readState(knowledgeId: string) {
  const rows = await db
    .select()
    .from(mastery_state)
    .where(
      and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, knowledgeId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

// A2 (YUK-434) — seed a root knowledge node with an explicit domain (the canonical
// effective_domain, since parent_id=null root carries the domain directly).
async function _seedKnowledgeWithDomain(id: string, domain: string) {
  const now = new Date();
  await db
    .insert(knowledge)
    .values({
      id,
      name: `K-${id}`,
      domain,
      parent_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

// A2 — read the per-domain θ_global row (subject_kind='ability_global', subject_id=domain).
async function _readGlobal(domain: string) {
  const rows = await db
    .select()
    .from(mastery_state)
    .where(
      and(eq(mastery_state.subject_kind, 'ability_global'), eq(mastery_state.subject_id, domain)),
    )
    .limit(1);
  return rows[0] ?? null;
}

describe('updateThetaForAttempt', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('single KC, correct answer: θ̂ rises, counts advance, evidence increments', async () => {
    const k = createId();
    const q = createId();
    await seedKnowledge(k);
    await seedQuestion(q, [k]);

    await db.transaction(async (tx) => {
      await updateThetaForAttempt(tx, {
        knowledgeIds: [k],
        questionId: q,
        outcome: 1,
        difficulty: 3, // → b=0 proxy
        attemptEventId: newId(),
        now: new Date(),
      });
    });

    const row = await readState(k);
    expect(row).not.toBeNull();
    expect(row?.theta_hat).toBeGreaterThan(0); // correct → θ̂ up
    expect(row?.evidence_count).toBe(1);
    expect(row?.success_count).toBe(1);
    expect(row?.fail_count).toBe(0);
  });

  // ── YUK-361 Phase 2 — θ precision 持久化（Urnings-Lite 不确定性） ──────────────
});

// ── A1 (YUK-433) — SRT scoring on the θ̂ credit hot path ──────────────────────

// ── A1 (YUK-450) — Fisher-conditioned time weight (4·p(1−p)) on the SRT credit ────

// YUK-372 L3 — family b_delta composition (effectiveFamilyB) in the θ̂ anchor.

// ═════════════════════════════════════════════════════════════════════════════
// A2 (YUK-434) — Hierarchical Elo: θ_global(per-domain) + θ_KC, cold-start inheritance.
// ═════════════════════════════════════════════════════════════════════════════

// A4 (YUK-436) — discrete grid-Bayes θ_KC offset posterior, SHADOW write (inc-1).
//   Read the persisted shadow posterior off mastery_state.theta_grid_json (a 'knowledge'
//   row, the same row the Elo theta_hat lives on).
async function _readGridJson(knowledgeId: string): Promise<ThetaGridPosterior | null> {
  const rows = await db
    .select({ grid: mastery_state.theta_grid_json })
    .from(mastery_state)
    .where(
      and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, knowledgeId)),
    )
    .limit(1);
  return (rows[0]?.grid as ThetaGridPosterior | null | undefined) ?? null;
}
