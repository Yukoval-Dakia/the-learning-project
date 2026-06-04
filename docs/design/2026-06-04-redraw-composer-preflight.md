# Redraw Wave-2 L-composer — design pre-flight（AF Slice 0：Copilot chat composer 上线）

> **Status**: Pre-flight（lane 现场写，对 fresh base）。YUK-169 / AF Slice 0。
> **Source**: loom-prototype `docs/design/loom-prototype/copilot.jsx`（checkpoint f85aca6d，提取于 `/tmp/loom-proto`）。
> **Base**: branch `yuk-169-w2-composer`（自 main @ `40165001`，已含 shell + loom primitives/CSS + CopilotDrawer/ToolUseCard primitive + 非流式 `/api/copilot/chat`）。
> **本 wave 唯一非纯 restyle lane**：把占位 chat surface 升级为真 chat（接现成 endpoint），保留 summary 视图 + `copilot-drawer-trigger` testid + shell 挂载。

---

## 0. 两端契约勘察结论（决定本刀范围，最关键）

| 端 | 事实 | 出处 |
|---|---|---|
| **后端 chat 是非流式 JSON** | `POST /api/copilot/chat` → `Response.json(result)`，一次性返回最终 `reply`。**没有 SSE / token-by-token 流**。 | `app/api/copilot/chat/route.ts:13-22` |
| 响应 shape | `{ task_run_id, reply, surface, triggered_by, user_ask_event_id? }`（`reply: string` 是完整文本） | `src/server/copilot/chat.ts:67-74, 326-332` |
| 请求 shape | `{ user_message: string(1..4000), triggered_by: 'chat' \| 'chip', chip_kind?: string }` | `src/server/copilot/chat.ts:55-63` |
| **route 不向前端暴露 tool-call 明细** | `RunTaskResult` 只有 `{ task_run_id, text, finishReason, usage, cost_usd? }`。tool 调用日志写在 server 侧（`src/server/ai/log.ts` / events），**响应里没有 per-message tool-call 数组**。 | `src/server/ai/runner.ts:56-64` |
| 事件留痕 | `runCopilotChat` 内部 `writeEvent(copilot_user_ask / copilot_chip_trigger)` + tool-use mirror events，**已在 server 侧完成**，前端不需要也不能碰。 | `chat.ts:201-236` |

**红线落点**：原型的"流式打字机 + ToolCard 带 `rows` + 思考中"在 `copilot.jsx` 里是 **mock**（`setTimeout` 1600ms 假 reply + 写死的 `rows: [["query",…],["matched",…]]`，jsx:91-98）。后端真实契约是「请求 → 等待 → 一次性 reply」。

**本刀决策**（不改后端路由、不新增路由、server 序列化零改动）：
1. 用既有非流式 JSON 契约。前端做 **请求中（loading/thinking）→ 成功（渲染 reply）→ 错误（错误条 + 重试按钮）** 三态，**不伪造 token 流**。"思考中"loading 态是真实的（请求在途），不是假打字机。
2. **tool-call 卡片：drop 真实数据**——route 不返回 tool 明细，no-mock 纪律下不把 `COPILOT_TOOL_FIXTURES` 灌进生产 chat。`ToolUseCard` primitive 保留可复用，但本刀不在真实消息流里挂它（见 §4 缺口表 D-2，phase-deferred）。
3. **会话持久化 / rolling summary**：AF S3 的事，本刀不做（§4 D-3 deferred）。每次 send 是独立 `triggered_by:'chat'` 请求，前端只在内存维护本 session 的消息列表。

---

## 1. 组件类型声明（CLAUDE.md 要求）

| 类型 | 物 |
|---|---|
| **drawer 内容（client component 改写）** | `src/ui/today/TodayCopilotDrawer.tsx`：把占位 `<p>Wave 5…会接入 chat</p>` 子节点换成真 chat surface（消息列表 + 流式/loading 渲染 + 错误重试），并向 `CopilotDrawer` 传 `footer`（composer 输入 + quick-chips）。**summary slot 原样保留**（收进顶部 summary 区，CopilotDrawer 已有独立 summary section）。 |
| **设计基座（CSS，additive + scoped）** | `app/globals.css` 追加 `LOOM COPILOT LAYER — Wave 2` 段：**全部 scope 在 `.copilot-loom` wrapper 下**（沿 `.knowledge-loom`/`.today-loom` 先例）。新类：`.copilot-loom .msg`/`.msg-ai`/`.msg-user`/`.msg-avatar`/`.msg-body`/`.msg-name`/`.msg-text` · `.copilot-loom .chat-stream`/`.chat-empty`/`.chat-error` · `.copilot-loom .composer`/`composer textarea` · `.copilot-loom .chat-chips`。`.spin` keyframe（thinking 图标旋转，grep=0 → 全局可，保险放 scoped）。 |
| **不改** | `CopilotDrawer` primitive（slot 容器，testid 契约全保留）· `app/(app)/layout.tsx`（shell 挂载点 + `openCopilot` trigger-click 机制）· `useCopilotDwell` · `/api/today/copilot-summary` query · 后端 chat.ts / route.ts。 |

---

## 2. 逐字引 loom（`copilot.jsx`，行号）

- **ToolCard**（jsx:1-29）：`.tool-card` > `.tool-head`（`Icon search` + `tool.name` + `.tool-status`：运行中 `Icon refresh .spin`「运行中」/ 完成 `Icon check`「完成」）+ `.tool-body.fade-key` > `.tool-row`（`.k` / `.v`）。→ **本刀 drop**（route 无 tool 明细，§4 D-2）。
- **Message**（jsx:31-48）：`.msg.msg-{role}` > `.msg-avatar`（ai=`Icon sparkle` / user=initial）+ `.msg-body`（`.msg-name`「Loom Copilot」/ user.name · 可选 `<ToolCard>` · `.msg-text` · ai 消息尾部 2 个动作 `<Btn size=sm variant=good icon=plus>生成 2 张卡片` / `<Btn variant=ghost icon=knowledge>查看节点`）。→ ai 尾部动作按钮 **drop**（未接线，§4 D-4）。
- **CopilotDrawer**（jsx:50-143）：`msgs` state + `typing` state + `val` 输入 state；`bodyRef` 滚到底（jsx:58-60）；focus-trap + Esc（jsx:63-84，CopilotDrawer primitive 已有 Esc + focus，复用不重造）；`send()`（jsx:86-99，原型是 mock setTimeout，本刀换真 fetch）。
- **drawer-head**（jsx:105-113）：`.card-icon.accent`(copilot icon) + `.drawer-title.serif`「Copilot」+ `<Badge tone=good dot pulse>在线` + 右侧 `IconBtn teach`（教学模式）/ `IconBtn close`。→ title/close 由 CopilotDrawer primitive header 提供（已有「收起」按钮）；teach IconBtn **drop**（teaching = AF S4，§4 D-5）。
- **drawer-body**（jsx:115-126）：`msgs.map(Message)` + `typing` 时的「思考中…」气泡（`.tool-card` 内 `Icon refresh .spin`「思考中…」）。→ 思考中气泡 **保留**（映射到真实「请求在途」loading 态）。
- **drawer-foot**（jsx:128-139）：quick-chips（jsx:129-132，2 个 `button.chip`：「今天该复习哪些？」「解释「之」的用法」点击 `send(text)`）+ `.composer`（`textarea` rows=1 + `Btn primary` send 图标，Enter 发送 / Shift+Enter 换行，jsx:133-138）。→ **全保留**，接真 send。

---

## 3. 数据映射（接现成 endpoint，零新接线）

| loom 字段 | 来源 |
|---|---|
| 发消息 | `apiJson('/api/copilot/chat', { method:'POST', body: JSON.stringify({ user_message, triggered_by:'chat' }) })`（既有 client，自动带 `x-internal-token`，`src/ui/lib/api.ts:68`） |
| ai 回复文本（`.msg-text`） | response `.reply`（完整字符串，渲染为 ai 消息） |
| quick-chip 发送 | 同上 `send(chipText)` —— 注：chip 文案是用户可读 prompt，走 **`triggered_by:'chat'`**（不是 `'chip'`；`'chip'` surface 是 mistake-action 直触发的另一套 allowlist，本刀 UI 的 quick-chip 只是预填 prompt 文案，语义上是 chat） |
| 思考中 loading | 真实 in-flight 态（fetch pending），非假 timer |
| 错误态 | `apiJson` 抛 `ApiError`/`ApiAuthError`（`api.ts:7-23`）→ 渲染 `.chat-error` 条 + 「重试」按钮（重发上一条 user_message） |
| user 消息 initial / name | 单用户工具无 user model → 头像用静态「知」（沿 AppSidebar `avatar`「知」先例，sidebar.tsx:109），name 省略或「我」 |
| ai avatar / name | `Icon sparkle` + 「Loom Copilot」（静态，原型一致） |
| summary slot | 原样保留现有 `summaryQ` 4-slot 渲染（daily_focus/review_due/brief/dreaming/footer，TodayCopilotDrawer.tsx:60-105 不动） |

---

## 4. 缺口 → 处理表（no-mock：后端没有的 drop + phase-deferred 注释，绝不假造）

| ID | loom 字段 | 后端现状 | 处理 |
|---|---|---|---|
| **D-1** | 流式 token-by-token 打字机（原型 `typing` 假 setTimeout） | route 是**非流式** `Response.json`，一次性 reply | **drop 假流**。改为真实「请求在途 → 一次性渲染 reply」。loading 态用原型「思考中…」气泡（真实在途，非假打字）。phase-deferred 注释：若日后后端改 SSE（需改 route + chat.ts 序列化，本刀红线禁），可升级为增量渲染。 |
| **D-2** | ToolCard（`.tool-card` 带 `rows` k/v + 运行中/完成态） | `RunTaskResult` 不向 route 暴露 tool-call 明细（runner.ts:56-64）；tool-use 仅 server 侧 events/log | **drop 真实 tool-card**。不把 `COPILOT_TOOL_FIXTURES` 灌进生产（no-mock）。`ToolUseCard` primitive 保留不删（其它用途）。phase-deferred 注释：AF 后续若让 route 回传 tool-use 摘要数组（最小 server 序列化扩展），可在消息流挂 `<ToolUseCard>`；上下文见本 preflight + `src/server/ai/log.ts`。 |
| **D-3** | 会话持久化 / rolling summary（多轮上下文） | 每次 send 是独立无状态请求（chat.ts 不读历史消息） | **本刀不做**（AF Slice 3）。前端只在内存维护本 session 消息列表，刷新即清。phase-deferred 注释标 AF S3。 |
| **D-4** | ai 消息尾部动作按钮（「生成 2 张卡片」「查看节点」，jsx:40-44） | 无对应接线（卡片生成 = propose_variant，节点跳转无 target id 回传） | **drop**。route reply 不含结构化 action target。phase-deferred：AF S4 / propose 链路落地后补。 |
| **D-5** | drawer-head teach IconBtn（教学模式，jsx:110） | teaching drawer = AF Slice 4，本 wave 明确不 restyle | **drop** teach 入口（保留 CopilotDrawer header 的 close）。 |
| **D-6** | drawer-head「在线」pulse badge（jsx:108） | 装饰，无 health 数据驱动 | **保留**为静态装饰（`LoomBadge tone=good dot pulse`「在线」），无数据依赖，不算假造（纯 UI 在线感）。放 summary 区顶或 chat 区顶。 |

---

## 5. CSS scope 策略

grep `app/globals.css` 结论：
- `.msg`/`.composer`/`.suggest-chip` 已存在但**全部 scope 在 `:is(.teach-chat-page, .teach-drawer)` 下**（Phase 2C teaching drawer，globals.css:4933-5074），不撞我新 drawer——但**为保险，本刀所有 chat 类全部 scope 在 `.copilot-loom` wrapper 下**（沿先例）。
- `.chip` / `.chip-k` / `button.chip`（globals.css:6350+）是**全局 loom 类**，quick-chip 直接**复用不重定义**。
- `.tool-card`/`.tool-head`/`.tool-body`/`.tool-row`/`.tool-status`/`.chat-empty`/`.chat-error`/`.chat-stream`/`.fade-key`/`.spin`/`.msg-avatar`/`.msg-text`/`.msg-ai`/`.msg-user`/`.msg-body`/`.msg-name`：**grep=0 无冲突**。
- 方案：drawer chat surface 根 `<div className="copilot-loom">`（套在 CopilotDrawer 的 chat slot / footer 内）；新 chat 类全 scope 在 `.copilot-loom` 下。`.spin` keyframe grep=0 → 全局定义（keyframe 无法 scope），但只 thinking 图标用。
- 复用不重定义：`.card`/`.btn`/`.badge`/`.chip`/`.serif`/`.card-icon.accent`/Btn/LoomBadge/LoomIcon。

---

## 6. Touch 文件清单

**MODIFY**：
- `src/ui/today/TodayCopilotDrawer.tsx` — 占位子节点 → 真 chat（消息列表 + loading/error/retry + composer footer + quick-chips）；新增本 session 消息 state + send mutation（`apiJson` POST）；**保留** `summaryQ` + summary slot + `[data-testid="copilot-drawer-trigger"]` 触发按钮 + `useCopilotDwell` 接线；改头部注释（不再是「占位」）。
- `app/globals.css` — 追加 `LOOM COPILOT LAYER — Wave 2` 段（scoped `.copilot-loom` chat/msg/composer/chips/states 层 + `.spin` keyframe），banner 注释 + append 前 grep collision-check 已做。

**REUSE（不动）**：`CopilotDrawer` primitive（slot 容器 + 全 testid + Esc/focus/scroll-lock）· `useCopilotDwell` · `/api/today/copilot-summary` query · `apiJson`/`ApiError`/`ApiAuthError` · `Btn`/`LoomBadge`/`LoomIcon`/`LoomCard` primitives · 全局 `.chip` loom 类 · `app/(app)/layout.tsx` shell 挂载 + `openCopilot` trigger-click。

**NOT-TOUCHED（红线）**：`app/api/copilot/chat/route.ts` · `src/server/copilot/chat.ts` · `src/server/ai/runner.ts`（后端零改动，无新路由，token 不进前端——只走既有带 token 的 `apiJson`）。

---

## 7. 风险 + 缓解

- **token 不进前端**：只走 `apiJson`（client localStorage token，middleware 校验），绝不在前端读 Anthropic key。请求只打既有 `/api/copilot/chat`。✅ 红线。
- **非流式但要"流式感"**：用真实 in-flight loading 气泡（「思考中…」+ spin），reply 到达后一次性渲染。不伪造 token 流（D-1）。reviewer 重点：loading→success→error 三态正确，错误条带可重试，事件留痕不破坏（server 侧已做，前端不碰）。
- **CSS 冲突**：`.msg`/`.composer` 撞 teaching → 全 scope `.copilot-loom`（§5），append 前已 grep。
- **testid 契约**：`copilot-drawer-trigger`（trigger 按钮）+ CopilotDrawer primitive 的 root/panel/summary/chat/footer/close testid 全保留 → shell `openCopilot` trigger-click 与既有 CopilotDrawer.test.tsx 不破。
- **移动断点**：CopilotDrawer primitive 已 `w-full sm:w-[420px]` + body scroll lock，复用其响应式；composer/chips 用 flex-wrap。
- **build = gate**：`pnpm build` 验 client component 编译 + drawer 渲染。无单测覆盖 TodayCopilotDrawer（grep 确认无 .test）；CopilotDrawer.test.tsx 测 primitive，不动 primitive → 仍绿。

---

## 8. Build order + verify gate

scoped CSS（globals append + banner）→ 改写 TodayCopilotDrawer chat surface（消息 state + send + 三态 + composer footer + chips，包 `.copilot-loom` wrapper，保留 summary + testid + dwell）→ **lane gate**：touched-file `biome check --write` · `pnpm typecheck` · `DATABASE_URL=postgres://placeholder pnpm build` · `pnpm vitest run --config vitest.unit.config.ts src/ui/primitives/CopilotDrawer.test.tsx`（primitive 未动，回归确认）。

---

*本刀只升级 Copilot drawer 的 chat surface（接现成非流式 `/api/copilot/chat`），保留 summary 视图 + testid 契约 + shell 挂载。流式打字 / tool-card 真实数据 / 会话持久化 / ai 动作按钮 / teaching 入口均 phase-deferred（§4），no-mock 不假造。后端零改动。*
