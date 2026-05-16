// Phase 1c.1 Step 8.B — `knowledge_mastery` view smoke.
//
// Per ADR-0012, mastery is a DERIVED metric — NULL for un-attempted nodes (no
// event references), [0,1] for attempted nodes. The view DDL (created by
// drizzle/0005_*.sql, applied via global-setup as of Step 8.A) implements:
//
//   - 180d hard window: events older than 180d are excluded from `attempts`
//   - 30d exponential decay (half-life): weight = exp(-ln(2) * age_days / 30)
//   - Evidence shortcut: <3 attempts → mastery = 0.5 (avoid noisy single-shot)
//   - Normal: mastery = weighted_success / weighted_total ∈ [0,1]
//
// Fixtures seed events DIRECTLY via `db.insert(event)` (NOT through writeEvent)
// so we control `created_at` exactly — required for decay/window assertions.
// `parseEvent` shape compliance is enforced by the schema TS types here, not
// by writeEvent's runtime gate. This is the standard test-side pattern (Step
// 4 fixtures use the same direct-insert convention).

import { event, knowledge } from '@/db/schema';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../helpers/db';

// Direct-insert seed helpers — bypass writeEvent so we can fix created_at.
// Shape mirrors the relevant Lane B `KnownEvent` subtypes (AttemptOnQuestion /
// ReviewOnQuestion) without parsing through Zod — runtime safety is provided
// by the TypeScript narrowing on `event.$inferInsert` plus integration tests
// elsewhere (`tests/integration/ai-output-parses-lane-b.test.ts`) that already
// guarantee Lane B coverage.

async function seedKnowledge(id: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: id,
    domain: 'wenyan',
    parent_id: null,
    created_at: now,
    updated_at: now,
  });
}

interface SeedEventOpts {
  id: string;
  outcome: 'success' | 'failure';
  knowledge_id: string;
  created_at: Date;
  /** default 'attempt' */
  action?: 'attempt' | 'review';
}

async function seedAttempt(opts: SeedEventOpts) {
  const db = testDb();
  const action = opts.action ?? 'attempt';
  // Minimal Lane B shape: action ∈ {attempt, review}, subject_kind='question',
  // payload carries referenced_knowledge_ids (drives mastery view's lateral
  // join). Other Lane B-required fields kept minimal/null where allowed.
  const payloadBase = {
    answer_md: null,
    answer_image_refs: [] as string[],
    referenced_knowledge_ids: [opts.knowledge_id],
  };
  const payload =
    action === 'review'
      ? {
          fsrs_rating: opts.outcome === 'success' ? ('good' as const) : ('again' as const),
          fsrs_state_after: {
            due: opts.created_at,
            stability: 1,
            difficulty: 5,
            elapsed_days: 0,
            scheduled_days: 1,
            learning_steps: 0,
            reps: 1,
            lapses: 0,
            state: 'review' as const,
            last_review: opts.created_at,
          },
          user_response_md: null,
          referenced_knowledge_ids: [opts.knowledge_id],
        }
      : payloadBase;
  await db.insert(event).values({
    id: opts.id,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action,
    subject_kind: 'question',
    subject_id: 'q_test',
    outcome: opts.outcome,
    payload,
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.created_at,
  });
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

async function masteryFor(knowledge_id: string): Promise<{
  knowledge_id: string;
  mastery: number | null;
  evidence_count: number;
} | null> {
  const db = testDb();
  const rows = await db.execute<{
    knowledge_id: string;
    mastery: number | null;
    evidence_count: number;
  }>(
    sql`SELECT knowledge_id, mastery, evidence_count FROM knowledge_mastery WHERE knowledge_id = ${knowledge_id}`,
  );
  const r = rows[0];
  if (r === undefined) return null;
  return {
    knowledge_id: r.knowledge_id,
    mastery: r.mastery === null ? null : Number(r.mastery),
    evidence_count: Number(r.evidence_count),
  };
}

describe('knowledge_mastery view', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns mastery=NULL + evidence_count=0 for un-attempted knowledge', async () => {
    await seedKnowledge('k_unused');
    const row = await masteryFor('k_unused');
    expect(row).not.toBeNull();
    expect(row?.mastery).toBeNull();
    expect(row?.evidence_count).toBe(0);
  });

  it('returns mastery ∈ [0,1] + evidence_count >= 3 for knowledge with multiple attempts', async () => {
    await seedKnowledge('k_practiced');
    const now = new Date();
    // 3 failures + 1 success — escapes the <3 evidence shortcut into the
    // weighted-ratio branch. All events same-day so weights ≈ 1.0.
    await seedAttempt({
      id: 'e_p1',
      outcome: 'failure',
      knowledge_id: 'k_practiced',
      created_at: now,
    });
    await seedAttempt({
      id: 'e_p2',
      outcome: 'failure',
      knowledge_id: 'k_practiced',
      created_at: now,
    });
    await seedAttempt({
      id: 'e_p3',
      outcome: 'failure',
      knowledge_id: 'k_practiced',
      created_at: now,
    });
    await seedAttempt({
      id: 'e_p4',
      action: 'review',
      outcome: 'success',
      knowledge_id: 'k_practiced',
      created_at: now,
    });
    const row = await masteryFor('k_practiced');
    expect(row).not.toBeNull();
    expect(row?.evidence_count).toBeGreaterThanOrEqual(3);
    expect(row?.mastery).not.toBeNull();
    if (row?.mastery !== null && row?.mastery !== undefined) {
      expect(row.mastery).toBeGreaterThanOrEqual(0);
      expect(row.mastery).toBeLessThanOrEqual(1);
      // 1 success / 4 total ≈ 0.25 (within recency floor — all same-day weights ≈ 1)
      expect(row.mastery).toBeGreaterThan(0.2);
      expect(row.mastery).toBeLessThan(0.3);
    }
  });

  it('excludes events older than 180 days (hard window)', async () => {
    await seedKnowledge('k_ancient');
    // Single event 200d ago — outside the WHERE `created_at > now() - interval '180 days'`
    await seedAttempt({
      id: 'e_ancient',
      outcome: 'failure',
      knowledge_id: 'k_ancient',
      created_at: daysAgo(200),
    });
    const row = await masteryFor('k_ancient');
    expect(row).not.toBeNull();
    // No surviving events → mastery NULL via `evidence_count = 0` branch
    expect(row?.evidence_count).toBe(0);
    expect(row?.mastery).toBeNull();
  });

  it('weight decays exponentially with age (half-life 30d)', async () => {
    // Compare same-set with vs. without decay applied:
    //   2 same-day successes  → weight ≈ 1.0 each
    //   2 30d-old failures    → weight ≈ 0.5 each
    //
    // weighted_success = 2 * 1.0 = 2.0
    // weighted_total   = 2 * 1.0 + 2 * 0.5 = 3.0
    // mastery          = 2.0 / 3.0 ≈ 0.667
    //
    // Without decay (all same-day) the ratio would be 2/4 = 0.5. The lift from
    // 0.5 → 0.667 is the decay signal we assert (with ±0.05 tolerance for
    // floating-point + intra-test-run clock drift).
    await seedKnowledge('k_decay');
    const now = new Date();
    await seedAttempt({
      id: 'e_d1',
      outcome: 'success',
      knowledge_id: 'k_decay',
      created_at: now,
    });
    await seedAttempt({
      id: 'e_d2',
      outcome: 'success',
      knowledge_id: 'k_decay',
      created_at: now,
    });
    await seedAttempt({
      id: 'e_d3',
      outcome: 'failure',
      knowledge_id: 'k_decay',
      created_at: daysAgo(30),
    });
    await seedAttempt({
      id: 'e_d4',
      outcome: 'failure',
      knowledge_id: 'k_decay',
      created_at: daysAgo(30),
    });
    const row = await masteryFor('k_decay');
    expect(row).not.toBeNull();
    expect(row?.evidence_count).toBe(4); // 4 events surviving the 180d window
    expect(row?.mastery).not.toBeNull();
    if (row?.mastery !== null && row?.mastery !== undefined) {
      // ±0.05 tolerance — `daysAgo(30)` measured from test start, view computes
      // weight against `now()` evaluated inside PG (a few ms later)
      expect(row.mastery).toBeGreaterThan(0.617);
      expect(row.mastery).toBeLessThan(0.717);
    }
  });
});
