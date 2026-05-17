# Artifact: Note (`note_hub` / `note_atomic`)

> 见 [架构基础](../architecture.md) 了解 Artifact 多态化和 schema。
> Embedded check 实际是嵌入 inline tool_quiz，引擎详见 [`quiz.md`](quiz.md)。

**定位**：Note 是 Artifact 的阅读型分支（`type: note_hub | note_atomic`），AI 是作者，用户是消费者。

Tool 互动型分支当前唯一实例是 `tool_quiz`（见 [`quiz.md`](quiz.md)），可独立存在或嵌入 Note 的 `check` section。

---

## 0. 实施现状（2026-05-17）

> 整条 Note artifact 链路（生成 / 渲染 / embedded check / hub ↔ atomic）**还没落地**。`artifact` 表 schema 存在（1c.1 Step 9 保留作 "C 档 AI 主动产出落点"），但当前 0 写入 0 UI。下面 §1+ 是 Phase 1d/2 设计参考。

| 设计概念 | 现状 |
|---|---|
| `artifact` 表 | ✅ schema 在；激活为 C 档 AI 产出落点（per ADR-0006 v2） |
| `NoteGenerateTask` / `NoteRefineTask` / `NoteVerifyTask` | ❌ AI runner 注册表里都没有这些 task kind |
| `note_hub` / `note_atomic` 类型 | ❌ artifact.type enum 还没在 schema 体现 |
| Hub ↔ LearningItem hub 1:1 / atomic ↔ LearningItem atomic 1:1 | ❌ LearningItem 层级字段也未启用 |
| TipTap 编辑器 | ❌ Phase 1d/2 |
| Embedded check（inline tool_quiz） | ❌ 同上，quiz 系统本身也未跑 |

**当前唯一 "AI 产出"**：`event(action='judge')`（cause 归因）+ `event(action='propose', subject_kind='knowledge'/'knowledge_edge')`（mesh 提议；agent 还没真在产）。这些都不走 `artifact` 表。

---

## 1. 生成触发

三个入口都汇入同一 pipeline：
- 用户声明意图（"我想学氧化还原反应"）
- 错题归因发现缺口（AI propose："你似乎在 X 上有缺口，要生成笔记吗？"）
- Dreaming 主动 propose

每个入口都触发 `NoteGenerateTask` 产出 `note_hub` + N 个 `note_atomic` Artifact。`learning_intent` 来源会**同步创建 LearningItem 层级**：1 hub LearningItem + N atomic LearningItems，跟 note 层级一一对应（详见 [`learning-items.md`](learning-items.md) § 1.2）。其他来源（mistake / dreaming）默认创建 1 atomic LearningItem。

## 2. Hub + Atomic 双层结构

不做单一巨型 note。每个学习主题拆成：

```
note_hub: 氧化还原反应
├── note_atomic: 概念定义        ← 知识点节点
├── note_atomic: 电子转移机制    ← 知识点节点
├── note_atomic: 化合价变化      ← 知识点节点
├── note_atomic: 半反应与配平    ← 知识点节点
├── note_atomic: 常见反应类型    ← 知识点节点
└── note_atomic: 易错点          ← 知识点节点
```

每个 atomic note ↔ 一个知识点节点，mastery 在叶子层累积。Hub mastery 是子节点加权聚合（见 [`progress.md`](progress.md)）。三个对象（artifact / LearningItem / 知识图谱）天然对齐。

## 3. 结构化 section 模板

每个 atomic note 至少包含五种 section：

| kind | 内容 |
| --- | --- |
| `definition` | 核心定义（1~2 句） |
| `mechanism` | 关键机制 / 公式 / 规则 |
| `example` | 标准例子（1~3 个） |
| `pitfall` | 易错点 / 常见误解 |
| `check` | 自检 mini-quiz（**inline tool_quiz**，引用 `Question.id`） |

`check` section 是 inline 嵌入的 tool_quiz——直接持 `question_ids[]`，不另建独立 `tool_quiz` Artifact 行。这跟 standalone tool_quiz Artifact（每日 quiz / 模拟卷）共用一套 `JudgeRouter` / Judge 引擎。

**为什么结构化**：才能做"针对你最近的错题更新这一节"。完全自由的 markdown 只能 regenerate 整篇。

## 4. 生成节奏

- **Hub outline + 第一节**：同步生成（~5s 出现）
- **其他 atomic notes**：进 batch 队列，夜间产出

用户立刻看到东西，敢相信系统在工作；昂贵的部分异步跑。

## 5. Note 是活的

| 信号 | AI 反应 |
| --- | --- |
| 在 atomic note A 上停留很久 | 标记为难点，下次复盘提一下 |
| 在 A 对应知识点错题 | propose 更新 A 的 `pitfall` section |
| 用户问"再举个例子" | 在 `example` section 追加，留版本 |
| mastery 升高 | 自动生成 atomic note 的"精简复习版" |
| embedded check 错误率持续 >50% | propose 重写整个 atomic（note 写错了的可能） |

这是相对静态笔记软件（Notion / Obsidian / Wikipedia）的护城河：内容跟随用户演化。

## 6. Embedded check 闭环

`check` section 是 inline 嵌入的 mini tool_quiz（`question_ids` 引用全局 Question 表）。Tool 可独立存在（每日 quiz、final quiz、用户存的模拟卷）也可嵌入 Note（即 embedded check）——同一抽象，共用 [`quiz.md`](quiz.md) 的判定与申诉机制。

闭环：
- 做对：算 LearningItem done 信号之一（见 [`learning-items.md`](learning-items.md)），喂 base mastery（见 [`progress.md`](progress.md)）
- 做错：入错题本（见 [`mistakes.md`](mistakes.md)，`from_judgment_id` 关联），可申诉重判
- 错误率持续 >50%：触发 § 5 的 note 重写 propose

读 note 与做题不再分离。

## 7. 准确性 / 反幻觉

**这是 AI 学习工具的死穴**——LLM 一本正经胡说八道是常态。不解决，工具没合法性。

### 7.1 Source tier 标记

每个 section 标注内容来源等级：

```
LLM-only         纯模型生成（默认，低可信）
Search-grounded  有 web 搜索 / 资料 grounding（中）
Textbook         用户上传教材作为 RAG（高）
User-verified    用户标过「✓ 看过没问题」（最高）
```

UI 上每个 section 显示来源标识（小标签），用户知道哪些还没被验证。

### 7.2 双 pass 生成

```
Pass 1  NoteGenerateTask  →  草稿（便宜模型）
Pass 2  NoteVerifyTask    →  不同 model 跑事实一致性检查
                            标可疑 section
```

走 batch API，成本 +50%，但能抓掉相当一部分内部不一致和明显幻觉。

### 7.3 显式不确定性

prompt 硬要求：不确定的说不确定，例子优先用经典教材原文，**不自创例子**。

### 7.4 Embedded check 反向信号

某 check question 多次尝试错误率持续 >50% → 自动 flag、propose 重写该 section。**可能不是用户没学懂，是 note 写错了**。

### 关键 Call

- Phase 2 Note **默认 Search-grounded**，不直接 LLM-only
  - 搜索源：Phase 2 初通用 web 搜索；Phase 2 后期支持用户上传教材作为 RAG
- Section schema 加 `source_tier` 和 `user_verified` 字段
- Living note 对 `user_verified` section **不主动覆盖**，只 propose

## 8. 生成时与知识图谱的交互

`NoteGenerateTask` 跟知识图谱是双向的：

**输入侧**

```
1. 用户声明 "我想学 X"
2. AI 查图谱：X 节点在吗？子节点齐吗？
3a. X 不存在        → propose 新节点 + 子结构 → 用户审一次 → 生成
3b. X 在但子节点缺  → propose 补全缺失子节点 → 用户审 → 生成
3c. X 在且子节点齐  → 直接用现有结构生成
```

**输出侧**

生成 atomic note 过程中 AI 发现某概念应独立成节点 → 调 `propose_new_knowledge_node` → 自动建带 `proposed_by_ai` 标记的节点。

**分级**（跟"软提议 vs 硬决策"一致）：
- **Hub 大纲变化 → 用户必审一次**（结构性变更）
- **Atomic 级小节点 → AI 自动建 + 标记**，用户在 maintenance lane（见 [`lanes.md`](lanes.md)）里事后 review

## 9. Living note 触发器（量化）

走 dreaming 夜间 batch，所有动作都是 propose 不直接执行；user-verified section 跳过自动覆盖。

| 触发器 | 动作 |
| --- | --- |
| 该节点最近 7 天新错题 ≥ 2 | propose 更新 atomic 的 `pitfall` |
| embedded check 多次错误率 >50% | propose 重写整个 atomic |
| 对话中提到该节点 ≥ 3 次 | propose 在 `example` 加例子 |
| mastery > 0.85 且持续 >30 天 | 生成「精简复习版」atomic |
| 节点 90 天没触达 | propose 归档 atomic + hub |

---

## 10. 技术实现

### 10.1 不嵌 Obsidian 的理由

- Note 在工具里是「学习系统的内容产物」——schema 强耦合知识图谱、structured sections、embedded check、AI 生命周期，Obsidian 自由 markdown 模型不匹配
- Obsidian 是闭合 app，不能嵌进 Tauri；移动端是独立 app，UX 不可控
- "做 Obsidian plugin" 路线 = 锁死在 Obsidian 生态，移动 / Tauri 都用不了
- AI 主动改某个 section、source_tier 标记、version 演化在 Obsidian 里没法做出好 UX

Obsidian 的优势（双链 / graph view / 插件生态）**反而都需要在自己工具里重做**——因为它们要跟知识图谱深度联动，不能是独立体系。

### 10.2 OSS 选型

| 层 | OSS |
| --- | --- |
| 编辑器（含定制 schema） | TipTap / Milkdown / Lexical（都基于 ProseMirror） |
| 纯渲染 | react-markdown / markdown-it |
| 数学公式 | KaTeX |
| 图表 | Mermaid |
| 代码高亮 | Shiki / Prism |
| 双链 / 反链 | 自建（耦合知识图谱） |
| Graph view | 自建（耦合知识图谱） |

TipTap 是关键——它让你在 markdown 之上加自定义 block（embedded check / source tier 标签 / 版本徽章），在 Obsidian 等通用编辑器里这些会自动 fallback 成 markdown 占位。

### 10.3 存储格式：纯 markdown + frontmatter

```
~/.learning-project/notes/
  wenyan/                    # 文言文（Phase 1 首发学科）
    廉颇蔺相如列传/
      _hub.md
      重点实词.md
      句式特征.md
      ...
```

每个 atomic note 的 frontmatter：

```yaml
---
id: art-1234
type: note_atomic
knowledge_id: kg-5678
parent: art-hub-9999
sections:
  - id: def
    kind: definition
    source_tier: search_grounded
    user_verified: false
  - id: pitfall
    kind: pitfall
    source_tier: llm_only
    user_verified: true
  - id: check
    kind: check
    embedded_check:
      question_ids: [q-001, q-002]   # inline tool_quiz，引用 Question 表
version: 3
generated_by: NoteGenerateTask v1.2
---

## 核心定义
...

## 关键机制
...

## 自检
<!-- embedded-check question_ids=[q-001, q-002] -->
```

Embedded check 用 HTML 注释占位 + 渲染层替换：本工具里 → 交互组件（实时调 `JudgeRouter`）；Obsidian/VS Code 里 → 看不见的注释。Section ↔ markdown heading 一一对应，AI 更新某 section = 编辑该 heading 下的内容。

### 10.4 自动获得开放性

存储是标准 markdown 文件，用户**随时能用 Obsidian / Logseq / VS Code 直接打开看**——不用做迁移工具，开放性免费送。

未来想做 Obsidian plugin（让用户在 Obsidian 里也能看 backlinks 和 mastery 标签）→ Phase 4 加分项。

---

## 11. 阅读 UX

### 移动端（优先）

- 单栏 linear scroll
- 5 个 section 顺序展开（折叠/展开切换）
- Embedded check 在 atomic 末尾
- 下一篇 atomic：底部按钮 / swipe 切换
- Hub 跳回：顶部 breadcrumb 一击返回

### 桌面端

- 双栏：左侧 hub outline 侧栏（含每 atomic 的 mastery 小标识 + 完成状态），右侧 atomic 主体
- Linear / tree 双导航：linear（next/prev atomic）为主，tree 跳转为辅
- 进度条：atomic 内显示 5 section 进度，hub 内显示 atomic 完成度

### Mastery 反馈

embedded check 做对后即时 toast：「+0.05 → 当前 X」，让 mastery 增长可感。

---

## 模块特定的待决策

- 阅读 UX → **已定**：移动单栏线性，桌面双栏（侧栏 outline + 主体）
- 跨学科引用 → **已定**：markdown wiki link 软引用
- Search-grounded 搜索源 → **已定**：Phase 2 初通用 web，后期教材 RAG
- Note section 的去重 / 引用机制 — 实际遇到内容重叠再设计
- Note section 拒绝重生策略 — Phase 2 用户实际反馈再定
- Note 引用外部资源（自动抓取） — MVP 手动外链已定
- Note 版本演化的 UI（"3 天前更新了 example"） — Phase 2 简版 diff 视图
- 「我已经会一部分」快速跳过机制 — Phase 2 后期再加
