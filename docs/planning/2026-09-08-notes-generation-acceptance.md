# YUK981 — Notes generation contract from actual acceptance

## Observed failure, not rollout completion

At 2026-09-07T17:53–17:54Z, source395d5d2d/runtime93df0528 ran a component
worker against isolated `loom_notes_887_actual_v1`. A fixed test outline produced
a proposal through the real planning writer; public acceptance committed the
LearningItems, note artifacts and generation intent. The process paused at the
existing post-commit dispatcher seam and was SIGKILLed (exit137). No generation
job existed before death. A new process ran the real `recoverNoteHandoffs`,
created and physically fetched generation job `986113e1-c7c1-5527-a401-d0155f84a697`.
The fixed outline is not an Agency actual-provider acceptance.

Real NoteGenerateTask `bymy8ayqi4gq7q7tvizfk2ep` used Xiaomi `mimo-v2.5-pro`:
HTTP200/end_turn, 768 input / 2894 output tokens. Raw source_markdown included an
unescaped quotation inside JSON; strict parser failed at position460. Artifact
`rcz6xs92e1rzjdui5em1o0uw` correctly became `failed`, not ready; verification was
never dispatched. Task provider success does not mean note business success.
Both temporary processes are terminal (accept137, generate1). The isolated
physical job remains active with no worker; it must not be automatically replayed.

This establishes accept-to-generation recovery across process death, but does
**not** pass the Notes generation/ready-to-verification scenario. There is no
production incident or production data mutation claimed.

## Instrumentation and spending

The source bundle changes only Xiaomi's provider URL to a test-local bounded
transport. Real Agent SDK0.3.220, runner, task prompt/parser, DB and owner handlers
remain in use. Only the proxy has the real key; no raw CoT is saved. The proxy
allows two requests per phase, 64KB input and 8192 output tokens; stops on failure.
One unsupported non-generation route was rejected locally, zero upstream charge.
Only one generation request reached Xiaomi; no verification request occurred.

The task cost estimate is $0.00285186, not an invoice. The full $1 conservative
run reserve is retained. Together with Memory failed $1 and passed $1, the
transferred $3 pool has $0 remaining. Original $10 accounting is unchanged.
Further paid calls wait for owner authorization; local repair can continue.

Private `notes-887-actual-v1.json` SHA256:
`9cb3c1af92dffd99c35d619cabf56d64ff1fc2a9f94b8dabe5fa402e280d338c`.
Worker bundle SHA256: `e5617586c86e2754923a56880aaab6d3017247504db6e9f89b3163f42c16966c`.
Controller SHA256: `2ac47b6b618ad4f5078c976276061b11052c1969f00e8aa07c962aa993ef4eb6`.
Input digest: `82b6e93cfb65f8d79fc1fe0c9a60aa427a05d5060d6af147fff719ffdb4d3372`.
Response digest: `09fca834f3b0938c38706ff647eb638bbc17078655e3349887e9e15a9810e276`.

## Correction constraints

Current generation asks the model to duplicate prose as source_markdown and PM
content, and to manufacture deterministic editor metadata. YUK981 will narrow
that responsibility while retaining ADR0020/0022 block-tree richness, atomic
semantic kinds, long/hub shape, cross-links, editing and undo. No generic JSON
guess/repair and no plain-text downgrade. Interface decision is under review;
no successful post-fix actual sample is claimed yet.

## Current implementation, not yet delivered

The bounded design consultation found a consequential omitted-source regression:
current NoteBlocks, NoteEditor and KnowledgeDetail read source_markdown directly.
An actual shipped-reader helper regression was RED on the omit-only candidate.
The corrected Notes-owned materializer now derives the source mirror from the
single model-authored PM body, preserving content structure, text, lists, marks,
links and math text. The model cannot mint block IDs or claim human verification;
initial generation supplies IDs and trust defaults. Unsupported content/marks
and system-owned auto-links fail before persistence; malformed JSON still fails.

Provider-facing legacy sections input was retired. Downstream sections readers
remain a compatibility projection, not another generated document format. The
three subject skills no longer repeat editor metadata requirements; the task
prompt owns the compact output contract and explicit-target-only link policy.
No UI, API, DB schema, generic JSON repair or new markup parser is introduced.

Twelve scoped unit checks including the actual source-only reader helper pass.
Final coverage is 59 scoped DB tests (58 Notes generate/verify/handoff plus one
rich-body/backlink persistence case), typecheck, lint, build and architecture audit.
Independent code review, exact CI and post-fix real output remain pending.
No deployment of YUK981 and no additional paid call are claimed.

## Initial review and follow-up

PR1365 initial review found two P1 blockers. Root independently reproduced the
editor issue through the real rendered NoteEditor: one character edit removes a
nested bulletList. This predates the PR (old prompt already allowed rich PM, and
NoteEditor is unchanged), but is incompatible with the intended final outcome.
The reproduction patch is retained privately as `note-editor-loss-repro.patch`;
no pending RED UI test or UI production code is left in the worktree. The seven-file
[rich-edit preflight](../design/2026-09-08-notes-rich-edit-preflight.md) awaits
owner approval. The single verification review is reserved until both findings
are addressed; no second initial review.

The reference finding is corrected locally: Notes queries at most twelve real,
unarchived targets in the note family or shared knowledge labels; each target has
at most eight block summaries. Pending notes remain valid artifact-level targets,
without invented body content. Only supplied artifact/block IDs may be persisted.
Seventeen generation DB cases pass, including positive backlink identity and
out-of-scope/archived/invented-block rejection with no ready content.

CI34150838539 on ed63127bc completed: both DB shards, production build, usability,
migration and type/lint/audits passed; two obsolete Notes prompt assertions failed.
The migration-only hash excludes the intentionally evolved Notes prompt, and the
policy test now expects server-owned metadata rather than instructing the model
to fill it. The 115 affected unit checks pass; local typecheck/lint/build pass.
No blind retry of the old CI run was requested.

Clean image ed63127b built successfully (SHA256
`f13c68503eff0b88d12c2ad0bd35812694b47e5e7d9cf7bc8c0644e590acf78f`);
it predates the reference correction and is not deployed or accepted for release.
Production remains93df0528. Budget and UI approvals are still pending.
