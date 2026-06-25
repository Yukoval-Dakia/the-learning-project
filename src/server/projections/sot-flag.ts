// YUK-471 W1 PR-B — the SoT-flip gate.
//
// OFF (default): the imperative applier writes the knowledge/knowledge_edge row, and the A2b
// parity assert verifies fold == row (unchanged A2b behavior). This is also the ROLLBACK
// state — flipping back OFF restores full A2b verification.
//
// ON: the projection write-through (projectKnowledge{Node,Edge}) becomes the row writer for
// the wired sites; the imperative row-write is skipped and the (now tautological) parity
// assert is skipped. Drift detection on the ON path moves to the offline `pnpm audit:projection`
// B3 gate.
//
// Activation is the B3 GATED-not-timed cutover: rebuild a prod-clone → `audit:projection`
// CLEAN → set PROJECTION_IS_WRITER=1 in prod env (all three processes — API / worker / Vite —
// the same way AI_PROVIDER_OVERRIDE is injected) → restart. Rollback = unset the flag +
// restart, then re-audit (an ON-window row that drifted would fail the OFF-path assert).
//
// STAGING: PR-B1 wires ONLY the pure-minting INSERT sites (propose_new / auto_tag / edge
// create) — those mint a fresh, event-sourced-this-tx entity, so the projection's fold is
// never null and its delete-on-null branch is unreachable (zero delete risk). The mutation
// sites (reparent / archive / merge / split / edge archive) and the defensive non-delete
// guard (never DELETE a live row that has no genesis anchor) land in PR-B2. The flag stays
// OFF through every PR until the full flip is wired and the B3 gate clears.
//
// ── PER-ENTITY ISOLATION (YUK-471 Wave 2, critic A1 — BLOCKER fix) ───────────────────────────
//
// The bare `PROJECTION_IS_WRITER` global flag gates ONLY knowledge / knowledge_edge — it was
// flipped LIVE (=1, docker-compose.mac.yml) when W1's B3 gate cleared. Wave 2/3 entities (goal,
// mistake_variant, learning_item, …) MUST NOT ride that same global flag: their reducers /
// gather / genesis backfill ship and clear their OWN B3 gate on independent timelines, so a
// W2 entity reading the (already-ON) global flag would flip to projection-as-writer the instant
// its wiring lands — folding an un-backfilled world / corrupting parity in prod.
//
// So `projectionIsWriter` is OVERLOADED:
//   - bare `projectionIsWriter()` → the global `PROJECTION_IS_WRITER` (knowledge/edge, UNCHANGED;
//     the 5 existing call sites keep their exact behavior — backward-compatible).
//   - `projectionIsWriter('goal')` → the PER-ENTITY env `PROJECTION_IS_WRITER_GOAL` (default OFF
//     until goal's own B3 gate clears). Each entity flips independently via its own env var.
//
// This is "defer flip not build" (project memory feedback_defer_flip_not_build): goal's full
// vertical slice — reducer / gather / genesis backfill / event path / write-through wiring —
// ships now; ONLY the act of switching who writes the goal ROW is deferred behind this flag.
// When OFF the imperative insertGoal / UPDATE stays the row writer; when ON the projection
// write-through writes the row. The genesis/event + materialized_id_index ALWAYS write (the
// event log + anchor is the source of truth; the flag only switches the ROW writer).
//
// Read per-call (a cheap `process.env` read) so tests can parameterize OFF/ON; in prod the env
// is fixed at boot, so the effective activation/rollback unit is an env change + restart.

/**
 * Per-entity SoT-flip flag env var name. Wave 2/3 entities extend this map.
 *
 * `as const` (NOT a `Record<string, string>` annotation): the explicit Record annotation widened
 * the KEY type to `string`, so `ProjectionEntity` (= keyof typeof) collapsed to `string` and
 * `projectionIsWriter('typo')` would compile. `as const` keeps the keys as the literal union
 * (`'goal' | …`) so a non-entity arg is a compile error.
 */
const PER_ENTITY_FLAG_ENV = {
  goal: 'PROJECTION_IS_WRITER_GOAL',
  // YUK-471 W2 — mistake_variant fold flips independently (default OFF until its own B3 gate).
  mistake_variant: 'PROJECTION_IS_WRITER_MISTAKE_VARIANT',
  // YUK-471 W2 — learning_item fold flips independently (default OFF until its own B3 gate).
  learning_item: 'PROJECTION_IS_WRITER_LEARNING_ITEM',
} as const;

/** Which named entities have a per-entity SoT-flip flag (the overloaded arg domain). */
export type ProjectionEntity = keyof typeof PER_ENTITY_FLAG_ENV;

export function projectionIsWriter(entity?: ProjectionEntity): boolean {
  if (entity === undefined) {
    // knowledge / knowledge_edge — the original global flag (W1, LIVE). UNCHANGED.
    return process.env.PROJECTION_IS_WRITER === '1';
  }
  // Per-entity flag — independent of the global. Default OFF until the entity's B3 gate clears.
  const envName = PER_ENTITY_FLAG_ENV[entity];
  return envName !== undefined && process.env[envName] === '1';
}
