---
name: pr
description: PR workflow for this repo — opening PRs and resolving code-review bot threads (CodeRabbit / OCR github-actions / codex / Cursor). Use when preparing a PR, or after addressing review findings and needing to resolve the corresponding review threads.
---

# PR Workflow
1. Run tests and lint locally
2. Organize changes into logical commits (squash WIP)
3. Push branch and open PR with summary + test plan
4. Run one independent review pass
5. Fix validated P0/P1 findings and run at most one verification review pass
6. Require the exact-head `CI Gate`; then close out or merge according to repository policy

## Review budget and stop policy

- Automated review is advisory. `OCR review`, `PR-Agent`, Codex, CodeRabbit, and similar review checks are not CI correctness gates.
- The review budget is **one initial pass plus at most one verification pass** after P0/P1 fixes. A new bot review after a push does not reset the budget, and never start a third pass unless the owner explicitly requests it.
- Fix validated P0/P1 findings in the current PR: security, data loss, correctness failures, or release blockers in the changed scope.
- P2/minor/nit/hygiene/refactor/performance suggestions are non-blocking by default. Reply with the skip rationale, resolve the thread, and capture only material actionable follow-ups in Linear after duplicate search. Do not create one issue per nit.
- Once the exact-head `CI Gate` is green and no validated P0/P1 remains, do not wait for or rerun advisory review checks that are pending, failed, cancelled, or timed out.
- Never describe a skipped finding as fixed. The owner can explicitly widen the review budget or request a P2 cleanup pass.

## Resolving review bot threads

After addressing review findings on a PR, resolve the corresponding review threads (CodeRabbit / OCR github-actions / codex / Cursor bots). For non-blocking findings you intentionally skip, reply with the rationale first, then resolve. Do this *after* fixes are committed + pushed, so fixed threads anchor to the landed diff; skipped findings may be replied to and resolved without another code push.

Mechanics: `pull_request_read` method `get_review_comments` → thread node IDs (`PRRT_…`); `pull_request_review_write` method `resolve_thread` (threadId); `add_reply_to_pull_request_comment` for skip rationale.

Rationale: approval-gate bots (e.g. Cursor's "未批准 / Risk medium") stay stale-blocked while threads are unresolved, and the unresolved-conversation count misrepresents reality. Resolving threads is cleanup only — it never authorizes a merge by itself (see CLAUDE.md's Merge policy for who/when may actually merge).
