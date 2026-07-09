---
name: pr
description: PR workflow for this repo — opening PRs and resolving code-review bot threads (CodeRabbit / OCR github-actions / codex / Cursor). Use when preparing a PR, or after addressing review findings and needing to resolve the corresponding review threads.
---

# PR Workflow
1. Run tests and lint locally
2. Organize changes into logical commits (squash WIP)
3. Push branch and open PR with summary + test plan
4. Address review comments iteratively, re-running CI between rounds

## Resolving review bot threads

After addressing review findings on a PR, resolve the corresponding review threads (CodeRabbit / OCR github-actions / codex / Cursor bots). For findings you intentionally skip, reply with the rationale first, then resolve (or leave for the owner). Do this *after* the fix is committed + pushed, so threads anchor to the landed diff.

Mechanics: `pull_request_read` method `get_review_comments` → thread node IDs (`PRRT_…`); `pull_request_review_write` method `resolve_thread` (threadId); `add_reply_to_pull_request_comment` for skip rationale.

Rationale: approval-gate bots (e.g. Cursor's "未批准 / Risk medium") stay stale-blocked while threads are unresolved, and the unresolved-conversation count misrepresents reality. Resolving threads is cleanup only — it never authorizes a merge by itself (see CLAUDE.md's Merge policy for who/when may actually merge).
