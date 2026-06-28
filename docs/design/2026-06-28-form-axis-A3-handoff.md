# 形态轴 A3 — D14 对话体验 · 功能 handoff（给 claude design）

- **date**: 2026-06-28
- **status**: functional handoff（零风格规定）—— 视觉稿由 claude design (claude.ai/design) 出，回来 slice-by-slice 实现
- **缺口来源**: `docs/design/2026-06-15-rethink-implementation-gate.md` §2 item 3（D14 对话体验 + 主动开口时机 + 对话面故障态）
- **架构依据**: `docs/design/2026-06-14-product-rethink-phase2-synthesis.md` §2.3「A3 · 单编排者 + hint-first」+ §4.2 全局出手强度表 A/B/C
- **构建于既有 loom design 系统**：复用 Copilot Drawer 既有 chat token（`.copilot-loom` / `.msg` / `.chip` / `.copilot-hero`），不引入新视觉系统

> 这是**功能** handoff：只描述对话面该让 owner**理解什么、能做什么**，**不规定任何视觉风格 / 布局 / 配色 / 组件选型**——那是 claude design 的活。实现回来后按项目 design tokens / primitives 落地。

---

## owner 想解决的问题

这台学习工具的 AI 是**单编排者 D14**（`docs/design/2026-06-14-product-rethink-phase2-synthesis.md` §2.3）：前台常驻 Copilot Drawer 是它的「前台召唤姿势」，后台三个 job（dreaming 夜想 / coach 规划回看 / goal_scope 目标范围）是同一个编排者的「后台姿势」，按 `actor_ref` 分轨保可观测，但对用户讲**同一个连贯故事**。

对话面是这个编排者**唯一**的同步出场。owner 想要的不是一个问答框，而是一个**像私人教研团成员**的对话：它读你的错题 / 知识图 / 今日计划来回答（既有 placeholder 已这么承诺，`src/capabilities/copilot/ui/CopilotDock.tsx:713`），该简短时一句话 + 一个下钻入口，该叙事时（譬如交代「我昨夜替你想了什么」）有铺陈；它在**该开口时主动开口**（练习卡住、录入完成），而不是只会被动等问或盲目弹窗；它做多步改动时让 owner**逐条看清、逐条接受 / 回退 / 挑选**，而不是黑箱写库或把所有提议甩到另一个页面去裁决。

四件事要在这次 handoff 里给出功能形态：
1. **回复长度 / 第一人称语气 / 何时叙事 vs 一句话+下钻**
2. **主动开口时机**（练习卡住 nudge？录入后提议？）—— 单编排者「主动性」的体验形态
3. **对话故障态**（SSE 半截 / 工具失败 / 空回复）—— 显式功能约束
4. **逐条 checkpoint keep / revert / cherry-pick**（AI 多步改动的逐条接受 / 回退 / 挑选）

---

## 现状反模式（锚真代码）

> 先 Read 引用文件，确认形态再设计。所有行号 anchor 自 worktree `worktree-form-axis-handoffs` 当前 HEAD。

### R-1 · 第一人称语气存在但「无人格调度」

- 前台 Copilot 已第一人称署名「我」、AI 头像 `Loom Copilot`（`CopilotDock.tsx:726`），回复经 `MathMarkdown` 渲染（GFM 加粗 / 斜体 / 列表，free-form 路径刻意关 KaTeX，`CopilotDock.tsx:732`）。
- 但后台三 job（dreaming / coach / goal_scope）各有**独立 actor surface，四个 agent 人格互不知情**（synthesis §2.3 现状）。前台对话目前**不会引用昨夜后台想的**——交班缕（A1）是后台产出的展示落点，但前台对话与它无 voice 契约。
- **反模式**：对话语气是单点写死的「我」，没有「同一个编排者的四种召唤姿势讲连贯故事」的体验形态。本 handoff 聚焦前台对话本身的语气 / 长度形态；**跨四面 voice 引用契约**是单独缺口（gate §2 item 4，不在本 doc 范围）。

### R-2 · 回复长度 / 叙事密度无形态规约

- 现状所有回复都是一条等宽 `.msg-ai` 气泡里的 markdown 文本流（`CopilotDock.tsx:716-805`），**没有「一句话答 + 下钻」与「叙事铺陈」的形态区分**。
- 唯一的「下钻 / 交还」结构是 **hero card**（per-reply 单一交付物 `primary_view`，渲染在回复文本下方，`CopilotDock.tsx:800` + `CopilotHeroCard.tsx`）：编排者每轮可提名 0 或 1 个交付物（题 / 卷 / 笔记 / 互动产物 / 工具结果），缺省=无 hero。
- **反模式**：回复长度完全由模型自由发挥，前端无任何「简短 vs 叙事」的视觉承载差异，owner 无法一眼区分「这是一句话回应」还是「这是一段交代」。

### R-3 · 主动开口=盲目 30 秒计时器，无内容驱动 nudge

- 当前**唯一**的「主动开口」是 dwell 计时器：首次挂载 arm 一个 30s 计时，任意交互（鼠标 / 键盘 / 滚动 / 可见性）重置；计时到点无交互则 Drawer 自动浮开；再访立即开；本 session 内一旦 dismiss 不再自动开（`src/ui/lib/use-copilot-dwell.ts:1-16`）。
- **反模式**：这是一个**与学习内容无关的盲目计时器**——它不知道 owner 练习卡住了、不知道刚录入完一份材料。synthesis §2.3 要的「单编排者主动性」是**内容驱动**的开口（编排者读 B3 信号判断「该说话了」），现状零实现。
- 注：`accept-chip.ts:74` 里的 `proactive` 是 coach 后台提案的 KPI 标签（区别 corrective），**不是**前台对话的主动开口——别混淆。

### R-4 · 多步改动无 inline checkpoint，全甩去 /inbox 出带外裁决

- 对话面对 AI 的结构性改动**零 inline 接受 / 回退 / 挑选 UI**。AI 提议的结构写入（知识节点 / 边 / 题草稿 / learning_item / block_merge / goal_scope 等）走 propose-only 红线，落到 `/inbox` 由 `ProposalCard` **逐条**裁决：`接受` / `忽略` / `改方向` / `改关系`（`src/capabilities/shell/ui/ProposalCard.tsx:182-256`，经 `POST /api/proposals/[id]/decide` + `/retract`）。
- 教学 skill 的 `ask_check` 题 + corrective chip（`重做 / 回看前置`）是对话内仅有的结构化交互（`CopilotDock.tsx:751-789`），但它是**KPI 信号 chip**，不是「接受 AI 一处改动」。
- 设计里的 **A 档「自动应用 + 撤销窗口」**（乐观 apply + 一键 revert + 单位时间熔断，synthesis §4.2）**designed-not-built**。durable run 有 `checkpoint_id`（= user_ask event id，`src/server/boss/handlers/copilot_run.ts:61-65`）但**没有任何 UI 暴露逐步 revert / cherry-pick**。
- **反模式**：owner 在对话里让 AI「把这几个知识点补全 + 给我出套题」时，多步改动既不在对话里逐条显形，也没有「这条留、这条退、这条只挑一部分」的体验——要么黑箱、要么跳到另一个页面整批裁决。

### R-5 · 故障态已部分内建（设计需在此基础上规约形态，不是从零造）

对话面已内建一批失信兜底（claude design 须**继承并给视觉形态**，不要当作不存在）：
- **思考气泡**：pre-first-byte 间隙的「思考中…」气泡（`CopilotDock.tsx:806-818`，`copilot-thinking`）。
- **打字光标**：SSE delta 流入时的 `▍` caret（`CopilotDock.tsx:737-745`，`copilot-msg-streaming`，与 thinking 分离的 testid）。
- **错误条 + 重试**：网络错 / 无可用终态 payload → 错误条 + `重试` 按钮（重发上一条 user message，`CopilotDock.tsx:820-828` + `retry` `:475`）。
- **半截兜底（partial-degrade）**：SSE 流中途出错但部分文本已持久 → 保留已渲染文本 + 并排显示错误提示（`CopilotDock.tsx:455-457`）。
- **脱敏**：服务端故障一律回固定串 `Internal Server Error`，真实信息绝不出站（`chat.unit.test.ts:88`）。
- **反模式**：这些是**功能正确但视觉零规约**的兜底——它们今天复用 Dock chat token 草草渲染，没有作为「对话的诚实失败形态」被设计过。

---

## 对话面应呈现什么（功能层，非视觉）

### ① 回复长度 / 语气 / 叙事 vs 一句话+下钻

1. **第一人称单一嗓音**：对话始终是单编排者第一人称（「我」/ `Loom Copilot`）。即便回复内容源自后台姿势（引用「我昨夜想的」），对用户仍是同一个「我」在说话——**不暴露 dreaming / coach / goal_scope 的内部分轨**给 owner（分轨只在可观测留痕里）。
2. **两种回复密度的形态区分**：
   - **一句话 + 下钻**：默认形态。编排者给一句直接回应 + 至多一个 hero 交付物（题 / 卷 / 笔记 / 互动 / 工具结果）作为「全量入口」。owner 一眼读完，要深入就开 hero。
   - **叙事铺陈**：少数场景（交代「我替你想了什么」/ 解释一个判断 / 教学 explain 段）允许多段铺陈。需要一个让 owner**一眼看出「这是一段交代，不是一句答」**的形态承载差异。
3. **策展 ≠ 啰嗦**：长不是默认，叙事是有理由才长（synthesis §2.1「先轻后叙事」精神）。claude design 须给「短」与「长」两态明确的视觉边界，避免模型把每条都写成小作文。
4. **hero 剂量**：一轮至多一个 hero（`primary_view` 是单一交付物，`CopilotHeroCard.tsx` 头注 §2.5）。hero 上**不挂技术 ribbon**（cost / model / caused_by）——hero 是交付物不是回执。

### ② 主动开口时机（内容驱动，取代盲目计时器）

编排者的「主动性」要从 R-3 的盲目计时器升级为**内容驱动的开口**。functional 形态需覆盖至少两个触发场景 + 一条克制约束：

1. **练习卡住 nudge**：owner 在练习流连续卡顿 / 长时间停留 / 反复错同一类 → 编排者主动开口提议（「要不要我换个角度讲讲这个？」/ 给提示）。**这是 hint-first 自主滑块（§2.3 ②）的对话入口**——主动开口给的是提示而非完整解，可逐阶走到完整答案后交还控制。
2. **录入后提议**：owner 录入完一份材料（ingestion 完成）→ 编排者主动开口提议下一步（「我看了这份材料，要不要我建知识点 / 出套题？」）。
3. **克制约束（显式功能要求）**：主动开口必须**可忽略、不抢焦点、不强制确认**，且**单位时间有上限**（避免编排者话痨——对应 §4.2 A 档的熔断精神：单用户没有第二个审计人，主动性门槛要比工业更严）。owner 一旦在某场景 dismiss，同场景短期内不再主动开口。
4. **与被动开口的关系**：dwell 计时器（R-3）作为**保底**可保留，但内容驱动 nudge 是新的主动性主路径。两者都不得在 owner 正输入 / 正答题时打断。

> claude design 须给主动开口一个**与 owner 主动提问明显不同**的形态（譬如「编排者起的话头」与「我问的」在对话流里可区分），让 owner 清楚「这是它主动找我，不是我问的」。

### ③ 逐条 checkpoint keep / revert / cherry-pick

当编排者在一轮对话里做**多步改动**（譬如「补全这 3 个知识点 + 出 1 套题」），owner 要能在对话面**逐条看清并逐条处置**：

1. **逐条显形**：多步改动在对话里**逐条列出**（每条：改了什么 / 影响哪个实体 / 可逆性档位），不是一句「已完成」黑箱，也不是整批甩去 /inbox。
2. **三种逐条动作**：
   - **keep**（留下）：接受这一条。
   - **revert**（回退）：撤销这一条（对应 §4.2 A 档「一键 revert」）。
   - **cherry-pick**（挑选）：多条改动里只接受一部分 / 只退一部分，而非全留或全退。
3. **档位决定形态**（§4.2 全局出手强度表）：
   - **A 档**（静态可逆、低后果）：编排者**乐观应用** + 留撤销窗口 + 一键 revert。对话里以「已替你做了 X，可撤销」呈现，不打断。
   - **B 档**（不可逆 / 高后果，如知识节点 / 边 / 题草稿 / learning_item）：**逐条人审**才落库。对话里以「我想做 X，要不要？」呈现，owner keep 才写。**沿用既有 propose-only 红线**——B 档结构写入仍可经 /inbox（R-4）裁决，但本缺口要的是**让这层逐条裁决能在对话面内发生 / 显形**，不必每次跳页。
   - **C 档**（纯状态 / 旁观）：不入队列、不要 checkpoint。
4. **可追溯**（evidence-first 红线）：每条 keep / revert 都可追溯（runs log，§4.3 红线）。durable run 已有 `checkpoint_id` 锚点（R-4），逐步 revert 的后端能力是基础设施缺口（见末尾）。

> claude design 只需给出**逐条 keep / revert / cherry-pick 的对话内形态**（一条改动长什么样、三个动作怎么呈现、A 档「已做可撤销」与 B 档「待你确认」如何区分）。档位判定 / 后端 revert 是实现侧，不是视觉。

---

## 空态 / 失信兜底 / 故障态（显式功能约束）

> 这是对话面的**诚实失败形态**，是显式功能要求，不是边角。claude design 须为每一态给视觉形态；R-5 已列出哪些今天已内建（继承之，别推翻）。

| 态 | 触发 | 功能约束（必须呈现什么） | 现状锚点 |
|---|---|---|---|
| **空对话** | 从未对话 / 本 session 清空 | 一句引导：编排者会读你的错题 / 知识图 / 今日计划来答（已承诺）。**不能空白**。 | `CopilotDock.tsx:711-714` |
| **思考中（pre-first-byte）** | 已发送、首字节未到 | 明确的「在想」态，与「正在打字」**不同形态**。 | `copilot-thinking` `:806` |
| **正在打字（streaming）** | SSE delta 流入中 | 文本逐增 + 打字光标；owner 知道这是实时流不是卡死。 | `copilot-msg-streaming` `:737` |
| **SSE 半截**（部分文本 + 中途断） | 流中途出错但已持久部分文本 | **保留已渲染文本** + 并排标记「被截断」，不能丢已说的话。 | partial-degrade `:455` |
| **空回复 / 无可用终态** | 终态 payload 缺失 / 非法 | 丢掉半截气泡（不留半条孤儿消息）+ 错误条 + **重试**（重发上一条）。 | `:411-417` + `retry` `:475` |
| **网络 / 工具失败** | fetch 异常 / 流错误 | 脱敏错误条（绝不暴露内部信息）+ 重试。`请求失败（{status}）`。 | `:458-468` + 脱敏 `chat.unit.test.ts:88` |
| **durable 异步态** | `durable:true` 走后台 job | 返回 202 不开流；对话需呈现「这条在后台跑，回头看结果」的态（durable 形态当前**前端无承载**，见缺口）。 | `chat.ts` durable 分流 + `chat.unit.test.ts:95` |
| **主动开口被忽略** | 编排者主动开口、owner 不理 | 可静默消失，不堆积、不反复弹同一条。 | 待建（R-3 无内容驱动 nudge） |
| **hero 取数失败** | 持久互动产物 inline 渲染失败 | 降级回**纯引用卡**（图标 + label + 打开链接），不白屏。 | `CopilotHeroCard.tsx:105-112` |

**语义约束（非视觉）**：故障态是「诚实告诉 owner 发生了什么 + 给出路」，不是把错误藏起来假装成功。脱敏红线（内部信息不出站）已内建，须保留。

---

## 数据契约（wire 形状 + 真实 sample，no-mock）

> 全部 anchor 自真实代码 / 测试 fixture，非编造。

### POST /api/copilot/chat — SSE 流（同步主路径）

请求体（`CopilotChatRequest`，`CopilotDock.tsx:361-369`）：

```jsonc
{
  "user_message": "讲讲这道题",
  "triggered_by": "chat",            // 'chat' | 'chip'
  "skill_context": { "skill": "teaching", "ref": { "kind": "knowledge", "id": "kn_x" } }, // 可选，教学/出题路由
  "ambient_context": { "route": "/practice", "focused_entity": { "kind": "knowledge", "id": "kn_x" } } // 可选，当前面+在场实体
}
```

SSE 帧序列（真实 fixture，`chat.unit.test.ts:71-73`）—— 先 N 个 `delta`，终态一个 `reply`：

```
event: delta
data: {"text":"你"}

event: delta
data: {"text":"好"}

event: reply
data: {"session_id":"s1","reply_event_id":"e1"}
```

`reply` 帧的完整 payload（`CopilotChatResponse`，`CopilotDock.tsx:87-105`）：

```jsonc
{
  "task_run_id": "tr_…",
  "reply": "终稿全文（已剥 primary_view marker，权威文本，对齐任何 delta 漂移）",
  "surface": "copilot",
  "triggered_by": "chat",
  "session_id": "sess_1",
  "reply_event_id": "evt_…",
  "skill_turn": { "kind": "ask_check", "structured_question": { "id": "q_…", "kind": "mcq", "prompt_md": "…", "choices_md": ["A…","B…"] } }, // 可选，教学
  "primary_view": { "source": "artifact", "ref": { "kind": "question", "id": "q_x" } }, // 可选，hero 提名；缺省=无 hero
  "error": "…"  // 可选；流中途出错但部分文本已持久（partial-degrade）
}
```

故障终态帧（脱敏，`chat.unit.test.ts:88`）：

```
event: reply
data: {"error":"Internal Server Error"}
```

`primary_view` 判别式（`replay.ts:61-63`）：

```ts
| { source: 'tool_result' | 'artifact'; ref: { kind: string; id: string } }
| { source: 'ephemeral_html'; ref: string }   // ref 本身即一次性 HTML body
```

### POST /api/copilot/chat — durable 异步分支

`durable:true` + `triggered_by:'chat'` + enqueue 开启 → **不开 SSE**，返回 202 JSON（`chat.unit.test.ts:108`）：

```jsonc
{ "run_id": "copilot_user_ask_RID", "session_id": "sess_1" }
```

`run_id` = `checkpoint_id` = user_ask event id（`copilot_run.ts:61-65`）。状态经 `job_events`（`business_table: 'copilot_run'`）流转。

### GET /api/copilot/turns?limit=20 — 重放（重开 / 刷新）

返回最近 N 轮（oldest→newest），用于 Drawer 重开时 prefill（`replay.ts:104` + `turns.ts`）：

```jsonc
{
  "turns": [
    { "role": "user", "text": "讲讲这道题", "at": "2026-06-28T…Z", "event_id": "evt_u1" },
    { "role": "ai",   "text": "终稿全文", "at": "2026-06-28T…Z", "event_id": "evt_a1",
      "reply_event_id": "evt_a1", "session_id": "sess_1",
      "skill_turn": { "kind": "ask_check", "structured_question": { … } },   // 可选
      "skill_context": { "skill": "teaching", "ref": { "kind": "knowledge", "id": "kn_x" } }, // 可选
      "primary_view": { "source": "artifact", "ref": { "kind": "question", "id": "q_x" } } }  // 可选
  ]
}
```

重放是 best-effort：fetch 失败 → 留在内存列表（降级到无重放，不报错，`CopilotDock.tsx:314-316`）。

### GET /api/today/copilot-summary — Drawer 顶部摘要（夜想 / coach digest 落点）

`CopilotSummary`（`CopilotDock.tsx:55-64`）—— 这是后台姿势产出对前台对话的展示落点：

```jsonc
{
  "daily_focus": "今日主线一句话",
  "review_due_count": 3,
  "brief_global_md": "…",            // 可 null
  "dreaming_preview": [ { "proposal_id": "p_…", "kind": "knowledge_node", "brief": "…", "proposed_at": "…Z" } ],
  "pending_proposals_total": 5,
  "coach_last_run_at": "…Z",         // 可 null
  "dreaming_last_run_at": "…Z"       // 可 null
}
```

### checkpoint keep / revert / cherry-pick 的现状写路径（R-4）

对话提议的结构写入今天走 `/inbox`：`POST /api/proposals/[id]/decide`（decision: `accept` / `dismiss` / `reverse` / `change_type`）+ `POST /api/proposals/[id]/retract`（`ProposalCard.tsx:95-256` + `shell/manifest.ts:18-28`）。**对话面内的逐条 keep / revert / cherry-pick wire 尚不存在**（见缺口）。

---

## 不在本 handoff 范围

- 不改编排者的内容生成 / 工具调用逻辑（那是 AF / D14 后端）；本 handoff 纯前台对话体验形态。
- 不定**跨四面 voice / 引用契约**（夜想→晨交班→日练→晚收尾 24h 弧线）—— 那是 gate §2 item 4 的单独缺口，与本 doc 解耦。
- 不改 propose-only 红线 / 不动树 / 防循环注入五防（§4.3 红线延续）。
- hint-first 自主滑块的**阶数**（H0-H5 几阶）待 owner 拍（synthesis §2.3 ②，§7 待定）；本 doc 只给「主动开口=给提示而非完整解 + 可走到完整 + 交还控制」的形态约束。

---

## 边界提醒（给实现者，非 claude design）

- 对话面是 copilot capability 的前台面（`src/capabilities/copilot/ui/`），按既有 CopilotDrawer / Dock 形态接入，复用 `.copilot-loom` chat token，不新立视觉系统。
- 动 UI 代码前仍走项目的 design-doc pre-flight；本 handoff + claude design 视觉稿 = pre-flight 的输入。
- 故障态 R-5 已内建——实现时**继承既有兜底逻辑**，只换视觉皮，不重写正确的降级语义（脱敏 / partial-degrade / 单飞守卫 / 重试锚点都已实测覆盖）。

---

## 基础设施缺口（needs issue）

以下是把本 handoff 的视觉稿落地前**必须先建的后端 / 数据能力**，超出「换皮」范围，需独立 Linear 工单：

1. **内容驱动主动开口触发器**（对应 ②）：当前主动开口仅 30s dwell 盲计时器（`use-copilot-dwell.ts`）。要「练习卡住 nudge」「录入后提议」，需建 **编排者主动开口的触发信号源 + 单位时间熔断**（读 B3 信号 / ingestion 完成事件 → 决定「该开口」）。synthesis §2.3 delta ④「统一叙事接线」的对话侧落点。**零现实实现**。

2. **对话内逐条 checkpoint 的 revert / cherry-pick 后端**（对应 ③）：durable run 有 `checkpoint_id` 锚点（`copilot_run.ts:61`）但**无逐步 revert / cherry-pick 能力**，且对话提议今天整批甩 /inbox（`ProposalCard`）。要在对话面内做逐条 keep / revert / cherry-pick，需建 **§4.2 A 档「自动应用 + 撤销窗口 + 一键 revert + 熔断」通道** + 把 B 档逐条裁决能在对话面内显形 / 落点的 wire。synthesis §4.2 明列为 designed-not-built。

3. **durable 异步态的前端承载**（对应故障态表）：`durable:true` 返回 202 `{run_id}` 后，**前端无任何「这条在后台跑、回头看结果」的承载**——对话流不显示 pending durable run，无结果回填路径。需建 durable run 状态的对话侧消费（读 `job_events` `copilot_run` → 在对话流呈现进行中 / 完成）。

4. **会话级工作记忆正式契约**（贯穿 ②③，承重前置）：`ambient_context` 现仍是 `chat.ts` 私有入参（synthesis §2.3 现状「雏形未成契约」）。「刚 dismiss 哪条 / 上一轮练习结果 / 当前 focused_entity」要服务主动开口克制（不重复提议）+ checkpoint 显形，需把它升格为**所有 surface 共写、编排者共读的正式表**。synthesis §2.3 delta ①。这条是 ②③ 的共同数据地基。
