# Copilot 呈现层设计（组合层定形）

> Status: **SETTLED（2026-06-09）** —— 全部 thread 收口（T4 / 执行模型 / P3 / T1 / P1→ADR-0033 / P2 / T3 / T5）。
> 本文件分两层：**组件层**（一个 tool call 长什么样）已由 claude design 出稿（YUK-276），
> **组合层**（一串卡 + 成品怎么排）= 本文件定的新面。结论：组合层基本是**既有通用机制上的 caller 策略**（density / primary_view / ribbon 剂量），零新卡片基建；唯二新建 = interactive artifact（ADR-0033）+ async tracker（P3）。
>
> 创建：2026-06-09。Refs：YUK-276（ToolUseCard 组件）· ADR-0033（interactive artifact）· `docs/design/2026-06-07-copilot-tool-use-cards/`（design handoff）· ADR-0031（draft=proposal）· ADR-0032（工具面）· `2026-06-04-agent-framework-design.md`（agent 论点）。
>
> **M5 后注（YUK-321，2026-06-13）**：Copilot 收口已落地为 `src/capabilities/copilot/`
> （capability manifest 的 copilotTools 贡献制 + Hono SSE，D14 单人格）。本文「唯二新建」中
> interactive artifact（ADR-0033）与 async tracker（P3）**未**随 M5 落地，保留为 future work；
> 文中 `app/api/**` 路径已随旧栈拆除迁移至 capability manifests。

---

## 0. 问题

同一个读工具（`query_mistakes` / `get_review_knowledge_snapshot`）有时是**通往造题的脚手架（过程）**、有时**本身就是用户要的答案（成品）**。谁是成品只有 **agent（orchestrator）知道**，不能让 UI 猜。两个判决性用例：

- **「出一道切合最近数学易错点的题」** → 多轮 tool call（找错题→分析易错点→造题）→ UI 出**题目卡**。成品 = 造出来的题。
- **「我最近哪些知识点易错」** → 一次读 → UI 出**知识点卡**。成品 = 读到的状态本身。

---

## 1. 组件层（已有，design 出稿 / YUK-276）

claude design 的 handoff（`tool-use-card.jsx`）：**每个 tool call 摊成一张富卡**，论点「AI 是带工具和成本的 agent，不是聊天框」。

- **5 部位解剖**：header（icon + fn + `agent` actor + 状态 pill）/ args（可折叠：key-value 列表 ↔ raw json）/ result（按状态切）/ ribbon（model · cost · latency · confidence · caused_by）/ actions
- **5 状态**：运行中（skeleton）· 完成 · 无结果（温和空态）· 失败（自动重试）· **待批准**
- **accept/dismiss 只在 `waiting` 状态出现** → propose→accept 闸**焊在卡上**；resolved-line 落一条新 event（`e_4491 · propose→accept`）。
- **8 工具词汇**：search_knowledge / query_mistakes（attempt→judge→cause 链）/ propose_variant / explain / schedule_fsrs（`$0.000` 确定性）/ propose_edge（mesh 边）/ write_note（diff）/ ocr_extract（SSE 流式）。
- **密度杠杆内置**：args 折叠 + design 自标「后续可加 Tweaks 切换卡片密度」。

组件层只管「一张卡」，明确没解决「一串卡 + 成品怎么排」。

---

## 2. 组合层（本文件要定的）

### 2.1 核心判断（RULED · agent 自主显示）

**是否卡片展示、谁是 hero，是 agent 每轮自主决定的**（owner 2026-06-09：「找题有时候只是过程、有时候是结果」——agent 说了算）。过程永远透明但可收敛；hero 由 agent 提名。**「过程 vs 成品」不是工具属性、也不是 effect 属性，是 agent 的意图判断**——同一个读工具，提名了就是成品，没提名就是过程。判断权 in-loop（不回退到 dispatch 处分类，ADR-0031 方向）。

### 2.2 综合：组合层驱动组件层的密度（不另造卡）

复用 design 已内置的密度杠杆，不和组件层打架：
- **过程 tool 卡 → 紧凑密度**（header + 一行 result + ribbon 收起）。透明性保留，不与成品争注意力。
- **hero 卡 → 完整密度**（full result + actions + 展开）。
- agent 的 hero 决定 = 选哪张走完整密度，其余紧凑。

### 2.3 信封字段：agent 的可选显示指令（非工具）

reply 信封加结构化字段（不是 DomainTool——呈现不是 domain mutation）：
```
primary_view?: { source: 'tool_result' | 'artifact' | 'ephemeral_html', ref }
```
- **缺省 → 无 hero**（纯对话答疑，文字 + 紧凑 trace）。
- 设了 → agent 提名某个 **已存在的** tool result / artifact / 现生成的 ephemeral html 为 hero。不重复取数；渲染器按 {工具名 / artifact 类型} → 卡组件（复用 YUK-276 词汇 + fallback）。
- 隐式默认：本轮创建了 artifact 但未显式提名 → 该 artifact 兜底为 hero。**这是兜底不是约束，agent 永远能覆盖**（把 find 提名成成品，或把造出的 artifact 压成过程）。

### 2.4 载体 taxonomy（intent → 载体）

agent 用 `primary_view` 自主提名 hero；载体由 intent 决定。6 个载体，4 个已有，只 P1/P3 新建。

| intent | 载体 | 持久化 | 状态 |
|---|---|---|---|
| 过程（agent 做了什么）| **tool-use trace 卡**（紧凑，ribbon 留痕）| tool_call_log | YUK-276 |
| 看一眼**只读**状态（「我哪里易错」）| **bespoke view 卡** | 不持久（in-stream）| YUK-276 词汇 |
| **快问快答**（当场作答）| **inline quiz 卡**（embedded-check，attempt→FSRS，YUK-283）| question 行 + artifact embedded_check | ✅ 已有（`EmbeddedCheckSection` / `/api/embedded-check`）|
| 持久**结构化**产物（题/卷/note）| **structured artifact**（body_blocks / tool_state）| artifact 行 + /practice | ✅ 已有 |
| 持久**交互式**学习内容（互动周期表/模拟/可视化）| **interactive artifact**（Claude-style：面板/沙盒/版本）| artifact 行 `type='interactive'` | 🆕 **ADR-0033** |
| **后台**任务（variant_gen ~120s）| **async tracker 卡**（job_events SSE，done resolve）| ai_task_runs + job_events；产物落 inbox | 🆕 P3 |

走用例：
- **出题**：`query_mistakes → snapshot → author_question` 全紧凑 trace；question artifact 天然 hero → 题目卡（「现在做→」= accept）。
- **易错点（只读）**：`get_review_knowledge_snapshot` 提名 `primary_view` → bespoke view 卡；不持久。
- **当场考你一道**：inline quiz 卡（embedded-check），用户作答 → FSRS。
- **给我个互动元素周期表**：`author_artifact(type='interactive')` → interactive artifact（沙盒面板打开，可 tag 化学知识节点复用）。见 ADR-0033。
- **变式（后台）**：enqueue variant_gen → tracker 卡实时 → done resolve 成提案卡；产物进 inbox。

### 2.5 hero 载体 = 结构化 artifact / HTML artifact / 提升的 tool_result

hero 多指某个 artifact（结构化 or HTML，§2.4 后三行）；只读视图是 tool_result 提名（次要路径）。**「看一眼(只读 bespoke 卡)」「快问快答(inline quiz 卡)」「持久交互式(HTML artifact)」是三个不同载体**——别再混成「临时 artifact」（那个提法作废）。

### 2.6 执行模型：sequence 默认 / async 逃生口（RULED · 2026-06-09）

「后台任务追踪」不是非此即彼——**默认 sequence，async 是重活逃生口，agent 自主选**。分界线 = **turn 能不能容忍这个时长**。

| | **sequence（默认）** | **async（逃生口）** |
|---|---|---|
| 执行 | tool `execute` 阻塞到出结果，SDK loop 自然 await | enqueue pg-boss job，立即返回 handle，worker 跑 |
| 进度 | running 态 + streaming（design 的 `ocr_extract` SSE-in-card）| tracker 卡订阅 job_events SSE |
| 上下文 | **同轮拿到，免费**（结果即 tool result，copilot 立刻用） | 跨边界，靠 agent_notes / 下一轮 re-fetch |
| 何时 | 几秒~几十秒、单/少量、用户在等、结果本轮要用 | 分钟级（quiz_gen ~120s）、扇出 N 个、fire-and-continue、产物本就落 inbox |
| 复用 | 现有 tool-call loop + streaming（YUK-266）+ tool-use 卡 running 态（YUK-276）| **P3 机制（下文）** |

**关键定位**：P3 的整套机制（AI 任务发 job_events + 通用 SSE + tracker 卡 + agent_notes wire）**只服务 async 逃生口，不是默认大建**。大部分「生成一道变式」（cheap_llm ~5-15s）走 sequence，不碰 P3，上下文同轮免费。反过度工程：先有 sequence（基本现成），async 作有界逃生口。

可选精修（backlog，先不做）：sequence 超时 → 用户「转后台」就地 detach。

---

## P3 · live async tracker（RULED · 2026-06-09）

### 缺口（grounded）
ingestion 有完整实时追踪（`writeJobEvent` → Postgres NOTIFY → `listen_loop` → `sse_router` fan-out → `/api/ingestion/[id]/events`，keyed `ingestion_session`）。**AI 后台任务（variant_gen/quiz_gen）完全不写 job_events、无 SSE**，只有 `ai_task_runs.status`（轮询）；copilot enqueue 是 fire-and-forget。→ 「后台生成变式」今天用户实时看不到任何东西。

### 设计：把已验证的 spine 接到 AI 任务（cross-process 已证 worker→app）

| # | 决定 |
|---|---|
| **P3-a** | tracker key = **per-run**（`business_table='ai_task_run'`，business_id = **enqueue 时预铸**的 run_id——`ai_task_runs` 行常晚于 enqueue 提交，故 key 必须预铸；job_events 独立于 ai_task_runs 行，enqueue 即可起流）。一轮可有多个 tracker |
| **P3-b** | runner 通用发 `enqueued/running/done/failed`；handler 可选发 `progress`。**job_events 是 spine，不轮询 ai_task_runs** |
| **P3-c** | 泛化 `/api/ingestion/[id]/events` → 通用 `/api/jobs/[table]/[id]/events`，复用 computeReplay + subscribe |
| **P3-d** | done → 卡 resolve 成成品卡 + accept；产物同时进 inbox（**T1 = inbox 持久 + tracker 卡实时，两者都要**） |
| **P3-e** | ribbon：running 显示 elapsed，done 显示终值 cost（`ai_task_runs.cost_usd`）——接 T5 |
| **P3-f** | 卡绑 run 不绑 turn（Last-Event-ID 续传，outlive 一轮，抽屉重开重订阅） |

### 上下文回流（async 路径专属）
copilot turn 驱动；任务 done 时 copilot 没在跑。两个需求分开：
- **「现在好了」实时上屏** = tracker 卡（SSE，无 LLM，不 re-invoke copilot）。
- **copilot 下一轮拿结果推理** = ① conversation_history（已 wire，YUK-267）② read 工具 re-fetch ③ **agent_notes**（`src/server/agents/notes.ts` 已建，copilot 是合法 target，但 chat.ts **还没把 `readAgentNotes('copilot')` 读进 run input**——缺的线）。
- **该补的 wire（= YUK-293，仅 async 路径需要）**：后台 done 时 `writeAgentNote({target:['copilot'], summary, refs:[{kind:'proposal',id}], signal_kind:'variant_ready', expires_at})` + copilot run input 接 `readAgentNotes('copilot')`。守防循环注入红线（notes 是事实非上轮装配物 / expires_at 防堆积 / 鲜读不回写 turn payload / 双截断）。
- **proactive re-invoke（task-done 主动弹「好了」）= 不做**（tracker 卡已实时；copilot 下一轮自然拿）。真要主动推送是另一个更重的 opt-in feature，不混进 P3。

---

## 3. 已拍 / OPEN

### ✅ T4 · primary_view 这层要不要 —— RULED（2026-06-09）
**要，框架 = 「agent 自主显示控制」**（owner：是否展示卡片 agent 自主决定）。一个 optional 信封字段 `primary_view`；缺省=无 hero；隐式 artifact-hero 是兜底不是约束。替代机制（位置规则 / effect 规则 / dispatch 分类）都断在 read-as-deliverable + 多工具淹没 + ADR-0031「判断权 in-loop」上。详见 §2.1–2.3。

### ✅ T2 · tool 卡 vs artifact 卡 —— 基本定向（2026-06-09）
owner 确认临时 artifact = HTML 形态（项目早期已有说法，未做）→ 推向**一个 artifact 家族 + persisted/ephemeral 子型**（§2.5），而非两套渲染器。hero 几乎总指某个 artifact。

### ✅ P1 · HTML artifact —— 升格成独立 ADR-0033（2026-06-09）
owner 校正：HTML artifact **不是数据视图，是 agent 生成的交互式学习内容**（互动式元素周期表为典型）——一种**新学习材料类型**，与 note/question artifact 并列，copilot 只是作者之一。已**移出呈现层范围、单开 `docs/adr/0033-interactive-learning-artifact.md`**（type=`interactive`、artifact 行、沙盒 iframe 去 same-origin + CSP 禁网、knowledge 绑定、reference 非 practice、`author_artifact` 写工具、version 迭代）。本呈现层文档只引用它：它是 §2.4 的「持久交互式产物」载体，`primary_view:{source:'artifact', ref}` 点开面板。

### ✅ P2 · bespoke 卡 vs HTML —— 经载体 taxonomy 化解（2026-06-09）
不是「读结果走 bespoke vs 生成 html」二选一，而是 §2.4 的载体分工：**只读已知视图 → bespoke view 卡**；**当场作答 → inline quiz 卡**；**持久定制交互 → HTML artifact**。三个不同 intent、三个载体，agent 按 intent 选。残留细节并入 T3（vocab 伸缩）。

### ✅ P3 · live async tracker —— RULED（2026-06-09）
见上「P3」专章（P3-a..f + 上下文回流 + 执行模型 §2.6）。要点：sequence 默认 / async 逃生口；P3 机制只为 async；job_events spine 泛化；agent_notes wire 收窄到 async；proactive re-invoke 不做。

### ✅ T1 · inline accept vs inbox —— RULED（经 P3-d）
**后台/夜间提案 → inbox 持久 + 对话触发的实时 tracker 卡 inline，两者都要**（tracker 卡 = 某 inbox-bound 提案的实时前端，accept 从任一处都 resolve）；纯对话内即时 sequence 提案 → inline `waiting` 卡当场批。关 ADR-0031（draft=proposal）+ owner 草图「现在做→」。

### ✅ T3 · 8 词汇 vs 34+ 工具伸缩 —— RULED（2026-06-09）
**grounded**：`ToolUseCard.renderResult()` switch 的是 `status` 不是 `toolName`；富内容是 caller 传的 `result?: ReactNode`；`summary` ← `DomainTool.summarize()`，done 态 fallback `result ?? body ?? null`。**「通用壳 + 按需 bespoke result + summarize() 兜底」已是现成架构。**
- **卡片壳 tool-agnostic**：34+ 工具白嫖 header/args/ribbon/states/actions。
- **bespoke `result` 节点 = caller 侧注册表，按需 opt-in**：只给「够格当 hero」的（用户面向成品型 + 高频过程工具），从 design ~6-8（fixtures 现覆盖 6）起，按需长。**不全 34 都做。**
- **fallback = `summarize()` 一行 = 紧凑 trace**（已在）。
- 接密度杠杆（§2.2）：result 节点展开 = hero 完整密度；缺省/折叠 = 紧凑 trace。

### ✅ T5 · 透明性剂量 —— RULED（2026-06-09，非对称）
**grounded**：`ToolUseMeta` 五字段全 optional、missing 静默 drop；`showMeta` 已在 empty/failed 隐藏。**剂量 = caller 填哪些字段，零卡片改动。**
- **过程/trace + tracker 卡 → 全 ribbon**（model·cost·latency·confidence·caused_by）。成本透明住在过程卡（兑现「带成本的 agent」论点；用户随时在 trace 看花费）。
- **hero 成品卡 → 抑制技术 ribbon**（默认不显 cost/caused_by/model；收据不是内容）。`confidence` 仅在对成品有语义时留；可「show details」按需展开成本。
- **hero provenance 重写**：不显 raw `caused_by e_xxxx`，显人话来源行（「针对你在『定语后置』的错误」）。
- 论点不破：成本在 trace 透明，只是不盖成品上。

---

## 4. 下一步

全部 thread 收口。组合层 = 既有通用机制上的 caller 策略（§2.1–2.6 + T3/T5），唯二新建 = interactive artifact（ADR-0033 / YUK-306）+ async tracker（P3）。

**剩余 impl 落点（拍前不写 UI 代码，CLAUDE.md UI pre-flight）：**
- `primary_view` 信封字段 + density 渲染（caller 侧 hero 提名 / 紧凑-完整切换）。
- bespoke `result` 注册表（从 design ~6-8 起按需长）+ ribbon 剂量 caller 策略（过程全 / hero 抑制）。
- P3 async tracker（job_events spine 泛化 + 通用 SSE + 卡绑 run + agent_notes wire）。
- interactive artifact → ADR-0033 / YUK-306。
- 关 YUK-276（组件层 S1）/ YUK-268（全屏面板）/ YUK-283（embedded-check FSRS）/ YUK-293（agent_notes）/ R2 二象性。

**Linear**：呈现层组合层 impl umbrella 待开（与 ADR-0031/0032/0033 impl 并列）。
