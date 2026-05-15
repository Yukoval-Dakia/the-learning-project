# Loom · v2.1 design — refine + knowledge mesh + tool-use (ADR-0010)

> v2 (`docs/design/loom-design-v2/`) 不动 95%；本轮 **6 处 refine + 1 个大补 mesh + 1 个 D 档立足点 tool-use**。

跑：`open loom-design-v2.1/index.html`。

---

## v2 → v2.1 改了什么

### Refine (brief §1)

| § | v2 现状 | v2.1 改成 |
|---|---|---|
| **1.1** EventChain 形态 | `<details>` inline 在 mistakes / knowledge / Copilot 三处 | `/mistakes` 保留 inline；`/knowledge` 移入节点 detail drawer；Copilot proposal 上"查看推理" → 跳出 drawer 到 `/mistakes` |
| **1.2** Copilot proactive 触发 | 1.2s（sales-pop 节奏） | 默认 30s + revisit 信号（第 2 次访问立即开）· 时长 slider 5–120s。Future: dwell-no-progress 行为信号 |
| **1.3** Today KPI 第三格 | "AI 提议 · 24h"（vanity） | "AI 提议 · 待审"（actionable，点 → /inbox） |
| **1.4** Vision Tier rescue | `Vision Tier 2 (Haiku · $0.005)` 单行 | 主 label + 第二行 meta-row (model · cost 退后) |
| **1.5** EventChain per-row cost | 每行印 cost = noise | summary 汇总；per-row 默认隐藏；新 tweak `chainRowCost`。ProposalCard 必显 |
| **1.6** Copilot tool-use ⭐ | text-only chat (chatbot 而非 agent) | 新 `<ToolUseCard>` 三段式 · 6 个 tool SEED · Copilot 对话调 `query_mistakes` 后引用具体 e_20 · "出 3 道变式" chip 触发 `propose_variant` · 新 tweak `toolUseDetail` (folded/expanded/off) |

### Knowledge mesh — ADR-0010 (brief §2)

- `data.jsx` 加 `KNOWLEDGE_EDGES`（6 条，**只存非 tree 边** —— 不与 parent_id 镜像）+ `k_yuwen`（语文根，演示跨 2 跳 ancestor）
- `RELATION_TYPES` 字典：5 个 core 类型 + directed 标记 + arrow / tone 样式
- 新 Primitives：`<KnowledgeRelation>` · `<EdgeProposalCard>` · `<KnowledgeGraph>` (手写 SVG verlet)
- `/knowledge` 重做：
  - `[ 树 | Graph ]` toggle
  - 节点 → detail drawer。**§2.3.a**: `层级·tree`（来自 parent_id）和 `关系·mesh·N`（来自 edges）**物理分离**
  - Graph: **§2.3.b**: tree edges 灰色虚线衬底始终渲染；mesh edges 按 relation_type 分色盖在上面
- `describeEvent()` 加 `propose × knowledge_edge` 和 `experimental:tool_use`
- `/today` inbox strip breakdown 加"关系建议"
- `/inbox` 拆三段：关系建议 / 新节点 / 内容生成

### Tool-use（brief §1.6 — C/D 档立足点）

> "AI 没有 tool 就不是 agent，design 必须先反映这点。"

- `data.jsx` 加 `TOOLS` 字典（6 个，**每个带 `foldedSummary(args, result)` 回调**——§1.6 #3a）+ `COPILOT_SEED_EVENTS` 重写（12 轮含 4 次 tool-use：成功 query/propose + soft fail + hard fail）+ `COPILOT_TOOL_EMITTED_EVENTS`（tool 产出的 3 个 generate artifact event）
- Dreaming chain 加 `e_31a` (`tool_use: query_mistakes`) 演示 AI 推理可见——§1.6 #6
- `<ToolUseCard event detail="folded|expanded|off">`：
  - **folded**: tool 自定 summary（不再 generic 截断）
  - `query_mistakes`：`failure + 无 judge + 7d · 1 event found`
  - `propose_variant`：`q3 · n=3 · 3 variants generated`
  - `query_events`：`review · 30d · 0 events found`（soft fail）
  - `propose_variant`：`q3 · n=1 · timeout after 30s`（hard fail · 红边框）
  - **expanded**: args (key:value) + result rows + event id / task_run_id + 失败时露 `error_reason` + `error_detail`
  - **off**: 隐藏
- CopilotDrawer：
  - `experimental:tool_use` 渲染独立卡片
  - **`experimental:accept_suggestion`**（§1.6 #3b）：用户点 chip = 写 accept_suggestion event，UI 渲染为小**chip-tag row**（"采纳建议 → propose_variant · 出 3 道变式"）。**不**伪装成 user msg
  - chip 触发的 tool 走 `acceptSuggestion → runAgentToolCall` 链：写 accept event → 写 tool_use event → 写 explain event，三段在 caused_by 链上正确连起来

---

## 新 Tweaks

- `proactiveDelay` (slider · 5–120s · 默认 30s) — `copilotMode='proactive'` 时显
- `chainRowCost` (radio · summary-only / hover / always · 默认 summary-only)
- `toolUseDetail` (radio · folded / expanded / off · 默认 folded) — §1.6

旧 4 个 tweak 保留：`inbox` / `copilotMode` / `lanes` / `costVisible`+`showActorRef`。

---

## C/D 档场景

1. **错题 + AI 链上孩子事件**（v2）：`/mistakes` attempt:failure 下挂 judge + variant + propose + note 的 caused_by 链
2. **夜间 Dreaming inbox**（v2）：`/today` strip 摘要 + breakdown
3. **Mesh edge proposal**（v2.1 新）：`/inbox` "关系建议" 段，EdgeProposalCard 4 动作 (accept/reverse/change/dismiss)
4. **Copilot tool-use 三段式**（v2.1 新 ⭐）：
   - 用户问 "现在有哪些错题可以推荐"
   - AI 调 `query_mistakes(filter:"outcome='failure' AND judge_status IS NULL", window:"now-7d")` → 1 event found
   - 回答引用 e_20 / q3 具体行（不靠 chat 记忆）
   - chip "出 3 道变式" → 调 `propose_variant(question_id='q3', n=3)` → 写 e_70/71/72 三个 artifact event

---

## Mesh 视觉决策

| 规模 | 库 |
|---|---|
| < 50 节点 | 手写 SVG 力导（当前）|
| 50-100 | 仍手写 + collision detection |
| > 100 | cytoscape-headless |

关系色 / 线型：

| Relation | 色 | 线 | Arrow |
|---|---|---|---|
| **tree (parent_id)** | `--ink-5` | **dashed (3 5)** | 无（衬底） |
| `prerequisite` | `--coral` | solid | → |
| `applied_in`   | `--info` | solid | → |
| `derived_from` | `--ink-5` | solid | → |
| `contrasts_with` | `--hard` | solid | 双向 |
| `related_to`   | `--ink-4` | dashed | 双向 |

不动 tokens.css。

---

## v2.1 grill hot-spots

设计仍开放的：

1. **`acceptSuggestion → runAgentToolCall` 的真假**：当前是 mock（"已执行" 占位 explain）。实装时该 chip 应该把 tool 调用真发出去，结果驱动新 explain。设计形态没问题，data 层是 stub。
2. **`/inbox` 的 EdgeProposalCard 上 EventChain summary** 现在 chain 里能看到 `e_31a tool_use` 这条——但 chain summary 只数 "events 计数"，没区分用户事件 / 工具事件 / 推理事件。要不要按 actor_kind 分色总数？
3. **Knowledge detail drawer** 在 graph 视图下盖一半 canvas（继承自 v2）。
4. **EdgeProposalCard "改方向" / "改关系"** 仍是 stub。
5. **soft fail 的 corrective chip "扩到 90 天再查"** 跑 `acceptSuggestion` 时——这是 user 接受 AI 推荐的查询，accept_suggestion 语义是否合适？还是该用别的 action？

---

## 已知 still-not-done

继承：mobile-first /record · 真 FSRS · dark mode · `/_/inspect`

新引入未做：
- "改方向" / "改关系" inline 编辑
- mesh edge archive UI
- Graph 缩放 / 拖拽
- failed tool-call SEED
- dwell-no-progress 行为信号（brief §1.2 future）
