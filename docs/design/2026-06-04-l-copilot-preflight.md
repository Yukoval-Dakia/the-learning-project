# L-copilot pre-flight — AF S2a 去 Today 化 + S3a 会话持久化（YUK-203 U3）

UI 改动（CopilotDock 组件移动/改名 + 文案 + replay 预填）触发 CLAUDE.md 的 UI design-doc pre-flight。本文逐字引设计源、声明组件类型、列 touch 清单、记缺口表。

## 设计源逐字引用

AF spec `docs/superpowers/specs/2026-06-04-agent-framework-design.md`：

- §7 Execution Order（L460-462）：
  > `S1 → (S0 ∥ S5) → S2a → S3a → S2b → S3b → S4`
- §7 slice 摘要（L467-468）：
  > - **S2a** (S): strip Today-specific copy.
  > - **S3a** (M): turn persistence + replay-last-N.
- §7 Slice 2 / S2a（L492-494）：
  > **S2a** (S):
  > - Rename Today-specific Copilot copy where it is no longer Today-specific.
- §7 Slice 3 / S3a（L505-509）：
  > **S3a** (M):
  > - Reuse `learning_session(type='conversation')` for Copilot.
  > - Persist turns/events consistently; support replay-last-N.
  > - Keep Claude Agent SDK session use an implementation detail.
- §1.5 Session Is a Product Concept（L132-134）：
  > Use `learning_session(type='conversation')` plus events/messages as the durable
  > conversation envelope. Do not revive the old `agent_sessions` / `agent_messages`
  > ADR shape unless there is a concrete need not covered by `learning_session`.
- §1.5（L138）：`recent raw turns;` 是 long-running 记忆的第一档（replay-last-N 的来源）。

U0 裁决 `docs/design/2026-06-04-u0-decisions.md` D10（L50-53）：
> 新增 Slice 0 = Copilot chat composer（…前端 TodayCopilotDrawer.tsx:107-109 是占位符…composer 做在 shell 挂的 drawer 里）
> 执行序：…→ S2a（去 Today 文案，S）→ S3a（turn 持久化+replay-last-N，M）→…
> S3b（rolling summary，L，YAGNI gate：真超窗才做）

## 组件类型声明

- **CopilotDock**（rename 自 `TodayCopilotDrawer`）：client component，宿主是 app shell（`app/(app)/layout.tsx`）挂载的全局抽屉（drawer）。底层视觉容器仍是既有 primitive `CopilotDrawer`（不动）。组件本身是 drawer wrapper，不是新 route/modal/page。
- testid 契约 `copilot-drawer-trigger` **不变**（shell + today/page.tsx 通过它驱动）。

## Touch 清单

创建：
- `src/ui/copilot/CopilotDock.tsx`（由 `src/ui/today/TodayCopilotDrawer.tsx` 移动改名而来；behavior 零变，仅文案 + replay 预填）
- `app/api/copilot/turns/route.ts`（新 GET，replay-last-N）
- `src/server/copilot/turns.ts`（turns 读：从 events 配对 ask+reply）
- `src/server/copilot/turns.test.ts`（db 测试）
- `src/server/copilot/conversation.ts` 不新建——复用 `src/server/session/conversation.ts`，**新增** `findOrCreateCopilotConversation()`（单一 owner 不变量：所有 conversation transition 住这）
- `src/ui/copilot/replay.ts`（pure helper：turns API → ChatMessage[]，drawer 预填逻辑可测无 jsdom）
- `src/ui/copilot/replay.test.ts`（unit，mock turns 数组）

修改：
- `app/(app)/layout.tsx`：import 改 `CopilotDock`（注释里 `TodayCopilotDrawer` 同步改名）
- `app/(app)/today/page.tsx`：仅注释提及 `TodayCopilotDrawer` 改名（驱动靠 testid，不变）
- `src/server/copilot/chat.ts`：runCopilotChat 加 conversation envelope（find-or-create + reply event + ask payload 带 session_id）
- `src/server/copilot/chat.test.ts`：补 session-envelope 断言（DI stub findOrCreate / writeEvent）
- `src/server/session/conversation.ts`：加 `findOrCreateCopilotConversation`
- `src/server/session/conversation.test.ts`：补 find-or-create db 测试

**不改**：`/api/today/copilot-summary` 路由（数据本就 today-scoped；summary 分区标题"今日摘要"语义正确，保留）。shell 文案（AppSidebar/AppTopbar 已是"Copilot"无 Today）。teaching/solve 任何文件（AF S4）。

## 文案去 Today

- drawer 标题 `Copilot · 今日` → `Copilot`（CopilotDrawer title prop）。
- 触发按钮 `召唤 Copilot` 文案保留（非 Today 语义，全局召唤即可）。
- chat 空态 + composer placeholder（`问 Loom 任何事…`）已是全局语义，不动。
- summary 分区内的"今日待复习/今日摘要"语义真是 today 数据，**保留**（D10/lane 明示）。

## 缺口表（no-mock — 占位代码必须留注释）

| 缺口 | 现状 | 处理 |
|---|---|---|
| 单元测试环境无 jsdom + 未装 `@testing-library/react` | `vitest.unit.config.ts` environment='node'，全部 UI 测试走 `renderToString`（无交互/无 fetch） | replay 逻辑抽成 pure helper `replay.ts`，unit 测纯函数（mock turns 数组）。不引新依赖，不写 happy-path mock 之外的伪 UI。drawer 内 `useEffect` fetch 预填靠 db smoke + pure helper 双覆盖，**不** mock 一个假 jsdom。 |
| reply event / ask session_id | 现 ask payload `{surface,user_message}`；无 reply 留痕 | 仅扩 payload（free-form `ExperimentalEvent`，零 schema）：reply action `experimental:copilot_reply` payload `{session_id, reply_md, task_run_id, in_reply_to_event_id}`；ask payload 补 `session_id`。`subject_kind:'query'` 已是合法 enum。 |
| 复用判据（24h / 未 ended） | learning_session 现有列：`status`/`started_at`/`updated_at`/`ended_at` | 判据 = 最近一条 `type='conversation'` 且 `status IN ('active','idle')` 且 `updated_at >= now-24h`，否则新建（status='active'）。**不加列**。Copilot conversation 的 `goal_id` 为 null（无 learning item，区别于 teaching 的 startConversation）。 |
| rolling summary（S3b） | DEFERRED，YAGNI gate | 本 lane 不做。 |

## 红线对照

- 零新表零新列：✅ events + learning_session 现有结构足够；payload-only 扩展。
- 不动 teaching/solve：✅ 新增独立 `findOrCreateCopilotConversation`，不碰 `startConversation`/teaching 路由。
- rolling summary 不做：✅。
