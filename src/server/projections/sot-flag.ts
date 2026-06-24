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
// Read per-call (a cheap `process.env` read) so tests can parameterize OFF/ON; in prod the
// env is fixed at boot, so the effective activation/rollback unit is an env change + restart.
export function projectionIsWriter(): boolean {
  return process.env.PROJECTION_IS_WRITER === '1';
}
