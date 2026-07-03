# SoT-flip rollback & operations runbook (YUK-548)

> Operational companion to `docs/design/2026-07-03-sot-flip-oracle-spec.md` §7. Governs flipping /
> rolling back `PROJECTION_IS_WRITER*` for the projection entities.

## 1. Flip = STOP-THE-WORLD, never rolling

The flag is read per-process from `process.env` in BOTH the API and the worker
(`projectionIsWriter` → `sot-flag.ts`; call sites across `actions.ts`, `goal-create.ts`,
`proposal-appliers.ts`, `variant_gen.ts`, `variant_verify.ts`, `block-structured-edit.ts`). A rolling
`up -d` of one container leaves an **app-ON / worker-OFF skew window** where the same row is written by
two writer semantics and the parity assert is skipped on the ON side.

**Therefore flip AND rollback must be stop-the-world:**

```
docker compose ... down          # stop app + worker together (no requests / jobs in flight)
# edit the flag in docker-compose.mac.yml (or the NAS .env)
docker compose ... up -d --build
```

Do **not** rolling-recreate a single container. n=1 owner flips in a quiet window, so the downtime is
negligible. At boot each process prints its flag vector (`warnFlipOrder` → `[sot-flag] flag vector at
boot: …`) so the owner can eyeball app-vs-worker agreement (the CHEAP cross-process guard — the spec
REJECTs a heavyweight shared-fingerprint table as over-engineering for n=1).

## 2. Rollback ≠ data repair (honest record)

Rollback = unset the flag + stop-the-world rebuild. The imperative writer resumes as the row writer
**from that moment** (it never disappeared — ON just stopped calling it; `sot-flag.ts:3-5`). But rows
written by the fold DURING the ON window are **left as-is** — rollback does not rewrite them.

- ON-window fold-written rows are **BY DEFINITION authoritative** (they passed the flip gate's
  `fold == imperative row` check at cutover). Rollback is a **write-path retreat**, NOT a "restore full
  verification".
- There is **no `events → imperative` independent rebuild tool** — the only rebuild
  (`rebuild-projection.ts`) re-runs the SAME fold reducer, so it cannot serve as a cross-check. This is
  the dual of the N-version independent write path Q1 rejected; it is an **accepted residual**.
- The `docker-compose.mac.yml` comment "the double-write never stopped … zero data loss" is **imprecise**:
  during ON it is a **single (fold) write**, not a double write; and "zero data loss" holds only for
  **deletions**, not for **value drift**.
- If the Q4a sweep / Q4b golden-reaudit flags an ON-window fold bug that corrupted rows: rollback
  **stops the bleeding** (no future fold writes) + `pnpm audit:golden --kind=<X>` (Q4b) locates the
  drifted rows + the owner repairs them **by hand** (evidence-first, never auto).

## 3. Reverse rollback order (flip-order dependency)

The learning_item retract path ALSO archives paired `artifact` rows + emits artifact lifecycle events
(`src/server/proposals/actions.ts:1308-1325` — grounded W3 coupling). So if **learning_item is ON**,
an **artifact-only** rollback must roll back **learning_item first**:

```
# WRONG: rollback artifact while learning_item stays ON
# RIGHT: rollback learning_item, THEN artifact  (or roll both back together)
```

`warnFlipOrder` prints a WARN at boot when `learning_item ON && artifact OFF` — it is a **WARN, never a
boot-throw**: a boot-throw would BRICK app+worker during exactly that single-entity rollback (a rollback
deadlock, and it contradicts "each entity flips independently"). The hard ordering check is this human
runbook step, not a runtime invariant.

`docs/…` runbook §4 discipline "don't flip everything at once" is retained.

## 4. Current live flag state (2026-07-03)

3/6 ON (see git-tracked `docker-compose.mac.yml`, now committed by YUK-548 slice 5):

| flag domain | subject_kind(s) | state |
|---|---|---|
| `PROJECTION_IS_WRITER` (bare global) | knowledge, knowledge_edge | **ON** (W1) |
| `PROJECTION_IS_WRITER_ARTIFACT` | artifact | **ON** (W3-D) |
| `PROJECTION_IS_WRITER_QUESTION_BLOCK` | question_block | **ON** (W3-D) |
| `PROJECTION_IS_WRITER_GOAL` | goal | OFF |
| `PROJECTION_IS_WRITER_MISTAKE_VARIANT` | mistake_variant | OFF |
| `PROJECTION_IS_WRITER_LEARNING_ITEM` | learning_item | OFF |

## 5. question_block stop-the-world rollback drill

**Purpose** (spec §7 / dossier gap 7): prove the rollback path is not merely a doc promise by
exercising a real stop-the-world unset + rebuild on the lowest-risk ON entity (question_block).

**Procedure** (owner, on the mac compose stack, in a quiet window):

```
# 0. confirm ON + capture the current fold state
docker compose -f docker-compose.yml -f docker-compose.mac.yml logs app | grep 'flag vector at boot'
#    → expect question_block: true

# 1. stop-the-world
docker compose -f docker-compose.yml -f docker-compose.mac.yml down

# 2. unset PROJECTION_IS_WRITER_QUESTION_BLOCK in docker-compose.mac.yml (app + worker blocks)

# 3. rebuild
docker compose -f docker-compose.yml -f docker-compose.mac.yml up -d --build app worker postgres

# 4. confirm the OFF path resumed
docker compose ... logs app | grep 'flag vector at boot'   # → question_block: false
#    create/edit a question_block; confirm the imperative row writer produced it (parity assert active).

# 5. re-flip ON (reverse of steps 1-3, setting the flag back to "1").
```

**Status**: procedure documented + the boot flag-vector print (`warnFlipOrder`) that makes step 0/4
observable is landed (YUK-548 slice 5). **Live execution is owner-gated** — it is a production
stop-the-world compose operation on the running stack; recording a fabricated result would violate the
no-fake-completion rule. Record the actual `flag vector at boot` lines + step-4 observation here after
the owner runs it.

## 6. Oracle operations

- **Q4a** `projection_oracle_sweep` — weekly (Mon 04:30) REPORT-ONLY. Owner reviews the
  `[projection-parity] oracle …` logs each week. The only automatic action on a non-CLEAN finding is a
  log + a fold-inert forensic breadcrumb — **no entity-table write, no auto-repair, no alerting**.
- **Q4b** `pnpm audit:golden --kind=<X>` — NOT a cron. Run per the pre-PR checklist
  (`docs/design/2026-07-03-golden-reaudit-checklist.md`) when a reducer/gather change touches an ON
  entity.
