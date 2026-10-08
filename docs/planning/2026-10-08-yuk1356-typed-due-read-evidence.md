# YUK-1356 bounded typed due read evidence

This delivery extracts the existing actionable HTTP due queue into `queryReviewDue(activeDb, input, deps)`. It returns typed `ReviewDueRow[]` without a Request or Response. `handleReviewDue` delegates to it and retains URL `parseInt` behavior, defaults, clamps, JSON serialization and error mapping. The existing HTTP handler is the live consumer. YUK-1377 owns the later Today adaptation.

## Source and ownership

- Worktree: `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk1356-typed-due-read`.
- Branch: `feat/yuk-1356-typed-due-read`.
- Base: `1bbd82795290931ac99b7669abf93fab83e2b56b`.
- Recovery source: immutable `git show b191ea714747eb468e1a55d88928a3f882470ac6`, limited to the typed declaration and due-query tests. Immutable `2f45f62cb5941b284046f4207fcab15212c35bf1` was compared for this due file. No whole commit was cherry-picked.
- The original review-operation worktree and its dirty trusted Pi work were never read or modified.
- Owned implementation files: `src/capabilities/practice/server/due-list.ts`, `src/capabilities/practice/server/due-list-query.db.test.ts`, and minimal exports in `src/capabilities/practice/public.ts`. This is the only evidence document.

The typed read requires an explicit `Db | Tx`, supports `queryReviewDue(db, { limit: 200 })`, and contains no global `db` access. `input.limit` defaults to 20, truncates fractions, substitutes 20 for NaN, and clamps to 1–200. `input.now` permits a deterministic due horizon. The public value is lazy, matching the existing HTTP export's import behavior.

A source comparison against the base confirms the scheduling body is unchanged after removing the local output type and ignoring indentation. The following helper functions are byte-identical. The extraction retains draft/suspension admission, existing probe/frozen-read paths, variant rotation, never-reviewed exclusions, cross-subject round-robin, goal soft ordering, correction state and diagnostic-answer suppression. This verifies preservation of baseline behavior, not new native scoring or frozen-snapshot acceptance.

`executeGetReviewDue` and the Pi tool were not changed. The recovered diagnostic tests verify never-reviewed/overdue rows, future projections, knowledge filtering, unknown queue completeness and zero-page assertions independently of the actionable queue.

### Immutable due-list Git blobs

| Commit | Due-list blob |
| --- | --- |
| `1bbd82795290931ac99b7669abf93fab83e2b56b` | `ab6bbf332a33a149dac745446d13e5ed476e5970` |
| `b191ea714747eb468e1a55d88928a3f882470ac6` | `711c052625b12430881690968f378c49249730b4` |
| `2f45f62cb5941b284046f4207fcab15212c35bf1` | `711c052625b12430881690968f378c49249730b4` |

### Tested source SHA-256

| File | SHA-256 |
| --- | --- |
| `src/capabilities/practice/server/due-list.ts` | `4b4f81c96754e4063de5db48e784c141d09492930034668463ea845876803c69` |
| `src/capabilities/practice/public.ts` | `300cafaca5d085b70bc27b62e729c53a3bdc96d0035bab6b66d3c621b806a026` |
| `src/capabilities/practice/server/due-list-query.db.test.ts` | `d961640961f142584b4c3ca24a746dfbc76c0bff0dae16926db5df43ffce72a3` |
| `pnpm-lock.yaml` | `7b1a3254d428b208c15ae5b86f831c76ae3d327018f47584cc84a7a6c27f9cf5` |

## Verification

All package commands used a clean environment with Node `v24.19.0`, pnpm `11.13.1`, no inherited provider credentials, and the explicit owned workdir. The local wrapper `/tmp/yuk1356-typed-due-run.py` captures each command's exit status and log. Frozen install left `pnpm-lock.yaml` byte-identical to the base.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Exit 0 |
| `pnpm typecheck` | Exit 0 |
| `pnpm lint` | Exit 0; 297 existing warnings |
| `pnpm build` | Exit 0; Vite, server, worker and migrate bundles built; size warnings remain |
| `pnpm exec biome check src/capabilities/practice/server/due-list.ts src/capabilities/practice/server/due-list-query.db.test.ts src/capabilities/practice/public.ts` | Exit 0, no warnings or fixes |
| `git diff --check` | Exit 0 |
| Source preservation and lockfile byte comparison | Passed; receipt below |
| Scoped DB command below | Exit 0; 7 files, 67 tests passed; 6 new due-query tests |

```bash
pnpm vitest run --config vitest.db.config.ts \
  src/capabilities/practice/server/due-list-query.db.test.ts \
  src/capabilities/practice/api/due.db.test.ts \
  src/capabilities/practice/api/due-part-regression.db.test.ts \
  src/capabilities/practice/api/due-soft-bias.db.test.ts \
  src/capabilities/practice/api/due-cross-subject.db.test.ts \
  src/capabilities/practice/api/due-source-tier-projection.db.test.ts \
  src/capabilities/practice/server/variant-rotation.db.test.ts
```

The injected-DB test inserts the mixed question/knowledge/FSRS/failure fixture inside an uncommitted transaction and invokes the lazy public export with that transaction. It verifies the complete selected rows, subject and goal ordering, correction identity, JavaScript Date values and the goals reader's exact transaction argument. It then rolls back and verifies no fixture rows remain. A singleton connection cannot see that fixture, so the result proves use of the injected DB rather than the singleton.

The limit test uses 205 due questions with long CJK prompts and references. It checks the default, NaN, negative, fractional, infinite and oversized typed limits, exact due-horizon inclusion, text truncation, and parseInt-compatible HTTP strings. The remaining tests cover mapped HTTP errors, typed error propagation and the separate diagnostic contract. Existing scoped due tests retain recall/application rotation, synthetic-root exclusion, reviewed-knowledge exclusion, subject balancing and goal soft ordering.

### Runtime coordination

No DB/container test ran while YUK-1377 held its lock. An initial outer runtime coordination directory was released after checking its ownership; only a read-only Docker version check had run. After the parent's explicit release notification, the corrected current lock at `/Volumes/YukovalSBak/yukoval-projects/tlp-local-prod-20260907.sjUaCU/deployment-20261007/deployment.lock` was rechecked and acquired atomically. Owner token `5fd77701-8f34-4368-9316-eebd54f4b68c` protected only this disposable Testcontainer suite. Vitest global teardown completed before the owner-checked lock release. The post-test inventory showed only the four healthy main services. No main service or retained database was changed or stopped.

### Local evidence SHA-256

| Receipt | SHA-256 |
| --- | --- |
| `/tmp/yuk1356-typed-due-install.log` | `25bc8a931d5c0c2f3b4162bf0f1af6d103562878c3140961bac67891a4e4c761` |
| `/tmp/yuk1356-typed-due-typecheck.log` | `8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92` |
| `/tmp/yuk1356-typed-due-lint.log` | `74f3e2330ab06a3aba054774771da3da238e20d74be53e5b51eb9ebe0623df7e` |
| `/tmp/yuk1356-typed-due-build.log` | `c1739a5190f95bd3cde4ce7d2eff303f224a61080bf501cd0aadc32d6fba5e2a` |
| `/tmp/yuk1356-typed-due-db.log` | `0d328f5323d238c420f69f67734b8b19f955bd987fe5c7aa67058e7fcf01bf2e` |
| `/tmp/yuk1356-typed-due-focused-biome.log` | `28ce1b9ce2d39e1090809e245146fae10d13da3fe721d043ee70e1522de1dae6` |
| `/tmp/yuk1356-typed-due-source-check.json` | `cb588621790947e62866209c8749c6900c36e8d54c2a49bf3e1179b14e83c78e` |
| `/tmp/yuk1356-typed-due-db-cleanup.json` | `bfbc5e362b969ae7f215089f679cda26cc624c8c17ea96122fc311d9cf82b47b` |

## Limits and handoff

This is the bounded typed read delivery, not completion of all YUK-1356. No full `pnpm test`, paid/provider call, private environment read, replay, worker execution, live acceptance, deployment, push, PR, watch, Linear mutation or child delegation occurred. No package/dependency, shell, Today, Start, manifest, kernel, scoring, recovery or worker source changed. No new actionable defect was found in this lane; inherited lint and bundle-size warnings remain. The parent owns independent review, Linear reconciliation/capture, exact-head CI, merge and any later runtime acceptance.
