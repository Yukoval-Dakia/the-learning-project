# Versioned OpenCode plugins

The repository owns two separate surfaces here:

- `.opencode/opencode.json` is the credential-free project config. It pins every npm plugin to an
  exact version. OpenCode 1.18.10 merges global config first and project config later, then
  deduplicates npm plugins by package name with the later declaration winning. The project pins
  therefore replace the same packages declared as `@latest` in a user overlay without changing
  that user-owned config. Unrelated user plugins remain user-owned.
- `.opencode/oh-my-openagent.json` and the equivalent root `oh-my-openagent.json` disable only the
  three Oh My OpenAgent compaction hooks that conflict with Magic Context. The OpenCode config also
  disables native auto-compaction, leaving Magic Context as the single compaction owner. These
  project-owned compatibility settings merge
  over user defaults; they contain no provider, auth, model, or telemetry values. Both files are
  required because Oh My OpenAgent 4.17.0 discovers project config under `.opencode/`, while Magic
  Context 0.33.0's conflict detector reads the root filename. The gate requires the copies to stay
  identical.
- `plugins/package.json` and `plugins/bun.lock` are the only tracked project package-manager
  manifest/lock and form the reviewed resolution **superset**. They directly control the local
  worktree plugin's development dependencies. They do not directly control OpenCode's npm cache.

OpenCode 1.18.10 resolves each configured npm spec into a disposable cache with npm Arborist and
lifecycle scripts disabled. Its transitive ranges are therefore not locked by `bun.lock` at install
time. The gate closes that observation gap after an isolated default-Arborist resolution: every
runtime package path/name/version/integrity must be present in the reviewed Bun superset, and each
plugin's normalized full-graph count and SHA-256 must match the inventory. Missing, added, changed,
or newly duplicated nested paths all fail. This is a continuous drift detector, not a claim that
Arborist consumes the Bun lock; run it before restarting OpenCode after any dependency change.

Ordinary OpenCode sessions may generate ignored root `.opencode/package.json`, `package-lock.json`,
and `node_modules/`. Those runtime files are not project lockfiles and must never be committed. The
supply-chain gate rejects any tracked OpenCode lock except `plugins/bun.lock`. Runtime/user
configuration such as `worktree.jsonc`, SQLite state, and provider/auth/telemetry settings stays
untracked and is not read or copied by the gate.

## Existing checkout migration

Older checkouts may already have an ignored local `.opencode/opencode.json`. Before pulling this
tracked config, back that file up outside the repository and remove the old copy so Git cannot
overwrite local-only settings. Do not change `~/.config/opencode/*`: project exact pins supersede
same-package global `@latest` entries, while unrelated global plugins remain user-owned. Rollback is
the reverse Git revert; restore the old ignored project file only if its non-secret settings are
still required.

Run the isolated checks with:

```bash
cd .opencode/plugins
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run typecheck
bun run lint
bun run verify:supply-chain
```

The final command uses the exact platform artifact installed by pinned `opencode-ai@1.18.10` twice.
It executes that artifact directly, so the wrapper's `postinstall` remains disabled and cannot run
an unreviewed fallback install. First, `opencode debug config --pure` resolves a synthetic,
credential-free user overlay and proves project pins win. Then a localhost server runs against a
temporary git workspace with a temporary HOME/cache/data/log directory and default Arborist
optional-dependency semantics. It loads the real plugins through `/experimental/tool/ids`, checks
their identifying tools, validates the complete normalized npm graphs described above, and asserts
that repository status is unchanged. No provider config, auth material, existing telemetry
preference, or user plugin state is passed to that process.

## Runtime inventory

Machine-readable versions, integrity values, upstreams, and identifying tool IDs live in
[`plugins/supply-chain/inventory.json`](plugins/supply-chain/inventory.json). Operational owner for
all entries is **Yukoval Studios / Tooling**.

| Plugin | Source / pinned version | Permissions and side effects | Rollback |
| --- | --- | --- | --- |
| Magic Context | [`@cortexkit/opencode-magic-context@0.33.0`](https://github.com/cortexkit/magic-context) | Runs in-process context hooks; can read conversation/tool history and project/git content, write durable SQLite memory and logs under the CortexKit/OpenCode data directories, invoke configured background models, and download a local embedding model when that feature is enabled. | Revert config + manifest + lock + inventory to the previous exact version, restart OpenCode, and keep the durable CortexKit database unless an explicit data rollback is required. |
| Skillful | [`@zenobius/opencode-skillful@1.2.5`](https://github.com/zenobi-us/opencode-skillful) | Scans global/project skill directories, injects selected skill text into the conversation, and lets the agent read declared skill resources. Skill scripts are exposed as resources but execution still goes through ordinary agent tools and permissions. | Revert the tracked config, manifest, lock, and inventory to the previous exact version and restart OpenCode. Existing skill files are not modified. |
| Oh My OpenAgent | [`oh-my-openagent@4.17.0`](https://github.com/code-yeongyu/oh-my-openagent) | Runs in-process orchestration hooks; can spawn background agents/processes, read sessions/project instructions, inject network-capable MCP tools, and write its own local state/config. It carries a PostHog client dependency; verification sets `DO_NOT_TRACK=1` rather than changing user telemetry configuration. | Revert the tracked config, manifest, lock, and inventory, restart OpenCode, then inspect/retain local `.omo`/OpenCode state separately. Do not fall back to the global `@latest` entry. |
| Worktree | local `.opencode/plugins/worktree.ts` at repository HEAD | Creates Git worktrees, copies/symlinks configured files, launches terminals, and writes local SQLite session state. Delete is fail-closed and preserves lane files as described below. | Revert the responsible repository commit and run the same plugin gate before restart. Preserve pending cleanup state and retained worktrees for manual audit. |

The former bare `list` entry was removed. The resolved package was the unrelated immutable-list data
structure `list@2.0.19`; it exposes no OpenCode plugin entrypoint and registered no tool in the
before/after runtime inventory, so it had no live consumer.

## Known advisories and risk boundary

The current locked graph is **not `bun audit` clean**: it has three High advisories
(`GHSA-xcpc-8h2w-3j85`, `GHSA-f88m-g3jw-g9cj`, `GHSA-mh99-v99m-4gvg`) and one Low advisory
(`GHSA-4x5r-pxfx-6jf8`). YUK-813 makes that graph exact and drift-detectable; it does not claim to
remediate those transitives. [YUK-831](https://linear.app/yukoval-studios/issue/YUK-831) owns the
upstream-compatible remediation and reachability evidence. Until it closes, keep dependency
lifecycle scripts disabled and do not introduce untrusted image/media processing through this
Transformers/sharp graph. Do not mask the findings with overrides outside upstream semver ranges.

## Upgrade procedure

1. Review the upstream changelog, package license, entrypoints, lifecycle scripts, permissions, and
   OpenCode compatibility. Upgrades are separate from unrelated tooling work.
2. Change the exact version in `.opencode/opencode.json`, `plugins/package.json`, and
   `plugins/supply-chain/inventory.json`; refresh the registry integrity in the inventory.
3. Run `bun install --ignore-scripts` in `plugins/`, inspect the full `bun.lock` diff, and run
   `bun audit`. Do not add npm, pnpm, or Yarn lockfiles under `.opencode/`. The exact PostHog
   overrides keep the reviewed Bun superset aligned with the currently observed Arborist graph;
   Arborist itself does not consume those overrides.
4. Run the default-Arborist actual-load check, inspect every graph drift, and update the approved
   package count/hash only after the new paths and Bun resolutions are reviewed.
5. Run `pnpm test:opencode-worktree`; obtain independent review and exact-head GitHub CI before
   merge. Restart OpenCode because npm plugin version changes are not guaranteed to hot-reload.
6. Roll back by reverting the version/config/lock/inventory change together. Never delete a project
   pin while the same package remains `@latest` in a global overlay.

The delete path is intentionally fail-closed: callers must commit or discard changes explicitly
before requesting cleanup. The plugin never stages files, creates snapshot commits, or invokes
`git worktree remove` (forced or otherwise).

The repository hooks remain the canonical policy for explicit staging/commits (including
artifact and credential safeguards). Cleanup does not duplicate that policy: it refuses every
worktree containing tracked modifications, untracked files, or ignored files before running hooks.
After a clean check, the complete directory is atomically moved beneath
`<worktree>.preserved-by-opencode/worktree`; Git registration is pruned without recursively deleting
that retained directory. A restrictive marker is left at the original path and both markers name
the preservation location. Even a background writer that follows the rename therefore writes into
retained storage rather than a directory Git will delete. Inspect and remove the preservation root
manually when it is no longer needed. Because Git's prune command is repository-wide, cleanup also
refuses to run it when porcelain reports any other prunable worktree registration. The absolute Git
common-directory cwd is resolved before the move and persisted as `git-admin-cwd`, so retries never
depend on the original path after it becomes a marker file.
