# YUK-59 — Review session-end next-step CTA

**Goal:** Review done 状态不再停在本地统计，把用户引导到 session summary、coach 周报、learning items 和 knowledge 视图。

## Design Pre-Flight

- CTA 放在 `SessionEndSummary` 内的 summary block 之后，作为一组紧凑 action list，而不是再套 card。
- 第一 CTA 固定指向 `/learning-sessions/[id]`；`aiSummary` 已有时标记为 ready，未生成时显示 loading copy，但仍允许进入详情页看事件流/等待异步 summary。
- 其他 CTA 用现有主路由：`/coach`、`/learning-items`、`/knowledge`。
- Mobile 使用单列 grid；desktop 自动铺成 4 列，避免文字挤压。

## Scope

- Update `src/ui/components/ReviewSessionChrome.tsx` `SessionEndSummary`.
- Add SSR component tests for CTA count, route hrefs, and summary loading copy.
- Add focused CSS under existing review session chrome block.

## Out of Scope

- Reminder scheduling; no app-local reminder route exists yet.
- Polling summary generation. Session detail route remains the source of truth.
- Changing session summary API.

## Tasks

1. **Red:** add `SessionEndSummary` tests for CTA grid and summary fallback copy.
2. **Green:** implement CTA action list and responsive CSS.
3. **Verify:** run component tests, Biome, typecheck.

## Exit

- [x] Done state displays at least 3 CTA.
- [x] Session summary CTA links to `/learning-sessions/[id]`.
- [x] Missing summary shows loading/fallback copy.
- [x] Mobile layout is single-column safe.
