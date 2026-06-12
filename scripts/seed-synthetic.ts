// Station 1 — synthetic seed (YUK-184).
//
// Spec: docs/superpowers/specs/2026-06-01-station1-synthetic-seed-design.md
//
// A re-runnable dev script that manufactures a realistic, causally-chained,
// time-distributed event history so the FSRS / proposal / detection slices of
// Layer-8 light up and become observable on a LOCAL dev DB only.
//
// This is a FOCUSED dev script, NOT a framework (scope discipline). It writes
// via the production chokepoints where they exist
// (`writeEvent` for events, `recordProposalDecisionSignal` for signals,
// `upsertFsrsState` for FSRS state) and markered direct-insert for the rest
// (knowledge / knowledge_edge / question). All synthetic events carry
// `payload.__synthetic = true`; all synthetic knowledge nodes use a `synthetic:`
// id prefix; everything is idempotent by deterministic ids.
//
// CLI:
//   pnpm seed:synthetic                  # idempotent seed (insert-or-skip)
//   pnpm seed:synthetic --reset          # scoped teardown of synthetic rows only
//   pnpm seed:synthetic --reset --reseed # clean re-seed
//   pnpm seed:synthetic --observe        # seed (if needed) + stubbed-nightly + report
//
// Guard env required for ALL invocations (D3 prod fence):
//   SEED_SYNTHETIC_OK=1  and  a loopback DATABASE_URL.
//
// The pipeline fns are parameterized on a `DbLike` handle + exported so the DB
// test can drive them against the testcontainer. The fence + main() auto-run
// only fire when this module is executed as the CLI entry point, so importing it
// (in tests) is side-effect-free.

// D3 / Step 0 — load `.env` BEFORE importing `@/db/client` (the client throws on
// a missing DATABASE_URL at construction). This MUST be the first import: ESM
// evaluates an imported module's side effects before the importing module's
// later imports, so a side-effect import lexically before `@/db/client`
// guarantees config() runs first. (dev-local.ts / migrate-local-db.ts are NOT
// precedents — they spawn a child process and never import @/db/client.)
// Scripts load `.env`, NOT `.env.local`.
import './load-env';

import { runKnowledgeEdgeProposeNightly } from '@/capabilities/knowledge/jobs/knowledge_edge_propose_nightly';
import type { RubricGate } from '@/capabilities/knowledge/server/rubric-validator';
import { scheduleReview } from '@/capabilities/practice/server/fsrs';
import { CauseSchema } from '@/core/schema/cause';
import type { FsrsStateSchemaT } from '@/core/schema/event/blocks';
import type { AiProposalPayloadInputT } from '@/core/schema/proposal';
import { type Db, type Tx, db } from '@/db/client';
import {
  event,
  knowledge,
  knowledge_edge,
  material_fsrs_state,
  proposal_signals,
  question,
} from '@/db/schema';
import { PROPOSAL_FEEDBACK_BUDGET, PROPOSAL_GATE_BIAS_CONFIG } from '@/server/ai/tools/budgets';
import { writeEvent } from '@/server/events/queries';
import { upsertFsrsState } from '@/server/fsrs/state';
import { listActiveSubjectsSinceRefresh } from '@/server/memory/active-subjects';
import { resolveEdgeGateBump } from '@/server/proposals/adaptive-bias';
import {
  getProposalAcceptanceRates,
  recordProposalDecisionSignal,
} from '@/server/proposals/signals';
import { writeAiProposal } from '@/server/proposals/writer';
import { loadWenyanFixtures } from '@/subjects/wenyan/fixtures';
import { and, eq, inArray, sql } from 'drizzle-orm';

type DbLike = Db | Tx;

// ── D3 prod fence: refuse to run unless BOTH guards hold ────────────────────
// (1) explicit opt-in env, (2) loopback DATABASE_URL. Belt-and-suspenders: the
// codebase has NO NODE_ENV fence and the destructive /api/_/* routes are
// token-gated but not env-gated, so for a pre-product synthetic seed the cost of
// a misfire against a real DB is total. This is a STRICTER check than
// `@/db/client`'s `/localhost|127\.0\.0\.1/` substring regex: we parse the URL
// and exact-match the hostname, so `postgres://u:p@localhost.evil.com/db` (or
// `localhost` smuggled into credentials/query) is correctly refused.
export function assertProdFence(env: NodeJS.ProcessEnv = process.env): void {
  if (env.SEED_SYNTHETIC_OK !== '1') {
    throw new Error(
      'seed-synthetic refused: SEED_SYNTHETIC_OK must equal "1" (explicit opt-in). ' +
        'This script manufactures synthetic dev data and must never run unintentionally.',
    );
  }
  const url = env.DATABASE_URL ?? '';
  // Parse the hostname and EXACT-match loopback (stricter than a substring regex).
  let host = '';
  try {
    host = new URL(env.DATABASE_URL ?? '').hostname;
  } catch {
    host = '';
  }
  // new URL lowercases host; IPv6 loopback arrives bracket-stripped as '::1'.
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLoopback) {
    throw new Error(
      `seed-synthetic refused: DATABASE_URL host must be loopback (localhost / 127.0.0.1). Got: ${url || '<unset>'}. Dev/local only by construction.`,
    );
  }
}

// ── D2: SEED_PROFILE — a handful of named, hard-coded-default knobs ─────────
// Deterministic-by-default so re-runs are reproducible. No config file, no
// scenario DSL, no RNG framework.
const SEED_PROFILE = {
  timeSpanDays: 28,
  // recent failure cluster sits inside the last 24h (so the nightly's 24h scan
  // discovers it — D2's "two windows" rule).
  recentClusterHoursAgo: [2, 6, 12], // each < 24h
  overdueReviewedQuestions: 4, // questions reviewed to a due_at <= now
  futureReviewedQuestions: 2, // questions reviewed to a due_at in the future
} as const;

const SYNTH = 'synthetic:'; // knowledge id prefix marker (D3)
const SUBJECT_DOMAIN = 'wenyan';
const Q_SOURCE = 'synthetic_seed';

// Deterministic synthetic ids — re-run = select-then-skip by these ids.
export const NODES = {
  root: `${SYNTH}wenyan:root`,
  shici: `${SYNTH}wenyan:shici`, // 实词
  xuci: `${SYNTH}wenyan:xuci`, // 虚词
  jushi: `${SYNTH}wenyan:jushi`, // 句式
  changshi: `${SYNTH}wenyan:changshi`, // 文学常识
  fanyi: `${SYNTH}wenyan:fanyi`, // 翻译
  yufa: `${SYNTH}wenyan:yufa`, // 语法
} as const;

type NodeId = (typeof NODES)[keyof typeof NODES];

const NODE_SPECS: Array<{ id: NodeId; name: string; parent: NodeId | null }> = [
  { id: NODES.root, name: '文言文（合成根）', parent: null },
  { id: NODES.shici, name: '实词', parent: NODES.root },
  { id: NODES.xuci, name: '虚词', parent: NODES.root },
  { id: NODES.jushi, name: '句式', parent: NODES.root },
  { id: NODES.changshi, name: '文学常识', parent: NODES.root },
  { id: NODES.fanyi, name: '翻译', parent: NODES.root },
  { id: NODES.yufa, name: '语法', parent: NODES.root },
];

// knowledge_hint → synthetic node id (the wenyan fixtures carry knowledge_hint).
const HINT_TO_NODE: Record<string, NodeId> = {
  实词: NODES.shici,
  虚词: NODES.xuci,
  句式: NODES.jushi,
  文学常识: NODES.changshi,
  翻译: NODES.fanyi,
  语法: NODES.yufa,
};

function hintNode(hint: string): NodeId {
  return HINT_TO_NODE[hint] ?? NODES.shici;
}

// Materialized edges (a few) between synthetic nodes. NOTE the PASS edge and the
// L2 dismiss-cluster edges arrive as PROPOSE events, NOT pre-existing rows — the
// proposal stack is what we want to light up — so we keep these materialized
// edges OFF the relation/endpoints the PASS + dismiss clusters use, to avoid
// duplicate-edge / duplicate-pending skips.
const MATERIALIZED_EDGES: Array<{ from: NodeId; to: NodeId; relation: string }> = [
  { from: NODES.shici, to: NODES.fanyi, relation: 'applied_in' },
  { from: NODES.jushi, to: NODES.fanyi, relation: 'applied_in' },
];

// The PASS edge (driven by the stubbed nightly) uses 'prerequisite' (asymmetric
// → directional cooldownKeys[0]).
export const PASS_RELATION = 'prerequisite';
export const PASS_FROM = NODES.xuci;
export const PASS_TO = NODES.jushi;

// The L2 dismiss cluster uses 'related_to' (distinct from the PASS relation so
// the bump's effect is isolated). related_to is SYMMETRIC → cooldownKeys[0] is
// the SORTED-normalized form (proposal-tools.ts edgeCooldownKeys).
export const L2_DISMISS_RELATION = 'related_to';

// Deterministic question / event ids.
function qId(ref: string): string {
  return `${SYNTH}q:${ref}`;
}
function eId(token: string): string {
  return `synthetic_evt_${token}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
function daysAgo(days: number, now: Date): Date {
  return new Date(now.getTime() - days * DAY_MS);
}
function hoursAgo(hours: number, now: Date): Date {
  return new Date(now.getTime() - hours * HOUR_MS);
}

export function passCooldownKey(from: string, to: string): string {
  // asymmetric relation → directional form (edgeCooldownKeys cooldownKeys[0]).
  return `knowledge_edge:${from}|${to}|${PASS_RELATION}`;
}
function symmetricCooldownKey(from: string, to: string, relation: string): string {
  const normalized = [from, to].sort().join('|');
  return `knowledge_edge:${normalized}|${relation}`;
}

// ── Idempotency helpers ─────────────────────────────────────────────────────
async function existingNodeIds(dbh: DbLike): Promise<Set<string>> {
  const rows = await dbh
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(
      inArray(
        knowledge.id,
        NODE_SPECS.map((n) => n.id),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

async function existingQuestionRefs(dbh: DbLike): Promise<Set<string>> {
  const rows = await dbh.select({ metadata: question.metadata }).from(question);
  const out = new Set<string>();
  for (const row of rows) {
    const meta = row.metadata as { fixture_ref?: string; synthetic?: boolean } | null;
    if (meta?.synthetic === true && typeof meta.fixture_ref === 'string') out.add(meta.fixture_ref);
  }
  return out;
}

// ── Step 1 — knowledge nodes (approved/active) ──────────────────────────────
async function seedKnowledgeNodes(dbh: DbLike, now: Date): Promise<void> {
  const present = await existingNodeIds(dbh);
  for (const spec of NODE_SPECS) {
    if (present.has(spec.id)) continue;
    await dbh.insert(knowledge).values({
      id: spec.id,
      name: spec.name,
      // Invariant (domain.ts): parent_id IS NULL ↔ domain IS NOT NULL. Root
      // carries the domain; children inherit via the parent-chain walk.
      domain: spec.parent === null ? SUBJECT_DOMAIN : null,
      parent_id: spec.parent,
      approval_status: 'approved',
      proposed_by_ai: false,
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }
}

// ── Step 2 — materialized knowledge edges (a few) ───────────────────────────
async function seedMaterializedEdges(dbh: DbLike, now: Date): Promise<void> {
  for (const e of MATERIALIZED_EDGES) {
    const existing = await dbh
      .select({ id: knowledge_edge.id })
      .from(knowledge_edge)
      .where(
        and(
          eq(knowledge_edge.from_knowledge_id, e.from),
          eq(knowledge_edge.to_knowledge_id, e.to),
          eq(knowledge_edge.relation_type, e.relation),
        ),
      )
      .limit(1);
    if (existing.length > 0) continue;
    await dbh.insert(knowledge_edge).values({
      id: eId(`edge_${e.from}_${e.to}_${e.relation}`).replace(/[^a-zA-Z0-9_]/g, '_'),
      from_knowledge_id: e.from,
      to_knowledge_id: e.to,
      relation_type: e.relation,
      weight: 0.8,
      created_by: { by: 'user' },
      reasoning: 'synthetic materialized edge',
      created_at: now,
    });
  }
}

// ── Step 3 — questions from wenyan fixtures (referencing synthetic nodes) ────
interface SeededQuestion {
  id: string;
  ref: string;
  node: NodeId;
}

async function seedQuestions(dbh: DbLike, now: Date): Promise<SeededQuestion[]> {
  const fixtures = loadWenyanFixtures();
  const seenRefs = await existingQuestionRefs(dbh);
  const out: SeededQuestion[] = [];
  for (const item of fixtures) {
    const node = hintNode(item.knowledge_hint);
    const id = qId(item.ref);
    out.push({ id, ref: item.ref, node });
    if (seenRefs.has(item.ref)) continue;
    await dbh.insert(question).values({
      id,
      kind: item.kind,
      prompt_md: item.prompt_md,
      reference_md: item.reference_md,
      choices_md: item.choices_md ?? null,
      rubric_json: item.rubric_json ?? null,
      knowledge_ids: [node],
      difficulty: item.difficulty,
      source: Q_SOURCE,
      variant_depth: 0,
      figures: [],
      image_refs: [],
      structured: null,
      metadata: { fixture_ref: item.ref, knowledge_hint: item.knowledge_hint, synthetic: true },
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }
  return out;
}

// ── Step 4 — attempts (writeEvent) + reviews/FSRS + recent failure cluster ──
function buildCause(primaryCategory: string, analysis: string): FsrsCauseShape {
  // CauseSchema.parse validates the SHAPE + the primary_category FORMAT regex
  // (/^[a-z][a-z0-9_]*$/) only — it does NOT check registry membership (that is
  // validateCauseAgainstProfile, not called here). Callers pass a value that IS
  // a registered wenyan category ('concept', profile.ts) so the seeded cause is
  // registry-valid; the parse just guards against a malformed shape (PR review).
  return CauseSchema.parse({
    primary_category: primaryCategory,
    secondary_categories: [],
    analysis_md: analysis,
    confidence: 0.8,
  });
}
interface FsrsCauseShape {
  primary_category: string;
  secondary_categories: string[];
  analysis_md: string;
  confidence: number;
}

interface ClusterRefs {
  attemptIds: string[];
  fromNode: NodeId;
  toNode: NodeId;
}

async function seedAttemptsAndReviews(
  dbh: DbLike,
  questions: SeededQuestion[],
  now: Date,
): Promise<ClusterRefs> {
  // 4a. Generic backdated attempts (mix of success/failure) across 28d.
  // Deterministic distribution by question index (no RNG). 3-4 attempts/question
  // so hot nodes clear the mastery <3-evidence shortcut.
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const attemptCount = 3 + (i % 2); // 3 or 4
    for (let a = 0; a < attemptCount; a++) {
      const ageDays = Math.max(1, SEED_PROFILE.timeSpanDays - 1 - a * 7 - (i % 3));
      const outcome =
        i % 2 === 0
          ? a === attemptCount - 1
            ? 'success'
            : 'failure'
          : a === 0
            ? 'failure'
            : 'success';
      await writeEvent(dbh, {
        id: eId(`att_${q.ref}_${a}`),
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: q.id,
        outcome,
        payload: {
          answer_md: outcome === 'success' ? '正确作答' : '错误作答',
          answer_image_refs: [],
          referenced_knowledge_ids: [q.node],
          __synthetic: true,
        },
        created_at: daysAgo(ageDays, now),
      });
    }
  }

  // 4b. Reviews → real FSRS scheduling so some items end up due.
  const overdue = questions.slice(0, SEED_PROFILE.overdueReviewedQuestions);
  const future = questions.slice(
    SEED_PROFILE.overdueReviewedQuestions,
    SEED_PROFILE.overdueReviewedQuestions + SEED_PROFILE.futureReviewedQuestions,
  );
  await seedReviewTimeline(dbh, overdue, now, /* makeDue */ true);
  await seedReviewTimeline(dbh, future, now, /* makeDue */ false);

  // 4c. The RECENT failure cluster (drives the PASS edge propose). ≥2 failure
  // attempts INSIDE the last 24h, same registry-valid primary_category,
  // judge-backed, each referencing BOTH edge endpoints (GAP4 — satisfies the
  // strongest gate so any relation passes).
  const fromNode = PASS_FROM;
  const toNode = PASS_TO;
  const clusterQuestions = questions.filter((q) => q.node === fromNode || q.node === toNode);
  const clusterTargets = (clusterQuestions.length >= 2 ? clusterQuestions : questions).slice(0, 3);

  // FIX F (reseed freshness): the recent-cluster events use deterministic ids and
  // writeEvent is conflict-do-nothing, so a re-run would NOT refresh their
  // created_at — and the cluster must stay inside the nightly's 24h scan window.
  // Delete ONLY the recent-cluster deterministic ids (attempt + chained judge)
  // before re-writing them, so each seed run re-anchors them to `now - hoursAgo`.
  // Scoped to these ids only — the 28d history (4a/4b) is fine to keep stable.
  const recentClusterIds: string[] = [];
  for (let c = 0; c < SEED_PROFILE.recentClusterHoursAgo.length; c++) {
    recentClusterIds.push(eId(`cluster_att_${c}`), eId(`cluster_judge_${c}`));
  }
  await dbh.delete(event).where(inArray(event.id, recentClusterIds));

  const attemptIds: string[] = [];
  for (let c = 0; c < clusterTargets.length && c < SEED_PROFILE.recentClusterHoursAgo.length; c++) {
    const q = clusterTargets[c];
    const attemptId = eId(`cluster_att_${c}`);
    const createdAt = hoursAgo(SEED_PROFILE.recentClusterHoursAgo[c], now);
    await writeEvent(dbh, {
      id: attemptId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: q.id,
      outcome: 'failure',
      payload: {
        answer_md: '混淆虚词与句式判断',
        answer_image_refs: [],
        // GAP4: reference BOTH endpoints.
        referenced_knowledge_ids: [fromNode, toNode],
        __synthetic: true,
      },
      created_at: createdAt,
    });
    // GAP3: chained judge with a registry-valid primary_category + endpoint refs.
    await writeEvent(dbh, {
      id: eId(`cluster_judge_${c}`),
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'judge',
      subject_kind: 'event',
      subject_id: attemptId,
      caused_by_event_id: attemptId,
      outcome: 'success',
      payload: {
        cause: buildCause(
          'concept',
          `合成判定：「虚词」与「句式」概念边界混淆（失败 attempt ${attemptId}）`,
        ),
        referenced_knowledge_ids: [fromNode, toNode],
        __synthetic: true,
      },
      created_at: new Date(createdAt.getTime() + 60_000),
    });
    attemptIds.push(attemptId);
  }

  return { attemptIds, fromNode, toNode };
}

// Iteratively schedule reviews over a backdated timeline, write `review` events
// via writeEvent, and upsert the final FSRS state.
async function seedReviewTimeline(
  dbh: DbLike,
  questions: SeededQuestion[],
  now: Date,
  makeDue: boolean,
): Promise<void> {
  const reviewOffsetsDaysAgo = makeDue ? [21, 14, 7] : [3, 1];
  const ratings: Array<'again' | 'hard' | 'good'> = makeDue
    ? ['hard', 'good', 'good']
    : ['good', 'good'];

  for (const q of questions) {
    let prevState: FsrsStateSchemaT | null = null;
    let lastReviewEventId = '';
    let lastDueAt = now;
    let lastState: FsrsStateSchemaT | null = null;
    for (let r = 0; r < reviewOffsetsDaysAgo.length; r++) {
      const asOf = daysAgo(reviewOffsetsDaysAgo[r], now);
      const rating = ratings[r];
      const { nextState, dueAt } = scheduleReview(prevState, rating, asOf);
      const outcome = rating === 'again' ? 'failure' : 'success';
      const reviewId = eId(`review_${q.ref}_${r}`);
      await writeEvent(dbh, {
        id: reviewId,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'review',
        subject_kind: 'question',
        subject_id: q.id,
        outcome,
        payload: {
          fsrs_rating: rating,
          fsrs_state_after: nextState,
          user_response_md: null,
          referenced_knowledge_ids: [q.node],
          __synthetic: true,
        },
        created_at: asOf,
      });
      prevState = nextState;
      lastReviewEventId = reviewId;
      lastDueAt = dueAt;
      lastState = nextState;
    }
    if (lastState) {
      // The persisted FSRS `state` is the real ts-fsrs projection. For the
      // overdue subset we force `due_at` into the past (the spec's overdueFraction
      // knob: "tune the last rating/timestamp so a fraction of items end with
      // due_at <= now"). A `good`-graded review's natural interval lands several
      // days in the FUTURE even from a 7-days-ago review, so backdating the
      // persisted due_at is the deterministic way to make the due-list non-empty.
      // `upsertFsrsState` takes an explicit due_at, so this is a clean override.
      const dueAt = makeDue ? daysAgo(1, now) : lastDueAt;
      await upsertFsrsState(dbh, {
        subject_kind: 'question',
        subject_id: q.id,
        state: lastState,
        due_at: dueAt,
        last_review_event_id: lastReviewEventId,
      });
    }
  }
}

// ── Step 5b — rubric-rejected propose events (hand-written, GAP1) ───────────
// Replicate foldRubricRejectedEdge's event_override shape. NO rate, NO
// proposal_signals row (terminal by design).
async function seedRubricRejectedProposes(dbh: DbLike, now: Date): Promise<void> {
  const rejects: Array<{
    from: NodeId;
    to: NodeId;
    relation: string;
    gate: RubricGate;
    reason: string;
  }> = [
    {
      from: NODES.shici,
      to: NODES.changshi,
      relation: 'prerequisite',
      gate: 'prerequisite_no_order_evidence',
      reason:
        'prerequisite requires learning-order evidence: no in-window judge-backed failure references either endpoint node (synthetic rubric-rejected fixture)',
    },
    {
      from: NODES.changshi,
      to: NODES.fanyi,
      relation: 'contrasts_with',
      gate: 'contrasts_with_no_confusion',
      reason:
        'contrasts_with requires confusion evidence: no in-window judge-backed failure references both endpoint nodes (synthetic rubric-rejected fixture)',
    },
  ];

  for (let i = 0; i < rejects.length; i++) {
    const r = rejects[i];
    const proposalPayload: AiProposalPayloadInputT = {
      kind: 'knowledge_edge',
      target: { subject_kind: 'knowledge_edge', subject_id: null },
      reason_md: `synthetic rubric-rejected edge ${r.from}->${r.to} (judge cause concept)`,
      evidence_refs: [],
      proposed_change: {
        from_knowledge_id: r.from,
        to_knowledge_id: r.to,
        relation_type: r.relation,
        weight: 0.5,
      },
      cooldown_key: `knowledge_edge:${r.from}|${r.to}|${r.relation}`,
    };
    await writeAiProposal(dbh, {
      id: eId(`rubric_reject_${i}`),
      actor_ref: 'dreaming',
      outcome: 'success',
      payload: proposalPayload,
      // GAP1 — exact foldRubricRejectedEdge event_override shape.
      event_override: {
        action: 'propose',
        subject_kind: 'knowledge_edge',
        payload: {
          from_knowledge_id: r.from,
          to_knowledge_id: r.to,
          relation_type: r.relation,
          weight: 0.5,
          reasoning: proposalPayload.reason_md,
          rubric_verdict: { ok: false, gate: r.gate, reason: r.reason },
          __synthetic: true,
        },
      },
      created_at: now,
    });
  }
}

// ── Proposal-signal idempotency guard ───────────────────────────────────────
// `recordProposalDecisionSignal` INCREMENTS accept_count/dismiss_count by a delta
// on every call (additive upsert), so a naive re-run would double the per-cell
// counts → acceptance_rate + the L2 gate-bump baseline drift. Skip the signal
// write when a row already exists for that cooldown_key (idempotent by cell).
async function signalExists(dbh: DbLike, cooldownKey: string): Promise<boolean> {
  const rows = await dbh
    .select({ id: proposal_signals.id })
    .from(proposal_signals)
    .where(eq(proposal_signals.cooldown_key, cooldownKey))
    .limit(1);
  return rows.length > 0;
}

// ── Step 5c — L2 dismiss cluster (sizes resolveEdgeGateBump → tighten) ──────
// 6 PASS-style propose+rate chains on a SINGLE relation_type across distinct
// from|to pairs, mostly dismiss, so the relation-summed total >= minSamples(5)
// and acceptance_rate < acceptanceThreshold(0.3).
async function seedL2DismissCluster(dbh: DbLike, now: Date): Promise<void> {
  const pairs: Array<[NodeId, NodeId]> = [
    [NODES.root, NODES.shici],
    [NODES.root, NODES.xuci],
    [NODES.root, NODES.jushi],
    [NODES.root, NODES.changshi],
    [NODES.root, NODES.fanyi],
    [NODES.root, NODES.yufa],
  ];
  // 5 dismisses + 1 accept → total 6 >= 5, rate = 1/6 ≈ 0.17 < 0.3 → tighten.
  const decisions: Array<'accept' | 'dismiss'> = [
    'accept',
    'dismiss',
    'dismiss',
    'dismiss',
    'dismiss',
    'dismiss',
  ];

  for (let i = 0; i < pairs.length; i++) {
    const [from, to] = pairs[i];
    const cooldownKey = symmetricCooldownKey(from, to, L2_DISMISS_RELATION);
    const proposeId = eId(`l2_propose_${i}`);
    const clusterPayload: AiProposalPayloadInputT = {
      kind: 'knowledge_edge',
      target: { subject_kind: 'knowledge_edge', subject_id: null },
      reason_md: `synthetic L2 cluster edge ${from}<->${to} (judge cause concept, related_to)`,
      evidence_refs: [],
      proposed_change: {
        from_knowledge_id: from,
        to_knowledge_id: to,
        relation_type: L2_DISMISS_RELATION,
        weight: 0.4,
      },
      cooldown_key: cooldownKey,
      suggestion_kind: 'proactive',
    };
    await writeAiProposal(dbh, {
      id: proposeId,
      actor_ref: 'dreaming',
      outcome: 'success',
      payload: clusterPayload,
      event_override: {
        action: 'propose',
        subject_kind: 'knowledge_edge',
        payload: {
          from_knowledge_id: from,
          to_knowledge_id: to,
          relation_type: L2_DISMISS_RELATION,
          weight: 0.4,
          reasoning: `synthetic L2 cluster edge ${from}<->${to}`,
          __synthetic: true,
        },
      },
      created_at: daysAgo(2, now),
    });

    const decision = decisions[i];
    // RateKnowledgeEdge pins actor_ref:'self'.
    await writeEvent(dbh, {
      id: eId(`l2_rate_${i}`),
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'knowledge_edge',
      // The rated proposal's id (PR review: a real RateKnowledgeEdge's subject_id
      // is the edge-proposal subject, not the cooldown_key). Linkage to the
      // propose is via caused_by_event_id; subject_id is not joined on.
      subject_id: proposeId,
      caused_by_event_id: proposeId,
      outcome: 'success',
      payload: { rating: decision, __synthetic: true },
      created_at: daysAgo(1, now),
    });

    // proposal_signals via the production signal writer (D1). GAP5: cooldown_key
    // set + suggestion_kind proactive (corrective+accept early-returns).
    // Idempotency (FIX B): the writer increments counts by a delta on every
    // call, so guard per-cell — skip when this cooldown_key already has a row.
    if (!(await signalExists(dbh, cooldownKey))) {
      await recordProposalDecisionSignal(
        dbh,
        {
          id: proposeId,
          kind: 'knowledge_edge',
          payload: { cooldown_key: cooldownKey, suggestion_kind: 'proactive' },
        },
        decision,
        decision === 'dismiss' ? '合成：与既有树结构重复，无导航价值' : undefined,
      );
    }
  }
}

// ── Step 5a — the PASS relation signal ──────────────────────────────────────
// The nightly produces the PASS propose event itself (--observe). For the plain
// `seed` path we still want a proposal_signals row for the PASS relation so
// getProposalAcceptanceRates has a non-zero row — record a user accept directly
// from the deterministic cooldown_key.
async function seedPassRelationSignal(dbh: DbLike, cluster: ClusterRefs): Promise<void> {
  const cooldownKey = passCooldownKey(cluster.fromNode, cluster.toNode);
  // Idempotency (FIX B): skip when this cooldown_key already has a signal row —
  // the writer is additive, so a naive re-run would double accept_count.
  if (await signalExists(dbh, cooldownKey)) return;
  await recordProposalDecisionSignal(
    dbh,
    {
      id: eId('pass_propose_signal'),
      kind: 'knowledge_edge',
      payload: { cooldown_key: cooldownKey, suggestion_kind: 'proactive' },
    },
    'accept',
  );
}

// ── The full seed pipeline ──────────────────────────────────────────────────
export async function runSeed(dbh: DbLike, now: Date = new Date()): Promise<void> {
  await seedKnowledgeNodes(dbh, now);
  await seedMaterializedEdges(dbh, now);
  const questions = await seedQuestions(dbh, now);
  const cluster = await seedAttemptsAndReviews(dbh, questions, now);
  await seedRubricRejectedProposes(dbh, now);
  await seedL2DismissCluster(dbh, now);
  await seedPassRelationSignal(dbh, cluster);
  console.log('[seed-synthetic] seed complete', {
    nodes: NODE_SPECS.length,
    questions: questions.length,
    clusterAttempts: cluster.attemptIds.length,
    passRelation: PASS_RELATION,
    l2DismissRelation: L2_DISMISS_RELATION,
  });
}

// ── --reset: scoped teardown of synthetic rows only (D3 #3) ─────────────────
// Reverse-FK order rooted at synthetic knowledge nodes (id LIKE 'synthetic:%'),
// PLUS two explicit FK-less deletes: material_fsrs_state (by synthetic subject
// question id), proposal_signals (by synthetic cooldown_keys). FK_ORDER is NOT
// mirrored (it omits proposal_signals + has no enforced FK on material_fsrs_state).
export interface ResetCounts {
  event: number;
  proposal_signals: number;
  material_fsrs_state: number;
  knowledge_edge: number;
  question: number;
  knowledge: number;
}

export async function runReset(dbh: DbLike): Promise<ResetCounts> {
  // FIX C (atomicity): wrap the whole delete sequence in a transaction so a
  // mid-failure never leaves a half-cleaned DB. A `Db` exposes `.transaction`;
  // a `Tx` does not (and nesting would be wrong), so guard on its presence.
  if ('transaction' in dbh) {
    return (dbh as Db).transaction((tx) => runResetTx(tx));
  }
  return runResetTx(dbh);
}

async function runResetTx(dbh: DbLike): Promise<ResetCounts> {
  // postgres-js `db.execute(sql\`… RETURNING …\`)` returns the rows array, so
  // `.length` is the deleted-row count.
  // Most synthetic events carry payload.__synthetic. EXCEPTION: the stubbed
  // nightly's PASS propose is written through the real writeAiProposal path,
  // whose event payload is built from the canned EdgeProposeOutput and CANNOT
  // carry __synthetic (EdgeProposalSchema forbids extra keys). So also delete
  // any knowledge_edge propose event whose endpoints are synthetic — that
  // catches the un-markered nightly PASS propose (PR review, major).
  //
  // FIX D(2): broaden the second arm to also catch `generate` events on
  // synthetic edges. A dev who accepts a seeded proposal via the real UI writes
  // a `generate` event WITHOUT __synthetic, and GenerateKnowledgeEdge's payload
  // carries from/to_knowledge_id (known.ts:392-393), so the synthetic-endpoint
  // predicate matches it. NOTE: `rate` is deliberately NOT included here —
  // RateKnowledgeEdge's payload is `{ rating, ... }` with NO from/to_knowledge_id
  // (known.ts:472-477); it keys the edge via `subject_id` (the propose event id)
  // + `caused_by_event_id`, NOT by endpoint, so a payload-endpoint predicate
  // cannot match it. A real un-markered `rate` on a seeded edge is therefore not
  // purged by --reset; correctness over coverage (PR review).
  const ev = await dbh.execute(
    sql`DELETE FROM "event"
        WHERE (payload->>'__synthetic') = 'true'
           OR (
             action IN ('propose', 'generate') AND subject_kind = 'knowledge_edge'
             AND (
               (payload->>'from_knowledge_id') LIKE ${'synthetic:%'}
               OR (payload->>'to_knowledge_id') LIKE ${'synthetic:%'}
             )
           )
        RETURNING id`,
  );
  const ps = await dbh.execute(
    sql`DELETE FROM "proposal_signals" WHERE cooldown_key LIKE ${'knowledge_edge:synthetic:%'} RETURNING id`,
  );
  const fs = await dbh.execute(
    sql`DELETE FROM "material_fsrs_state" WHERE subject_id LIKE ${'synthetic:q:%'} RETURNING id`,
  );
  // FIX D(1): delete any edge with EITHER endpoint synthetic (OR, not AND). An
  // edge with ONE synthetic endpoint would otherwise FK-block the knowledge
  // delete below.
  const ke = await dbh.execute(
    sql`DELETE FROM "knowledge_edge" WHERE from_knowledge_id LIKE ${'synthetic:%'} OR to_knowledge_id LIKE ${'synthetic:%'} RETURNING id`,
  );
  const q = await dbh.execute(
    sql`DELETE FROM "question" WHERE (metadata->>'synthetic') = 'true' RETURNING id`,
  );
  const k = await dbh.execute(
    sql`DELETE FROM "knowledge" WHERE id LIKE ${'synthetic:%'} RETURNING id`,
  );
  const counts: ResetCounts = {
    event: arrayLen(ev),
    proposal_signals: arrayLen(ps),
    material_fsrs_state: arrayLen(fs),
    knowledge_edge: arrayLen(ke),
    question: arrayLen(q),
    knowledge: arrayLen(k),
  };
  console.log('[seed-synthetic] reset complete (deleted rows)', counts);
  return counts;
}

function arrayLen(result: unknown): number {
  return Array.isArray(result) ? result.length : 0;
}

// ── --observe: drive the REAL nightly with a STUBBED runTaskFn + report ─────
export async function runObserve(dbh: DbLike, now: Date = new Date()): Promise<void> {
  // Ensure seeded (idempotent) before observing.
  await runSeed(dbh, now);
  await runStubbedNightly(dbh);
  await printReport(dbh, now);
}

// The stub returns a canned EdgeProposeOutput JSON (the PASS propose). The
// nightly's REAL body runs: getFailureAttempts(now-24h) discovers the cluster,
// runEdgeProposeAndWrite applies real dedup/self-loop/unknown-node/duplicate
// checks, then writeAiProposal → writeEvent writes a PLAIN PASS propose event.
// Zero token, deterministic. The reasoning names a concrete signal (G7a) and the
// relation is the asymmetric PASS_RELATION.
export async function runStubbedNightly(dbh: DbLike): Promise<void> {
  const cannedReasoning =
    '「虚词」与「句式」概念边界混淆：合成 judge cause concept，错题失败 attempt 触发 prerequisite';
  const cannedOutput = JSON.stringify({
    proposals: [
      {
        from_knowledge_id: PASS_FROM,
        to_knowledge_id: PASS_TO,
        relation_type: PASS_RELATION,
        weight: 0.6,
        reasoning: cannedReasoning,
      },
    ],
  });
  // runKnowledgeEdgeProposeNightly is typed for a `Db`; a Tx is structurally
  // compatible for the reads/writes it performs.
  const result = await runKnowledgeEdgeProposeNightly(dbh as Db, {
    // STUBBED runTaskFn — zero token, deterministic. TaskTextResult shape
    // ({ text, task_run_id?, cost_usd? }); task_run_id is optional (omit).
    runTaskFn: async () => ({ text: cannedOutput, cost_usd: 0 }),
  });
  console.log('[seed-synthetic] nightly result', result);
}

export interface ObserveReport {
  fsrs_due_overdue: number;
  fsrs_never_reviewed: number;
  proposal_signal_kinds: number;
  edge_propose_pass: number;
  edge_propose_rubric_rejected: number;
  l2_tighten_medium_to_strong: boolean;
  active_subjects_detected: number;
}

export async function printReport(dbh: DbLike, now: Date = new Date()): Promise<ObserveReport> {
  // 1. FSRS due count (overdue slice) + never-reviewed synthetic failure slice.
  const dueRows = await dbh
    .select({ id: material_fsrs_state.subject_id })
    .from(material_fsrs_state)
    .where(
      and(
        eq(material_fsrs_state.subject_kind, 'question'),
        sql`${material_fsrs_state.due_at} <= ${now.toISOString()}::timestamptz`,
        sql`${material_fsrs_state.subject_id} LIKE ${'synthetic:q:%'}`,
      ),
    );
  const neverReviewed = (await dbh.execute(sql`
    SELECT count(DISTINCT e.subject_id)::int AS n
    FROM "event" e
    WHERE e.action = 'attempt' AND e.subject_kind = 'question' AND e.outcome = 'failure'
      AND (e.payload->>'__synthetic') = 'true'
      AND e.subject_id LIKE 'synthetic:q:%'
      AND NOT EXISTS (
        SELECT 1 FROM "material_fsrs_state" m
        WHERE m.subject_kind = 'question' AND m.subject_id = e.subject_id
      )
  `)) as unknown as Array<{ n: number }>;

  // 2. proposal_signals rows with total > 0 + acceptance_rate, grouped by kind.
  const rates = await getProposalAcceptanceRates(dbh);

  // 3. edge propose events: PASS (no rubric_verdict) + rubric-rejected.
  const passProposes = (await dbh.execute(sql`
    SELECT count(*)::int AS n FROM "event"
    WHERE action = 'propose' AND subject_kind = 'knowledge_edge'
      AND (payload->'rubric_verdict') IS NULL
      AND (payload->>'from_knowledge_id') LIKE 'synthetic:%'
      AND (payload->>'to_knowledge_id') LIKE 'synthetic:%'
  `)) as unknown as Array<{ n: number }>;
  const rejectProposes = (await dbh.execute(sql`
    SELECT count(*)::int AS n FROM "event"
    WHERE action = 'propose' AND subject_kind = 'knowledge_edge'
      AND (payload->'rubric_verdict'->>'ok') = 'false'
  `)) as unknown as Array<{ n: number }>;

  // 4. L2 gate-bump on the sized dismiss relation.
  const bump = await resolveEdgeGateBump(
    dbh,
    L2_DISMISS_RELATION,
    PROPOSAL_FEEDBACK_BUDGET,
    PROPOSAL_GATE_BIAS_CONFIG,
  );

  // 5. active subjects detected.
  const active = await listActiveSubjectsSinceRefresh(dbh as Db, { now });

  const report: ObserveReport = {
    fsrs_due_overdue: dueRows.length,
    fsrs_never_reviewed: neverReviewed[0]?.n ?? 0,
    proposal_signal_kinds: rates.length,
    edge_propose_pass: passProposes[0]?.n ?? 0,
    edge_propose_rubric_rejected: rejectProposes[0]?.n ?? 0,
    l2_tighten_medium_to_strong: bump.tightenMediumToStrong,
    active_subjects_detected: active.length,
  };

  console.log('\n=== Station 1 — what lit up ===');
  console.table(report);
  console.log('proposal acceptance rates:', rates);
  console.log(
    'active subjects:',
    active.map((a) => ({ subjectId: a.subjectId, maxCreatedAt: a.maxCreatedAt })),
  );
  console.log('L2 gate bump (relation=%s):', L2_DISMISS_RELATION, bump);
  return report;
}

// ── CLI entry ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  const reseed = args.includes('--reseed');
  const observe = args.includes('--observe');
  const now = new Date();
  if (reset) {
    await runReset(db);
    if (reseed) await runSeed(db, now);
  } else if (observe) {
    await runObserve(db, now);
  } else {
    await runSeed(db, now);
  }
}

// Only run the fence + main when executed as the CLI entry point. Importing this
// module (e.g. from the DB test) is side-effect-free.
const isEntry =
  typeof process.argv[1] === 'string' && process.argv[1].endsWith('seed-synthetic.ts');
if (isEntry) {
  assertProdFence();
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed-synthetic] failed', err);
      process.exit(1);
    });
}
