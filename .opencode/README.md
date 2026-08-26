# OpenCode worktree plugin

This repository does not own OpenCode's user configuration or third-party npm plugin versions.
OpenCode loads those from the user's configuration directory. Do not add project-level
`opencode.json`, provider, authentication, model, telemetry, Magic Context, or Oh My OpenAgent
configuration here.

The repository owns only the local worktree plugin under `plugins/`. Its package manifest and Bun
lock contain the dependencies needed to typecheck, lint, and test that plugin; they do not control
OpenCode's npm plugin cache.

Run its checks with:

```bash
pnpm test:opencode-worktree
```

The delete path is intentionally fail-closed: callers must commit or discard changes explicitly
before requesting cleanup. The plugin never stages files, creates snapshot commits, or invokes
`git worktree remove` (forced or otherwise).

Cleanup refuses every worktree containing tracked modifications, untracked files, or ignored files
before running hooks. After a clean check, the complete directory is atomically moved beneath
`<worktree>.preserved-by-opencode/worktree`; Git registration is pruned without recursively deleting
that retained directory. A restrictive marker is left at the original path and both markers name
the preservation location. Inspect and remove the preservation root manually when it is no longer
needed. Because Git's prune command is repository-wide, cleanup also refuses to run it when
porcelain reports another prunable worktree registration.
