# YUK-55 — Note verification badge

**Goal:** 在 learning item 阅读视图里把 NoteVerifyTask 状态收敛成可点开的 badge，让用户能快速判断 note 是否可信，并在 failed / needs_review 时看到 issues。

## Design Pre-Flight

- Badge 放在 artifact header 的 status row 内，紧邻 generation status，不抢占正文阅读空间。
- 用 native `details/summary` 实现点击展开；无需引入 tooltip JS 状态。
- Badge tone 映射：
  - `verified` -> good
  - `queued` / `pending` / `not_started` -> info
  - `needs_review` / `outdated` -> warn
  - `failed` -> again
  - `not_required` -> neutral
- Panel 中展示状态说明、summary、issues 列表；issue message 是纯文本，suggested fix 继续留给下方 markdown verification panel 渲染。

## Scope

- Add `src/ui/components/NoteRenderer/VerificationBadge.tsx`.
- Export it from `src/ui/components/NoteRenderer/index.ts`.
- Replace the raw verification status span in `app/(app)/learning-items/[id]/page.tsx`.
- Add unit tests for the status mapping and issue expansion HTML.

## Out of Scope

- Marking edited sections as `outdated`; YUK-54 section editing will provide the trigger.
- Retry / regenerate note actions.
- Changing the API verification schema.

## Tasks

1. **Red:** add `VerificationBadge` tests for verified / pending / failed / outdated and issue rendering.
2. **Green:** implement the component and wire it into the artifact header.
3. **Verify:** run component tests, targeted page typecheck, Biome, and `pnpm typecheck`.

## Exit

- [x] Note header renders verification badge.
- [x] Failed / needs_review badge expands to issue list.
- [x] `outdated` is supported for the upcoming edit-in-place lane.
- [x] Touched UI tests and typecheck pass.
