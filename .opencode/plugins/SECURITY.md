# Security advisories — worktree plugin dependency sweep

Scope: this subtree only (`.opencode/plugins`, Bun-managed, `bun.lock`). The root pnpm
workspace is audited separately; do not push overrides for this tree into the root
`pnpm-workspace.yaml`.

## Latest sweep — 2026-09-16

- Tool: `bun audit` (bun 1.3.14) after `bun install --frozen-lockfile --ignore-scripts`.
- Result: 1 finding, now resolved. `bun audit` exits clean (0 vulnerabilities).

### Disposition

| Advisory | Package | Severity | Path | Disposition |
|----------|---------|----------|------|-------------|
| GHSA-4x5r-pxfx-6jf8 / CVE-2026-49356 | `@babel/core@7.28.0` (vulnerable `<=7.29.0`) | low (CVSS 3.2) | `@opencode-ai/plugin` → optional peer `@opentui/solid@0.4.5` → `@babel/core` exact pin | **Fixed**: `overrides.@babel/core = 7.29.7` in `package.json` (patched floor is 7.29.6). Upstream `@opentui/solid` still exact-pins `7.28.0` even at its latest release (0.5.11), so no direct-dependency upgrade can clear this; the scoped Bun override is the compatible path. |

### Reachability evidence (recorded for future triage)

- The plugin's only runtime imports are `@opencode-ai/plugin` and `@opencode-ai/sdk`;
  no source file under `worktree.ts`, `worktree/`, or `kdco-primitives/` imports
  `@opentui/*` or `@babel/*`. Those packages exist in `node_modules` only because Bun
  installs `@opencode-ai/plugin`'s optional peers.
- The advisory requires all of: attacker-controlled source input to Babel, attacker
  can read the compiled output, and attacker knows the target source-map path on the
  host. This plugin never invokes a Babel transform — there is no untrusted-input path
  into `@babel/core` in this repository.
- Residual exceptions: none.

## Convention for residual advisories

When a future advisory has no compatible patched release, do not force an incompatible
override. Instead add an exception row here with: advisory ID + affected package/version,
why it cannot be upgraded, reachability evidence (why the vulnerable code path is
unreachable or cannot be triggered by untrusted input in this repo), and a review-by
date. An honest documented exception beats a fake clean audit.

## Review cadence

Re-run `bun audit` here roughly every 6 weeks and on any dependency bump in this
subtree. Next review due: 2026-10-28.
