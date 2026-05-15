# Project Design System

_Started 2026-05-15 11:05 UTC_

---

## User

https://github.com/Yukoval-Dakia/the-learning-project 为此项目创建设计。读 docs/design/2026-05-15-design-brief.md 作为 ground truth，按 §8 顺序读其它 5 个文件。不要照 port 
  ▎ docs/design/loom-design/project/ui_kits/ 里的 JSX——那是 mistake-centric 旧 design。审美/voice/tokens/Primitives 命名保留，page 形状 + 
  ▎ 交互按 ADR-0006 v2 event-driven 核重画。

## Assistant

_[tool: github_read_file]_

_[tool: github_read_file]_

_[tool: github_read_file]_

_[tool: github_read_file]_

_[tool: list_files]_

_[tool: read_file]_

_[tool: list_files]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: update_todos]_

读完了。Brief 极清晰 — ADR-0006 v2 是 3-table 核（material + learning_session + event），ADR-0008 把 conversation 也吸收进 learning_session。Voice/tokens/Primitives 命名保留；page shape + 交互按 event-driven 重画。§9 给的默认（chain 用 inline details / inbox 分布式 + today 预览）我接住，在 prototype 里 surface 出来供 grill。

不开 questions_v2 了——brief 把决策点都列清楚了，先出第一版让你 grill。建计划，开工：

_[tool: copy_files]_

_[tool: copy_starter_component]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now write the app CSS:

_[tool: write_file]_

_[tool: write_file]_

Now primitives:

_[tool: str_replace_edit]_

Now the SEED data — event-shaped per ADR-0006 v2:

_[tool: write_file]_

Now the pages and Copilot drawer. This is the big one — six pages + drawer. Let me write it carefully:

_[tool: write_file]_

## Assistant

Now the pages — biggest file. I'll write all 6 routes + Copilot drawer:

_[tool: write_file]_

_[tool: write_file]_

_[tool: grep]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now let's load it and check for errors:

_[tool: show_html]_

_[tool: done]_

_[tool: show_html]_

_[tool: get_webview_logs]_

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: eval_js_user_view]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: save_screenshot]_

_[tool: str_replace_edit]_

_[tool: show_html]_

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: get_webview_logs]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: show_html]_

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: str_replace_edit]_

The debug `body.innerHTML = ...` clobbered `#root`. Let me clean up:

_[tool: str_replace_edit]_

_[tool: show_html]_

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: eval_js]_

_[tool: eval_js]_

_[tool: eval_js]_

_[tool: eval_js]_

_[tool: eval_js]_

_[tool: eval_js]_

_[tool: str_replace_edit]_

Found it — my inline `data-presets="react"` is preventing babel from transforming JSX. Removing it:

_[tool: show_html]_

_[tool: sleep]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: str_replace_edit]_

Rendering. Some layout fixes needed — nav chars are wrapping, inbox strip is cramped:

_[tool: show_html]_

_[tool: save_screenshot]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: show_html]_

_[tool: sleep]_

Let me see the page across the various screens — I'll spot-check a few:

_[tool: multi_screenshot]_

_[tool: str_replace_edit]_

_[tool: show_html]_

_[tool: multi_screenshot]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: show_html]_

_[tool: multi_screenshot]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: write_file]_

Let me write a README and surface this to you. README:

_[tool: done]_

_[tool: update_todos]_

_[tool: fork_verifier_agent]_

v2 落到 `loom-design-v2/`。按 ADR-0006 v2 + ADR-0008 重画——保留旧 loom 的审美、token、Primitives 命名，page shape + 交互全换 event-driven 核：

**6 路由 + Copilot drawer**
- `/today` — 4 KPI（全是 event filter）/ 三 lane / 夜间 Dreaming inbox strip / cost ribbon
- `/mistakes` — `events WHERE action=attempt outcome=failure` 视图；每条错题展开 caused_by 链上的孩子事件（judge + variant + propose + note），ProposalCard 内联 accept/dismiss
- `/review` — FSRS 三档 + 上次归因结论 + EventChain 推理钻取
- `/record` — 3 tab + Sub 0c SSE feed + layout_quality 提醒 + Vision Tier 2/3 rescue（明码 cost）
- `/knowledge` — 树视图 + per-node AI 活动 + 节点内嵌 propose 卡
- `/items` — 学习项 TODO（与 event 解耦保留）
- `/inbox` — §6.2 的独立路由选项（today strip 上"集中审批"进）
- Copilot drawer — `session.type='conversation'` + events；试调 `window.claude.complete` 失败回脚本

**§9 七问全做成 Tweaks 在右下面板**——inbox 形态 / Copilot 主动性 / Lane B/C 空数据处理 / 成本可见性 / actor 名展开。我的默认全选了 brief §9 标"默认"的那些，但每个都能切换 grill。

**新 Primitives**（v1 没画的，是 C+D 档核心）：`<ActorBadge>` · `<EventChain>` · `<ProposalCard>` · `<CopilotDrawer>` · `<CostRibbon>` · `<Lane>`。每个 AI event 都有 actor + task_run + cost 元数据。

**没做**：mobile-first /record 拍照流（§9 Q6）、knowledge force-directed graph（§9 Q7）、`/_/inspect`、dark mode、真 FSRS 数学——都按 brief §7 out of scope 处理。详细决策跟 hot-spots 写在 `loom-design-v2/README.md`，等你 grill。

## User

读docs/design/2026-05-15-design-brief-v2.1.md

## User

读docs/design/2026-05-15-design-brief-v2.1.md

## Assistant

_[tool: github_read_file]_

_[tool: list_files]_

_[tool: github_read_file]_

_[tool: grep]_

_[tool: show_html]_

_[tool: get_webview_logs]_

_[tool: multi_screenshot]_

Read it. v2.1 已经实装在 `loom-design-v2.1/` — diff-style 改 v2，全部 6 项都落到位了。快速核对一下当前状态：

Read. v2.1 已经在 `loom-design-v2.1/` 全部落地了 — 我之前的 grep 确认 6 项 brief 都在位：

**5 处 refine**
- §1.1 chain-shape per-context — `/mistakes` 保留 inline `<details>`；`/knowledge` 改右侧 detail drawer；Copilot 内"跳出"返回 `/mistakes` 
- §1.2 Copilot proactive: 默认 30s（slider 5–120s，新 `proactiveDelay` tweak）
- §1.3 Today KPI 第三格 → "AI 提议 · 待审" + 点击跳 `/inbox`
- §1.4 Vision Tier rescue 按钮拆双行（主 label + meta-row: model · cost）
- §1.5 EventChain 总成本走 summary；per-row 默认隐藏；新 `chainRowCost` tweak (summary-only / hover / always)

**Mesh 大补 (ADR-0010)**
- `KNOWLEDGE_EDGES` 6 条 + `RELATION_TYPES` 字典 (5 个 core 类型, 含 directed 标记)
- 2 条待审 edge proposal events（Maintenance agent 跑出）
- 新 Primitives: `<KnowledgeRelation>` · `<EdgeProposalCard>` · `<KnowledgeGraph>` (手写 SVG 力导 verlet)
- `/knowledge` Tree | Graph toggle + 节点 detail drawer + 关系分组
- `describeEvent()` 加 `propose × knowledge_edge` 路径
- `/today` inbox strip breakdown 加"关系建议"
- `/inbox` 拆三段 (关系建议 / 新节点 / 内容生成) 各自动作集

你 tweak 过的 `chainRowCost: "summary-only"` 是默认值——保持原样。要看实际效果 / 改某处 / grill 哪条？

## User

重新再读一下新版本

## Assistant

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: grep]_

_[tool: show_html]_

_[tool: sleep]_

_[tool: multi_screenshot]_

实物核对完了。v2.1 跑得很干净——所有 6 项 brief 都落地了：

**`/today`** — 4 KPI 第三格已是 "AI 提议 · 待审 = 7"（kpi-clickable，→ `/inbox`）。inbox strip 显示昨晚 Dreaming `跑了 120 分钟 · $0.060`，breakdown 含**关系建议 · 2**。

**`/knowledge` tree** — 顶 strip "AI 提议了 2 条新关系"，节点行右侧显示 mistake count + 活动数 + "新关系" badge（`之 (用法)` 有 1 错 · 3 事件 · 新关系）。`[树 | Graph]` toggle 工作。

**`/knowledge` graph** — 手写 SVG 力导出来了（断句 / 翻译节点位置合理，coral 实线 = prerequisite，灰虚线 = related_to）。

**节点 detail drawer** — 右侧滑入，分四段：AI 建议关系 / 关系 / AI 建议子节点 / 近活动。我刚才点的是根节点 `k_wenyan`（无 mesh 边，所以看到空态——data 上正确，但 demo 上选个叶节点更有看头）。

**`/inbox`** — 三段拆分清楚。EdgeProposalCard 形态：`之·定语标志` →派生自 `之(用法)` + 推理理由 + 4 动作 (接受 / 改方向 / 改关系 / 忽略) + 右侧 EventChain summary "4 events · $0.0174"（`chainRowCost=summary-only` 生效，per-row cost 不显）。

**`/mistakes`** — 错题卡片 + 你的答（红）/ 参考（绿）/ AI judge 蓝条 + concept(87%) + EventChain。

要 push back 的几个 hot-spots（README §你 grill 时的新 hot-spots 已列）现在我亲眼看：

1. **detail drawer 在 graph 视图下盖一半 canvas** — README §1 已 flag，确实视觉冲突
2. **"改方向" / "改关系"** 当前是 stub 按钮，没接交互
3. **kedge_01 (`之 → 文言虚词 derived_from`)** 其实重复了 tree parent_id — 我倾向 push back：mesh 表只存非 tree 边

要我现在就改哪条，或者还有 grill 的方向？

## User

我是说v2.1 brief

## Assistant

Ah，brief 本身——我重读：

**brief 的判断**

它是 **delta，不是 redo**——v2 保留 95%，diff-style 改。这立刻把工作量从"重画"压成"5 处 surgical refine + 1 处大补 mesh"。

**5 个 refine 都有同一种 grounding**：把 v2 里"sales-pop / 仪表盘 / 流水帐"的反射换成"克制 + 分层 + 可信"。

| § | 替换的反射 | 换成 |
|---|---|---|
| 1.1 EventChain | inline `<details>` 摊在三处 | per-context：mistakes inline / knowledge → drawer / Copilot 跳出 |
| 1.2 Copilot proactive | 1.2s = 弹窗节奏 | 30s + revisit 信号（行为信号 > 时长） |
| 1.3 Today KPI | "AI 提议 · 24h"（vanity metric） | "AI 提议 · 待审"（action metric，可点） |
| 1.4 Vision Tier cost | 单行混排 (model · cost 抢主焦) | 主 label + meta-row（成本退后） |
| 1.5 EventChain cost | per-row noise | summary 汇总；per-row 默认隐藏；ProposalCard 上必显（成本决策点） |

**§2 mesh = 真正的架构补丁**：ADR-0010 把 knowledge 从一棵树升级到 tree+mesh。这不是 UI 加 graph 视图的事——是 schema 加 `knowledge_edge` 表 + `event.subject_kind` 扩 `'knowledge_edge'` + 6 个新 event 路径（propose/generate/rate × edge）。UI 顺势补：节点 detail drawer 的"关系"段 / Tree|Graph toggle / EdgeProposalCard（accept/reverse/change/dismiss 4 动作）/ inbox 拆三段（edges / nodes / artifacts）。

**brief 明确回答了 v2 我留的两个 grill 问题**（§4）：
- Q2 inbox 双入口 — 保留（today strip = "yesterday's haul peek"，/inbox = "all unhandled"）
- Q6 force-directed graph — 本轮做（升级为"确定需要"）

**brief 留给 designer 的两个 open choice**：
- §2.3.b graph 库选型 — 给规模上下文（< 1000 节点 / ~5000 edges），让我选
- §结尾："你看完发现某条 refinement 我说错了/路径不对，可以 push back" —— 明确邀请 design pushback

**我自己在实装时 push back 的口子**（我倾向提的，brief 没堵）：
- §2.1 数据里 `kedge_01 = 之-用法 →derived_from→ 文言虚词` 其实重复了 tree 的 parent_id。这违背 "tree 是骨架，mesh 是肌肉"——mesh 应只存**非 tree** 的关系。brief 自己例子 stub 就这样存了，但显然是为了演示，我倾向不存。
- §1.2 "revisit = 2 次访问立即开" 仍是时长替代品——更准的"卡住"信号是 *scroll/hover idle 5s+ 无 click*（dwell with no progress）。但实装难度高，先保留 brief 的 revisit 触发即可。

读完了。要从哪条往下做？

## User

没有关于tool-use的信息吗

## Assistant

对，brief v2.1 **没**点 tool-use 的 UI——只在 schema 层上提了"AI 调 tool 写 `action='generate'/'propose'/'rate'` event + `task_run_id` 关联 task_run"（这是 ADR-0006 v2 + ADR-0008 修订里就有的事实），但 UI 怎么呈现 tool-use **空缺**。

v2.1 现在的处理是**事后视图**：

| 时间 | UI |
|---|---|
| 调用中 | drawer 顶部 `归因中...` 三点（笼统） |
| 调用完 | 一条 event 落下 → ProposalCard / EventChain row |

这等于把 tool-use 压成了 `task_run_id + cost_micro_usd` 两个 meta 字段。**实时**那一刻没专门表达。

如果要补，可以做的方向：

1. **chain row 显式 tool name** —— 现在 EventChain row 只印 `attribution · t_001 · $0.0042`，加一格 `→ judge_question(q1)` 把 tool 名摆出来（Anthropic / Cursor 风格）
2. **Copilot drawer streaming tool indicator** —— 把 typing `…` 换成 `调用 propose_knowledge_edge(from=k_shici, to=k_juedu)` 的实时栏（带可折叠 args / result）
3. **task_run 详情 popover** —— hover `t_001` 弹出该 run 的 messages/tool_calls/tokens/duration（已有 `cost_ledger` / `tool_call_log` 表撑得起）
4. **新 event action `experimental:tool_call`** —— 把 tool 调用本身做成 event，actor=agent + action=tool_call + subject=event(parent run)，让 EventChain 自然包含

要不要在 v2.1 加一处 tool-use 显形？我倾向 (1) + (3) 起步——chain row 加 tool name + `t_xxx` hover popover——成本最低、信息密度最高。drawer 的实时流（2）+ event 新 action（4）等真有 SSE 接入再做。

## User

重新拉brief

## Assistant

_[tool: github_read_file]_

_[tool: read_file]_

_[tool: read_file]_

拉到了——brief 现在 18KB，**§1.6 Copilot tool-use 三段式**是新加的大件（比 mesh 还重要）。我之前 push back 的两条都被吸收了：

- §1.2 `revisit` 改成 v2.1 baseline，dwell-no-progress 记为 future direction
- §2.1 mesh 只存非 tree 关系 — KNOWLEDGE_EDGES 整组重写

新增工作：

| § | 任务 |
|---|---|
| 1.6 | `<ToolUseCard>` primitive · 6 个 tool SEED (`query_events / query_knowledge / query_mistakes / propose_variant / attribute_mistake / propose_edge`) · 重写 Copilot SEED 对话含 tool-use chain · drawer 渲染三段式 · 新 tweak `tool-use 详细度` (folded / expanded / off) |
| 2.1 | KNOWLEDGE_EDGES 重写：去除与 tree parent_id 重复的边 |
| 2.3.a | 节点 detail drawer：Tree 段（parent/children）与 Mesh 段物理分离 |
| 2.3.b | Graph 视图：tree edges 灰细折线衬底，mesh edges 分色盖在上面 |
| README | 强调 tool-use 是 C/D 档立足点 |

我分几轮做，不一次性巨写。先 data.jsx——这是地基。

_[tool: str_replace_edit]_

Data 层重写。一次性 batch edits：

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now the Copilot conversation — replace it with a tool-use demonstration:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: read_file]_

_[tool: str_replace_edit]_

Now primitives — ToolUseCard + describeEvent for tool_use:

_[tool: str_replace_edit]_

Now the CopilotDrawer — render tool-use events inline, and accept `toolUseDetail` prop:

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now thread `toolUseDetail` from App + add CSS + add tweak:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now ship it and check:

_[tool: show_html]_

_[tool: sleep]_

_[tool: multi_screenshot]_

_[tool: multi_screenshot]_

_[tool: eval_js]_

_[tool: save_screenshot]_

_[tool: view_image]_

_[tool: eval_js]_

_[tool: str_replace_edit]_

Tool-use flow rendering correctly: 2 tool cards + 3 suggested-action chips after first explain. Now finish the remaining brief items — Knowledge §2.3.a (Tree vs Mesh sections separated) and §2.3.b (tree edges underneath mesh edges in graph):Now graph view — pass tree edges as a separate underlay layer:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now check it renders. Then update README:

_[tool: show_html]_

_[tool: get_webview_logs]_

_[tool: multi_screenshot]_

_[tool: str_replace_edit]_

_[tool: done]_

All three §1.6/§2.3 items rendering cleanly: graph view shows dashed gray tree underlay + colored mesh on top; node drawer has separate `层级 · tree` and `关系 · mesh · 2` sections. Update README:

_[tool: write_file]_

_[tool: fork_verifier_agent]_

Brief v2.1 全部 6+1+1 落地：

**§1.6 Copilot tool-use** ⭐ ——新 `<ToolUseCard>` 三段式 · `TOOLS` 字典 6 个 · Copilot SEED 重写为含 2 次 tool-call 的真对话（`query_mistakes` → 引用 e_20 → chip "出 3 道变式" → `propose_variant` 写 e_70/71/72）· 新 tweak `toolUseDetail` (folded/expanded/off)

**§2.1 mesh 去镜像** ——我之前 push back 的"mesh 不存 tree 已表达的边"被采纳；KNOWLEDGE_EDGES 重写不含 `derived_from → parent_id`。加 `k_yuwen` 让跨 2 跳 ancestor 的例子成立。

**§2.3.a 节点 drawer 拆段** ——`层级·tree`（parent_id）和 `关系·mesh·N`（edges）物理分离

**§2.3.b graph 视觉分层** ——tree edges 灰虚线衬底（始终渲染、参与力导布局），mesh edges 按 relation_type 分色盖上。Legend 加 `tree (parent_id)` 一项

新 grill 口（写在 README）：

1. ToolUseCard folded 时 args 看不见——要不要摘前 20 字
2. `suggested_actions` chip 现在走 `sendUser(label)`——真 agent 应当 chip → 直触发 tool_use 事件、跳过 user msg
3. failed tool case 没 SEED
4. `k_yuwen` 是凑跨 2 跳例子加的，真用户可能只一棵文言文树

要 grill 哪条？

## User

再次拉brief，确认没有修改

## Assistant

_[tool: snip]_

_[tool: snip]_

_[tool: github_read_file]_

_[tool: str_replace_edit]_

Brief 又更新了——18KB → 20KB，三处都是 designer 反馈采纳，正好对应我之前 grill 的 4 个 hot-spots：

| 我提的 hot-spot | brief 采纳 |
|---|---|
| #1 ToolUseCard folded 时 args 看不见 | §1.6 #3a：每个 tool 自定 `foldedSummary`，6 个范例 |
| #2 chip 走 sendUser 不对 | §1.6 #3b：新 event `accept_suggestion`，UI 是 chip-tag row 不是 bubble |
| #3 failed tool 没 SEED | §1.6 #5：要 soft fail (0 results) + hard fail (timeout) 两种 |
| #4 k_yuwen 凑跨学科例子 | §2.1: "Phase 1 单 subject，不引入跨学科 root"——kedge_04 改成 `k_xuci_zhi → k_juedu related_to` 在文言文树内 |

加 §1.6 #6（我没提）：`/inbox` 也要带 tool-use trace——Dreaming chain 应显示它先调了 `query_mistakes` 再 generate。

逐一改。先 data：Now the bigger work — per-tool foldedSummary + chip → accept_suggestion + failed-tool SEED + dreaming tool-use trace:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now add the dreaming chain tool-use trace (§1.6 #6) — insert a `query_mistakes` tool_use between e_31 scan and e_32 generate:

_[tool: str_replace_edit]_

Now primitives — ToolUseCard uses per-tool foldedSummary; CopilotDrawer handles accept_suggestion + failure UI:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now CopilotDrawer — handle accept_suggestion as a small chip-tag row, and rewire chip clicks:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Ship and verify:

_[tool: show_html]_

_[tool: sleep]_

_[tool: eval_js]_

_[tool: sleep]_

_[tool: eval_js]_

_[tool: get_webview_logs]_

_[tool: show_html]_

_[tool: sleep]_

_[tool: eval_js]_

_[tool: sleep]_

_[tool: eval_js]_

_[tool: sleep]_

_[tool: eval_js]_

_[tool: grep]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: sleep]_

_[tool: eval_js]_

_[tool: show_html]_

_[tool: sleep]_

_[tool: eval_js]_

_[tool: get_webview_logs]_

_[tool: sleep]_

_[tool: eval_js]_

_[tool: write_file]_

_[tool: show_html]_

_[tool: sleep]_

_[tool: eval_js]_

_[tool: read_file]_

_[tool: show_html]_

_[tool: sleep]_

_[tool: eval_js]_

_[tool: eval_js]_

_[tool: sleep]_

_[tool: eval_js]_

_[tool: delete_file]_

_[tool: save_screenshot]_

_[tool: view_image]_

All four working: per-tool summaries (`failure + 无 judge + 7d · 1 event found`), `msg-accept` chip-tag row, soft fail (0 results + corrective chips), hard fail (red, timeout, retry chips). Clean up + screenshot + README:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: done]_

Brief 第二轮的 4 处反馈采纳都落地：

**§1.6 #3a per-tool foldedSummary** ——`TOOLS` 字典每个 tool 带回调；ToolUseCard 折叠时显示 tool-defined 摘要：
- `query_mistakes` → `failure + 无 judge + 7d · 1 event found`
- `propose_variant` → `q3 · n=3 · 3 variants generated`
- `query_events` → `review · 30d · 0 events found`
- `propose_variant` (timeout) → `q3 · n=1 · timeout after 30s`（红）

**§1.6 #3b chip → accept_suggestion** ——新 event action，UI 渲染为 dashed chip-tag row（"采纳建议 propose_variant 出 3 道变式"）而非伪 user bubble。caused_by 链：`explain → accept_suggestion → tool_use → explain` 四段连起来

**§1.6 #5 failed tool 双 mode** ——SEED 加 4 条新 event：
- soft fail：`query_events` returned 0 → Copilot acknowledge + 修正 chip "扩到 90 天再查" / "看所有 attempts"
- hard fail：`propose_variant` outcome=`failure` + `error_reason: 'timeout_30s'` + `error_detail` → 红边框 + 重试 chip + graceful degradation 文字

**§1.6 #6 Dreaming chain tool-use trace** ——`e_31a` 插在 scan ↔ generate 之间：`tool_use: query_mistakes(k=k_xuci_zhi, 30d) → 5 found · 3 distinct causes`。点 EventChain 能看到 AI 不是凭空生成变式，是先查了 5 道相关错题再决定

**§2.1 不引入跨学科 root** ——撤 k_yuwen；kedge_04 改为 `k_xuci_zhi → k_juedu related_to`（同在文言文树内，跨 2 个一级子树）

新 grill 口我写在 README，主要是 mock vs 实装的边界（chip → 真 tool 调用）和 EventChain summary 是否按 actor_kind 分色。

