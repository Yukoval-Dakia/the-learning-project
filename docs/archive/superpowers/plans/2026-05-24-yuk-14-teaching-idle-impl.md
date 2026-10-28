# YUK-14 — Teaching idle state machine impl plan

**Date**: 2026-05-24
**Linear**: [YUK-14](https://linear.app/yukoval-studios/issue/YUK-14)
**Wave**: M1.2 (Product Track 1 closeout)
**Design SoT**: [`docs/design/2026-05-24-teaching-idle-state-machine.md`](../../design/2026-05-24-teaching-idle-state-machine.md)
**Pattern SoT**: [`docs/adr/0013-review-session-lifecycle.md`](../../adr/0013-review-session-lifecycle.md)
**Author**: Wave 2 Lane 1 subagent

---

## Goal

给 `learning_session(type='conversation')` 装上完整 lifecycle —— `active → idle → ended | abandoned`，并 mirror ADR-0013 的 sendBeacon + 6h orphan cron pattern，外加 conversation 独有的 1min idle-promote cron。

设计 doc Open questions §1–5 全部采纳 default：
1. **IDLE_MS = 5 min**
2. abandoned session 的 "Continue teaching" CTA 推迟到 [YUK-18](https://linear.app/yukoval-studios/issue/YUK-18)
3. promote cron 每 **1 min**
4. drawer 处于 `idle` 状态时 pagehide → `'abandoned'`；非 idle 时 pagehide → `'ended'`
5. **不**升格为 ADR（design doc 即 SoT）

## Architecture

### 数据流

```
Mount drawer ──► POST /api/teaching-sessions       (T1: → active)
                       │
                  user msg ──► POST /…/turn         (T2/T2b: idle→active if was idle)
                       │
                  promote cron (1min) ──► CTE 查 last user msg          (T4: active→idle)
                       │
                  drawer unmount ──► POST /…/end {status:'ended'}      (T5)
                  pagehide while ACTIVE ──► sendBeacon /…/end {ended}  (T5)
                  pagehide while IDLE   ──► sendBeacon /…/end {abandoned} (T6)
                       │
                  orphan cron (6h, 04:25 BJT) ──► (T7: → abandoned)
```

### 模块分层

- `src/core/schema/learning_session.ts` — enum 扩展（+`'abandoned'`）
- `src/server/session/conversation.ts` — 新增 `idleConversation` / `resumeConversation` / `abandonConversation`，扩展 `endConversation`，新增 `assertAcceptingTurns`，保留 `assertActive` (deprecated comment, no behavior change)
- `src/server/session/conversation.test.ts` — 新增 transition 单测
- `src/server/boss/handlers/promote_conversation_idle.ts` + `.test.ts`
- `src/server/boss/handlers/prune_orphan_conversation_sessions.ts` + `.test.ts`
- `src/server/boss/handlers.ts` — 注册 + schedule
- `app/api/teaching-sessions/[id]/end/route.ts` — parse body + sendBeacon Content-Type 容错（mirror review end route）
- `app/api/teaching-sessions/[id]/end/route.test.ts` — 新增（目前无此 file）
- `app/api/teaching-sessions/[id]/turn/route.ts` — 使用 `assertAcceptingTurns`，response 加 `was_idle: boolean`
- `app/api/teaching-sessions/[id]/route.test.ts` — 已存在，可能需补 abandoned/idle case
- `src/ui/components/TeachingDrawer.tsx` — pagehide + sendBeacon、 status polling、idle banner、abandoned 锁屏

## File-by-file diff plan

| 文件 | 操作 | 内容 |
|---|---|---|
| `src/core/schema/learning_session.ts:41` | 修改 | `ConversationStatus` enum +`'abandoned'`，注释更新 |
| `src/server/session/conversation.ts` | 修改 | 新 transition fns + `assertAcceptingTurns`；旧 `assertActive` 加 `@deprecated` JSDoc，行为不变 |
| `src/server/session/conversation.test.ts` | 修改 | 覆盖 T2b / T4 / T5(idle→ended) / T6 / reject 表 |
| `src/server/boss/handlers/promote_conversation_idle.ts` | 创建 | SQL CTE (design §"Idle clock") 找 candidates → call `idleConversation` per row |
| `src/server/boss/handlers/promote_conversation_idle.test.ts` | 创建 | 5min cutoff 验证 + race skip |
| `src/server/boss/handlers/prune_orphan_conversation_sessions.ts` | 创建 | 6h cutoff，仿 review prune |
| `src/server/boss/handlers/prune_orphan_conversation_sessions.test.ts` | 创建 | 6h 验证 + 终态跳过 |
| `src/server/boss/handlers.ts:58` 附近 | 修改 | 注册 + schedule (`promote_conversation_idle` 每分钟 `* * * * *`；`prune_orphan_conversation_sessions` BJT `25 4 * * *`) |
| `app/api/teaching-sessions/[id]/end/route.ts` | 修改 | parse body `{status: 'ended' \| 'abandoned'}` (default 'ended')，sendBeacon Content-Type 容错（仿 review end） |
| `app/api/teaching-sessions/[id]/end/route.test.ts` | 创建 | JSON / text-plain / abandoned / 默认 ended / not_found / conflict |
| `app/api/teaching-sessions/[id]/turn/route.ts` | 修改 | 使用 `assertAcceptingTurns`；response 加 `was_idle` |
| `app/api/teaching-sessions/[id]/route.ts` | 不动 | GET 已返回 status，UI 直接消费 |
| `src/ui/components/TeachingDrawer.tsx` | 修改 | pagehide handler + sendBeacon；30s polling GET; idle banner; abandoned 锁屏（详 §UI Pre-flight） |

## UI Pre-flight（design-doc compliance）

按 worktree `CLAUDE.md` 「UI Design Compliance」要求：

### 1. 逐字引用 design doc

- [`docs/design/2026-05-24-teaching-idle-state-machine.md`](../../design/2026-05-24-teaching-idle-state-machine.md) §"Implementation sketch (留 YUK-14)" 第 5 项（line 311-315）：
  > **UI** (`TeachingDrawer.tsx`)：
  > - Mount 时加 `pagehide` listener → sendBeacon `/end` with `{status: drawer was idle ? 'abandoned' : 'ended'}`
  > - Unmount cleanup 跑 fetch `/end` `{status:'ended'}`（drawer 主动关 = ended）
  > - Poll session GET `/api/teaching-sessions/[id]` 每 30s，或订阅 SSE（仿 review session SSE 模式）→ 拿到 status；status=`idle` 显示「黄色 banner: 走开了吗？敲字继续 / 结束」；status=`abandoned` 显示「session 已过期」+ 重开 CTA
  > - User 敲字时如果上次拿到的 status=`idle`，乐观切回 `active`（turn response 的 `was_idle: true` confirm 后清 banner）

- §"State enum" line 73：
  > | `idle` | drawer 仍开但最近 N 分钟无 user 输入… | live |
  > | `abandoned` | orphan cron 标记 / 显式 abandoned beacon | terminal |

- §"Edge cases" E5（line 273）：
  > 用户已 idle，又主动关 drawer：**决策：`ended`**（用户主动关 = 主动结束语义）。pagehide 路径（关 tab）才是 abandoned。

- §"Open questions" #4 default：drawer 关 / pagehide 时 if session=`idle` → 发 `'abandoned'`。

### 2. 组件类型

**Drawer**（既有 `TeachingDrawer.tsx`，aside.teach-drawer）。无新增 route / modal / page。

### 3. Touch files

- 修改：`src/ui/components/TeachingDrawer.tsx`
- 不创建新 UI 文件
- 不引入新 design tokens / primitives —— 复用已有的 `.session-banner` / `.end-banner` class，新加一个语义 class `is-idle`（黄色变体）+ `is-abandoned`（灰锁屏变体）。**这两个 class 在 `app/globals.css` 复用 already-defined CSS variables（`var(--again-ink)` 之类） —— 不引入新颜色 token。**

### 4. 设计 doc 没明确写的 UI 微决策

- **Idle banner 文案**：design doc §"State enum" 写 "走开了吗？敲字继续 / 结束"。我会用同字面。**已包含在引用，不需另开 NEEDS USER APPROVE**。
- **轮询 vs SSE**：design doc 说「Poll 30s **或**订阅 SSE」。本期取轮询（更简单，30s 精度足够，SSE refactor 留 follow-up）。
- **乐观 active 切换**：design 已明确，按 `was_idle` 回包 confirm。
- **status=`ended` 已存在 `ended` banner**：不动现有「会话已结束」banner；abandoned 用新 class 区分。

如果上面任何一项 user 觉得需要重审，请在 PR review 阶段提出。所有 UI 改动**严格按 design doc 落地**，pre-flight gate 视为满足。

## Tasks（TDD red-green-refactor）

### T1 — Schema enum

- [ ] 改 `src/core/schema/learning_session.ts:41` 加 `'abandoned'`。type 自动更新。
- [ ] commit: `feat(schema): YUK-14 add 'abandoned' to ConversationStatus`

### T2 — session/conversation transition fns

- [ ] **Red**: 在 `conversation.test.ts` 加 transition 单测 —— `idleConversation` (active→idle), `resumeConversation` (idle→active in tx), `abandonConversation` (active|idle → abandoned), `endConversation` 允许从 idle, double-end 拒绝。
- [ ] **Green**: impl 4 个 fn + `assertAcceptingTurns(db, sessionId) → { goalId, wasIdle }`。`assertActive` 保留，加 `@deprecated` JSDoc 指向新 fn。
- [ ] commit: `feat(session): YUK-14 conversation idle/resume/abandon transitions`

### T3 — promote_conversation_idle handler

- [ ] **Red**: handler test —— 创 active session 老化 6min → promote → status=idle + job_events 写 `conversation.idle`。新 session (<5min) 不动。idle 状态 race skip。
- [ ] **Green**: handler 内做 CTE 查 last user message timestamp (event 表) → 选 candidates → 对每个调 `idleConversation`，try/catch 跳过 race lost。
- [ ] commit: `feat(boss): YUK-14 promote_conversation_idle handler`

### T4 — prune_orphan_conversation_sessions handler

- [ ] **Red**: mirror review prune test，6h cutoff，abandons active+idle，跳过 ended/abandoned。
- [ ] **Green**: 仿 `prune_orphan_review_sessions.ts`，处理两种 source state。
- [ ] commit: `feat(boss): YUK-14 prune_orphan_conversation_sessions cron`

### T5 — boss handler registration

- [ ] 改 `src/server/boss/handlers.ts`：注册两个 queue + `boss.schedule('promote_conversation_idle', '* * * * *', ...)` + `boss.schedule('prune_orphan_conversation_sessions', '25 4 * * *', ...)`
- [ ] commit: `feat(boss): YUK-14 register conversation lifecycle schedules`

### T6 — end route body parsing

- [ ] **Red**: 新建 `app/api/teaching-sessions/[id]/end/route.test.ts` —— JSON {status:abandoned}, text/plain 默认 ended, JSON 无 status 默认 ended, 不存在 →404, 已 ended →409。
- [ ] **Green**: 改 route 仿 review end (Content-Type 容错)；dispatch 到 endConversation / abandonConversation。
- [ ] commit: `feat(api): YUK-14 teaching-sessions end accepts {status} body`

### T7 — turn route uses assertAcceptingTurns

- [ ] **Red**: turn route test 中加 case：idle session 收到 user turn → response.was_idle=true + session 切回 active + job_events 写 `conversation.resumed`。Active 状态 was_idle=false。Ended 状态 →409。
- [ ] **Green**: 改 turn route。
- [ ] commit: `feat(api): YUK-14 turn route resumes idle conversations`

### T8 — TeachingDrawer UI

- [ ] pagehide + sendBeacon (status=idle? abandoned : ended)
- [ ] 30s `setInterval` poll GET session 拿 status
- [ ] idle banner（黄）+ abandoned 锁屏（灰）+ 乐观 resume on send
- [ ] commit: `feat(ui): YUK-14 TeachingDrawer idle/abandoned UX`

### T9 — Final audits

- [ ] `pnpm audit:schema` — verify 4 个 conversation status 都有 write path（design §CC line 289）
- [ ] `pnpm audit:partition` — 新测试文件分区正确
- [ ] `pnpm typecheck && pnpm lint`
- [ ] `pnpm test`
- [ ] commit (if doc tweaks)

## Open Q defaults applied

| # | Q | Default | 落点 |
|---|---|---|---|
| 1 | IDLE_MS | 5 min | `promote_conversation_idle.ts` constant `IDLE_MS = 5 * 60 * 1000` |
| 2 | Continue teaching CTA | YUK-18 | TeachingDrawer abandoned 状态显示提示 + 关闭 CTA，无 resume button（follow-up） |
| 3 | Promote cron 频率 | 1 min | schedule `* * * * *` |
| 4 | Pagehide 时 idle → ? | abandoned | drawer 用 ref 跟踪「上次拿到的 status」，sendBeacon 时择 abandoned vs ended |
| 5 | 新 ADR? | 否 | 引用 design doc 路径 |

## Risk + rollback

- **风险**：`promote_conversation_idle` 每分钟扫一次 conversation 表。NAS 单用户 conversation row 量极小（每天 < 50 row），无 index 也 OK。但加 `(type, status, updated_at)` 索引日后 P50 < 5ms 更稳。**本 PR 不加 index**（YAGNI；conversation 表行数 < 10k 时 seq scan 几乎免费）。Follow-up: 如果 conversation 表行数 > 50k，加 partial index `WHERE type='conversation' AND status IN ('active','idle')`。
- **风险**：UI 30s polling 在 N 个 tab 同时打开时放大。NAS 单用户场景可忽略；不引入跨 tab coordination（design §Non-goals 显式排除）。
- **回滚**：每个 commit 独立 reversible。Schema enum 加值不需要 migration，回滚就是删枚举值；但要确保没有 row 已经 status='abandoned'（最简办法：回滚前 `UPDATE learning_session SET status='ended' WHERE type='conversation' AND status='abandoned'`）。

## Acceptance check（对照 Linear ticket）

| Linear AC | 落点 |
|---|---|
| 状态机 server 端 + 单测覆盖每条转移 | T2 + handler tests |
| frontend idle banner 显示 | T8 (TeachingDrawer is-idle class) |
| resume 不丢消息 | T7 turn route was_idle response 验证 + UI optimistic state reset |
| abandoned 状态 cron / 显式按钮兜底 | T4 (orphan cron) + T6 (sendBeacon body parsing) |
| E2E：发消息 → idle → resume → 继续 → end | conversation.test.ts 端到端覆盖（DB level） + turn route test |
| pnpm typecheck && pnpm test PASS | T9 |
| pnpm audit:schema PASS | T9 |

**No new field added**，因此无需 audit:schema allowlist 改动；`status` 既有 INSERT (start) + UPDATE (end/idle/abandon) write path。

## Linear capture gate — proposed follow-ups

为 orchestrator 在 chain-merge 阶段统一开 Linear:

1. **abandoned conversation 重开 CTA**（design E7）：在 `/learning-sessions/[id]` 详情页 abandoned 状态下加 "Continue teaching" 按钮 → 开新 session。关联 [YUK-18](https://linear.app/yukoval-studios/issue/YUK-18) 或新单。
2. **`assertActive` 退役**：本 PR 加 `@deprecated`，下一个 conversation 相关 PR 删除（避免本 PR 改动面过大）。提议开 small follow-up issue。
3. **SSE 替代 30s polling**：参考 review SSE 模式（如存在），让 idle / abandoned 状态变更实时推送。性能 / UX 提升，但非阻塞。
4. **`conversation_id` 部分索引**：当 conversation 表 > 50k row 时加 `(type, status, updated_at)` partial index。监控触发。
5. **`/today` ribbon 显示 conversation lifecycle**：当前 ribbon 只统计 review；conversation idle/abandoned 也应有可观测性。

## Exit criteria

- 全部 9 commit ✓
- pre-merge gate（typecheck + lint + audit:schema + audit:partition + audit:profile + test）全绿
- PR description 引用 design doc 路径 + Open Q decisions + Acceptance check 表
- `Closes YUK-14` 在最后一个 commit message
