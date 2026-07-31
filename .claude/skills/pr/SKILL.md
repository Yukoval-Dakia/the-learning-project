---
name: pr
description: PR workflow for this repo — opening PRs and resolving code-review bot threads (CodeRabbit / OCR github-actions / codex / Cursor). Use when preparing a PR, or after addressing review findings and needing to resolve the corresponding review threads.
---

# PR Workflow
1. Follow the local scoped-validation boundary in `AGENTS.md`; never run the full `pnpm test` locally
2. Organize changes into logical commits (squash WIP)
3. Push branch and open or update the PR with summary + test plan
4. Run one independent review pass
5. Fix validated P0/P1 findings and run at most one verification review pass
6. Require the exact-head GitHub `CI Gate` to execute the full test gate; then close out or merge according to repository policy

## Review budget and stop policy

- Automated review is advisory, not a CI correctness gate.
- Budget one initial review plus at most one verification review after P0/P1 fixes. Never start a third pass unless the owner explicitly requests it.
- Fix validated security, data-loss, correctness, or release-blocking P0/P1 findings.
- Treat P2/minor/nit/hygiene/refactor/performance suggestions as non-blocking by default. Reply with the rationale, resolve the thread, and capture only material deduplicated follow-ups in Linear.
- When the exact-head `CI Gate` is green and no validated P0/P1 remains, do not wait for or rerun pending/failed/cancelled/timed-out advisory review checks.
- Never claim that a skipped finding was fixed.

## Resolving review bot threads

After addressing review findings on a PR, resolve the corresponding review threads (CodeRabbit / OCR github-actions / codex / Cursor bots). For findings you intentionally skip, reply with the rationale first, then resolve (or leave for the owner). Do this *after* the fix is committed + pushed, so threads anchor to the landed diff.

Mechanics: `pull_request_read` method `get_review_comments` → thread node IDs (`PRRT_…`); `pull_request_review_write` method `resolve_thread` (threadId); `add_reply_to_pull_request_comment` for skip rationale.

Rationale: approval-gate bots (e.g. Cursor's "未批准 / Risk medium") stay stale-blocked while threads are unresolved, and the unresolved-conversation count misrepresents reality. Resolving threads is cleanup only — it never authorizes a merge by itself (see `AGENTS.md`'s merge policy for who/when may actually merge).
