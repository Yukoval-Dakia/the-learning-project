# Versioned OpenCode worktree plugin

This directory contains the repository-owned OpenCode worktree plugin. Its source-adjacent
`plugins/package.json` and exact Bun lock are isolated from OpenCode's runtime-managed root
`.opencode/package.json`, so ordinary sessions cannot rewrite the versioned dependency manifest.
Runtime/user configuration such as `worktree.jsonc`, SQLite state, and `node_modules/` stays
untracked.

Run the isolated checks with:

```bash
cd .opencode/plugins
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run lint
```

The delete path is intentionally fail-closed: callers must commit or discard changes explicitly
before requesting cleanup. The plugin never stages files, creates snapshot commits, or invokes
`git worktree remove --force`.

The repository hooks remain the canonical policy for explicit staging/commits (including
artifact and credential safeguards). Cleanup does not duplicate that policy: it refuses every
worktree containing tracked modifications, untracked files, or ignored files before running hooks
or removal, so hidden artifacts and credentials cannot be deleted and there is no plugin-owned
staging surface to guard separately.
