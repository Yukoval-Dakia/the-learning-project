# AI 学习工具 · 规划草稿

> 自用 · 移动 + 桌面双修 · 应试与兴趣并行
> v0.3 · 2026-05-07

---

## 一、定位

不是「错题本 + 进度统计 + 笔记工具」三件套的拼盘，而是围绕**知识点图谱**这一根锚组织起来的个人学习系统。

错题、进度、artifact 都是知识点的不同切面：
- 错题 = 知识点上「失败的尝试」
- 进度 = 知识点上「掌握度的演化」
- artifact = 知识点上「可被反复消费的产物」

只要锚不丢，模块就不会变成孤岛。

---

## 二、核心概念

### 知识点图谱（Knowledge Graph）

底层数据结构。每个知识点是一个节点，节点之间有「前置 / 关联 / 同属」三种边。

每个知识点至少包含：
- id / 名称 / 所属领域（应试科目 or 兴趣主题）
- 当前掌握度（0~1，分两层：base + AI delta，详见学习进度追踪）
- 最近一次活跃时间
- 关联资源（错题列表、artifact 列表、外部链接）

应试和兴趣两套图谱并存但相互引用，不硬合并；通过共享 tag 系统打通。

### AI 角色

不是聊天助手，是「数据加工 + 内容生产 + 主动判断」的中间层。它负责：
1. 归因 / 归类（错题 → 知识点、错因分析）
2. 生产（变式题、卡片、artifact、dreaming 推荐）
3. 复盘（周报、薄弱点诊断、下阶段建议）
4. 维护（提议删错题 / 合并节点 / 归档冷数据）

AI 是裁判而不是打分器：所有判断必须 evidence-based，留下推理痕迹。

### AI 能动性边界

支持 AI 主观判断，但分对象：

| 对象 | AI 能动性 |
| --- | --- |
| 软判断（完成判定、推荐、排序、人话总结） | ✅ AI 自由发挥 |
| 软提议（删错题、合并节点、归档、状态重置） | ✅ AI 提议 + 用户确认 + 可回滚 |
| 硬数据（错题正确率、复习记录、行为日志） | ❌ 事实层，不可改 |
| 不可逆消费（跨预算调用 LLM） | ❌ 硬约束 |

**自用工具最大的失败模式不是死板，是数据失信**。所有 AI 的判断和提议必须留痕，三个月后能回放为什么。

---

## 三、核心模块

### 1. 错题管理

**录入入口**
- 拍照 / 截图 → vision LLM 直接处理（跳过 OCR 中间层）
- 手动粘贴（纯文本 / Markdown）
- 从 artifact 或会话中反向标记

**AI 处理**

入库时同步必跑：
- 归因：概念不清 / 计算失误 / 审题 / 知识点缺失
- 挂载：定位到一个或多个知识点
- 触发：是否产生 LearningItem

异步可批（夜间 batch）：
- 变式题生成，结果先 draft，做完确认才进复习池

**复习调度**

应试场景下 **FSRS** 比 SM-2 更合适。每道错题保留：
- 首次错时间 / 累计错次数 / 最近一次复习状态
- FSRS state（due_at, interval, ease, repeat, lapses）

### 2. 待学习列表（LearningItem）

新一等公民——不是错题、不是知识点、不是复习队列，是「还没学 / 不熟，要去做」的项。

**四个来源汇入**

```
错题归因后        ─┐
主动输入          ─┤
学习意图声明      ─┼→ 待学习列表 (LearningItem)
AI dreaming 推荐  ─┘   (dreaming 来源经待审核区)
```

学习意图声明（"我想学氧化还原反应"）是主动输入的特殊子类——不只创建 LearningItem，还触发 Artifact 生成 pipeline。

**完成判定（多路径）**

不强制 quiz 才能 done。三条路径都接受：

| 路径 | 触发 | AI 角色 |
| --- | --- | --- |
| 用户自我宣告 | 用户点「完成」 | 看证据，足则 done，不足时反问 |
| AI 主动提议 | 长期信号积累后 | propose「我觉得你已掌握」，用户确认 |
| Quiz 通过 | 用户选择走严格路径 | 出题 + 评分；通过则 base mastery 硬跳升 |

**所有路径都产生 `CompletionEvidence` 记录**：列出 AI 看到的依据（近期错题表现、复习记录、artifact 触达、对话痕迹），可回放可质疑。

### 3. 学习进度追踪

**掌握度分两层**

- **Base mastery（确定性）**：错题、复习、quiz 通过等事件触发，公式驱动。事实层。
- **AI delta（覆盖层）**：AI 基于额外信号 propose 调整（「这周三次提到这个点都答得很顺，建议 +0.15」）。可见、可一键回滚。

最终展示 mastery = base + delta，但任何时候都能看到拆分。

**行为层（辅助）**

- 学习会话记录（番茄 / 自由计时）
- 连续打卡热力图
- 复习按时率

只观察行为习惯，不喧宾夺主。

**周复盘**

每周 AI 自动生成：
- 本周薄弱点 Top N
- 反复错的题
- 下周建议优先攻的知识点
- 一段「人话总结」

### 4. Learning Artifacts

**定位**：AI 是作者，用户是消费者。当前阶段只做 Note 型；Tool 型推到 Phase 3 评估。

#### 4.1 生成触发

三个入口都汇入同一 pipeline：
- 用户声明意图（"我想学氧化还原反应"）
- 错题归因发现缺口（AI propose："你似乎在 X 上有缺口，要生成笔记吗？"）
- Dreaming 主动 propose

每个入口都创建 LearningItem，并触发 NoteGenerateTask。

#### 4.2 Hub + Atomic 双层结构

不做单一巨型 note。每个学习主题拆成：

```
Hub Note: 氧化还原反应
├── Atomic Note: 概念定义        ← 知识点节点
├── Atomic Note: 电子转移机制    ← 知识点节点
├── Atomic Note: 化合价变化      ← 知识点节点
├── Atomic Note: 半反应与配平    ← 知识点节点
├── Atomic Note: 常见反应类型    ← 知识点节点
└── Atomic Note: 易错点          ← 知识点节点
```

每个 atomic note ↔ 一个知识点节点，mastery 在叶子层累积。Hub mastery 是子节点加权聚合。三个对象（artifact / LearningItem / 知识图谱）天然对齐。

#### 4.3 结构化 section 模板

每个 atomic note 至少包含五种 section：

| kind | 内容 |
| --- | --- |
| `definition` | 核心定义（1~2 句） |
| `mechanism` | 关键机制 / 公式 / 规则 |
| `example` | 标准例子（1~3 个） |
| `pitfall` | 易错点 / 常见误解 |
| `check` | 自检 mini-quiz（1~3 题，embedded） |

**理由**：结构化才能做"针对你最近的错题更新这一节"。完全自由的 markdown 只能 regenerate 整篇，成本高且失去连续性。

#### 4.4 生成节奏

- Hub outline + 第一节内容：**同步**生成（~5s 出现）
- 其他 atomic notes：进 batch 队列，**夜间产出**

用户立刻看到东西，敢相信系统在工作；昂贵的部分异步跑。

#### 4.5 Note 是活的

| 信号 | AI 反应 |
| --- | --- |
| 在 atomic note A 上停留很久 | 标记为难点，下次复盘提一下 |
| 在 A 对应知识点错题 | propose 更新 A 的 `pitfall` section |
| 用户问"再举个例子" | 在 `example` section 追加，留版本 |
| mastery 升高 | 自动生成 atomic note 的"精简复习版" |

这是相对静态笔记软件（Notion / Obsidian / Wikipedia）的护城河：内容跟随用户演化。

#### 4.6 Embedded check 闭环

`check` section 末尾的 mini-quiz 做对：
- 算 LearningItem done 信号之一
- 直接喂 base mastery
- 错的题入错题本，闭环回到错题管理

读 note 与做题不再分离。

---

## 四、Dreaming 与 Maintenance（两条 AI 主动 lane）

AI 主动产出走两条平行 lane，UI 模式一致：建议列表 + reason 展示 + 一键 approve / dismiss / batch。

### Dreaming（生产 lane）

| 产出 | 类别 | 触发 | 去向 |
| --- | --- | --- | --- |
| 每日总结 | 日报 | 自动 1/day | 阅读流 |
| 每日 quiz（1~3 题，≤3min） | 日报 | 自动 1/day | 任务流 |
| 题目推荐（自主） | 填充 | dreaming 不定期 | 待审核区 |
| 题目推荐（手动） | 即时 | 用户按钮 | 直接进待学习列表 |
| 知识点建议 | 填充 | dreaming 不定期 | 待审核区 |

**输入信号**：知识图谱邻接 + 薄弱点 + 久未触达 + 兴趣声明，四种皆用。

**健康指标**：dreaming 推荐的接受率。持续三月低于 30% 要砍信号或调 prompt。

### Maintenance（维护 lane）

| 操作 | AI 推荐时机 | 安全网 |
| --- | --- | --- |
| 删错题 | 重复 / 录入失败 / 孤儿 | soft delete，30 天可恢复 |
| 合并节点 | 节点名相似 / 关联错题/artifact 重叠率高 | canonical 节点保留 `merged_from[]`，可拆回 |
| 归档节点或学习项 | 久未触达（默认 90 天） | snapshot + 可回滚 |
| 重置 FSRS state | 用户标记「我忘了」 | snapshot |
| 重置 mastery | 推翻 AI 累积估计 | snapshot |

**统一原则**：所有 AI-proposable 的破坏性操作必须 reversible 一段时间。这是给 AI 推荐的「试错预算」——能撤回，你才敢相信它的推荐质量。

---

## 五、AI 任务层（LLM Task Layer）

独立模块。所有 AI 调用按「任务」抽象，**不**按 `chat()` 抽象——避免丢掉 provider 特色能力（prompt caching / batch API / structured output）。

### 5.1 Task 注册

```
任务                       →  Provider/Model 选择            tool call
────────────────────────    ──────────────────────────       ─────────
VisionExtractTask          →  低成本视觉 → Haiku vision      否
AttributionTask            →  Sonnet → Haiku 备选            是
VariantGenTask             →  Sonnet + batch                 否
QuizGenTask                →  Sonnet                          否
WeeklyReportTask           →  Opus + prompt cache             是
DreamingTask               →  Opus + batch + prompt cache    是
MaintenanceProposeTask     →  Sonnet + batch                 是
NoteGenerateTask           →  Sonnet + batch (atomic)         hub 是
NoteSectionUpdateTask      →  Sonnet                          否
```

每个任务独立选 provider，自由用 provider 特色（prompt caching / batch API / structured output），上层只关心业务语义。

### 5.2 运行时 Tool Calling

需要"边看数据边决策"的 Task 走 multi-turn tool call；输入已固定的 Task 走单轮 structured output。

**Tool 分组（按权限）**

```
Read（任何 Task 可用）：
  search_knowledge_by_concept / get_knowledge_node / get_node_neighbors
  find_similar_mistakes / get_recent_mistakes / get_weak_points
  get_review_due / get_learning_history / get_artifact

Write（Task 白名单）：
  create_knowledge_node           # AttributionTask
  link_mistake_to_node            # AttributionTask
  update_ai_delta_mastery         # 限定 Task，可回滚

Propose-only（产生待审核记录，不立即执行）：
  propose_completion / propose_merge / propose_archive / propose_delete_mistake
```

破坏性操作（删错题、合并节点）**没有直接 tool**——AI 只能 propose，走 MaintenanceSuggestion 流程。

**循环控制**

每个 Task 三层 budget：
```
TaskBudget {
  maxIterations    // 最多几轮 tool call
  maxCost          // 单次任务总成本上限
  timeout          // 总超时
}
```

超 budget → 1 轮 nudge（"必须给出最终答案"）→ 仍不收敛则 fallback 到确定性逻辑，记录 `degraded` 标记。

**实现**：tool-calling 循环、provider 兼容、流式都是成熟问题，**直接用开源方案**（Vercel AI SDK / LangChain / 自选），不自建。重点是把这四件做对：
- Tool 注册（含权限）
- Task → 允许 tool 白名单
- Budget 与降级
- ToolCallLog（必须）

### 5.3 成本控制

- 同步任务（用户操作时跑）：归因 + 挂载 + 视觉录入
- 异步 batch（夜间跑，50% 折扣）：变式生成、dreaming、maintenance、周报、atomic note 生成
- prompt caching：知识图谱 / 错题历史作为稳定 prefix
- 模型分级：简单任务用便宜模型
- 结果缓存：同 prompt 命中直接返回
- **预算天花板**：日 / 周 cost 上限，超了自动降级（顶级 → 中级 → 暂停 dreaming）
- 每次调用记录 `CostLedger`，按 `(task, provider, model)` 聚合可见

### 5.4 Skill / MCP Server / Plugin（推后）

这三块概念保留但不在 Phase 1 实现：

- **Skill**（提示词包，markdown + frontmatter）：Phase 2 在 prompt 重复多了之后再抽
- **MCP Server**（对外暴露 resources + tools）：Phase 2 等核心闭环稳了再 expose；Phase 1 在代码层面分好"以后能 expose"和"内部"目录
- **Plugin**（学科 bundle）：Phase 3 真有第二学科再做；Phase 1 划好 `core/` vs `subjects/math/` 的目录边界
- **外部 MCP 消费**（Calendar / Search / FS）：Phase 2 按需接

---

## 六、技术栈建议（务实版）

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 前端 | React / Svelte + Tailwind | 个人手感，两者都能 PWA |
| 桌面壳 | **Tauri** | 比 Electron 轻一个数量级，自用够了 |
| 移动 | PWA（先）→ 必要时 Capacitor 包装 | 不要一上来就 RN |
| 本地存储 | SQLite（Tauri 原生集成） | 错题/进度天然适合关系型 |
| 云同步 | Cloudflare D1 + R2 | 已有账号 |
| AI 调用 | 见第五节任务层 | |
| Tool calling 循环 | OSS 框架（Vercel AI SDK / LangChain） | 不自建 |
| 视觉 | vision LLM 直接处理（跳过 OCR） | 移动端拍照场景 |

**反模式提醒**：

- 不要一开始就上多端原生（RN / Flutter）
- 不要自建账号系统（自用没必要，需要时用 Cloudflare Access）
- 不要把 AI 调用做成「聊天框」，做成后台管线
- LLM 抽象层不要按 `chat()` 抽象，按任务抽象
- 不自建 tool-calling 循环，用 OSS
- schema 第一天就加 `updated_at` / `version` 字段，给同步留位

---

## 七、阶段路线图

### Phase 1 · 让一个闭环跑起来（最小可用）

只做错题管理 + 学习项 + 知识点挂载，验证数据模型。

- [ ] 知识点 schema（含 base / ai_delta mastery、merged_from、归档字段、updated_at/version）
- [ ] 课标 import + AI 自动建议节点（人工确认）
- [ ] 错题录入（vision LLM 直接处理）
- [ ] LearningItem 数据流（来源：mistake / manual）
- [ ] AI 归因 + 自动挂载知识点
- [ ] FSRS 复习队列
- [ ] 完成判定多路径（自我宣告 + Evidence 留痕）
- [ ] AI Task Layer 骨架（基于 OSS 框架，先单 Claude provider）
- [ ] Tool registry + Task 白名单 + Budget 控制
- [ ] ToolCallLog 观测
- [ ] 目录边界：`core/` vs `subjects/math/`
- [ ] 数据导出（JSON / Markdown）—— 给未来的自己买保险
- [ ] PWA 跑通（移动端能录入、能复习、能管学习项）

目标：自己能用它备考一周，跑出第一批数据。

### Phase 2 · 进度图谱 + Dreaming + Maintenance + Note Artifact

- [ ] base mastery 计算公式落定
- [ ] 知识点图谱可视化
- [ ] 学习会话记录 + 热力图
- [ ] 周复盘报告（WeeklyReportTask）
- [ ] Dreaming lane（每日总结、每日 quiz、题目/知识点建议）
- [ ] Maintenance lane（合并、归档、删错题、状态重置）
- [ ] 完成判定的 AI 主动提议路径
- [ ] AI delta mastery + 回滚
- [ ] **学习意图声明输入 + Artifact 生成 pipeline**
- [ ] **Hub + Atomic note 双层结构**
- [ ] **结构化 section 模板（5 种 kind）**
- [ ] **Hub outline 同步 + atomic batch 异步生成**
- [ ] **Embedded check 与 mistake / mastery 联动**
- [ ] **Note 演进机制（基于错题更新 section）**
- [ ] Skill 抽离（如果 prompt 重复够多）
- [ ] MCP Server expose（safe resources + propose-only tools）
- [ ] 外部 MCP 消费（Calendar 优先）
- [ ] 视觉模型 eval（MiMo / Qwen-VL / Haiku vision），定 baseline

### Phase 3 · Tool 型 Artifact / Plugin

- [ ] Tool 型 Artifact 评估（Note 升级 还是独立创作类）
- [ ] Plugin loader（如果引入第二学科）
- [ ] Tauri 桌面端打包

### Phase 4 · 体验打磨

- [ ] 云同步（D1 + R2，基于 Phase 1 留下的 version 字段）
- [ ] 离线优先策略
- [ ] 移动端拍照 vision pipeline 优化
- [ ] 多 provider 接入（按任务路由 / 备选链）

---

## 八、数据模型骨架（粗）

```
Knowledge
  id, name, domain, parent_id, last_active_at
  base_mastery, ai_delta_mastery
  merged_from[]                   // 合并历史，可拆回
  archived_at?
  updated_at, version

Mistake
  id, content, source, created_at
  → knowledge_ids[]
  → cause: {category, ai_analysis}
  → variants[]                    // 含 status: draft | active
  → fsrs_state {due_at, interval, ease, repeat, lapses}
  deleted_at?                     // soft delete (30 天后真删)
  updated_at, version

LearningItem                      // 待学习列表
  id
  source: mistake | manual | learning_intent | ai_dream
  source_ref                      // mistake_id / dream_id / null
  title, content
  → knowledge_ids[]
  primary_artifact_id?            // 主消费物（note hub）
  status: pending | in_progress | done | dismissed
  priority
  created_at, due_at?
  reviewed_at?
  updated_at, version

CompletionEvidence
  id, learning_item_id
  path: self_declare | ai_propose | quiz_pass
  evidence_json                   // AI 看到的信号快照
  decided_at

DreamingProposal
  id, kind: problem | knowledge | quiz | summary
  payload, reasoning
  status: pending | accepted | dismissed
  proposed_at, decided_at

MaintenanceSuggestion
  id, kind                        // delete_mistake | merge_knowledge | archive | reset_fsrs | reset_mastery
  target_ref
  reasoning
  status: pending | accepted | dismissed | rolled_back
  snapshot_json                   // 操作前快照，回滚用
  proposed_at, decided_at, rollback_until

Artifact                          // Note 优先；Tool 型 Phase 3 评估
  id
  type: hub | atomic              // Phase 1/2 只做 note
  title
  knowledge_id                    // atomic 必填，hub 可选
  parent_artifact_id?             // atomic 指向 hub
  child_artifact_ids[]            // hub 持有
  intent_source: declared | from_mistake | from_dream
  source_ref                      // 触发它的 LearningItem / Mistake / Proposal
  outline_json                    // hub: [{section_id, atomic_id, status}]
  sections: [{                    // atomic
    id, kind: definition | mechanism | example | pitfall | check
    body_md
    embedded_check?: {questions[], last_result}
    version
  }]
  generation_status: pending | partial | complete
  generated_by: {task, provider, model, prompt_version}
  history[]                       // 章节级 diff，可回放
  archived_at?
  updated_at, version

Session
  id, started_at, ended_at, type
  → knowledge_ids[]
  → mistake_ids[]

WeeklyReview
  id, week_start, summary_md
  → weak_points: knowledge_ids[]
  → recurring_mistakes: mistake_ids[]

ToolCallLog                       // 运行时 tool 调用观测
  id, task_run_id, task_kind
  tool_name, input_json, output_json
  iteration, latency_ms, cost
  occurred_at

CostLedger
  id, task_kind, provider, model
  cost, tokens_in, tokens_out
  occurred_at

// In-code registries (not DB)
Tool { name, description, input/output_schema, handler, permission, cost_estimate }
Task { kind, allowed_tools[], budget, system_prompt, default_provider, fallback_chain, needs_tool_call }
```

---

## 九、待决策

- [x] 应试 vs 兴趣两套图谱 → **共享 tag、独立主图**
- [x] AI 调用 API 还是本地 → **走 API（Phase 1 单家 Claude，任务层留多 provider 接口）**
- [x] 同步策略 → **本地优先 + 自动后台同步（去抖 3~5s），LWW + version 字段**
- [x] 完成判定 → **多路径 + Evidence 留痕，不强制 quiz**
- [x] AI 能动性边界 → **软判断 / 软提议 AI free，硬数据 / 不可逆操作锁死**
- [x] Artifact 定位 → **AI 作者，用户消费；Phase 1/2 只做 Note，Tool 型 Phase 3 评估**
- [x] Note 结构 → **Hub + Atomic 双层，atomic ↔ 知识点节点**
- [x] Tool calling 实现 → **用 OSS 框架，不自建**
- [ ] 第一个落地的应试场景：?（决定 Phase 1 课标 import 范围）
- [ ] 视觉模型 eval：MiMo / Qwen-VL / Haiku vision 在真实题型上的对比基准
- [ ] 成本天花板的具体数值（日 / 周 / 单任务）
- [ ] 归档触发的久未触达阈值（默认 90 天）
- [ ] dreaming 接受率的阈值与窗口（默认三月低于 30% 调信号）
- [ ] AI delta mastery 单次最大幅度
- [ ] **Note section 的去重 / 引用机制**：atomic 之间内容重叠时
- [ ] **Note section 拒绝重生策略**：reject + 重生 / 手动覆盖 / 标记不再 propose
- [ ] **Embedded check 与 QuizGenTask 的关系**：共用一套引擎？参数差异？
- [ ] **Note 引用外部资源**：MVP 只手动外链，Phase 2+ 是否做自动抓取
- [ ] Tool 型 Artifact 的沙箱设计（Phase 3 决策）

---

## 十、未来可能性（不在当前路线图）

- 番茄计时和复习日程同步到日历
- 多人模式（学习小组、错题互通）
- 与已有 osu / 编程项目的数据打通（学习时长聚合）
- 语音问答（路上回顾错题）
- 知识图谱跨用户合并（应试图谱社区共享）
