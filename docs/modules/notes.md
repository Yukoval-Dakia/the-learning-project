# Artifact: Note (`note_hub` / `note_atomic`)

> Last reviewed: 2026-05-28 (T-PD8)
>
> 见 [架构基础](../architecture.md) 了解 Artifact 多态化和 schema。
> Block-tree 重建详见 [ADR-0020](../adr/0020-block-tree-note-rebuild.md)；body 走 ProseMirror JSON 见 [ADR-0022](../adr/0022-tiptap-pm-node-schema.md)。
> Embedded check 实际是嵌入 inline tool_quiz，引擎详见 [`quiz.md`](quiz.md)。

**定位**：Note 是 Artifact 的阅读型分支（`type: note_hub | note_atomic`），AI 是作者，用户是消费者。

Tool 互动型分支当前唯一实例是 `tool_quiz`（见 [`quiz.md`](quiz.md)），可独立存在或嵌入 Note 的 `check` section。

---

## 0. 实施现状（2026-05-28）

> Note 链路已有 MVP：Learning Intent 可以创建 hub/atomic LearningItem 与配套 artifact，pg-boss `note_generate` 会异步填充 atomic body blocks；`note_verify` 已做二次检查；verified atomic note 会生成 embedded check。`NoteRefineTask`（patch-op based）正在 Lane 1（T-88 P4-A / YUK-127）落地。Living-note proposal 走 `AiProposal(kind='note_update')`（[`src/core/schema/proposal.ts`](../../src/core/schema/proposal.ts)）。

| 设计概念 | 现状 |
|---|---|
| `artifact` 表 | ✅ schema (`src/db/schema.ts` L290) 与 write path 已在 Learning Intent / note generation 路径启用；body 存 `body_blocks` (ProseMirror JSON), 而非 markdown 文件 |
| `NoteGenerateTask` | ✅ registry 已有；pg-boss `note_generate` handler 填 atomic body blocks |
| `NoteVerifyTask` | ✅ Pass-2 verify 把结果写 `artifact.verification_status` + `verification_summary` |
| `NoteRefineTask` | 🟡 Lane 1 (T-88 P4-A / YUK-127) 进行中，输出 patch ops (`AiProposal(kind='note_update')`) |
| `note_hub` / `note_atomic` 类型 | ✅ artifact.type 二态 + `parent_artifact_id` 父子链 |
| Hub ↔ LearningItem hub 1:1 / atomic ↔ LearningItem atomic 1:1 | ✅ Learning Intent accept 时同步 materialize |
| TipTap 编辑器 | 🟡 ADR-0022 已锁 PM node schema；交互编辑器仍未上线（只读渲染） |
| Embedded check（inline tool_quiz） | ✅ verified atomic note 后生成 1–3 题；attempt 走 `POST /api/embedded-check/attempt`；question 写 `source='embedded'` |
| Grounding / source verification | ❌ sections 目前默认 `source_tier='llm_only'`、`user_verified=false`（Phase 2） |

---

## 1. 生成触发

长期上三个入口都汇入同一 pipeline：
- 用户声明意图（"我想学氧化还原反应"）
- 错题归因发现缺口（AI propose："你似乎在 X 上有缺口，要生成笔记吗？"）
- Dreaming 主动 propose

当前已落地的是 `learning_intent` 来源：用户声明 topic → `LearningIntentOutlineTask` 产出 1 hub + N atomic outline → 用户 accept 后**同步创建 LearningItem 层级**与 `note_hub` / `note_atomic` artifact stubs → 入队 `NoteGenerateTask` 填 atomic sections。mistake / dreaming 来源仍是未来入口。

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

- **Hub outline**：Learning Intent accept 后同步 materialize，立即可见。
- **Atomic sections**：进 pg-boss `note_generate` job，异步填充。
- **未来优化**：需要更强 grounding / verify 时再加 Search/RAG 与双 pass，不假设当前已经有 batch verify。

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

走 dreaming 夜间 batch，所有动作都是 propose 不直接执行（写 `event(action='propose', subject_kind='artifact')` 携带 `AiProposal(kind='note_update' | 'archive')`，定义见 [`src/core/schema/proposal.ts`](../../src/core/schema/proposal.ts)）；user-verified section 跳过自动覆盖。

| 触发器 | 动作 |
| --- | --- |
| 该节点最近 7 天新错题 ≥ 2 | `note_update` propose 更新 atomic 的 `pitfall` |
| embedded check 多次错误率 >50% | `note_update` propose 重写整个 atomic |
| 对话中提到该节点 ≥ 3 次 | `note_update` propose 在 `example` 加例子 |
| mastery > 0.85 且持续 >30 天 | 生成「精简复习版」atomic（新 artifact） |
| 节点 90 天没触达 | `archive` propose 归档 atomic + hub |

---

## 10. 技术实现

### 10.1 不嵌 Obsidian 的理由

- Note 在工具里是「学习系统的内容产物」——schema 强耦合知识图谱、structured sections、embedded check、AI 生命周期，Obsidian 自由 markdown 模型不匹配
- Obsidian 是闭合 app，不能内嵌进当前自托管 Next.js / NAS Docker 运行时；移动端是独立 app，UX 不可控
- "做 Obsidian plugin" 路线 = 锁死在 Obsidian 生态，做不到 AI 实时改 section / propose / 接 judge 路径
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

ADR-0022 已锁 TipTap PM node schema：embedded check / source tier 标签 / 版本徽章直接落 PM block，body 持久化为 JSON 存 `artifact.body_blocks`。

### 10.3 存储格式：ProseMirror JSON in `artifact.body_blocks`

当前实现：note body 是 ProseMirror JSON 树，持久化为 `artifact.body_blocks`（jsonb）。Section 即顶层 block，AI 改 section = 走 `NoteRefineTask` 产 patch ops（[ADR-0020](../adr/0020-block-tree-note-rebuild.md)）作用在 PM 子树上。Frontmatter / sections 列表 / source_tier / user_verified 等元数据走 `artifact.attrs`，不是文件 frontmatter。

```
artifact (row)
  id: art-1234
  type: note_atomic
  parent_artifact_id: art-hub-9999      # ↔ hub
  knowledge_ids: ['kg-5678']
  source: 'learning_intent'              # 'learning_intent' | 'note_generate' | 'dreaming' | …
  body_blocks: { type: 'doc', content: [ … PM nodes … ] }
  attrs: {
    sections: [
      { id: 'def', kind: 'definition', source_tier: 'search_grounded', user_verified: false },
      { id: 'pitfall', kind: 'pitfall', source_tier: 'llm_only', user_verified: true },
      { id: 'check', kind: 'check', embedded_check: { question_ids: ['q-001','q-002'] } },
    ],
    note_version: 3,
  }
  generation_status: 'ready'
  verification_status: 'verified'
  embedded_check_status: 'ready'
  generated_by: { task_kind: 'NoteGenerateTask', version: '…' }
  …
```

Embedded check 在 PM 树里是自定义 block，渲染时交给 [`POST /api/embedded-check/attempt`](../../app/api/embedded-check/attempt/route.ts) 走 judge 链路；question_ids 引用 `question` 表（统一题库）。

### 10.4 开放性 / 离线导出

不再假设 markdown 文件落盘开放性免费送。需要时由 `/api/_/export` 走 [export 路径](../../app/api/_/export/route.ts) 把 PM JSON 转 markdown 文件下载，或后续做 Obsidian plugin 反向桥（Phase 4 加分项）。当前自托管运行时是 Next.js + Postgres，note 存数据库，不直接写用户家目录。

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
