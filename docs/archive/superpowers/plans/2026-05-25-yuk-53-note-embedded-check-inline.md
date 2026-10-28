# YUK-53 — Note embedded check inline

**Goal:** 收口 atomic note `check` section 的 inline 自检题阅读体验：确认题目只挂在 check section 末尾、提交仍走 `/api/embedded-check/attempt`，并让 judge `unsupported` 结果在 inline feedback 中清楚可见。

**Scope:**

- Reuse `src/ui/components/EmbeddedCheckSection.tsx`; do not add a second embedded-check UI.
- Add unit coverage proving `ArtifactSections` wires the embedded check only for `kind='check'`.
- Add unit coverage for ready embedded-check rendering and unsupported feedback copy.
- Keep FSRS/review queue semantics unchanged; embedded check remains inline-only.

**Out of scope:**

- Retake history, retry/re-enqueue controls, question authoring UI.
- Section edit-in-place; that is YUK-54.
- Verification badge expansion; that is YUK-55.

## Tasks

1. **Red:** add tests for `ArtifactSections` check-section wiring and `EmbeddedCheckSection` unsupported feedback copy.
2. **Green:** expose a small feedback-copy helper and render unsupported judge outcomes as "暂不支持自动判分".
3. **Verify:** run targeted unit tests and touched-file lint/type checks.

## Exit

- [x] Check section renders inline self-check questions.
- [x] Non-check sections do not render inline self-check UI.
- [x] Unsupported judge results do not masquerade as partial correctness.
- [x] `pnpm test:unit src/ui/components/ArtifactSections.test.tsx src/ui/components/EmbeddedCheckSection.test.tsx` passes.
